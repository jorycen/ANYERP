const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const S = require('../src/modules/approval/service');
const R = require('../src/modules/approval/businessRuntime');
const C = require('../src/modules/approval/catalog');

function fixture(t, nodes) {
  const tx = { LOCK: { UPDATE: 'UPDATE' } };
  const state = { instances: [], tasks: [], logs: [], flow: { definition_id: 'flow-1', flow_code: 'purchase_request', business_type: 'purchase_request', name: '采购审批', version: 1, status: 'published', config_json: JSON.stringify({ nodes }) } };
  const row = data => Object.assign(data, { toJSON() { return { ...this }; }, async update(patch, options) { assert.ok(options.transaction === tx || options.transaction == null); Object.assign(this, patch); return this; } });
  const employees = [1, 2, 3, 4].map(id => row({ staff_id: id, name: `员工${id}`, status: 1, is_deleted: 0, store_id: 'HOME', distributor_id: 'D1', Roles: [] }));
  t.mock.method(M.sequelize, 'query', async () => { throw new Error('Tests must not access a database'); });
  t.mock.method(M.Staff, 'findByPk', async id => employees.find(e => e.staff_id === Number(id)));
  t.mock.method(M.Staff, 'findAll', async () => employees);
  t.mock.method(M.Store, 'findByPk', async () => ({ distributor_id: 'D1' }));
  t.mock.method(M.ApprovalFlowDefinition, 'findOne', async () => state.flow?.status === 'published' ? state.flow : null);
  t.mock.method(M.ApprovalFlowInstance, 'findOne', async () => state.instances.at(-1) || null);
  t.mock.method(M.ApprovalFlowInstance, 'findByPk', async id => state.instances.find(i => i.instance_id === id));
  t.mock.method(M.ApprovalFlowInstance, 'create', async (values, options) => { assert.ok(options.transaction === tx || options.transaction == null); const instance = row(values); state.instances.push(instance); return instance; });
  const matches = (task, where) => Object.entries(where).every(([key, value]) => task[key] === value);
  t.mock.method(M.ApprovalTask, 'bulkCreate', async (values, options) => { assert.ok(options.transaction === tx || options.transaction == null); state.tasks.push(...values.map(row)); });
  t.mock.method(M.ApprovalTask, 'findOne', async ({ where }) => state.tasks.find(task => matches(task, where)) || null);
  t.mock.method(M.ApprovalTask, 'count', async ({ where }) => state.tasks.filter(task => matches(task, where)).length);
  t.mock.method(M.ApprovalTask, 'update', async (patch, { where, transaction }) => {
    assert.equal(transaction, tx);
    for (const task of state.tasks) if (task.instance_id === where.instance_id && (typeof where.status === 'object' ? ['pending', 'waiting'].includes(task.status) : task.status === where.status)) Object.assign(task, patch);
  });
  t.mock.method(M.ApprovalActionLog, 'create', async (values, options) => { assert.ok(options.transaction === tx || options.transaction == null); state.logs.push(values); });
  const business = row({ request_id: 'PR1', request_no: '采购1', status: 'pending', applicant_staff_id: 1, store_id: 'STORE', distributor_id: 'D1' });
  const ctx = id => ({ state: { user: { staffId: id, name: `员工${id}`, roles: ['clerk'], accessibleStoreIds: ['STORE'], distributorId: 'D1' } }, request: { body: {} }, throw(status, message) { throw Object.assign(new Error(message), { status }); } });
  return { state, tx, business, ctx };
}
const node = (mode, ids, name = '审批节点') => ({ name, signMode: mode, approvers: ids.map(staffId => ({ type: 'fixed_user', staffId })) });

