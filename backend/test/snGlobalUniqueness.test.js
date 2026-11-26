const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ProductSn, SnLog } = require('../src/models');
const { findInboundSnByIdentity } = require('../src/utils/snIdentity');
const { recordSnReentry } = require('../src/utils/snEligibility');

test('same SN under another PN never reuses the sold stock row', async t => {
  const sold = { sn_id: 'old', pn_code: 'SERVICE', sn_code: '20261126', product_id: 'P1', status: 'sold' };
  const memory = { sn_id: 'new', pn_code: 'MEMORY', sn_code: '20261126', product_id: 'P2', status: 'in_stock' };
  const rows = [sold];
  t.mock.method(ProductSn, 'findAll', async ({ where }) =>
    rows.filter(row => row.pn_code === where.pn_code && row.sn_code === where.sn_code));
  assert.equal(await findInboundSnByIdentity({ pnCode: 'MEMORY', snCode: ' 20261126 ' }), null);
  rows.push(memory);
  assert.equal(await findInboundSnByIdentity({ pnCode: 'memory', snCode: '20261126' }), memory);
  assert.equal(await findInboundSnByIdentity({ pnCode: 'service', snCode: '20261126' }), sold);
  assert.equal(await findInboundSnByIdentity({ snCode: '20261126' }), null);
});

test('same PN duplicate data requires review and never chooses an arbitrary record', async t => {
  t.mock.method(ProductSn, 'findAll', async () => [{ sn_id: 'A' }, { sn_id: 'B' }]);
  await assert.rejects(findInboundSnByIdentity({ pnCode: 'P', snCode: 'S' }), { status: 409 });
});

test('return to stock after a sale creates a distinct inventory cycle', async t => {
  const insert = t.mock.method(SnLog, 'create', async () => {});
  const transaction = {};
  await recordSnReentry({ sn_id: 'A', sn_code: 'S', product_id: 'P' }, 'sold', { transaction });
  assert.equal(insert.mock.calls[0].arguments[0].action, 'stock_cycle_reentry');
  assert.equal(insert.mock.calls[0].arguments[1].transaction, transaction);
});

test('migration preserves PN/SN uniqueness and retires the legacy global index', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../src/utils/dbMigration.js'), 'utf8');
  assert.match(migration, /ADD UNIQUE KEY uk_product_sn_pn_sn \(PN_CODE, SN_CODE\)/);
  assert.match(migration, /removeIndex\('T_PRODUCT_SN', 'uk_product_sn_code_global'\)/);
  assert.doesNotMatch(migration, /ADD UNIQUE KEY uk_product_sn_code_global/);
});
