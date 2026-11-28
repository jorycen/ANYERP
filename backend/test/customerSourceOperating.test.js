const test = require('node:test');
const assert = require('node:assert/strict');
const { Order, ProductCategory, SalesReturnRequest } = require('../src/models');
const { DashboardService } = require('../src/modules/report/dashboardService');
const operating = require('../src/modules/report/operatingProfit');
const report = require('../src/modules/report/controller');

const event = fields => ({
  store_id: 'S', store_name: '门店', create_time: '2026-11-20 09:00:00',
  create_staff_id: 'A', create_user: '员工', sales_amount: 0, base_gross_profit: 0, ...fields
});

test('来源汇总、门店图表与明细复用经营流水，退货和调整归原订单来源', async t => {
  const orders = [
    event({ order_id: '1', sales_amount: 100, base_gross_profit: 20 }),
    event({ order_id: 'return:2', source_order_id: '2', entry_type: 'return', sales_amount: -35, base_gross_profit: -7 }),
    event({ order_id: 'return-adjustment:3', source_order_id: '2', entry_type: 'return_adjustment' }),
    event({ order_id: '4', sales_amount: 25, base_gross_profit: 4 }),
    event({ order_id: 'reward:5', entry_type: 'reward_redemption', sales_amount: 5, base_gross_profit: -2 })
  ];
  const adjustments = [{ orderId: 'return-adjustment:3', signedAmount: -3 }];
  let received;
  t.mock.method(operating, 'loadOperatingEvents', async (filters, range) => {
    received = { filters, range };
    return { orders, adjustments };
  });
  t.mock.method(Order, 'findAll', async () => [
    { order_id: '1', customer_source: '线下' },
    { order_id: '2', customer_source: '线下', customer_source_detail: '路过' },
    { order_id: '4', customer_source: ' ' }
  ]);
  t.mock.method(ProductCategory, 'findAll', async () => []);
  t.mock.method(SalesReturnRequest, 'findAll', async () => [{ order_id: '1' }]);
  const context = (query = {}, roleCode = 'finance') => ({
    query: { dimension: 'store', storeId: 'S', startDate: '2026-11-01', endDate: '2026-11-30', productLine: '电脑', ...query },
    state: { user: { roleCode, staffId: 'A', accessibleStoreIds: ['S'] } }
  });
  const ctx = context();
  await report.getCustomerSourceAnalysis(ctx);
  const { summary, sourceDistribution, chartRows } = ctx.body;
  const canonical = operating.aggregateOperatingProfit(orders, adjustments).summary;
  assert.equal(received.filters.productLine, '电脑');
  assert.equal(received.filters.archiveScope, 'archived');
  assert.equal(summary.salesAmount, canonical.salesAmount);
  assert.equal(summary.grossProfit, canonical.grossProfit);
  assert.equal(summary.orderCount, canonical.orderCount);
  assert.equal(summary.afterSalesOrderCount, 1);
  assert.deepEqual(sourceDistribution.map(({ customerSource, salesAmount, grossProfit }) => [customerSource, salesAmount, grossProfit]),
    [['线下', 65, 10], ['未填写来源', 25, 4], ['积分兑换', 5, -2]]);
  assert.deepEqual(chartRows[0].sources['线下'], { salesAmount: 65, grossProfit: 10, orderCount: 1 });
  const detail = context({ customerSource: '线下', sourceDetail: '路过' });
  await report.getCustomerSourceDetail(detail);
  assert.deepEqual(detail.body.rows.map(row => [row.entryType, row.salesAmount, row.grossProfit]),
    [['return', -35, -7], ['return_adjustment', 0, -3]]);
  const restricted = context({}, 'clerk');
  await report.getCustomerSourceAnalysis(restricted);
  assert.equal(received.filters.employeeId, 'A');
  assert.equal(restricted.body.canViewProfit, true);
  delete restricted.state.user.staffId;
  await report.getCustomerSourceAnalysis(restricted);
  assert.equal(restricted.body.summary.grossProfit, null);
  assert.equal(restricted.body.sourceDistribution[0].grossProfit, null);
  assert.equal(restricted.body.chartRows[0].grossProfit, null);
});

test('区域筛选与总览共用权限范围，空区域不读取经营流水', async () => {
  const service = new DashboardService({ query: async () => [] });
  const filters = await service.resolveOperatingFilters({ role: 'boss', accessibleStoreIds: ['S'] }, { regionId: 'R' });
  assert.deepEqual(filters.storeIds, []);
  const source = { getEmployeeOrderRows() { throw new Error('空区域不应查询'); } };
  assert.deepEqual(await operating.loadOperatingEvents(filters, {}, source), { orders: [], adjustments: [] });
  await assert.rejects(service.resolveOperatingFilters({ role: 'boss', accessibleStoreIds: ['S'] }, { storeId: 'other' }), { status: 403 });
});
