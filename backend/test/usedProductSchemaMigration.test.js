const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Product } = require('../src/models');

const migrationSource = fs.readFileSync(
  path.join(__dirname, '../src/utils/dbMigration.js'),
  'utf8'
);

test('product model and startup migration agree on IS_USED_PRODUCT', () => {
  assert.ok(Product.rawAttributes.is_used_product);
  assert.match(migrationSource, /ensureCriticalSchemaCompatibility\(\)/);
  assert.match(migrationSource, /'T_PRODUCT'[\s\S]*'IS_USED_PRODUCT'/);
  assert.match(migrationSource, /'T_PURCHASE_REQUEST_ITEM'[\s\S]*'IS_USED_PRODUCT'/);
});
