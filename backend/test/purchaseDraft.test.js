const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const purchaseRouter = require('../src/modules/purchase/routes');
const purchaseController = require('../src/modules/purchase/controller');

const purchaseControllerSource = fs.readFileSync(
  path.join(__dirname, '../src/modules/purchase/controller.js'),
  'utf8'
);

test('采购申请草稿提供保存、编辑和提交接口', () => {
  const saveRoute = purchaseRouter.stack.find(layer => layer.path === '/request-draft' && layer.methods.includes('POST'));
  const updateRoute = purchaseRouter.stack.find(layer => layer.path === '/request-draft/:requestId' && layer.methods.includes('PUT'));
  const submitRoute = purchaseRouter.stack.find(layer => layer.path === '/request-draft/:requestId/submit' && layer.methods.includes('POST'));
  const deleteRoute = purchaseRouter.stack.find(layer => layer.path === '/request-draft/:requestId' && layer.methods.includes('DELETE'));

  assert.deepEqual(saveRoute.stack.map(handler => handler.name), ['saveRequestDraft']);
  assert.deepEqual(updateRoute.stack.map(handler => handler.name), ['updateRequestDraft']);
  assert.deepEqual(submitRoute.stack.map(handler => handler.name), ['submitRequestDraft']);
  assert.deepEqual(deleteRoute.stack.map(handler => handler.name), ['deleteRequestDraft']);
});

test('采购审批禁止没有明细的空采购申请', () => {
  assert.match(
    purchaseControllerSource,
    /status === 'approved' && \(!request\.items \|\| request\.items\.length === 0\)/
  );
  assert.match(purchaseControllerSource, /缺少商品明细，无法审批通过/);
  assert.match(purchaseControllerSource, /isUsablePnCode/);
  assert.match(purchaseControllerSource, /勾选审批完成及入库时必须填写PN码/);
  assert.match(
    purchaseControllerSource,
    /const items = request\.items\.map\(item => \(\{[\s\S]*?pnCode: item\.pn_code,[\s\S]*?assertUsedProductDirectInbound\(ctx, item\)/
  );
  assert.match(purchaseControllerSource, /await sequelize\.transaction\(async transaction =>/);
  assert.match(purchaseControllerSource, /PurchaseRequestItem\.create\([\s\S]*?\{ transaction \}\)/);
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

test('采购退单后采购订单展示当前有效金额但保留原始金额', () => {
  const request = {
    total_amount: 1000,
    rebate_deduction: 100,
    actual_total: 900
  };
  purchaseController._test.attachCurrentPurchaseAmounts(request, [{
    total_amount_delta: -180,
    items: [{ quantity_delta: -2, unit_price: 100, amount_delta: -180 }]
  }]);

  assert.equal(request.original_total_amount, 1000);
  assert.equal(request.current_total_amount, 800);
  assert.equal(request.current_rebate_deduction, 80);
  assert.equal(request.current_actual_total, 720);
});
