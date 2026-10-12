// October 2026 sales gross profit correction for two specified purchase sources.
// Preview by default. Pass --execute to update only matching order snapshots.
const { Op, QueryTypes } = require('sequelize');
const { sequelize, OrderGrossProfit } = require('../src/models');
const { calculateGrossProfitValues, roundMoney } = require('../src/modules/sales/grossProfit');
const { recordBusinessAction } = require('../src/utils/businessActionLog');

const START = '2026-10-01';
const END = '2026-11-01';
const SUPPLIER_IDS = ['SP2026091522196', 'SP2026071555763'];
const ALLOWED_STATUSES = new Set(['已归档', 'return_pending']);

function array(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  const parsed = JSON.parse(value);
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
  const execute = process.argv.includes('--execute');
  const orders = await sequelize.query(`
    SELECT DISTINCT o.ORDER_ID order_id, o.ORDER_NO order_no,
           o.ORDER_STATUS order_status, o.INVOICE_STATUS invoice_status
      FROM T_ORDER o
      JOIN T_ORDER_ITEM oi ON oi.ORDER_ID = o.ORDER_ID
      LEFT JOIN T_PRODUCT_SN sn ON sn.SN_ID = oi.SN_ID
     WHERE o.IS_DELETED = 0
       AND (o.CREATE_TIME >= :startDate AND o.CREATE_TIME < :endDate
         OR o.ARCHIVE_TIME >= :startDate AND o.ARCHIVE_TIME < :endDate)
       AND COALESCE(oi.SUPPLIER_ID, sn.SUPPLIER_ID) IN (:supplierIds)`,
    { replacements: { startDate: START, endDate: END, supplierIds: SUPPLIER_IDS }, type: QueryTypes.SELECT }
  );
  const orderIds = orders.map(order => order.order_id);
  const snapshots = orderIds.length ? await OrderGrossProfit.findAll({
    where: { order_id: { [Op.in]: orderIds } }, raw: true
  }) : [];
  const snapshotByOrder = new Map(snapshots.map(row => [row.order_id, row]));
  const targetLines = snapshots.flatMap(row => array(row.product_pricing_details)
    .filter(line => SUPPLIER_IDS.includes(line.supplierId)));
  const productIds = [...new Set(targetLines.map(line => line.productId).filter(Boolean))];
  const prices = productIds.length ? await sequelize.query(`
    SELECT PRODUCT_ID product_id, MAX(STANDARD_PRICE) standard_price
      FROM T_PRODUCT_PRICE WHERE STATUS = 1 AND PRODUCT_ID IN (:productIds)
     GROUP BY PRODUCT_ID`,
    { replacements: { productIds }, type: QueryTypes.SELECT }
  ) : [];
  const companyPriceByProduct = new Map(prices.map(row => [row.product_id, roundMoney(row.standard_price)]));
  const summary = {
    period: `${START}..${END}`, scannedOrders: orders.length, affectedOrders: 0,
    affectedItems: 0, amountChangedOrders: 0, beforeGrossProfit: 0, afterGrossProfit: 0,
    skippedStatuses: [], skippedMissingSnapshot: [], skippedSnapshotDrift: [], changes: []
  };

  for (const order of orders) {
    if (!ALLOWED_STATUSES.has(order.order_status)) {
      summary.skippedStatuses.push({ orderNo: order.order_no, status: order.order_status });
      continue;
    }
    const snapshot = snapshotByOrder.get(order.order_id);
    if (!snapshot || snapshot.snapshot_status !== 'final') {
      summary.skippedMissingSnapshot.push(order.order_no);
      continue;
    }
    const beforeLines = array(snapshot.product_pricing_details);
    const afterLines = beforeLines.map(line => ({ ...line }));
    const itemChanges = [];
    for (const line of afterLines) {
      if (!SUPPLIER_IDS.includes(line.supplierId)) continue;
      const companyPrice = companyPriceByProduct.get(line.productId);
      if (!(companyPrice > 0) || line.isSpecialPrice === true) {
        throw new Error(`订单 ${order.order_no} 商品 ${line.itemId} 缺少有效公司定价或存在特殊定价`);
      }
      if (roundMoney(line.unitPricing) === companyPrice && line.source === 'product_standard_price') continue;
      itemChanges.push({ itemId: line.itemId, productId: line.productId, supplierId: line.supplierId,
        beforeUnitPricing: roundMoney(line.unitPricing), afterUnitPricing: companyPrice,
        beforeSource: line.source || '' });
      line.unitPricing = companyPrice;
      line.pricingAmount = roundMoney(companyPrice * Number(line.quantity || 1));
      line.source = 'product_standard_price';
      line.isCompanyPriced = true;
      line.grossProfitUpliftAmount = 0;
      line.externalAdjustmentEligible = false;
    }
    if (!itemChanges.length) continue;

    const baseline = calculate(order, snapshot, beforeLines);
    if (roundMoney(baseline.productPricingAmount) !== roundMoney(snapshot.product_pricing_amount) ||
        roundMoney(baseline.paymentFeeAmount) !== roundMoney(snapshot.payment_fee_amount) ||
        roundMoney(baseline.vatAmount) !== roundMoney(snapshot.vat_amount) ||
        roundMoney(baseline.grossProfitAmount) !== roundMoney(snapshot.gross_profit_amount)) {
      summary.skippedSnapshotDrift.push(order.order_no);
      continue;
    }
    const after = calculate(order, snapshot, afterLines);
    const beforeAmounts = {
      productPricingAmount: roundMoney(snapshot.product_pricing_amount),
      vatTaxableAmount: roundMoney(snapshot.vat_taxable_amount),
      vatAmount: roundMoney(snapshot.vat_amount),
      grossProfitAmount: roundMoney(snapshot.gross_profit_amount)
    };
    const afterAmounts = {
      productPricingAmount: after.productPricingAmount,
      vatTaxableAmount: after.vatTaxableAmount,
      vatAmount: after.vatAmount,
      grossProfitAmount: after.grossProfitAmount
    };

    if (execute) {
      await sequelize.transaction(async transaction => {
        const current = await OrderGrossProfit.findOne({
          where: { order_id: order.order_id }, transaction, lock: transaction.LOCK.UPDATE
        });
        if (!current || current.snapshot_status !== 'final' ||
            JSON.stringify(array(current.product_pricing_details)) !== JSON.stringify(beforeLines) ||
            roundMoney(current.gross_profit_amount) !== beforeAmounts.grossProfitAmount) {
          throw new Error(`订单 ${order.order_no} 毛利快照已变化，停止刷新`);
        }
        await current.update({
          product_pricing_details: afterLines,
          product_pricing_amount: afterAmounts.productPricingAmount,
          vat_taxable_amount: afterAmounts.vatTaxableAmount,
          vat_amount: afterAmounts.vatAmount,
          gross_profit_amount: afterAmounts.grossProfitAmount,
          calculated_by: 'october_supplier_company_price_refresh',
          calculated_at: new Date(), update_time: new Date()
        }, { transaction });
        await recordBusinessAction({
          businessType: 'sales_order', businessId: order.order_id, businessNo: order.order_no,
          action: 'gross_profit_corrected', fromStatus: order.order_status, toStatus: order.order_status,
          user: { name: 'system_october_supplier_company_price_refresh' },
          comment: '按指定采购来源公司定价口径刷新2026年10月订单毛利，保留其他商品和费用快照',
          detail: { before: beforeAmounts, after: afterAmounts, items: itemChanges }, transaction
        });
      });
    }
    summary.affectedOrders += 1;
    summary.affectedItems += itemChanges.length;
    if (beforeAmounts.grossProfitAmount !== afterAmounts.grossProfitAmount) summary.amountChangedOrders += 1;
    summary.beforeGrossProfit = roundMoney(summary.beforeGrossProfit + beforeAmounts.grossProfitAmount);
    summary.afterGrossProfit = roundMoney(summary.afterGrossProfit + afterAmounts.grossProfitAmount);
    summary.changes.push({ orderNo: order.order_no, before: beforeAmounts, after: afterAmounts, items: itemChanges });
  }
  console.log(JSON.stringify({ mode: execute ? 'executed' : 'preview', ...summary }, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => sequelize.close());
