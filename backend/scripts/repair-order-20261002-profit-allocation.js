// One-order correction. Preview by default; pass --execute to update price tags and refresh its archived GP snapshot.
const { sequelize, ProductSettlementOrder, ProductSettlementItem, OrderGrossProfit } = require('../src/models');
const { calculateAndSaveOrderGrossProfit } = require('../src/modules/sales/grossProfit');
const { _test: { summarizeProductSettlementItems } } = require('../src/modules/report/productSettlement');

const ORDER_ID = 'd233836c141a44149dda42ec7da7b5ad';
const PRODUCT_IDS = [
  '5735b630937d407cbee93d54662cc3a6', // QX41P50255
  'b7823c69f29b4f8d9afe4d462437e89e'  // QXR1M21517
];

async function main() {
  const [orders] = await sequelize.query(
    'SELECT ORDER_NO, ORDER_STATUS FROM T_ORDER WHERE ORDER_ID = :orderId AND IS_DELETED = 0',
    { replacements: { orderId: ORDER_ID } }
  );
  const [products] = await sequelize.query(
    'SELECT PRODUCT_ID, MANUFACTURER_CODE, GROSS_PROFIT_COST_MODE FROM T_PRODUCT WHERE PRODUCT_ID IN (:productIds)',
    { replacements: { productIds: PRODUCT_IDS } }
  );
  if (orders.length !== 1 || orders[0].ORDER_STATUS !== '已归档' || products.length !== PRODUCT_IDS.length) {
    throw new Error('订单或商品状态与预期不一致，已停止');
  }
  console.log(JSON.stringify({ order: orders[0], products, execute: process.argv.includes('--execute') }, null, 2));
  if (!process.argv.includes('--execute')) return;

  await sequelize.transaction(async transaction => {
    await sequelize.query(
      "UPDATE T_PRODUCT SET GROSS_PROFIT_COST_MODE = 'COMPANY_PRICE' WHERE PRODUCT_ID IN (:productIds) AND GROSS_PROFIT_COST_MODE = 'PURCHASE_PRICE'",
      { replacements: { productIds: PRODUCT_IDS }, transaction }
    );
    await calculateAndSaveOrderGrossProfit(ORDER_ID, {
      transaction, calculatedBy: 'order_20261002_pricing_correction', force: true, final: true
    });
    const snapshot = await OrderGrossProfit.findOne({ where: { order_id: ORDER_ID }, transaction, raw: true });
    const details = Array.isArray(snapshot.product_pricing_details)
      ? snapshot.product_pricing_details : JSON.parse(snapshot.product_pricing_details);
    const settlement = await ProductSettlementOrder.findOne({ where: { source_order_id: ORDER_ID }, transaction });
    if (!settlement) throw new Error('产品端结算单不存在，事务已回滚');
    const settlementItems = await ProductSettlementItem.findAll({
      where: { settlement_id: settlement.settlement_id }, transaction
    });
    for (const item of settlementItems) {
      const detail = details.find(row => String(row.itemId) === String(item.source_order_item_id));
      if (!detail) throw new Error(`结算商品行 ${item.source_order_item_id} 缺少毛利快照，事务已回滚`);
      if (!PRODUCT_IDS.includes(item.product_id)) continue;
      const unitPrice = Number(detail.unitPricing);
      await item.update({
        product_unit_price: unitPrice,
        product_price_source: detail.source,
        gross_profit_amount: item.cost_status === 'ready'
          ? Number((unitPrice * Number(item.quantity) - Number(item.purchase_cost_amount)).toFixed(2)) : 0
      }, { transaction });
    }
    const summary = summarizeProductSettlementItems(settlementItems.map(item => item.toJSON()));
    await settlement.update({
      product_pricing_amount: summary.productPricingAmount,
      purchase_cost_amount: summary.purchaseCostAmount,
      cost_pending_amount: summary.costPendingAmount,
      gross_profit_amount: summary.grossProfitAmount,
      status: summary.status
    }, { transaction });
  });
  const [snapshot] = await sequelize.query(
    'SELECT FORMULA_VERSION, PRODUCT_PRICING_AMOUNT, PAYMENT_FEE_AMOUNT, VAT_AMOUNT, FREIGHT_COST_AMOUNT, GROSS_PROFIT_AMOUNT, PRODUCT_PRICING_DETAILS FROM T_ORDER_GROSS_PROFIT WHERE ORDER_ID = :orderId',
    { replacements: { orderId: ORDER_ID } }
  );
  console.log(JSON.stringify(snapshot[0], null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => sequelize.close());
