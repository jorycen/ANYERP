const test = require('node:test');
const assert = require('node:assert/strict');
const models = require('../src/models');
const inventoryRouter = require('../src/modules/inventory/routes');
const { _test: inventoryTest } = require('../src/modules/inventory/controller');

test('销售、采购单据包含提交和审批字段，业务审计日志模型可持久化', async () => {
  const order = models.Order.build({
    order_id: 'ORDER_AUDIT_1',
    order_no: 'SO_AUDIT_1',
    store_id: 'STORE_1',
    submit_user: '销售员',
    submit_time: new Date(),
    approve_user: '店长',
    approve_time: new Date(),
    approve_comment: '通过'
  });
  const request = models.PurchaseRequest.build({
    request_id: 'REQUEST_AUDIT_1',
    request_no: 'PR_AUDIT_1',
    store_id: 'STORE_1',
    submit_user: '采购员',
    submit_time: new Date(),
    approve_user: '采购主管',
    approve_time: new Date()
  });
  const log = models.BusinessActionLog.build({
    log_id: 'LOG_AUDIT_1',
    business_type: 'sales_order',
    business_id: 'ORDER_AUDIT_1',
    action: 'approved',
    actor_name: '店长',
    from_status: 'pending_approval',
    to_status: '未归档'
  });

  await Promise.all([order.validate(), request.validate(), log.validate()]);
  assert.equal(order.submit_user, '销售员');
  assert.equal(request.approve_user, '采购主管');
  assert.equal(log.action, 'approved');
});

test('调拨详情接口已注册，用于展示调拨全流程', () => {
  const route = inventoryRouter.stack.find(layer => layer.path === '/transfer/:transferId' && layer.methods.includes('GET'));
  assert.ok(route);
});

test('调拨申请撤销和拒绝接口已注册，且权限状态判断只允许申请未出库前处理', () => {
  assert.ok(inventoryRouter.stack.find(layer => layer.path === '/transfer/revoke' && layer.methods.includes('POST')));
  assert.ok(inventoryRouter.stack.find(layer => layer.path === '/transfer/reject' && layer.methods.includes('POST')));
  assert.ok(inventoryRouter.stack.find(layer => layer.path === '/transfer/return' && layer.methods.includes('POST')));
  assert.equal(inventoryTest.isTransferRequestOpen({ status: 'pending' }), true);
  assert.equal(inventoryTest.isTransferRequestOpen({ status: 'out_confirmed' }), false);
  assert.equal(inventoryTest.isTransferRequestOpen({ status: 'completed' }), false);
  assert.equal(inventoryTest.isTransferAwaitingReceipt('out_confirmed'), true);
  assert.equal(inventoryTest.isTransferAwaitingReceipt('returned'), false);
  assert.equal(inventoryTest.isTransferApplicant({ name: '申请人' }, { apply_user: '申请人' }), true);
  assert.equal(inventoryTest.isTransferApplicant({ name: '其他人' }, { apply_user: '申请人' }), false);
});
