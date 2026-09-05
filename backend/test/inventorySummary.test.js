const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../src/modules/inventory/controller');
const salesController = require('../src/modules/sales/controller');

test('SN销售仓明细保留非销售仓数量，不重复计入销售余额', () => {
  const fields = ['display_qty', 'demo_qty', 'unsellable_qty', 'pending_qty', 'rental_demo_qty'];
  const inventory = [
    { store_id: 'A', location_id: 'sale', normal_qty: 99 },
    ...fields.map(field => ({ store_id: 'A', location_id: field, [field]: 1, normal_qty: 0 }))
  ];
  const rows = _test.mergeSnSalesStockBreakdown(inventory,
    [{ store_id: 'A', location_id: 'sale', normal_qty: 24, full_resource_qty: 24 }]);
  assert.equal(rows.reduce((sum, row) => sum + Number(row.normal_qty || 0), 0), 24);
  for (const field of fields) {
    assert.equal(rows.reduce((sum, row) => sum + Number(row[field] || 0), 0), 1);
  }
  assert.equal(inventory[0].normal_qty, 99);
});

test('没有销售SN时保留样品明细并清除陈旧销售明细', () => {
  const rows = _test.mergeSnSalesStockBreakdown([
    { store_id: 'A', location_id: '', normal_qty: 9, full_resource_qty: 9, demo_qty: 1 },
    { store_id: 'A', location_id: 'sale', normal_qty: 10 }
  ], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].demo_qty, 1);
  assert.equal(rows[0].normal_qty, 0);
  assert.equal(rows[0].full_resource_qty, 0);
});

test('销售退单库存控制器可以调用正式定金释放函数', () => {
  assert.equal(typeof salesController.releaseDepositRedemptionForOrder, 'function');
});

test('销售退单只有整单完成退货后才恢复定金核销', async () => {
  const calls = [];
  const release = async (...args) => calls.push(args);

  assert.equal(await _test.restoreDepositForCompletedSalesReturn(
    { order_id: 'ORDER-1' },
    false,
    { id: 'TX-1' },
    release
  ), false);
  assert.equal(calls.length, 0);

  assert.equal(await _test.restoreDepositForCompletedSalesReturn(
    { order_id: 'ORDER-1' },
    true,
    { id: 'TX-2' },
    release
  ), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].order_id, 'ORDER-1');
  assert.equal(calls[0][1].id, 'TX-2');
  assert.equal(calls[0][2], '销售退单整单退货，恢复定金');
});

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

test('导出当前门店库存合计五类仓库，排除样品仓和资源分类重复数量', () => {
  const rows = _test.buildStoreInventoryExportRows([{
    total_stock_qty: 10,
    store_stock_info: [
      { store_id: 'A', normal_qty: '2', full_resource_qty: 2, demo_qty: 100 },
      { store_id: 'A', normal_qty: 3, subsidy_only_qty: 3, display_qty: '4' },
      { store_id: 'A', unsellable_qty: 5, pending_qty: 6, rental_demo_qty: 7 },
      { store_id: 'B', normal_qty: 5 },
      { store_id: 'C', demo_qty: 9 }
    ]
  }]);
  assert.equal(rows.find(row => row.store_id === 'A').current_store_stock_qty, 27);
  assert.equal(rows.find(row => row.store_id === 'A').normal_qty, 5);
  assert.equal(rows.find(row => row.store_id === 'A').demo_qty, 100);
  assert.equal(rows.find(row => row.store_id === 'B').current_store_stock_qty, 5);
  assert.equal(rows.find(row => row.store_id === 'C').current_store_stock_qty, 0);
});

test('inventory summary uses serialized stock projection for SN products', () => {
  assert.equal(_test.getSummaryNormalQty({ need_sn: 1 }, { normal_qty: 10 }, { total: 7 }), 7);
  assert.equal(_test.getSummaryNormalQty({ need_sn: 0 }, { normal_qty: 10 }, { total: 7 }), 10);
});
