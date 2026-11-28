const {createHash}=require('node:crypto');
function groupKey(row){
 return row.definition_id || createHash('sha256').update(JSON.stringify([row.name,row.source,row.role_codes||[row.role_code],row.category_ids||[],row.product_ids||[],row.scope_config||{},row.check_method,row.requirements])).digest('hex').slice(0,32);
}
function groupedOverview(overview,plans,stores,definitions=[],anchors=[]){
 const groups=new Map();
 for(const row of overview){
  const store=stores.find(s=>s.store_id===row.storeId);
  const definitionId=row.metrics[0]?.definition_id;
  const id=[store?.distributor_id,row.source,row.source==='store'?row.storeId:'',groupKey(row.metrics[0])].join(':');
  const group=groups.get(id)||{id,definitionId,anchorId:row.metrics[0]?.indicator_id,name:row.name,source:row.source,kind:row.kind,distributorId:store?.distributor_id,stores:[],metrics:[],canDelete:!!store?.[row.source==='company'?'company':'manager']};
  group.stores.push(row);groups.set(id,group);
 }
 for(const plan of plans.filter(p=>p.status===1)){
  const d=definitions.find(d=>d.definition_id===plan.definition_id);if(!d)continue;
  const allowed=stores.some(s=>s.distributor_id===d.distributor_id&&(d.source==='company'?s.company:s.manager&&s.store_id===d.store_id));if(!allowed)continue;
  const id=[d.distributor_id,d.source,d.source==='store'?d.store_id:'',d.definition_id].join(':');
  const anchor=anchors.find(r=>r.definition_id===d.definition_id);if(!groups.has(id)&&anchor)groups.set(id,{id,definitionId:d.definition_id,anchorId:anchor.indicator_id,name:d.name,source:d.source,kind:d.config.kind,distributorId:d.distributor_id,stores:[],metrics:[],canDelete:true});
 }
 return [...groups.values()].map(g=>{
  const plan=g.source==='company'&&!g.canDelete?null:plans.find(p=>p.definition_id===g.definitionId&&p.status===1);
  for(const row of g.stores)for(const m of row.metrics){if(m.status!==1)continue;let total=g.metrics.find(x=>x.metric===m.metric);if(!total){total={metric:m.metric,target:0,storeAllocated:0,allocated:0};g.metrics.push(total);}total.storeAllocated+=Number(m.target);total.allocated+=m.allocated;}
  for(const metric of Object.keys(plan?.company_targets||{}))if(!g.metrics.some(m=>m.metric===metric))g.metrics.push({metric,target:0,storeAllocated:0,allocated:0});
  for(const m of g.metrics){m.target=Number(plan?.company_targets?.[m.metric]??m.storeAllocated);for(const field of ['target','storeAllocated','allocated'])m[field]=Math.round(m[field]*100)/100;}
  return {...g,storeCount:g.stores.length};
 });
}
module.exports={groupKey,groupedOverview};
