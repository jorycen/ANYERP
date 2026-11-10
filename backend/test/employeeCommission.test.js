const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/modules/report/employeeCommission');
test('missing personal configuration stays unknown', () => {
  assert.equal(C.estimateStaffCommission(10000, null), null);
  assert.equal(C.estimateStaffCommission(10000, ''), null);
});
test('staff tiers retain the explicitly confirmed formula', () => {
  assert.equal(C.estimateStaffCommission(1000, 1000), 0);
  assert.equal(C.estimateStaffCommission(1200, 1000), 60);
  assert.equal(C.estimateStaffCommission(1500, 1000), 0);
  assert.equal(C.estimateStaffCommission(2000, 1000), 250);
});
test('manager exceptions and special store rates', () => {
  const config = { commissionBase: 1000, breakEvenLine: 1000 };
  assert.equal(C.employeeEstimate({ employeeName: '卢珏', isManager: true }, 2000, 10000, config).rule, 'staff');
  assert.equal(C.employeeEstimate({ employeeName: '石高铭', isManager: true }, 2000, 10000, config).storeCommission, 500);
  assert.equal(C.employeeEstimate({ employeeName: '其他', isManager: true }, 2000, 10000, config).performanceEstimate, 700);
});
