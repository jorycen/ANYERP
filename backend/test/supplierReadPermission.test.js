const test = require('node:test');
const assert = require('node:assert/strict');
const { storeAccessMiddleware } = require('../src/middleware/auth');

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
