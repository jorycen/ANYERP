const M=require('../../models');
async function overlayMigratedProfit(tasks,allocations,monthKey,storeIds){
 if(monthKey<'2026-11')return;
 const definitions=(await M.MonthlyIndicatorDefinition.findAll({raw:true})).filter(d=>d.config?.legacyGrossProfit);
 if(!definitions.length)return;
 const candidates=await M.MonthlyIndicator.findAll({where:{month_key:monthKey,definition_id:definitions.map(d=>d.definition_id),metric:'profit',...(storeIds?{store_id:storeIds}:{})},raw:true});
 const current=new Map();
 for(const row of candidates){const key=row.definition_id+':'+row.store_id,old=current.get(key);if(!old||(row.status===1&&old.status!==1))current.set(key,row);}
 const rows=[...current.values()];
 const assignments=await M.MonthlyIndicatorAssignment.findAll({where:{indicator_id:rows.map(r=>r.indicator_id)},raw:true});
 for(const row of rows){
  let task=tasks.find(t=>t.task_id===row.scope_config?.legacyTaskId)||tasks.find(t=>t.target_type==='store'&&t.target_id===row.store_id&&t.distributor_id===definitions.find(d=>d.definition_id===row.definition_id)?.distributor_id);
  if(!task){task={task_id:'indicator:'+row.indicator_id,target_type:'store',target_id:row.store_id,month_key:monthKey,distributor_id:definitions.find(d=>d.definition_id===row.definition_id)?.distributor_id,sales_target:0,status:1};tasks.push(task);}
  task.gross_profit_target=row.status===1?Number(row.target):0;
  for(let i=allocations.length-1;i>=0;i--)if(allocations[i].task_id===task.task_id)allocations.splice(i,1);
  const people=row.status===1?assignments.filter(a=>a.indicator_id===row.indicator_id):[];
  for(const person of people)if(!tasks.some(t=>t.target_type==='staff'&&String(t.target_id)===String(person.staff_id)&&t.distributor_id===task.distributor_id))tasks.push({task_id:'assignment:'+person.assignment_id,target_type:'staff',target_id:String(person.staff_id),parent_store_id:row.store_id,month_key:monthKey,distributor_id:task.distributor_id,sales_target:0,status:1});
  allocations.push(...people.map(a=>({task_id:task.task_id,staff_id:a.staff_id,allocated_target:a.target})));
  for(const staff of tasks.filter(t=>t.target_type==='staff'&&t.parent_store_id===row.store_id))staff.gross_profit_target=Number(people.find(a=>String(a.staff_id)===String(staff.target_id))?.target||0);
 }
}
module.exports={overlayMigratedProfit};
