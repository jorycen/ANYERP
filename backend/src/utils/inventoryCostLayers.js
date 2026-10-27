// Shared FIFO remaining cost layers and average.
function fifoRemainingAverageCost(layers, currentStockQty, { requireComplete = false } = {}) {
  let remaining = Number(currentStockQty || 0);
  let totalCost = 0;
  let totalQty = 0;

  for (const layer of layers) {
    if (remaining <= 0) break;
    const price = Number(layer.unit_price || layer.UNIT_PRICE || 0);
    const qty = Number(layer.quantity || layer.QUANTITY || 0);
    if ((price <= 0 && !(price === 0 && Number(layer.zero_cost_confirmed) === 1)) || qty <= 0) continue;
    const takeQty = Math.min(qty, remaining);
    totalCost += takeQty * price;
    totalQty += takeQty;
    remaining -= takeQty;
  }

  if (requireComplete && remaining > 0) return null;
  if (totalQty <= 0) return 0;
  return parseFloat((totalCost / totalQty).toFixed(2));
}

const remainingCostLayersSql = `
    SELECT unit_price, quantity, create_time, zero_cost_confirmed FROM (
      SELECT
        ii.UNIT_PRICE AS unit_price,
        ii.QUANTITY AS quantity,
        COALESCE(i.RECEIVE_TIME, i.CREATE_TIME) AS create_time,
        CASE WHEN ii.UNIT_PRICE = 0 AND i.SOURCE_TYPE IN ('GIFT','SALES_COMPONENT_RECOVERY')
          AND EXISTS (SELECT 1 FROM T_NON_PURCHASE_RECEIPT npr WHERE npr.INBOUND_ID = i.INBOUND_ID AND npr.STATUS IN ('approved','received')) THEN 1 ELSE 0 END AS zero_cost_confirmed
      FROM T_INBOUND_ITEM ii
      JOIN T_INBOUND i ON ii.INBOUND_ID = i.INBOUND_ID
      WHERE ii.PRODUCT_ID = ?
        AND i.STATUS IN ('completed', 'executed')
        AND COALESCE(ii.SN_CODE, '') = ''
        AND (ii.UNIT_PRICE > 0 OR (ii.UNIT_PRICE = 0 AND i.SOURCE_TYPE IN ('GIFT','SALES_COMPONENT_RECOVERY')
          AND EXISTS (SELECT 1 FROM T_NON_PURCHASE_RECEIPT npr WHERE npr.INBOUND_ID = i.INBOUND_ID AND npr.STATUS IN ('approved','received'))))
        AND ii.QUANTITY > 0
      UNION ALL
      SELECT
        item.UNIT_PRICE AS unit_price,
        item.QUANTITY AS quantity,
        COALESCE(app.EXECUTE_TIME, item.CREATE_TIME, app.CREATE_TIME) AS create_time,
        0 AS zero_cost_confirmed
      FROM T_INVENTORY_BATCH_APPLICATION_ITEM item
      JOIN T_INVENTORY_BATCH_APPLICATION app ON item.APPLICATION_ID = app.APPLICATION_ID
      WHERE item.PRODUCT_ID = ?
        AND app.STATUS = 'executed'
        AND item.OPERATION_TYPE = 'INBOUND'
        AND COALESCE(item.NEED_SN, 0) = 0
        AND item.UNIT_PRICE > 0
        AND item.QUANTITY > 0
    ) layers
    ORDER BY create_time DESC
  `;
module.exports = { fifoRemainingAverageCost, remainingCostLayersSql };
