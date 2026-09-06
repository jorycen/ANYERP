const test = require('node:test');
const assert = require('node:assert/strict');
const models = require('../src/models');
const effects = [];
// Stub accounting boundaries; exercise the real approval and inventory controllers.
for (const [path, names] of [
  ['../src/modules/sales/grossProfit', ['createSalesReturnGrossProfitLedger']],
  ['../src/modules/report/productSettlement', ['createProductSettlementReturnAdjustment']],
  ['../src/modules/sales/salesReturnSettlement', ['createSalesReturnSettlement']],
  ['../src/modules/inventory/serializedInventoryBalance', ['syncSerializedInventoryBalance']]
]) {
  const mod = require(path);
  for (const name of names) mod[name] = async args => { effects.push({ name, transaction: args.transaction }); };
}
const sales = require('../src/modules/sales/controller');
sales.releaseDepositRedemptionForOrder = async (order, transaction) => effects.push({ name: 'deposit', transaction });
require('../src/modules/inventory/controller');

async function fixture(t, { sn = true, partial = false, missingLocation = false, stage = 'pending_distributor', failSettlement = false } = {}) {
  effects.length = 0;
  const tx = { LOCK: { UPDATE: 'UPDATE' } };
  const state = { commits: 0, rollbacks: 0, transactions: 0, logs: [] };
  const records = [];
  const record = data => {
    const row = { ...data, async update(values, options) {
      assert.equal(options.transaction, tx);
      Object.assign(this, values); return this;
    } };
    records.push(row); return row;
  };
  const request = record({ return_id: 'R', return_no: 'SR1', order_id: 'O', store_id: 'S', status: 'pending', approval_stage: stage });
  const item = record({ item_id: 'RI', return_id: 'R', order_item_id: 'OI', product_id: 'P', product_name: '商品', quantity: sn ? 1 : 2, pn_code: 'PN', sn_code: sn ? 'SN' : '' });
  const orderItem = { item_id: 'OI', product_id: 'P', quantity: partial ? 4 : item.quantity, original_inventory_cost: 0 };
  const order = record({ order_id: 'O', order_status: 'return_pending', OrderItems: [orderItem] });
  const product = { product_id: 'P', product_code: 'P', name: '商品', need_sn: sn ? 1 : 0, manufacturer_code: 'PN', status: 1 };
  const serial = record({ sn_id: 'SNID', product_id: 'P', store_id: 'S', sn_code: 'SN', pn_code: 'PN', status: 'sold', original_pickup_price: 740 });
  const balance = record({ normal_qty: 0 });
  let inbound = null;
  const inboundItems = [];
  const stub = (model, name, fn) => t.mock.method(model, name, fn);
  stub(models.sequelize, 'transaction', async callback => {
    state.transactions++;
    const snapshots = records.map(row => ({ row, data: { ...row } }));
    try { const value = await callback(tx); state.commits++; return value; }
    catch (error) {
      state.rollbacks++;
      for (const { row, data } of snapshots) { for (const key of Object.keys(row)) delete row[key]; Object.assign(row, data); }
      inbound = null; inboundItems.length = 0; state.logs.length = 0;
      throw error;
    }
  });
  stub(models.SalesReturnRequest, 'findByPk', async () => request);
  stub(models.SalesReturnRequest, 'findOne', async () => request);
  stub(models.SalesReturnRequest, 'findAll', async () => request.status === 'completed' ? [{ items: [item] }] : []);
  stub(models.SalesReturnRequestItem, 'findAll', async () => [item]);
  stub(models.OrderItem, 'findAll', async () => [orderItem]);
  stub(models.Order, 'findByPk', async () => order);
  stub(models.Order, 'update', async (values, options) => order.update(values, options));
  stub(models.Product, 'findAll', async () => [product]);
  stub(models.ProductPn, 'findAll', async () => [record({ pn_id: 'PNID', product_id: 'P', pn_code: 'PN', status: 1, is_deleted: 0 })]);
  stub(models.Product, 'findByPk', async () => product);
  stub(models.sequelize, 'query', async () => { throw new Error('Unexpected database query in unit test'); });
  stub(models.ProductPn, 'findOne', async () => ({ pn_id: 'PNID', product_id: 'P', pn_code: 'PN', status: 1, is_deleted: 0 }));
  stub(models.ProductSn, 'findOne', async () => serial);
  stub(models.Location, 'findOne', async () => missingLocation ? null : { location_id: 'L', type: 'normal_qty' });
  stub(models.Inventory, 'findOne', async () => balance);
  stub(models.Inbound, 'findOne', async () => inbound);
  stub(models.Inbound, 'findByPk', async () => inbound);
  stub(models.Inbound, 'create', async (data, options) => { assert.equal(options.transaction, tx); inbound = record(data); return inbound; });
  stub(models.InboundItem, 'create', async data => { const row = record({ ...data, item_id: 'II' }); inboundItems.push(row); return row; });
  stub(models.InboundItem, 'findAll', async () => inboundItems);
  stub(models.BusinessActionLog, 'create', async (data, options) => { assert.equal(options.transaction, tx); state.logs.push(data); });
  stub(models.SnLog, 'create', async (data, options) => { assert.equal(options.transaction, tx); state.logs.push(data); });
  if (failSettlement) {
    // Failure after stock mutation must abort the outer approval transaction.
    stub(models.Order, 'findByPk', async () => { if (request.status === 'completed') throw new Error('settlement unavailable'); return order; });
  }
  const ctx = { params: { returnId: 'R' }, request: { body: {} }, state: { user: { roles: ['admin'], role: 'admin', name: '审核人', accessibleStoreIds: ['*'] } },
    throw(status, message) { throw Object.assign(new Error(message), { status }); } };
  return { ctx, request, serial, balance, order, state, tx, get inbound() { return inbound; }, inboundItems };
}

