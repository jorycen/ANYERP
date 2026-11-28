const test=require('node:test'),a=require('node:assert/strict'),M=require('../src/models');
const {overlayMigratedProfit}=require('../src/modules/sales/monthlyProfitTargets');
test('legacy achievement reads current migrated targets and assignments, including newly assigned employees',async t=>{
 t.mock.method(M.MonthlyIndicatorDefinition,'findAll',async()=>[{definition_id:'D',distributor_id:'C',config:{legacyGrossProfit:true}}]);
 t.mock.method(M.MonthlyIndicator,'findAll',async({where})=>{a.deepEqual(where.store_id,['S']);return [{indicator_id:'I',definition_id:'D',store_id:'S',status:1,target:200,scope_config:{legacyTaskId:'T'}},{indicator_id:'DELETED',definition_id:'D',store_id:'S',status:-1,target:99,scope_config:{legacyTaskId:'T'}}];});
 t.mock.method(M.MonthlyIndicatorAssignment,'findAll',async()=>[{assignment_id:'A',indicator_id:'I',staff_id:3,target:250}]);
 const tasks=[{task_id:'T',target_type:'store',target_id:'S',distributor_id:'C',gross_profit_target:10},{task_id:'OLD',target_type:'staff',target_id:'2',parent_store_id:'S',gross_profit_target:10}],allocations=[{task_id:'T',staff_id:2,allocated_target:10}];
 await overlayMigratedProfit(tasks,allocations,'2026-11',['S']);a.equal(tasks[0].gross_profit_target,200);a.equal(tasks[1].gross_profit_target,0);a.equal(tasks.find(x=>x.target_id==='3').gross_profit_target,250);a.deepEqual(allocations,[{task_id:'T',staff_id:3,allocated_target:250}]);
});
test('October legacy targets remain unchanged',async t=>{
 t.mock.method(M.MonthlyIndicatorDefinition,'findAll',async()=>a.fail('Historical legacy month must not query new goals'));
 const tasks=[{gross_profit_target:123}],allocations=[];await overlayMigratedProfit(tasks,allocations,'2026-10',['S']);a.equal(tasks[0].gross_profit_target,123);
});
