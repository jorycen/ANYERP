const { test } = require('node:test');
const a = require('node:assert/strict');
const M = require('../src/models');
const C = require('../src/modules/report/commissionConfig');
const R = require('../src/modules/report/employeeProfitSummary');
const D = require('../src/modules/report/dashboardDataSource').RealtimeSqlDashboardDataSource;
const F = require('../src/modules/report/financialProfitController');
const E = require('../src/modules/finance/expenseProfitDeduction');
function fixture(t) {
  t.mock.method(C, 'scope', async()=>[{store_id:'S',name:'门店',manager_staff_id:2}]);
  t.mock.method(C, 'options', async()=>({ stores:[{storeId:'S',breakEvenLine:1000}],employees:[
    {staffId:'1',employeeName:'店员',storeId:'S',commissionBase:1000,roles:'staff'},
    {staffId:'2',employeeName:'石高铭',storeId:'S',roles:'manager'}] }));
  t.mock.method(M.Staff, 'findAll', async()=>[{staff_id:1,store_id:'S',role_code:'staff'},{staff_id:2,store_id:'S',role_code:'manager'}]);
  t.mock.method(D.prototype, 'getEmployeeOrderRows', async()=>[
    {order_id:'1',create_staff_id:1,create_user:'店员',base_gross_profit:2000,sales_amount:5000,auxiliary_sales_list:'[]'},
    {order_id:'2',create_staff_id:2,create_user:'石高铭',base_gross_profit:3000,sales_amount:5000,auxiliary_sales_list:'[]'}]);
  t.mock.method(D.prototype, 'getApprovedAdjustments', async()=>[]);
  t.mock.method(E,'loadMonthly',async()=>[]);
  t.mock.method(F,'queryFinancialProfit',async()=>({summary:{productGrossProfit:100,operationsGrossProfit:200},storeSummaries:[{storeId:'S',summary:{companyGrossProfit:10000}}]}));
}
test('shared rows and export retain zero versus unconfigured values',async t=>{
  fixture(t);
  const result=await R.load({staffId:9,roles:['boss']},{startDate:'2026-11-01',endDate:'2026-11-30'});
  a.equal(result.rows.length,2);
  a.equal(result.rows.find(r=>String(r.staffId)==='2').storeCommission,500);
  a.equal(result.rows.find(r=>String(r.staffId)==='1').salesCommission,250);
  const exported=R.exportRows(result.rows);
  a.equal(exported[0].绩效预估,result.rows[0].performanceEstimate);
  a.equal(exported[0].产品端提成,'待定');
});
test('employee selection never shrinks the manager store commission',async t=>{
  fixture(t);
  const r=await R.load({staffId:9,roles:['boss']},{startDate:'2026-11-01',endDate:'2026-11-30',employeeId:'2'});
  a.equal(r.rows.length,1);a.equal(r.rows[0].storeCommission,500);a.equal(r.panels.product.grossProfit,null);
});
test('cross-month estimates add each month without reapplying tiers to a combined total',async t=>{
  fixture(t);
  const r=await R.load({staffId:9,roles:['boss']},{startDate:'2026-10-01',endDate:'2026-11-30',employeeId:'1'});
  a.equal(r.rows[0].grossProfit,4000);a.equal(r.rows[0].salesCommission,500);
});
test('manager with configured line shows pending store accounting in report and export',async t=>{
  fixture(t);
  t.mock.method(F,'queryFinancialProfit',async()=>({summary:{productGrossProfit:null,operationsGrossProfit:0},storeSummaries:[{storeId:'S',summary:{companyGrossProfit:null,profitPendingCount:45}}]}));
  const r=await R.load({staffId:9,roles:['boss']},{startDate:'2026-11-01',endDate:'2026-11-30',employeeId:'2'});
  a.equal(r.rows[0].breakEvenLine,1000);a.equal(r.rows[0].status,'pending');a.match(r.rows[0].remark,/45笔/);
  a.equal(R.exportRows(r.rows)[0].绩效预估,'待核算');
});
test('Excel output matches the same employee records',async t=>{
  fixture(t);
  const query={startDate:'2026-11-01',endDate:'2026-11-30'},user={staffId:9,roles:['boss']};
  const r=await R.load(user,query),ctx={state:{user},query,set(){}};
  await R.exportReport(ctx);
  const X=require('xlsx'),wb=X.read(ctx.body,{type:'buffer'}),rows=X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  a.equal(rows.length,r.rows.length);a.equal(rows[0].毛利,r.rows[0].grossProfit);a.equal(rows[0].绩效预估,r.rows[0].performanceEstimate);
});
test('corrected first tier is shared by employee report, total and Excel',async t=>{
  fixture(t);
  t.mock.method(C,'options',async()=>({stores:[{storeId:'S'}],employees:[{staffId:'1',employeeName:'张翔',storeId:'S',roles:'staff',commissionBase:9000}]}));
  t.mock.method(D.prototype,'getEmployeeOrderRows',async()=>[{order_id:'sale',create_staff_id:1,create_user:'张翔',base_gross_profit:12893.39,sales_amount:20000,auxiliary_sales_list:'[]'}]);
  const query={startDate:'2026-10-01',endDate:'2026-10-31',employeeId:'1'},user={staffId:9,roles:['boss']};
  const result=await R.load(user,query);
  a.equal(result.rows[0].salesCommission,778.68);a.equal(result.panels.sales.commission,778.68);
  const ctx={state:{user},query,set(){}};await R.exportReport(ctx);
  const X=require('xlsx'),wb=X.read(ctx.body,{type:'buffer'}),rows=X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  a.equal(rows[0].销售端提成,778.68);a.equal(rows[0].绩效预估,778.68);
});
test('self-only account cannot select another person',async t=>{
  fixture(t);
  const r=await R.load({staffId:1,roles:['staff']},{startDate:'2026-11-01',endDate:'2026-11-30',employeeId:'2'});
  a.equal(r.rows.length,1);a.equal(String(r.rows[0].staffId),'1');
});
test('invalid dates rejected and month ranges split once',()=>{
  a.throws(()=>R.periods({startDate:'2026-02-30',endDate:'2026-03-01'}));
  a.equal(R.periods({startDate:'2026-10-31',endDate:'2026-11-01'}).length,2);
});
test('store staff cannot save commission configuration',async()=>{
  await a.rejects(C.save({state:{user:{staffId:1,roles:['staff']}},request:{body:{}}}),{status:403});
});
test('configuration saves atomically with audit and rejects stale revisions',async t=>{
  t.mock.method(M.Store,'findAll',async()=>[{store_id:'S',name:'门店'}]);
  t.mock.method(M.sequelize,'query',async()=>[{staffId:1,employeeName:'店员',storeId:'S'}]);
  t.mock.method(C.Config,'findAll',async()=>[]);
  t.mock.method(C.Config,'findByPk',async()=>null);
  let saved, audited;
  t.mock.method(C.Config,'create',async values=>{saved=values});
  t.mock.method(M.BusinessActionLog,'create',async values=>{audited=values});
  t.mock.method(M.sequelize,'transaction',async callback=>callback({LOCK:{UPDATE:'UPDATE'}}));
  const ctx={state:{user:{staffId:9,roles:['boss']}},request:{body:{month:'2026-11',entityType:'staff',entityId:'1',amount:'1234.56',revision:0}}};
  await C.save(ctx);a.equal(saved.amount,1234.56);a.equal(saved.month_key,'2026-11');a.ok(audited.detail_json);
  ctx.request.body.revision=1;await a.rejects(C.save(ctx),{status:409});
  ctx.request.body.entityId='other';await a.rejects(C.save(ctx),{status:403});
});
