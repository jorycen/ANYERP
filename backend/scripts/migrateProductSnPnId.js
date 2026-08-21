const { sequelize, ProductPn, ProductSn } = require('../src/models');
const { normalizePnCode } = require('../src/utils/productPn');

function key(productId, pnCode) {
  return `${String(productId || '')}::${normalizePnCode(pnCode)}`;
}

async function main() {
  const apply = process.argv.includes('--apply');
  await sequelize.authenticate();

  const [pns, sns] = await Promise.all([
    ProductPn.findAll({
      attributes: ['pn_id', 'product_id', 'pn_code', 'status', 'is_deleted'],
      where: { status: 1, is_deleted: 0 },
      order: [['product_id', 'ASC'], ['is_primary', 'DESC'], ['pn_code', 'ASC']]
    }),
    ProductSn.findAll({
      attributes: ['sn_id', 'product_id', 'pn_id', 'pn_code', 'sn_code', 'status', 'is_deleted'],
      where: { is_deleted: 0 }
    })
  ]);

  const pnMap = new Map();
  for (const pn of pns) {
    const pnKey = key(pn.product_id, pn.pn_code);
    const rows = pnMap.get(pnKey) || [];
    rows.push(pn);
    pnMap.set(pnKey, rows);
  }

  const repairs = [];
  const unresolved = [];
  for (const sn of sns) {
    const normalizedCode = normalizePnCode(sn.pn_code);
    const candidates = normalizedCode ? (pnMap.get(key(sn.product_id, normalizedCode)) || []) : [];
    if (candidates.length !== 1) {
      unresolved.push({
        sn_id: sn.sn_id,
        product_id: sn.product_id,
        sn_code: sn.sn_code,
        pn_id: sn.pn_id || null,
        pn_code: sn.pn_code || null,
        reason: normalizedCode ? (candidates.length === 0 ? 'PN_NOT_FOUND' : 'PN_AMBIGUOUS') : 'PN_CODE_EMPTY'
      });
      continue;
    }

    const pn = candidates[0];
    if (String(sn.pn_id || '') !== String(pn.pn_id || '') || String(sn.pn_code || '') !== String(pn.pn_code || '')) {
      repairs.push({ sn, pn });
    }
  }

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    activeProductPn: pns.length,
    activeProductSn: sns.length,
    repairable: repairs.length,
    unresolved: unresolved.length,
    unresolvedSample: unresolved.slice(0, 30).map(row => ({
      sn_id: row.sn_id,
      product_id: row.product_id,
      sn_code: row.sn_code,
      pn_id: row.pn_id,
      pn_code: row.pn_code,
      reason: row.reason
    }))
  }, null, 2));

  if (apply && repairs.length > 0) {
    const transaction = await sequelize.transaction();
    try {
      for (const { sn, pn } of repairs) {
        await sn.update({ pn_id: pn.pn_id, pn_code: pn.pn_code }, { transaction });
      }
      await transaction.commit();
      console.log(`Applied ${repairs.length} ProductSn PN bindings.`);
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close();
  });
