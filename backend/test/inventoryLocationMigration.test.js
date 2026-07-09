const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Location } = require('../src/models');
const { STANDARD_INVENTORY_LOCATIONS } = require('../src/utils/standardLocations');

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
  assert.match(migrationSource, /idx_location_store_type/);
  for (const location of STANDARD_INVENTORY_LOCATIONS) {
    assert.match(migrationSource, new RegExp(location.type));
    assert.match(migrationSource, new RegExp(location.name));
  }
});
