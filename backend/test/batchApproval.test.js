const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const runtime = require('../src/modules/approval/businessRuntime');
const service = require('../src/modules/approval/service');
const batch = require('../src/modules/approval/batchApproval');

function context(items) {
  return { state: { user: { staffId: 7, accessibleStoreIds: ['STORE'] } }, request: { body: { items, businessData: { rebateAmount: 999 } } }, params: {},
    throw(status, message) { throw Object.assign(new Error(message), { status }); } };
}
function fixture(t) {
  const instance = { instance_id: 'I1', business_type: 'gift_receipt', business_id: 'B1', status: 'pending', store_id: 'STORE', current_node_index: 0, resubmit_count: 0, payload_json: '{"managedBusiness":true}' };
  const task = { task_id: 'T1' };
  const row = { receipt_id: 'B1', source_type: 'GIFT', status: 'pending', update_time: new Date('2026-10-27T00:00:00Z') };
  t.mock.method(M.ApprovalFlowInstance, 'findByPk', async () => instance);
  t.mock.method(M.ApprovalFlowInstance, 'findOne', async () => instance);
  t.mock.method(M.ApprovalTask, 'findOne', async () => task);
  t.mock.method(M.NonPurchaseReceipt, 'findByPk', async () => row);
  t.mock.method(runtime, 'context', async () => ({ store_id: 'STORE' }));
  t.mock.method(runtime, 'visible', () => true);
  const ref = { key: 'B', kind: 'business', businessType: 'gift_receipt', businessId: 'B1' };
  return { instance, task, row, ref };
}
test('需要人工补充资料的审批不可批量通过，不能通过携带businessData绕过', async () => {
  const ctx = context(['sales_component_recovery', 'manufacturer_rebate_confirmation', 'product_application', 'inventory_transfer'].map(type => ({ key: type, kind: 'business', businessType: type, businessId: '1' })));
  await batch.options(ctx);
  assert.equal(ctx.body.data.length, 4);
  assert.ok(ctx.body.data.every(item => !item.eligible && item.reason));
  await batch.approve(ctx);
  assert.equal(ctx.body.data.failed, 4);
});
test('逐单处理保留原上下文，调用原业务入口；失败不影响后续单据', async t => {
  const f = fixture(t);
  const resolved = await batch.resolve(f.ref, context([]).state.user);
  const ctx = context([{ ...f.ref, token: resolved.token }, { key: 'bad', kind: 'business', businessType: 'not_exists', businessId: '2' }, { ...f.ref, key: 'duplicate', token: resolved.token }]);
  let calls = 0;
  t.mock.method(runtime, 'dispatch', async (child, type, id, action) => {
    calls++; assert.equal(type, 'gift_receipt'); assert.equal(id, 'B1'); assert.equal(action, 'approve');
    assert.equal(child.state.user.staffId, 7); assert.equal(child.state.batchApprovalExpected, resolved.token);
    assert.deepEqual(child.request.body, { action: 'approve', comment: '' });
    child.status = 200;
    child.body = { code: 0, status: 'pending' };
  });
  await batch.approve(ctx);
  assert.equal(calls, 1);
  assert.equal(ctx.body.code, 0); assert.equal(ctx.status, undefined);
  assert.equal(ctx.body.data.succeeded, 1); assert.equal(ctx.body.data.failed, 2);
  assert.equal(ctx.body.data.results[0].pending, true);
});
test('通用实例和业务入口指向同一审批时去重', async t => {
  const f = fixture(t), user = context([]).state.user;
  const token = (await batch.resolve(f.ref, user)).token;
  t.mock.method(runtime, 'dispatch', async child => { child.body = { code: 0 }; });
  const ctx = context([{ ...f.ref, token }, { key: 'alias', kind: 'instance', instanceId: 'I1', token }]);
  await batch.approve(ctx);
  assert.deepEqual(ctx.body.data.results.map(item => item.success), [true, false]);
});
test('勾选后节点或待办已变更，旧请求不能通过下一节点', async t => {
  const f = fixture(t), user = context([]).state.user;
  const token = (await batch.resolve(f.ref, user)).token;
  f.task.task_id = 'T2';
  let calls = 0;
  t.mock.method(runtime, 'dispatch', async () => { calls++; });
  const ctx = context([{ ...f.ref, token }]);
  await batch.approve(ctx);
  assert.equal(ctx.body.data.failed, 1); assert.equal(calls, 0);
});
test('业务锁内再次验证，读取后发生状态变化也不能审批', async t => {
  const f = fixture(t), ctx = context([]);
  ctx.state.batchApprovalExpected = (await batch.resolve(f.ref, ctx.state.user)).token;
  f.row.update_time = new Date('2026-10-27T01:00:00Z');
  await assert.rejects(batch.assertBusiness(ctx, 'gift_receipt', f.row, { LOCK: { UPDATE: 'UPDATE' } }), /刷新/);
});
test('没有该节点待办或没有门店权限不能获取可用令牌', async t => {
  const f = fixture(t);
  t.mock.method(M.ApprovalTask, 'findOne', async () => null);
  await assert.rejects(batch.resolve(f.ref, context([]).state.user), /待审批任务/);
  t.mock.method(runtime, 'visible', () => false);
  await assert.rejects(batch.resolve(f.ref, context([]).state.user), /无权/);
});
test('通用审批在事务锁内阻止旧待办令牌，不写审批日志或状态', async t => {
  const f = fixture(t);
  f.instance.payload_json = '{}'; f.instance.business_type = 'sn_change';
  const oldToken = batch.instanceToken(f.instance, f.task);
  f.task.task_id = 'T2';
  const tx = { LOCK: { UPDATE: 'UPDATE' } };
  await assert.rejects(service.actionInstance('I1', 'approve', '', context([]).state.user, { transaction: tx, batchExpected: oldToken }), /刷新/);
});
test('批次为空或超过100条整批拒绝', async () => {
  await assert.rejects(batch.approve(context([])), /100/);
  await assert.rejects(batch.options(context(Array(101).fill({}))), /100/);
});
test('原审批入口报错后仍继续执行后续单据，逐单返回完整结果', async t => {
  const f = fixture(t);
  t.mock.method(M.ApprovalFlowInstance, 'findByPk', async id => ({ ...f.instance, instance_id: id, payload_json: '{}', business_type: 'sn_change' }));
  const controller = require('../src/modules/approval/controller');
  const called = [];
  t.mock.method(controller, 'action', async ctx => {
    called.push(ctx.params.instanceId);
    if (ctx.params.instanceId === 'FAIL') throw new Error('原业务校验未通过');
    ctx.body = { code: 0 };
  });
  const refs = ['OK1', 'FAIL', 'OK2'].map(id => ({ key: id, kind: 'instance', instanceId: id }));
  const ctx = context([]);
  ctx.request.body.items = await Promise.all(refs.map(async item => ({ ...item, token: (await batch.resolve(item, ctx.state.user)).token })));
  await batch.approve(ctx);
  assert.deepEqual(called, ['OK1', 'FAIL', 'OK2']);
  assert.deepEqual(ctx.body.data.results.map(row => row.success), [true, false, true]);
  assert.equal(ctx.body.data.results[1].message, '原业务校验未通过');
});
test('兼容依赖外层格式化器的原业务成功响应，不误报已提交业务为失败', async t => {
  const f = fixture(t), ctx = context([]);
  const token = (await batch.resolve(f.ref, ctx.state.user)).token;
  t.mock.method(runtime, 'dispatch', async child => { child.body = { message: '资源任务已审核完成' }; });
  ctx.request.body.items = [{ ...f.ref, token }];
  await batch.approve(ctx);
  assert.equal(ctx.body.data.succeeded, 1);
});
test('原入口设置失败HTTP状态时逐单隔离，整批仍能正常返回结果', async t => {
  const f = fixture(t), ctx = context([]);
  const token = (await batch.resolve(f.ref, ctx.state.user)).token;
  t.mock.method(runtime, 'dispatch', async child => { child.status = 409; child.body = { code: 409, message: '业务状态已变化' }; });
  ctx.request.body.items = [{ ...f.ref, token }];
  await batch.approve(ctx);
  assert.equal(ctx.body.data.failed, 1);
  assert.equal(ctx.status, undefined);
  assert.equal(ctx.body.data.results[0].message, '业务状态已变化');
});
