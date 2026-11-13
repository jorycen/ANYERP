const { test } = require('node:test');
const a = require('node:assert/strict');
const M = require('../src/models');
const C = require('../src/modules/report/commissionConfig');
const R = require('../src/modules/report/employeeProfitSummary');
const D = require('../src/modules/report/dashboardDataSource').RealtimeSqlDashboardDataSource;
const F = require('../src/modules/report/financialProfitController');
const E = require('../src/modules/finance/expenseProfitDeduction');
const T = require('../src/modules/report/managerCommissionTimeline');
const A=require('../src/modules/report/storeCommissionAllocation');
function fixture(t) {
  t.mock.method(C,'staffConfigs',async()=>[]);
  t.mock.method(A,'load',async()=>({owners:new Map([['2',{commission:500,grossProfit:10000,storeIds:['S'],issues:[]}]]),missing:[],people:[]}));
  t.mock.method(T,'createLoader',()=>({forStaff:async()=>({lowGrossProfit:0,highGrossProfit:3000,reason:'',details:[]})}));
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
  t.mock.method(F,'queryFinancialProfit',async()=>({profitDetails:[],summary:{productGrossProfit:null,operationsGrossProfit:200},storeSummaries:[{storeId:'S',summary:{companyGrossProfit:null,salesGrossProfit:10000,profitPendingCount:45}}]}));
}
test('产品运营按业绩身份归属个人毛利，经营明细排除返利且不重复计入销售', async t=>{
 fixture(t);
 t.mock.method(M.Staff,'findAll',async()=>[{staff_id:1,store_id:'S',performance_identity:'product',role_code:'admin'},{staff_id:2,store_id:'S',performance_identity:'operations',role_code:'purchaser'}]);
 t.mock.method(F,'queryFinancialProfit',async()=>({summary:{},storeSummaries:[],profitDetails:[
  {eventKey:'sale:A',entryType:'sale',storeId:'S',orderNo:'A',productGrossProfit:100,operationsGrossProfit:50},
  {eventKey:'policy:P',entryType:'policy',storeId:'S',productGrossProfit:999,operationsGrossProfit:0}
 ]}));
 const query={startDate:'2026-11-01',endDate:'2026-11-30',reportRole:'all'};
 const r=await R.load({staffId:9,roles:['boss']},query);
 a.equal(r.panels.sales.grossProfit,0);a.equal(r.panels.product.grossProfit,2100);a.equal(r.panels.operations.grossProfit,3050);
 a.equal(r.rows.filter(x=>x.sourceLabel==='人员业绩').length,2);
 a.equal(r.rows.some(x=>x.grossProfit===999),false);
 const selected=await R.load({staffId:9,roles:['boss']},{...query,reportRole:'product',employeeId:'1'});
 a.equal(selected.rows.length,1);a.equal(selected.rows[0].grossProfit,2000);
 const ctx={state:{user:{staffId:9,roles:['boss']}},query:{...query,reportRole:'product'},set(){}};
 await R.exportReport(ctx);const X=require('xlsx'),wb=X.read(ctx.body,{type:'buffer'}),rows=X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
 a.equal(rows.reduce((s,x)=>s+Number(x.产品端毛利),0),2100);a.ok(rows.some(x=>x.订单号==='A'));
});
test('warehouse-only scope uses product totals without querying or estimating personal sales',async t=>{
 fixture(t);
 t.mock.method(C,'scope',async()=>[{store_id:'D028000',name:'成都自营仓',manager_staff_id:3}]);
 t.mock.method(C,'options',async()=>({stores:[],employees:[{staffId:'3',employeeName:'仓库',storeId:'D028000',roles:'manager'}]}));
 t.mock.method(A,'load',async()=>({owners:new Map(),missing:[],people:[]}));
 for(const method of ['getEmployeeOrderRows','getApprovedAdjustments'])t.mock.method(D.prototype,method,async()=>{throw Error('warehouse sales must not be queried')});
 t.mock.method(E,'loadMonthly',async()=>{throw Error('warehouse personal deductions must not be queried')});
 t.mock.method(F,'queryFinancialProfit',async()=>({profitDetails:[{eventKey:'sale:W',entryType:'sale',storeId:'D028000',productGrossProfit:123,operationsGrossProfit:0}],summary:{},storeSummaries:[]}));
 const r=await R.load({staffId:9,roles:['boss']},{startDate:'2026-11-01',endDate:'2026-11-30',reportRole:'all',storeId:'D028000'});
 a.equal(r.rows.filter(x=>x.sideName==='销售端').length,0);a.equal(r.panels.sales.grossProfit,0);
 a.equal(r.panels.product.grossProfit,123);a.equal(r.rows.find(x=>x.sideName==='产品端').grossProfit,123);
});
test('mixed store scope excludes only warehouse sales while retaining warehouse product reporting',async t=>{
 fixture(t);
 t.mock.method(C,'scope',async()=>[{store_id:'S',name:'门店',manager_staff_id:2},{store_id:'D023000',name:'重庆自营仓'}]);
 const getOrders=D.prototype.getEmployeeOrderRows.bind(D.prototype);
 t.mock.method(D.prototype,'getEmployeeOrderRows',async(filters,range)=>{a.deepEqual(filters.storeIds,['S']);return getOrders(filters,range)});
 t.mock.method(D.prototype,'getApprovedAdjustments',async filters=>{a.deepEqual(filters.storeIds,['S']);return []});
 t.mock.method(E,'loadMonthly',async filters=>{a.deepEqual(filters.storeIds,['S']);return []});
 const r=await R.load({staffId:9,roles:['boss']},{startDate:'2026-11-01',endDate:'2026-11-30',reportRole:'all'});
 a.equal(r.rows.filter(x=>x.sideName==='销售端').length,2);
 a.ok(!r.rows.some(x=>x.sideName==='产品端'&&x.storeId==='D023000')); // 无经营明细不得由汇总虚构清单
});
test('shared rows and export retain zero versus unconfigured values',async t=>{
  fixture(t);
  const result=await R.load({staffId:9,roles:['boss']},{startDate:'2026-11-01',endDate:'2026-11-30'});
  a.equal(result.rows.length,2);
  a.equal(result.rows.find(r=>String(r.staffId)==='2').storeCommission,500);
  const manager=result.rows.find(r=>String(r.staffId)==='2');
  a.equal(manager.status,'estimated');a.equal(manager.storeGrossProfit,10000);
  a.equal(manager.salesCommission,750);
  a.equal(R.exportRows([manager])[0].门店销售端毛利,10000);
  a.equal(result.rows.find(r=>String(r.staffId)==='1').salesCommission,250);
  const exported=R.exportRows(result.rows);
  a.equal(exported[0].绩效预估,result.rows[0].performanceEstimate);
  a.equal(exported[0].产品端提成,'待定');
});
test('employee selection never shrinks the manager store commission',async t=>{
  fixture(t);
  const r=await R.load({staffId:9,roles:['boss']},{startDate:'2026-11-01',endDate:'2026-11-30',employeeId:'2'});
  a.equal(r.rows.length,1);a.equal(r.rows[0].storeCommission,500);a.equal(r.panels.product.grossProfit,0);
});
test('cross-month estimates add each month without reapplying tiers to a combined total',async t=>{
  fixture(t);
  const r=await R.load({staffId:9,roles:['boss']},{startDate:'2026-10-01',endDate:'2026-11-30',employeeId:'1'});
  a.equal(r.rows[0].grossProfit,4000);a.equal(r.rows[0].salesCommission,500);
});
test('manager with configured line shows pending store accounting in report and export',async t=>{
  fixture(t);
  t.mock.method(A,'load',async()=>({owners:new Map([['2',{commission:null,grossProfit:null,storeIds:['S'],issues:[{month:'2026-11',reason:'门店销售端毛利待核算'}]}]]),missing:[],people:[]}));
  t.mock.method(F,'queryFinancialProfit',async()=>({summary:{productGrossProfit:null,operationsGrossProfit:0},storeSummaries:[{storeId:'S',summary:{companyGrossProfit:null,salesGrossProfit:null,profitPendingCount:45}}]}));
  const r=await R.load({staffId:9,roles:['boss']},{startDate:'2026-11-01',endDate:'2026-11-30',employeeId:'2'});
  a.equal(r.rows[0].breakEvenLine,1000);a.equal(r.rows[0].status,'pending');a.ok(r.rows[0].issues.some(i=>i.reason.includes('门店销售端毛利待核算')));
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

test('role views select employees, retain full-store commission and export matching fields',async t=>{
  fixture(t);
  const user={staffId:9,roles:['boss']},base={startDate:'2026-11-01',endDate:'2026-11-30'};
  const staff=await R.load(user,{...base,reportRole:'staff'}),manager=await R.load(user,{...base,reportRole:'manager'});
  a.equal(staff.rows.length,1);a.equal(String(staff.rows[0].staffId),'1');a.equal(staff.panels.sales.grossProfit,2000);
  a.ok(!staff.columns.some(c=>c.key==='breakEvenLine'));a.equal(manager.rows.length,1);a.equal(manager.rows[0].storeCommission,500);
  const ctx={state:{user},query:{...base,reportRole:'manager'},set(){}};await R.exportReport(ctx);
  const X=require('xlsx'),wb=X.read(ctx.body,{type:'buffer'}),rows=X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  a.equal(rows[0].门店提成归属毛利,10000);a.equal(rows[0].门店提成,500);a.ok(!('提成基数' in rows[0]));
});

test('product and operations group by store with empty owner and retain unknown values',async t=>{
  fixture(t);
  t.mock.method(F,'queryFinancialProfit',async()=>({profitDetails:[{eventKey:'sale:X',entryType:'sale',storeId:'S',productGrossProfit:null,operationsGrossProfit:200}],summary:{},storeSummaries:[]}));
  const user={staffId:9,roles:['boss']},base={startDate:'2026-11-01',endDate:'2026-11-30'};
  const all=await R.load(user,{...base,reportRole:'all'}),product=await R.load(user,{...base,reportRole:'product'}),ops=await R.load(user,{...base,reportRole:'operations'});
  a.equal(all.rows.length,4);a.equal(product.rows.length,1);a.equal(product.rows[0].employeeName,'');a.equal(product.rows[0].grossProfit,null);
  a.equal(ops.rows[0].grossProfit,200);a.equal(ops.rows[0].cells.commission,'待定');
  a.ok(!product.columns.some(c=>c.key==='commissionBase'));a.ok(!JSON.stringify(all.rows.map(r=>r.cells)).includes('不适用'));
  const own=await R.load({staffId:1,roles:['staff']},{...base,reportRole:'product'});a.equal(own.rows.length,0);
  const selected=await R.load(user,{...base,reportRole:'product',employeeId:'2'});a.equal(selected.rows.length,0);
});
test('invalid dates rejected and month ranges split once',()=>{
  a.throws(()=>R.periods({startDate:'2026-02-30',endDate:'2026-03-01'}));
  a.equal(R.periods({startDate:'2026-10-31',endDate:'2026-11-01'}).length,2);
});

test('manager identity preserves employee-rule exception without irrelevant placeholders',async t=>{
 fixture(t);
 t.mock.method(C,'options',async()=>({stores:[{storeId:'S',breakEvenLine:1000}],employees:[{staffId:'2',employeeName:'葛宇',roles:'manager',commissionBase:1000}]}));
 t.mock.method(D.prototype,'getEmployeeOrderRows',async()=>[{order_id:'2',create_staff_id:2,create_user:'葛宇',base_gross_profit:3000,sales_amount:5000,auxiliary_sales_list:'[]'}]);
 const r=await R.load({staffId:9,roles:['boss']},{startDate:'2026-11-01',endDate:'2026-11-30',reportRole:'manager'});
 a.equal(r.rows.length,1);a.equal(r.rows[0].rule,'staff');a.equal(r.rows[0].cells.commissionBase,undefined);a.equal(r.rows[0].cells.breakEvenLine,undefined);a.equal(r.rows[0].cells.storeCommission,'');
 a.deepEqual(r.columns.slice(3,6).map(c=>c.key),['performanceEstimate','salesCommission','storeCommission']);a.ok(r.columns.slice(3,6).every(c=>c.bold));
});

test('side totals accumulate monthly values and reject invalid classification',async t=>{
 fixture(t);
 t.mock.method(F,'queryFinancialProfit',async q=>({profitDetails:[{eventKey:'sale:'+q.startDate,entryType:'sale',storeId:'S',productGrossProfit:0,operationsGrossProfit:200}],summary:{},storeSummaries:[]}));
 const user={staffId:9,roles:['boss']},query={startDate:'2026-10-01',endDate:'2026-11-30',reportRole:'operations'};
 const r=await R.load(user,query);a.equal(r.rows.length,2);a.equal(r.panels.operations.grossProfit,400);
 await a.rejects(R.load(user,{...query,reportRole:'invalid'}),{status:400});
});

test('manager stage expenses and Excel share backend stage totals',async t=>{
 fixture(t);
 t.mock.method(T,'createLoader',()=>({forStaff:async()=>({lowGrossProfit:1000,highGrossProfit:2000,reason:'',details:[]})}));
 t.mock.method(E,'loadMonthly',async()=>[{staffId:'2',staffName:'石高铭',amount:300}]);
 const user={staffId:9,roles:['boss']},query={startDate:'2026-11-01',endDate:'2026-11-30',reportRole:'manager'};
 const result=await R.load(user,query),row=result.rows[0];
 a.equal(row.lowDeduction,100);a.equal(row.highDeduction,200);a.equal(row.lowCommission,135);a.equal(row.highCommission,450);a.equal(row.salesCommission,585);a.equal(row.performanceEstimate,1085);
 const ctx={state:{user},query,set(){}};await R.exportReport(ctx);
 const X=require('xlsx'),wb=X.read(ctx.body,{type:'buffer'}),rows=X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
 a.equal(rows[0]['15%阶段提成'],135);a.equal(rows[0]['25%阶段提成'],450);a.equal(rows[0].绩效合计,row.performanceEstimate);
});

test('historical owner remains individually calculated as clerk and receives original store entitlement',async t=>{
 fixture(t);
 t.mock.method(A,'load',async()=>({owners:new Map([['1',{commission:300,grossProfit:10000,storeIds:['S'],issues:[]}]]),missing:[],people:[]}));
 const r=await R.load({staffId:9,roles:['boss']},{startDate:'2026-11-01',endDate:'2026-11-30',reportRole:'manager',employeeId:'1'});
 a.equal(r.rows.length,1);a.equal(r.rows[0].salesCommission,250);a.equal(r.rows[0].storeCommission,300);a.equal(r.rows[0].performanceEstimate,550);a.equal(r.rows[0].cells.storeCommission,300);
});

test('unconfirmed history remains visibly pending rather than silently assigning current manager',async t=>{
 fixture(t);
 t.mock.method(A,'load',async()=>({owners:new Map(),people:[],missing:[{storeId:'S',month:'2026-11',originalMonth:'2026-11',reason:'业务发生时的店长任职依据未确认',from:'2026-11-01',to:'2026-12-01'}]}));
 const r=await R.load({staffId:9,roles:['boss']},{startDate:'2026-11-01',endDate:'2026-11-30',reportRole:'manager'});
 const person=r.rows.find(x=>String(x.staffId)==='2');a.equal(person.salesCommission,750);a.equal(person.storeCommission,null);a.equal(person.performanceEstimate,null);
 a.ok(r.rows.some(x=>x.employeeName==='店长归属待确认'));a.equal(r.panels.sales.commission,null);
});

test('personal base follows the authorized employee even if not in the filtered current-store roster',async t=>{
 fixture(t);t.mock.method(C,'staffConfigs',async()=>[{entity_id:'1',amount:1500}]);
 const r=await R.load({staffId:9,roles:['boss']},{startDate:'2026-11-01',endDate:'2026-11-30',reportRole:'staff',employeeId:'1'});
 a.equal(r.rows[0].commissionBase,1500);a.equal(r.rows[0].salesCommission,100);
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
