const {test}=require('node:test');
const a=require('node:assert/strict');
const {buildTimeline,netStages,createLoader}=require('../src/modules/report/managerCommissionTimeline');
const {estimateManagerCommission}=require('../src/modules/report/employeeCommission');
function sale(id,amount,personal,time='10:00:00'){
 return {eventKey:`sale:${id}`,orderId:id,entryType:'sale',businessDate:'2026-10-01',time:`2026-10-01 ${time}`,amount,allocations:[{staffId:'M',grossProfit:personal}]};
}
test('crossing order splits only the excess and leaves earlier personal profit at 15%',()=>{
 const r=buildTimeline([sale('B',1000,1000,'11:00:00'),sale('A',99900,0)],100000);
 a.equal(r.entries[1].allocations[0].low,100);a.equal(r.entries[1].allocations[0].high,900);
 const stages=netStages({lowGrossProfit:100,highGrossProfit:900,reason:''},1000,0);
 const estimate=estimateManagerCommission(1000,100000,100000,.03,stages);
 a.equal(estimate.personal,240);a.equal(estimate.lowCommission,15);a.equal(estimate.highCommission,225);
});
test('before, exactly at and after the threshold are separate stages; negative sales move cumulative back',()=>{
 const r=buildTimeline([sale('1',100,100),sale('2',10,10,'11:00:00'),sale('3',-15,-15,'12:00:00'),sale('4',10,10,'13:00:00')],100);
 a.deepEqual(r.entries.map(e=>[e.allocations[0].low,e.allocations[0].high]),[[100,0],[0,10],[-5,-10],[5,5]]);
});
test('return restores original order tiers even when store has since fallen below line',()=>{
 const refund={eventKey:'return:R',orderId:'O',entryType:'return',businessDate:'2026-11-02',time:'2026-11-02 10:00:00',amount:-1000,allocations:[{staffId:'M',grossProfit:-1000}]};
 const prior=new Map([['O',{fraction:.9}]]),r=buildTimeline([refund],100000,prior);
 a.equal(r.entries[0].allocations[0].low,-100);a.equal(r.entries[0].allocations[0].high,-900);
 a.equal(r.cumulative,-1000);
});
test('missing original stages remain pending; zero return needs no invented stage',()=>{
 const refund={...sale('O',-10,-10),eventKey:'return:R',entryType:'return'};
 const r=buildTimeline([refund],100);a.match(r.entries[0].reason,/原订单/);a.equal(r.entries[0].allocations[0].high,null);
 const zero=buildTimeline([{...refund,amount:0,allocations:[{staffId:'M',grossProfit:0}]}],100);
 a.equal(zero.entries[0].allocations[0].low,0);
});
test('unknown earlier store profit prevents later stage guessing',()=>{
 const r=buildTimeline([sale('1',null,0),sale('2',100,100,'11:00:00')],100);
 a.equal(r.entries[1].allocations[0].low,null);a.match(r.entries[1].reason,/此前/);
});
test('cent conservation, reconciliation and explicit expense stage policies',()=>{
 const s={lowGrossProfit:100.01,highGrossProfit:200.02,reason:''};
 const r=netStages(s,300.03,10,'proportional');
 a.equal(r.lowDeduction,3.33);a.equal(r.highDeduction,6.67);a.equal(r.lowNetGrossProfit,96.68);a.equal(r.highNetGrossProfit,193.35);
 a.match(netStages(s,300,0).reason,/不一致/);
 a.match(netStages(s,300.03,10).reason,/待确认/);
 a.equal(netStages(s,300.03,10,'low').lowDeduction,10);
});

