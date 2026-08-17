const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../src/modules/inventory/controller');
const { isDealerTransferOperation, storeGuard } = require('../src/middleware/permission');

test('经销商级账号可以进入全部调拨操作接口，门店角色仍受门店分配限制', () => {
  const dealerContext = {
    method: 'POST',
    path: '/api/v1/inventory/transfer/confirm-out',
    state: { user: { roles: ['finance'], accessibleStoreIds: [] } },
    request: { body: {} },
    query: {},
    throw(status, message) { throw new Error(message || status) }
  };
  assert.equal(isDealerTransferOperation(dealerContext), true);
  assert.equal(storeGuard(dealerContext), null);

  const storeContext = {
    ...dealerContext,
    state: { user: { roles: ['manager'], accessibleStoreIds: [] } }
  };
  assert.equal(isDealerTransferOperation(storeContext), false);
  assert.throws(() => storeGuard(storeContext), /当前账号尚未分配门店/);
});

test('调拨查询按角色区分本人参与、经销商和系统全量范围', () => {
  assert.equal(_test.getTransferVisibilityLevel({ roles: ['boss'] }), 'all');
  assert.equal(_test.getTransferVisibilityLevel({ roles: ['admin'] }), 'distributor');
  assert.equal(_test.getTransferVisibilityLevel({ roles: ['finance'] }), 'distributor');
  assert.equal(_test.getTransferVisibilityLevel({ roles: ['purchaser'] }), 'distributor');
  assert.equal(_test.getTransferVisibilityLevel({ roles: ['business'] }), 'distributor');
  assert.equal(_test.getTransferVisibilityLevel({ roles: ['manager'] }), 'store');
  assert.equal(_test.getTransferVisibilityLevel({ roles: ['clerk'] }), 'participant');
  assert.equal(_test.getTransferVisibilityLevel({ roles: ['manager', 'clerk'] }), 'store');
  assert.equal(_test.getTransferVisibilityLevel({ roles: ['manager', 'finance'] }), 'distributor');
});

test('店员调拨查询同时限制授权门店和本人参与人字段', () => {
  const conditions = _test.buildTransferVisibilityWhere(
    { roles: ['clerk'], name: '张三' },
    ['STORE_1']
  );

  assert.equal(conditions.length, 1);
  const participantCondition = conditions[0];
  const participantOr = participantCondition[Object.getOwnPropertySymbols(participantCondition)[0]];
  assert.equal(participantOr.length, 7);
  assert.deepEqual(participantOr[0], { apply_user: '张三' });
  assert.deepEqual(participantOr[4], { receiving_user: '张三' });
});

test('经销商级账号按本经销商门店范围查询，不能因无门店而放开数据', () => {
  const conditions = _test.buildTransferVisibilityWhere({ roles: ['admin'] }, []);
  assert.equal(conditions.length, 1);
  const scopeCondition = conditions[0];
  const scopeOr = scopeCondition[Object.getOwnPropertySymbols(scopeCondition)[0]];
  assert.equal(scopeOr.length, 1);
  assert.deepEqual(scopeOr[0].transfer_id, { [Object.getOwnPropertySymbols(scopeOr[0].transfer_id)[0]]: ['__NO_TRANSFER_SCOPE__'] });
});

test('经销商级账号只按用户管理已分配门店查询历史调拨', () => {
  const conditions = _test.buildTransferVisibilityWhere({ roles: ['finance'] }, ['STORE_1', 'STORE_2'], 'D1');
  const scopeCondition = conditions[0];
  const scopeOr = scopeCondition[Object.getOwnPropertySymbols(scopeCondition)[0]];
  assert.deepEqual(scopeOr, [
    { from_store_id: { [Object.getOwnPropertySymbols(scopeOr[0].from_store_id)[0]]: ['STORE_1', 'STORE_2'] } },
    { to_store_id: { [Object.getOwnPropertySymbols(scopeOr[1].to_store_id)[0]]: ['STORE_1', 'STORE_2'] } }
  ]);
});

test('店员和店长不能查询SN关联入库详情，经销商业务角色可以', () => {
  assert.equal(_test.isDistributorAccount({ roles: ['admin'] }), true);
  assert.equal(_test.isDistributorAccount({ roles: ['business'] }), true);
  assert.equal(_test.isDistributorAccount({ roles: ['finance', 'manager'] }), true);
  assert.equal(_test.isDistributorAccount({ roles: ['manager'] }), false);
  assert.equal(_test.isDistributorAccount({ roles: ['clerk'] }), false);
});

test('运输中待收货调拨才允许退回', () => {
  assert.equal(_test.isTransferAwaitingReceipt('out_confirmed'), true);
  assert.equal(_test.isTransferAwaitingReceipt('shipping_out'), true);
  assert.equal(_test.isTransferAwaitingReceipt('in_transit'), true);
  assert.equal(_test.isTransferAwaitingReceipt('pending'), false);
  assert.equal(_test.isTransferAwaitingReceipt('completed'), false);
  assert.equal(_test.isTransferAwaitingReceipt('returned'), false);
});

test('调拨入库沿用出库明细SN并拒绝替换', () => {
  const binding = _test.resolveTransferInboundSnBinding(
    { sn_id: 'SN_ID_1', sn_code: 'SN_CODE_1' },
    { sn_id: 'SN_ID_1', sn_code: 'SN_CODE_1' },
    { snId: 'SN_ID_2', snCode: 'SN_CODE_2' }
  );

  assert.equal(binding.snId, 'SN_ID_1');
  assert.equal(binding.snCode, 'SN_CODE_1');
  assert.equal(binding.requestedSnIdMismatch, true);
  assert.equal(binding.requestedSnCodeMismatch, true);
  assert.equal(binding.sourceSnIdMismatch, false);
  assert.equal(binding.sourceSnCodeMismatch, false);
});
