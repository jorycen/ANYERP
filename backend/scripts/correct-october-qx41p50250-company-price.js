// Correct the QX41P50250 product tag and its October 2026 archived snapshots.
// Preview by default; --execute applies product, snapshot and settlement changes atomically.
const { QueryTypes } = require('sequelize');
const fs = require('fs');
const path = require('path');
const {
  sequelize, Product, ProductPrice, OrderGrossProfit,
  ProductSettlementOrder, ProductSettlementItem
} = require('../src/models');
const { calculateGrossProfitValues, roundMoney } = require('../src/modules/sales/grossProfit');
const { _test: { summarizeProductSettlementItems } } = require('../src/modules/report/productSettlement');
const { recordBusinessAction } = require('../src/utils/businessActionLog');

const PRODUCT_ID = 'd87a16cfdecd461a97fa79fbf7e0b6dd';
const PN = 'QX41P50250';
const CALCULATED_BY = 'october_qx41p50250_company_price_correction';
const execute = process.argv.includes('--execute');

function array(value) {
  if (Array.isArray(value)) return value;
  const parsed = JSON.parse(value || '[]');
  if (!Array.isArray(parsed)) throw new Error('毛利明细不是数组');
  return parsed;
}

function calculate(order, snapshot, lines) {
  const adjustments = array(snapshot.supplement_details);
  return calculateGrossProfitValues({
    receivableAmount: snapshot.receivable_amount,
    paymentDetails: array(snapshot.payment_fee_details),
    productPricingDetails: lines,
    supplementDetails: adjustments.filter(item => item.source !== 'freight_cost'),
    freightCostDetails: adjustments.filter(item => item.source === 'freight_cost'),
    invoiceAmount: snapshot.invoice_amount,
    invoiceStatus: order.invoice_status,
    externalAdjustmentEligible: lines.some(item => item.externalAdjustmentEligible === true)
  });
}

