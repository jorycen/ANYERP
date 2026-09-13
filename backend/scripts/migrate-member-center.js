// Additive, resumable migration. Historical rules, balances and exchanges are untouched.
const { sequelize } = require('../src/config/database');
const M = require('../src/modules/customerOps/models');
const columns = {
  Reward: ['description', 'original_price', 'cash_required', 'sort', 'valid_start_time', 'valid_end_time', 'self_only', 'coupon_value', 'coupon_min_spend', 'coupon_scope'],
  Redemption: ['cash_received', 'receipt_reference', 'coupon_check']
};
async function migrate(apply = process.argv.includes('--apply')) {
  const qi = sequelize.getQueryInterface();
  for (const [name, fields] of Object.entries(columns)) {
    const model = M[name], existing = await qi.describeTable(model.tableName);
    for (const field of fields) if (!existing[field]) {
      if (apply) await qi.addColumn(model.tableName, field, model.rawAttributes[field]);
      console.log(`${apply ? 'Added' : 'Would add'} ${model.tableName}.${field}`);
    }
  }
  // Only enrolled distributors get a new version. Never enroll new stores implicitly.
  const rules = await M.Rule.findAll({ order: [['effective_at', 'DESC'], ['id', 'DESC']] });
  const seen = new Set();
  for (const rule of rules) {
    if (seen.has(rule.distributor_id)) continue;
    seen.add(rule.distributor_id);
    if (String(rule.numerator) === '1' && String(rule.denominator) === '1000' && !(rule.product_ids || []).length) continue;
    console.log(`${apply ? 'Publish' : 'Would publish'} 10 yuan / 1 point for ${rule.distributor_id}`);
    if (apply) await sequelize.transaction(async transaction => {
      await require('../src/models').Distributor.findByPk(rule.distributor_id, { transaction, lock: transaction.LOCK.UPDATE });
      const latest = await M.Rule.findOne({ where: { distributor_id: rule.distributor_id }, order: [['effective_at', 'DESC']], transaction });
      if (String(latest.numerator) === '1' && String(latest.denominator) === '1000' && !(latest.product_ids || []).length) return;
      await M.Rule.create({ distributor_id: rule.distributor_id, numerator: '1', denominator: '1000', product_ids: [],
        effective_at: new Date(Math.max(Date.now(), new Date(latest.effective_at).getTime() + 1000)), actor: 'migration:member-center' }, { transaction });
    });
  }
}
if (require.main === module) migrate().catch(e => { console.error(e.name, e.original?.code || e.message); process.exitCode = 1; }).finally(() => sequelize.close());
module.exports = { migrate, columns };
