const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const S = require('../src/modules/approval/service');
const R = require('../src/modules/approval/businessRuntime');
const C = require('../src/modules/approval/catalog');

function fixture(t, nodes) {
  const tx = { LOCK: { UPDATE: 'UPDATE' } };
  const state = { instances: [], tasks: [], logs: [], flow: { definition_id: 'flow-1', flow_code: 'purchase_request', business_type: 'purchase_request', name: '采购审批', version: 1, status: 'published', config_json: JSON.stringify({ nodes }) } };
  const row = data => Object.assign(data, { toJSON() { return { ...this }; }, async update(patch, options) { assert.equal(options.transaction, tx); Object.assign(this, patch); return this; } });
  const employees = [1, 2, 3, 4].map(id => row({ staff_id: id, name: `员工${id}`, status: 1, is_deleted: 0, store_id: 'HOME', distributor_id: 'D1', Roles: [] }));
  t.mock.method(M.sequelize, 'query', async () => { throw new Error('Tests must not access a database'); });
  t.mock.method(M.Staff, 'findByPk', async id => employees.find(e => e.staff_id === Number(id)));
  t.mock.method(M.Staff, 'findAll', async () => employees);
  t.mock.method(M.Store, 'findByPk', async () => ({ distributor_id: 'D1' }));
  t.mock.method(M.ApprovalFlowDefinition, 'findOne', async () => state.flow?.status === 'published' ? state.flow : null);
  t.mock.method(M.ApprovalFlowInstance, 'findOne', async () => state.instances.at(-1) || null);
  t.mock.method(M.ApprovalFlowInstance, 'findByPk', async id => state.instances.find(i => i.instance_id === id));
  t.mock.method(M.ApprovalFlowInstance, 'create', async (values, options) => { assert.equal(options.transaction, tx); const instance = row(values); state.instances.push(instance); return instance; });
  const matches = (task, where) => Object.entries(where).every(([key, value]) => task[key] === value);
  t.mock.method(M.ApprovalTask, 'bulkCreate', async (values, options) => { assert.equal(options.transaction, tx); state.tasks.push(...values.map(row)); });
  t.mock.method(M.ApprovalTask, 'findOne', async ({ where }) => state.tasks.find(task => matches(task, where)) || null);
  t.mock.method(M.ApprovalTask, 'count', async ({ where }) => state.tasks.filter(task => matches(task, where)).length);
  t.mock.method(M.ApprovalTask, 'update', async (patch, { where, transaction }) => {
    assert.equal(transaction, tx);
    for (const task of state.tasks) if (task.instance_id === where.instance_id && (typeof where.status === 'object' ? ['pending', 'waiting'].includes(task.status) : task.status === where.status)) Object.assign(task, patch);
  });
  t.mock.method(M.ApprovalActionLog, 'create', async (values, options) => { assert.equal(options.transaction, tx); state.logs.push(values); });
  const business = row({ request_id: 'PR1', request_no: '采购1', status: 'pending', applicant_staff_id: 1, store_id: 'STORE', distributor_id: 'D1' });
  const ctx = id => ({ state: { user: { staffId: id, name: `员工${id}`, roles: ['clerk'], accessibleStoreIds: ['STORE'], distributorId: 'D1' } }, request: { body: {} }, throw(status, message) { throw Object.assign(new Error(message), { status }); } });
  return { state, tx, business, ctx };
}
const node = (mode, ids, name = '审批节点') => ({ name, signMode: mode, approvers: ids.map(staffId => ({ type: 'fixed_user', staffId })) });

