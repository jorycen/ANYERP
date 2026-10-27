const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const { getRecentPriceChanges } = require('../src/modules/product/controller');
test('首页旧调用仍返回每商品最近一次的3条摘要，不改变数组结构', async t => {
  t.mock.method(M.sequelize, 'query', async (sql, options) => {
    assert.match(sql, /WHERE product_rank = 1/);
    assert.equal(options.replacements.limit, 3);
    return [{ changeId: 'C1', productId: 'P', oldPrice: '100', currentPrice: '90' }];
  });
  const ctx = { query: {} }; await getRecentPriceChanges(ctx);
  assert.ok(Array.isArray(ctx.body.data));
  assert.equal(ctx.body.data[0].adjustmentAmount, -10);
});
test('分页按真实调价记录查询，同商品不合并，后端返回总数和翻页参数', async t => {
  t.mock.method(M.sequelize, 'query', async (sql, options) => {
    assert.doesNotMatch(sql, /WHERE product_rank = 1/);
    assert.match(sql, /STATUS = 'effective'/);
    assert.match(sql, /OLD_PRICE <> l.NEW_PRICE/);
    if (/SELECT COUNT/.test(sql)) return [{ total: 12 }];
    assert.match(sql, /ORDER BY modifiedAt DESC, changeId DESC/);
    assert.deepEqual(options.replacements, { limit: 10, offset: 10 });
    return [{ changeId: 'C2', productId: 'P', oldPrice: 100, currentPrice: 90 }, { changeId: 'C1', productId: 'P', oldPrice: 90, currentPrice: 95 }];
  });
  const ctx = { query: { page: '2', pageSize: '10' } }; await getRecentPriceChanges(ctx);
  assert.equal(ctx.body.data.total, 12);
  assert.deepEqual(ctx.body.data.list.map(row => row.changeId), ['C2', 'C1']);
  assert.equal(ctx.body.data.list[1].adjustmentAmount, 5);
});
test('无效分页参数安全回退，页面大小限制100', async t => {
  const calls = [];
  t.mock.method(M.sequelize, 'query', async (sql, options) => {
    if (/SELECT COUNT/.test(sql)) return [{ total: 0 }];
    calls.push(options.replacements); return [];
  });
  await getRecentPriceChanges({ query: { page: 'Infinity', pageSize: 'Infinity' } });
  await getRecentPriceChanges({ query: { page: '-1', pageSize: '1000' } });
  assert.deepEqual(calls, [{ limit: 10, offset: 0 }, { limit: 100, offset: 0 }]);
});
