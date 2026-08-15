const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../src/modules/inventory/controller');

test('inventory summary maps legacy normal quantity to the bound non-sale location', () => {
  const snapshot = _test.getInventoryQuantitySnapshot({
    normal_qty: 2,
    regular_qty: 0,
    subsidy_qty: 0,
    second_qty: 0,
    display_qty: 0,
    demo_qty: 0,
    unsellable_qty: 0,
    pending_qty: 0
  }, 'unsellable_qty');

  assert.equal(snapshot.normal_qty, 0);
  assert.equal(snapshot.unsellable_qty, 2);
});

test('inventory summary keeps standard quantities in their matching location fields', () => {
  const snapshot = _test.getInventoryQuantitySnapshot({
    normal_qty: 0,
    regular_qty: 0,
    subsidy_qty: 0,
    second_qty: 0,
    display_qty: 0,
    demo_qty: 3,
    unsellable_qty: 0,
    pending_qty: 0
  }, 'demo_qty');

  assert.equal(snapshot.normal_qty, 0);
  assert.equal(snapshot.demo_qty, 3);
});

test('inventory summary keeps rental demo stock separate and non-sale', () => {
  const snapshot = _test.getInventoryQuantitySnapshot({
    normal_qty: 0,
    regular_qty: 0,
    subsidy_qty: 0,
    second_qty: 0,
    display_qty: 0,
    demo_qty: 2,
    unsellable_qty: 0,
    pending_qty: 0,
    rental_demo_qty: 4
  }, 'rental_demo_qty');

  assert.equal(snapshot.demo_qty, 0);
  assert.equal(snapshot.rental_demo_qty, 4);
  assert.equal(snapshot.normal_qty, 0);
});

test('inventory summary splits sales stock by resource type', () => {
  const snapshot = _test.getSalesResourceQuantitySnapshot({
    normal_qty: 7,
    regular_qty: 4,
    subsidy_qty: 2,
    second_qty: 1,
    display_qty: 0,
    demo_qty: 0,
    unsellable_qty: 0,
    pending_qty: 0
  }, 'normal_qty');

  assert.deepEqual(snapshot, {
    full_resource_qty: 4,
    subsidy_only_qty: 2,
    no_subsidy_qty: 1
  });
});

test('inventory summary treats legacy unsplit sales stock as full-resource stock', () => {
  const snapshot = _test.getSalesResourceQuantitySnapshot({
    normal_qty: 3,
    regular_qty: 0,
    subsidy_qty: 0,
    second_qty: 0
  }, 'normal_qty');

  assert.deepEqual(snapshot, {
    full_resource_qty: 3,
    subsidy_only_qty: 0,
    no_subsidy_qty: 0
  });
});

test('inventory model quick filters classify the three product types and special prices', () => {
  assert.equal(_test.getInventoryProductType('电脑/笔记本', '', '', ''), 'computer');
  assert.equal(_test.getInventoryProductType('手机', '', '', ''), 'phone');
  assert.equal(_test.getInventoryProductType('平板', '', '', ''), 'tablet');
  assert.equal(_test.isSpecialPriceProduct({
    ProductPrice: { standard_price: 5000, retail_price: 4500 }
  }), true);
  assert.equal(_test.isSpecialPriceProduct({
    ProductPrice: { standard_price: 5000, retail_price: 5000 }
  }), false);
  assert.equal(_test.matchesInventoryModelFilter({}, { special_sn_count: 2 }, 'special'), true);
  assert.equal(_test.matchesInventoryModelFilter({
    ProductPrice: { standard_price: 5000, retail_price: 4500 }
  }, { special_sn_count: 0 }, 'special'), false);
});

test('inventory model quick filters sort hot and high-margin models by the latest seven days', () => {
  const rows = [
    { sales_7_qty: 2, gross_margin_7: 0.3, gross_profit_7: 300, avg_gross_profit_7: 300 },
    { sales_7_qty: 5, gross_margin_7: 0.2, gross_profit_7: 400, avg_gross_profit_7: 200 }
  ];
  assert.equal(_test.compareInventoryModelRows(rows[1], rows[0], 'hot7') < 0, true);
  assert.equal(_test.compareInventoryModelRows(rows[0], rows[1], 'highMargin7') < 0, true);
  assert.equal(_test.matchesInventoryModelFilter({ is_focus_product: 1 }, {}, 'focus'), true);
  assert.equal(_test.matchesInventoryModelFilter({}, { sales_7_qty: 0 }, 'hot7'), false);
  assert.equal(_test.matchesInventoryModelFilter({}, { avg_gross_profit_7: 0 }, 'highMargin7'), false);
});

test('inventory export expands one product into store rows and keeps store-specific quantities', () => {
  const rows = _test.buildStoreInventoryExportRows([{
    product_name: '测试商品',
    total_stock_qty: 5,
    store_stock_info: [
      { store_id: 'S2', store_name: '重庆门店', normal_qty: 2, display_qty: 1 },
      { store_id: 'S1', store_name: '成都门店', normal_qty: 3, display_qty: 0 }
    ]
  }]);

  assert.deepEqual(rows.map(row => [row.store_name, row.normal_qty, row.total_stock_qty]), [
    ['成都门店', 3, 5],
    ['重庆门店', 2, 5]
  ]);
});