test('配置人员即使没有旧采购角色也可审批，业务门店覆盖员工主门店', async t => {
  const { state, tx, business, ctx } = fixture(t, [node('or', [2])]);
  assert.equal(await R.advance(ctx(2), 'purchase_request', business, tx, 'approved'), true);
  assert.equal(state.instances[0].status, 'approved');
  assert.equal(state.instances[0].store_id, 'STORE');
  assert.equal(state.logs.length, 2);
});
test('串行节点依次审批，第二节点完成前不得执行业务', async t => {
  const { state, tx, business, ctx } = fixture(t, [node('serial', [2, 3]), node('or', [4])]);
  assert.equal(await R.advance(ctx(2), 'purchase_request', business, tx, 'approved'), false);
  assert.equal(state.instances[0].current_node_index, 0);
  assert.equal(await R.advance(ctx(3), 'purchase_request', business, tx, 'approved'), false);
  assert.equal(state.instances[0].current_node_index, 1);
  assert.equal(await R.advance(ctx(4), 'purchase_request', business, tx, 'approved'), true);
});
test('或签单人拒绝保持审批中，另一人通过后才最终通过', async t => {
  const { state, tx, business, ctx } = fixture(t, [node('or', [2, 3])]);
  assert.equal(await R.advance(ctx(2), 'purchase_request', business, tx, 'reject', '不同意'), false);
  assert.equal(state.instances[0].status, 'pending');
  assert.equal(await R.advance(ctx(3), 'purchase_request', business, tx, 'approve'), true);
  assert.equal(state.instances[0].status, 'approved');
});
test('或签全部拒绝才拒绝，串行拒绝取消后续任务', async t => {
  const { state, tx, business, ctx } = fixture(t, [node('or', [2, 3])]);
  await R.advance(ctx(2), 'purchase_request', business, tx, 'reject', '不同意');
  assert.equal(await R.advance(ctx(3), 'purchase_request', business, tx, 'reject', '不同意'), true);
  assert.equal(state.instances[0].status, 'rejected');
});
test('新发布配置不覆盖在途快照，旧审批人可继续，新增审批人不能越级', async t => {
  const { state, tx, business, ctx } = fixture(t, [node('serial', [2, 3])]);
  await R.begin('purchase_request', business, tx);
  state.flow.config_json = JSON.stringify({ nodes: [node('or', [4])] });
  await assert.rejects(R.advance(ctx(4), 'purchase_request', business, tx, 'approved'), /不是该节点/);
  await R.advance(ctx(2), 'purchase_request', business, tx, 'approved');
  assert.equal(await R.advance(ctx(3), 'purchase_request', business, tx, 'approved'), true);
});
test('流程缺失或停用不放行，跨门店不能审批', async t => {
  const { state, tx, business, ctx } = fixture(t, [node('or', [2])]);
  state.flow = null;
  await assert.rejects(R.advance(ctx(2), 'purchase_request', business, tx, 'approved'), /已发布/);
  const denied = ctx(2); denied.state.user.accessibleStoreIds = ['OTHER'];
  await assert.rejects(R.advance(denied, 'purchase_request', business, tx, 'approved'), /无权审批/);
});
test('已处理单据与无事务请求不能重复执行，拒绝必须有原因', async t => {
  const { tx, business, ctx } = fixture(t, [node('or', [2])]);
  await assert.rejects(R.advance(ctx(2), 'purchase_request', business, null, 'approved'), /同一事务/);
  await assert.rejects(R.advance(ctx(2), 'purchase_request', business, tx, 'reject'), /拒绝时必须/);
  business.status = 'approved';
  await assert.rejects(R.advance(ctx(2), 'purchase_request', business, tx, 'approved'), /已处理/);
});
test('托管审批不能从通用入口绕过业务执行', async t => {
  const { state, tx, business, ctx } = fixture(t, [node('or', [2])]);
  await R.begin('purchase_request', business, tx);
  await assert.rejects(S.actionInstance(state.instances[0].instance_id, 'approve', '', ctx(2).state.user, { transaction: tx }), /业务审批入口/);
});
test('历史复审从已有阶段继续，缺少对应配置节点阻止审批', async t => {
  const { state, tx, business } = fixture(t, [node('or', [2])]);
  state.flow.business_type = 'profit_adjustment';
  business.adjustment_id = 'A1'; business.status = 'pending_admin';
  await assert.rejects(R.begin('profit_adjustment', business, tx, { historical: true }), /历史审批阶段/);
});
test('补齐18类流程，缺失固定审批人保留草稿，不覆盖自定义或停用流程', async t => {
  const saved = [];
  t.mock.method(M.Staff, 'findAll', async () => []);
  t.mock.method(M.ApprovalFlowDefinition, 'findOne', async ({ where }) => where.flow_code === 'purchase_request' ? { status: 'disabled' } : null);
  t.mock.method(M.ApprovalFlowDefinition, 'create', async values => saved.push(values));
  await C.seedApprovalFlowCatalog();
  assert.equal(C.defaultCatalog().length, 18);
  assert.equal(saved.length, 17);
  assert.equal(saved.find(row => row.flow_code === 'expense_attribution').status, 'draft');
  assert.equal(saved.find(row => row.flow_code === 'product_application').status, 'published');
  assert.equal(saved.some(row => row.flow_code === 'purchase_request'), false);
});

