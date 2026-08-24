const { Op } = require('sequelize');

function normalizeProductIds(productIds) {
  return [...new Set((Array.isArray(productIds) ? productIds : [productIds])
    .map(value => String(value || '').trim())
    .filter(Boolean))];
}

async function findActiveProducts(Product, productIds, options = {}) {
  const ids = normalizeProductIds(productIds);
  if (ids.length === 0) return [];
  return Product.findAll({
    where: {
      product_id: { [Op.in]: ids },
      is_deleted: 0,
      status: 1
    },
    ...options
  });
}

async function assertActiveProducts(Product, productIds, options = {}) {
  const ids = normalizeProductIds(productIds);
  if (ids.length === 0) return [];

  const products = await findActiveProducts(Product, ids, options);
  const activeIds = new Set(products.map(product => String(product.product_id)));
  const invalidIds = ids.filter(productId => !activeIds.has(productId));
  if (invalidIds.length > 0) {
    const error = new Error(`商品 ${invalidIds.join('、')} 不存在或已停用，只能选择已启用商品`);
    error.status = 400;
    throw error;
  }
  return products;
}

module.exports = {
  normalizeProductIds,
  findActiveProducts,
  assertActiveProducts
};
