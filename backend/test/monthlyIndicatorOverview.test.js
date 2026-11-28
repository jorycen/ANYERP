const test=require('node:test'),a=require('node:assert/strict');
const {groupedOverview}=require('../src/modules/sales/monthlyIndicatorOverview');
const {matchesAbilityRow}=require('../src/modules/report/monthlyIndicatorScope');
const {indicatorActual,loadActuals}=require('../src/modules/report/monthlyTaskAchievement');
const M=require('../src/models');
test('company overview merges the same definition across stores, retains its own target and allows over-allocation',()=>{
 const make=(store,target,allocated,definition='D')=>({storeId:store,source:'company',name:'高德评价',kind:'management',metrics:[{definition_id:definition,metric:'management',status:1,target,allocated}]});
 const result=groupedOverview([make('A',20,25),make('B',30,40),make('A',1,1,'OTHER')],[{definition_id:'D',status:1,company_targets:{management:40}}],[{store_id:'A',distributor_id:'X',company:true},{store_id:'B',distributor_id:'X',company:true}]);
 a.equal(result.length,2);a.deepEqual(result[0].metrics,[{metric:'management',target:40,storeAllocated:50,allocated:65}]);a.equal(result[0].stores.length,2);
 const managed=groupedOverview([make('A',20,25)],[{definition_id:'D',status:1,company_targets:{management:400}}],[{store_id:'A',distributor_id:'X',company:false,manager:true}]);a.equal(managed[0].metrics[0].target,20);
 const empty=groupedOverview([],[{definition_id:'D',status:1,company_targets:{management:40}}],[{store_id:'A',distributor_id:'X',company:true}],[{definition_id:'D',distributor_id:'X',source:'company',name:'评价',config:{kind:'management'}}],[{definition_id:'D',indicator_id:'DELETED'}]);a.equal(empty[0].storeCount,0);a.equal(empty[0].metrics[0].target,40);a.equal(empty[0].anchorId,'DELETED');
});
test('ability matching uses original sale age, the frozen SN special flag, and exact customer sources',()=>{
 a.equal(matchesAbilityRow({snCode:'SN',saleAgeDays:30},{abilityType:'overdue'}),false);
 a.equal(matchesAbilityRow({snCode:'SN',saleAgeDays:31},{abilityType:'overdue'}),true);
 a.equal(matchesAbilityRow({snCode:'SN',saleAgeDays:null},{abilityType:'overdue'}),null);
 a.equal(matchesAbilityRow({itemId:1,snCode:'SN',pricingDetails:[{itemId:1,isSpecialPrice:true}]},{abilityType:'special'}),true);
 a.equal(matchesAbilityRow({itemId:1,snCode:'SN',pricingDetails:[{itemId:1,isSpecialPrice:false}]},{abilityType:'special'}),false);
 a.equal(matchesAbilityRow({itemId:1,snCode:'SN',pricingDetails:[]},{abilityType:'special'}),null);
 a.equal(matchesAbilityRow({customerSource:'即时零售'},{abilityType:'source',customerSources:['即时零售']}),true);
 a.equal(matchesAbilityRow({customerSource:'到店'},{abilityType:'source',customerSources:['即时零售']}),false);
 a.equal(indicatorActual({scopeUnknown:true},'quantity'),null);
 a.equal(indicatorActual({abilityScoped:true,unallocatedProfit:true},'profit'),null);
});
test('ability achievement filters individual items and reverses only matching returned items',async t=>{
 const details=[{itemId:1,isSpecialPrice:true},{itemId:2,isSpecialPrice:false}];
 t.mock.method(M.sequelize,'query',async sql=>{
  if(sql.includes('FROM T_ORDER o'))return [
   {orderId:'O',storeId:'S',createStaffId:1,createUser:'员工',itemId:1,productId:'P',snCode:'SN',quantity:1,salesAmount:100,itemGrossProfit:10,pricingDetails:details},
   {orderId:'O',storeId:'S',createStaffId:1,createUser:'员工',itemId:2,productId:'Q',snCode:'SN2',quantity:1,salesAmount:900,itemGrossProfit:90,pricingDetails:details}];
  if(sql.includes('FROM T_SALES_RETURN_SETTLEMENT'))return [{orderId:'O',storeId:'S',createStaffId:1,createUser:'员工',itemId:1,productId:'P',snCode:'SN',quantity:-1,salesAmount:100,pricingDetails:details}];
  return [];
 });
 const r=await loadActuals(['S'],new Date(),new Date(),'archived',true,{abilityType:'special'});
 a.equal(indicatorActual(r.storeActuals.get('S'),'sales'),0);a.equal(indicatorActual(r.storeActuals.get('S'),'quantity'),0);
 a.equal(indicatorActual(r.employeeActuals.get('S:id:1'),'sales'),0);
 a.equal(indicatorActual(r.storeActuals.get('S'),'profit'),null);
});
