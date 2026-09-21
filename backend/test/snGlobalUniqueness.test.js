const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const models = require('../src/models');
const inventoryController = require('../src/modules/inventory/controller');

test('重新入库按SN全局查找并复用已销售记录，不再受PN限制', async () => {
  const originalFindOne = models.ProductSn.findOne;
  const sold = { sn_id: 'SN-ID-1', sn_code: 'MP2VJAEP', pn_code: '83VK008XCD', status: 'sold' };
  let receivedWhere;
  models.ProductSn.findOne = async options => {
    receivedWhere = options.where;
    return sold;
  };

  try {
    const result = await inventoryController._test.findInboundSnByIdentity({
      pnCode: 'DIFFERENT-PN',
      snCode: ' MP2VJAEP '
    });
    assert.equal(result, sold);
    assert.deepEqual(receivedWhere, { sn_code: 'MP2VJAEP' });
  } finally {
    models.ProductSn.findOne = originalFindOne;
  }
});

test('已销售SN即使历史商品档案不同也允许复用并重新绑定本次入库商品', () => {
  const controller = fs.readFileSync(path.resolve(__dirname, '../src/modules/inventory/controller.js'), 'utf8');
  const batch = fs.readFileSync(path.resolve(__dirname, '../src/modules/inventory/batchMaintenance.js'), 'utf8');

  assert.match(controller, /String\(existingSn\.product_id[\s\S]+!REUSABLE_INBOUND_SN_STATUSES\.has/);
  assert.match(batch, /String\(existing\.product_id[\s\S]+!isReusableInboundSnStatus\(existing\.status\)/);
});

test('数据库迁移启用SN全局唯一索引且不再主动删除该索引', () => {
  const migration = fs.readFileSync(path.resolve(__dirname, '../src/utils/dbMigration.js'), 'utf8');
  assert.match(migration, /uk_product_sn_code_global/);
  assert.match(migration, /ADD UNIQUE KEY uk_product_sn_code_global \(SN_CODE\)/);
  assert.doesNotMatch(migration, /DROP INDEX.*SN全局唯一索引/);
});

test('SN修改申请使用全局唯一提示，不再限定同一PN', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/modules/inventory/snChangeApplication.js'), 'utf8');
  assert.match(source, /SN在全系统不允许重复/);
  assert.doesNotMatch(source, /在同一PN下已被使用/);
});