test('待办查询只显示当前配置人员，GET不会创建实例或改变业务', async t => {
  const { state, business, ctx } = fixture(t, [node('serial', [2, 3])]);
  t.mock.method(M.PurchaseRequest, 'findAll', async () => [business]);
  const first = ctx(2);
  await R.listBusinessTasks(first, 'purchase_request');
  assert.equal(first.body.data.length, 1);
  const waiting = ctx(3);
  await R.listBusinessTasks(waiting, 'purchase_request');
  assert.equal(waiting.body.data.length, 0);
  assert.equal(state.instances.length, 0);
  assert.equal(state.tasks.length, 0);
  assert.equal(business.status, 'pending');
});

test('托管待办路由不把Koa next参数当作业务类型', async t => {
  const { business, ctx } = fixture(t, [node('or', [2])]);
  for (const name of new Set(Object.values(R.registry).map(d => d.model))) {
    t.mock.method(M[name], 'findAll', async () => name === 'PurchaseRequest' ? [business] : []);
  }
  const route = require('../src/modules/approval/routes').stack.find(item => item.path === '/business-tasks');
  const request = ctx(2);
  await route.stack[0](request, async () => {});
  assert.equal(request.body.data.length, 1);
});

test('已完成实例不能重新显示成可审批历史单据', async t => {
  const { state, business, ctx } = fixture(t, [node('or', [2])]);
  state.instances.push({ status: 'approved' });
  t.mock.method(M.PurchaseRequest, 'findAll', async () => [business]);
  const admin = ctx(2); admin.state.user.roles = ['admin'];
  await R.listBusinessTasks(admin, 'purchase_request');
  assert.equal(admin.body.data.length, 0);
  assert.match(admin.body.issues[0].message, /状态不一致/);
});

test('业务提交钩子在原事务创建快照，撤销时取消在途任务', async t => {
  const { state, business, tx } = fixture(t, [node('or', [2])]);
  const hooks = new Map();
  for (const name of new Set(Object.values(R.registry).map(d => d.model))) {
    t.mock.method(M[name], 'addHook', (event, key, fn) => hooks.set(`${event}:${key}`, fn));
  }
  R.installHooks();
  business.isNewRecord = false;
  business.previous = () => 'draft';
  const save = hooks.get('afterSave:approval_purchase_request');
  await save(business, { transaction: tx });
  assert.equal(state.instances.length, 1);
  assert.equal(state.tasks[0].status, 'pending');
  await save(business, { transaction: tx });
  assert.equal(state.instances.length, 1);
  business.status = 'revoked'; business.previous = () => 'pending';
  await save(business, { transaction: tx });
  assert.equal(state.instances[0].status, 'cancelled');
  assert.equal(state.tasks[0].status, 'cancelled');
});

test('无门店审批必须匹配经销商，不能依赖应付类型放行', () => {
  const user = { roles: ['finance'], accessibleStoreIds: [], distributorId: 'D1' };
  assert.equal(S.canReadApprovalStore(user, null, 'payable_settlement', 'D1'), true);
  assert.equal(S.canReadApprovalStore(user, null, 'payable_settlement', 'D2'), false);
  assert.equal(S.canReadApprovalStore(user, null, 'payable_settlement'), false);
});
