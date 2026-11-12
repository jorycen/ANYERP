const {test}=require('node:test'),a=require('node:assert/strict'),M=require('../src/models'),D=require('../src/modules/finance/expenseProfitDeduction'),A=require('../src/modules/report/storeCommissionAllocation');
test('approved store-affecting expense uses frozen performance month and allocation totals, not approval month or expense face amount',async t=>{
 t.mock.method(M.sequelize,'query',async(sql,options)=>{
  a.match(sql,/a.STATUS='approved'/);a.match(sql,/e.STATUS='approved'/);a.match(sql,/e.AFFECTS_STORE_PROFIT=1/);a.match(sql,/SUM\(a.AMOUNT\)/);a.match(sql,/a.PERFORMANCE_MONTH=:month/);a.equal(options.replacements.month,'2026-10');
  return [{expenseId:'E',expenseNo:'EXP179377670517359',storeId:'S',amount:'298.87',expenseDate:'2026-10-09'}];
 });
 const events=await D.storeCommissionEvents({storeIds:['S'],month:'2026-10'});a.equal(events.length,1);a.equal(events[0].amount,-298.87);
 const facts=[{amount:278810.33,ownershipTime:'2026-10-01',storeId:'S'},...events];
 const r=A.allocate(facts,[{store_id:'S',staff_id:9,effective_from:'2026-09-01'}],[{staff_id:9,name:'石高铭'}],{month:'2026-10'},new Map([['S',{grossProfit:278511.46,breakEvenLine:100000}]]));
 a.equal(r.owners.get('9').grossProfit,278511.46);a.equal(r.owners.get('9').commission,13925.57);
});
