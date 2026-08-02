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

function storeContext(body) {
  const value = context('/api/v1/sales/create', 'POST');
  value.request.body = body;
  value.state.user.accessibleStoreIds = ['STORE_A'];
  return value;
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

test('辅助销售人的其他门店归属不应被当作订单操作门店拦截', async () => {
  let called = false;
  await storeAccessMiddleware(storeContext({
    storeId: 'STORE_A',
    auxiliarySalesList: [{ staffId: 'STAFF_B', storeId: 'STORE_B' }]
  }), async () => {
    called = true;
  });
  assert.equal(called, true);
});

test('订单主门店仍必须属于当前账号权限范围', async () => {
  await assert.rejects(
    storeAccessMiddleware(storeContext({
      storeId: 'STORE_B',
      auxiliarySalesList: [{ staffId: 'STAFF_A', storeId: 'STORE_A' }]
    }), async () => {}),
    error => error.status === 403 && error.message === '无权访问该门店'
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
