// 经营毛利唯一来源：原销售冻结毛利 + 审批调整 + 按发生期入账的退货/调整冲回。
// 不把实采/税务财务核算结果、产品端收益或厂家返利再叠加到销售考核毛利。
const money = value => Math.round(Number(value || 0) * 100) / 100;

function aggregateOperatingProfit(orders, adjustments, filters = {}) {
  const orderMap = new Map(orders.map(row => [String(row.order_id), row]));
  const stores = new Map();
  const get = (id, name) => {
    const key = String(id);
    if (!stores.has(key)) stores.set(key, { storeId: key, storeName: name || key, salesAmount: 0, baseGrossProfit: 0, approvedAdjustment: 0, grossProfit: 0, orderCount: 0 });
    return stores.get(key);
  };
  for (const order of orders) {
    const store = get(order.store_id, order.store_name);
    store.salesAmount += Number(order.sales_amount || 0);
    store.baseGrossProfit += Number(order.base_gross_profit || 0);
    if (!order.entry_type) store.orderCount++;
  }
  for (const adjustment of adjustments) {
    const order = orderMap.get(String(adjustment.orderId));
    if (order) get(order.store_id, order.store_name).approvedAdjustment += Number(adjustment.signedAmount || 0);
  }
  if (filters.employeeId) {
    const { buildEmployeePerformance } = require('./dashboardService');
    for (const store of stores.values()) {
      const subset = orders.filter(row => String(row.store_id) === store.storeId);
      const keys = new Set(subset.map(row => String(row.order_id)));
      const ranking = buildEmployeePerformance(subset, adjustments.filter(row => keys.has(String(row.orderId))), filters.employeeId, true).ranking;
      store.salesAmount = ranking.reduce((sum, row) => sum + Number(row.salesAmount), 0);
      store.baseGrossProfit = ranking.reduce((sum, row) => sum + Number(row.baseGrossProfit), 0);
      store.approvedAdjustment = ranking.reduce((sum, row) => sum + Number(row.approvedAdjustment), 0);
    }
  }
  const rows = [...stores.values()].map(row => ({ ...row, salesAmount: money(row.salesAmount),
    baseGrossProfit: money(row.baseGrossProfit), approvedAdjustment: money(row.approvedAdjustment),
    grossProfit: money(row.baseGrossProfit + row.approvedAdjustment) }));
  const summary = rows.reduce((sum, row) => {
    for (const key of ['salesAmount', 'baseGrossProfit', 'approvedAdjustment', 'grossProfit', 'orderCount']) sum[key] = money(sum[key] + row[key]);
    return sum;
  }, { salesAmount: 0, baseGrossProfit: 0, approvedAdjustment: 0, grossProfit: 0, orderCount: 0 });
  return { rows, summary, source: 'OPERATING_FROZEN_EVENTS_V1' };
}

async function queryOperatingProfit(filters, range, source) {
  const { RealtimeSqlDashboardDataSource } = require('./dashboardDataSource');
  const dataSource = source || new RealtimeSqlDashboardDataSource();
  const [orders, adjustments] = await Promise.all([
    dataSource.getEmployeeOrderRows(filters, range), dataSource.getApprovedAdjustments(filters, range)
  ]);
  const result = aggregateOperatingProfit(orders, adjustments, filters);
  const groups = new Map();
  for (const order of orders) {
    const value = order.create_time;
    const key = typeof value === 'string' && !/[zZ]|[+]\d\d:\d\d$/.test(value)
      ? value.slice(0, 10) : new Date(new Date(value).getTime() + 28800000).toISOString().slice(0, 10);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(order);
  }
  result.daily = [...groups].map(([bucket, rows]) => {
    const keys = new Set(rows.map(row => String(row.order_id)));
    return { bucket, ...aggregateOperatingProfit(rows, adjustments.filter(row => keys.has(String(row.orderId))), filters).summary };
  }).sort((a, b) => a.bucket.localeCompare(b.bucket));
  return result;
}

async function getOperatingProfit(ctx) {
  const { resolveFilters } = require('./financialProfitController');
  const { buildRanges, canViewProfit } = require('./dashboardService');
  const { isSelfOnlyReportUser } = require('../../utils/storePermissions');
  const filters = await resolveFilters(ctx);
  const scoped = { storeIds: filters.storeIds, archiveScope: 'archived',
    employeeId: isSelfOnlyReportUser(ctx.state.user) ? String(ctx.state.user.staffId || '') : '' };
  const result = await queryOperatingProfit(scoped, buildRanges(filters).current);
  const visible = canViewProfit(ctx.state.user);
  ctx.body = { code: 0, data: { source: result.source, startDate: filters.startDate, endDate: filters.endDate,
    rows: result.rows.map(row => visible ? row : { ...row, grossProfit: null, baseGrossProfit: null, approvedAdjustment: null }),
    summary: visible ? result.summary : { ...result.summary, grossProfit: null, baseGrossProfit: null, approvedAdjustment: null } } };
}

module.exports = { getOperatingProfit, aggregateOperatingProfit, queryOperatingProfit };
