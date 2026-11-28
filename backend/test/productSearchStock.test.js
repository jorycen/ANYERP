const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../src/modules/product/controller');

test('serialized product search stock uses in-stock sales warehouse SN count', () => {
  const stockMap = {
    productA: {
      current: 0,
      other: 2,
      total: 2,
      stores: [{ store_id: 'store-old', store_name: '历史门店', normal_qty: 2 }],
      currentStore: null,
      otherStores: []
    }
  };

  _test.applySerializedSalesStock(
    stockMap,
    ['productA', 'productB'],
    [
      { product_id: 'productA', store_id: 'store-current' },
      { product_id: 'productA', store_id: 'store-other' }
    ],
    new Map([
      ['store-current', '当前门店'],
      ['store-other', '其他门店']
    ]),
    'store-current'
  );

  assert.equal(stockMap.productA.current, 1);
  assert.equal(stockMap.productA.other, 1);
  assert.equal(stockMap.productA.total, 2);
  assert.equal(stockMap.productA.currentStore.store_name, '当前门店');
  assert.equal(stockMap.productB.total, 0);
  assert.deepEqual(stockMap.productB.stores, []);
});
