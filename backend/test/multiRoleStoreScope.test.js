const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const scope = require('../src/utils/storePermissions');

test('ordinary roles share explicit stores; empty grants do not expand; boss remains global', async () => {
  const original = [M.StaffStorePermission.findAll, M.StaffDistributorPermission.findAll];
  let rows = [{ store_id: 'S1' }, { store_id: 'S1' }];
  M.StaffDistributorPermission.findAll = async () => [{ distributor_id: 'D1' }];
  M.StaffStorePermission.findAll = async options => {
    assert.equal(options.include[0].required, true);
    assert.ok(options.include[0].where.distributor_id);
    return rows;
  };
  try {
    for (const roles of [['clerk'], ['business', 'purchaser'], ['purchaser', 'business'], ['admin', 'clerk']]) {
      assert.deepEqual(await scope.resolveAccessibleStoreIds({ staff_id: 1, store_id: 'OLD' }, roles), ['S1']);
    }
    rows = [];
    assert.deepEqual(await scope.resolveAccessibleStoreIds({ staff_id: 1, store_id: 'OLD' }, ['business']), []);
    assert.deepEqual(await scope.resolveAccessibleStoreIds({ staff_id: 1 }, ['boss', 'clerk']), ['*']);
  } finally {
    [M.StaffStorePermission.findAll, M.StaffDistributorPermission.findAll] = original;
    await M.sequelize.close();
  }
});
