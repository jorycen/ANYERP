const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const { splitEducation, educationSnapshot, educationIncome, postEducation, reverseEducation } = require('../src/modules/inventory/educationReward');
const snapshot = { version: 1, accountingVersion: 2, resourceType: 'EDU_SUBSIDY', amount: 100.01, employeeAmount: 80.01, productAmount: 20, orderItemId: 7 };
test('80% and residual 20% always conserve full education income to the cent', () => {
  for (const amount of [0.01, 0.02, 1.01, 100.01, 9999.99]) {
    const split = splitEducation(amount);
    assert.equal(Math.round((split.employeeAmount + split.productAmount) * 100), Math.round(amount * 100));
  }
  assert.equal(educationSnapshot({ reward_snapshot_json: snapshot }).employeeAmount, 80.01);
  assert.throws(() => educationSnapshot({ reward_snapshot_json: { ...snapshot, productAmount: 20.01 } }), /快照异常/);
});
test('already-booked historical education cannot be credited a second time', async t => {
  t.mock.method(M.PerformanceProfitAdjustment, 'findOne', async () => ({ amount: 80.01 }));
  t.mock.method(M.PerformanceProfitAdjustment, 'create', async () => { throw new Error('Must not create duplicate income'); });
  await assert.rejects(postEducation({ task: { reward_snapshot_json: snapshot }, order: { order_id: 'ORDER' }, item: { item_id: 7 }, transaction: {} }), /已计入过毛利/);
});
test('education amount is frozen from PN/category config, not the order discount or current cost', async t => {
  t.mock.method(M.Product, 'findByPk', async () => ({ category_id: 'laptop' }));
  t.mock.method(M.ProductCategory, 'findAll', async () => [{ category_id: 'laptop', name: '笔记本', status: 1 }]);
  const frozen = await require('../src/modules/inventory/rewardConfig').freezeSalesReportReward({
    category: { category_code: 'EDU_SUBSIDY', rule_config_json: JSON.stringify({ rewardRules: [{ id: 'pn', scope: 'PN', pnCode: 'PN1', amount: 100.01, enabled: true }] }) },
    item: { item_id: 7, product_id: 'P', pn_code: 'PN1', original_inventory_cost: 9999 }, order: { education_subsidy: 888, archive_time: '2026-10-20T00:00:00+08:00' }, transaction: {} });
  assert.equal(educationSnapshot({ reward_snapshot_json: frozen }).amount, 100.01);
});
test('archive consumes education eligibility without crediting employee profit or receivable', async t => {
  const tx = { LOCK: { UPDATE: 'UPDATE' } };
  const right = { current_status: 'LOCKED', locked_source_type: 'SALE_ORDER', locked_source_id: 'ORDER', async update(values) { Object.assign(this, values); } };
  t.mock.method(M.ResourceCategory, 'findOne', async () => ({ name: '教育补贴' }));
  t.mock.method(M.InventoryResourceRight, 'findOne', async () => right);
  t.mock.method(M.ResourceRightChangeOrder, 'create', async values => values);
  t.mock.method(M.PerformanceProfitAdjustment, 'create', async () => { throw new Error('Archive must not credit education'); });
  t.mock.method(M.ResourceSettlement, 'findOrCreate', async () => { throw new Error('Archive must not settle education'); });
  await require('../src/modules/inventory/resourceRights').finishSaleRights({ order_id: 'ORDER', education_subsidy: 888 }, [
    { item_id: 7, sn_id: 'SN', sn_code: 'SN1', product_id: 'P', use_edu_subsidy: 1, selected_resource_types: '["EDU_SUBSIDY"]' }
  ], tx);
  assert.equal(right.current_status, 'USED');
});
test('company full income and employee/product shares share one ledger and net to zero on return', async t => {
  t.mock.method(M.ResourceRightChangeOrder, 'findAll', async () => [
    { related_sale_order_id: 'ORDER', reward_snapshot_json: JSON.stringify(snapshot), change_reason: 'SALE_RESOURCE_TASK' },
    { related_sale_order_id: 'ORDER', reward_snapshot_json: JSON.stringify(snapshot), change_reason: 'EDU_REWARD_RETURN' },
    { related_sale_order_id: 'ORDER', reward_snapshot_json: null, change_reason: 'SALE_RESOURCE_TASK' }
  ]);
  t.mock.method(M.Order, 'findAll', async () => [{ order_id: 'ORDER', store_id: 'STORE' }]);
  const rows = await educationIncome({ orderIds: ['ORDER'] });
  assert.equal(rows.length, 2);
  for (const key of ['amount', 'employeeAmount', 'productAmount']) assert.equal(rows.reduce((sum, row) => sum + row[key], 0), 0);
});
test('return reverses confirmed education once, cancels unreceived settlement and pending tasks', async t => {
  const tx = { LOCK: { UPDATE: 'UPDATE' } }, entries = [], profits = [];
  const task = { change_id: 'T', resource_type: 'EDU_SUBSIDY', approval_status: 'completed', reward_snapshot_json: JSON.stringify(snapshot) };
  const pending = { resource_type: 'SALES_REPORT', approval_status: 'pending_manager_review', async update(patch) { Object.assign(this, patch); } };
  const settlement = { status: 'PENDING', matched_amount: 0, async update(patch) { Object.assign(this, patch); } };
  t.mock.method(M.ResourceRightChangeOrder, 'findAll', async () => [task, pending]);
  t.mock.method(M.ResourceRightChangeOrder, 'findOne', async () => entries[0] || null);
  t.mock.method(M.ResourceRightChangeOrder, 'create', async values => { entries.push(values); return values; });
  t.mock.method(M.PerformanceProfitAdjustment, 'create', async values => { profits.push(values); return values; });
  t.mock.method(M.ResourceSettlement, 'findAll', async () => [settlement]);
  const args = { request: { return_id: 'R', return_no: 'RET1' }, order: { order_id: 'ORDER' }, requestItems: [{ order_item_id: 7 }],
    orderItemMap: new Map([['7', { item_id: 7, sn_id: 'SN', sn_code: 'SN1', product_id: 'P' }]]), transaction: tx };
  await reverseEducation(args); await reverseEducation(args);
  assert.equal(entries.length, 1); assert.equal(entries[0].change_amount, -100.01);
  assert.equal(profits[0].signed_amount, -80.01); assert.equal(profits.length, 1);
  assert.equal(settlement.status, 'CANCELLED'); assert.equal(pending.approval_status, 'cancelled');
});
