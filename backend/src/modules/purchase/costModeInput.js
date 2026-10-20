const MODES = new Set(['COMPANY_PRICE', 'PURCHASE_PRICE']);
function normalizeMode(value) {
  const mode = String(value).trim().toUpperCase();
  if (!MODES.has(mode)) throw Object.assign(new Error('采购毛利计价方式无效'), { status: 400 });
  return mode;
}
function resolveIncomingCostMode(item, body = {}, product = {}) {
  if ([true, 1, '1'].includes(item.isUsedProduct ?? item.is_used_product)) return 'PURCHASE_PRICE';
  // Legacy mini-programs choose one mode for the entire request. Honor that
  // explicit selection even if a copied product/draft still contains old modes.
  if (body.useProductStandardPrice !== undefined && body.useProductStandardPrice !== null) {
    const flag = body.useProductStandardPrice;
    if ([false, 0, '0', 'false'].includes(flag)) return 'PURCHASE_PRICE';
    if ([true, 1, '1', 'true'].includes(flag)) return 'COMPANY_PRICE';
    throw Object.assign(new Error('整单毛利计价方式无效'), { status: 400 });
  }
  const explicit = item.grossProfitCostMode || item.gross_profit_cost_mode;
  if (explicit) return normalizeMode(explicit);
  return normalizeMode(product?.gross_profit_cost_mode || 'PURCHASE_PRICE');
}
function applyIncomingCostModes(items, body, products) {
  for (const item of items) item.grossProfitCostMode = resolveIncomingCostMode(item, body, products.get(String(item.productId || item.product_id || '')));
}
module.exports = { resolveIncomingCostMode, applyIncomingCostModes };
