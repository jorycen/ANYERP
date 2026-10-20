// Restore the exact pre-refresh historical costs; retain user-confirmed invoice corrections.
const fs = require('fs');
const path = require('path');
const { sequelize, Order, OrderItem, OrderGrossProfit, ProductSettlementOrder,
  ProductSettlementItem, SalesReturnGrossProfitLedger } = require('../src/models');
const { roundMoney, snapshotToResponse, VAT_RATE } = require('../src/modules/sales/grossProfit');
const { updateReturnLedgers } = require('./migrate-final-order-gross-profit-to-current');
const { recordBusinessAction } = require('../src/utils/businessActionLog');
const dir = path.join(__dirname, '../../backup');
const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const original = read('migrate-final-order-gross-profit-october-before-1792469365888.json');
const runs = ['1792469365888', '1792469549801'].flatMap(id => read(`migrate-final-order-gross-profit-october-result-${id}.json`).results);
const invoices = [...read('october-invoice-result-1792470144890.json').corrected,
  read('october-invoice-confirmed-result-1792470502620.json')];
const invoiceByNo = new Map(invoices.map(row => [row.orderNo, row]));
const runByNo = new Map(runs.map(row => [row.orderNo, row]));
const execute = process.argv.includes('--execute');
const fields = ['formula_version', 'received_amount', 'receivable_amount', 'settlement_cost_amount',
  'product_pricing_amount', 'payment_fee_amount', 'invoice_amount', 'vat_taxable_amount', 'vat_amount',
  'supplement_amount', 'freight_cost_amount', 'gross_profit_amount', 'payment_fee_details',
  'settlement_cost_details', 'product_pricing_details', 'supplement_details', 'snapshot_status'];
function same(a, b) {
  if (a === null || b === null || a === undefined || b === undefined) return a == b;
  if (typeof a === 'object' || typeof b === 'object') {
    const parse = v => typeof v === 'string' ? JSON.parse(v) : v;
    return JSON.stringify(parse(a)) === JSON.stringify(parse(b));
  }
  return String(a) === String(b) || (Number.isFinite(Number(a)) && Number(a) === Number(b));
}
function targetSnapshot(old) {
  const target = Object.fromEntries(fields.map(field => [field, old[field]]));
  const invoice = invoiceByNo.get(old.order_no);
  if (invoice) {
    target.invoice_amount = invoice.afterInvoice;
    target.vat_taxable_amount = roundMoney(Math.max(0, invoice.afterInvoice - Number(old.product_pricing_amount)));
    target.vat_amount = roundMoney(target.vat_taxable_amount * VAT_RATE);
    const beforeFee = snapshotToResponse(old).externalAdjustmentFee;
    const afterFee = snapshotToResponse({ ...old, ...target }).externalAdjustmentFee;
    target.gross_profit_amount = roundMoney(Number(old.gross_profit_amount) -
      (target.vat_amount - Number(old.vat_amount)) - (afterFee - beforeFee));
  }
  return target;
}
const group = (rows, field) => {
  const map = new Map();
  rows.forEach(row => { const key = String(row[field]); map.set(key, [...(map.get(key) || []), row]); });
  return map;
};

