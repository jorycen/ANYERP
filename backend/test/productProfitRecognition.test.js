const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const { syncPolicyIncome } = require('../src/modules/report/productPolicyIncome');
const cost = require('../src/modules/report/productCostSupplement');
const tx = { LOCK: { UPDATE: 'UPDATE' } };
function ctx(body = {}) { return { state: { user: { roles: ['finance'], accessibleStoreIds: ['S'], accessibleDistributorIds: ['D'] } }, params: { settlementId: 'PS' }, request: { body }, throw(status, message) { throw Object.assign(new Error(message), { status }); } }; }
function row(values) { return { ...values, toJSON() { return Object.fromEntries(Object.entries(this).filter(([,value]) => typeof value !== 'function')); }, async update(patch) { Object.assign(this, patch); } }; }

test('full reconciliation recognizes once; partial does not; reversal and re-reconciliation conserve income', async t => {
  const entries = [];
  t.mock.method(M.ProductProfitIncome, 'findAll', async () => entries);
  t.mock.method(M.ProductProfitIncome, 'create', async value => { entries.push(value); return value; });
  t.mock.method(M.RebateEstimate, 'findByPk', async () => ({ sales_order_id: 'O' }));
  t.mock.method(M.Order, 'findByPk', async () => ({ order_id: 'O', store_id: 'S' }));
  const record = { settlement_id: 'R', source_type: 'MANUFACTURER_REBATE', amount: 100, matched_amount: 50, status: 'PARTIALLY_SETTLED' };
  await syncPolicyIncome(record, tx); assert.equal(entries.length, 0);
  Object.assign(record, { status: 'SETTLED', matched_amount: 100 });
  await syncPolicyIncome(record, tx); await syncPolicyIncome(record, tx);
  assert.equal(entries.length, 1); assert.equal(entries[0].amount, 100);
  await syncPolicyIncome(record, tx, {}, true); await syncPolicyIncome(record, tx, {}, true);
  assert.equal(entries.length, 2); assert.equal(entries.reduce((n,e) => n + e.amount, 0), 0);
  await syncPolicyIncome(record, tx); assert.equal(entries.reduce((n,e) => n + e.amount, 0), 100);
});

test('education recognizes frozen 20% only and carries item attribution into reversals', async t => {
  const entries = [];
  t.mock.method(M.ProductProfitIncome, 'findAll', async () => entries);
  t.mock.method(M.ProductProfitIncome, 'create', async value => { entries.push(value); return value; });
  t.mock.method(M.ResourceRightChangeOrder, 'findByPk', async () => ({ approval_status: 'completed', related_sale_order_id: 'O', reward_snapshot_json: { accountingVersion: 2, amount: 100, productAmount: 20, orderItemId: 9 } }));
  t.mock.method(M.Order, 'findByPk', async () => ({ order_id: 'O', store_id: 'S' }));
  t.mock.method(M.ResourceRightChangeOrder, 'findOne', async () => null);
  const record = { settlement_id: 'EDU', source_type: 'EDU_PRODUCT_REBATE', resource_type: 'EDU_SUBSIDY', amount: 100, matched_amount: 100, status: 'SETTLED' };
  record.matched_amount = 20; record.status = 'PARTIALLY_SETTLED';
  await syncPolicyIncome(record, tx); assert.equal(entries.length, 0);
  record.matched_amount = 100; record.status = 'SETTLED';
  await syncPolicyIncome(record, tx); await syncPolicyIncome(record, tx, {}, true);
  assert.deepEqual(entries.map(e => e.amount), [20, -20]);
  assert.deepEqual(entries.map(e => e.detail_json.orderItemId), [9, 9]);
});

test('manual purchase cost validates amounts, explicit zero, and frozen zero pricing', () => {
  for (const value of [-1, null, undefined, true, '', '1.001', '1e3']) assert.throws(() => cost.validateInput({ items: [{ itemId: 1, unitCost: value }] }));
  assert.throws(() => cost.validateInput({ items: [{ itemId: 1, unitCost: 0 }] }), /零元/);
  assert.equal(cost.validateInput({ items: [{ itemId: 1, unitCost: 0, confirmZero: true }] })[0].unitCost, 0);
  const missing = { quantity: 2, product_unit_price: 0 };
  assert.equal(cost.updatedItem(missing, { unitCost: 10 }).cost_status, 'pending');
  const zeroPrice = cost.updatedItem(missing, { unitCost: 10 }, { unitPricing: 0, source: 'frozen' });
  assert.equal(zeroPrice.cost_status, 'ready'); assert.equal(zeroPrice.gross_profit_amount, -20);
});

