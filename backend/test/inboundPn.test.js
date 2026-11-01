const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const { requireInboundPn } = require('../src/utils/inboundPn');
const tx = { LOCK: { UPDATE: 'UPDATE' } };
const product = { product_id: 'p', product_code: 'SP05187', need_sn: 0, manufacturer_code: '' };
function master(t, rows = [], overrides = {}) {
  const p = { ...product, ...overrides };
  t.mock.method(M.Product, 'findByPk', async (_, options) => { assert.equal(options.transaction, tx); return p; });
  t.mock.method(M.ProductPn, 'findAll', async options => { assert.equal(options.transaction, tx); return rows; });
  return p;
}
const pn = code => ({ pn_code: code, status: 1, is_deleted: 0 });

test('all product types reject unregistered, empty and placeholder PN, even if supplied by client', async t => {
  for (const need_sn of [0, 1]) {
    const p = master(t, [], { need_sn });
    for (const value of ['', 'none', '-', 'CLIENT-PN']) {
      await assert.rejects(requireInboundPn(p, value, tx), { code: 'INBOUND_PN_INVALID' });
    }
  }
});
test('active master PN is required, normalized and reused; multiple PN requires a selection', async t => {
  const p = master(t, [pn('PN-A'), pn('PN-B')]);
  assert.equal(await requireInboundPn(p, ' pn- a ', tx), 'PN-A');
  await assert.rejects(requireInboundPn(p, '', tx), /多个PN/);
  for (const code of ['无', 'none', '-', 'OTHER']) await assert.rejects(requireInboundPn(p, code, tx));
});
test('disabled or deleted PN cannot be revived by legacy manufacturer code', async t => {
  for (const row of [{ ...pn('OLD'), status: 0 }, { ...pn('OLD'), is_deleted: 1 }]) {
    const p = master(t, [row], { manufacturer_code: 'OLD' });
    await assert.rejects(requireInboundPn(p, 'OLD', tx), /未维护有效PN/);
  }
});
test('single legacy PN supports old masters but SN products cannot use multiple master PN', async t => {
  const p = master(t, [], { manufacturer_code: 'LEGACY' });
  assert.equal(await requireInboundPn(p, '', tx), 'LEGACY');
  const sn = master(t, [pn('A'), pn('B')], { need_sn: 1 });
  await assert.rejects(requireInboundPn(sn, 'A', tx), { code: 'SN_PRODUCT_PN_NOT_UNIQUE' });
});
test('ordinary and sales-return receipts reject missing PN before inventory or SN mutation', async t => {
  master(t);
  const controller = require('../src/modules/inventory/controller');
  const item = { item_id: 1, product_id: 'p', quantity: 1, received_quantity: 0 };
  let writes = 0;
  t.mock.method(M.Product, 'findAll', async () => [product]);
  t.mock.method(M.InboundItem, 'findAll', async () => [item]);
  t.mock.method(require('../src/modules/inventory/nonPurchaseReceipt'), 'validateInboundRequest', async () => {});
  for (const model of [M.Inventory, M.ProductSn]) t.mock.method(model, 'create', async () => { writes++; });
  for (const source_type of ['purchase', 'SALES_RETURN', 'GIFT']) {
    t.mock.method(M.Inbound, 'findByPk', async () => ({ status: 'pending', source_type, store_id: 's' }));
    await assert.rejects(controller.executeInboundInTransaction({ inboundId: 'i', items: [{ productId: 'p', quantity: 1 }], user: {},
      fail(status, message) { throw Object.assign(new Error(message), { status }); } }, tx), { code: 'INBOUND_PN_INVALID' });
  }
  assert.equal(writes, 0);
});
test('historical batch receipt and positive adjustment revalidate master before stock writes', async t => {
  master(t);
  const { executeApplicationItem } = require('../src/modules/inventory/batchMaintenance')._test;
  let writes = 0;
  for (const operation_type of ['INBOUND', 'ADJUST']) {
    const item = { product_id: 'p', operation_type, quantity: 1, need_sn: 0, pn_code: 'CLIENT-PN', async update() { writes++; } };
    await assert.rejects(executeApplicationItem(item, {}, tx), { code: 'INBOUND_PN_INVALID' });
  }
  assert.equal(writes, 0);
});
test('transfer receipt with missing PN rolls back before destination stock or item changes', async t => {
  master(t);
  let rolledBack = false, writes = 0;
  const transaction = { ...tx, async rollback() { rolledBack = true; }, async commit() { throw new Error('must not commit'); } };
  t.mock.method(M.sequelize, 'transaction', async () => transaction);
  t.mock.method(M.Product, 'findAll', async () => [product]);
  t.mock.method(M.ProductPn, 'findAll', async () => []);
  t.mock.method(M.Transfer, 'findByPk', async () => ({ status: 'out_confirmed', to_store_id: 's', transfer_no: 'T',
    TransferItems: [{ item_id: 1, product_id: 'p', quantity: 1 }] }));
  t.mock.method(M.Inbound, 'findOne', async () => null);
  t.mock.method(M.Location, 'findAll', async () => []);
  t.mock.method(M.Inventory, 'create', async () => { writes++; });
  const ctx = { state: { user: { roles: ['boss'] } }, request: { body: { transferId: 't' } },
    throw(status, message) { throw Object.assign(new Error(message), { status }); } };
  await assert.rejects(require('../src/modules/inventory/controller').confirmTransferIn(ctx), /未维护有效PN/);
  assert.equal(rolledBack, true);
  assert.equal(writes, 0);
});
