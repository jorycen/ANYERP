const {test}=require('node:test'),a=require('node:assert/strict'),A=require('../src/modules/report/storeCommissionAllocation');
const history=[{store_id:'S',staff_id:1,effective_from:'2026-09-01'}];
function calc(gross,line,name='蒋君杰',events=[{storeId:'S',ownershipTime:'2026-10-01',amount:gross}]){return A.allocate(events,history,[{staff_id:1,name}],{month:'2026-10'},new Map([['S',{grossProfit:gross,breakEvenLine:line}]])).owners.get('1');}
test('monthly store commission is zero below/equal line and full gross above it; all three special managers get 5%',()=>{
 a.equal(calc(99999,100000).commission,0);a.equal(calc(100000,100000).commission,0);
 for(const name of ['石高铭','唐陈','蒋君杰'])a.equal(calc(100001,100000,name).commission,5000.05);
 a.equal(calc(100001,100000,'其他店长').commission,3000.03);
 a.equal(calc(100001,null).commission,null);a.equal(calc(null,100000).commission,null);
});
test('completed returns and approved adjustments can reverse eligibility; selected slice uses full month gate',()=>{
 const events=[{amount:110000},{amount:-5000},{amount:-6000}].map((e,i)=>({...e,eventKey:String(i),storeId:'S',ownershipTime:'2026-10-01'}));
 a.equal(calc(99000,100000,'蒋君杰',events).commission,0);
 a.equal(calc(120000,100000,'蒋君杰',[events[0]]).commission,5500);
 a.equal(calc(99000,100000,'蒋君杰',[events[0]]).commission,0);
});
test('partial range queries the entire calendar month for eligibility, while commission keeps selected event amounts',async t=>{
 t.mock.method(require('../src/modules/finance/expenseProfitDeduction'),'storeCommissionEvents',async()=>[]);
 const M=require('../src/models'),H=require('../src/modules/report/storeManagerHistory'),F=require('../src/modules/report/financialProfitController');
 t.mock.method(M.Order,'findAll',async()=>[{order_id:'O',store_id:'S',create_time:'2026-10-05',archive_time:'2026-10-05'}]);
 t.mock.method(H.Assignment,'findAll',async()=>history);
 t.mock.method(M.Staff,'findAll',async()=>[{staff_id:1,name:'蒋君杰'}]);
 t.mock.method(F,'queryFinancialProfit',async filters=>{
  a.equal(filters.startDate,'2026-10-01');a.equal(filters.endDate,'2026-10-31');a.deepEqual(filters.storeIds,['S']);
  return {storeSummaries:[{storeId:'S',summary:{salesGrossProfit:120000}}]};
 });
 const r=await A.load({profitDetails:[{entryType:'sale',eventKey:'sale:O',orderId:'O',storeId:'S',salesGrossProfit:1000}],storeSummaries:[{storeId:'S',summary:{salesGrossProfit:1000}}]},[{store_id:'S'}],{month:'2026-10',startDate:'2026-10-05',endDate:'2026-10-05'},{stores:[{storeId:'S',breakEvenLine:100000}]});
 a.equal(r.owners.get('1').commission,50);a.equal(r.owners.get('1').grossProfit,1000);
});
