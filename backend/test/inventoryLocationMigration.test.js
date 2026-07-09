const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Location } = require('../src/models');

const migrationSource = fs.readFileSync(
  path.join(__dirname, '../src/utils/dbMigration.js'),
  'utf8'
);

test('inventory location model is covered by automatic migrations', () => {
  for (const column of ['location_id', 'store_id', 'name', 'type', 'is_sellable', 'status']) {
    assert.ok(Location.rawAttributes[column], `model should define ${column}`);
  }

  assert.match(migrationSource, /checkAndCreateTable\('T_LOCATION'/);
  assert.match(migrationSource, /checkAndAddColumn\('T_LOCATION', 'TYPE'/);
  assert.match(migrationSource, /checkAndAddColumn\('T_LOCATION', 'IS_SELLABLE'/);
  assert.match(migrationSource, /checkAndAddColumn\('T_LOCATION', 'STATUS'/);
});