async function main() {
  sequelize.options.logging = false;
  const ids = original.snapshotsBefore.map(row => row.order_id);
  const currentSnapshots = await OrderGrossProfit.findAll({ where: { order_id: ids }, raw: true });
  const snapshotById = new Map(currentSnapshots.map(row => [row.order_id, row]));
  const plan = original.snapshotsBefore.map(old => {
    const current = snapshotById.get(old.order_id);
    if (!current) throw new Error(`Missing snapshot ${old.order_no}`);
    const invoice = invoiceByNo.get(old.order_no), run = runByNo.get(old.order_no);
    const expected = invoice ? invoice.afterProfit : run ? run.after : Number(old.gross_profit_amount);
    if (roundMoney(current.gross_profit_amount) !== roundMoney(expected)) throw new Error(`Concurrent profit change ${old.order_no}`);
    const target = targetSnapshot(old);
    return { old, current, target, changed: fields.some(key => !same(current[key], target[key])) };
  });
  const settlementsByOrder = group(original.settlementsBefore, 'source_order_id');
  const settlementItems = group(original.settlementItemsBefore, 'settlement_id');
  const ledgersByOrder = group(original.returnLedgersBefore, 'order_id');
  const itemsByOrder = group(original.orderItemsBefore, 'order_id');
  const stamp = Date.now();
  const backupFile = path.join(dir, `restore-october-historical-before-${stamp}.json`);
  if (execute) {
    const settlements = await ProductSettlementOrder.findAll({ where: { source_order_id: ids }, raw: true });
    fs.writeFileSync(backupFile, JSON.stringify({ snapshots: currentSnapshots, settlements,
      settlementItems: await ProductSettlementItem.findAll({ where: { settlement_id: settlements.map(row => row.settlement_id) }, raw: true }),
      ledgers: await SalesReturnGrossProfitLedger.findAll({ where: { order_id: ids }, raw: true }),
      items: await OrderItem.findAll({ where: { order_id: ids }, raw: true }) }, null, 2), { flag: 'wx' });
  }
  const summary = { mode: execute ? 'execute' : 'preview', checked: plan.length, restoredSnapshots: 0,
    restoredSettlementItems: 0, restoredSettlements: 0, restoredLedgers: 0, filledSubtotals: 0, filledPrices: 0,
    invoiceCorrectionsRetained: invoices.length, failures: [], details: [] };
  let cursor = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
  while (cursor < plan.length) {
    const row = plan[cursor++];
    const detail = { orderNo: row.old.order_no, originalProfit: Number(row.old.gross_profit_amount),
      currentProfit: Number(row.current.gross_profit_amount), targetProfit: Number(row.target.gross_profit_amount) };
    summary.details.push(detail);
    if (!execute) continue;
    try {
      const counts = await sequelize.transaction(async transaction => {
        const counts = { restoredSnapshots: 0, restoredSettlementItems: 0, restoredSettlements: 0, restoredLedgers: 0, filledSubtotals: 0, filledPrices: 0 };
        const snapshot = await OrderGrossProfit.findByPk(row.current.gross_profit_id, { transaction, lock: transaction.LOCK.UPDATE });
        if (!fields.every(key => same(snapshot[key], row.current[key]))) throw new Error('Snapshot changed during restoration');
        if (row.changed) {
          await snapshot.update({ ...row.target, calculated_by: 'restore_historical_cost_keep_invoice', calculated_at: new Date(), update_time: new Date() }, { transaction });
          counts.restoredSnapshots++;
        }
        for (const old of settlementsByOrder.get(row.old.order_id) || []) {
          for (const item of settlementItems.get(String(old.settlement_id)) || []) {
            const current = await ProductSettlementItem.findByPk(item.settlement_item_id, { transaction });
            const keys = ['product_unit_price', 'product_price_source', 'gross_profit_amount'];
            if (!current) throw new Error('Missing product settlement item');
            if (keys.some(key => !same(current[key], item[key]))) {
              await current.update(Object.fromEntries(keys.map(key => [key, item[key]])), { transaction }); counts.restoredSettlementItems++;
            }
          }
          const current = await ProductSettlementOrder.findByPk(old.settlement_id, { transaction });
          const keys = ['product_pricing_amount', 'purchase_cost_amount', 'cost_pending_amount', 'gross_profit_amount', 'status'];
          if (!current) throw new Error('Missing product settlement');
          if (keys.some(key => !same(current[key], old[key]))) {
            await current.update({ ...Object.fromEntries(keys.map(key => [key, old[key]])), update_time: new Date() }, { transaction }); counts.restoredSettlements++;
          }
        }
        for (const old of ledgersByOrder.get(row.old.order_id) || []) {
          const current = await SalesReturnGrossProfitLedger.findByPk(old.ledger_id, { transaction });
          if (!current) throw new Error('Missing return ledger');
          if (!same(current.gross_profit_amount, old.gross_profit_amount)) {
            await current.update({ gross_profit_amount: old.gross_profit_amount }, { transaction }); counts.restoredLedgers++;
          }
        }
        if (invoiceByNo.has(row.old.order_no) && Number(row.target.gross_profit_amount) !== Number(row.old.gross_profit_amount)) {
          const order = await Order.findByPk(row.old.order_id, { transaction });
          await updateReturnLedgers(order, Number(row.old.gross_profit_amount), Number(row.target.gross_profit_amount), transaction);
        }
        for (const old of itemsByOrder.get(row.old.order_id) || []) {
          const current = await OrderItem.findByPk(old.item_id, { transaction });
          if (!current) throw new Error('Missing order item');
          const patch = {};
          if (!same(current.freight_cost, old.freight_cost)) patch.freight_cost = old.freight_cost;
          const quantity = Number(current.quantity);
          if (quantity > 0 && Number(current.subtotal) === 0 && Number(current.sale_price) > 0) {
            patch.subtotal = roundMoney(Number(current.sale_price) * quantity); counts.filledSubtotals++;
          } else if (quantity > 0 && Number(current.sale_price) === 0 && Number(current.subtotal) > 0) {
            patch.sale_price = roundMoney(Number(current.subtotal) / quantity); counts.filledPrices++;
          }
          if (Object.keys(patch).length) await current.update(patch, { transaction });
        }
        if (detail.currentProfit !== detail.targetProfit) await recordBusinessAction({ businessType: 'sales_order', businessId: row.old.order_id,
          businessNo: row.old.order_no, action: 'historical_profit_restored', user: { name: 'restore_historical_cost_keep_invoice' },
          comment: '撤销按当前定价回算，恢复更新前历史成本；保留用户确认的开票修正，仅补齐缺失销售单价与小计。', detail, transaction });
        return counts;
      });
      for (const [key, count] of Object.entries(counts)) summary[key] += count;
    } catch (error) { summary.failures.push({ orderNo: row.old.order_no, error: error.message }); }
    if (summary.details.length % 100 === 0) console.log(JSON.stringify({ progress: summary.details.length, total: plan.length, failed: summary.failures.length }));
  }
  }));
  summary.beforeProfit = roundMoney(plan.reduce((s, r) => s + Number(r.current.gross_profit_amount), 0));
  summary.targetProfit = roundMoney(plan.reduce((s, r) => s + Number(r.target.gross_profit_amount), 0));
  summary.changedProfitOrders = plan.filter(row => Number(row.current.gross_profit_amount) !== Number(row.target.gross_profit_amount)).length;
  summary.resultFile = path.join(dir, `restore-october-historical-${execute ? 'result' : 'preview'}-${stamp}.json`);
  if (execute) {
    summary.verificationErrors = [];
    const after = await OrderGrossProfit.findAll({ where: { order_id: ids }, raw: true });
    const targets = new Map(plan.map(row => [row.old.order_id, row.target]));
    for (const row of after) if (!fields.every(key => same(row[key], targets.get(row.order_id)[key]))) summary.verificationErrors.push(row.order_no);
  }
  fs.writeFileSync(summary.resultFile, JSON.stringify(summary, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ ...summary, details: undefined }));
  if (summary.failures.length || summary.verificationErrors?.length) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => sequelize.close());