test('cost tool scopes access, refuses stale preview, updates sale and return with audit trail', async t => {
  const settlement = row({ settlement_id: 'PS', source_order_id: 'O', store_id: 'S', gross_profit_amount: 0, status: 'cost_pending' });
  const sale = row({ settlement_item_id: 1, settlement_id: 'PS', source_order_item_id: 9, quantity: 2, product_unit_price: 100, purchase_unit_cost: 0, purchase_cost_amount: 0, cost_status: 'pending' });
  const adjustment = row({ adjustment_id: 'R', source_order_id: 'O', status: 'cost_pending' });
  const returned = row({ adjustment_item_id: 2, adjustment_id: 'R', source_order_item_id: 9, quantity: -1, cost_status: 'pending' });
  const logs = [];
  t.mock.method(M.ProductSettlementOrder, 'findByPk', async () => settlement);
  t.mock.method(M.Store, 'findByPk', async () => ({ distributor_id: 'D' }));
  t.mock.method(M.Order, 'findByPk', async () => ({ order_status: 'archived' }));
  t.mock.method(M.ProductSettlementItem, 'findAll', async options => options.raw ? [sale.toJSON()] : [sale]);
  t.mock.method(M.OrderGrossProfit, 'findOne', async () => null);
  t.mock.method(M.ProductSettlementAdjustment, 'findAll', async () => [adjustment]);
  t.mock.method(M.ProductSettlementAdjustmentItem, 'findAll', async () => [returned]);
  t.mock.method(M.sequelize, 'transaction', async fn => fn(tx));
  t.mock.method(M.BusinessActionLog, 'create', async (value, options) => { assert.equal(options.transaction, tx); logs.push(value); });
  const request = ctx({ items: [{ itemId: 1, unitCost: 70 }], reason: '采购凭据1' });
  request.state.user.accessibleStoreIds = ['OTHER']; await assert.rejects(cost.preview(request), /无权/);
  request.state.user.accessibleStoreIds = ['S']; await cost.preview(request);
  const hash = request.body.data.previewHash;
  request.request.body.previewHash = 'stale'; await assert.rejects(cost.apply(request), /重新预览/);
  assert.equal(sale.purchase_unit_cost, 0); assert.equal(logs.length, 0);
  request.request.body.previewHash = hash; await cost.apply(request);
  assert.equal(settlement.gross_profit_amount, 60); assert.equal(settlement.status, 'posted');
  assert.equal(returned.purchase_cost_amount, -70); assert.equal(adjustment.gross_profit_amount, -30);
  assert.equal(logs.length, 1); assert.equal(JSON.parse(logs[0].detail_json).items[0].before.purchase_unit_cost, 0);
  await assert.rejects(cost.apply(request), /已有采购成本/);
});

test('withdrawn excluded by recognized whitelist and product expense never charged to store', async t => {
  t.mock.method(M.sequelize, 'query', async sql => {
    if (!sql.includes('FROM T_EXPENSE')) return [{ storeId: 'S', distributorId: 'D' }];
    assert.match(sql, /STATUS IN \('pending_payment', 'pending', 'processing', 'approved', 'paid'\)/);
    return [ { expenseId: 'P', amount: 795, attributionType: 'PRODUCT_SIDE', sourceStoreId: 'S' },
      { expenseId: 'S', amount: 10, attributionType: 'STORE', sourceStoreId: 'S', attributionDetails: [{ target_id: 'S', amount: 10 }] },
      { expenseId: 'PERSONAL', amount: 20, attributionType: 'PERSONAL', sourceStoreId: 'S' } ];
  });
  const result = await require('../src/modules/finance/expenseCostAllocation').summarizeAllocatedExpenses({ storeIds: ['S'] });
  assert.equal(result.amount, 10); assert.equal(result.productAmount, 795);
});

test('cash red packet claim APIs reject before financial side effects', async () => {
  const rights = require('../src/modules/inventory/resourceRights');
  await assert.rejects(rights.createSalesCashRebateClaim(ctx()), /仅供展示/);
  await assert.rejects(rights.reviewSalesCashRebateClaim(ctx()), /仅供展示/);
});
