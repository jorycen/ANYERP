const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../src/modules/finance/expenseAmortization');
const M = require('../src/models');
const E = require('../src/modules/report/financialProfitEngine');
const { calculateOrder } = require('../src/modules/report/financialProfitController');

test('startup adds amortization columns idempotently and refuses readiness after failed DDL, without rewriting expense data', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../src/utils/dbMigration'), 'utf8');
  const helper = source.slice(source.indexOf('async function ensureExpenseAmortizationSchema()'), source.indexOf('async function ensureExpenseRecipientSchema()'));
  const calls = []; let fail = false;
  const ensure = vm.runInNewContext(`${helper}; ensureExpenseAmortizationSchema`, {
    checkAndAddColumn: async (...args) => { calls.push(args); },
    sequelize: { query: async sql => { calls.push(sql); if (fail) throw new Error('missing column'); } }
  });
  await ensure();
  assert.equal(calls[0][1], 'AMORTIZATION_START_MONTH'); assert.equal(calls[1][1], 'AMORTIZATION_END_MONTH');
  assert.match(calls[2], /^SELECT AMORTIZATION_START_MONTH/);
  fail = true; await assert.rejects(ensure(), /missing column/);
  assert.match(source.slice(source.indexOf('async function runSchemaMigrations()'), source.indexOf('async function ensureSalesCashRebateSchema()')), /await ensureExpenseAmortizationSchema\(\)/);
});

test('annual rent is split by month and approved store shares, with cent-level conservation', () => {
  const rows = A.splitSchedule([{ target_id: 'A', amount: 72000 }, { target_id: 'B', amount: 48000 }], '2026-01', '2026-12');
  assert.equal(rows.length, 12);
  assert.ok(rows.every(row => row.amount === 10000 && row.allocations[0].amount === 6000 && row.allocations[1].amount === 4000));
  for (let cents = 1; cents <= 111; cents++) {
    const shares = [Math.floor(cents / 3), cents - Math.floor(cents / 3)].map(amount => ({ amount: amount / 100 }));
    const schedule = A.splitSchedule(shares, '2026-10', '2027-03');
    assert.equal(schedule.reduce((sum, row) => sum + Math.round(row.amount * 100), 0), cents);
    shares.forEach((share, i) => assert.equal(schedule.reduce((sum, row) => sum + Math.round(row.allocations[i].amount * 100), 0), Math.round(share.amount * 100)));
    assert.ok(Math.max(...schedule.map(row => row.amount)) - Math.min(...schedule.map(row => row.amount)) <= 0.0100001);
  }
  assert.throws(() => A.monthsBetween('2026-13', '2027-01'), /有效/);
  assert.throws(() => A.monthsBetween('2027-01', '2026-01'), /有效/);
});

test('monthly query includes only the covered month; electricity remains a single original-period charge', () => {
  const rent = { expenseId: 'R', sourceStoreId: 'A', amount: 12000, businessDate: '2026-01-01', amortizationStartMonth: '2026-01', amortizationEndMonth: '2026-12', attributionDetails: [] };
  const rows = A.expandExpenseRows([rent], { dateMode: 'financial_period', startDate: '2026-10-01', endDate: '2026-10-31' });
  assert.equal(rows.length, 1); assert.equal(rows[0].amount, 1000); assert.equal(rows[0].businessDate, '2026-10-01');
  assert.equal(A.expenseEventKey({ ...rows[0], storeId: 'A' }), 'expense:R:A:2026-10');
  assert.equal(A.expandExpenseRows([rent], { dateMode: 'date', startDate: '2026-10-02', endDate: '2026-10-02' }).length, 0);
  const electricity = { expenseId: 'E', amount: 300, businessDate: '2026-10-10' };
  assert.deepEqual(A.expandExpenseRows([electricity], { dateMode: 'financial_period' }), [electricity]);
  assert.equal(A.expenseEventKey({ expenseId: 'E', storeId: 'A' }), 'expense:E:A');
});