test('final approval completes original SN inbound and accounting exactly once', async t => {
  const f = await fixture(t);
  await sales.reviewSalesReturn(f.ctx);
  assert.equal(f.request.status, 'completed');
  assert.equal(f.inbound.status, 'completed');
  assert.equal(f.serial.status, 'in_stock');
  assert.equal(f.serial.location_id, 'L');
  assert.equal(f.serial.original_pickup_price, 740);
  assert.equal(f.balance.normal_qty, 1);
  assert.equal(f.order.order_status, 'returned');
  assert.equal(f.ctx.body.data.status, 'completed');
  assert.match(f.ctx.body.message, /自动入库/);
  assert.equal(f.state.transactions, 1);
  assert.equal(f.state.commits, 1);
  for (const name of ['createSalesReturnGrossProfitLedger', 'createProductSettlementReturnAdjustment', 'createSalesReturnSettlement', 'deposit']) {
    assert.equal(effects.filter(e => e.name === name).length, 1);
  }
  assert.ok(effects.every(e => e.transaction === f.tx));
  await assert.rejects(sales.reviewSalesReturn(f.ctx), /无需审批/);
  assert.equal(f.balance.normal_qty, 1);
});

test('partial non-SN return restores only selected quantity and keeps deposit', async t => {
  const f = await fixture(t, { sn: false, partial: true });
  await sales.reviewSalesReturn(f.ctx);
  assert.equal(f.balance.normal_qty, 2);
  assert.equal(f.inboundItems[0].received_quantity, 2);
  assert.equal(f.order.order_status, '已归档');
  assert.equal(effects.some(e => e.name === 'deposit'), false);
});

test('first approval stage does not receive stock', async t => {
  const f = await fixture(t, { stage: 'pending_store' });
  await sales.reviewSalesReturn(f.ctx);
  assert.equal(f.request.approval_stage, 'pending_distributor');
  assert.equal(f.balance.normal_qty, 0);
  assert.equal(f.inbound, null);
});

for (const [name, options, pattern] of [
  ['missing sales warehouse', { missingLocation: true }, /有效库位/],
  ['accounting failure after stock update', { failSettlement: true }, /settlement unavailable/]
]) test(name + ' rolls back approval and inventory together', async t => {
  const f = await fixture(t, options);
  await assert.rejects(sales.reviewSalesReturn(f.ctx), pattern);
  assert.equal(f.request.status, 'pending');
  assert.equal(f.request.approval_stage, 'pending_distributor');
  assert.equal(f.serial.status, 'sold');
  assert.equal(f.balance.normal_qty, 0);
  assert.equal(f.state.commits, 0);
  assert.equal(f.state.rollbacks, 1);
});

test('rejected return does not enter inventory', async t => {
  const f = await fixture(t);
  f.ctx.request.body.action = 'rejected';
  await sales.reviewSalesReturn(f.ctx);
  assert.equal(f.request.status, 'rejected');
  assert.equal(f.order.order_status, '已归档');
  assert.equal(f.balance.normal_qty, 0);
});
