const crypto = require('node:crypto');
// Stable organization IDs: do not infer financial ownership from display names.
const PRODUCT_WAREHOUSES = new Set(['D028000', 'D023000']);
const isProductWarehouse = storeId => PRODUCT_WAREHOUSES.has(String(storeId));
function attribute(event) {
  if (!isProductWarehouse(event.storeId)) return event;
  // Reclassify the frozen company amount, never recalculate cost or historical facts.
  const result = { ...event, salesGrossProfit: 0, operationsGrossProfit: 0,
    productGrossProfit: event.companyGrossProfit,
    profitAttribution: 'SELF_OPERATED_WAREHOUSE_PRODUCT' };
  result.managementSourceHash = crypto.createHash('sha256').update(JSON.stringify({
    key: event.eventKey, date: event.businessDate, store: event.storeId,
    values: [0, result.productGrossProfit, 0], costState: event.costState
  })).digest('hex');
  return result;
}
module.exports = { isProductWarehouse, attribute };