test('company and per-store profit share the same monthly expense facts without distributing unallocated company fees', async t => {
  const stores = [{ storeId: 'A', storeName: '门店A', distributorId: 'D' }, { storeId: 'B', storeName: '门店B', distributorId: 'D' }];
  t.mock.method(M.sequelize, 'query', async sql => {
    if (sql.includes('FROM T_STORE')) return stores;
    if (sql.includes('FROM T_EXPENSE e')) return [
      { expenseId: 'R', expenseType: '房租', sourceStoreId: 'A', distributorId: 'D', amount: 12000, businessDate: '2026-01-01', amortizationStartMonth: '2026-01', amortizationEndMonth: '2026-12', attributionType: 'STORE', attributionDetails: JSON.stringify([{ target_type: 'store', target_id: 'A', amount: 7200 }, { target_type: 'store', target_id: 'B', amount: 4800 }]) },
      { expenseId: 'C', expenseType: '公司管理费', sourceStoreId: 'A', distributorId: 'D', amount: 2400, businessDate: '2026-01-01', amortizationStartMonth: '2026-01', amortizationEndMonth: '2026-12', attributionType: 'COMPANY', attributionDetails: JSON.stringify([{ target_type: 'distributor', target_id: 'D', amount: 2400 }]) },
      { expenseId: 'E', expenseType: '电费', sourceStoreId: 'A', distributorId: 'D', amount: 50, businessDate: '2026-10-01', attributionType: 'STORE', attributionDetails: '[]' }
    ];
    return [];
  });
  const report = await E.query({ storeIds: ['A', 'B'], startDate: '2026-10-01', endDate: '2026-10-31', includeStores: true }, calculateOrder);
  assert.equal(report.summary.operatingExpense, 1250);
  assert.equal(report.summary.estimatedOperatingProfit, -1250);
  assert.equal(report.summary.companyExpense, 200);
  assert.equal(report.storeSummaries[0].summary.operatingExpense, 650);
  assert.equal(report.storeSummaries[1].summary.operatingExpense, 400);
  assert.equal(report.expenseEntries.filter(row => row.expenseId === 'R').length, 2);
  assert.equal(new Set(report.expenseEntries.map(row => row.eventKey)).size, report.expenseEntries.length);
});

test('amortization changes enforce source-store scope, closed periods, original electricity month and audit', async t => {
  const tx = { LOCK: { UPDATE: 'UPDATE' } }, writes = [], logs = [];
  let closed = false;
  const expense = { expense_id: 'R', expense_no: 'EXP1', expense_type: '房租', is_deleted: 0, store_id: 'A', distributor_id: 'D',
    status: 'paid', accounting_month: '2026-09', attribution_type: 'STORE', attribution_details_json: '[]',
    update: async value => { writes.push(value); Object.assign(expense, value); } };
  t.mock.method(M.sequelize, 'transaction', async fn => fn(tx));
  t.mock.method(M.Expense, 'findByPk', async () => expense);
  t.mock.method(M.Store, 'findAll', async options => { assert.equal(options.lock, 'UPDATE'); return [{ store_id: 'A', distributor_id: 'D' }]; });
  t.mock.method(M.ExpenseAccountingPeriod, 'findOne', async () => null);
  t.mock.method(M.sequelize, 'query', async () => closed ? [{ MONTH_KEY: '2026-09' }] : []);
  t.mock.method(M.BusinessActionLog, 'create', async value => { logs.push(value); return value; });
  const ctx = { params: { id: 'R' }, request: { body: { startMonth: '2026-10', endMonth: '2026-12', reason: '按租赁合同覆盖月份分摊' } },
    state: { user: { staffId: 1, roles: ['finance'], accessibleStoreIds: ['B'] } },
    throw(status, message) { throw Object.assign(new Error(message), { status }); } };
  await assert.rejects(A.update(ctx), { status: 403 });
  ctx.state.user.accessibleStoreIds = ['A']; closed = true;
  await assert.rejects(A.update(ctx), /已关账/); assert.equal(writes.length, 0);
  closed = false; expense.expense_type = '电费';
  await assert.rejects(A.update(ctx), /电费/); assert.equal(writes.length, 0);
  expense.expense_type = '房租'; await A.update(ctx);
  assert.equal(writes[0].amortization_start_month, '2026-10'); assert.equal(logs.length, 1);
  assert.equal(logs[0].action, 'update_amortization');
  expense.status = 'approved'; closed = true;
  await assert.rejects(require('../src/modules/finance/expenseService').cancelExpenseRecord(expense, ctx.state.user, tx), /已关账/);
});
