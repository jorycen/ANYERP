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
