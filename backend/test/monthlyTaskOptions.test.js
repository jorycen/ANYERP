const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');

const models = require('../src/models');
const storePermissions = require('../src/utils/storePermissions');

test('月度任务选项接口必须写入 Koa ctx.body，不能返回空响应形成 404', async () => {
  mock.method(storePermissions, 'resolveAllReadableStoreIds', async () => ['store-1']);
  mock.method(models.Store, 'findAll', async options => {
    if (options.attributes?.length === 1) return [{ store_id: 'store-1' }];
    return [{ store_id: 'store-1', name: '测试门店' }];
  });
  mock.method(models.Staff, 'findAll', async () => [{ staff_id: 1, name: '测试员工', store_id: 'store-1' }]);
  mock.method(models.StaffStorePermission, 'findAll', async () => [{ staff_id: 1, store_id: 'store-1' }]);
  mock.method(models.Product, 'findAll', async () => [{ product_id: 'product-1', product_code: 'P001', name: '测试商品' }]);

  const modulePath = require.resolve('../src/modules/sales/monthlyTaskController');
  delete require.cache[modulePath];
  const { getMonthlyTaskOptions } = require(modulePath);
  const ctx = { state: { user: { roles: ['admin'], distributorId: 'distributor-1' } } };

  await getMonthlyTaskOptions(ctx);

  assert.deepEqual(ctx.body, {
    code: 0,
    data: {
      stores: [{ storeId: 'store-1', name: '测试门店' }],
      staff: [{ staffId: '1', name: '测试员工', storeId: 'store-1', storeIds: ['store-1'] }],
      products: [{ productId: 'product-1', productCode: 'P001', name: '测试商品' }]
    }
  });
});
