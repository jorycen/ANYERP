const M = require('../src/models');
const C = require('../src/modules/report/settlementPriceCorrection');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { recordBusinessAction } = require('../src/utils/businessActionLog');
const no = 'ORD202610100749263841';
const batch = 'INVOICE-20261105-' + no;
const input = { type: C.INVOICE_TYPE, invoiceAmount: 19999, invoiceStatus: '开专票', periodMode: 'original' };
const plain = x => JSON.parse(JSON.stringify(x));
const ctx = { state: { user: { name: '用户授权（Codex会话）', accessibleStoreIds: ['D0215790'] } } };
let backup;
async function main() {
  await M.sequelize.transaction(async transaction => {
    const order = await M.Order.findOne({ where: { order_no: no }, transaction, lock: transaction.LOCK.UPDATE });
    assert(order);
    ctx.state.user.accessibleStoreIds = [order.store_id];
    const selected = await C.select(ctx, order.order_id, input, transaction);
    const r = selected.result;
    assert.equal(r.beforeInvoiceStatus, '不开票');
    assert.equal(r.targetMonth, '2026-10');
    assert.equal(r.vatBefore, 0);
    assert.equal(r.vatAfter, 747.37);
    assert.equal(r.salesBefore, 5344.61);
    assert.equal(r.salesAfter, 4597.24);
    const adjustments = await M.PerformanceProfitAdjustment.findAll({ where: { order_id: order.order_id }, transaction, lock: transaction.LOCK.UPDATE });
    assert(!adjustments.some(x => !['approved', 'rejected', 'cancelled', 'canceled', 'voided'].includes(x.status)), '存在待处理调整');
    backup = { order: plain(order), snapshot: plain(selected.snapshot), result: r,
      settlement: selected.settlement ? plain(selected.settlement) : null, items: selected.items.map(plain),
      orderItems: r.before.orderItems, adjustments: adjustments.map(plain) };
    console.log(JSON.stringify({ preview: true, order: no, vatBefore: r.vatBefore, vatAfter: r.vatAfter, profitBefore: r.salesBefore, profitAfter: r.salesAfter, month: r.targetMonth }));
    if (!process.argv.includes('--apply')) return;
    const dir = path.resolve(__dirname, '../backup/order-corrections', batch);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'before.json'), JSON.stringify(backup, null, 2), { flag: 'wx' });
    await selected.order.update(r.after.order, { transaction });
    await selected.snapshot.update({ ...r.after.snapshot, calculated_by: batch, calculated_at: new Date(), update_time: new Date() }, { transaction });
    await recordBusinessAction({ businessType: 'invoice_amount_correction', businessId: order.order_id,
      businessNo: no, action: 'correct_invoice_amount', user: ctx.state.user,
      comment: '用户明确授权：全额补开专票19999元，差额归属2026年10月；仅含税笔记本14250元抵减税基，未税赠品不抵减。直接数据纠错，不冒充审批。',
      detail: { batch, ...r }, transaction });
  });
  if (!process.argv.includes('--apply')) return;
  const order = plain(await M.Order.findByPk(backup.order.order_id, { raw: true }));
  const snapshot = plain(await M.OrderGrossProfit.findByPk(backup.snapshot.gross_profit_id, { raw: true }));
  for (const key of Object.keys(backup.order)) if (!['invoice_status', 'invoice_amount', 'update_time'].includes(key)) assert.deepEqual(order[key], backup.order[key], key);
  assert.equal(order.invoice_status, input.invoiceStatus);
  assert.equal(Number(order.invoice_amount), 19999);
  for (const [key, value] of Object.entries(backup.result.after.snapshot)) assert.equal(Number(snapshot[key]), Number(value), key);
  for (const key of Object.keys(backup.snapshot)) if (!(key in backup.result.after.snapshot) && !['calculated_by', 'calculated_at', 'update_time'].includes(key)) assert.deepEqual(snapshot[key], backup.snapshot[key], key);
  const sorted = xs => xs.sort((a,b) => String(a.item_id || a.settlement_item_id).localeCompare(String(b.item_id || b.settlement_item_id)));
  assert.deepEqual(sorted(plain(await M.OrderItem.findAll({ where: { order_id: order.order_id }, raw: true }))), sorted(backup.orderItems));
  if (backup.settlement) {
    assert.deepEqual(plain(await M.ProductSettlementOrder.findByPk(backup.settlement.settlement_id, { raw: true })), backup.settlement);
    assert.deepEqual(sorted(plain(await M.ProductSettlementItem.findAll({ where: { settlement_id: backup.settlement.settlement_id }, raw: true }))), sorted(backup.items));
  }
  assert.deepEqual(plain(await M.PerformanceProfitAdjustment.findAll({ where: { order_id: order.order_id }, raw: true })), backup.adjustments);
  const result = { verified: true, order: no, invoiceStatus: order.invoice_status, invoiceAmount: Number(order.invoice_amount), vat: Number(snapshot.vat_amount), grossProfit: Number(snapshot.gross_profit_amount), month: '2026-10' };
  fs.writeFileSync(path.resolve(__dirname, '../backup/order-corrections', batch, 'verified.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => M.sequelize.close());
