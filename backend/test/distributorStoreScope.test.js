const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isStoreScopedAccount,
  resolvePrimaryStoreId
} = require('../src/utils/storePermissions');

test('经销商级账号不再拥有当前门店语义', () => {
  assert.equal(isStoreScopedAccount(['admin']), false);
  assert.equal(isStoreScopedAccount(['finance']), false);
  assert.equal(isStoreScopedAccount(['admin', 'manager']), false);
  assert.equal(resolvePrimaryStoreId({ store_id: 'STORE_1' }, ['STORE_1', 'STORE_2']), 'STORE_1');
});

test('纯门店账号继续使用主门店语义', () => {
  assert.equal(isStoreScopedAccount(['clerk']), true);
  assert.equal(isStoreScopedAccount(['manager']), true);
  assert.equal(isStoreScopedAccount(['store_manager']), true);
  assert.equal(resolvePrimaryStoreId({ store_id: 'STORE_1' }, ['STORE_2', 'STORE_1']), 'STORE_1');
});
