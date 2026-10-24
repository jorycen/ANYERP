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
    { categoryId: 'empty', name: '无库存分类', level: 1, showInFinance: 0 },
    { categoryId: 'disabled', name: '选件周边', level: 1, status: 0 },
    { categoryId: 'disabled-stock', name: '停用但有库存', level: 1, status: 0 },
    { categoryId: 'orphan', name: '孤立三级', parentId: 'missing-parent', level: 3, showInFinance: 1 }
  ];
  source.query = async sql => {
    sqls.push(sql);
    if (sql.includes('FROM T_PRODUCT_CATEGORY')) return categories;
    if (sql.includes('GROUP BY ageBucket')) return [];
    if (sql.includes('FROM T_PRODUCT_SN')) return [{ productId: 'used-machine', categoryId: 'used', categoryPath: '电脑/二手', quantity: 2, inventoryAmount: 1234.56 }];
    return [
      { productId: 'mouse', categoryId: 'accessory', quantity: 10, inventoryAmount: 100 },
      { productId: 'unknown', categoryId: 'missing', quantity: 3, inventoryAmount: 30 },
      { productId: 'orphan-stock', categoryId: 'orphan', quantity: 2, inventoryAmount: 20 },
      { productId: 'old-stock', categoryId: 'disabled-stock', quantity: 1, inventoryAmount: 10 },
      { productId: 'legacy', categoryPath: '配件/旧分类', quantity: 1, inventoryAmount: 20 }
    ];
  };
  const result = await source.getInventory({ storeIds: ['S1'], allRootCategories: true, includeDemo: false });
  const byName = new Map(result.categories.map(row => [row.name, row]));
  assert.equal(byName.get('电脑').quantity, 2);
  assert.equal(byName.get('电脑').children[0].name, '二手');
  assert.equal(byName.get('配件').quantity, 11);
  assert.equal(byName.get('配件').amount, 120);
  assert.equal(byName.get('未分类').quantity, 5);
  assert.equal(byName.get('无库存分类').quantity, 0);
  assert.equal(byName.has('选件周边'), false);
  assert.equal(byName.get('停用但有库存').amount, 10);
  assert.equal(result.categories.reduce((sum, row) => sum + row.quantity, 0), result.inventoryQuantity);
  assert.equal(result.categories.reduce((sum, row) => sum + row.amount, 0), result.inventoryAmount);
  assert.ok(result.categories.every(row => row.level === 1));
  assert.ok(!result.categories.some(row => row.name === '孤立三级'));
  assert.ok(sqls.filter(sql => sql.includes('FROM T_PRODUCT_SN') || sql.includes('FROM T_INVENTORY i')).every(sql => sql.includes("= 'care服务'")));
  assert.ok(sqls.filter(sql => sql.includes('FROM T_PRODUCT_SN')).every(sql => sql.includes('ps.STORE_ID IN (:storeIds)') && sql.includes('NOT IN (\'demo_qty\', \'rental_demo_qty\')')));
  assert.ok(!sqls.find(sql => sql.includes('FROM T_PRODUCT_CATEGORY')).includes('WHERE STATUS = 1'));
});

test('legacy full-path categories marked level one never become top-level rows and their stock returns to the real root', async () => {
  const source = new RealtimeSqlDashboardDataSource();
  source.query = async sql => {
    if (sql.includes('FROM T_PRODUCT_CATEGORY')) return [
      { categoryId: 'root', name: '笔记本', level: 1 },
      { categoryId: 'legacy2', name: '笔记本/联想', level: 1 },
      { categoryId: 'legacy3', name: '笔记本/联想/小新', level: 1 },
      { categoryId: 'legacy4', name: '笔记本/联想/小新/Pro', level: 1 }
    ];
    if (sql.includes('FROM T_INVENTORY i')) return [{ productId: 'P', categoryId: 'legacy4', categoryPath: '笔记本/联想/小新/Pro', brand: '联想', series: '小新', model: 'Pro', quantity: 2, inventoryAmount: 10000 }];
    return [];
  };
  const result = await source.getInventory({ storeIds: ['S'], allRootCategories: true });
  assert.deepEqual(result.categories.map(row => row.name), ['笔记本']);
  assert.equal(result.categories[0].amount, result.inventoryAmount);
  assert.equal(result.categories[0].quantity, 2);
  assert.equal(result.categories[0].children[0].name, '联想');
});
