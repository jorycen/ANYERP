const M = require('../../models');

// Called only after the approval instance access check.
async function resourceClaimDetail(id) {
  const change = await M.ResourceRightChangeOrder.findByPk(id);
  if (!change) return null;
  const [category, product, sn] = await Promise.all([
    M.ResourceCategory.findOne({ where: { category_code: change.resource_type } }),
    change.product_id ? M.Product.findByPk(change.product_id) : null,
    change.sn_id ? M.ProductSn.findByPk(change.sn_id) : null
  ]);
  return {
    ...change.toJSON(), resource_name: category?.name || change.resource_type,
    product_name: product?.name || '', pn_code: sn?.pn_code || '',
    sn_code: change.sn_code || sn?.sn_code || ''
  };
}
module.exports = { resourceClaimDetail };
