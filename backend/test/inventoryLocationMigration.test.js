const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Location, InboundItem } = require('../src/models');
const { _test: systemControllerTest } = require('../src/modules/system/controller');
const { STANDARD_INVENTORY_LOCATIONS } = require('../src/utils/standardLocations');

const migrationSource = fs.readFileSync(
  path.join(__dirname, '../src/utils/dbMigration.js'),
  'utf8'
);

test('inventory location model is covered by automatic migrations', () => {
  for (const column of ['location_id', 'store_id', 'name', 'type', 'is_sellable', 'status']) {
    assert.ok(Location.rawAttributes[column], `model should define ${column}`);
  }
  assert.ok(require('../src/models').Inventory.rawAttributes.rental_demo_qty);

  assert.match(migrationSource, /checkAndCreateTable\('T_LOCATION'/);
  assert.match(migrationSource, /checkAndAddColumn\('T_LOCATION', 'TYPE'/);
  assert.match(migrationSource, /checkAndAddColumn\('T_LOCATION', 'IS_SELLABLE'/);
  assert.match(migrationSource, /checkAndAddColumn\('T_LOCATION', 'STATUS'/);
  assert.match(migrationSource, /idx_location_store_type/);
  for (const location of STANDARD_INVENTORY_LOCATIONS) {
    assert.match(migrationSource, new RegExp(location.type));
    assert.match(migrationSource, new RegExp(location.name));
  }
  assert.ok(STANDARD_INVENTORY_LOCATIONS.some(location => (
    location.type === 'rental_demo_qty' && location.name === '租赁样机仓' && location.is_sellable === 0
  )));
  assert.match(migrationSource, /rental_demo_qty/);
});

test('inbound item model tracks partial receipt progress and received SNs', () => {
  assert.ok(InboundItem.rawAttributes.received_quantity);
  assert.ok(InboundItem.rawAttributes.received_sn_codes);
  assert.match(migrationSource, /checkAndAddColumn\('T_INBOUND_ITEM', 'RECEIVED_QUANTITY'/);
  assert.match(migrationSource, /checkAndAddColumn\('T_INBOUND_ITEM', 'RECEIVED_SN_CODES'/);
});

test('location disable stock check counts standard inventory buckets without double-counting normal stock', () => {
  const getQuantity = systemControllerTest.getInventoryQuantityForLocation;

  assert.equal(getQuantity({ normal_qty: 5, regular_qty: 2, subsidy_qty: 1, second_qty: 1 }), 5);
  assert.equal(getQuantity({ normal_qty: 0, regular_qty: 2, subsidy_qty: 1, second_qty: 1 }), 4);
  assert.equal(getQuantity({ normal_qty: 0, display_qty: 2, demo_qty: 3, unsellable_qty: 1, pending_qty: 4 }), 10);
});
