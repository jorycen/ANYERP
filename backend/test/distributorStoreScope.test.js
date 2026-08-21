const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isStoreScopedAccount,
  isStoreManagerAccount,
  resolveReportStoreIds,
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

test('店长报表跨门店范围识别兼容历史和当前角色编码', () => {
  assert.equal(isStoreManagerAccount(['manager']), true);
  assert.equal(isStoreManagerAccount(['store_manager']), true);
  assert.equal(isStoreManagerAccount(['manager', 'finance']), true);
  assert.equal(isStoreManagerAccount(['clerk']), false);
});

test('经营报表恢复为账号已配置的门店范围', async () => {
  assert.deepEqual(
    await resolveReportStoreIds({ roles: ['manager'], accessibleStoreIds: ['STORE_1'] }),
    ['STORE_1']
  );
  assert.deepEqual(
    await resolveReportStoreIds({ roles: ['staff'], accessibleStoreIds: ['STORE_2'] }),
    ['STORE_2']
  );
  assert.deepEqual(
    await resolveReportStoreIds({ roles: ['boss'], accessibleStoreIds: [] }),
    ['*']
  );
});
