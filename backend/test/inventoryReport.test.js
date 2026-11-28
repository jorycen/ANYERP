const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../src/modules/report/controller');

test('库存报表汇总成本及库龄超过30天的滞销率', () => {
  const result = _test.buildInventoryReportMetrics([
    { category: '电脑', totalCount: '8', totalCost: '40000.126', staleCount: '2' },
    { category: '手机', totalCount: '2', totalCost: '6000.004', staleCount: '1' }
  ]);

  assert.equal(result.rows[0].totalCost, 40000.13);
  assert.equal(result.rows[0].staleRate, 25);
  assert.deepEqual(result.summary, {
    totalCount: 10,
    totalCost: 46000.13,
    staleCount: 3,
    staleRate: 30
  });
});

test('库存为空时滞销率为0', () => {
  const result = _test.buildInventoryReportMetrics([]);
  assert.equal(result.summary.totalCost, 0);
  assert.equal(result.summary.staleRate, 0);
});

test('库存报表严格按照分类管理树的排序展示', () => {
  const categories = [
    { category_id: 'phone', parent_id: null, name: '手机', level: 1, sort_order: 2, status: 1 },
    { category_id: 'computer', parent_id: null, name: '电脑', level: 1, sort_order: 1, status: 1 },
    { category_id: 'brand-b', parent_id: 'computer', name: '品牌B', level: 2, sort_order: 2, status: 1 },
    { category_id: 'brand-a', parent_id: 'computer', name: '品牌A', level: 2, sort_order: 1, status: 1 },
    { category_id: 'series-2', parent_id: 'brand-a', name: '系列2', level: 3, sort_order: 2, status: 1 },
    { category_id: 'series-1', parent_id: 'brand-a', name: '系列1', level: 3, sort_order: 1, status: 1 }
  ];
  const rows = [
    { category: '手机', brand: '品牌C', series: '', model: '' },
    { category: '电脑', brand: '品牌B', series: '', model: '' },
    { category: '电脑', brand: '品牌A', series: '系列2', model: '' },
    { category: '电脑', brand: '品牌A', series: '系列1', model: '' }
  ];

  const sorted = _test.sortInventoryCategoryStats(rows, categories);
  assert.deepEqual(sorted.map(row => [row.category, row.brand, row.series]), [
    ['电脑', '品牌A', '系列1'],
    ['电脑', '品牌A', '系列2'],
    ['电脑', '品牌B', ''],
    ['手机', '品牌C', '']
  ]);
});
