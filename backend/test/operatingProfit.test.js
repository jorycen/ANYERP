const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateOperatingProfit, queryOperatingProfit } = require('../src/modules/report/operatingProfit');
const { RealtimeSqlDashboardDataSource } = require('../src/modules/report/dashboardDataSource');
const { buildRanges } = require('../src/modules/report/dashboardService');

const order = overrides => ({ order_id: 'O', store_id: 'S', store_name: '门店', create_staff_id: 'A', create_user: '员工',
  create_time: '2026-10-01 00:01:32', sales_amount: 1000, base_gross_profit: 100, ...overrides });

test('原销售保留后只冲回一次，审批及退回调整按独立事件各计一次', () => {
  const result = aggregateOperatingProfit([
    order(), order({ order_id: 'return:L', entry_type: 'return', sales_amount: -1000, base_gross_profit: -100 }),
    order({ order_id: 'return-adjustment:R', entry_type: 'return_adjustment', sales_amount: 0, base_gross_profit: 0 })
  ], [{ orderId: 'O', signedAmount: 20 }, { orderId: 'return-adjustment:R', signedAmount: -20 }]);
  assert.equal(result.summary.grossProfit, 0);
  assert.equal(result.summary.salesAmount, 0);
  assert.equal(result.summary.orderCount, 1);
});

test('门店、趋势和公共接口使用同一完整事件集合，不截断100条明细', async () => {
  const rows = Array.from({ length: 150 }, (_, i) => order({ order_id: `O${i}`, base_gross_profit: 1 }));
  const source = new RealtimeSqlDashboardDataSource();
  source.getEmployeeOrderRows = async () => rows;
  source.getApprovedAdjustments = async () => [{ orderId: 'O0', signedAmount: 5 }];
  const filters = { storeIds: ['S'], archiveScope: 'archived' };
  const range = buildRanges({ startDate: '2026-10-01', endDate: '2026-10-25' }).current;
  const canonical = await queryOperatingProfit(filters, range, source);
  const ranking = await source.getStoreRanking(filters, range);
  const trend = await source.getTrend(filters, range, 'day');
  assert.equal(canonical.summary.grossProfit, 155);
  assert.equal(ranking[0].grossProfit, canonical.summary.grossProfit);
  assert.equal(trend.reduce((sum, row) => sum + row.grossProfit, 0), canonical.summary.grossProfit);
});

test('中国时区月初凌晨退货纳入本月，只有退货的门店也保留负毛利', async () => {
  const source = { getEmployeeOrderRows: async () => [order({ order_id: 'return:L', entry_type: 'return', sales_amount: -1,
    base_gross_profit: -2227.27, create_time: new Date('2026-09-30T16:01:32Z') })], getApprovedAdjustments: async () => [] };
  const result = await queryOperatingProfit({ storeIds: ['S'] }, {}, source);
  assert.equal(result.rows[0].grossProfit, -2227.27);
  assert.equal(result.daily[0].bucket, '2026-10-01');
});

test('员工筛选只统计其分配毛利，辅助销售份额总和等于门店', () => {
  const rows = [order({ auxiliary_sales_list: [{ staffId: 'B', name: '辅助' }] })];
  const adjustments = [{ orderId: 'O', signedAmount: 10 }];
  const store = aggregateOperatingProfit(rows, adjustments);
  const a = aggregateOperatingProfit(rows, adjustments, { employeeId: 'A' });
  const b = aggregateOperatingProfit(rows, adjustments, { employeeId: 'B' });
  assert.equal(a.summary.grossProfit + b.summary.grossProfit, store.summary.grossProfit);
  assert.equal(store.summary.grossProfit, 110);
});
