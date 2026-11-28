const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const { Op } = require('sequelize');
const { executeInboundInTransaction } = require('../src/modules/inventory/controller');
function fixture(t) {
  t.mock.method(M.Inbound, 'findByPk', async () => ({ status: 'pending', source_type: 'purchase', store_id: 'store' }));
  t.mock.method(require('../src/modules/inventory/nonPurchaseReceipt'), 'validateInboundRequest', async () => {});
  t.mock.method(M.InboundItem, 'findAll', async () => [
    { item_id: 1, product_id: 'white', quantity: 0, received_quantity: 0 },
    { item_id: 2, product_id: 'black', quantity: 20, received_quantity: 0 }
  ]);
}
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const transaction = { LOCK: { UPDATE: 'UPDATE' } };
test('cancelled disabled white item does not block submitting enabled black receipt', async t => {
  fixture(t);
  const stop = new Error('reached item processing');
  let calls = 0;
  t.mock.method(M.Product, 'findAll', async options => {
    assert.deepEqual(options.where.product_id[Op.in], ['black']);
    calls++;
    if (calls === 2) throw stop;
    return [{ product_id: 'black', status: 1 }];
  });
  await assert.rejects(executeInboundInTransaction({ inboundId: 'in', items: [{ productId: 'black', inboundItemId: 2, quantity: 20 }], user: {}, fail }, transaction), error => error === stop);
  assert.equal(calls, 2);
});
test('a submitted disabled product still fails active status validation', async t => {
  fixture(t);
  t.mock.method(M.Product, 'findAll', async () => []);
  await assert.rejects(executeInboundInTransaction({ inboundId: 'in', items: [{ productId: 'white', inboundItemId: 1, quantity: 1 }], user: {}, fail }, transaction), /已停用/);
});
test('even an enabled cancelled item cannot exceed its zero remaining quantity', async t => {
  fixture(t);
  t.mock.method(M.Product, 'findAll', async () => [{ product_id: 'white', status: 1 }]);
  await assert.rejects(executeInboundInTransaction({ inboundId: 'in', items: [{ productId: 'white', inboundItemId: 1, quantity: 1 }], user: {}, fail }, transaction), /最多还能入库 0 件/);
});