test('loader uses full month prefix and reverses an earlier month sale using its original tiers',async t=>{
 const M=require('../src/models'),F=require('../src/modules/report/financialProfitController'),C=require('../src/modules/report/commissionConfig');
 const calls=[];
 t.mock.method(F,'queryFinancialProfit',async q=>{
  calls.push(q);
  return {profitDetails:q.startDate.startsWith('2026-10')?[
   {eventKey:'sale:A',entryType:'sale',orderId:'A',storeId:'S',businessDate:'2026-10-01',salesGrossProfit:99900},
   {eventKey:'sale:O',entryType:'sale',orderId:'O',storeId:'S',businessDate:'2026-10-02',salesGrossProfit:1000}
  ]:[{eventKey:'return:R',entryType:'return',orderId:'O',storeId:'S',businessDate:'2026-11-03',salesGrossProfit:-500}]};
 });
 t.mock.method(C,'options',async()=>({stores:[{storeId:'S',breakEvenLine:100000}]}));
 t.mock.method(M.Order,'findAll',async()=>[
  {order_id:'A',create_time:'2026-10-01 10:00:00',archive_time:'2026-10-01 11:00:00'},
  {order_id:'O',create_time:'2026-10-02 10:00:00',archive_time:'2026-10-02 11:00:00'}
 ]);
 t.mock.method(M.SalesReturnRequest,'findAll',async()=>[{return_id:'R',create_time:'2026-11-03 10:00:00'}]);
 const loader=createLoader({user:{staffId:9,roles:['boss']},stores:[{store_id:'S'}]});
 const oct=await loader.forStaff({period:{month:'2026-10',startDate:'2026-10-02',endDate:'2026-10-02'},storeId:'S',staffId:'M',performanceDetails:[
  {staffId:'M',orderId:'O',sourceOrderId:'O',orderNo:'SO',sourceEntryType:'sale',orderTime:'2026-10-02',allocatedGrossProfit:1100}
 ]});
 // Original-order performance adjustments follow that sale's stages too.
 a.equal(oct.lowGrossProfit,110);a.equal(oct.highGrossProfit,990);a.equal(calls[0].startDate,'2026-10-01');
 const nov=await loader.forStaff({period:{month:'2026-11',startDate:'2026-11-03',endDate:'2026-11-03'},storeId:'S',staffId:'M',performanceDetails:[
  {staffId:'M',orderId:'return:L',sourceOrderId:'O',returnId:'R',orderNo:'RET',sourceEntryType:'return',orderTime:'2026-11-03',allocatedGrossProfit:-500}
 ]});
 a.equal(nov.lowGrossProfit,-50);a.equal(nov.highGrossProfit,-450);a.equal(nov.reason,'');
});

test('uncapped backend performance details include every transaction while dashboard remains capped',()=>{
 const {buildEmployeePerformance}=require('../src/modules/report/dashboardService');
 const orders=Array.from({length:120},(_,i)=>({order_id:String(i),create_staff_id:1,create_user:'M',auxiliary_sales_list:'[]',sales_amount:1,base_gross_profit:1}));
 a.equal(buildEmployeePerformance(orders,[],'',true).details.length,100);
 a.equal(buildEmployeePerformance(orders,[],'',true,{allDetails:true}).details.length,120);
});

test('loader collects all cross-store blockers instead of only the first',async t=>{
 const M=require('../src/models'),F=require('../src/modules/report/financialProfitController'),C=require('../src/modules/report/commissionConfig');
 t.mock.method(C,'options',async()=>({stores:[{storeId:'S',breakEvenLine:100}]}));
 t.mock.method(F,'queryFinancialProfit',async()=>({profitDetails:[]}));
 t.mock.method(M.Order,'findByPk',async id=>({order_id:id,store_id:'OTHER',create_time:'2026-10-01'}));
 const loader=createLoader({user:{staffId:9},stores:[{store_id:'S'}]});
 const r=await loader.forStaff({period:{month:'2026-10',startDate:'2026-10-01',endDate:'2026-10-31'},storeId:'S',staffId:'M',performanceDetails:['A','B'].map(id=>({staffId:'M',orderId:id,sourceOrderId:id,orderNo:id,sourceEntryType:'sale',allocatedGrossProfit:1}))});
 a.equal(r.issues.length,2);a.deepEqual(r.issues.map(i=>i.orderNo),['A','B']);a.equal(r.lowGrossProfit,null);
});
