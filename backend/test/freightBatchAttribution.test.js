const test = require('node:test');
const assert = require('node:assert/strict');
const models = require('../src/models');
const { matchesFreightOrigin, buildFreightCostDetails } = require('../src/modules/sales/grossProfit');

const item = { item_id: 46839, product_id: 'repair', sn_id: 'sn-new', sn_code: 'PF132AEZ', quantity: 1 };
const origin = { source_type: 'purchase', source_id: 'pr-new', source_no: 'PR202610210700436185' };
const freight = (id, no, amount, extra = {}) => ({
  product_id: 'repair', unit_amount: amount, quantity: 1, ...extra,
  freightRecord: { freight_id: id, source_type: 'purchase', source_id: id, source_no: no,
    store_id: 'store', create_time: '2026-10-18', update_time: '2026-10-18', status: 'active' }
});

test('same product cannot borrow freight from another purchase or another SN', () => {
  assert.equal(matchesFreightOrigin(item, freight('pr-old', 'PR-old', 360), [origin]), false);
  assert.equal(matchesFreightOrigin(item, freight('pr-new', origin.source_no, 20), [origin]), true);
  assert.equal(matchesFreightOrigin(item, freight('pr-new', origin.source_no, 20, { sn_id: 'other' }), [origin]), false);
  assert.equal(matchesFreightOrigin(item, freight('pr-old', 'PR-old', 360), []), false);
  assert.equal(matchesFreightOrigin({ product_id: 'repair' }, freight('pr-old', 'PR-old', 360), []), false);
  assert.equal(matchesFreightOrigin(item, freight('pr-new', origin.source_no, 20, { sn_id: 'other', sn_code: item.sn_code }), [origin]), false);
  assert.equal(matchesFreightOrigin(item, freight('pr-new', origin.source_no, 20, { sn_id: item.sn_id, sn_code: 'old-code' }), []), true);
});

test('batch attribution keeps purchase and transfer sources separate', () => {
  const value = freight('pr-new', origin.source_no, 20);
  value.freightRecord.source_type = 'transfer';
  assert.equal(matchesFreightOrigin(item, value, [origin]), false);
  assert.equal(matchesFreightOrigin(item, value, [{ ...origin, source_type: 'TRANSFER' }]), true);
});

test('zero freight purchase does not inherit the previous purchase freight; actual batch freight still works', async t => {
  t.mock.method(models.OrderItem, 'findAll', async () => [item]);
  t.mock.method(models.sequelize, 'query', async () => [origin]);
  let rows = [freight('pr-old', 'PR-old', 360)];
  t.mock.method(models.FreightRecordItem, 'findAll', async () => rows.map(row => ({ toJSON: () => row })));
  const order = { order_id: 'sale', store_id: 'store', create_time: '2026-10-21' };
  assert.deepEqual(await buildFreightCostDetails(order), []);
  rows.push(freight('pr-new', origin.source_no, 15));
  const details = await buildFreightCostDetails(order);
  assert.equal(details.length, 1);
  assert.equal(details[0].amount, 15);
  assert.equal(details[0].sourceNo, origin.source_no);
});
