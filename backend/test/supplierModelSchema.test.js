const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Supplier, PurchaseRequest, SupplierRebate } = require('../src/models');
const { getRebateSummary } = require('../src/modules/finance/rebateController');

test('快递单号属于采购申请而不是供应商，供应商查询不会读取不存在字段', () => {
  assert.equal(Supplier.rawAttributes.express_no, undefined);
  assert.ok(PurchaseRequest.rawAttributes.express_no);
  assert.equal(PurchaseRequest.rawAttributes.express_no.field, 'express_no');
});

test('安全启动迁移会补齐采购申请快递单号字段', () => {
  const migration = fs.readFileSync(path.resolve(__dirname, '../src/utils/dbMigration.js'), 'utf8');
  const start = migration.indexOf('async function ensureCriticalSchemaCompatibility()');
  const end = migration.indexOf('async function dropProductSnGlobalUniqueIndex()');
  const compatibility = migration.slice(start, end);

  assert.match(compatibility, /'T_PURCHASE_REQUEST',\s*'EXPRESS_NO'/);
  assert.match(compatibility, /'T_PURCHASE_REQUEST_ITEM',\s*'NEW_PRODUCT_PAYLOAD'/);
});

test('安全启动迁移会补齐日结明细的云闪付和登记信息字段', () => {
  const migration = fs.readFileSync(path.resolve(__dirname, '../src/utils/dbMigration.js'), 'utf8');
  const start = migration.indexOf('async function ensureFinanceSchemaCompatibility()');
  const end = migration.indexOf('async function ensureProductSettlementFeatureSchema()');
  const compatibility = migration.slice(start, end);

  for (const column of ['UNIONPAY_ORDER_NO', 'SOURCE_TYPE', 'REMARK', 'CREATE_USER', 'CREATE_TIME']) {
    assert.match(compatibility, new RegExp(`'T_DAILY_STATEMENT_DETAIL',\\s*'${column}'`));
  }
});

test('接口在安全启动迁移完成前不会接收业务请求', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/index.js'), 'utf8');
  assert.match(source, /let schemaInitializationReady = false/);
  assert.match(source, /系统正在检查数据库结构，请稍后重试/);
  assert.ok(source.indexOf("ensureDatabaseReady('post-migration database activation'") < source.indexOf('schemaInitializationReady = true;'));
});

test('返利余额汇总展示全部有效供应商并为无流水供应商显示零余额', async () => {
  const originalRebateFindAll = SupplierRebate.findAll;
  const originalSupplierFindAll = Supplier.findAll;
  SupplierRebate.findAll = async () => [{
    get: () => ({ supplier_id: 'SP001', supplier_name: '旧名称', balance: 120, create_time: new Date('2026-09-20T10:00:00+08:00') })
  }];
  Supplier.findAll = async () => [
    { supplier_id: 'SP001', name: '供应商甲' },
    { supplier_id: 'SP002', name: '供应商乙' }
  ];

  try {
    const ctx = {};
    await getRebateSummary(ctx);
    assert.equal(ctx.body.code, 0);
    assert.equal(ctx.body.data.totalBalance, 120);
    assert.deepEqual(ctx.body.data.list.map(item => [item.supplier_name, item.balance]), [
      ['供应商甲', 120],
      ['供应商乙', 0]
    ]);
  } finally {
    SupplierRebate.findAll = originalRebateFindAll;
    Supplier.findAll = originalSupplierFindAll;
  }
});
