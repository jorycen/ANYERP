// Read-only refresh/audit of realtime October statistics; never rewrite snapshots.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sequelize, Store } = require('../src/models');
const { RealtimeSqlDashboardDataSource } = require('../src/modules/report/dashboardDataSource');
const { buildRanges, buildEmployeePerformance } = require('../src/modules/report/dashboardService');
const { aggregateOperatingProfit } = require('../src/modules/report/operatingProfit');
const money = n => Math.round(Number(n) * 100) / 100;

async function main() {
  const stores = await Store.findAll({ attributes: ['store_id'], raw: true });
  const filters = { storeIds: stores.map(row => row.store_id), archiveScope: 'archived' };
  const range = buildRanges({ startDate: '2026-10-01', endDate: '2026-10-31' }).current;
  const source = new RealtimeSqlDashboardDataSource();
  const rows = await source.getEmployeeOrderRows(filters, range);
  const adjustments = await source.getApprovedAdjustments(filters, range);
  const sales = rows.filter(row => !row.entry_type);
  const ids = sales.map(row => row.order_id);
  const [facts] = ids.length ? await sequelize.query(`
    SELECT o.ORDER_ID AS orderId, o.TOTAL_AMOUNT AS amount,
      COALESCE(SUM(CASE WHEN os.AMOUNT_TYPE = 'decrease' THEN -os.AMOUNT ELSE os.AMOUNT END), 0) AS supplement
    FROM T_ORDER o LEFT JOIN T_ORDER_SUPPLEMENT os
      ON os.ORDER_ID = o.ORDER_ID AND os.IS_DELETED = 0
    WHERE o.ORDER_ID IN (:ids) GROUP BY o.ORDER_ID, o.TOTAL_AMOUNT`, { replacements: { ids } }) : [[]];
  const factMap = new Map(facts.map(row => [row.orderId, row]));
  let previousPositive = 0;
  let correctedPositive = 0;
  let changedOrders = 0;
  for (const row of sales) {
    const fact = factMap.get(row.order_id);
    assert.ok(fact, `Missing order ${row.order_id}`);
    assert.equal(money(row.sales_amount), money(fact.amount), `Sales amount mismatch ${row.order_id}`);
    correctedPositive += Number(fact.amount);
    previousPositive += money(Number(fact.amount) - Number(fact.supplement));
    if (money(fact.supplement)) changedOrders++;
  }
  const legacyRows = rows.map(row => row.entry_type ? row : {
    ...row, sales_amount: money(Number(factMap.get(row.order_id).amount) - Number(factMap.get(row.order_id).supplement))
  });
  const corrected = aggregateOperatingProfit(rows, adjustments);
  const legacy = aggregateOperatingProfit(legacyRows, adjustments);
  assert.equal(corrected.summary.grossProfit, legacy.summary.grossProfit);
  const dailyRows = rows.filter(row => new Date(row.create_time).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }) === '2026-10-26');
  const today = buildEmployeePerformance(dailyRows, adjustments, '17', true);
  const oldToday = buildEmployeePerformance(legacyRows.filter(row => dailyRows.some(day => day.order_id === row.order_id)), adjustments, '17', true);
  const employee = today.ranking.find(row => String(row.staffId) === '17');
  assert.equal(employee.salesAmount, 2019);
  const report = {
    generatedAt: new Date().toISOString(), range: { startDate: '2026-10-01', endDate: '2026-10-31', timeZone: 'Asia/Shanghai' },
    mode: 'read_only_realtime_requery', persistedRowsChanged: 0,
    positiveOrdersChecked: sales.length, ordersWithSalesCorrection: changedOrders,
    previousPositiveSales: money(previousPositive), correctedPositiveSales: money(correctedPositive),
    previousSummary: legacy.summary, correctedSummary: corrected.summary,
    salesDifference: money(corrected.summary.salesAmount - legacy.summary.salesAmount),
    stores: corrected.rows,
    employee17Today: { previousSalesAmount: oldToday.ranking.find(row => String(row.staffId) === '17')?.salesAmount,
      correctedSalesAmount: employee.salesAmount, orderCount: employee.participatedOrderCount,
      grossProfit: employee.grossProfit }
  };
  const output = path.resolve(__dirname, '../../docs/october-2026-sales-statistics-audit.json');
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, stores: undefined, output }, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => sequelize.close());
