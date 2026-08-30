const {
  Order,
  OrderItem,
  FreightRecord,
  FreightRecordItem,
  sequelize
} = require('../src/models');
const {
  isFreightRecordApplicableToOrder,
  roundMoney
} = require('../src/modules/sales/grossProfit');

const exampleLimitArg = process.argv.find(arg => arg.startsWith('--examples='));
const exampleLimitValue = Number(exampleLimitArg?.split('=')[1]);
const EXAMPLE_LIMIT = Number.isFinite(exampleLimitValue)
  ? Math.min(Math.max(exampleLimitValue, 0), 200)
  : 30;

function referenceId(value) {
  return String(value || '').trim();
}

function itemMatchesFreight(orderItem, freightItem) {
  const productId = referenceId(orderItem.product_id);
  const snId = referenceId(orderItem.sn_id);
  const snCode = referenceId(orderItem.sn_code);
  return Boolean(
    (productId && productId === referenceId(freightItem.product_id))
    || (snId && snId === referenceId(freightItem.sn_id))
    || (snCode && snCode === referenceId(freightItem.sn_code))
  );
}

function isExactSnMatch(orderItem, freightItem) {
  const snId = referenceId(orderItem.sn_id);
  const snCode = referenceId(orderItem.sn_code);
  return Boolean(
    (snId && snId === referenceId(freightItem.sn_id))
    || (snCode && snCode === referenceId(freightItem.sn_code))
  );
}

function sortNewestFirst(left, right) {
  const leftTime = new Date(left.create_time || 0).getTime();
  const rightTime = new Date(right.create_time || 0).getTime();
  if (rightTime !== leftTime) return rightTime - leftTime;
  return Number(right.item_id || 0) - Number(left.item_id || 0);
}

function selectedFreightAmount(order, orderItem, freightItems, freightRecords, applyScope) {
  const candidates = freightItems
    .filter(row => itemMatchesFreight(orderItem, row))
    .map(row => ({
      ...row,
      source: freightRecords.get(referenceId(row.freight_id)) || {}
    }))
    .filter(row => !applyScope || isFreightRecordApplicableToOrder({
      orderStoreId: order.store_id,
      orderCreatedAt: order.create_time,
      sourceType: row.source.source_type,
      storeId: row.source.store_id,
      toStoreId: row.source.to_store_id,
      sourceCreatedAt: row.source.create_time,
      sourceUpdatedAt: row.source.update_time
    }))
    .sort(sortNewestFirst);
  if (!candidates.length) return { amount: 0, source: null };
  const exactRows = candidates.filter(row => isExactSnMatch(orderItem, row));
  const selected = (exactRows.length ? exactRows : candidates)[0];
  const quantity = Math.max(1, Number(orderItem.quantity || 1));
  const unitAmount = roundMoney(
    selected.unit_amount
      || (Number(selected.allocated_amount || 0) / Math.max(1, Number(selected.quantity || 1)))
  );
  return {
    amount: roundMoney(unitAmount * quantity),
    source: selected.source,
    unitAmount
  };
}

async function main() {
  const [orders, orderItems, freightRecords, freightItems] = await Promise.all([
    Order.findAll({ attributes: ['order_id', 'order_no', 'store_id', 'create_time'], raw: true }),
    OrderItem.findAll({ attributes: ['item_id', 'order_id', 'product_id', 'sn_id', 'sn_code', 'quantity', 'freight_cost'], raw: true }),
    FreightRecord.findAll({
      where: { status: 'active' },
      attributes: [
        'freight_id', 'source_type', 'source_no', 'store_id', 'store_name',
        'to_store_id', 'to_store_name', 'create_time', 'update_time'
      ],
      raw: true
    }),
    FreightRecordItem.findAll({
      attributes: [
        'item_id', 'freight_id', 'product_id', 'sn_id', 'sn_code',
        'quantity', 'allocated_amount', 'unit_amount', 'create_time'
      ],
      raw: true
    })
  ]);

  const orderMap = new Map(orders.map(order => [referenceId(order.order_id), order]));
  const freightRecordsMap = new Map(
    freightRecords.map(record => [referenceId(record.freight_id), record])
  );
  const freightByProduct = freightItems;
  const rows = [];
  for (const item of orderItems) {
    const order = orderMap.get(referenceId(item.order_id));
    if (!order) continue;
    const oldResult = selectedFreightAmount(
      order,
      item,
      freightByProduct,
      freightRecordsMap,
      false
    );
    const newResult = selectedFreightAmount(
      order,
      item,
      freightByProduct,
      freightRecordsMap,
      true
    );
    const currentAmount = roundMoney(item.freight_cost);
    if (currentAmount === newResult.amount) continue;
    rows.push({
      orderNo: order.order_no,
      orderId: order.order_id,
      storeId: order.store_id,
      itemId: item.item_id,
      productId: item.product_id,
      currentAmount,
      oldRuleAmount: oldResult.amount,
      newRuleAmount: newResult.amount,
      difference: roundMoney(newResult.amount - currentAmount),
      oldSourceNo: oldResult.source?.source_no || '',
      oldSourceStore: oldResult.source?.store_name || oldResult.source?.to_store_name || '',
      newSourceNo: newResult.source?.source_no || '',
      newSourceStore: newResult.source?.store_name || newResult.source?.to_store_name || ''
    });
  }

  const summary = rows.reduce((result, row) => {
    result.itemCount += 1;
    result.currentTotal = roundMoney(result.currentTotal + row.currentAmount);
    result.newTotal = roundMoney(result.newTotal + row.newRuleAmount);
    result.decreaseTotal = roundMoney(result.decreaseTotal + Math.max(0, -row.difference));
    result.increaseTotal = roundMoney(result.increaseTotal + Math.max(0, row.difference));
    if (row.newRuleAmount === 0) result.willClearItemCount += 1;
    return result;
  }, {
    itemCount: 0,
    currentTotal: 0,
    newTotal: 0,
    decreaseTotal: 0,
    increaseTotal: 0,
    willClearItemCount: 0
  });

  const orderCount = new Set(rows.map(row => row.orderId)).size;
  console.log(JSON.stringify({
    mode: 'preview_only',
    scannedOrderCount: orders.length,
    scannedItemCount: orderItems.length,
    changedOrderCount: orderCount,
    summary,
    examples: rows.slice(0, EXAMPLE_LIMIT)
  }, null, 2));
}

main()
  .catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
