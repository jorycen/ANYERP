const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness({ exists = false, ddlFails = false } = {}) {
  const queries = [];
  const source = fs.readFileSync(path.join(__dirname, '../src/utils/dbMigration.js'), 'utf8');
  const stop = new Error('remaining startup checks');
  const context = {
    console: { log() {}, error() {} },
    sequelize: { QueryTypes: { SELECT: 'SELECT' }, async query(sql) {
      queries.push(sql);
      if (sql.includes('information_schema.COLUMNS')) return [{ cnt: exists ? 1 : 0 }];
      if (sql.startsWith('ALTER TABLE')) {
        if (ddlFails) throw new Error('DDL denied');
        exists = true;
      }
      if (sql.startsWith('SELECT CORRECTION_DATA') && !exists) throw new Error('missing CORRECTION_DATA');
      return [];
    } },
    ensureExpenseRemarkSchema: async () => { throw stop; }
  };
  for (const name of ['checkAndAddColumn', 'runSchemaMigrations', 'ensureProfitAdjustmentCorrectionSchema']) {
    const start = source.indexOf(`async function ${name}(`);
    const end = source.indexOf('\nasync function ', start + 1);
    vm.runInNewContext(source.slice(start, end), context);
  }
  return { context, queries, stop };
}

test('actual startup entry adds and verifies correction column before continuing', async () => {
  const { context, queries, stop } = harness();
  await assert.rejects(context.runSchemaMigrations(), error => error === stop);
  assert.equal(queries.filter(sql => sql.startsWith('ALTER TABLE')).length, 1);
  assert.match(queries.at(-1), /^SELECT CORRECTION_DATA/);
});

test('existing column is verified without DDL', async () => {
  const { context, queries } = harness({ exists: true });
  await context.ensureProfitAdjustmentCorrectionSchema();
  assert.equal(queries.some(sql => sql.startsWith('ALTER TABLE')), false);
  assert.match(queries.at(-1), /^SELECT CORRECTION_DATA/);
});

test('DDL failure cannot be swallowed into successful startup', async () => {
  const { context } = harness({ ddlFails: true });
  await assert.rejects(context.runSchemaMigrations(), /missing CORRECTION_DATA/);
});
