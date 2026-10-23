// Validate existing business tables read-only before deploying new control tables.
const M = require('../src/models');
const originalQuery = M.sequelize.query.bind(M.sequelize);
M.sequelize.query = (sql, options) => {
  if (/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(sql)) throw Error('Read-only verification refused a mutation');
  if (/FROM T_FINANCIAL_PROFIT_(?:REVIEW|PERIOD|ADJUSTMENT)\b/.test(sql) || /FROM T_PRODUCT_PROFIT_INCOME\b/.test(sql)) return Promise.resolve([]);
  return originalQuery(sql, options);
};
(async () => {
  const stores = await M.Store.findAll({ attributes: ['store_id'], where: { is_deleted: 0 }, raw: true });
  const { queryFinancialProfit } = require('../src/modules/report/financialProfitController');
  const report = await queryFinancialProfit({ storeIds: stores.map(row => row.store_id), startDate: '2026-10-01', endDate: '2026-10-23' });
  console.log(JSON.stringify({ scope: 'Pre-migration, control/recognized-policy tables deliberately empty',
    sales: report.items.filter(row => row.entryType === 'sale').length, returns: report.items.filter(row => row.entryType === 'return').length,
    policyCount: report.policyItems.length, expenseCount: report.expenseEntries.length, summary: report.summary }, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => M.sequelize.close());
