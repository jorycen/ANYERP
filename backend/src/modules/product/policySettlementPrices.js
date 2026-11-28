const { Op } = require('sequelize');
const { ProductPn, ManufacturerPriceHistory } = require('../../models');
const { splitPnCodes } = require('../../utils/productPn');

// Read the same policy records as inventory/resource-rights/nb-policy.
// Keep multiple PNs separate; a product's different models can have different prices.
async function loadPolicySettlementPrices(products, barcodes) {
  const ids = products.map(product => product.product_id);
  if (!ids.length) return new Map();
  const pns = await ProductPn.findAll({ where: { product_id: { [Op.in]: ids }, is_deleted: 0 },
    attributes: ['product_id', 'pn_code'], raw: true });
  const codes = new Map(products.map(product => [product.product_id, new Set(splitPnCodes(product.manufacturer_code))]));
  for (const row of [...pns, ...barcodes]) {
    const code = row.pn_code || row.barcode_code;
    if (code) codes.get(row.product_id)?.add(code);
  }
  const allCodes = [...new Set([...codes.values()].flatMap(set => [...set]))];
  const now = new Date();
  const policies = await ManufacturerPriceHistory.findAll({ where: {
    [Op.or]: [{ product_id: { [Op.in]: ids } }, ...(allCodes.length ? [{ pn: { [Op.in]: allCodes } }] : [])],
    effective_date: { [Op.lte]: now },
    [Op.and]: [{ [Op.or]: [{ expire_date: null }, { expire_date: { [Op.gte]: now } }] }]
  }, order: [['effective_date', 'DESC'], ['created_at', 'DESC'], ['id', 'DESC']], raw: true });
  return new Map(products.map(product => {
    const latest = new Map();
    for (const policy of policies) {
      if (policy.product_id && policy.product_id !== product.product_id) continue;
      if (policy.product_id !== product.product_id && !codes.get(product.product_id).has(policy.pn)) continue;
      if (!latest.has(policy.pn)) latest.set(policy.pn, { pn: policy.pn,
        settlement_price: policy.settlement_price == null ? null : Number(policy.settlement_price) });
    }
    return [product.product_id, [...latest.values()]];
  }));
}
module.exports = { loadPolicySettlementPrices };
