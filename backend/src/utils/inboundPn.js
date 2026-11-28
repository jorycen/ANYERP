const { Product, ProductPn } = require('../models');
const { isUsablePnCode, normalizePnCode, uniquePnCodes, assertSingleSnProductPn } = require('./productPn');

// Receipt paths must validate master data inside their stock transaction.
async function requireInboundPn(productOrId, requestedCode, transaction) {
  const product = typeof productOrId === 'object' && productOrId
    ? productOrId : await Product.findByPk(productOrId, { transaction });
  const fail = message => { throw Object.assign(new Error(message), { status: 400, code: 'INBOUND_PN_INVALID' }); };
  if (!product) fail('入库商品不存在');
  const label = product.product_code || product.name || product.product_id;
  const records = await ProductPn.findAll({ where: { product_id: product.product_id }, transaction });
  const active = records.filter(row => Number(row.status) === 1 && !Number(row.is_deleted));
  const legacy = uniquePnCodes([product.manufacturer_code]).filter(code =>
    !records.some(row => normalizePnCode(row.pn_code) === normalizePnCode(code)));
  const configured = uniquePnCodes([active.map(row => row.pn_code), legacy]);
  if (!configured.length) fail(`商品【${label}】未维护有效PN，请先维护商品PN后再入库`);
  const requested = String(requestedCode ?? '').trim();
  if (requested && !isUsablePnCode(requested)) fail(`商品【${label}】的入库PN无效，不能使用占位值`);
  const matched = requested ? configured.find(code => normalizePnCode(code) === normalizePnCode(requested)) : '';
  if (requested && !matched) fail(`商品【${label}】的入库PN未关联本商品或已停用`);
  if (!requested && configured.length > 1) fail(`商品【${label}】有多个PN，请明确选择本次入库PN`);
  const code = matched || configured[0];
  assertSingleSnProductPn({ needSn: product.need_sn, productCode: label, configuredCodes: configured, requestedCode: code });
  return code;
}

module.exports = { requireInboundPn };
