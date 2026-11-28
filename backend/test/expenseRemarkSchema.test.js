const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { Expense } = require('../src/models');
const source = fs.readFileSync(require.resolve('../src/utils/dbMigration'), 'utf8');
const helper = source.slice(source.indexOf('async function ensureExpenseRemarkSchema()'), source.indexOf('async function ensureExpenseRecipientSchema()'));

test('purchase reimbursement remarks can preserve long source explanations', () => {
  assert.equal(Expense.rawAttributes.remark.type.key, 'TEXT');
  const startup = source.slice(source.indexOf('async function runSchemaMigrations()'), source.indexOf('async function ensureSalesCashRebateSchema()'));
  assert.match(startup, /await ensureExpenseRemarkSchema\(\)/);
});

test('remark migration widens once without truncating data and propagates DDL failure', async () => {
  let dataType = 'varchar', fail = false;
  const changes = [];
  const ensure = vm.runInNewContext(`${helper}; ensureExpenseRemarkSchema`, { sequelize: {
    QueryTypes: { SELECT: 'SELECT' },
    query: async sql => {
      if (sql.startsWith('SELECT')) return [{ dataType }];
      if (fail) throw Error('DDL denied');
      changes.push(sql); dataType = 'longtext';
    }
  } });
  await ensure(); await ensure();
  assert.deepEqual(changes, ['ALTER TABLE T_EXPENSE MODIFY COLUMN REMARK LONGTEXT NULL']);
  dataType = 'varchar'; fail = true;
  await assert.rejects(ensure(), /DDL denied/);
});
