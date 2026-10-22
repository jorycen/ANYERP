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

module.exports = { applyCostPreview };
