const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveInventoryWriteLocation } = require('../src/utils/inventoryLocation');

test('旧流程未传库位时按库存类型选择本门店有效标准仓', async () => {
  for (const field of ['normal_qty', 'demo_qty', 'display_qty', 'pending_qty', 'unsellable_qty', 'rental_demo_qty', 'regular_qty', 'subsidy_qty', 'second_qty']) {
    const transaction = {};
    const Location = { findOne: async options => {
      assert.equal(options.where.store_id, 'store');
      assert.equal(options.where.status, 1);
      assert.equal(options.where.type, ['regular_qty', 'subsidy_qty', 'second_qty'].includes(field) ? 'normal_qty' : field);
      assert.equal(options.transaction, transaction);
      return { location_id: 'valid-location' };
    } };
    assert.equal(await resolveInventoryWriteLocation(Location, { storeId: 'store', field, transaction }), 'valid-location');
  }
});

test('显式库位验证门店和启用状态，失效库位不静默改仓', async () => {
  const Location = { findOne: async ({ where }) => {
    assert.deepEqual(where, { store_id: 'store', status: 1, location_id: 'wrong-location' });
    return null;
  } };
  await assert.rejects(resolveInventoryWriteLocation(Location, {
    storeId: 'store', field: 'normal_qty', locationId: 'wrong-location'
  }), { status: 400 });
});

test('缺少标准库位时拒绝增加库存', async () => {
  await assert.rejects(resolveInventoryWriteLocation({ findOne: async () => null }, {
    storeId: 'store', field: 'normal_qty', locationId: ' '
  }), { status: 400 });
});
