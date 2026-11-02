const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureFocusCategoryColumn } = require('../src/utils/focusCategoryMigration');
const { DashboardService } = require('../src/modules/report/dashboardService');
const models = require('../src/models');
const controller = require('../src/modules/product/controller');
const ctx = body => ({ request: { body }, params: { categoryId: 'leaf' }, throw(status, message) { throw Object.assign(Error(message), { status }); } });

test('category update persists focus switch, omission preserves it, and invalid values are rejected', async t => {
  let saved;
  t.mock.method(models.ProductCategory, 'findByPk', async () => ({ name: 'Leaf', status: 1, update: async values => { saved = values; } }));
  await controller.updateCategory(ctx({ isFocusCategory: true }));
  assert.equal(saved.is_focus_category, 1);
  await controller.updateCategory(ctx({ sortOrder: 4 }));
  assert.equal(Object.hasOwn(saved, 'is_focus_category'), false);
  await controller.updateCategory(ctx({ isFocusCategory: false }));
  assert.equal(saved.is_focus_category, 0);
  await assert.rejects(controller.updateCategory(ctx({ isFocusCategory: 'false' })), { status: 400 });
});

test('focus column migration is idempotent and fails on unavailable schema', async () => {
  let exists = false, alters = 0;
  const db = { query: async sql => {
    if (sql.startsWith('ALTER')) { alters++; exists = true; return []; }
    return [exists ? [{ COLUMN_NAME: 'IS_FOCUS_CATEGORY' }] : []];
  } };
  await ensureFocusCategoryColumn(db); await ensureFocusCategoryColumn(db);
  assert.equal(alters, 1);
  await assert.rejects(ensureFocusCategoryColumn({ query: async sql => {
    if (sql.startsWith('ALTER')) throw Error('DDL denied');
    return [[]];
  } }), /DDL denied/);
});

test('overview uses saved categories rather than request selections and reuses full product ranking results', async () => {
  const categories = [
    { categoryId: 'root', name: 'Root', isFocusCategory: 1 },
    { categoryId: 'leaf', parentId: 'root', name: 'Leaf', isFocusCategory: 1 },
    { categoryId: 'other', name: 'Other', isFocusCategory: 0 },
    { categoryId: 'zero', name: 'Zero', isFocusCategory: 1 }
  ];
  const source = { query: async () => categories,
    getProductRows: async () => Array.from({ length: 12 }, (_, index) => ({ productId: String(index), categoryId: 'leaf', categoryPath: 'stale', quantity: 1, salesAmount: 10.01, grossProfit: -0.11 })),
    getInventory: async () => ({ inventoryQuantity: 0, inventoryAmount: 0, ageStructure: [], staleProducts: [] }) };
  for (const method of ['getTrend', 'getStoreRanking', 'getStoreProductTypeQuantities', 'getProductLineRows', 'getProductCategoryRows', 'getEmployeeOrderRows', 'getApprovedAdjustments']) source[method] = async () => [];
  const service = new DashboardService(source);
  const run = (roles, staffId) => service.buildOverview({ roles, staffId, accessibleStoreIds: ['S1'] }, { focusCategoryPaths: '["Other"]' });
  const result = await run(['boss'], 'ADMIN');
  const rows = result.productAnalysis.focusCategories;
  assert.deepEqual(rows.map(row => row.categoryPath), ['Root', 'Root/Leaf', 'Zero']);
  assert.equal(rows[0].quantity, 12);
  assert.equal(rows[0].salesAmount, 120.12);
  assert.equal(rows[0].grossProfit, -1.32);
  assert.equal(rows[1].salesAmount, rows[0].salesAmount);
  assert.equal(rows[2].grossProfit, 0);
  assert.equal(result.productAnalysis.salesTop10.length, 10);
  const hidden = await run(['sales']);
  assert.equal(hidden.meta.canViewProfit, false);
  assert.ok(hidden.productAnalysis.focusCategories.every(row => row.grossProfit === null));
});
