// Correct only the one-character input lag proven by the stored Guobu payment amount.
// Preview by default. Preserve frozen pricing, fees and all unrelated order facts.
const fs = require('fs');
const path = require('path');
const { sequelize, Order, OrderPayment, OrderGrossProfit, SalesReturnGrossProfitLedger } = require('../src/models');
const { roundMoney, snapshotToResponse, calculateGrossProfitValues } = require('../src/modules/sales/grossProfit');
const { updateReturnLedgers } = require('./migrate-final-order-gross-profit-to-current');
const { recordBusinessAction } = require('../src/utils/businessActionLog');
const execute = process.argv.includes('--execute');

function calculate(snapshot, invoiceAmount, invoiceStatus) {
  const saved = snapshotToResponse(snapshot);
  return calculateGrossProfitValues({
    receivableAmount: saved.receivableAmount,
    paymentDetails: saved.paymentDetails,
    productPricingDetails: saved.productPricingDetails,
    supplementDetails: saved.supplementDetails,
    freightCostDetails: saved.freightCostDetails,
    invoiceAmount, invoiceStatus
  });
}

async function main() {
  sequelize.options.logging = false;
  const [rows] = await sequelize.query(`SELECT o.ORDER_ID orderId, o.ORDER_NO orderNo,
    o.ORDER_STATUS status, o.INVOICE_STATUS invoiceStatus, o.INVOICE_AMOUNT invoiceAmount,
    o.TOTAL_AMOUNT totalAmount, o.NATIONAL_SUBSIDY nationalSubsidy,
    (SELECT SUM(p.AMOUNT) FROM T_ORDER_PAYMENT p
      WHERE p.ORDER_ID=o.ORDER_ID AND p.PAYMENT_METHOD LIKE :pattern) guobuPayments
    FROM T_ORDER o WHERE o.IS_DELETED=0
    AND ((o.CREATE_TIME >= '2026-10-01' AND o.CREATE_TIME < '2026-11-01')
      OR (o.ARCHIVE_TIME >= '2026-10-01' AND o.ARCHIVE_TIME < '2026-11-01'))
    AND (o.NATIONAL_SUBSIDY > 0 OR EXISTS(SELECT 1 FROM T_ORDER_PAYMENT p
      WHERE p.ORDER_ID=o.ORDER_ID AND p.PAYMENT_METHOD LIKE :pattern))`,
    { replacements: { pattern: '%国补%' } });
  const candidates = [], review = [], excluded = [];
  for (const row of rows) {
    const amount = roundMoney(row.invoiceAmount), gross = roundMoney(row.guobuPayments);
    if (!(gross > 0 && amount > 0 && amount < gross * 0.3)) continue;
    if (!['已归档', 'returned', 'completed', 'archived'].includes(row.status)) {
      excluded.push(row); continue;
    }
    // Missing the last typed digit is unambiguous only when it matches saved payments.
    const isPrefix = Number.isInteger(gross) && amount === Math.floor(gross / 10);
    if (!isPrefix || gross > Number(row.totalAmount) + 0.01 || row.invoiceStatus === '不开票') {
      review.push(row); continue;
    }
    candidates.push(row);
  }
  const backups = { orders: [], snapshots: [], payments: [], returnLedgers: [] };
  const result = { mode: execute ? 'execute' : 'preview', audited: rows.length, corrected: [], review, excluded, failures: [] };
  for (const candidate of candidates) {
    try {
      const next = await sequelize.transaction(async transaction => {
        const order = await Order.findByPk(candidate.orderId, { transaction, lock: transaction.LOCK.UPDATE });
        const snapshot = await OrderGrossProfit.findOne({ where: { order_id: candidate.orderId }, transaction, lock: transaction.LOCK.UPDATE });
        if (!snapshot || snapshot.snapshot_status !== 'final') throw new Error('缺少最终毛利快照');
        if (roundMoney(order.invoice_amount) !== roundMoney(candidate.invoiceAmount)) throw new Error('开票金额已变化');
        const payments = await OrderPayment.findAll({ where: { order_id: candidate.orderId }, transaction, raw: true });
        const paymentTotal = roundMoney(payments.filter(p => String(p.payment_method).includes('国补')).reduce((sum, p) => sum + Number(p.amount), 0));
        if (paymentTotal !== roundMoney(candidate.guobuPayments)) throw new Error('国补收款金额已变化');
        const previous = calculate(snapshot, order.invoice_amount, order.invoice_status);
        if (Math.abs(previous.grossProfitAmount - Number(snapshot.gross_profit_amount)) > 0.01) throw new Error('原快照无法按冻结明细复算');
        const values = calculate(snapshot, paymentTotal, order.invoice_status);
        const item = { orderNo: order.order_no, beforeInvoice: Number(order.invoice_amount), afterInvoice: paymentTotal,
          beforeVat: Number(snapshot.vat_amount), afterVat: values.vatAmount,
          beforeProfit: Number(snapshot.gross_profit_amount), afterProfit: values.grossProfitAmount };
        backups.orders.push(order.toJSON()); backups.snapshots.push(snapshot.toJSON()); backups.payments.push(...payments);
        const ledgers = await SalesReturnGrossProfitLedger.findAll({ where: { order_id: order.order_id }, transaction, raw: true });
        item.beforeReturnProfit = roundMoney(ledgers.reduce((sum, row) => sum + Number(row.gross_profit_amount), 0));
        backups.returnLedgers.push(...ledgers);
        if (execute) {
          // Persist the complete recovery data before the first write for every order.
          fs.writeFileSync(backupFile, JSON.stringify(backups, null, 2));
          await order.update({ invoice_amount: paymentTotal, update_time: new Date() }, { transaction });
          await snapshot.update({ invoice_amount: paymentTotal, vat_taxable_amount: values.vatTaxableAmount,
            vat_amount: values.vatAmount, gross_profit_amount: values.grossProfitAmount,
            calculated_by: 'october_stale_invoice_repair', calculated_at: new Date(), update_time: new Date() }, { transaction });
          item.returnLedgerRows = await updateReturnLedgers(order, item.beforeProfit, item.afterProfit, transaction);
          const nextLedgers = await SalesReturnGrossProfitLedger.findAll({ where: { order_id: order.order_id }, transaction, raw: true });
          item.afterReturnProfit = roundMoney(nextLedgers.reduce((sum, row) => sum + Number(row.gross_profit_amount), 0));
          await recordBusinessAction({ businessType: 'sales_order', businessId: order.order_id,
            businessNo: order.order_no, action: 'invoice_amount_corrected', user: { name: 'october_stale_invoice_repair' },
            comment: '修正国补金额输入滞后一位导致的默认开票金额错误，按已存国补收款原价恢复，保留冻结成本与收款税率', detail: item, transaction });
        }
        return item;
      });
      result.corrected.push(next);
    } catch (error) { result.failures.push({ orderNo: candidate.orderNo, error: error.message }); }
  }
  result.invoiceIncrease = roundMoney(result.corrected.reduce((s, r) => s + r.afterInvoice - r.beforeInvoice, 0));
  result.profitDelta = roundMoney(result.corrected.reduce((s, r) => s + r.afterProfit - r.beforeProfit, 0));
  if (execute) {
    result.verificationErrors = [];
    for (const expected of result.corrected) {
      const order = await Order.findOne({ where: { order_no: expected.orderNo }, raw: true });
      const snapshot = await OrderGrossProfit.findOne({ where: { order_id: order.order_id }, raw: true });
      if (roundMoney(order.invoice_amount) !== expected.afterInvoice || roundMoney(snapshot.gross_profit_amount) !== expected.afterProfit)
        result.verificationErrors.push(expected.orderNo);
    }
  }
  fs.writeFileSync(resultFile, JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ ...result, corrected: result.corrected.length, resultFile, backupFile: execute ? backupFile : null }));
  if (result.failures.length || result.verificationErrors?.length) process.exitCode = 1;
}
const stamp = Date.now();
const backupFile = path.join(__dirname, '../../backup', `october-invoice-before-${stamp}.json`);
const resultFile = path.join(__dirname, '../../backup', `october-invoice-${execute ? 'result' : 'preview'}-${stamp}.json`);
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => sequelize.close());
