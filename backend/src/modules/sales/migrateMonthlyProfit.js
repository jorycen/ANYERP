const {createHash}=require('node:crypto');
const M=require('../../models');
const {Op}=require('sequelize');
const id=s=>createHash('sha256').update(s).digest('hex').slice(0,32);
const CUTOVER='2026-11';
async function migrateLegacyProfit({apply=false}={}){
 const tasks=await M.MonthlyTask.findAll({where:{month_key:{[Op.gte]:CUTOVER},status:1},raw:true});
 const allocations=await M.MonthlyTaskGrossProfitAllocation.findAll({where:{task_id:tasks.map(t=>t.task_id)},raw:true});
 const staff=await M.Staff.findAll({attributes:['staff_id','store_id'],raw:true});
 const roles=await M.Role.findAll({where:{status:1},attributes:['role_code'],raw:true});
 const groups=new Map();
 for(const task of tasks.filter(t=>t.target_type==='store'&&Number(t.gross_profit_target)>0)){
  const key=task.distributor_id+':'+task.month_key;const g=groups.get(key)||[];g.push(task);groups.set(key,g);
 }
 const report=[];
 for(const [key,stores]of groups){const tx=await M.sequelize.transaction();try{
  const definitionId=id('legacy-profit:'+stores[0].distributor_id),month=stores[0].month_key;
  const planId=id('legacy-plan:'+key);
  if(await M.MonthlyIndicatorPlan.findByPk(planId,{transaction:tx,lock:tx.LOCK.UPDATE})){await tx.rollback();report.push({group:key,skipped:'已迁移，保留新版后续修改'});continue;}
  let definition=await M.MonthlyIndicatorDefinition.findByPk(definitionId,{transaction:tx,lock:tx.LOCK.UPDATE});
  if(!definition)definition=await M.MonthlyIndicatorDefinition.create({definition_id:definitionId,distributor_id:stores[0].distributor_id,store_id:null,source:'company',name:'毛利',status:1,config:{kind:'operating',allProducts:true,legacyGrossProfit:true,metrics:['profit'],roleCodes:roles.map(r=>r.role_code),categoryIds:[],requirements:''}},{transaction:tx});
  const existing=await M.MonthlyIndicator.findAll({where:{month_key:month,store_id:stores.map(s=>s.target_id),metric:'profit',source:'company',status:1},transaction:tx,lock:tx.LOCK.UPDATE});
  let migrated=0,people=0;
  for(const task of stores){
   const indicatorId=id('legacy-profit:'+task.task_id);
   const equivalent=existing.filter(r=>!r.category_ids?.length&&!r.product_ids?.length&&r.scope_config?.kind!=='ability'&&r.store_id===task.target_id);
   let row=await M.MonthlyIndicator.findByPk(indicatorId,{transaction:tx});
   if(!row&&equivalent.length)throw Error('已有新版全商品毛利目标，需核对后合并：'+task.target_id);
   if(!row){row=await M.MonthlyIndicator.create({indicator_id:indicatorId,definition_id:definitionId,release_id:id('legacy-release:'+key),month_key:month,store_id:task.target_id,source:'company',name:'毛利',role_code:roles[0]?.role_code||'staff',role_codes:roles.map(r=>r.role_code),metric:'profit',target:task.gross_profit_target,product_ids:[],category_ids:[],scope_config:{kind:'operating',legacyTaskId:task.task_id},requirements:'',status:1,created_by:task.create_staff_id||0},{transaction:tx});migrated++;}
   // A rerun must never overwrite targets subsequently edited in the new UI.
   const map=new Map();
   for(const x of allocations.filter(a=>a.task_id===task.task_id&&Number(a.allocated_target)>0))map.set(String(x.staff_id),Number(x.allocated_target));
   for(const st of tasks.filter(t=>t.target_type==='staff'&&t.month_key===month&&t.distributor_id===task.distributor_id&&Number(t.gross_profit_target)>0&&String(t.parent_store_id||staff.find(s=>String(s.staff_id)===String(t.target_id))?.store_id)===String(task.target_id))){
    const prev=map.get(String(st.target_id));if(prev!==undefined&&prev!==Number(st.gross_profit_target))throw Error('旧版个人目标与分解目标冲突：'+st.target_id);
    map.set(String(st.target_id),Number(st.gross_profit_target));
   }
   for(const [staffId,target]of map){const assignmentId=id('legacy-assignment:'+indicatorId+':'+staffId);if(!await M.MonthlyIndicatorAssignment.findByPk(assignmentId,{transaction:tx})){await M.MonthlyIndicatorAssignment.create({assignment_id:assignmentId,indicator_id:indicatorId,staff_id:staffId,target},{transaction:tx});people++;}}
  }
  if(!await M.MonthlyIndicatorPlan.findByPk(planId,{transaction:tx}))await M.MonthlyIndicatorPlan.create({plan_id:planId,definition_id:definitionId,month_key:month,company_targets:{profit:Math.round(stores.reduce((s,t)=>s+Number(t.gross_profit_target),0)*100)/100},status:1},{transaction:tx});
  await require('../../utils/businessActionLog').recordBusinessAction({businessType:'monthly_indicator_migration',businessId:planId,action:'migrate_legacy_profit',user:{name:'monthly-profit-20261107'},detail:{cutover:CUTOVER,group:key,stores:migrated,people},transaction:tx});
  if(apply)await tx.commit();else await tx.rollback();report.push({group:key,stores:migrated,assignments:people,apply});
 }catch(e){if(!tx.finished)await tx.rollback();report.push({group:key,error:e.message});}}
 return report;
}
module.exports={migrateLegacyProfit,CUTOVER};
