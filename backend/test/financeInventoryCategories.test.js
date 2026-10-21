const test = require('node:test');
const assert = require('node:assert/strict');
const { RealtimeSqlDashboardDataSource } = require('../src/modules/report/dashboardDataSource');

test('finance inventory includes all root categories and unclassified stock exactly once', async () => {
  const source = new RealtimeSqlDashboardDataSource();
  const sqls = [];
  const categories = [
    { categoryId: 'computer', name: '电脑', level: 1, showInFinance: 1 },
    { categoryId: 'used', name: '二手', parentId: 'computer', level: 2, showInFinance: 1 },
    { categoryId: 'accessory', name: '配件', level: 1, showInFinance: 0 },
    { categoryId: 'empty', name: '无库存分类', level: 1, showInFinance: 0 }
  ];
  source.query = async sql => {
    sqls.push(sql);
    if (sql.includes('FROM T_PRODUCT_CATEGORY')) return categories;
    if (sql.includes('GROUP BY ageBucket')) return [];
    if (sql.includes('FROM T_PRODUCT_SN')) return [{ productId: 'used-machine', categoryId: 'used', categoryPath: '电脑/二手', quantity: 2, inventoryAmount: 1234.56 }];
    return [
      { productId: 'mouse', categoryId: 'accessory', quantity: 10, inventoryAmount: 100 },
      { productId: 'unknown', categoryId: 'missing', quantity: 3, inventoryAmount: 30 },
      { productId: 'legacy', categoryPath: '配件/旧分类', quantity: 1, inventoryAmount: 20 }
    ];
  };
  const result = await source.getInventory({ storeIds: ['S1'], allRootCategories: true, includeDemo: false });
  const byName = new Map(result.categories.map(row => [row.name, row]));
  assert.equal(byName.get('电脑').quantity, 2);
  assert.equal(byName.get('电脑').children[0].name, '二手');
  assert.equal(byName.get('配件').quantity, 11);
  assert.equal(byName.get('配件').amount, 120);
  assert.equal(byName.get('未分类').quantity, 3);
  assert.equal(byName.get('无库存分类').quantity, 0);
  assert.equal(result.categories.reduce((sum, row) => sum + row.quantity, 0), result.inventoryQuantity);
  assert.equal(result.categories.reduce((sum, row) => sum + row.amount, 0), result.inventoryAmount);
  assert.ok(result.categories.every(row => row.level === 1));
  assert.ok(sqls.filter(sql => sql.includes('FROM T_PRODUCT_SN')).every(sql => sql.includes('ps.STORE_ID IN (:storeIds)') && sql.includes('NOT IN (\'demo_qty\', \'rental_demo_qty\')')));
  assert.ok(!sqls.find(sql => sql.includes('FROM T_PRODUCT_CATEGORY')).includes('WHERE STATUS = 1'));
});
