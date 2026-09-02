const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildReturnAdjustmentItems,
  getReturnAdjustmentSummary,
  canOffsetOriginalPayable
} = require('../src/modules/purchase/purchaseReturnAccounting');
const { _test: purchaseTest } = require('../src/modules/purchase/controller');

test('采购退库明细生成负向数量和金额，并保留原入库关联', () => {
  const rows = buildReturnAdjustmentItems({
    returnNo: 'RTN-1',
    requestItems: [{
      item_id: 11,
      product_id: 'P-1',
      product_name: '商品A',
      quantity: 5,
      unit_price: 100,
      rebate_deduction: 50
    }],
    inboundItems: [{
      item_id: 21,
      inbound_id: 'IN-1',
      purchase_request_item_id: 11,
      product_id: 'P-1',
      quantity: 5,
      store_id: 'S-1'
    }],
    returnItems: [{
      item_id: 31,
      inbound_item_id: 21,
      product_id: 'P-1',
      quantity: 2,
      unit_price: 100
    }]
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].request_item_id, 11);
  assert.equal(rows[0].inbound_item_id, 21);
  assert.equal(rows[0].quantity_delta, -2);
  assert.equal(rows[0].amount_delta, -180);
  assert.deepEqual(getReturnAdjustmentSummary(rows), {
    totalQuantityDelta: -2,
    totalAmountDelta: -180
  });
});

test('历史退库缺少入库明细外键时，仅在商品匹配唯一时兼容修复', () => {
  const rows = buildReturnAdjustmentItems({
    returnNo: 'RTN-2',
    requestItems: [{ item_id: 11, product_id: 'P-1', quantity: 1, unit_price: 20 }],
    inboundItems: [{ item_id: 21, inbound_id: 'IN-1', purchase_request_item_id: 11, product_id: 'P-1', quantity: 1 }],
    returnItems: [{ item_id: 31, product_id: 'P-1', quantity: 1, unit_price: 20 }]
  });
  assert.equal(rows[0].inbound_item_id, 21);
  assert.throws(() => buildReturnAdjustmentItems({
    returnNo: 'RTN-3',
    requestItems: [{ item_id: 11, product_id: 'P-1', quantity: 2, unit_price: 20 }],
    inboundItems: [
      { item_id: 21, inbound_id: 'IN-1', purchase_request_item_id: 11, product_id: 'P-1', quantity: 1 },
      { item_id: 22, inbound_id: 'IN-2', purchase_request_item_id: 11, product_id: 'P-1', quantity: 1 }
    ],
    returnItems: [{ item_id: 31, product_id: 'P-1', quantity: 1, unit_price: 20 }]
  }), /无法唯一匹配/);
});

test('原采购应付款只有未结算且未付款时才直接冲减', () => {
  assert.equal(canOffsetOriginalPayable({ status: 'unpaid', paid_amount: 0 }, 0), true);
  assert.equal(canOffsetOriginalPayable({ status: 'paid', paid_amount: 0 }, 0), false);
  assert.equal(canOffsetOriginalPayable({ status: 'unpaid', paid_amount: 10 }, 0), false);
  assert.equal(canOffsetOriginalPayable({ status: 'unpaid', paid_amount: 0 }, 1), false);
});

test('采购申请详情按采购调整扣减当前数量和金额，原始值仍保留', () => {
  const items = purchaseTest.attachCurrentPurchaseItemAmounts([
    { item_id: 11, quantity: 5, unit_price: 100, subtotal: 500, rebate_deduction: 50, actual_amount: 450 }
  ], [{
    items: [{ request_item_id: 11, quantity_delta: -2, unit_price: 100, amount_delta: -180 }]
  }]);
  assert.equal(items[0].quantity, 5);
  assert.equal(items[0].current_quantity, 3);
  assert.equal(items[0].current_subtotal, 300);
  assert.equal(items[0].current_rebate_deduction, 30);
  assert.equal(items[0].current_actual_amount, 270);
});

test('采购申请将退货调整暴露为独立负向订单，原订单仍保持独立', () => {
  const orders = purchaseTest.buildNegativePurchaseOrders([{
    adjustment_id: 'ADJ-1',
    adjustment_no: 'RET-1',
    request_id: 'REQ-1',
    request_no: 'PR-1',
    total_quantity_delta: -2,
    total_amount_delta: -190,
    status: 'completed',
    items: [{
      request_item_id: 11,
      product_id: 'P-1',
      product_name: '商品A',
      quantity_delta: -2,
      amount_delta: -190,
      unit_price: 95
    }]
  }, {
    adjustment_id: 'ADJ-2',
    adjustment_no: 'ADD-1',
    request_id: 'REQ-1',
    total_quantity_delta: 1,
    total_amount_delta: 95,
    items: []
  }]);

  assert.equal(orders.length, 1);
  assert.equal(orders[0].order_no, 'RET-1');
  assert.equal(orders[0].total_quantity, -2);
  assert.equal(orders[0].total_amount, -190);
  assert.equal(orders[0].items[0].quantity, -2);
  assert.equal(orders[0].items[0].amount, -190);
});

test('采购申请生命周期区分部分退货和全部退货', () => {
  assert.equal(purchaseTest.getPurchaseLifecycleStatus('approved', [
    { status: 'completed' },
    { status: 'returned' }
  ]), 'partial_return');
  assert.equal(purchaseTest.getPurchaseLifecycleStatus('approved', [
    { status: 'returned' },
    { status: 'cancelled' }
  ]), 'returned');
});
