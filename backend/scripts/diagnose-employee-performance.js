const { sequelize } = require('../src/models');
const { getEmployeePerformanceReport, getDashboardFilters, getDashboardOverview } = require('../src/modules/report/controller');

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

async function main() {
  await sequelize.authenticate();
  const ctx = {
    query: {
      page: process.env.REPORT_PAGE || 1,
      pageSize: process.env.REPORT_PAGE_SIZE || 20,
      startDate: process.env.REPORT_START_DATE || '',
      endDate: process.env.REPORT_END_DATE || '',
      storeId: process.env.REPORT_STORE_ID || '',
      staffName: process.env.REPORT_STAFF_NAME || '',
      orderNo: process.env.REPORT_ORDER_NO || ''
    },
    state: {
      user: { roles: ['boss'], roleCode: 'boss', accessibleStoreIds: ['*'] }
    }
  };

  await getEmployeePerformanceReport(ctx);
  const result = {
    listCount: ctx.body?.list?.length || 0,
    total: ctx.body?.pagination?.total || 0,
    employeeCount: ctx.body?.employees?.length || 0,
    summaryReady: Boolean(ctx.body?.summary)
  };

  const filterCtx = { state: ctx.state };
  await getDashboardFilters(filterCtx);
  result.dashboardStoreCount = filterCtx.body?.stores?.length || 0;
  result.dashboardEmployeeCount = filterCtx.body?.employees?.length || 0;

  const today = new Date();
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - (today.getDay() || 7) + 1);
  const overviewCtx = {
    state: ctx.state,
    query: { startDate: dateKey(weekStart), endDate: dateKey(today), granularity: 'day' }
  };
  await getDashboardOverview(overviewCtx);
  result.dashboardOverviewReady = Boolean(overviewCtx.body?.meta);
  console.log(JSON.stringify(result));
}

main()
  .catch(error => {
    console.error(JSON.stringify({
      name: error.name,
      message: error.message,
      databaseMessage: error.parent?.sqlMessage || error.original?.sqlMessage || '',
      code: error.parent?.code || error.original?.code || ''
    }));
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
