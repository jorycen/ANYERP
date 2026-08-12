const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../src/modules/purchase/controller');

test('采购订单按明细累计入库，部分到货保持 partial', () => {
  const requestItems = [
    { item_id: 101, quantity: 2 },
    { item_id: 102, quantity: 1 }
  ];

  const partial = _test.purchaseInboundProgress(requestItems, [
    {
      status: 'partial',
      items: [{ purchase_request_item_id: 101, quantity: 2, received_quantity: 1 }]
    }
  ]);
  assert.deepEqual(partial, { totalQuantity: 3, receivedQuantity: 1, status: 'partial' });

  const completed = _test.purchaseInboundProgress(requestItems, [
    {
      status: 'completed',
      items: [
        { purchase_request_item_id: 101, quantity: 2, received_quantity: 2 },
        { purchase_request_item_id: 102, quantity: 1, received_quantity: 1 }
      ]
    }
  ]);
  assert.deepEqual(completed, { totalQuantity: 3, receivedQuantity: 3, status: 'completed' });
});

