const test = require('node:test');
const assert = require('node:assert/strict');
const purchaseRouter = require('../src/modules/purchase/routes');
const purchaseController = require('../src/modules/purchase/controller');

test('采购申请草稿提供保存、编辑和提交接口', () => {
  const saveRoute = purchaseRouter.stack.find(layer => layer.path === '/request-draft' && layer.methods.includes('POST'));
  const updateRoute = purchaseRouter.stack.find(layer => layer.path === '/request-draft/:requestId' && layer.methods.includes('PUT'));
  const submitRoute = purchaseRouter.stack.find(layer => layer.path === '/request-draft/:requestId/submit' && layer.methods.includes('POST'));

  assert.deepEqual(saveRoute.stack.map(handler => handler.name), ['saveRequestDraft']);
  assert.deepEqual(updateRoute.stack.map(handler => handler.name), ['updateRequestDraft']);
  assert.deepEqual(submitRoute.stack.map(handler => handler.name), ['submitRequestDraft']);
});

test('采购申请门店库位分配可以展开为入库明细', () => {
  const allocations = purchaseController._test.flattenPurchaseAllocations({
    quantity: 5,
    storeAllocations: [
      {
        storeId: 'STORE_A',
        quantity: 3,
        locationAllocations: [
          { locationId: 'LOC_SALES', quantity: 2 },
          { locationId: 'LOC_DISPLAY', quantity: 1 }
        ]
      },
      {
        storeId: 'STORE_B',
        quantity: 2,
        locationAllocations: [{ locationId: 'LOC_SALES_B', quantity: 2 }]
      }
    ]
  }, 'STORE_DEFAULT');

  assert.deepEqual(allocations, [
    { storeId: 'STORE_A', locationId: 'LOC_SALES', quantity: 2 },
    { storeId: 'STORE_A', locationId: 'LOC_DISPLAY', quantity: 1 },
    { storeId: 'STORE_B', locationId: 'LOC_SALES_B', quantity: 2 }
  ]);
});
