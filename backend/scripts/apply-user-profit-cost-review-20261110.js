const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const M=require('../src/models'),S=require('../src/modules/report/productCostSupplement');
const root=path.resolve(__dirname,'../../outputs/october-profit-review-20261110');
const review=JSON.parse(fs.readFileSync(path.join(root,'returned-review.json'),'utf8'));
const baseline=JSON.parse(fs.readFileSync(path.join(root,'supplement-source.json'),'utf8'));
const batch='USER-PRODUCT-COST-20261110-'+review.sha256.slice(0,10),dir=path.resolve(__dirname,'../backup/order-corrections',batch);
const plain=x=>JSON.parse(JSON.stringify(x?.toJSON?x.toJSON():x));
const sha=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const parse=v=>typeof v==='string'?JSON.parse(v):v||[];
const month=v=>new Date(new Date(v).getTime()+28800000).toISOString().slice(0,7);
const user={name:'用户回填清单确认（本会话授权）',roles:['boss'],accessibleStoreIds:['*'],accessibleDistributorIds:['*']};
function context(settlementId,body){return{params:{settlementId},request:{body},state:{user},throw(status,message){throw Object.assign(new Error(message),{status})}}}
async function lockedPeriods(settlement,adjustments){
 const months=[...new Set(['2026-10',...[settlement.business_date,...adjustments.map(a=>a.business_date)].filter(Boolean).map(month)])];
 const closed=await M.sequelize.query('SELECT MONTH_KEY FROM T_FINANCIAL_PROFIT_PERIOD WHERE MONTH_KEY IN (:months)',{replacements:{months},type:M.sequelize.QueryTypes.SELECT});
 return closed.map(r=>r.MONTH_KEY);
}
async function facts(settlement){
 const order=await M.Order.findByPk(settlement.source_order_id,{raw:true});
 const [items,snap,settlementItems,adjustments]=await Promise.all([
 M.OrderItem.findAll({where:{order_id:order.order_id},order:[['item_id','ASC']],raw:true}),
 M.OrderGrossProfit.findOne({where:{order_id:order.order_id},raw:true}),
 M.ProductSettlementItem.findAll({where:{settlement_id:settlement.settlement_id},order:[['settlement_item_id','ASC']],raw:true}),
 M.ProductSettlementAdjustment.findAll({where:{source_order_id:order.order_id},order:[['adjustment_id','ASC']],raw:true})]);
 const returnItems=adjustments.length?await M.ProductSettlementAdjustmentItem.findAll({where:{adjustment_id:adjustments.map(a=>a.adjustment_id)},order:[['adjustment_item_id','ASC']],raw:true}):[];
 return plain({order,items,snap,settlement,settlementItems,adjustments,returnItems});
}
(async()=>{
 assert.equal(review.mismatches.length,0,'回填表原定位列有变更');assert.equal(review.extraRows,0,'存在新增行');
 fs.mkdirSync(dir,{recursive:true});
 const fileHash=crypto.createHash('sha256').update(fs.readFileSync(review.source)).digest('hex');assert.equal(fileHash,review.sha256,'用户文件已变化');
 let skipped=review.invalid.map(r=>({row:r.row,reason:r.reason})),alreadyConfirmed=[];const groups=new Map(),plans=[];
 const reviewedMode=process.argv.includes('--apply-reviewed');
 if(reviewedMode){
  const saved=JSON.parse(fs.readFileSync(path.join(dir,'preview-summary.json'),'utf8'));
  assert.equal(saved.summary.batch,batch);skipped=saved.skipped;alreadyConfirmed=saved.alreadyConfirmed||[];
  plans.push(...fs.readdirSync(dir).filter(f=>f.endsWith('.before.json')).map(f=>JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'))));
  assert.equal(plans.length,saved.summary.orders,'备份与已审核预检数量不一致');
 }
 const originalItems=reviewedMode?[]:await M.OrderItem.findAll({where:{item_id:review.changes.map(r=>r.orderItemId)},raw:true});
 const originalOrders=originalItems.length?await M.Order.findAll({where:{order_id:[...new Set(originalItems.map(i=>i.order_id))]},raw:true}):[];
 const originalSettlements=originalOrders.length?await M.ProductSettlementOrder.findAll({where:{source_order_id:originalOrders.map(o=>o.order_id)},raw:true}):[];
 const originalSettlementItems=originalSettlements.length?await M.ProductSettlementItem.findAll({where:{settlement_id:originalSettlements.map(s=>s.settlement_id)},raw:true}):[];
 for(const r of reviewedMode?[]:review.changes){
  const base=baseline.rows.find(x=>String(x.itemId)===r.orderItemId&&x.orderNo===r.orderNo);assert(base,'原始导出清单找不到商品');
  const oi=originalItems.find(i=>String(i.item_id)===r.orderItemId);
  if(!oi||oi.product_name!==r.name||String(oi.pn_code||'')!==r.pn){skipped.push({...r,reason:'原商品名称/PN/身份已变化'});continue}
  const o=originalOrders.find(o=>o.order_id===oi.order_id);if(o?.order_no!==r.orderNo){skipped.push({...r,reason:'原订单身份不一致'});continue}
  const settlement=originalSettlements.find(s=>s.source_order_id===oi.order_id);
  const candidates=settlement?originalSettlementItems.filter(i=>i.settlement_id===settlement.settlement_id&&String(i.source_order_item_id)===r.orderItemId):[];
  if(candidates.length!==1){skipped.push({...r,reason:'原销售产品结算明细缺失或不唯一，不能按退货明细猜写'});continue}
  const item=candidates[0];
  if(r.itemId&&String(item.settlement_item_id)!==r.itemId){skipped.push({...r,reason:'产品结算商品行不一致'});continue}
  const storedSn=oi.sn_code||item.sn_code||'';
  if(r.sn!=='无SN记录'&&storedSn&&r.sn!==storedSn){skipped.push({...r,reason:'SN与导出不一致'});continue}
  if(item.cost_status==='ready'||Number(item.purchase_unit_cost)!==Number(r.beforeCost)||Number(item.product_unit_price)!==Number(r.beforePrice)){
   skipped.push({...r,reason:'结算成本/定价或状态已变化，保留当前值'});continue;
  }
  if(item.cost_source==='manual_sold_cost'&&Number(item.purchase_unit_cost)===r.unitCost){alreadyConfirmed.push({...r,itemId:String(item.settlement_item_id),reason:'已人工确认成本与本次回填一致，保留原记录'});continue}
  if(r.priceInput!=null&&String(r.priceInput).trim()!==''){skipped.push({...r,reason:'定价变更需要单独审批，本脚本仅回填采购成本'});continue}
  const g=groups.get(settlement.settlement_id)||{settlement,rows:[]};g.rows.push({...r,itemId:String(item.settlement_item_id)});groups.set(settlement.settlement_id,g);
 }
 for(const [id,g]of groups){
  const before=await facts(g.settlement),closed=await lockedPeriods(g.settlement,before.adjustments);
  if(closed.length){skipped.push(...g.rows.map(r=>({...r,reason:'期间已关账：'+closed.join('、')})));continue}
  const body={items:g.rows.map(r=>({itemId:r.itemId,unitCost:r.unitCost,confirmZero:r.confirmZero}))};
  try{const ctx=context(id,body);await S.preview(ctx);const preview=ctx.body.data;
   const priceChanges=preview.items.filter(i=>Number(i.before.product_unit_price)!==Number(i.after.product_unit_price));
   if(priceChanges.length){skipped.push(...g.rows.map(r=>({...r,reason:'现有服务将改变原结算定价，需另核对后处理'})));continue}
   const plan={id,rows:g.rows,body,before,preview};
   if(!fs.existsSync(path.join(dir,id+'.before.json')))fs.writeFileSync(path.join(dir,id+'.before.json'),JSON.stringify(plan,null,2),{flag:'wx'});
   plans.push(plan);
  }catch(e){skipped.push(...g.rows.map(r=>({...r,reason:e.message})))}
 }
 const summary={batch,phase:'preview',orders:plans.length,items:plans.reduce((s,p)=>s+p.rows.length,0),alreadyConfirmed:alreadyConfirmed.length,willResolveItems:plans.reduce((s,p)=>s+p.preview.items.filter(i=>i.after.cost_status==='ready').length,0),stillPendingItems:plans.reduce((s,p)=>s+p.preview.items.filter(i=>i.after.cost_status!=='ready').length,0),skipped:skipped.length};
 console.log(JSON.stringify(summary));fs.writeFileSync(path.join(dir,'preview-summary.json'),JSON.stringify({summary,skipped,alreadyConfirmed},null,2));
 if(!process.argv.includes('--apply')&&!reviewedMode)return;
 fs.copyFileSync(review.source,path.join(dir,'user-confirmed-source.xlsx'));
 fs.writeFileSync(path.join(dir,'input-confirmation.json'),JSON.stringify(review,null,2));
 const applied=[],failed=[];
 for(const p of plans){
  try{
   const current=await facts(await M.ProductSettlementOrder.findByPk(p.id,{raw:true}));assert.equal(sha(current),sha(p.before),'执行前资料已变化');
   assert.equal((await lockedPeriods(current.settlement,current.adjustments)).length,0,'期间已关账');
   const ctx=context(p.id,{...p.body,previewHash:p.preview.previewHash,reason:batch+'；依据用户回填清单明确确认实际采购成本；不修改原销售毛利、订单和收款'});
   await S.apply(ctx);
   const after=await facts(await M.ProductSettlementOrder.findByPk(p.id,{raw:true}));
   assert.deepEqual(after.order,p.before.order,'原订单发生变化');assert.deepEqual(after.items,p.before.items,'原销售商品行发生变化');assert.deepEqual(after.snap,p.before.snap,'销售毛利快照发生变化');
   for(const r of p.rows){const item=after.settlementItems.find(i=>String(i.settlement_item_id)===r.itemId);assert.equal(Number(item.purchase_unit_cost),r.unitCost);assert.equal(Number(item.product_unit_price),Number(r.beforePrice));}
   fs.writeFileSync(path.join(dir,p.id+'.verified.json'),JSON.stringify({rows:p.rows,result:ctx.body.data,after,verified:true},null,2));applied.push({orderNo:p.before.order.order_no,rows:p.rows,afterStatus:after.settlement.status});
  }catch(e){failed.push({id:p.id,rows:p.rows,reason:e.message});console.error('FAILED',p.id,e.message)}
 }
 fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({batch,applied,failed,skipped,alreadyConfirmed},null,2));
 console.log(JSON.stringify({batch,phase:'applied',orders:applied.length,items:applied.reduce((s,p)=>s+p.rows.length,0),alreadyConfirmed:alreadyConfirmed.length,failed:failed.length,skipped:skipped.length}));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>M.sequelize.close());
