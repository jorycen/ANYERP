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
  const config = { commissionBase: 1000, breakEvenLine: 1000,stages:{lowNetGrossProfit:2000,highNetGrossProfit:0} };
  assert.equal(C.employeeEstimate({ employeeName: '卢珏', isManager: true }, 2000, 10000, config).rule, 'staff');
  assert.equal(C.employeeEstimate({ employeeName: '石高铭', isManager: true }, 2000, 10000, config).storeCommission, 500);
  assert.equal(C.employeeEstimate({ employeeName: '其他', isManager: true }, 2000, 10000, config).performanceEstimate, 600);
});
test('manager commission sums chronological stages without repricing earlier personal profit', () => {
  assert.equal(C.estimateManagerCommission(2000,10000,20000,.03,{lowNetGrossProfit:2000,highNetGrossProfit:0}).personal,300);
  assert.equal(C.estimateManagerCommission(2000,10000,20000,.03,{lowNetGrossProfit:1000,highNetGrossProfit:1000}).personal,400);
  assert.equal(C.estimateManagerCommission(2000,10000,20000,.03,{lowNetGrossProfit:0,highNetGrossProfit:2000}).personal,500);
  assert.equal(C.estimateManagerCommission(2000,10000,20000),null);
  assert.equal(C.estimateManagerCommission(2000,10000,20000,.03,{lowNetGrossProfit:1000,highNetGrossProfit:999}),null);
});
test('configured line with pending store total is pending accounting, not missing configuration', () => {
  const r = C.employeeEstimate({ employeeName: '石高铭', isManager: true }, 31858.29, null, {breakEvenLine:100000});
  assert.equal(r.status, 'pending'); assert.equal(r.reason, '门店销售端毛利待核算'); assert.equal(r.performanceEstimate, null);
  const missing = C.employeeEstimate({ employeeName: '石高铭', isManager: true }, 100, 1000, {});
  assert.equal(missing.status, 'unconfigured'); assert.equal(missing.reason, '门店盈亏平衡线未配置');
});

test('known store commission remains available when personal original tiers are pending',()=>{
 const r=C.employeeEstimate({employeeName:'石高铭',isManager:true},1000,10000,{breakEvenLine:1000,stages:{reason:'原单阶段待核实'}});
 assert.equal(r.storeCommission,500);assert.equal(r.salesCommission,null);assert.equal(r.performanceEstimate,null);assert.equal(r.status,'pending');
});
