const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/utils/dbMigration'), 'utf8');
const helper = source.slice(source.indexOf('async function ensureExpenseRecipientSchema()'), source.indexOf('async function ensureExpenseAccountingSchema()'));

test('startup installs recipient column without historical accounting repairs', () => {
  const startup = source.slice(source.indexOf('async function runSchemaMigrations()'), source.indexOf('async function ensureSalesCashRebateSchema()'));
  assert.match(startup, /await ensureExpenseRecipientSchema\(\)/);
  assert.doesNotMatch(startup, /await ensureExpenseAccountingSchema\(\)/);
});

test('recipient schema verifies readability and propagates failed DDL', async () => {
  const calls = [];
  let fail = false;
  const ensure = vm.runInNewContext(`${helper}; ensureExpenseRecipientSchema`, {
    checkAndAddColumn: async (...args) => calls.push(args),
    sequelize: { query: async sql => { calls.push(sql); if (fail) throw new Error('missing column'); } }
  });
  await ensure();
  assert.deepEqual(calls[0].slice(0, 2), ['T_EXPENSE', 'RECIPIENT_SNAPSHOT_JSON']);
  assert.match(calls[0][2], /^LONGTEXT NULL/);
  assert.equal(calls[1], 'SELECT RECIPIENT_SNAPSHOT_JSON FROM T_EXPENSE LIMIT 0');
  fail = true;
  await assert.rejects(ensure(), /missing column/);
});
