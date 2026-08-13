const test = require('node:test');
const assert = require('node:assert/strict');

const inventoryController = require('../src/modules/inventory/controller');

test('采购入库单的采购发起人取采购申请人，不取审批人或入库操作人', () => {
  const resolveName = inventoryController._test.purchaseInitiatorName;
  const resolveReturnName = inventoryController._test.salesReturnRequesterName;

  assert.equal(resolveName({ apply_user: '熊家敏', approve_user: '段超', submit_user: '熊家敏' }), '熊家敏');
  assert.equal(resolveName({ apply_user: '', submit_user: '熊家敏', approve_user: '段超' }), '熊家敏');
  assert.equal(resolveName({ approve_user: '段超', create_user: '段超' }), '');
  assert.equal(resolveReturnName({ create_user: '退单人' }), '退单人');
  assert.equal(resolveReturnName({ create_user: '', approve_user: '审批人' }), '');
});