test('教育补贴依次经过三级，前两级不记账，末级员工80%确认且返利全额待核销，重复处理被拒绝', async t => {
  const { state, tx, business, ctx } = fixture(t, [node('or', [2], '店长'), node('serial', [3], '张欢'), node('serial', [4], '邓红梅')]);
  state.flow.flow_code = state.flow.business_type = 'sale_resource_reward';
  Object.assign(business, { change_id: 'TASK', change_order_no: 'SRT1', change_reason: 'SALE_RESOURCE_TASK', resource_type: 'EDU_SUBSIDY',
    approval_status: 'pending_manager_review', related_sale_order_id: 'ORDER', sn_id: 'SN', sn_code: 'SN001', product_id: 'P',
    change_amount: 100.01, attachment_url: '["https://example.com/proof.jpg"]',
    reward_snapshot_json: JSON.stringify({ version: 1, accountingVersion: 2, resourceType: 'EDU_SUBSIDY', amount: 100.01, employeeAmount: 80.01, productAmount: 20, orderItemId: 7 }) });
  const profits = [], settlements = [];
  t.mock.method(M.sequelize, 'transaction', async fn => fn(tx));
  t.mock.method(M.ResourceRightChangeOrder, 'findByPk', async () => business);
  t.mock.method(M.Order, 'findByPk', async () => ({ order_id: 'ORDER', order_no: 'ORD1', order_status: '已归档', store_id: 'STORE', create_staff_id: 1, create_user: '销售员' }));
  t.mock.method(M.OrderItem, 'findOne', async () => ({ item_id: 7, sn_id: 'SN', product_id: 'P' }));
  t.mock.method(M.PerformanceProfitAdjustment, 'findOne', async () => null);
  t.mock.method(M.PerformanceProfitAdjustment, 'create', async values => { profits.push(values); return values; });
  const right = { supplier_id: 'SUPPLIER', current_status: 'LOCKED', locked_source_type: 'SALE_ORDER', locked_source_id: 'ORDER',
    async update(patch) { Object.assign(this, patch); } };
  t.mock.method(M.InventoryResourceRight, 'findOne', async () => right);
  t.mock.method(M.ResourceRightChangeOrder, 'create', async values => values);
  t.mock.method(M.ResourceCategory, 'findOne', async () => ({ category_code: 'EDU_SUBSIDY' }));
  t.mock.method(M.ResourceSettlement, 'findOrCreate', async values => { settlements.push(values.defaults); return [values.defaults]; });
  const review = async id => {
    const request = ctx(id); request.params = { changeId: 'TASK' }; request.request.body = { approved: true };
    await require('../src/modules/inventory/resourceRights').reviewSaleResourceTask(request); return request;
  };
  await assert.rejects(review(1), error => error.status === 403);
  assert.equal((await review(2)).state.businessApproval.status, 'pending');
  assert.equal((await review(3)).state.businessApproval.status, 'pending');
  assert.equal(profits.length, 0); assert.equal(settlements.length, 0); assert.equal(business.approval_status, 'pending_manager_review');
  assert.equal(right.current_status, 'LOCKED');
  await review(4);
  assert.equal(business.approval_status, 'completed'); assert.equal(profits.length, 1);
  assert.equal(right.current_status, 'USED');
  assert.equal(profits[0].signed_amount, 80.01); assert.equal(settlements[0].amount, 100.01); assert.equal(settlements[0].source_type, 'EDU_PRODUCT_REBATE');
  assert.equal(JSON.parse(business.reward_snapshot_json).productAmount + profits[0].signed_amount, 100.01);
  await assert.rejects(review(4), error => error.status === 409);
  assert.equal(profits.length, 1);
});

