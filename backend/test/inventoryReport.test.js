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
