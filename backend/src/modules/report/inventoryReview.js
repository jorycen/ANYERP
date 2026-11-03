// One shared source for explicit inventory valuation confirmations. No invoice facts are invented.
const crypto=require('crypto');
const signature=row=>crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');
const snState=s=>[s.sn_id,s.product_id,s.store_id,s.location_id,s.status,Number(s.inbound_price),String(s.batch_no||''),s.update_time?new Date(s.update_time).toISOString():null];
const inventoryState=s=>[s.inventory_id,s.product_id,s.store_id,s.location_id,...['regular_qty','subsidy_qty','second_qty','normal_qty','pending_qty','display_qty','demo_qty','rental_demo_qty','unsellable_qty'].map(k=>Number(s[k]||0)),s.update_time?new Date(s.update_time).toISOString():null];
function matches(detail,state){return !!detail&&detail.signature===signature(state);}
async function load(transaction){
 const M=require('../../models');
 const rows=await M.BusinessActionLog.findAll({where:{business_type:'inventory_review',action:'valuation_confirmed'},order:[['create_time','DESC'],['log_id','DESC']],raw:true,transaction});
 const map=new Map();for(const r of rows){if(map.has(r.business_id))continue;try{map.set(r.business_id,JSON.parse(r.detail_json));}catch{}}
 return map;
}
function taxOverride(map,key,state){const d=map.get(key);return matches(d,state)?{status:'manual_confirmed',invoiceType:d.invoiceType,evidenceSource:'manual_review',reason:'用户回填确认，预计测算；未代替真实发票或采购关联',reviewBatch:d.batch}:null;}
module.exports={signature,snState,inventoryState,matches,load,taxOverride};
