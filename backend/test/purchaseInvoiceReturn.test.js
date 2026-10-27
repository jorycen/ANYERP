const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const C = require('../src/modules/finance/invoiceController');
function fixture(t) {
  const tx = { LOCK: { UPDATE: 'UPDATE' } }, logs = [], allocations = [
    { allocation_id: 'A1', payment_id: 'P1', amount: 100 }, { allocation_id: 'A2', payment_id: 'P2', amount: 200 }
  ].map(row => ({ ...row, toJSON() { return { ...this }; } }));
  const invoice = { invoice_id: 'I', invoice_no: 'NO', distributor_id: 'D', status: 'active', total_amount: 300,
    toJSON() { return { ...this }; }, async update(patch, options) { assert.equal(options.transaction, tx); Object.assign(this, patch); } };
  t.mock.method(M.sequelize, 'query', async () => { throw new Error('Tests must not access a database'); });
  t.mock.method(M.sequelize, 'transaction', async callback => {
    const status = invoice.status;
    try { return await callback(tx); } catch (error) { invoice.status = status; throw error; }
  });
  t.mock.method(M.PurchaseInvoice, 'findByPk', async (_, options) => { assert.equal(options.lock, tx.LOCK.UPDATE); return invoice; });
  t.mock.method(M.PurchaseInvoice, 'findOne', async () => invoice);
  t.mock.method(M.PurchaseInvoiceAllocation, 'findAll', async () => allocations);
  t.mock.method(M.BusinessActionLog, 'create', async values => { logs.push(values); });
  const ctx = { params: { invoiceId: 'I' }, request: { body: { reason: '登记错误' } },
    state: { user: { staffId: 7, name: '财务', accessibleDistributorIds: ['D'] } },
    throw(status, message) { throw Object.assign(new Error(message), { status }); } };
  return { tx, invoice, allocations, logs, ctx };
}
test('整张退回保留所有分摊和原金额，审计记录全部付款，重复退回拒绝', async t => {
  const f = fixture(t);
  await C.returnInvoice(f.ctx);
  assert.equal(f.invoice.status, 'returned'); assert.equal(f.invoice.total_amount, 300);
  assert.equal(f.allocations.length, 2);
  const detail = JSON.parse(f.logs[0].detail_json);
  assert.equal(detail.allocations.length, 2); assert.equal(f.logs[0].action, 'returned');
  await assert.rejects(C.returnInvoice(f.ctx), /已退回/);
});
test('跨经销商及无退回原因不允许执行', async t => {
  const f = fixture(t);
  f.ctx.state.user.accessibleDistributorIds = ['OTHER'];
  await assert.rejects(C.returnInvoice(f.ctx), /无权/);
  f.ctx.request.body.reason = '';
  await assert.rejects(C.returnInvoice(f.ctx), /退回原因/);
  assert.equal(f.invoice.status, 'active'); assert.equal(f.logs.length, 0);
});
test('审计失败整张回滚，不能出现已退回但未留痕', async t => {
  const f = fixture(t);
  t.mock.method(M.BusinessActionLog, 'create', async () => { throw new Error('审计失败'); });
  await assert.rejects(C.returnInvoice(f.ctx), /审计失败/);
  assert.equal(f.invoice.status, 'active');
});
test('登记余额只统计有效发票，不把退回记录算作已收票', async t => {
  const f = fixture(t);
  t.mock.method(M.PurchaseInvoiceAllocation, 'sum', async (_, options) => {
    assert.equal(options.include[0].where.status, 'active'); assert.equal(options.include[0].required, true);
    return 50;
  });
  assert.equal(await C._test.activeInvoiceAmount('P1', f.tx), 50);
});
test('同票号重新登记复用原记录，历史分摊快照留痕后替换，避免唯一键冲突', async t => {
  const f = fixture(t); f.invoice.status = 'returned';
  let destroyed = false;
  t.mock.method(M.PurchaseInvoiceAllocation, 'destroy', async options => { assert.equal(options.transaction, f.tx); destroyed = true; });
  const row = await C._test.saveInvoice(f.ctx, { invoice_id: 'NEW-ID', invoice_no: 'NO', invoice_code: '', supplier_tax_no: 'TAX', distributor_id: 'D', total_amount: 300 }, f.tx);
  assert.equal(row.invoice_id, 'I'); assert.equal(row.status, 'active'); assert.equal(destroyed, true);
  assert.equal(f.logs[0].action, 'reregistered'); assert.equal(JSON.parse(f.logs[0].detail_json).allocations.length, 2);
});
