const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const C = require('../src/modules/product/inventoryPricing');
const { resolveInventoryCostMode } = require('../src/modules/sales/grossProfit');
function ctx(body = {}, user = { staffId: 1, roles: ['boss'] }) {
  return { request: { body }, query: {}, state: { user }, throw(status, message) { throw Object.assign(new Error(message), { status }); } };
}
function fixture(t) {
  const writes = [], logs = [];
  const stock = { sn_id: 'SN1', sn_code: 'CODE', product_id: 'P', store_id: 'S', status: 'in_stock', is_deleted: 0,
    gross_profit_use_standard_price: 0, inbound_price: '1000', original_inbound_time: '2026-09-01T00:00:00Z', update_time: '2026-10-01T00:00:00Z' };
  const product = { product_id: 'P', name: 'item', category: '电脑配件', gross_profit_cost_mode: 'PURCHASE_PRICE' };
  const price = { price_id: 'PRICE', product_id: 'P', standard_price: '2900', status: 1 };
  let occupied = false;
  const row = { ...stock, toJSON() { return { ...this }; }, async update(values) { writes.push(values); Object.assign(this, values); } };
  t.mock.method(M.sequelize, 'query', async () => assert.fail('No live database access'));
  t.mock.method(M.sequelize, 'transaction', async fn => fn({ LOCK: { UPDATE: 'UPDATE' } }));
  t.mock.method(M.Store, 'findAll', async () => [{ store_id: 'S', name: 'store' }]);
  t.mock.method(M.ProductSn, 'findAll', async () => [row]);
  t.mock.method(M.Product, 'findAll', async () => [product]);
  t.mock.method(M.ProductPrice, 'findAll', async () => price.status === 1 ? [price] : []);
  t.mock.method(M.OrderItem, 'findAll', async () => occupied ? [{ product_id: 'P', sn_code: 'CODE' }] : []);
  t.mock.method(M.BusinessActionLog, 'create', async values => { logs.push(values); });
  return { row, product, price, writes, logs, occupy() { occupied = true; } };
}
async function preview(body) { const c = ctx(body); await C.preview(c); return c.body.data; }

