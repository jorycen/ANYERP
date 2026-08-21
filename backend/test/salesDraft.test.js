const test = require('node:test');
const assert = require('node:assert/strict');
const salesRouter = require('../src/modules/sales/routes');
const salesController = require('../src/modules/sales/controller');

test('销售订单草稿提供保存、编辑、提交和删除接口', () => {
  const saveRoute = salesRouter.stack.find(layer => layer.path === '/draft' && layer.methods.includes('POST'));
  const updateRoute = salesRouter.stack.find(layer => layer.path === '/draft/:orderId' && layer.methods.includes('PUT'));
  const submitRoute = salesRouter.stack.find(layer => layer.path === '/draft/:orderId/submit' && layer.methods.includes('POST'));
  const deleteRoute = salesRouter.stack.find(layer => layer.path === '/draft/:orderId' && layer.methods.includes('DELETE'));

  assert.ok(saveRoute);
  assert.ok(updateRoute);
  assert.ok(submitRoute);
  assert.ok(deleteRoute);
  assert.equal(typeof salesController.saveSalesDraft, 'function');
  assert.equal(typeof salesController.updateSalesDraft, 'function');
  assert.equal(typeof salesController.submitSalesDraft, 'function');
  assert.equal(typeof salesController.deleteSalesDraft, 'function');
});

test('product order lookup is a distributor-scoped read-only endpoint', () => {
  const route = salesRouter.stack.find(
    layer => layer.path === '/product-orders/:productId' && layer.methods.includes('GET')
  );

  assert.ok(route);
  assert.equal(typeof salesController.listProductOrders, 'function');
});
