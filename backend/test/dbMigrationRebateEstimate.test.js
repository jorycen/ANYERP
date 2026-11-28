const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RebateEstimate } = require('../src/models');

const migrationSource = fs.readFileSync(
  path.join(__dirname, '../src/utils/dbMigration.js'),
  'utf8'
);

test('rebate estimate model columns are covered by automatic migrations', () => {
  const sourceColumns = ['source_type', 'source_id', 'reversal_of'];

  for (const column of sourceColumns) {
    assert.ok(RebateEstimate.rawAttributes[column], `model should define ${column}`);
    assert.match(
      migrationSource,
      new RegExp(`checkAndAddColumn\\('T_REBATE_ESTIMATE', '${column.toUpperCase()}'`),
      `migration should add T_REBATE_ESTIMATE.${column.toUpperCase()}`
    );
  }
});
