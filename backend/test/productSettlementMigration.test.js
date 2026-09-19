const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const reportRouter = require('../src/modules/report/routes');
const reportController = require('../src/modules/report/financeOverviewController');
const productSettlement = require('../src/modules/report/productSettlement');

test('产品端结算表迁移和自动迁移入口已覆盖', () => {
  const migration = fs.readFileSync(
    require('path').join(__dirname, '../db_migrations/20260831_add_product_settlement.sql'),
    'utf8'
  );
  const runner = fs.readFileSync(
    require('path').join(__dirname, '../src/utils/dbMigration.js'),
    'utf8'
  );
  ['T_PRODUCT_SETTLEMENT_ORDER', 'T_PRODUCT_SETTLEMENT_ITEM', 'T_PRODUCT_SETTLEMENT_ADJUSTMENT', 'T_PRODUCT_SETTLEMENT_ADJUSTMENT_ITEM']
    .forEach(tableName => assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName}`)));
  assert.match(runner, /ensureProductSettlementSchema/);
  assert.match(runner, /20260831_add_product_settlement\.sql/);
  const startupSchema = runner.slice(
    runner.indexOf('async function runSchemaMigrations()'),
    runner.indexOf('async function ensureCriticalSchemaCompatibility()')
  );
  assert.match(startupSchema, /await ensureProductSettlementFeatureSchema\(\)/);
  ['T_MANUFACTURER_REBATE_POLICY', 'T_MANUFACTURER_PRICE_HISTORY', 'T_REBATE_ESTIMATE', 'T_SALES_SETTLEMENT_COST_ADJUSTMENT']
    .forEach(tableName => assert.match(startupSchema, new RegExp(`checkAndCreateTable\\('${tableName}'`)));
  assert.match(runner, /finance_product_settlement/);
  assert.match(runner, /\/finance\/product-settlement/);
});

test('产品端毛利清单和导出路由已注册', () => {
  const listRoute = reportRouter.stack.find(
    layer => layer.path === '/product-settlement-orders' && layer.methods.includes('GET')
  );
  const exportRoute = reportRouter.stack.find(
    layer => layer.path === '/product-settlement-orders/export' && layer.methods.includes('GET')
  );

  assert.ok(listRoute);
  assert.ok(exportRoute);
  assert.equal(typeof reportController.getProductSettlementOrders, 'function');
  assert.equal(typeof reportController.exportProductSettlementOrders, 'function');
});

test('产品端政策收益关联实际销售订单表', () => {
  const query = productSettlement._test.buildProductSettlementEntrySql({
    storeIds: ['STORE_1']
  });
  assert.match(query.sql, /FROM T_PRODUCT_SETTLEMENT_ORDER/);

  const source = fs.readFileSync(
    require('path').join(__dirname, '../src/modules/report/productSettlement.js'),
    'utf8'
  );
  assert.match(source, /INNER JOIN T_ORDER sale ON sale\.ORDER_ID = estimate\.SALES_ORDER_ID/);
  assert.doesNotMatch(source, /T_SALES_ORDER/);
});
