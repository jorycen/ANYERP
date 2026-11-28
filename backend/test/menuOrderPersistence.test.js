const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationSource = fs.readFileSync(
  path.join(__dirname, '../src/utils/dbMigration.js'),
  'utf8'
);

test('menu seeding preserves administrator-managed hierarchy and order', () => {
  const ensureChildMenus = migrationSource.match(
    /const ensureChildMenus = async \(\) => \{([\s\S]*?)\n    \};/
  )?.[1];

  assert.ok(ensureChildMenus, 'menu seeding function should exist');

  const existingMenuUpdate = ensureChildMenus.match(
    /UPDATE T_MENU SET ([\s\S]*?) WHERE MENU_ID = \?/
  )?.[1];

  assert.ok(existingMenuUpdate, 'existing menu metadata should be synchronized');
  assert.doesNotMatch(existingMenuUpdate, /PARENT_ID|SORT_ORDER/);
  assert.match(
    ensureChildMenus,
    /INSERT INTO T_MENU \(MENU_ID, MENU_CODE, NAME, PARENT_ID, MENU_TYPE, PATH, ICON, SORT_ORDER, STATUS\)/
  );
});