test('权益审批默认节点为店长、指定张欢、指定邓红梅', () => {
  const flow = C.defaultCatalog(new Map([['张欢', 33], ['邓红梅', 44]])).find(row => row.flowCode === 'sale_resource_reward');
  assert.equal(flow.nodes.length, 3);
  assert.equal(flow.nodes[0].approvers[0].type, 'store_manager');
  assert.equal(flow.nodes[1].approvers[0].staffId, 33);
  assert.equal(flow.nodes[2].approvers[0].staffId, 44);
});
test('可用资源读取服务端当前审批人权限，指定人员无需店长角色也可看到待办', async t => {
  fixture(t, [node('or', [2])]);
  const task = { change_id: 'TASK', resource_type: 'EDU_SUBSIDY', related_sale_order_id: 'ORDER',
    applicant_staff_id: 1, approval_status: 'pending_manager_review', reward_snapshot_json: JSON.stringify({ version: 1, amount: 100 }),
    toJSON() { return { ...this }; } };
  t.mock.method(M.ResourceRightChangeOrder, 'findAll', async () => [task]);
  t.mock.method(M.Order, 'findByPk', async () => ({ order_id: 'ORDER', store_id: 'STORE', create_staff_id: 1 }));
  t.mock.method(M.ApprovalFlowInstance, 'findOne', async () => ({ instance_id: 'I', current_node_index: 1, resubmit_count: 0 }));
  t.mock.method(M.ApprovalTask, 'findOne', async ({ where }) => where.assignee_staff_id === 3 ? { node_name: '张欢审批' } : null);
  const ctx = { query: { orderId: 'ORDER' }, state: { user: { staffId: 3, roles: ['finance'], accessibleStoreIds: ['STORE'] } },
    throw(status, message) { throw Object.assign(new Error(message), { status }); } };
  await require('../src/modules/inventory/resourceRights').listSaleResourceTasks(ctx);
  assert.equal(ctx.body[0].can_review, true); assert.equal(ctx.body[0].approval_node_name, '张欢审批');
  ctx.state.user.staffId = 4;
  await assert.rejects(require('../src/modules/inventory/resourceRights').listSaleResourceTasks(ctx), error => error.status === 403);
});

test('截图提交不可省略，缺少凭证时不创建审批或收益', async t => {
  fixture(t, [node('or', [2])]);
  t.mock.method(M.ResourceRightChangeOrder, 'findByPk', async () => ({ change_id: 'TASK', resource_type: 'EDU_SUBSIDY', change_reason: 'SALE_RESOURCE_TASK',
    approval_status: 'pending_submit', related_sale_order_id: 'ORDER', applicant_staff_id: 1 }));
  t.mock.method(M.Order, 'findByPk', async () => ({ order_id: 'ORDER', store_id: 'STORE', create_staff_id: 1 }));
  t.mock.method(M.sequelize, 'transaction', async () => { throw new Error('Must not start without proof'); });
  const ctx = { params: { changeId: 'TASK' }, request: { body: {} }, state: { user: { staffId: 1, roles: ['clerk'], accessibleStoreIds: ['STORE'] } },
    throw(status, message) { throw Object.assign(new Error(message), { status }); } };
  await assert.rejects(require('../src/modules/inventory/resourceRights').submitSaleResourceTask(ctx), error => error.status === 400 && /证明图片/.test(error.message));
});

test('无快照历史报号重新提交仍保持160元，不使用当前规则重算', async t => {
  const { tx } = fixture(t, [node('or', [2])]);
  const task = { change_id: 'OLD', resource_type: 'SALES_REPORT', change_reason: 'SALE_RESOURCE_TASK', approval_status: 'pending_submit',
    related_sale_order_id: 'ORDER', applicant_staff_id: 1, sn_id: 'SN', async reload() {}, async update(values) { Object.assign(this, values); } };
  t.mock.method(M.ResourceRightChangeOrder, 'findByPk', async () => task);
  t.mock.method(M.Order, 'findByPk', async () => ({ order_id: 'ORDER', store_id: 'STORE', create_staff_id: 1, order_status: '已归档' }));
  t.mock.method(M.OrderItem, 'findOne', async () => ({ item_id: 7, sn_id: 'SN' }));
  t.mock.method(M.ResourceCategory, 'findOne', async () => { throw new Error('Must not apply current prices to a legacy reward'); });
  t.mock.method(M.sequelize, 'transaction', async fn => fn(tx));
  const ctx = { params: { changeId: 'OLD' }, request: { body: { attachments: ['https://example.com/proof.jpg'] } },
    state: { user: { staffId: 1, roles: ['clerk'], accessibleStoreIds: ['STORE'] } },
    throw(status, message) { throw Object.assign(new Error(message), { status }); } };
  await require('../src/modules/inventory/resourceRights').submitSaleResourceTask(ctx);
  assert.equal(JSON.parse(task.reward_snapshot_json).amount, 160); assert.equal(task.change_amount, 160);
});

