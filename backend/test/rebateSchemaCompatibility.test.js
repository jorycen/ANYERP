const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const migration = fs.readFileSync(path.join(root, 'backend/src/utils/dbMigration.js'), 'utf8');

test('安全启动迁移补齐供应商返利流水的经销商字段', () => {
  const compatibilityStart = migration.indexOf('async function ensureFinanceSchemaCompatibility()');
  const compatibilityEnd = migration.indexOf('async function ensureProductSettlementFeatureSchema()');
  const compatibility = migration.slice(compatibilityStart, compatibilityEnd);

  assert.ok(compatibilityStart >= 0 && compatibilityEnd > compatibilityStart);
  assert.match(compatibility, /checkAndCreateTable\('T_SUPPLIER_REBATE'/);
  assert.match(compatibility, /checkAndAddColumn\('T_SUPPLIER_REBATE', 'DISTRIBUTOR_ID'/);
  assert.match(compatibility, /idx_supplier_rebate_distributor/);
});
