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

test('formal sales order creation reserves inventory before returning success', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/modules/sales/controller.js'),
    'utf8'
  );
  assert.match(source, /inventory_reserved:\s*isDraft\s*\?\s*0\s*:\s*1/);
  assert.match(source, /if\s*\(!isDraft\)\s*\{[\s\S]*?reserveInventoryForOrder\(savedOrder, transaction\)/);
});
