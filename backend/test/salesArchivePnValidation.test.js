const test = require('node:test');
const assert = require('node:assert/strict');
const models = require('../src/models');
const salesController = require('../src/modules/sales/controller');

function buildOrderItem(overrides = {}) {
  return {
    item_id: 'ITEM_1',
    product_id: 'PRODUCT_1',
    product_name: '测试商品',
    pn_code: '870017165',
    sn_code: '',
    quantity: 1,
    update: async values => Object.assign(buildOrderItem.item, values),
    ...overrides
  };
}

async function withArchiveStubs({ pnRows, products, inventory }, callback) {
  const originals = {
    itemFindAll: models.OrderItem.findAll,
    pnFindAll: models.ProductPn.findAll,
    productFindAll: models.Product.findAll,
    inventoryFindAll: models.Inventory.findAll
  };
  const item = buildOrderItem();
  buildOrderItem.item = item;
  const inv = {
    product_id: 'PRODUCT_1',
    store_id: 'STORE_1',
    normal_qty: 1,
    regular_qty: 0,
    subsidy_qty: 0,
    second_qty: 0,
    display_qty: 0,
    pending_qty: 0,
    update: async values => Object.assign(inv, values)
  };

  models.OrderItem.findAll = async () => [item];
  models.ProductPn.findAll = async () => pnRows;
  models.Product.findAll = async () => products;
  models.Inventory.findAll = async () => {
    if (inventory === false) return [];
    if (Array.isArray(inventory)) return inventory;
    return [inventory || inv];
  };

  try {
    await callback({ order_id: 'ORDER_1', store_id: 'STORE_1' });
  } finally {
    models.OrderItem.findAll = originals.itemFindAll;
    models.ProductPn.findAll = originals.pnFindAll;
    models.Product.findAll = originals.productFindAll;
    models.Inventory.findAll = originals.inventoryFindAll;
  }
}

test('归档要求PN主数据存在，不再使用manufacturer_code兜底', async () => {
  await withArchiveStubs({
    pnRows: [],
    products: [{ product_id: 'PRODUCT_1', name: '测试商品', need_sn: 0 }]
  }, async order => {
    await assert.rejects(
      salesController._test.validateAndDeductInventoryForArchive(order),
      error => error.message === 'PN码 [870017165] 不存在，不能归档'
    );
  });
});

test('归档PN比较忽略字符串类型和空格，但仍要求商品关联一致', async () => {
  await withArchiveStubs({
    pnRows: [{ product_id: 'PRODUCT_1', pn_code: '87 001 7165', status: 1, is_deleted: 0 }],
    products: [{ product_id: 'PRODUCT_1', name: '测试商品', need_sn: 0 }]
  }, async order => {
    await salesController._test.validateAndDeductInventoryForArchive(order);
  });

  await withArchiveStubs({
    pnRows: [{ product_id: 'PRODUCT_2', pn_code: '870017165', status: 1, is_deleted: 0 }],
    products: [{ product_id: 'PRODUCT_1', name: '测试商品', need_sn: 0 }]
  }, async order => {
    await assert.rejects(
      salesController._test.validateAndDeductInventoryForArchive(order),
      error => error.message === 'PN码 [870017165] 与订单商品不匹配，不能归档'
    );
  });
});

test('归档按同门店多个库位汇总非SN库存，不会只读取空库存行', async () => {
  const emptyLocationRow = {
    product_id: 'PRODUCT_1',
    store_id: 'STORE_1',
    location_id: 'LOCATION_EMPTY',
    normal_qty: 0,
    regular_qty: 0,
    subsidy_qty: 0,
    second_qty: 0,
    display_qty: 0,
    pending_qty: 0,
    update: async values => Object.assign(emptyLocationRow, values)
  };
  const stockedLocationRow = {
    product_id: 'PRODUCT_1',
    store_id: 'STORE_1',
    location_id: 'LOCATION_SALES',
    normal_qty: 1,
    regular_qty: 0,
    subsidy_qty: 0,
    second_qty: 0,
    display_qty: 0,
    pending_qty: 0,
    update: async values => Object.assign(stockedLocationRow, values)
  };

  await withArchiveStubs({
    pnRows: [{ product_id: 'PRODUCT_1', pn_code: '870017165', status: 1, is_deleted: 0 }],
    products: [{ product_id: 'PRODUCT_1', name: '测试商品', need_sn: 0 }],
    inventory: [emptyLocationRow, stockedLocationRow]
  }, async order => {
    await salesController._test.validateAndDeductInventoryForArchive(order);
  });

  assert.equal(emptyLocationRow.normal_qty, 0);
  assert.equal(stockedLocationRow.normal_qty, 0);
});
