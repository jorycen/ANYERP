const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const models = require('../src/models');
const accountingController = require('../src/modules/finance/expenseAccountingController');
const { normalizeAttribution } = require('../src/modules/finance/expenseService');

test('费用模型包含经营归属月份和门店经营利润开关', () => {
  assert.ok(models.Expense.rawAttributes.accounting_month);
  assert.ok(models.Expense.rawAttributes.affects_store_profit);
  assert.ok(models.ExpensePerformanceAllocation.rawAttributes.performance_month);
  assert.ok(models.ExpensePerformanceAllocation.rawAttributes.staff_id);
  assert.ok(models.ExpensePerformanceAllocation.rawAttributes.status);
  assert.ok(models.ExpenseAccountingPeriod.rawAttributes.month_key);
  assert.ok(models.ExpenseAccountingPeriod.rawAttributes.status);
});

test('费用绩效分摊只允许从已确认费用状态进入业务口径', () => {
  for (const status of ['pending_payment', 'pending', 'processing', 'approved', 'paid']) {
    assert.equal(accountingController.RECOGNIZED_EXPENSE_STATUSES.has(status), true);
  }
  for (const status of ['draft', 'pending_approval', 'rejected', 'cancelled']) {
    assert.equal(accountingController.RECOGNIZED_EXPENSE_STATUSES.has(status), false);
  }
});

test('费用经营月份迁移和API路由已注册', () => {
  const migration = fs.readFileSync(require.resolve('../src/utils/dbMigration'), 'utf8');
  const routes = fs.readFileSync(require.resolve('../src/modules/finance/routes'), 'utf8');
  assert.match(migration, /ensureExpenseAccountingSchema/);
  assert.match(migration, /T_EXPENSE_PERFORMANCE_ALLOCATION/);
  assert.match(migration, /T_EXPENSE_ACCOUNTING_PERIOD/);
  assert.match(routes, /performance-allocations/);
  assert.match(routes, /expense-accounting-periods/);
});

test('费用绩效分摊提供按费用所属经销商读取员工选项的接口', () => {
  const routes = fs.readFileSync(require.resolve('../src/modules/finance/routes'), 'utf8');
  assert.match(routes, /performance-staff-options/);
  assert.equal(typeof accountingController.listExpensePerformanceStaffOptions, 'function');
});

test('费用归属支持个人、产品端、返利及多门店平均分摊', () => {
  const personal = normalizeAttribution({
    attributionType: 'PERSONAL', totalAmount: 100, applicantStaffId: 12, applicantName: '张三'
  });
  assert.equal(personal.type, 'PERSONAL');
  assert.deepEqual(personal.details[0], { target_type: 'staff', target_id: '12', target_name: '张三', amount: 100 });

  const stores = normalizeAttribution({
    attributionType: 'STORE', totalAmount: 100, allocationDetails: [{ targetId: 'S1' }, { targetId: 'S2' }]
  });
  assert.deepEqual(stores.details.map(item => item.amount), [50, 50]);

  assert.equal(normalizeAttribution({ attributionType: 'PRODUCT_SIDE', totalAmount: 20 }).details[0].target_name, '产品端');
  assert.throws(() => normalizeAttribution({ attributionType: 'REBATE', totalAmount: 20 }), /供应商/);
});
