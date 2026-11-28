const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const policy = require('../src/modules/inventory/rebatePolicyDetail');
const { purchaseBreakdown } = require('../src/modules/purchase/rebateCostBasis');
function ctx(body = {}) { return { state: { user: { roles: ['finance'], accessibleStoreIds: ['S'], accessibleDistributorIds: ['D'], name: '财务' } }, params: { settlementId: 'R' }, request: { body }, throw(status, message) { throw Object.assign(new Error(message), { status }); } }; }
function stubs(t) {
  const record = { settlement_id: 'R', settlement_no: 'RST1', distributor_id: 'D', counterparty_id: 'SUP', resource_type: 'EDU_SUBSIDY', source_type: 'EDU_PRODUCT_REBATE', source_id: 'TASK', amount: 1000, matched_amount: 500, status: 'PARTIALLY_SETTLED' };
  t.mock.method(M.ResourceSettlement, 'findByPk', async () => record);
  t.mock.method(M.ResourceRightChangeOrder, 'findByPk', async () => ({ related_sale_order_id: 'O', reward_snapshot_json: { accountingVersion: 2, amount: 1000, employeeAmount: 800, productAmount: 200, orderItemId: 9 } }));
  t.mock.method(M.Order, 'findByPk', async () => ({ order_id: 'O', order_no: 'ORD1', store_id: 'S' }));
  t.mock.method(M.Store, 'findByPk', async () => ({ store_id: 'S', distributor_id: 'D' }));
  return record;
}
test('policy allocation preserves full credit and splits education margin only; PO belongs entirely to product', () => {
  const split = policy.allocation({ resource_type: 'EDU_SUBSIDY', amount: 1000 }, { reward_snapshot_json: { accountingVersion: 2, amount: 1000, employeeAmount: 800, productAmount: 200 } });
  assert.equal(split.policyAmount, 1000); assert.equal(split.employeeAmount, 800); assert.equal(split.productAmount, 200);
  assert.equal(policy.allocation({ resource_type: 'EDU_SUBSIDY', amount: 1000 }).known, false);
  const po = policy.allocation({ source_type: 'MANUFACTURER_REBATE', amount: 300 });
  assert.equal(po.employeeAmount, 0); assert.equal(po.productAmount, 300);
});
test('credit payment does not reduce goods cost, including fully credit-funded and returned purchases', () => {
  assert.deepEqual(Object.values(purchaseBreakdown({ total_amount: 10000, rebate_deduction: 1000 })).slice(0,3), [10000, 1000, 9000]);
  const all = purchaseBreakdown({ total_amount: 10000, rebate_deduction: 10000 });
  assert.equal(all.goodsCostBasis, 10000); assert.equal(all.cashOrPayable, 0);
  const returned = purchaseBreakdown({ total_amount: 10000, rebate_deduction: 1000, current_total_amount: 5000, current_rebate_deduction: 500 });
  assert.equal(returned.goodsCostBasis, 5000); assert.equal(returned.cashOrPayable, 4500);
});
test('policy detail shows frozen evidence and pending share without recognizing partial credit', async t => {
  stubs(t);
  t.mock.method(M.ProductProfitIncome, 'findAll', async () => []);
  t.mock.method(M.RebateSettlementAllocation, 'findAll', async () => []);
  t.mock.method(M.BusinessActionLog, 'findAll', async () => []);
  t.mock.method(M.ProductSettlementOrder, 'findOne', async () => ({ settlement_id: 'PS' }));
  t.mock.method(M.ProductSettlementItem, 'findOne', async () => ({ cost_status: 'ready', gross_profit_amount: -50 }));
  t.mock.method(M.ProductProfitIncome, 'create', async () => { throw Error('Viewing must not recognize income'); });
  const request = ctx(); await policy.detail(request);
  assert.equal(request.body.data.allocation.policyAmount, 1000);
  assert.equal(request.body.data.expectedProductAmount, 200);
  assert.equal(request.body.data.recognizedProductAmount, 0);
  assert.equal(request.body.data.policyExpectedMargin, 150);
  assert.match(request.body.data.pricingEvidenceNote, /不以当前价格倒推/);
});
test('tax evidence requires explicit financial basis and never infers a fixed 20% tax', () => {
  const pending = policy.validateTax({ invoiceMode: 'no_invoice', status: 'pending', reason: '待核实', impactAmount: 200 });
  assert.equal(pending.impactAmount, null);
  assert.throws(() => policy.validateTax({ invoiceMode: 'no_invoice', status: 'confirmed', reason: '核实', impactAmount: -1, evidence: '凭证' }));
  assert.throws(() => policy.validateTax({ invoiceMode: 'no_invoice', status: 'confirmed', reason: '核实', impactAmount: 100 }), /依据/);
  assert.equal(policy.validateTax({ invoiceMode: 'red_invoice', status: 'confirmed', reason: '凭证核实', impactAmount: 0, evidence: '红票1' }).impactAmount, 0);
});
test('tax records enforce store scope, append revisions in a transaction, and never change financial amounts', async t => {
  stubs(t);
  const tx = { LOCK: { UPDATE: 'UPDATE' } }, logs = [];
  t.mock.method(M.sequelize, 'transaction', async fn => fn(tx));
  t.mock.method(M.BusinessActionLog, 'findAll', async () => logs);
  t.mock.method(M.BusinessActionLog, 'create', async (value, options) => { assert.equal(options.transaction, tx); logs.push(value); });
  t.mock.method(M.ResourceSettlement, 'update', async () => { throw Error('Must not change pool amount'); });
  t.mock.method(M.ProductProfitIncome, 'create', async () => { throw Error('Must not recognize profit'); });
  const request = ctx({ invoiceMode: 'no_invoice', status: 'pending', reason: '核实票据' });
  request.state.user.accessibleStoreIds = ['OTHER']; await assert.rejects(policy.saveTax(request), /无权/); assert.equal(logs.length, 0);
  request.state.user.accessibleStoreIds = ['S']; await policy.saveTax(request); await policy.saveTax(request);
  assert.deepEqual(logs.map(log => JSON.parse(log.detail_json).revision), [1, 2]);
  assert.equal(JSON.parse(logs[1].detail_json).before.invoiceMode, 'no_invoice');
  assert.deepEqual(policy.sortTaxHistory([{ detail: { revision: 2 } }, { detail: { revision: 1 } }]).map(row => row.detail.revision), [1, 2]);
});
test('credit usage is scoped and does not invent individual-policy purchase allocations', async t => {
  stubs(t);
  t.mock.method(M.SupplierRebate, 'findAll', async options => { assert.equal(options.limit, 200); return [{ balance: 900, related_no: 'PUR1' }]; });
  t.mock.method(M.PurchaseRequest, 'findAll', async options => { assert.ok(options.where.store_id); return [{ request_no: 'PUR1', rebate_deduction: 100 }]; });
  const request = ctx(); await policy.credit(request);
  assert.equal(request.body.data.availableBalance, null);
  assert.equal(request.body.data.purchases[0].rebate_deduction, 100);
  assert.match(request.body.data.note, /不虚构/);
});
