const test = require('node:test');
const assert = require('node:assert/strict');

const inventoryController = require('../src/modules/inventory/controller');

test('采购入库单的采购发起人取采购申请人，不取审批人或入库操作人', () => {
  const resolveName = inventoryController._test.purchaseInitiatorName;
  const resolveReturnName = inventoryController._test.salesReturnRequesterName;
  const resolveInbound = inventoryController._test.resolveInboundInitiator;
  const resolveLogUser = inventoryController._test.resolveSnTraceLogUser;

  assert.equal(resolveName({ apply_user: '熊家敏', approve_user: '段超', submit_user: '熊家敏' }), '熊家敏');
  assert.equal(resolveName({ apply_user: '', submit_user: '熊家敏', approve_user: '段超' }), '熊家敏');
  assert.equal(resolveName({ approve_user: '段超', create_user: '段超' }), '');
  assert.equal(resolveReturnName({ create_user: '退单人' }), '退单人');
  assert.equal(resolveReturnName({ create_user: '', approve_user: '审批人' }), '');
  assert.equal(resolveInbound({ source_type: 'purchase', create_user: '审批人' }, { apply_user: '采购发起人' }), '采购发起人');
  assert.equal(resolveInbound({ source_type: 'SALES_RETURN', create_user: '审批人' }, { create_user: '退单发起人' }), '退单发起人');
  assert.equal(resolveInbound({ source_type: 'TRANSFER', create_user: '执行人' }, null, null, { apply_user: '调拨发起人' }), '调拨发起人');
  assert.equal(resolveLogUser({ remark: 'Sales return approved: RET-001', create_user: '审批人' }, new Map([['RET-001', '退单发起人']])), '退单发起人');
});

test('调拨入库单不属于通用入库列表和通用入库执行入口', () => {
  const { isTransferInboundRecord, buildNonTransferInboundCondition } = inventoryController._test;

  assert.equal(isTransferInboundRecord({ source_type: 'TRANSFER' }), true);
  assert.equal(isTransferInboundRecord({ source_type: 'transfer' }), true);
  assert.equal(isTransferInboundRecord({ source_type: 'purchase' }), false);
  assert.equal(isTransferInboundRecord({ source_type: null }), false);

  const condition = buildNonTransferInboundCondition();
  const orKey = Object.getOwnPropertySymbols(condition)[0];
  assert.equal(condition[orKey].length, 2);
  assert.deepEqual(condition[orKey][0], { source_type: null });
});

test('采购SN入库只有收齐数量和SN数量才能完成', () => {
  const isComplete = inventoryController._test.isPurchaseInboundItemProgressComplete;
  const product = { need_sn: 1 };

  assert.equal(isComplete({ quantity: 8, received_quantity: 7, received_sn_codes: JSON.stringify(['SN1', 'SN2', 'SN3', 'SN4', 'SN5', 'SN6', 'SN7']) }, product), false);
  assert.equal(isComplete({ quantity: 8, received_quantity: 8, received_sn_codes: JSON.stringify(['SN1', 'SN2', 'SN3', 'SN4', 'SN5', 'SN6', 'SN7', 'SN8']) }, product), true);
  assert.equal(isComplete({ quantity: 8, received_quantity: 8, received_sn_codes: JSON.stringify(['SN1', 'SN2', 'SN3', 'SN4', 'SN5', 'SN6', 'SN7']) }, product), false);

  assert.equal(isComplete(
    { quantity: 8, received_quantity: 0, received_sn_codes: '[]' },
    product,
    { quantity: 8, snCodes: ['SN1', 'SN2', 'SN3', 'SN4', 'SN5', 'SN6', 'SN7', 'SN8'] }
  ), true);
  assert.equal(isComplete(
    { quantity: 8, received_quantity: 7, received_sn_codes: JSON.stringify(['SN1', 'SN2', 'SN3', 'SN4', 'SN5', 'SN6', 'SN7']) },
    product,
    { quantity: 1, snCodes: ['SN8'] }
  ), true);
  assert.equal(isComplete(
    { quantity: 8, received_quantity: 7, received_sn_codes: JSON.stringify(['SN1', 'SN2', 'SN3', 'SN4', 'SN5', 'SN6', 'SN7']) },
    product,
    { quantity: 1, snCodes: [] }
  ), false);
});
