const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const inventoryController = require('../src/modules/inventory/controller');

test('SN status labels expose reserved inventory as 已占用', () => {
  const getLabel = inventoryController._test.getSnStatusLabel;
  assert.equal(getLabel('in_stock'), '在库');
  assert.equal(getLabel('reserved'), '已占用');
  assert.equal(getLabel('occupied'), '已占用');
  assert.equal(getLabel('sold'), '已销售');
});

test('sales order creation does not reserve inventory before archiving', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/modules/sales/controller.js'),
    'utf8'
  );
  assert.match(source, /inventory_reserved:\s*0/);
  assert.doesNotMatch(source, /if\s*\(!isDraft\)\s*\{[\s\S]*?reserveInventoryForOrder\(savedOrder, transaction\)/);
});
