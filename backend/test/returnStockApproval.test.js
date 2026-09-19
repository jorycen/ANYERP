const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
let accountingFailure = false;
require('../src/modules/purchase/purchaseReturnAccounting').ensurePurchaseReturnAccounting = async ({ transaction }) => {
  assert.ok(transaction);
  if (accountingFailure) throw new Error('accounting unavailable');
  return { payableId: 'PAY' };
};
require('../src/modules/inventory/serializedInventoryBalance').syncSerializedInventoryBalance = async () => {};
// Engine voting has its own integration suite; here exercise business transaction ownership.
require('../src/modules/approval/businessRuntime').advance = async (ctx, type, row, transaction) => {
  assert.equal(type, 'return_stock');
  assert.equal(row.transaction, transaction);
  row.approvalCommitted = true;
  return true;
};
const controller = require('../src/modules/inventory/controller');

function fixture(t) {
  accountingFailure = false;
  const state = { commits: 0, rollbacks: 0 };
  const records = [];
  const tx = { LOCK: { UPDATE: 'UPDATE' }, async commit() { state.commits++; }, async rollback() { state.rollbacks++; for (const [row, snapshot] of records) Object.assign(row, snapshot); } };
  const record = data => {
    const row = { ...data, transaction: tx, async update(patch, options) { assert.equal(options.transaction, tx); Object.assign(this, patch); }, async reload(options) { assert.equal(options.lock, tx.LOCK.UPDATE); return this; } };
    records.push([row, { ...row }]); return row;
  };
  const item = { inbound_item_id: 'II', product_id: 'P', quantity: 1, location_id: 'L', inventory_type: 'normal_qty' };
  const request = record({ return_id: 'R', return_no: 'RT1', inbound_id: 'IN', store_id: 'S', status: 'pending', approvalCommitted: false, items: [item] });
  const inbound = record({ inbound_id: 'IN', status: 'completed', items: [{ item_id: 'II', quantity: 2 }] });
  const inventory = record({ normal_qty: 2 });
  t.mock.method(M.sequelize, 'query', async () => { throw new Error('Unexpected database access'); });
  t.mock.method(M.sequelize, 'transaction', async () => { for (const entry of records) entry[1] = { ...entry[0] }; return tx; });
  t.mock.method(console, 'error', () => {});
  t.mock.method(M.ReturnStock, 'findByPk', async () => request);
  t.mock.method(M.Inbound, 'findByPk', async () => inbound);
  t.mock.method(M.Product, 'findAll', async () => [{ product_id: 'P', status: 1, is_deleted: 0 }]);
  t.mock.method(M.Inventory, 'findOne', async () => inventory);
  t.mock.method(M.ReturnStockItem, 'findAll', async () => [item]);
  const ctx = { request: { body: { returnId: 'R' } }, state: { user: { staffId: 2, name: '审批人', accessibleStoreIds: ['S'] } }, throw(status, message) { throw Object.assign(new Error(message), { status }); } };
  return { state, request, inbound, inventory, ctx };
}

test('退库审批与执行共用事务，部分退货不能重复累计成全部退货', async t => {
  const f = fixture(t);
  await controller.approveReturn(f.ctx);
  assert.equal(f.state.commits, 1);
  assert.equal(f.request.status, 'completed');
  assert.equal(f.inventory.normal_qty, 1);
  assert.equal(f.inbound.status, 'completed');
  await assert.rejects(controller.approveReturn(f.ctx), /待审批/);
  assert.equal(f.state.commits, 1);
  assert.equal(f.request.status, 'completed');
  assert.equal(f.inventory.normal_qty, 1);
});

test('退库记账失败时回滚审批和库存，不提前提交审批', async t => {
  const f = fixture(t); accountingFailure = true;
  await assert.rejects(controller.approveReturn(f.ctx), /accounting unavailable/);
  assert.equal(f.state.commits, 0);
  assert.equal(f.state.rollbacks, 1);
  assert.equal(f.request.status, 'pending');
  assert.equal(f.request.approvalCommitted, false);
  assert.equal(f.inventory.normal_qty, 2);
});
