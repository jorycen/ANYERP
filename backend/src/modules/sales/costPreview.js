const { snapshotToResponse, validPrice, roundMoney } = require('./grossProfit');

// These are response fields only. Do not write preview costs into frozen items,
// or run archive settlement/rebate effects while reading a sales order.
function applyCostPreview(orderData, snapshot) {
  const preview = snapshotToResponse(snapshot, orderData);
  const byItem = new Map(preview.productPricingDetails.map(row => [String(row.itemId), row]));
  return {
    ...orderData,
    cost_preview: preview,
    OrderItems: (orderData.OrderItems || []).map(item => {
      const pricing = byItem.get(String(item.item_id));
      const complete = !!pricing && !String(pricing.source || '').startsWith('missing_') && validPrice(pricing.unitPricing) !== null;
      const cost = complete ? Number(pricing.unitPricing) : null;
      return {
        ...item,
        cost_is_preview: true,
        cost_status: complete ? 'complete' : 'pending',
        cost_source: pricing?.source || 'missing_price',
        original_inventory_cost: pricing && pricing.purchasePriceKnown !== false && validPrice(pricing.purchasePrice) !== null ? Number(pricing.purchasePrice) : null,
        sales_settlement_cost: cost,
        cost_adjustment_amount: null,
        sales_gross_profit: complete ? roundMoney(Number(item.subtotal) - cost * Number(item.quantity || 1)) : null
      };
    })
  };
}

// Repair legacy display gaps using transaction prices and the frozen snapshot.
// These values are response-only; never migrate archived costs on a detail read.
function applyFrozenCostDisplay(orderData, snapshot) {
  let details = snapshot?.product_pricing_details || [];
  if (typeof details === 'string') {
    try { details = JSON.parse(details); } catch (_) { details = []; }
  }
  const byItem = new Map((Array.isArray(details) ? details : []).map(row => [String(row.itemId), row]));
  return { ...orderData, OrderItems: (orderData.OrderItems || []).map(item => {
    const row = { ...item };
    const quantity = Number(item.quantity ?? 1);
    const salePrice = validPrice(item.sale_price);
    if ((validPrice(item.subtotal) === null || Number(item.subtotal) === 0) && salePrice !== null && salePrice > 0 && quantity > 0) {
      row.subtotal = roundMoney(salePrice * quantity);
    }
    const pricing = snapshot?.snapshot_status === 'final' ? byItem.get(String(item.item_id)) : null;
    if (pricing && !String(pricing.source || '').startsWith('missing_')) {
      if (!(Number(item.original_inventory_cost) > 0) && validPrice(pricing.purchasePrice) !== null && pricing.purchasePriceKnown !== false) row.original_inventory_cost = Number(pricing.purchasePrice);
      if (validPrice(pricing.unitPricing) !== null) {
        if (!(Number(item.sales_settlement_cost) > 0) && !Number(item.cost_adjustment_amount || 0)) row.sales_settlement_cost = Number(pricing.unitPricing);
        row.sales_gross_profit = roundMoney(Number(row.subtotal || 0) - Number(row.sales_settlement_cost) * quantity);
      }
    }
    return row;
  }) };
}

module.exports = { applyCostPreview, applyFrozenCostDisplay };
