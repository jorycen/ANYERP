const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const D = require('../src/modules/finance/settlementDraft');
const controller = require('../src/modules/finance/payableController');
const context = body => ({ params: { id: 'S' }, request: { body }, state: { user: { staffId: 1, name: '财务', roles: ['boss'] } },
  throw(status, message) { throw Object.assign(new Error(message), { status }); } });
function state(overrides = {}) {
  return { settlement: { rebate_deduction: 0 },
    items: [{ item_id: 1, payable_id: 'P', amount: 100 }, { item_id: 2, payable_id: 'P', amount: 20 }],
    payables: [{ payable_id: 'P', total_amount: 150, offset_amount: 10 }],
    summary: new Map([['P', { amount: 30, amountByItem: new Map() }]]), requestItems: new Map(), deltas: new Map(), ...overrides };
}
test('draft edits validate aggregate source balance, item ownership and credit signs', () => {
  assert.equal(D.validateItems(context(), state(), [{ itemId: 1, amount: 110 }])[0].amount, 110);
  assert.throws(() => D.validateItems(context(), state(), [{ itemId: 1, amount: 100 }, { itemId: 2, amount: 20 }]), /剩余可结算/);
  assert.throws(() => D.validateItems(context(), state(), [{ itemId: 999, amount: 10 }]), /不属于/);
  assert.throws(() => D.validateItems(context(), state(), [{ itemId: 1, amount: 10 }, { itemId: 1, amount: 10 }]), /重复/);
  assert.throws(() => D.validateItems(context(), state(), [{ itemId: 1, amount: -10 }]), /剩余可结算/);
  const negative = state({ payables: [{ payable_id: 'P', total_amount: -150 }], summary: new Map([['P', { amount: -30, amountByItem: new Map() }]]) });
  assert.equal(D.validateItems(context(), negative, [{ itemId: 1, amount: -120 }])[0].amount, -120);
  assert.throws(() => D.validateItems(context(), negative, [{ itemId: 1, amount: -121 }]), /剩余可结算/);
});
test('line balance and existing rebate allocations cannot be bypassed while editing', () => {
  const s = state(); s.items[0].request_item_id = 7;
  s.requestItems.set('7', { quantity: 2, unit_price: 50 }); s.deltas.set('7', -1);
  assert.throws(() => D.validateItems(context(), s, [{ itemId: 1, amount: 51 }]), /商品/);
  s.settlement.rebate_allocation_json = '[{"payableId":"P","amount":10}]';
  s.items.push({ item_id: 3, payable_id: 'OTHER', amount: 1 }); s.payables.push({ payable_id: 'OTHER', total_amount: 100 });
  assert.throws(() => D.validateItems(context(), s, [{ itemId: 3, amount: 10 }]), /已分配返利/);
});
function fixture(t) {
  const tx = { LOCK: { UPDATE: 'UPDATE' } }, logs = [], writes = [];
  const row = values => ({ ...values, toJSON() { return { ...this }; }, async update(patch) { writes.push(patch); Object.assign(this, patch); }, async destroy() { this.removed = true; } });
  const settlement = row({ settlement_id: 'S', settlement_no: 'SET1', supplier_id: 'SUP', distributor_id: 'D', status: 'draft', total_amount: 120,
    paid_amount: 0, submit_time: '2026-10-19', approval_comment: '请核对金额', rebate_deduction: 0 });
  const items = [row({ item_id: 1, settlement_id: 'S', payable_id: 'P', amount: 100, quantity: 2 }), row({ item_id: 2, settlement_id: 'S', payable_id: 'P', amount: 20 })];
  const payable = row({ payable_id: 'P', supplier_id: 'SUP', distributor_id: 'D', total_amount: 200, offset_amount: 0, status: 'partial_settled' });
  t.mock.method(M.sequelize, 'query', async () => { throw new Error('Tests must not access live database'); });
  t.mock.method(M.sequelize, 'transaction', async fn => fn(tx));
  t.mock.method(M.Settlement, 'findOne', async () => settlement);
  t.mock.method(M.Settlement, 'findAll', async () => [settlement]);
  t.mock.method(M.SettlementItem, 'findAll', async ({ where }) => {
    if (where.settlement_id && typeof where.settlement_id !== 'string') return []; // exclude own draft reservation
    return items.filter(row => !row.removed);
  });
  t.mock.method(M.Payable, 'findAll', async () => [payable]);
  t.mock.method(M.Payable, 'findByPk', async () => payable);
  t.mock.method(M.SettlementPaymentRecord, 'findOne', async () => null);
  t.mock.method(M.SettlementPaymentRecord, 'findAll', async () => []);
  t.mock.method(M.ApprovalFlowInstance, 'findOne', async () => null);
  t.mock.method(controller, 'getPurchaseAdjustmentQuantityDeltasForDraft', async () => new Map());
  t.mock.method(M.Expense, 'findAll', async () => []);
  t.mock.method(M.SupplierPaymentAccount, 'findOne', async () => ({ account_id: 'A', company_name: '供应商', bank_name: '银行', account_number: '12345678' }));
  t.mock.method(M.BusinessActionLog, 'create', async (values, options) => { assert.equal(options.transaction, tx); logs.push(values); });
  return { settlement, payable, items, logs, writes };
}
test('previously submitted/rejected draft can edit amounts and account, retaining its identity and rejection history', async t => {
  const f = fixture(t);
  await D.updateDraft(context({ items: [{ itemId: 1, amount: 80 }], supplierAccountId: 'A', remark: '已核对' }));
  assert.equal(f.settlement.settlement_id, 'S'); assert.equal(f.settlement.status, 'draft');
  assert.equal(f.settlement.total_amount, 80); assert.equal(f.items[0].quantity, null); assert.equal(f.items[1].removed, true);
  assert.equal(f.settlement.approval_comment, '请核对金额'); assert.equal(f.settlement.submit_time, '2026-10-19');
  assert.equal(JSON.parse(f.settlement.supplier_account_snapshot).accountId, 'A');
  assert.equal(f.payable.settled_amount, 80); assert.equal(f.logs[0].action, 'draft_updated');
  await D.validateForSubmit(context(), f.settlement, { LOCK: { UPDATE: 'UPDATE' } });
});
test('non-draft, paid and cross-distributor edits are rejected before any write', async t => {
  const f = fixture(t), ctx = context({ items: [{ itemId: 1, amount: 80 }] });
  f.settlement.status = 'pending_approval';
  await assert.rejects(D.updateDraft(ctx), error => error.status === 409);
  f.settlement.status = 'draft'; f.settlement.paid_amount = 1;
  await assert.rejects(D.updateDraft(ctx), /付款记录/);
  f.settlement.paid_amount = 0; ctx.state.user = { staffId: 2, roles: ['finance'], distributorId: 'OTHER' };
  await assert.rejects(D.updateDraft(ctx), error => error.status === 403);
  assert.equal(f.writes.length, 0);
});
test('resubmission refuses a draft whose source availability has changed', async t => {
  const f = fixture(t); f.payable.total_amount = 50;
  await assert.rejects(D.validateForSubmit(context(), f.settlement, { LOCK: { UPDATE: 'UPDATE' } }), /剩余可结算/);
  assert.equal(f.writes.length, 0);
});
