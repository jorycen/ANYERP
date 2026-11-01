const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const Z = require('../src/modules/purchase/zeroCost');
const tx = {};

test('warning detects individual zero lines in mixed purchases; blank is not confirmed zero', () => {
  const result = Z.zeroCostNotice([{ price: 0, quantity: 1, productName: 'free' }, { price: 300, quantity: 1 },
    ...['', null, undefined, false].map(price => ({ price, quantity: 1 }))]);
  assert.equal(result.hasZeroCost, true);
  assert.equal(result.zeroCostItems.length, 1);
  assert.match(result.message, /0成本采购/);
  assert.equal(Z.zeroCostNotice([{ unit_price: '1', quantity: 1 }]).message, '');
});
test('original approval records specific zero lines and receipt inherits audited evidence in same transaction', async t => {
  const logs = [];
  t.mock.method(M.BusinessActionLog, 'create', async (value, options) => {
    assert.equal(options.transaction, tx); logs.push(value); return value;
  });
  t.mock.method(M.BusinessActionLog, 'findAll', async () => logs.filter(log => log.action === 'zero_cost_purchase_approved'));
  const request = { request_id: 'pr', request_no: 'PR' };
  await Z.recordApproval(request, [{ item_id: 7, product_id: 'p', unit_price: '0.00', quantity: 1 }], { name: 'Reviewer' }, tx);
  await Z.recordReceipt({ purchase_request_id: 'pr', inbound_id: 'in', inbound_no: 'IN' },
    { item_id: 9, product_id: 'p', purchase_request_item_id: 7, unit_price: 0 }, { sn_id: 'sn' }, { name: 'Receiver' }, tx);
  assert.deepEqual(logs.map(log => log.action), ['zero_cost_purchase_approved', 'zero_cost_purchase_received']);
  assert.equal(logs[1].business_id, 'sn');
  assert.equal(JSON.parse(logs[1].detail_json).after.inbound_price, 0);
});
test('old approval without explicit zero evidence and mismatched items do not confirm default zero', async t => {
  let writes = 0;
  t.mock.method(M.BusinessActionLog, 'create', async () => { writes++; });
  for (const logs of [[], [{ detail_json: JSON.stringify({ version: 1, items: [{ itemId: 77, productId: 'other', unitPrice: 0 }] }) }]]) {
    t.mock.method(M.BusinessActionLog, 'findAll', async () => logs);
    await Z.recordReceipt({ purchase_request_id: 'pr' }, { item_id: 9, product_id: 'p', purchase_request_item_id: 7, unit_price: 0 }, null, {}, tx);
  }
  assert.equal(writes, 0);
});
test('non-SN zero receipt evidence belongs to this inbound line, not the whole product', async t => {
  let captured;
  t.mock.method(M.BusinessActionLog, 'findAll', async () => [{ detail_json: JSON.stringify({ version: 1, items: [{ itemId: 7, productId: 'p', unitPrice: 0 }] }) }]);
  t.mock.method(M.BusinessActionLog, 'create', async value => { captured = value; });
  await Z.recordReceipt({ purchase_request_id: 'pr' }, { item_id: 9, product_id: 'p', purchase_request_item_id: 7, unit_price: 0 }, null, {}, tx);
  assert.equal(captured.business_type, 'inbound_item');
  assert.equal(captured.business_id, '9');
});
test('SN completeness accepts audited zero receipt and preserves later-cycle invalidation', async t => {
  t.mock.method(M.sequelize, 'query', async (sql, options) => {
    assert.match(sql, /zero_cost_purchase_received/);
    assert.match(sql, /l.CREATE_TIME>evidence.evidenceTime/);
    assert.equal(options.transaction, tx);
    return [{ snId: 'sn' }];
  });
  const K = require('../src/utils/costKnowledge');
  const confirmed = await K.confirmedZeroSnIds([{ sn_id: 'sn', inbound_price: 0 }], tx);
  assert.equal(K.knownCost(0, confirmed.has('sn')), 0);
  assert.equal(K.knownCost(0, false), null);
});
