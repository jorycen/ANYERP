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

test('inventory summary only treats the sales warehouse as store stock', () => {
  assert.equal(_test.isSalesWarehouseLocation('normal_qty'), true);
  assert.equal(_test.isSalesWarehouseLocation('display_qty'), false);
  assert.equal(_test.isSalesWarehouseLocation(''), false);

  assert.equal(_test.getSalesWarehouseInventoryQty({ normal_qty: 3 }, 'normal_qty'), 3);
  assert.equal(_test.getSalesWarehouseInventoryQty({ normal_qty: 3 }, 'display_qty'), 0);
  assert.equal(_test.getSalesWarehouseInventoryQty({ normal_qty: 3 }, ''), 0);
});

test('inventory summary only counts in-stock SN in the sales warehouse', () => {
  assert.equal(_test.isInStockSalesWarehouseSn(
    { status: 'in_stock' },
    { type: 'normal_qty' }
  ), true);
  assert.equal(_test.isInStockSalesWarehouseSn(
    { status: 'reserved' },
    { type: 'normal_qty' }
  ), false);
  assert.equal(_test.isInStockSalesWarehouseSn(
    { status: 'in_stock' },
    { type: 'display_qty' }
  ), false);
  assert.equal(_test.isInStockSalesWarehouseSn(
    { status: 'in_stock' },
    null
  ), false);
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

test('inventory summary search includes the real product of an in-stock SN historical PN', () => {
  const conditions = _test.buildInventoryProductKeywordConditions('83NN006LCD', ['PRODUCT_WITH_HISTORICAL_PN']);
  assert.equal(conditions.some(condition => condition.product_id?.[require('sequelize').Op.in]?.includes('PRODUCT_WITH_HISTORICAL_PN')), true);
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

test('inventory summary export keeps only in-stock target categories and sorts them', () => {
  const rows = _test.buildInventorySummaryExportRows([
    { product_id: 'accessory', category: '配件', product_name: '配件', standard_price: 50, normal_qty: 4 },
    { product_id: 'desktop', category: '台式机', product_name: '台机', standard_price: 40, normal_qty: 3 },
    { product_id: 'phone', category: '手机', product_name: '手机', standard_price: 30, normal_qty: 2 },
    { product_id: 'tablet', category: '平板', product_name: '平板', standard_price: 20, normal_qty: 1 },
    { product_id: 'notebook', category: '电子产品/笔记本', product_name: '笔记本', standard_price: 10, normal_qty: 5 },
    { product_id: 'empty', category: '手机', product_name: '无库存手机', standard_price: 60, normal_qty: 0 },
    { product_id: 'other', category: '其他', product_name: '其他商品', standard_price: 70, normal_qty: 6 }
  ], new Map([
    ['accessory', 'PN-A'],
    ['desktop', 'PN-D'],
    ['phone', 'PN-P'],
    ['tablet', 'PN-T'],
    ['notebook', 'PN-N'],
    ['empty', 'PN-E'],
    ['other', 'PN-O']
  ]));

  assert.deepEqual(rows, [
    { 产品名称: '笔记本', PN: 'PN-N', 定价: 10, 库存: 5 },
    { 产品名称: '平板', PN: 'PN-T', 定价: 20, 库存: 1 },
    { 产品名称: '手机', PN: 'PN-P', 定价: 30, 库存: 2 },
    { 产品名称: '台机', PN: 'PN-D', 定价: 40, 库存: 3 },
    { 产品名称: '配件', PN: 'PN-A', 定价: 50, 库存: 4 }
  ]);
});
