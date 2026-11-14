const M = require('../src/models');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const uid = () => require('node:crypto').randomUUID().replaceAll('-', '');
const types = ['EDU_SUBSIDY', 'SALES_BONUS', 'MANUFACTURER_REBATE'];
const reason = '用户确认MP2VZE04活动资格可用，无当前活动金额按0保存';
(async () => {
  await M.sequelize.transaction(async transaction => {
    const opt = { transaction, lock: transaction.LOCK.UPDATE };
    const sn = await M.ProductSn.findByPk('2eda321adf5041f58cb492ff70c0d871', opt);
    assert.equal(sn.sn_code, 'MP2VZE04');
    const rows = await M.InventoryResourceRight.findAll({ where: { sn_id: sn.sn_id }, ...opt });
    const template = rows.find(x => x.resource_type === 'GOV_SUBSIDY');
    assert.ok(template);
    for (const type of types) {
      const row = rows.find(x => x.resource_type === type);
      if (row) assert.ok(['AVAILABLE', 'NOT_APPLICABLE'].includes(row.current_status), '存在已使用或锁定权益');
    }
    const dir = path.resolve(__dirname, '../backup/resource-eligibility');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'MP2VZE04-' + Date.now() + '.json'), JSON.stringify({ reason, sn, rows }, null, 2), { flag: 'wx' });
    for (const type of types) {
      let right = rows.find(x => x.resource_type === type);
      if (right?.current_status === 'AVAILABLE' && Number(right.amount) === 0 && !right.effective_end && !right.effective_start) continue;
      const before = right?.current_status || 'NOT_APPLICABLE';
      const values = { current_status: 'AVAILABLE', amount: 0, effective_start: null, effective_end: null, source: 'USER_ELIGIBILITY_CONFIRMED', remark: reason, version: Number(right?.version || 0) + 1 };
      if (right) await right.update(values, { transaction });
      else { const data = template.toJSON(); delete data.right_id; right = await M.InventoryResourceRight.create({ ...data, ...values, right_id: uid(), resource_type: type, initial_status: 'AVAILABLE', create_time: new Date(), update_time: new Date() }, { transaction }); }
      await M.ResourceRightChangeOrder.create({ change_id: uid(), change_order_no: 'RRC' + Date.now() + uid().slice(0, 6), sn_id: sn.sn_id, sn_code: sn.sn_code, product_id: sn.product_id, resource_type: type, before_status: before, after_status: 'AVAILABLE', change_amount: 0, change_reason: 'ELIGIBILITY_CONFIRMED', approval_status: 'approved', applicant_name: 'Codex用户授权操作', reviewer_name: 'Codex用户授权操作', review_time: new Date(), remark: reason }, { transaction });
    }
  });
  console.log(JSON.stringify(await M.InventoryResourceRight.findAll({ where: { sn_id: '2eda321adf5041f58cb492ff70c0d871', resource_type: types }, attributes: ['resource_type', 'current_status', 'amount'], raw: true })));
})().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => M.sequelize.close());
