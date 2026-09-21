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
