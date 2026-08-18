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
    inventoryFindOne: models.Inventory.findOne,
    inventoryFindAll: models.Inventory.findAll,
    locationFindAll: models.Location.findAll
  };
  const item = buildOrderItem();
  buildOrderItem.item = item;
  const inv = {
    product_id: 'PRODUCT_1',
    store_id: 'STORE_1',
    location_id: 'LOCATION_SALES',
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
  models.Inventory.findOne = async () => inventory === false ? null : inv;
  models.Inventory.findAll = async () => inventory === false ? [] : [inv];
  models.Location.findAll = async () => [{ location_id: 'LOCATION_SALES', type: 'normal_qty', status: 1 }];

  try {
    await callback({ order_id: 'ORDER_1', store_id: 'STORE_1' });
  } finally {
    models.OrderItem.findAll = originals.itemFindAll;
    models.ProductPn.findAll = originals.pnFindAll;
    models.Product.findAll = originals.productFindAll;
    models.Inventory.findOne = originals.inventoryFindOne;
    models.Inventory.findAll = originals.inventoryFindAll;
    models.Location.findAll = originals.locationFindAll;
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

test('归档汇总同门店多库位库存，不因读取到零库存行而误报库存不足', async () => {
  const originals = {
    itemFindAll: models.OrderItem.findAll,
    pnFindAll: models.ProductPn.findAll,
    productFindAll: models.Product.findAll,
    inventoryFindAll: models.Inventory.findAll,
    locationFindAll: models.Location.findAll
  };
  const item = buildOrderItem.item = buildOrderItem();
  const zeroStockRow = {
    inventory_id: 'INV_EMPTY',
    product_id: 'PRODUCT_1',
    store_id: 'STORE_1',
    location_id: 'LOCATION_EMPTY',
    normal_qty: 0,
    display_qty: 0,
    pending_qty: 0,
    regular_qty: 0,
    subsidy_qty: 0,
    second_qty: 0,
    update: async values => Object.assign(zeroStockRow, values)
  };
  const sellableRow = {
    inventory_id: 'INV_SELLABLE',
    product_id: 'PRODUCT_1',
    store_id: 'STORE_1',
    location_id: 'LOCATION_SALES',
    normal_qty: 1,
    display_qty: 0,
    pending_qty: 0,
    regular_qty: 0,
    subsidy_qty: 0,
    second_qty: 0,
    update: async values => Object.assign(sellableRow, values)
  };

  models.OrderItem.findAll = async () => [item];
  models.ProductPn.findAll = async () => [{ product_id: 'PRODUCT_1', pn_code: '870017165', status: 1, is_deleted: 0 }];
  models.Product.findAll = async () => [{ product_id: 'PRODUCT_1', name: '测试商品', need_sn: 0 }];
  models.Inventory.findAll = async () => [zeroStockRow, sellableRow];
  models.Location.findAll = async () => [
    { location_id: 'LOCATION_EMPTY', type: 'normal_qty', status: 1 },
    { location_id: 'LOCATION_SALES', type: 'normal_qty', status: 1 }
  ];

  try {
    await salesController._test.validateAndDeductInventoryForArchive({ order_id: 'ORDER_1', store_id: 'STORE_1' });
    assert.equal(zeroStockRow.normal_qty, 0);
    assert.equal(sellableRow.normal_qty, 0);
  } finally {
    models.OrderItem.findAll = originals.itemFindAll;
    models.ProductPn.findAll = originals.pnFindAll;
    models.Product.findAll = originals.productFindAll;
    models.Inventory.findAll = originals.inventoryFindAll;
    models.Location.findAll = originals.locationFindAll;
  }
});

test('归档只统计销售仓库存，不把铺货仓或占用库存当作可售库存', async () => {
  const originals = {
    itemFindAll: models.OrderItem.findAll,
    pnFindAll: models.ProductPn.findAll,
    productFindAll: models.Product.findAll,
    inventoryFindAll: models.Inventory.findAll,
    locationFindAll: models.Location.findAll
  };
  const item = buildOrderItem.item = buildOrderItem();
  const displayRow = {
    inventory_id: 'INV_DISPLAY',
    product_id: 'PRODUCT_1',
    store_id: 'STORE_1',
    location_id: 'LOCATION_DISPLAY',
    normal_qty: 0,
    display_qty: 1,
    pending_qty: 0,
    regular_qty: 0,
    subsidy_qty: 0,
    second_qty: 0,
    update: async values => Object.assign(displayRow, values)
  };
  const pendingRow = {
    inventory_id: 'INV_PENDING',
    product_id: 'PRODUCT_1',
    store_id: 'STORE_1',
    location_id: 'LOCATION_SALES',
    normal_qty: 0,
    display_qty: 0,
    pending_qty: 1,
    regular_qty: 0,
    subsidy_qty: 0,
    second_qty: 0,
    update: async values => Object.assign(pendingRow, values)
  };

  models.OrderItem.findAll = async () => [item];
  models.ProductPn.findAll = async () => [{ product_id: 'PRODUCT_1', pn_code: '870017165', status: 1, is_deleted: 0 }];
  models.Product.findAll = async () => [{ product_id: 'PRODUCT_1', name: '测试商品', need_sn: 0 }];
  models.Inventory.findAll = async () => [displayRow, pendingRow];
  models.Location.findAll = async () => [
    { location_id: 'LOCATION_DISPLAY', type: 'display_qty', status: 1 },
    { location_id: 'LOCATION_SALES', type: 'normal_qty', status: 1 }
  ];

  try {
    await assert.rejects(
      salesController._test.validateAndDeductInventoryForArchive({ order_id: 'ORDER_1', store_id: 'STORE_1' }),
      error => error.message === '商品 测试商品 库存不足(可用:0, 需要:1)，不能归档'
    );
    assert.equal(displayRow.display_qty, 1);
    assert.equal(pendingRow.pending_qty, 1);
  } finally {
    models.OrderItem.findAll = originals.itemFindAll;
    models.ProductPn.findAll = originals.pnFindAll;
    models.Product.findAll = originals.productFindAll;
    models.Inventory.findAll = originals.inventoryFindAll;
    models.Location.findAll = originals.locationFindAll;
  }
});

test('SN商品位于非销售仓时禁止归档销售', async () => {
  const originals = {
    itemFindAll: models.OrderItem.findAll,
    pnFindAll: models.ProductPn.findAll,
    productFindAll: models.Product.findAll,
    productSnFindOne: models.ProductSn.findOne,
    locationFindByPk: models.Location.findByPk
  };
  const item = buildOrderItem({ sn_code: 'SN_DISPLAY_1' });
  buildOrderItem.item = item;
  const snRecord = {
    sn_id: 'SN_ID_1',
    sn_code: 'SN_DISPLAY_1',
    pn_code: '870017165',
    inventory_type: 'display_qty',
    location_id: 'LOCATION_DISPLAY',
    status: 'in_stock',
    update: async values => Object.assign(snRecord, values)
  };

  models.OrderItem.findAll = async () => [item];
  models.ProductPn.findAll = async () => [{ product_id: 'PRODUCT_1', pn_code: '870017165', status: 1, is_deleted: 0 }];
  models.Product.findAll = async () => [{ product_id: 'PRODUCT_1', name: '测试SN商品', need_sn: 1 }];
  models.ProductSn.findOne = async () => snRecord;
  models.Location.findByPk = async () => ({ location_id: 'LOCATION_DISPLAY', type: 'display_qty', status: 1 });

  try {
    await assert.rejects(
      salesController._test.validateAndDeductInventoryForArchive({ order_id: 'ORDER_1', store_id: 'STORE_1' }),
      error => error.message === 'SN码 [SN_DISPLAY_1] 不在销售仓，不允许直接销售'
    );
  } finally {
    models.OrderItem.findAll = originals.itemFindAll;
    models.ProductPn.findAll = originals.pnFindAll;
    models.Product.findAll = originals.productFindAll;
    models.ProductSn.findOne = originals.productSnFindOne;
    models.Location.findByPk = originals.locationFindByPk;
  }
});
