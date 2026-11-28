const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getSerializedStockField,
  getSerializedResourceQuantity
} = require('../src/modules/inventory/serializedInventoryBalance');

test('serialized inventory projection maps SN status and active location type', () => {
  assert.equal(getSerializedStockField('in_stock', 'normal_qty'), 'normal_qty');
  assert.equal(getSerializedStockField('in_stock', 'display_qty'), 'display_qty');
  assert.equal(getSerializedStockField('reserved', 'normal_qty'), 'pending_qty');
  assert.equal(getSerializedStockField('sold', 'normal_qty'), '');
  assert.equal(getSerializedStockField('in_stock', ''), '');
});

test('serialized inventory projection keeps resource classification deterministic', () => {
  assert.deepEqual(getSerializedResourceQuantity({}, { sales_resource_label: '全资源货' }), {
    regular_qty: 1, subsidy_qty: 0, second_qty: 0
  });
  assert.deepEqual(getSerializedResourceQuantity({}, { available_resource_summary: '含国补资格' }), {
    regular_qty: 0, subsidy_qty: 1, second_qty: 0
  });
  assert.deepEqual(getSerializedResourceQuantity({ tax_type: 'UNTAXED' }, {}), {
    regular_qty: 0, subsidy_qty: 0, second_qty: 1
  });
});
