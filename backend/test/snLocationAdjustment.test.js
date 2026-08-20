const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../src/modules/inventory/controller');

const baseSn = {
  sn_id: 'SN_1',
  store_id: 'STORE_1',
  status: 'in_stock'
};

const baseLocation = {
  location_id: 'LOC_2',
  store_id: 'STORE_1',
  status: 1
};

test('同门店在库SN可以调整到启用库位', () => {
  assert.equal(_test.validateSnLocationAdjustment({
    sn: baseSn,
    storeId: 'STORE_1',
    locationId: 'LOC_2',
    targetLocation: baseLocation
  }), null);
});

test('SN库位调整禁止跨门店、非在库和无效库位', () => {
  assert.deepEqual(
    _test.validateSnLocationAdjustment({
      sn: baseSn,
      storeId: 'STORE_2',
      locationId: 'LOC_2',
      targetLocation: baseLocation
    }),
    { status: 403, message: '只能调整SN所在门店的库位' }
  );

  assert.deepEqual(
    _test.validateSnLocationAdjustment({
      sn: { ...baseSn, status: 'sold' },
      storeId: 'STORE_1',
      locationId: 'LOC_2',
      targetLocation: baseLocation
    }),
    { status: 409, message: '只有在库SN可以调整库位' }
  );

  assert.deepEqual(
    _test.validateSnLocationAdjustment({
      sn: baseSn,
      storeId: 'STORE_1',
      locationId: 'LOC_DISABLED',
      targetLocation: null
    }),
    { status: 400, message: '目标库位不存在、已停用或不属于当前门店' }
  );
});

test('SN库位调整同步使用目标库位的库存类型', () => {
  assert.deepEqual(
    _test.getSnInventoryMoveFields('demo_qty', 'demo_qty'),
    ['demo_qty', 'normal_qty', 'regular_qty', 'subsidy_qty', 'second_qty']
  );
  assert.deepEqual(
    _test.getSnInventoryMoveFields('normal_qty', 'demo_qty'),
    ['normal_qty', 'regular_qty', 'subsidy_qty', 'second_qty']
  );
  assert.equal(_test.normalizeInventoryQuantityField('unknown'), 'normal_qty');
});
