const {test}=require('node:test'),a=require('node:assert/strict'),T=require('../src/modules/report/dashboardTargets');
test('毛利目标按自然日跨月折算，闰年二月正确',()=>{
 const slices=T.monthSlices('2024-02-28','2024-03-02');
 a.deepEqual(slices,[{month:'2024-02',days:2,totalDays:29},{month:'2024-03',days:2,totalDays:31}]);
 const tasks=[{month_key:'2024-02',target_type:'store',target_id:'S',status:1,gross_profit_target:2900},{month_key:'2024-03',target_type:'store',target_id:'S',status:1,gross_profit_target:6200}];
 a.equal(T.prorate(tasks,slices,'S'),600);
 a.equal(T.prorate(tasks.slice(0,1),slices,'S'),null);
 a.equal(T.prorate([...tasks,tasks[0]],slices,'S'),null);
});
