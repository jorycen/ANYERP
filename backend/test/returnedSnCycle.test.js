const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const { recordSnReentry } = require('../src/utils/snEligibility');
const { snKey } = require('../src/modules/inventory/foundation');
test.after(() => M.sequelize.close());
test('returned SN starts a separate acquisition foundation in the intake transaction', async t => {
  const transaction = {}, logs = [];
  t.mock.method(M.SnLog, 'create', async (row, options) => {
    assert.equal(options.transaction, transaction);
    logs.push({...row, create_time: new Date()});
  });
  const sn = {sn_id:'S',sn_code:'CODE',product_id:'NEW',store_id:'STORE',inventory_type:'normal_qty'};
  await recordSnReentry(sn, 'returned', {transaction,actor:'user',document:'IN-NEW'});
  assert.equal(logs.length, 1);
  assert.equal(logs[0].product_id, 'NEW');
  assert.notEqual(snKey('S', logs), snKey('S', []));
  assert.equal(JSON.parse(logs[0].remark).fromStatus, 'returned');
  await recordSnReentry(sn, 'in_stock', {transaction});
  assert.equal(logs.length, 1);
  await assert.rejects(recordSnReentry(sn, 'returned'), /同一事务/);
});
