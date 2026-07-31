const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../src/modules/inventory/controller');

test('inventory summary maps legacy normal quantity to the bound non-sale location', () => {
  const snapshot = _test.getInventoryQuantitySnapshot({
    normal_qty: 2,
    regular_qty: 0,
    subsidy_qty: 0,
    second_qty: 0,
    display_qty: 0,
    demo_qty: 0,
    unsellable_qty: 0,
    pending_qty: 0
  }, 'unsellable_qty');

  assert.equal(snapshot.normal_qty, 0);
  assert.equal(snapshot.unsellable_qty, 2);
});

test('inventory summary keeps standard quantities in their matching location fields', () => {
  const snapshot = _test.getInventoryQuantitySnapshot({
    normal_qty: 0,
    regular_qty: 0,
    subsidy_qty: 0,
    second_qty: 0,
    display_qty: 0,
    demo_qty: 3,
    unsellable_qty: 0,
    pending_qty: 0
  }, 'demo_qty');

  assert.equal(snapshot.normal_qty, 0);
  assert.equal(snapshot.demo_qty, 3);
});

test('inventory summary splits sales stock by resource type', () => {
  const snapshot = _test.getSalesResourceQuantitySnapshot({
    normal_qty: 7,
    regular_qty: 4,
    subsidy_qty: 2,
    second_qty: 1,
    display_qty: 0,
    demo_qty: 0,
    unsellable_qty: 0,
    pending_qty: 0
  }, 'normal_qty');

  assert.deepEqual(snapshot, {
    full_resource_qty: 4,
    subsidy_only_qty: 2,
    no_subsidy_qty: 1
  });
});

test('inventory summary treats legacy unsplit sales stock as full-resource stock', () => {
  const snapshot = _test.getSalesResourceQuantitySnapshot({
    normal_qty: 3,
    regular_qty: 0,
    subsidy_qty: 0,
    second_qty: 0
  }, 'normal_qty');

  assert.deepEqual(snapshot, {
    full_resource_qty: 3,
    subsidy_only_qty: 0,
    no_subsidy_qty: 0
  });
});
