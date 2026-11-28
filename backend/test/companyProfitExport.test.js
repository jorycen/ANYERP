const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { sequelize } = require('../src/models');
const C = require('../src/modules/report/financialProfitController');
test('Excel exports all company details despite page size and preserves zero versus unknown', async t => {
  t.mock.method(sequelize, 'query', async () => []);
  const profitDetails = [0, null, -113].map((value, index) => ({ entryNo: `N${index}`, entryType: 'sale',
    costState: value === null ? 'pending' : value === 0 ? 'confirmed_zero' : 'known', salesGrossProfit: value,
    productGrossProfit: 0, operationsGrossProfit: 0, companyGrossProfit: value, grossCost: value, bookCost: value === -113 ? -100 : value }));
  t.mock.method(require('../src/modules/report/financialProfitEngine'), 'query', async () => ({
    profitDetails, items: [], policyItems: [], expenseEntries: [], discrepancies: [], summary: { companyGrossProfit: null } }));
  const ctx = { query: { page: '1', pageSize: '1', startDate: '2026-10-01', endDate: '2026-10-29' },
    state: { user: { accessibleStoreIds: ['s'], role: 'finance' } }, set() {} };
  await C.exportFinancialProfitOrders(ctx);
  const book = XLSX.read(ctx.body, { type: 'buffer' });
  assert.ok(book.SheetNames.includes('利润明细'));
  assert.ok(book.SheetNames.includes('毛利汇总'));
  assert.ok(book.SheetNames.includes('销售退货及调整'));
  const rows = XLSX.utils.sheet_to_json(book.Sheets['利润明细']);
  assert.equal(rows.length, 3);
  assert.equal(rows[0]['含税成本'], 0);
  assert.equal(rows[0]['公司经营毛利'], 0);
  assert.equal(rows[1]['含税成本'], '待核算');
  assert.equal(rows[1]['公司经营毛利'], '待核算');
  assert.equal(rows[0]['不含税成本'], 0);
  assert.equal(rows[1]['不含税成本'], '待核算');
  assert.equal(rows[2]['不含税成本'], -100);
});