test('explicit inventory mode wins for every category, including accessory and Care defaults', () => {
  for (const category of ['电脑配件', '选件', '二手', '手机', '平板', '笔记本', '售后']) {
    const p = { category, brand: 'Care服务', gross_profit_cost_mode: 'COMPANY_PRICE' };
    assert.equal(resolveInventoryCostMode(p, { gross_profit_use_standard_price: 0 }, { status: 1, standard_price: 2900 }), 'PURCHASE_PRICE');
    assert.equal(resolveInventoryCostMode({ ...p, gross_profit_cost_mode: 'PURCHASE_PRICE' }, { gross_profit_use_standard_price: 1 }), 'COMPANY_PRICE');
  }
});
test('preview writes nothing; apply changes only selected stock and records audited before/after', async t => {
  const f = fixture(t);
  const body = { snIds: ['SN1'], mode: 'COMPANY_PRICE', reason: '库存备货转公司定价' };
  const p = await preview(body);
  assert.equal(p.list[0].purchasePrice, 1000); assert.equal(p.list[0].standardPrice, 2900);
  assert.equal(f.writes.length, 0);
  t.mock.method(M.Product, 'update', async () => assert.fail('Do not change global defaults'));
  t.mock.method(M.OrderGrossProfit, 'update', async () => assert.fail('Do not change archived profits'));
  await C.apply(ctx({ ...body, previewHash: p.previewHash }));
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].gross_profit_use_standard_price, 1);
  assert.equal(f.logs[0].from_status, 'PURCHASE_PRICE'); assert.equal(f.logs[0].to_status, 'COMPANY_PRICE');
  assert.equal(JSON.parse(f.logs[0].detail_json).purchasePrice, 1000);
  assert.equal(f.row.inbound_price, '1000');
});
test('changed company price invalidates preview before any update', async t => {
  const f = fixture(t), body = { snIds: ['SN1'], mode: 'COMPANY_PRICE', reason: 'test' };
  const p = await preview(body); f.price.standard_price = '3100';
  await assert.rejects(C.apply(ctx({ ...body, previewHash: p.previewHash })), /重新预览/);
  assert.equal(f.writes.length, 0);
});
test('sold or unarchived-order-linked inventory cannot be adjusted', async t => {
  const f = fixture(t), body = { snIds: ['SN1'], mode: 'COMPANY_PRICE', reason: 'test' };
  let p = await preview(body); f.row.status = 'sold';
  await assert.rejects(C.apply(ctx({ ...body, previewHash: p.previewHash })), /不可调整/);
  f.row.status = 'in_stock'; f.occupy(); p = await preview(body);
  assert.match(p.list[0].blocked, /未归档/);
  await assert.rejects(C.apply(ctx({ ...body, previewHash: p.previewHash })), /不可调整/);
  assert.equal(f.writes.length, 0);
});
test('missing company price blocks, valid zero is accepted with below-cost acknowledgement', async t => {
  const f = fixture(t), body = { snIds: ['SN1'], mode: 'COMPANY_PRICE', reason: 'test' };
  f.price.status = 0; let p = await preview(body); assert.match(p.list[0].blocked, /缺少有效公司定价/);
  f.price.status = 1; f.price.standard_price = 0; p = await preview(body);
  assert.equal(p.list[0].blocked, ''); assert.match(p.list[0].warning, /低于/);
  await assert.rejects(C.apply(ctx({ ...body, previewHash: p.previewHash })), /确认风险/);
  await C.apply(ctx({ ...body, previewHash: p.previewHash, confirmBelowCost: true }));
  assert.equal(f.writes.length, 1);
});
test('rejects absent inventory, missing reasons and users without price-management permission', async t => {
  fixture(t);
  await assert.rejects(C.apply(ctx({ snIds: ['SN1'], mode: 'COMPANY_PRICE' })), /原因/);
  t.mock.method(M.ProductSn, 'findAll', async () => []);
  await assert.rejects(C.preview(ctx({ snIds: ['SN1'], mode: 'COMPANY_PRICE' })), /权限范围/);
  t.mock.method(M.Role, 'findAll', async () => []);
  t.mock.method(M.RoleMenu, 'findAll', async () => []);
  t.mock.method(M.Menu, 'findOne', async () => null);
  await assert.rejects(C.preview(ctx({ snIds: ['SN1'], mode: 'COMPANY_PRICE' }, { staffId: 2, roles: ['clerk'] })), /价格管理权限/);
});
test('non-boss accounts query stock only inside active authorized distributor stores', async t => {
  fixture(t);
  t.mock.method(M.Role, 'findAll', async () => [{ role_id: 'R' }]);
  t.mock.method(M.RoleMenu, 'findAll', async () => [{ menu_id: 'product_price' }]);
  t.mock.method(M.Menu, 'findOne', async () => ({ menu_id: 'product_price' }));
  t.mock.method(M.Store, 'findAll', async ({where}) => { assert.equal(where.distributor_id[require('sequelize').Op.in][0], 'D'); return []; });
  t.mock.method(M.ProductSn, 'findAll', async ({where}) => { assert.deepEqual(where.store_id[require('sequelize').Op.in], []); return []; });
  await assert.rejects(C.preview(ctx({ snIds: ['SN1'], mode: 'COMPANY_PRICE' }, { staffId: 2, roles: ['product_manager'], accessibleDistributorIds: ['D'] })), /权限范围/);
});

test('inventory list filters all categories, mode and stock age and exposes blocked pending orders', async t => {
  const f = fixture(t); f.product.category = '手机';
  f.occupy();
  const c = ctx(); c.query = { category: '手机', mode: 'PURCHASE_PRICE', minDays: 7, page: 1, pageSize: 20 };
  await C.list(c);
  assert.equal(c.body.data.total, 1);
  assert.equal(c.body.data.list[0].category, '手机');
  assert.match(c.body.data.list[0].blocked, /未归档/);
  assert.equal(c.body.data.list[0].version, undefined);
  c.query.mode = 'COMPANY_PRICE'; await C.list(c); assert.equal(c.body.data.total, 0);
});

test('history requires scoped stock access and returns recorded adjustments', async t => {
  fixture(t);
  t.mock.method(M.ProductSn, 'findOne', async () => ({ sn_id: 'SN1' }));
  t.mock.method(M.BusinessActionLog, 'findAll', async () => [{ action: 'change_cost_mode', detail_json: '{"afterFlag":1}' }]);
  const c = ctx(); c.params = { snId: 'SN1' }; await C.history(c);
  assert.equal(c.body.data[0].detail.afterFlag, 1);
  t.mock.method(M.ProductSn, 'findOne', async () => null);
  await assert.rejects(C.history(c), /权限范围/);
});
