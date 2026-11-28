const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const models = require('../src/models');
const inventoryController = require('../src/modules/inventory/controller');
const salesController = require('../src/modules/sales/controller');
const { getEffectiveSnSalePrice } = require('../../utils/model');

const {
  calculateStockAgeDays,
  resolveOriginalInboundTime,
  resolveEffectiveSalePrice,
  canManageDistributorPrice
} = inventoryController._test;

test('SN特价优先于统一售价且不随统一调价变化', () => {
  assert.equal(resolveEffectiveSalePrice(6999, 6299), 6299);
  assert.equal(resolveEffectiveSalePrice(7299, 6299), 6299);
  assert.equal(resolveEffectiveSalePrice(7299, null), 7299);
});

test('前端选中SN时使用接口返回的当前适用售价', () => {
  assert.equal(getEffectiveSnSalePrice({ effective_sale_price: 7000, unified_sale_price: 8499 }), 7000);
  assert.equal(getEffectiveSnSalePrice({ special_price: 7000, unified_sale_price: 8499 }), 7000);
  assert.equal(getEffectiveSnSalePrice({ unified_sale_price: 8499 }), 8499);
});

test('SN库龄按完整自然日向下取整，缺少入库时间返回未知', () => {
  const now = new Date('2026-07-06T12:00:00.000Z');
  assert.equal(calculateStockAgeDays('2026-07-01T11:59:59.000Z', now), 5);
  assert.equal(calculateStockAgeDays(null, now), null);
});

test('SN库龄优先使用公司首次采购入库时间，兼容历史记录回退入库时间', () => {
  assert.equal(
    resolveOriginalInboundTime('2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
    '2026-07-01T00:00:00.000Z'
  );
  assert.equal(resolveOriginalInboundTime('', '2026-08-01T00:00:00.000Z'), '2026-08-01T00:00:00.000Z');
  assert.equal(resolveOriginalInboundTime(null, null), null);
});

test('只有BOSS或所属经销商admin可以维护SN特价', () => {
  assert.equal(canManageDistributorPrice({ roles: ['boss'], distributorId: 'OTHER' }, 'D1'), true);
  assert.equal(canManageDistributorPrice({ roles: ['admin'], distributorId: 'D1' }, 'D1'), true);
  assert.equal(canManageDistributorPrice({ roles: ['admin'], distributorId: 'D2' }, 'D1'), false);
  assert.equal(canManageDistributorPrice({ roles: ['manager'], distributorId: 'D1' }, 'D1'), false);
});

test('SN特价表由自动迁移创建并纳入正式启用前库存清理', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../src/utils/dbMigration.js'), 'utf8');
  const cleanup = fs.readFileSync(path.join(__dirname, '../clear_data.js'), 'utf8');
  for (const table of ['T_SN_DISTRIBUTOR_PRICE', 'T_SN_DISTRIBUTOR_PRICE_CHANGE_LOG']) {
    assert.match(migration, new RegExp(`checkAndCreateTable\\('${table}'`));
    assert.match(cleanup, new RegExp(`'${table}'`));
  }
});

test('销售选择SN时返回当前门店经销商特价和有效售价', async () => {
  const originals = {
    snFindAll: models.ProductSn.findAll,
    storeFindOne: models.Store.findOne,
    productPriceFindOne: models.ProductPrice.findOne,
    specialFindAll: models.SnDistributorPrice.findAll,
    rightFindAll: models.InventoryResourceRight.findAll,
    categoryFindAll: models.ResourceCategory.findAll,
    locationFindByPk: models.Location.findByPk
  };

  models.ProductSn.findAll = async () => [{
    sn_id: 'SN_ID_1',
    sn_code: 'SN001',
    pn_code: 'PN001',
    inventory_type: 'normal_qty',
    location_id: 'LOCATION_SALES',
    tax_type: 'TAX_INCLUDED'
  }];
  models.Location.findByPk = async () => ({ location_id: 'LOCATION_SALES', type: 'normal_qty', status: 1 });
  models.Store.findOne = async () => ({ store_id: 'STORE_1', distributor_id: 'D1' });
  models.ProductPrice.findOne = async () => ({ standard_price: 6999, min_sale_price: 6500 });
  models.SnDistributorPrice.findAll = async options => {
    assert.equal(options.where.distributor_id, 'D1');
    return [{ sn_id: 'SN_ID_1', special_price: 6299, remark: '清库特价' }];
  };
  models.InventoryResourceRight.findAll = async () => [];
  models.ResourceCategory.findAll = async () => [];

  const ctx = {
    params: { storeId: 'STORE_1', productId: 'PRODUCT_1' },
    query: {},
    state: { user: { accessibleStoreIds: ['STORE_1'], roles: ['clerk'] } },
    throw(status, message) {
      throw Object.assign(new Error(message), { status });
    }
  };

  try {
    await salesController.getProductSns(ctx);
    assert.equal(ctx.body.data.length, 1);
    assert.equal(ctx.body.data[0].special_price, 6299);
    assert.equal(ctx.body.data[0].effective_sale_price, 6299);
    assert.equal(ctx.body.data[0].min_sale_price, 6500);
    assert.equal(ctx.body.data[0].is_special_price, true);
  } finally {
    models.ProductSn.findAll = originals.snFindAll;
    models.Store.findOne = originals.storeFindOne;
    models.ProductPrice.findOne = originals.productPriceFindOne;
    models.SnDistributorPrice.findAll = originals.specialFindAll;
    models.InventoryResourceRight.findAll = originals.rightFindAll;
    models.ResourceCategory.findAll = originals.categoryFindAll;
    models.Location.findByPk = originals.locationFindByPk;
  }
});