test('销量报号同样等待三级全部通过才按快照增加CARE余额', async t => {
  const { tx, business, ctx, state } = fixture(t, [node('or', [2]), node('serial', [3]), node('serial', [4])]);
  state.flow.flow_code = state.flow.business_type = 'sale_resource_reward';
  Object.assign(business, { change_id: 'REPORT', change_order_no: 'SRT2', change_reason: 'SALE_RESOURCE_TASK', resource_type: 'SALES_REPORT',
    approval_status: 'pending_manager_review', related_sale_order_id: 'ORDER', sn_id: 'SN', sn_code: 'SN001',
    attachment_url: '["https://example.com/proof.jpg"]', reward_snapshot_json: JSON.stringify({ version: 1, resourceType: 'SALES_REPORT', amount: 230 }) });
  const credits = [];
  t.mock.method(M.sequelize, 'transaction', async fn => fn(tx));
  t.mock.method(M.ResourceRightChangeOrder, 'findByPk', async () => business);
  t.mock.method(M.Order, 'findByPk', async () => ({ order_id: 'ORDER', order_no: 'ORD1', order_status: '已归档', store_id: 'STORE', create_staff_id: 1 }));
  t.mock.method(M.OrderItem, 'findOne', async () => ({ item_id: 7, sn_id: 'SN', use_sales_report: 1 }));
  t.mock.method(M.StaffCareCreditTransaction, 'findOne', async () => credits[0] || null);
  t.mock.method(M.StaffCareCreditTransaction, 'findAll', async () => []);
  t.mock.method(M.StaffCareCreditTransaction, 'create', async values => { credits.push(values); return values; });
  const review = async id => {
    const request = ctx(id); request.params = { changeId: 'REPORT' }; request.request.body = { approved: true };
    await require('../src/modules/inventory/resourceRights').reviewSaleResourceTask(request);
  };
  await review(2); await review(3); assert.equal(credits.length, 0);
  await review(4); assert.equal(credits.length, 1); assert.equal(credits[0].amount, 230);
  assert.equal(credits[0].staff_id, 1);
});

test('教育补贴拒绝只退回凭证，不计入毛利或生成待下账', async t => {
  const { tx, business, ctx, state } = fixture(t, [node('or', [2]), node('serial', [3]), node('serial', [4])]);
  state.flow.flow_code = state.flow.business_type = 'sale_resource_reward';
  Object.assign(business, { change_id: 'EDU', change_order_no: 'SRT3', change_reason: 'SALE_RESOURCE_TASK', resource_type: 'EDU_SUBSIDY',
    approval_status: 'pending_manager_review', related_sale_order_id: 'ORDER', sn_id: 'SN', attachment_url: '["https://example.com/proof.jpg"]' });
  t.mock.method(M.sequelize, 'transaction', async fn => fn(tx));
  t.mock.method(M.ResourceRightChangeOrder, 'findByPk', async () => business);
  t.mock.method(M.Order, 'findByPk', async () => ({ order_id: 'ORDER', order_status: '已归档', store_id: 'STORE' }));
  t.mock.method(M.PerformanceProfitAdjustment, 'create', async () => { throw new Error('Must not credit a rejection'); });
  t.mock.method(M.ResourceSettlement, 'findOrCreate', async () => { throw new Error('Must not settle a rejection'); });
  const request = ctx(2); request.params = { changeId: 'EDU' }; request.request.body = { approved: false, comment: '截图不清晰' };
  await require('../src/modules/inventory/resourceRights').reviewSaleResourceTask(request);
  assert.equal(business.approval_status, 'rejected'); assert.equal(state.instances[0].status, 'rejected');
});
