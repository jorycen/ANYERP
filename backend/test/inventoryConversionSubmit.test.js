const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const pnMaster = require('../src/utils/productPnMaster');
const balance = require('../src/modules/inventory/serializedInventoryBalance');

function fixture(t, { sourceSn = true, targetSn = true, failTarget = false } = {}) {
  const state = { committed: false, rolledBack: false, conversions: [], items: [], snLogs: [], newSns: [], inventory: [] };
  const tx = { LOCK: { UPDATE: 'UPDATE' }, async commit() { state.committed = true; }, async rollback() {
    state.rolledBack = true; state.conversions.length = 0; state.items.length = 0;
    state.snLogs.length = 0; state.newSns.length = 0; state.inventory.length = 0;
    Object.assign(source, { inbound_price: 1, status: 'in_stock' });
  } };
  const source = { sn_id: 'SOURCE-SN', sn_code: 'FPT9TX1', pn_code: 'SOURCE-PN', product_id: 'SOURCE',
    store_id: 'STORE', inventory_type: 'normal_qty', inbound_price: 1, status: 'in_stock',
    async update(patch, options) { assert.equal(options.transaction, tx); Object.assign(this, patch); } };
  const products = {
    SOURCE: { product_id: 'SOURCE', name: '二手一体机', need_sn: sourceSn ? 1 : 0, manufacturer_code: 'SOURCE-PN', status: 1 },
    TARGET: { product_id: 'TARGET', name: 'DDR4内存', need_sn: targetSn ? 1 : 0, manufacturer_code: 'TARGET-PN', status: 1 }
  };
  t.mock.method(M.sequelize, 'transaction', async () => tx);
  t.mock.method(M.Store, 'findByPk', async () => ({ store_id: 'STORE' }));
  t.mock.method(M.Product, 'findOne', async options => products[options.where.product_id]);
  t.mock.method(M.Product, 'findAll', async () => Object.values(products));
  t.mock.method(M.ProductPn, 'findAll', async options => [{ pn_code: products[options.where.product_id]?.manufacturer_code }]);
  t.mock.method(M.ProductPrice, 'findOne', async () => ({ cost_price: 1 }));
  t.mock.method(M.ProductSn, 'findOne', async options => options.where.product_id === 'SOURCE' ? source : null);
  t.mock.method(M.ProductSn, 'create', async (value, options) => { assert.equal(options.transaction, tx); state.newSns.push(value); return value; });
  t.mock.method(pnMaster, 'ensureProductPnMaster', async options => { assert.equal(options.transaction, tx); return { pn_id: 'TARGET-PN-ID' }; });
  t.mock.method(balance, 'syncSerializedInventoryBalance', async options => { assert.equal(options.transaction, tx); });
  t.mock.method(M.InventoryConversion, 'create', async (value, options) => { assert.equal(options.transaction, tx); state.conversions.push(value); return value; });
  t.mock.method(M.InventoryConversionItem, 'create', async (value, options) => { assert.equal(options.transaction, tx); state.items.push(value); return value; });
  t.mock.method(M.SnLog, 'create', async (value, options) => { assert.equal(options.transaction, tx); state.snLogs.push(value); return value; });
  t.mock.method(M.Inventory, 'findAll', async () => [{ normal_qty: 1, async update(patch, options) { assert.equal(options.transaction, tx); state.inventory.push(patch); } }]);
  t.mock.method(M.Location, 'findOne', async () => ({ location_id: 'NORMAL' }));
  t.mock.method(M.Inventory, 'findOne', async () => ({ normal_qty: 1, async update(patch, options) { assert.equal(options.transaction, tx); state.inventory.push(patch); } }));
  if (failTarget) t.mock.method(M.ProductSn, 'create', async () => { throw Object.assign(new Error('测试目标写入失败'), { status: 409 }); });
  // Capture dependency mocks for this controller instance only; no real database access.
  delete require.cache[require.resolve('../src/modules/inventory/controller')];
  const controller = require('../src/modules/inventory/controller');
  const ctx = { state: { user: { name: '测试操作人', staffId: 7, accessibleStoreIds: ['STORE'] } },
    request: { body: { conversionType: 'split', storeId: 'STORE', remark: '故障机，内存拆出来使用',
      sourceItems: [{ productId: 'SOURCE', pnCode: 'SOURCE-PN', snId: sourceSn ? 'SOURCE-SN' : undefined, snCode: sourceSn ? 'FPT9TX1' : '', quantity: 1, unitCost: 1 }],
      targetItems: [{ productId: 'TARGET', pnCode: 'TARGET-PN', snCode: '20261027', quantity: 1, unitCost: 1, totalCost: 1 }] } },
    throw(status, message) { throw Object.assign(new Error(message), { status }); } };
  return { state, ctx, source, controller };
}

test('截图场景：SN整机成本1元拆出SN内存1元，原SN保持在库且剩余成本0，双端日志和单据提交成功', async t => {
  const f = fixture(t);
  await f.controller.createConversion(f.ctx);
  assert.equal(f.ctx.body.code, 0); assert.equal(f.state.committed, true); assert.equal(f.state.rolledBack, false);
  assert.equal(f.source.inbound_price, 0); assert.equal(f.source.status, 'in_stock');
  assert.equal(f.state.conversions[0].total_source_cost, 1); assert.equal(f.state.conversions[0].total_target_cost, 1);
  assert.deepEqual(f.state.snLogs.map(row => row.action), ['inventory_split_source', 'inventory_split_target']);
  assert.ok(f.state.snLogs.every(row => row.create_user === '测试操作人'));
  assert.equal(f.state.newSns[0].inbound_price, 1);
  assert.equal(f.state.items.find(row => row.line_role === 'target').source_sn_id, 'SOURCE-SN');
});
test('非SN来源组装为SN成品时也可记录目标操作人并提交', async t => {
  const f = fixture(t, { sourceSn: false }); f.ctx.request.body.conversionType = 'assemble';
  await f.controller.createConversion(f.ctx);
  assert.equal(f.state.committed, true); assert.equal(f.state.snLogs[0].action, 'inventory_assemble_target');
  assert.equal(f.state.snLogs[0].create_user, '测试操作人');
});
test('目标SN写入失败时整单回滚，不留下来源成本变更和已完成拆分单', async t => {
  const f = fixture(t, { failTarget: true });
  await assert.rejects(f.controller.createConversion(f.ctx), /测试目标写入失败/);
  assert.equal(f.state.committed, false); assert.equal(f.state.rolledBack, true);
  assert.equal(f.source.inbound_price, 1); assert.equal(f.state.conversions.length, 0); assert.equal(f.state.snLogs.length, 0);
});
test('拆出金额超过来源成本仍拒绝，修复不放宽原成本守恒校验', async t => {
  const f = fixture(t); Object.assign(f.ctx.request.body.targetItems[0], { unitCost: 2, totalCost: 2 });
  await assert.rejects(f.controller.createConversion(f.ctx), /不能超过/);
  assert.equal(f.state.committed, false); assert.equal(f.state.rolledBack, true); assert.equal(f.source.inbound_price, 1);
});