async function main() {
  const product = await Product.findByPk(PRODUCT_ID, { raw: true });
  const price = await ProductPrice.findOne({ where: { product_id: PRODUCT_ID, status: 1 }, raw: true });
  if (!product || product.manufacturer_code !== PN || !price || roundMoney(price.standard_price) !== 80) {
    throw new Error('商品或公司定价与预期不一致');
  }
  if (!['PURCHASE_PRICE', 'COMPANY_PRICE'].includes(product.gross_profit_cost_mode)) {
    throw new Error('商品计价标签与预期不一致');
  }
  const orders = await sequelize.query(`
    SELECT DISTINCT o.ORDER_ID order_id, o.ORDER_NO order_no, o.ORDER_STATUS order_status,
           o.INVOICE_STATUS invoice_status, gp.GROSS_PROFIT_ID gross_profit_id
      FROM T_ORDER o
      JOIN T_ORDER_ITEM oi ON oi.ORDER_ID = o.ORDER_ID AND oi.PRODUCT_ID = :productId
      JOIN T_ORDER_GROSS_PROFIT gp ON gp.ORDER_ID = o.ORDER_ID
     WHERE o.IS_DELETED = 0 AND o.ORDER_STATUS = '已归档'
       AND gp.SNAPSHOT_STATUS = 'final'
       AND (o.CREATE_TIME >= '2026-10-01' AND o.CREATE_TIME < '2026-11-01'
         OR o.ARCHIVE_TIME >= '2026-10-01' AND o.ARCHIVE_TIME < '2026-11-01')
     ORDER BY o.ORDER_NO`,
    { replacements: { productId: PRODUCT_ID }, type: QueryTypes.SELECT }
  );
  if (orders.length !== 11) throw new Error(`10 月有效归档订单数已变化：${orders.length}`);
  const plans = [];
  for (const order of orders) {
    const snapshot = await OrderGrossProfit.findOne({ where: { order_id: order.order_id }, raw: true });
    if (snapshot.formula_version !== 'ORDER_GP_V11_PRODUCT_COST_MODE') {
      throw new Error(`订单 ${order.order_no} 公式版本不是 V11`);
    }
    const beforeLines = array(snapshot.product_pricing_details);
    const targetLines = beforeLines.filter(line => line.productId === PRODUCT_ID);
    if (targetLines.length !== 1 || Number(targetLines[0].specialPrice || 0) > 0) {
      throw new Error(`订单 ${order.order_no} 商品行或特价与预期不一致`);
    }
    const line = targetLines[0];
    const afterLines = beforeLines.map(item => item === line ? {
      ...item, unitPricing: 80, pricingAmount: roundMoney(80 * Number(item.quantity || 1)),
      source: 'product_standard_price', isCompanyPriced: true,
      grossProfitUpliftAmount: 0, externalAdjustmentEligible: false
    } : item);
    const before = calculate(order, snapshot, beforeLines);
    if (roundMoney(snapshot.product_pricing_amount) !== before.productPricingAmount ||
        roundMoney(snapshot.payment_fee_amount) !== before.paymentFeeAmount ||
        roundMoney(snapshot.vat_amount) !== before.vatAmount ||
        roundMoney(snapshot.gross_profit_amount) !== before.grossProfitAmount) {
      throw new Error(`订单 ${order.order_no} 原毛利快照无法复算，停止修改`);
    }
    const after = calculate(order, snapshot, afterLines);
    const settlement = await ProductSettlementOrder.findOne({
      where: { source_order_id: order.order_id }, raw: true
    });
    if (!settlement) throw new Error(`订单 ${order.order_no} 缺少产品端结算单`);
    const settlementItems = await ProductSettlementItem.findAll({
      where: { settlement_id: settlement.settlement_id }, raw: true
    });
    const settlementItem = settlementItems.find(item => String(item.source_order_item_id) === String(line.itemId));
    if (!settlementItem || settlementItem.product_id !== PRODUCT_ID) {
      throw new Error(`订单 ${order.order_no} 产品端商品行不匹配`);
    }
    const newItemProfit = settlementItem.cost_status === 'ready'
      ? roundMoney(80 * Number(settlementItem.quantity || 1) - Number(settlementItem.purchase_cost_amount || 0)) : 0;
    const afterSettlementItems = settlementItems.map(item => item === settlementItem ? {
      ...item, product_unit_price: 80, product_price_source: 'product_standard_price',
      gross_profit_amount: newItemProfit
    } : item);
    const afterSettlement = summarizeProductSettlementItems(afterSettlementItems);
    plans.push({ order, snapshot, beforeLines, afterLines, before, after, settlement,
      settlementItem, newItemProfit, afterSettlement,
      sourceBefore: line.source, priceBefore: roundMoney(line.unitPricing) });
  }
  console.log(JSON.stringify({ mode: execute ? 'execute' : 'preview', pn: PN,
    oldProductMode: product.gross_profit_cost_mode, newProductMode: 'COMPANY_PRICE',
    affectedOrders: plans.length, amountChangedOrders: plans.filter(p => p.before.grossProfitAmount !== p.after.grossProfitAmount).length,
    changes: plans.map(p => ({ orderNo: p.order.order_no, beforeUnitPricing: p.priceBefore,
      afterUnitPricing: 80, beforeSource: p.sourceBefore,
      beforeGrossProfit: p.before.grossProfitAmount, afterGrossProfit: p.after.grossProfitAmount })) }, null, 2));
  if (!execute) return;

  const backupFile = path.join(__dirname, '../../backup', 'qx41p50250-october-before-20261012.json');
  fs.mkdirSync(path.dirname(backupFile), { recursive: true });
  fs.writeFileSync(backupFile, JSON.stringify({ product, plans: plans.map(plan => ({
    order: plan.order, snapshot: plan.snapshot, settlement: plan.settlement,
    settlementItem: plan.settlementItem
  })) }, null, 2), { flag: 'wx' });

  await sequelize.transaction(async transaction => {
    const currentProduct = await Product.findByPk(PRODUCT_ID, { transaction, lock: transaction.LOCK.UPDATE });
    if (currentProduct.gross_profit_cost_mode !== product.gross_profit_cost_mode) {
      throw new Error('商品标签已变化，事务已回滚');
    }
    await currentProduct.update({ gross_profit_cost_mode: 'COMPANY_PRICE' }, { transaction });
    for (const plan of plans) {
      const current = await OrderGrossProfit.findByPk(plan.order.gross_profit_id, {
        transaction, lock: transaction.LOCK.UPDATE
      });
      if (!current || JSON.stringify(array(current.product_pricing_details)) !== JSON.stringify(plan.beforeLines) ||
          roundMoney(current.gross_profit_amount) !== plan.before.grossProfitAmount) {
        throw new Error(`订单 ${plan.order.order_no} 毛利快照已变化，事务已回滚`);
      }
      await current.update({
        product_pricing_details: plan.afterLines,
        product_pricing_amount: plan.after.productPricingAmount,
        vat_taxable_amount: plan.after.vatTaxableAmount,
        vat_amount: plan.after.vatAmount,
        gross_profit_amount: plan.after.grossProfitAmount,
        calculated_by: CALCULATED_BY, calculated_at: new Date(), update_time: new Date()
      }, { transaction });
      const item = await ProductSettlementItem.findByPk(plan.settlementItem.settlement_item_id, {
        transaction, lock: transaction.LOCK.UPDATE
      });
      if (!item || roundMoney(item.product_unit_price) !== roundMoney(plan.settlementItem.product_unit_price) ||
          item.product_price_source !== plan.settlementItem.product_price_source) {
        throw new Error(`订单 ${plan.order.order_no} 产品端商品行已变化，事务已回滚`);
      }
      await item.update({ product_unit_price: 80, product_price_source: 'product_standard_price',
        gross_profit_amount: plan.newItemProfit }, { transaction });
      const settlement = await ProductSettlementOrder.findByPk(plan.settlement.settlement_id, {
        transaction, lock: transaction.LOCK.UPDATE
      });
      if (!settlement || roundMoney(settlement.product_pricing_amount) !== roundMoney(plan.settlement.product_pricing_amount)) {
        throw new Error(`订单 ${plan.order.order_no} 产品端结算单已变化，事务已回滚`);
      }
      await settlement.update({
        product_pricing_amount: plan.afterSettlement.productPricingAmount,
        purchase_cost_amount: plan.afterSettlement.purchaseCostAmount,
        cost_pending_amount: plan.afterSettlement.costPendingAmount,
        gross_profit_amount: plan.afterSettlement.grossProfitAmount,
        status: plan.afterSettlement.status,
        update_time: new Date()
      }, { transaction });
      await recordBusinessAction({ businessType: 'sales_order', businessId: plan.order.order_id,
        businessNo: plan.order.order_no, action: 'gross_profit_corrected',
        fromStatus: plan.order.order_status, toStatus: plan.order.order_status,
        user: { name: 'system_october_qx41p50250_company_price_correction' },
        comment: 'QX41P50250 按公司定价 80 元修正 10 月订单毛利，保留其他商品及费用',
        detail: { itemId: plan.settlementItem.source_order_item_id,
          beforeUnitPricing: plan.priceBefore, afterUnitPricing: 80,
          beforeGrossProfit: plan.before.grossProfitAmount, afterGrossProfit: plan.after.grossProfitAmount },
        transaction });
    }
  });
  console.log(JSON.stringify({ executedOrders: plans.length, productMode: 'COMPANY_PRICE', backupFile }));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => sequelize.close());
