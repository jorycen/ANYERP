const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const { Op } = require('sequelize');
const C = require('../src/modules/finance/payableController');
const ctx = body => ({ request: { body }, state: { user: { roles: ['boss'], name: 'tester' } },
  throw(status, message) { throw Object.assign(new Error(message), { status }); } });
const body = { settlementId: 'S', accountId: 'A', amount: 40, evidence: 'bank-proof-1', requestId: 'request_1234567890' };
function fixture(t, { auditFailure = false } = {}) {
  const state = { paid: 0, status: 'pending_refund', income: 100, transactions: [], records: [], batches: [] };
  const tx = { LOCK: { UPDATE: 'UPDATE' } };
  t.mock.method(M.sequelize, 'transaction', async fn => {
    const before = JSON.parse(JSON.stringify(state));
    try { return await fn(tx); } catch (error) { Object.assign(state, before); throw error; }
  });
  t.mock.method(M.SettlementAccount, 'findOne', async () => ({ account_id: 'A', account_type: 'FUND', status: 1, distributor_id: 'D' }));
  t.mock.method(M.Settlement, 'findByPk', async () => ({ settlement_id: 'S', settlement_no: 'S1', total_amount: -115,
    paid_amount: state.paid, payment_status: state.status, distributor_id: 'D', status: 'confirmed',
    async update(values, options) { assert.equal(options.transaction, tx); state.paid = values.paid_amount; state.status = values.payment_status; } }));
  t.mock.method(M.SettlementPaymentRecord, 'findOne', async options => state.records.find(row => row.import_key === options.where.import_key));
  t.mock.method(M.SettlementAccountTransaction, 'sum', async (field, options) => options.where.type === 'income' ? state.income : 0);
  t.mock.method(M.SettlementAccountTransaction, 'create', async (values, options) => {
    assert.equal(options.transaction, tx); assert.equal(values.type, 'income');
    assert.equal(values.balance_after, state.income + values.amount);
    state.income += values.amount; state.transactions.push(values); return values;
  });
  t.mock.method(M.SettlementPaymentRecord, 'create', async (values, options) => { assert.equal(options.transaction, tx); state.records.push(values); return values; });
  t.mock.method(M.SettlementPaymentBatch, 'create', async (values, options) => { assert.equal(options.transaction, tx); state.batches.push(values); return values; });
  t.mock.method(M.BusinessActionLog, 'create', async (values, options) => {
    assert.equal(options.transaction, tx); if (auditFailure) throw new Error('audit failed'); return values;
  });
  return state;
}
test('refund supports partial receipt, idempotent retry, full closure and signed history', async t => {
  const state = fixture(t);
  await C.confirmSupplierRefund(ctx(body));
  assert.equal(state.paid, -40); assert.equal(state.status, 'pending_refund'); assert.equal(state.income, 140);
  assert.equal(state.records[0].amount, -40); assert.equal(state.batches[0].total_amount, -40);
  await C.confirmSupplierRefund(ctx(body));
  assert.equal(state.transactions.length, 1);
  await assert.rejects(C.confirmSupplierRefund(ctx({ ...body, amount: 41 })), /内容已变化/);
  await assert.rejects(C.confirmSupplierRefund(ctx({ ...body, amount: 76, requestId: 'request_2345678901' })), /超过剩余/);
  await C.confirmSupplierRefund(ctx({ ...body, amount: 75, requestId: 'request_2345678901' }));
  assert.equal(state.paid, -115); assert.equal(state.status, 'refunded'); assert.equal(state.income, 215);
  await C.confirmSupplierRefund(ctx(body)); // retries still work after full receipt
  assert.equal(state.transactions.length, 2);
  await assert.rejects(C.confirmSupplierRefund(ctx({ ...body, requestId: 'request_3456789012' })), /不在待供应商退款/);
});
test('audit failure rolls back account, payment records and settlement together', async t => {
  const state = fixture(t, { auditFailure: true });
  await assert.rejects(C.confirmSupplierRefund(ctx(body)), /audit failed/);
  assert.equal(state.income, 100); assert.equal(state.paid, 0);
  assert.equal(state.records.length, 0); assert.equal(state.transactions.length, 0); assert.equal(state.batches.length, 0);
});
test('refund rejects cross-distributor account, missing evidence and invalid precision', async t => {
  const state = fixture(t);
  t.mock.method(M.SettlementAccount, 'findOne', async () => ({ account_id: 'A', account_type: 'FUND', distributor_id: 'OTHER' }));
  await assert.rejects(C.confirmSupplierRefund(ctx(body)), /经销商不一致/);
  await assert.rejects(C.confirmSupplierRefund(ctx({ ...body, evidence: '' })), /凭证/);
  await assert.rejects(C.confirmSupplierRefund(ctx({ ...body, amount: 0.001 })), /两位小数/);
  assert.equal(state.transactions.length, 0);
});
test('old settlement refund endpoint cannot move money', async t => {
  t.mock.method(M.sequelize, 'transaction', async () => assert.fail('must not start posting'));
  await assert.rejects(C.registerSupplierRefund(ctx(body)), error => error.status === 410);
});
test('a refund cannot be posted as an ordinary outgoing payment', async t => {
  const state = fixture(t);
  t.mock.method(M.SettlementPaymentRecord, 'sum', async () => 0);
  await assert.rejects(C.createDirectPayment(ctx({ settlementId: 'S', accountId: 'A', amount: 10 })), /超过剩余未付款金额/);
  assert.equal(state.transactions.length, 0);
});
test('candidate query includes outstanding refunds and preserves distributor filter', async t => {
  let captured;
  t.mock.method(M.Settlement, 'findAndCountAll', async options => { captured = options; return { count: 0, rows: [] }; });
  await C.getPaymentCandidates({ query: {}, state: { user: { roles: ['finance'], accessibleDistributorIds: ['D'] } } });
  const clauses = captured.where[Op.or];
  assert.equal(clauses[1].payment_status, 'pending_refund');
  assert.equal(clauses[1].total_amount[Op.lt], 0);
  assert.ok(captured.where.distributor_id || captured.where[Op.and]);
});
