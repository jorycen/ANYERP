
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const M = require('../src/models');
const GP = require('../src/modules/sales/grossProfit');
const { recordBusinessAction } = require('../src/utils/businessActionLog');
const plain = value => JSON.parse(JSON.stringify(value));
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const batch = 'ZERO-FREIGHT-20261107-ORD202610061045475506';
const directory = path.resolve(__dirname, '../backup/order-corrections', batch);

(async () => {
  let before;
  await M.sequelize.transaction(async transaction => {
    const lock = { transaction, lock: transaction.LOCK.UPDATE };
    const order = await M.Order.findOne({ where: { order_no: 'ORD202610061045475506' }, ...lock });
    assert(order && !order.is_deleted);
    assert(['已归档', 'completed', 'archived'].includes(order.order_status));
    const store = await M.Store.findByPk(order.store_id, lock);
    const closed = await M.sequelize.query("SELECT MONTH_KEY FROM T_FINANCIAL_PROFIT_PERIOD WHERE MONTH_KEY='2026-10' FOR UPDATE",
      { transaction, type: M.sequelize.QueryTypes.SELECT });
    assert.equal(closed.length, 0, 'Financial period closed');
    const period = await M.ExpenseAccountingPeriod.findOne({ where: { distributor_id: store.distributor_id, month_key: '2026-10' }, ...lock });
    assert(!period || period.status === 'open', 'Expense period closed');
    assert.equal(await M.SalesReturnRequest.count({ where: { order_id: order.order_id }, transaction }), 0);
    assert.equal(await M.PerformanceProfitAdjustment.count({ where: { order_id: order.order_id }, transaction }), 0);
    const snapshot = await M.OrderGrossProfit.findOne({ where: { order_id: order.order_id }, ...lock });
    assert.equal(snapshot.snapshot_status, 'final');
    assert.equal(Number(snapshot.product_pricing_amount), 0);
    assert.equal(Number(snapshot.freight_cost_amount), 11);
    assert.equal(Number(snapshot.gross_profit_amount), -1.03);
    const items = await M.OrderItem.findAll({ where: { order_id: order.order_id }, ...lock });
    const payments = await M.OrderPayment.findAll({ where: { order_id: order.order_id }, ...lock });
    const settlement = await M.ProductSettlementOrder.findAll({ where: { source_order_id: order.order_id }, ...lock });
    const supplements = parse(snapshot.supplement_details);
    const removed = supplements.filter(line => line.source === 'freight_cost');
    assert.equal(removed.length, 1);
    assert.equal(Number(removed[0].amount), 11);
    before = { batch, order: plain(order), snapshot: plain(snapshot), items: plain(items), payments: plain(payments), settlement: plain(settlement), removed };
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'before.json'), JSON.stringify(before, null, 2), { flag: 'wx' });
    const remaining = supplements.filter(line => line.source !== 'freight_cost');
    const values = GP.calculateGrossProfitValues({
      receivableAmount: snapshot.receivable_amount, invoiceAmount: snapshot.invoice_amount, invoiceStatus: order.invoice_status,
      productPricingDetails: parse(snapshot.product_pricing_details), paymentDetails: parse(snapshot.payment_fee_details),
      supplementDetails: remaining, freightCostDetails: []
    });
    assert.equal(values.grossProfitAmount, 9.97);
    assert.equal(values.freightCostAmount, 0);
    assert.equal(values.vatAmount, Number(snapshot.vat_amount));
    assert.equal(values.paymentFeeAmount, Number(snapshot.payment_fee_amount));
    await snapshot.update({ supplement_details: remaining, freight_cost_amount: 0, gross_profit_amount: values.grossProfitAmount,
      calculated_by: batch, calculated_at: new Date() }, { transaction });
    await recordBusinessAction({
      businessType: 'sales_order', businessId: order.order_id, businessNo: order.order_no,
      action: 'correct_historical_order_freight', user: { name: '用户明确确认（Codex会话）' }, comment: batch,
      detail: { authorization: '用户明确确认本单运费也不需要', removedFreight: removed,
        beforeFreight: 11, afterFreight: 0, beforeProfit: -1.03, afterProfit: 9.97, paymentFee: 0.03,
        scope: '仅本销售单冻结运费明细；原采购物流记录独立保留' }, transaction
    });
  });
  for (const [model, where, expected] of [
    ['Order', { order_id: before.order.order_id }, [before.order]],
    ['OrderItem', { order_id: before.order.order_id }, before.items],
    ['OrderPayment', { order_id: before.order.order_id }, before.payments],
    ['ProductSettlementOrder', { source_order_id: before.order.order_id }, before.settlement]
  ]) assert.deepEqual(plain(await M[model].findAll({ where, raw: true })), expected);
  const after = await M.OrderGrossProfit.findByPk(before.snapshot.gross_profit_id, { raw: true });
  const allowed = new Set(['supplement_details', 'freight_cost_amount', 'gross_profit_amount', 'calculated_by', 'calculated_at', 'update_time']);
  for (const key of Object.keys(before.snapshot)) if (!allowed.has(key)) assert.deepEqual(plain(after)[key], before.snapshot[key], key);
  assert.equal(Number(after.freight_cost_amount), 0);
  assert.equal(Number(after.gross_profit_amount), 9.97);
  const result = { batch, verified: true, cost: 0, freight: 0, paymentFee: 0.03, grossProfit: 9.97 };
  fs.writeFileSync(path.join(directory, 'verified.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => M.sequelize.close());
