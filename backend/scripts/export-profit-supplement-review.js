const fs=require('node:fs'),path=require('node:path'),M=require('../src/models');
const dir=path.resolve(__dirname,'../../outputs/october-profit-review-20261110');
const source=JSON.parse(fs.readFileSync(path.join(dir,'source.json'),'utf8'));
const parse=v=>typeof v==='string'?JSON.parse(v):v||[];
(async()=>{
 const ids=[...new Set(source.rows.map(r=>r.orderId).filter(Boolean))];
 const [settlements,orderItems,snapshots,adjustments]=await Promise.all([
  M.ProductSettlementOrder.findAll({where:{source_order_id:ids},raw:true}),
  M.OrderItem.findAll({where:{order_id:ids},raw:true}),
  M.OrderGrossProfit.findAll({where:{order_id:ids},raw:true}),
  M.ProductSettlementAdjustment.findAll({where:{source_order_id:ids},raw:true})
 ]);
 const [items,returnItems,refs]=await Promise.all([
  M.ProductSettlementItem.findAll({where:{settlement_id:settlements.map(s=>s.settlement_id)},raw:true}),
  M.ProductSettlementAdjustmentItem.findAll({where:{adjustment_id:adjustments.map(s=>s.adjustment_id)},raw:true}),
  M.InventoryFoundationRef.findAll({where:{reference_key:orderItems.map(i=>'order_item:'+i.item_id)},raw:true})
 ]);
 const foundations=await M.InventoryFoundation.findAll({where:{basis_id:refs.map(r=>r.basis_id)},raw:true});
 const sns=await M.ProductSn.findAll({where:{sn_id:[...new Set([...orderItems,...items,...returnItems].map(i=>i.sn_id).filter(Boolean))]},attributes:['sn_id','sn_code','product_id'],raw:true});
 const targets=new Map(),system=[];
 const add=(orderId,itemId,item,returnNo)=>{
  const key=orderId+':'+itemId;if(targets.has(key))return;
  const oi=orderItems.find(x=>String(x.item_id)===String(itemId)&&x.order_id===orderId);
  const snapshot=snapshots.find(s=>s.order_id===orderId);
  const frozen=parse(snapshot?.product_pricing_details).find(x=>String(x.itemId)===String(itemId));
  const ref=refs.find(x=>x.reference_key==='order_item:'+itemId),basis=ref&&foundations.find(x=>x.basis_id===ref.basis_id);
  const linkedSn=sns.find(x=>String(x.sn_id)===String(oi?.sn_id||item.sn_id)&&x.product_id===(oi?.product_id||item.product_id));
  const values=[oi?.sn_code,item.sn_code,linkedSn?.sn_code].filter(Boolean).map(String),codes=[...new Set(values)];
  const events=source.rows.filter(x=>x.orderId===orderId);
  const priceKnown=frozen&&frozen.unitPricing!=null&&Number.isFinite(Number(frozen.unitPricing))&&!String(frozen.source||'').startsWith('missing_');
  const costMissing=!(Number(item.purchase_unit_cost)>0);
  const priceMissing=String(item.product_price_source||'').startsWith('missing_')||(!(Number(item.product_unit_price)>0)&&!priceKnown);
  const required=[costMissing?'实际采购单价（若为0需明确确认）':'',priceMissing?'原单结算定价依据':''].filter(Boolean).join('；')||'结算明细状态及来源依据复核';
  targets.set(key,{key,store:events[0]?.store||'',orderNo:events[0]?.orderNo||settlements.find(s=>s.source_order_id===orderId)?.source_order_no||'',
   events:events.map(e=>e.entryNo).join('；'),returnNo:returnNo||'',itemId:String(itemId),settlementItemId:String(item.settlement_item_id||''),
   product:oi?.product_name||item.product_name,pn:oi?.pn_code||item.pn_code||'',sn:codes[0]||'无SN记录',
   snNote:codes.length>1?'记录不一致：'+codes.join(' / '):codes.length?'已读取原商品准确关联':'原销售/结算明细及准确关联档案均无SN记录',
   quantity:Number(oi?.quantity||Math.abs(item.quantity)||1),storedCost:Number(item.purchase_unit_cost),storedPrice:Number(item.product_unit_price),status:item.cost_status,
   frozenCost:frozen?.purchasePriceKnown===true?frozen.purchasePrice??null:null,
   foundationCost:basis?.product_id===(oi?.product_id||item.product_id)&&basis?.status==='confirmed'?basis.purchase_cost:null,
   foundationId:basis?.basis_id||'',required,costMissing,priceMissing,fillCost:'',confirmZero:'',fillPrice:'',evidence:''});
 };
 for(const e of source.rows){
  const settlement=settlements.find(s=>s.source_order_id===e.orderId);
  if(e.product==null){
   const related=e.type==='退货'?returnItems.filter(i=>adjustments.some(a=>a.adjustment_id===i.adjustment_id&&a.source_return_no===e.entryNo)):items.filter(i=>i.settlement_id===settlement?.settlement_id);
   const pending=related.filter(i=>i.cost_status!=='ready');
   for(const i of pending)add(e.orderId,i.source_order_item_id,i,e.type==='退货'?e.entryNo:'');
   if(!pending.length)system.push({no:e.entryNo,orderNo:e.orderNo,store:e.store,reason:!settlement?'原销售产品结算缺失':'产品端汇总待核算，但未匹配到待补商品行',products:related.map(i=>i.product_name).join('；'),sns:[...new Set(related.map(i=>i.sn_code).filter(Boolean))].join('；')||'无SN记录',required:'系统核查结算汇总/退货关联，无需先填写采购成本'});
  }
  if(e.sales==null){const ret=await M.SalesReturnRequest.findOne({where:{return_no:e.entryNo},raw:true});const ri=ret?await M.SalesReturnRequestItem.findAll({where:{return_id:ret.return_id},raw:true}):[];
   system.push({no:e.entryNo,orderNo:e.orderNo,store:e.store,reason:'退货销售端毛利流水缺失',products:ri.map(i=>i.product_name).join('；'),sns:[...new Set(ri.map(i=>i.sn_code||orderItems.find(o=>String(o.item_id)===String(i.order_item_id))?.sn_code).filter(Boolean))].join('；')||'无SN记录',required:'核对原销售快照、退单流水；无需重复补已确认的产品成本'});
  }
 }
 const rows=[...targets.values()].sort((a,b)=>a.store.localeCompare(b.store,'zh-CN')||a.orderNo.localeCompare(b.orderNo));
 fs.writeFileSync(path.join(dir,'supplement-source.json'),JSON.stringify({asOf:new Date().toISOString(),sourceEvents:source.total,rows,system},null,2));
 console.log(JSON.stringify({rows:rows.length,withSN:rows.filter(r=>r.sn!=='无SN记录').length,missingCost:rows.filter(r=>r.costMissing).length,missingPrice:rows.filter(r=>r.priceMissing).length,system:system.length,snConflicts:rows.filter(r=>r.snNote.startsWith('记录不一致')).length}));
})().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>M.sequelize.close());
