const test = require('node:test'), assert = require('node:assert/strict');
const M = require('../src/models');
const C = require('../src/modules/finance/invoiceController');
const { invoiceAmounts, invoiceNumbers } = require('../src/modules/finance/invoiceAmounts');
const context = body => ({ request: { body }, state: { user: { roles: ['boss'], staffId: 1, name: 'finance' } },
  throw(status, message) { throw Object.assign(new Error(message), { status }); } });
const body = { invoiceNumbers: ['NO-1', 'NO-2'], invoiceDate: '2026-10-29', invoiceType: 'VAT', taxRate: 0.13,
  totalAmount: 113, amountWithoutTax: 999, taxAmount: 999,
  allocations: [{ paymentId: 'B', amount: 63 }, { paymentId: 'A', amount: 50 }] };
function fixture(t, failAudit = false) {
  const state = { headers: [], numbers: [], allocations: [], locks: [] };
  const tx = { LOCK: { UPDATE: 'UPDATE' } };
  t.mock.method(M.sequelize, 'transaction', async fn => {
    const before = structuredClone(state);
    try { return await fn(tx); } catch (error) { Object.assign(state, before); throw error; }
  });
  t.mock.method(M.SettlementPaymentRecord, 'findOne', async options => {
    state.locks.push(options.where.payment_id);
    return { payment_id: options.where.payment_id, settlement_id: `S${options.where.payment_id}`, distributor_id: 'D',
      supplier_name: 'supplier', amount: 200, Settlement: { supplier_id: 'SUP' } };
  });
  t.mock.method(M.Supplier, 'findByPk', async () => ({ tax_no: null }));
  t.mock.method(M.PurchaseInvoiceAllocation, 'sum', async () => 0);
  t.mock.method(M.PurchaseInvoiceAllocation, 'create', async (values, options) => { assert.equal(options.transaction, tx); state.allocations.push(values); });
  t.mock.method(M.PurchaseInvoice, 'findAll', async () => state.headers);
  t.mock.method(M.PurchaseInvoice, 'findOne', async () => null);
  t.mock.method(M.PurchaseInvoice, 'create', async values => { state.headers.push(values); return values; });
  t.mock.method(M.PurchaseInvoiceNumber, 'findAll', async () => state.numbers);
  t.mock.method(M.PurchaseInvoiceNumber, 'destroy', async () => 0);
  t.mock.method(M.PurchaseInvoiceNumber, 'bulkCreate', async values => state.numbers.push(...values));
  t.mock.method(M.BusinessActionLog, 'create', async () => { if (failAudit) throw new Error('audit failed'); });
  return state;
}
test('group records two numbers and one total, ignores client tax and keeps correct payment links', async t => {
  const state = fixture(t);
  await C.createInvoice(context(body));
  assert.equal(state.headers.length, 1); assert.equal(state.numbers.length, 2);
  assert.equal(state.headers[0].total_amount, 113);
  assert.equal(state.headers[0].amount_without_tax, 100);
  assert.equal(state.headers[0].tax_amount, 13);
  assert.equal(state.headers[0].supplier_tax_no, null);
  assert.deepEqual(state.locks, ['A', 'B']);
  assert.equal(state.allocations.find(row => row.payment_id === 'B').settlement_id, 'SB');
  assert.equal(state.allocations.reduce((sum, row) => sum + row.amount, 0), 113);
  await assert.rejects(C.createInvoice(context({ ...body, invoiceNumbers: ['NO-2', 'NO-3'] })), /已登记/);
  assert.equal(state.headers.length, 1);
});
test('group amount mismatch, duplicate numbers and audit failure cannot leave partial registrations', async t => {
  const state = fixture(t, true);
  await assert.rejects(C.createInvoice(context({ ...body, totalAmount: 112 })), /付款分摊金额一致/);
  await assert.rejects(C.createInvoice(context({ ...body, invoiceNumbers: ['NO-1', 'no-1'] })), /重复/);
  await assert.rejects(C.createInvoice(context(body)), /audit failed/);
  assert.equal(state.headers.length, 0); assert.equal(state.numbers.length, 0); assert.equal(state.allocations.length, 0);
});
test('preview defaults from selected allocations and rounds tax with exact cent conservation', async () => {
  const ctx = context({ allocations: body.allocations, taxRate: 0.13 });
  await C.previewInvoice(ctx);
  assert.deepEqual(ctx.body.data, { totalAmount: 113, amountWithoutTax: 100, taxAmount: 13, taxRate: 0.13 });
  for (const total of [0, 0.01, 1, 99.99, 1234.56]) for (const rate of [0, 0.01, 0.06, 0.13]) {
    const r = invoiceAmounts(total, rate);
    assert.equal(Math.round(r.amountWithoutTax * 100) + Math.round(r.taxAmount * 100), Math.round(total * 100));
  }
  assert.throws(() => invoiceAmounts('', 0.13));
  assert.throws(() => invoiceAmounts(113, -1));
  assert.throws(() => invoiceNumbers(['', 'NO']));
});
