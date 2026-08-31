const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isStoreScopedAccount,
  isStoreManagerAccount,
  resolveAllReadableStoreIds,
  resolveReportStoreIds,
  resolvePrimaryStoreId
} = require('../src/utils/storePermissions');
const { Store } = require('../src/models');

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
  assert.equal(isStoreManagerAccount(['store_admin']), true);
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

test('库存只读范围按经销商展开，不受店长主门店限制', async () => {
  const originalFindAll = Store.findAll;
  let query;
  Store.findAll = async options => {
    query = options;
    return [{ store_id: 'STORE_1' }, { store_id: 'STORE_2' }];
  };
  try {
    assert.deepEqual(
      await resolveAllReadableStoreIds({
        roles: ['manager'],
        accessibleStoreIds: ['STORE_1'],
        accessibleDistributorIds: ['DIST_1']
      }),
      ['STORE_1', 'STORE_2']
    );
    assert.deepEqual(query.where.distributor_id[require('sequelize').Op.in], ['DIST_1']);
  } finally {
    Store.findAll = originalFindAll;
  }
});
