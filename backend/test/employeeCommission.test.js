const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/modules/report/employeeCommission');
test('missing personal configuration stays unknown', () => {
  assert.equal(C.estimateStaffCommission(10000, null), null);
  assert.equal(C.estimateStaffCommission(10000, ''), null);
});
test('staff commission increases on profit above the personal base', () => {
  assert.equal(C.estimateStaffCommission(1000, 1000), 0);
  assert.equal(C.estimateStaffCommission(1200, 1000), 40);
  assert.equal(C.estimateStaffCommission(1500, 1000), 100);
  assert.equal(C.estimateStaffCommission(2000, 1000), 250);
});
test('Heshenghui staff examples and tier boundary remain continuous', () => {
  assert.equal(C.estimateStaffCommission(12893.39, 9000), 778.68);
  assert.equal(C.estimateStaffCommission(9447.82, 9000), 89.56);
  assert.equal(C.estimateStaffCommission(8999.99, 9000), 0);
  assert.equal(C.estimateStaffCommission(9000, 9000), 0);
  assert.equal(C.estimateStaffCommission(13499.99, 9000), 900);
  assert.equal(C.estimateStaffCommission(13500, 9000), 900);
  assert.equal(C.estimateStaffCommission(13501, 9000), 900.3);
  assert.equal(C.estimateStaffCommission(0, 0), 0);
  assert.equal(C.estimateStaffCommission(100, 0), 30);
});
test('manager exceptions and special store rates', () => {
  const config = { commissionBase: 1000, breakEvenLine: 1000 };
  assert.equal(C.employeeEstimate({ employeeName: '卢珏', isManager: true }, 2000, 10000, config).rule, 'staff');
  assert.equal(C.employeeEstimate({ employeeName: '石高铭', isManager: true }, 2000, 10000, config).storeCommission, 500);
  assert.equal(C.employeeEstimate({ employeeName: '其他', isManager: true }, 2000, 10000, config).performanceEstimate, 800);
});
test('store total selects one rate for the entire manager personal profit', () => {
  assert.equal(C.estimateManagerCommission(2000, 10000, 9999).personal, 300);
  assert.equal(C.estimateManagerCommission(2000, 10000, 10000).personal, 300);
  assert.equal(C.estimateManagerCommission(2000, 10000, 10001).personal, 500);
  // Personal profit exceeding the store line does not select the 25% rate.
  assert.equal(C.estimateManagerCommission(12000, 10000, 9999).personal, 1800);
});
test('configured line with pending store total is pending accounting, not missing configuration', () => {
  const r = C.employeeEstimate({ employeeName: '石高铭', isManager: true }, 31858.29, null, {breakEvenLine:100000});
  assert.equal(r.status, 'pending'); assert.equal(r.reason, '门店销售端毛利待核算'); assert.equal(r.performanceEstimate, null);
  const missing = C.employeeEstimate({ employeeName: '石高铭', isManager: true }, 100, 1000, {});
  assert.equal(missing.status, 'unconfigured'); assert.equal(missing.reason, '门店盈亏平衡线未配置');
});
