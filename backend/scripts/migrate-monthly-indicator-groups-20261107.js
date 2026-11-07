const M=require('../src/models'),{Op}=require('sequelize'),{groupKey}=require('../src/modules/sales/monthlyIndicatorOverview'),{createHash}=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const id=s=>createHash('sha256').update(s).digest('hex').slice(0,32);
async function main(){
 const apply=process.argv.includes('--apply'),rows=await M.MonthlyIndicator.findAll({where:{month_key:{[Op.gte]:'2026-11'},definition_id:null,status:{[Op.gte]:0}},raw:true}),stores=await M.Store.findAll({attributes:['store_id','distributor_id'],raw:true}),groups=new Map(),dir=path.resolve(__dirname,'../backup/monthly-profit-20261107');fs.mkdirSync(dir,{recursive:true});
 if(apply)fs.writeFileSync(path.join(dir,'legacy-indicators-'+Date.now()+'.json'),JSON.stringify(rows,null,2),{flag:'wx'});
 for(const row of rows){const store=stores.find(s=>s.store_id===row.store_id);if(!store)throw Error('门店不存在：'+row.store_id);const k=[store.distributor_id,row.source,row.source==='store'?row.store_id:'',groupKey(row)].join(':');const g=groups.get(k)||[];g.push(row);groups.set(k,g);}
 const report=[];
 for(const [key,list]of groups){await M.sequelize.transaction(async transaction=>{
  const first=list[0],definitionId=id('group-definition:'+key),kind=first.metric==='management'?'management':'operating';
  if(first.product_ids?.length)throw Error('旧指标含固定商品范围，需单独核对：'+first.name);
  const config={kind,metrics:[...new Set(list.map(r=>r.metric))],roleCodes:first.role_codes||[first.role_code],categoryIds:first.category_ids||[],allProducts:kind==='operating'&&!first.category_ids?.length,checkMethod:first.check_method||'photo',requirements:first.requirements||''};
  if(!await M.MonthlyIndicatorDefinition.findByPk(definitionId,{transaction}))await M.MonthlyIndicatorDefinition.create({definition_id:definitionId,distributor_id:stores.find(s=>s.store_id===first.store_id).distributor_id,store_id:first.source==='store'?first.store_id:null,source:first.source,name:first.name,config,status:1},{transaction});
  for(const month of [...new Set(list.map(r=>r.month_key))]){
   const subset=list.filter(r=>r.month_key===month),targets={};for(const r of subset.filter(r=>r.status===1))targets[r.metric]=Math.round(((targets[r.metric]||0)+Number(r.target))*100)/100;
   const planId=id('group-plan:'+key+':'+month);if(!await M.MonthlyIndicatorPlan.findByPk(planId,{transaction}))await M.MonthlyIndicatorPlan.create({plan_id:planId,definition_id:definitionId,month_key:month,company_targets:targets,status:1},{transaction});
   if(apply)await M.MonthlyIndicator.update({definition_id:definitionId,release_id:id('group-release:'+key+':'+month),scope_config:{kind}},{where:{indicator_id:subset.map(r=>r.indicator_id),definition_id:null},transaction});
  }
  if(apply)await require('../src/utils/businessActionLog').recordBusinessAction({businessType:'monthly_indicator_migration',businessId:definitionId,action:'group_legacy_indicators',user:{name:'monthly-group-20261107'},detail:{ids:list.map(r=>r.indicator_id)},transaction});
  // Preview rolls back the transaction as well as association updates.
  if(!apply)throw Object.assign(Error('PREVIEW'),{preview:true});
 }).catch(e=>{if(!e.preview)throw e;});report.push({name:list[0].name,rows:list.length,apply});}
 console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>M.sequelize.close());
