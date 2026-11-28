const {test}=require('node:test');
const a=require('node:assert/strict');
const {buildTimeline,netStages,createLoader,eventFacts}=require('../src/modules/report/managerCommissionTimeline');
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
test('return below line uses current month 15 percent, without original stages',()=>{
 const refund={eventKey:'return:R',orderId:'O',entryType:'return',businessDate:'2026-11-02',time:'2026-11-02 10:00:00',amount:-1000,allocations:[{staffId:'M',grossProfit:-1000}]};
 const r=buildTimeline([refund],100000);
 a.equal(r.entries[0].allocations[0].low,-1000);a.equal(r.entries[0].allocations[0].high,0);
 a.equal(r.cumulative,-1000);
});
test('return needs current-month basis rather than original stages; zero reversal stays known',()=>{
 const refund={...sale('O',-10,-10),eventKey:'return:R',entryType:'return'};
 const r=buildTimeline([refund],100);a.equal(r.entries[0].reason,'');a.equal(r.entries[0].allocations[0].low,-10);
 const missing=buildTimeline([refund],null);a.match(missing.entries[0].reason,/平衡线未配置/);a.equal(missing.entries[0].allocations[0].high,null);
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

test('loader uses month prefix and never loads original month for a later-month return',async t=>{
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
 t.mock.method(M.SalesReturnGrossProfitLedger,'findAll',async()=>[{return_id:'R',create_time:'2026-11-03 10:00:00'}]);
 const loader=createLoader({user:{staffId:9,roles:['boss']},stores:[{store_id:'S'}]});
 t.mock.method(M.Order,'findByPk',async()=>{throw Error('must not load original personal stage')});
 const oct=await loader.forStaff({period:{month:'2026-10',startDate:'2026-10-02',endDate:'2026-10-02'},storeId:'S',staffId:'M',performanceDetails:[
  {staffId:'M',orderId:'O',sourceOrderId:'O',orderNo:'SO',sourceEntryType:'sale',orderTime:'2026-10-02',allocatedGrossProfit:1100}
 ]});
 // Original-order performance adjustments follow that sale's stages too.
 a.equal(oct.lowGrossProfit,110);a.equal(oct.highGrossProfit,990);a.equal(calls[0].startDate,'2026-10-01');
 const beforeReturn=calls.length;
 const nov=await loader.forStaff({period:{month:'2026-11',startDate:'2026-11-03',endDate:'2026-11-03'},storeId:'S',staffId:'M',performanceDetails:[
  {staffId:'M',orderId:'return:L',sourceOrderId:'O',returnId:'R',orderNo:'RET',sourceEntryType:'return',orderTime:'2026-11-03',allocatedGrossProfit:-500}
 ]});
 a.equal(nov.lowGrossProfit,-500);a.equal(nov.highGrossProfit,0);a.equal(nov.reason,'');
 a.ok(calls.slice(beforeReturn).every(q=>q.startDate==='2026-11-01'));
});

test('negative return crossing downward splits at threshold and conserves individual shares',()=>{
 const refund={...sale('O',-2000,-2000,'11:00:00'),entryType:'return',eventKey:'return:R'};
 const r=buildTimeline([sale('prefix',101000,0),refund],100000),share=r.entries[1].allocations[0];
 a.equal(share.low,-1000);a.equal(share.high,-1000);a.equal(r.cumulative,99000);
 const stages=netStages({lowGrossProfit:share.low,highGrossProfit:share.high,reason:''},-2000,0);
 a.equal(estimateManagerCommission(-2000,100000,99000,.03,stages).personal,-400);
 const high=buildTimeline([sale('prefix',102500,0),refund],100000);a.equal(high.entries[1].allocations[0].high,-2000);
 const exact=buildTimeline([sale('prefix',102000,0),refund],100000);a.equal(exact.entries[1].allocations[0].high,-2000);a.equal(exact.entries[1].allocations[0].low,0);
 const shared=buildTimeline([sale('prefix',101000,0),{...refund,allocations:[{staffId:'M',grossProfit:-1000}]}],100000);a.equal(shared.entries[1].allocations[0].low,-500);a.equal(shared.entries[1].allocations[0].high,-500);
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

test('personal cross-store profit uses original store threshold, not current store threshold',async t=>{
 const M=require('../src/models'),F=require('../src/modules/report/financialProfitController'),C=require('../src/modules/report/commissionConfig');
 t.mock.method(C,'options',async()=>({stores:[{storeId:'S',breakEvenLine:100000},{storeId:'T',breakEvenLine:1}]}));
 t.mock.method(F,'queryFinancialProfit',async()=>({profitDetails:[{eventKey:'sale:A',entryType:'sale',orderId:'A',storeId:'S',businessDate:'2026-10-01',salesGrossProfit:99900},{eventKey:'sale:O',entryType:'sale',orderId:'O',storeId:'S',businessDate:'2026-10-02',salesGrossProfit:1000}]}));
 t.mock.method(M.Order,'findAll',async()=>[{order_id:'A',store_id:'S',create_time:'2026-09-01 10:00:00',archive_time:'2026-10-01 10:00:00'},{order_id:'O',store_id:'S',create_time:'2026-09-02 10:00:00',archive_time:'2026-10-02 10:00:00'}]);
 const loader=createLoader({user:{staffId:9},stores:[{store_id:'S'},{store_id:'T'}]});
 const r=await loader.forStaff({period:{month:'2026-10',startDate:'2026-10-01',endDate:'2026-10-31'},storeId:'T',staffId:'M',performanceDetails:[{staffId:'M',storeId:'S',sourceEntryType:'sale',orderId:'O',sourceOrderId:'O',allocatedGrossProfit:1000,orderTime:'2026-10-02'}]});
 a.equal(r.lowGrossProfit,100);a.equal(r.highGrossProfit,900);a.equal(r.reason,'');a.equal(r.details[0].storeId,'S');
});

test('return-related adjustment follows current-month downward crossing without querying original phase',async t=>{
 const M=require('../src/models'),F=require('../src/modules/report/financialProfitController'),C=require('../src/modules/report/commissionConfig'),calls=[];
 t.mock.method(C,'options',async(u,month)=>{a.equal(month,'2026-11');return {stores:[{storeId:'S',breakEvenLine:400}]}});
 t.mock.method(F,'queryFinancialProfit',async q=>{calls.push(q);return {profitDetails:[{eventKey:'sale:A',entryType:'sale',orderId:'A',storeId:'S',businessDate:'2026-11-01',salesGrossProfit:500},{eventKey:'performance:ADJ',entryType:'performance_adjustment',storeId:'S',businessDate:'2026-11-02',salesGrossProfit:-200}]}});
 t.mock.method(M.Order,'findAll',async()=>[{order_id:'A',store_id:'S',create_time:'2026-10-01 10:00:00',archive_time:'2026-11-01 10:00:00'},{order_id:'O',store_id:'S',create_time:'2026-09-01 10:00:00'}]);
 t.mock.method(M.PerformanceProfitAdjustment,'findAll',async()=>[{adjustment_id:'ADJ',order_id:'O',create_time:'2026-10-02 10:00:00',admin_review_time:'2026-11-02 10:00:00'}]);
 t.mock.method(M.Order,'findByPk',async()=>{throw Error('must not query old personal stage')});
 const r=await createLoader({user:{staffId:9},stores:[{store_id:'S'}]}).forStaff({period:{month:'2026-11',startDate:'2026-11-01',endDate:'2026-11-30'},storeId:'S',staffId:'M',performanceDetails:[{staffId:'M',storeId:'S',orderId:'return-adjustment:ADJ',sourceOrderId:'O',orderNo:'AUTO-CARE-RET-R',sourceEntryType:'return_adjustment',allocatedGrossProfit:-200,orderTime:'2026-11-02'}]});
 a.equal(r.lowGrossProfit,-100);a.equal(r.highGrossProfit,-100);a.equal(r.reason,'');a.ok(calls.every(q=>q.startDate==='2026-11-01'));
});

test('return sequencing uses its frozen posting time while store-owner reference remains original sale time',async t=>{
 const M=require('../src/models'),original=new Date('2026-09-01T02:00:00Z');
 t.mock.method(M.Order,'findAll',async()=>[{order_id:'O',store_id:'S',create_time:original,archive_time:new Date('2026-10-01T02:00:00Z')}]);
 t.mock.method(M.SalesReturnGrossProfitLedger,'findAll',async()=>[{return_id:'R',create_time:new Date('2026-11-02T08:00:00Z')}]);
 t.mock.method(M.SalesReturnRequest,'findAll',async()=>{throw Error('request time must not replace posting time')});
 const r=await eventFacts([{eventKey:'return:R',entryType:'return',orderId:'O',storeId:'S',businessDate:'2026-11-02',salesGrossProfit:-100}],['S']);
 a.equal(r[0].time,'2026-11-02 16:00:00.000');a.equal(r[0].ownershipTime,original);
 t.mock.method(M.Order,'findAll',async()=>[{order_id:'O',store_id:'S',create_time:original,archive_time:null}]);
 const legacy=await eventFacts([{eventKey:'return:R',entryType:'return',orderId:'O',storeId:'S',businessDate:'2026-11-02',salesGrossProfit:-100}],['S']);
 const known=require('../src/modules/report/storeCommissionAllocation').allocate(legacy,[{store_id:'S',staff_id:1,effective_from:'2026-09-01',effective_to:null}],[{staff_id:1,name:'已确认历史店长'}],{month:'2026-11'},new Map([['S',{grossProfit:200,breakEvenLine:100}]]));
 a.equal(known.missing.length,0);a.equal(known.owners.get('1').commission,-3);
 t.mock.method(M.Order,'findAll',async()=>[]);
 const missing=await eventFacts([{eventKey:'return:R',entryType:'return',orderId:'O',storeId:'S',businessDate:'2026-11-02',salesGrossProfit:-100}],['S']);
 a.equal(missing[0].ownershipTime,null);
 const allocation=require('../src/modules/report/storeCommissionAllocation').allocate(missing,[{store_id:'S',staff_id:1,effective_from:'2026-11-01'}],[{staff_id:1,name:'当前店长'}],{month:'2026-11'});
 a.equal(allocation.owners.size,0);a.match(allocation.missing[0].reason,/原业务发生时间/);
});
