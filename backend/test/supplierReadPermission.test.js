const test = require('node:test');
const assert = require('node:assert/strict');
const { storeAccessMiddleware } = require('../src/middleware/auth');
const purchaseRouter = require('../src/modules/purchase/routes');

function context(path, method = 'GET') {
  return {
    path,
    method,
    query: {},
    request: { body: {} },
    state: {
      user: {
        roles: ['clerk'],
        accessibleStoreIds: []
      }
    },
    throw(status, message) {
      const error = new Error(message);
      error.status = status;
      throw error;
    }
  };
}

test('supplier reads do not require a store assignment', async () => {
  let called = false;
  await storeAccessMiddleware(context('/api/v1/purchase/supplier-list'), async () => {
    called = true;
  });
  assert.equal(called, true);
});

test('other purchase reads still require a store assignment', async () => {
  await assert.rejects(
    storeAccessMiddleware(context('/api/v1/purchase/request-list'), async () => {}),
    error => error.status === 403
  );
});

test('purchase request query and submission do not require purchaser role', () => {
  const requestListRoute = purchaseRouter.stack.find(layer => layer.path === '/request-list');
  const createRequestRoute = purchaseRouter.stack.find(layer => layer.path === '/create-request');
  assert.deepEqual(requestListRoute.stack.map(handler => handler.name), ['getRequestList']);
  assert.deepEqual(createRequestRoute.stack.map(handler => handler.name), ['createRequest']);
});

test('purchase approval and supplier maintenance still require purchaser role', () => {
  const approveRoute = purchaseRouter.stack.find(layer => layer.path === '/approve-request/:requestId');
  const createSupplierRoute = purchaseRouter.stack.find(layer => layer.path === '/supplier' && layer.methods.includes('POST'));
  assert.equal(approveRoute.stack.length, 2);
  assert.equal(createSupplierRoute.stack.length, 2);
});
