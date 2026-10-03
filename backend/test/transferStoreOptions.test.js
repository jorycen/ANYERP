const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { Store } = require('../src/models');
const { getTransferStores } = require('../src/modules/store/controller');

test('双经销商权限的调拨门店候选覆盖全部经销商门店', async () => {
  const originalFindAll = Store.findAll;
  let query;
  Store.findAll = async options => {
    query = options;
    return [];
  };

  try {
    await getTransferStores({
      state: {
        user: {
          roles: ['admin'],
          distributorId: 'AINO_CLOUD',
          accessibleDistributorIds: ['AINO_CLOUD', 'AINO_ZHIXING'],
          accessibleStoreIds: []
        }
      },
      body: {},
      query: {}
    });

    assert.deepEqual(query.where.distributor_id[Op.in], ['AINO_CLOUD', 'AINO_ZHIXING']);
  } finally {
    Store.findAll = originalFindAll;
  }
});
