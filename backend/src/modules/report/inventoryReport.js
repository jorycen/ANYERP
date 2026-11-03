const M=require('../../models');
const {Op,QueryTypes}=require('sequelize');
const {resolveReportStoreIds}=require('../../utils/storePermissions');
const {knownCost,confirmedZeroSnIds}=require('../../utils/costKnowledge');
const {FIELDS,getInventoryQuantitySnapshot}=require('../../utils/inventoryQuantities');
const round=v=>Math.round((Number(v)+Number.EPSILON)*100)/100;
const TYPES={normal_qty:'可售',pending_qty:'占用',display_qty:'展示',demo_qty:'样机',rental_demo_qty:'租赁样机',unsellable_qty:'残次'};
const allowed=['category','store','product'];
function nonPhysicalReason(p){
 const text=`${p.name||''} ${p.product_code||''}`;
 if(/care/i.test(text)&&/售后|服务|care/i.test(p.category||''))return 'CARE服务权益';
 if(Number(p.need_sn)!==1 && (p.brand==='服务'||['次','年','月'].includes(p.unit)||p.name==='纯利润'||/^(电脑(检测|优化|故障)维修|检测[-－]|服务[-－])/.test(p.name||'')||/保值换新|碎屏险|延保|意外险/.test(p.name||'')))return '明确服务或虚拟项目';
 return '';
}
function dimensions(value){
 const result=[...new Set((Array.isArray(value)?value:String(value||'category').split(',')).filter(Boolean))];
 if(!result.length||result.some(v=>!allowed.includes(v)))throw Object.assign(Error('请至少选择分类、门店或产品中的一个维度'),{status:400});
 return allowed.filter(v=>result.includes(v));
}
function taxEstimate(cost,type){
 if(cost===null)return {net:null,tax:null};
 if(cost===0)return {net:0,tax:0};
 const document=String(type||'');
 if(/专票|增值税专用/.test(document)){
  const match=document.match(/(\d+(?:\.\d+)?)\s*%/);if(!match)return {net:null,tax:null};
  const rate=Number(match[1])/100;if(rate<0||rate>1)return {net:null,tax:null};
  const amounts=require('../finance/invoiceAmounts').invoiceAmounts(cost,rate);
  return {net:amounts.amountWithoutTax,tax:amounts.taxAmount};
 }
 if(/收据|普通发票|普票/.test(document))return {net:cost,tax:0};
 return {net:null,tax:null};
}
function bucket(time,at){
 if(!time||!Number.isFinite(new Date(time).getTime())||new Date(time)>at)return 'unknown';
 const days=Math.floor((at-new Date(time))/86400000);return days<=30?'d0_30':days<=60?'d31_60':days<=90?'d61_90':'d90_plus';
}
function categoryPaths(rows){
 const map=new Map(rows.map(row=>[String(row.category_id),row])),paths=new Map(),order=new Map();
 function path(row,seen=new Set()){
  if(!row||seen.has(String(row.category_id)))return '';
  seen.add(String(row.category_id));const parent=map.get(String(row.parent_id));
  return [parent?path(parent,seen):'',row.name].filter(Boolean).join('/');
 }
 for(const row of rows)paths.set(String(row.category_id),path(row));
 function visit(parent){for(const row of rows.filter(r=>String(r.parent_id||'')===parent).sort((a,b)=>Number(a.sort_order||0)-Number(b.sort_order||0)||String(a.category_id).localeCompare(String(b.category_id)))){const p=paths.get(String(row.category_id));if(order.has(p))continue;order.set(p,order.size);visit(String(row.category_id));}}
 visit('');return {paths,order};
}
function aggregate(details,dims){
 const groups=new Map();
 for(const d of details){
  const key=JSON.stringify(dims.map(k=>k==='product'?d.productId:k==='store'?d.storeId:d.category));
  if(!groups.has(key))groups.set(key,{key,category:dims.includes('category')?d.category:'',storeName:dims.includes('store')?d.storeName:'',productId:dims.includes('product')?d.productId:'',productCode:dims.includes('product')?d.productCode:'',productName:dims.includes('product')?d.productName:'',
   totalCount:0,knownCostAmount:0,estimatedCostAmount:0,knownCostCount:0,estimatedCostCount:0,missingCostCount:0,confirmedZeroCount:0,taxPendingCount:0,taxEstimateCoveredCount:0,netEstimateAmount:0,estimatedTaxAmount:0,
   d0_30:0,d31_60:0,d61_90:0,d90_plus:0,unknown:0,ageAmounts:{d0_30:0,d31_60:0,d61_90:0,d90_plus:0,unknown:0},ageMissing:{d0_30:0,d31_60:0,d61_90:0,d90_plus:0,unknown:0},...Object.fromEntries(FIELDS.map(k=>[k,0]))});
  const r=groups.get(key);r.totalCount+=d.quantity;r[d.type]+=d.quantity;r[d.ageBucket]+=d.quantity;
  if(d.costAmount===null){r.missingCostCount+=d.quantity;r.ageMissing[d.ageBucket]+=d.quantity;}
  else{r[d.estimated?'estimatedCostAmount':'knownCostAmount']+=d.costAmount;r[d.estimated?'estimatedCostCount':'knownCostCount']+=d.quantity;r.ageAmounts[d.ageBucket]+=d.costAmount;if(d.unitCost===0)r.confirmedZeroCount+=d.quantity;}
  if(d.netEstimate===null)r.taxPendingCount+=d.quantity;
  else{r.netEstimateAmount+=d.netEstimate;r.estimatedTaxAmount+=d.estimatedTax;r.taxEstimateCoveredCount+=d.quantity;}
 }
 return [...groups.values()].map(r=>{
  for(const k of ['knownCostAmount','estimatedCostAmount','netEstimateAmount','estimatedTaxAmount'])r[k]=round(r[k]);
  r.coveredCostAmount=round(r.knownCostAmount+r.estimatedCostAmount);r.totalCost=r.missingCostCount?null:r.coveredCostAmount;
  r.netAmount=r.taxPendingCount?null:r.netEstimateAmount;r.staleCount=r.d31_60+r.d61_90+r.d90_plus;r.staleRate=r.totalCount?round(r.staleCount/r.totalCount*100):0;
  r.costStatus=r.missingCostCount?'待补成本':r.estimatedCostCount?'含估算成本':'已知成本';
  r.taxStatus=r.totalCount===r.confirmedZeroCount?'零成本':'按采购凭证测算，待税务核实';
  for(const k of Object.keys(r.ageAmounts))r.ageAmounts[k]=round(r.ageAmounts[k]);
  return r;
 }).sort((a,b)=>b.coveredCostAmount-a.coveredCostAmount||a.key.localeCompare(b.key));
}
async function load(query,user){
 const dims=dimensions(query.dimensions);
 return M.sequelize.transaction({readOnly:true},async transaction=>{
  const scope=await resolveReportStoreIds(user);
  if(query.storeId&&!scope.includes('*')&&!scope.map(String).includes(String(query.storeId)))throw Object.assign(Error('无权访问该门店库存报表'),{status:403});
  const where={};if(!scope.includes('*'))where.store_id={[Op.in]:scope};if(query.storeId)where.store_id=query.storeId;if(query.regionId)where.region_id=query.regionId;if(query.distributorId)where.distributor_id=query.distributorId;
  const stores=await M.Store.findAll({where,raw:true,transaction}),storeIds=stores.map(r=>r.store_id);
  const at=new Date();
  const [sns,stock,locations]=await Promise.all([
   M.ProductSn.findAll({where:{is_deleted:0,status:'in_stock',store_id:{[Op.in]:storeIds}},raw:true,transaction}),
   M.Inventory.findAll({where:{store_id:{[Op.in]:storeIds}},raw:true,transaction}),
   M.Location.findAll({where:{store_id:{[Op.in]:storeIds}},raw:true,transaction})]);
  const ids=[...new Set([...sns,...stock].map(r=>r.product_id))];
  const products=ids.length?await M.Product.findAll({where:{product_id:{[Op.in]:ids}},raw:true,transaction}):[];
  const categoryRows=await M.ProductCategory.findAll({where:{status:1},attributes:['category_id','parent_id','name','sort_order'],raw:true,transaction});
  const categories=categoryPaths(categoryRows);
  const prices=ids.length?await M.ProductPrice.findAll({where:{product_id:{[Op.in]:ids},status:1,[Op.or]:[{effective_time:{[Op.lte]:at}},{effective_time:null}]},order:[['effective_time','DESC'],['price_id','DESC']],raw:true,transaction}):[];
  const zero=await confirmedZeroSnIds(sns,transaction);
  const evidenceService=require('./inventoryEvidence');
  const evidence=await evidenceService.loadEvidence(M.sequelize,ids,transaction,at);
  const pmap=new Map(products.map(p=>[p.product_id,p])),smap=new Map(stores.map(s=>[s.store_id,s])),lmap=new Map(locations.map(l=>[l.location_id,l]));
  const details=[],excluded=[];
  const add=(p,storeId,locationId,type,quantity,unitCost,estimated,costSource,sn,time,invoice,source={})=>{
   if(!(quantity>0))return;
   const category=categories.paths.get(String(p.category_id))||[p.category,p.brand,p.series,p.model].filter(Boolean).join('/');
   if(query.category&&category!==query.category&&!category.startsWith(query.category+'/'))return;
   if(query.keyword&&!`${p.name||''} ${p.product_code||''} ${sn?.sn_code||''} ${sn?.pn_code||''}`.toLowerCase().includes(String(query.keyword).toLowerCase()))return;
   if(query.inventoryType&&type!==query.inventoryType)return;
   const reason=nonPhysicalReason(p);
   if(reason){excluded.push({productCode:p.product_code,productName:p.name,category,storeName:smap.get(storeId)?.name||storeId,quantity,reason});return;}
   const costAmount=unitCost===null?null:round(unitCost*quantity),tax=taxEstimate(costAmount,invoice);
   details.push({productId:p.product_id,productCode:p.product_code||'',productName:p.name||'未命名商品',category:category||'未分类',storeId,storeName:smap.get(storeId)?.name||storeId,location:lmap.get(locationId)?.name||locationId||'未指定库位',type,typeName:TYPES[type]||type,
    quantity,unitCost,costAmount,estimated,costSource,sn:sn?.sn_code||'',pn:sn?.pn_code||'',inboundTime:time||null,ageBucket:bucket(time,at),netEstimate:tax.net,estimatedTax:tax.tax,invoiceType:invoice||'待核实',evidenceStatus:source.status||'unlinked',evidenceStatusLabel:({linked:'已关联',unlinked:'未关联',conflict:'来源冲突',owner_pending:'经销商归属待确认',invoice_pending:'票种税率待确认',invoice_conflict:'发票口径冲突',batch_pending:'采购批次待对应'})[source.status]||'未关联',evidenceReason:source.reason||'',purchaseRequestNo:source.requestNo||'',sourceInboundNo:source.inboundNo||'',invoiceNos:source.invoiceNos||'',invoiceSource:source.evidenceSource==='registered_invoice'?'已登记采购发票':source.evidenceSource==='purchase_request'?'采购申请约定':'待关联',sourceCandidateCount:source.candidateCount||0,sourceCandidates:source.candidates||[],scopeWarning:Number(p.need_sn)!==1&&p.category==='售后'?'售后非SN项目，实物属性待核对':''});
  };
  for(const sn of sns){
   const p=pmap.get(sn.product_id);if(!p||Number(p.need_sn)!==1)continue;
   const source=evidenceService.resolveSnEvidence(sn,evidence.receipts,smap.get(sn.store_id)?.distributor_id,evidence.invoices,at);
   const cost=knownCost(sn.inbound_price,zero.has(String(sn.sn_id)));
   add(p,sn.store_id,sn.location_id,FIELDS.includes(sn.inventory_type)?sn.inventory_type:'normal_qty',1,cost,false,cost===null?'成本待补':'SN实际入库成本',sn,sn.original_inbound_time||sn.inbound_time,source.status==='linked'?source.invoiceType:null,source);
  }
  for(const inv of stock){
   const p=pmap.get(inv.product_id);if(!p||Number(p.need_sn)===1)continue;
   const price=prices.find(r=>r.product_id===p.product_id);
   const cost=knownCost(price?.cost_price,Number(price?.cost_price_locked)===1);
   const qty=getInventoryQuantitySnapshot(inv,lmap.get(inv.location_id)?.type);
   const candidates=evidenceService.nonSnCandidates(p.product_id,inv.store_id,smap.get(inv.store_id)?.distributor_id,evidence.receipts,at);
   const source={status:candidates.length?'batch_pending':'unlinked',candidateCount:candidates.length,candidates,reason:candidates.length?'已找到同店采购资料，库存未记录采购批次，不能确定当前库存对应票据':'尚无可确认的同店采购来源，需核对原始入库或调拨来源'};
   for(const field of FIELDS)add(p,inv.store_id,inv.location_id,field,qty[field],cost,Number(price?.cost_price_locked)!==1,'非SN商品成本档案（未锁定时为估算）',null,null,null,source);
  }
  const summary=aggregate(details,[])[0]||aggregate([{quantity:0,type:'normal_qty',ageBucket:'unknown',costAmount:null,netEstimate:null}],[])[0];
  const rows=aggregate(details,dims);
  if(dims.includes('category'))rows.sort((a,b)=>(categories.order.get(a.category)??Number.MAX_SAFE_INTEGER)-(categories.order.get(b.category)??Number.MAX_SAFE_INTEGER)||a.category.localeCompare(b.category,'zh-CN')||a.key.localeCompare(b.key));
  return {rows,categoryStats:rows,inStockStats:[],summary,details,excluded,meta:{asOf:at.toISOString(),dimensions:dims,version:3,
   evidenceLinkedQuantity:details.filter(r=>r.evidenceStatus==='linked').reduce((n,r)=>n+r.quantity,0),
   evidenceCandidateQuantity:details.filter(r=>r.evidenceStatus==='batch_pending').reduce((n,r)=>n+r.quantity,0),
   categoryOptions:[...categories.order.keys()],
   excludedQuantity:excluded.reduce((sum,row)=>sum+row.quantity,0),scopePendingQuantity:details.filter(row=>row.scopeWarning).reduce((sum,row)=>sum+row.quantity,0),
   costBasis:'SN按实际入库成本；非SN按成本档案估值并标记估算；缺失成本不按零替代。',
   taxBasis:'扣税后金额及税额按关联采购凭证测算，并非已核实抵扣或正式账面价值；SN优先关联完整覆盖且口径一致的已登记发票，其次采购申请约定票种；非SN采购候选不作为批次证明。无依据显示待核实。',
   quantityBasis:'SN与非SN分别取数不叠加；明确服务/虚拟项目单列排除；疑似售后实物属性待核对的项目仍保留；在途及待入库不计入。',
   agingBasis:'SN按首次采购入库时间；非SN无法逐件追溯库龄时列未知，不以最后调拨时间代替。'}};
 });
}
async function exportReport(ctx){
 const report=await load(ctx.query,ctx.state.user),XLSX=require('xlsx');
 const amount=v=>v===null?'待补/待核实':v;
 const group=r=>({分类:r.category,门店:r.storeName,商品编码:r.productCode,商品:r.productName,数量:r.totalCount,
  可售:r.normal_qty,占用:r.pending_qty,展示:r.display_qty,样机:r.demo_qty,租赁样机:r.rental_demo_qty,残次:r.unsellable_qty,
  采购估值:amount(r.totalCost),已知成本:r.knownCostAmount,估算成本:r.estimatedCostAmount,成本待补数量:r.missingCostCount,确认零成本数量:r.confirmedZeroCount,
  预计扣税后金额:amount(r.netAmount),已覆盖扣税后测算金额:r.netEstimateAmount,预计税额:r.estimatedTaxAmount,税务依据待补数量:r.taxPendingCount,
  '0至30天':r.d0_30,'31至60天':r.d31_60,'61至90天':r.d61_90,'90天以上':r.d90_plus,库龄未知:r.unknown,
  '0至30天已覆盖金额':r.ageAmounts.d0_30,'31至60天已覆盖金额':r.ageAmounts.d31_60,'61至90天已覆盖金额':r.ageAmounts.d61_90,'90天以上已覆盖金额':r.ageAmounts.d90_plus,库龄未知已覆盖金额:r.ageAmounts.unknown,
  成本状态:r.costStatus,税务状态:r.taxStatus});
 const rows=report.rows.map(group);rows.push({...group(report.summary),分类:'合计'});
 const detail=report.details.map(d=>({门店:d.storeName,库位:d.location,分类:d.category,商品编码:d.productCode,商品:d.productName,PN:d.pn,SN:d.sn,库存状态:d.typeName,
  数量:d.quantity,采购单价:amount(d.unitCost),采购金额:amount(d.costAmount),成本来源:d.costSource,是否估算:d.estimated?'是':'否',首次入库时间:d.inboundTime,实物范围提示:d.scopeWarning,
  库龄分段:d.ageBucket,采购凭证:d.invoiceType,采购单号:d.purchaseRequestNo,入库单号:d.sourceInboundNo,发票号码:d.invoiceNos,票据依据来源:d.invoiceSource,关联状态:d.evidenceStatusLabel,待核实原因:d.evidenceReason,采购候选数量:d.sourceCandidateCount,采购候选单号:d.sourceCandidates.map(r=>r.requestNo).join('、'),预计扣税后金额:amount(d.netEstimate),预计税额:amount(d.estimatedTax)}));
 const productRows=aggregate(report.details,['store','product']).map(group);
 const wb=XLSX.utils.book_new();
 for(const [name,data]of [['当前维度汇总',rows],['门店产品明细',productRows],['库存来源明细',detail],['服务虚拟项单列',report.excluded.map(r=>({商品编码:r.productCode,商品:r.productName,分类:r.category,门店:r.storeName,数量:r.quantity,原因:r.reason}))],['统计口径',Object.entries(report.meta).map(([key,value])=>({项目:key,内容:Array.isArray(value)?value.join('、'):String(value)}))]]){
  const sheet=XLSX.utils.json_to_sheet(data);sheet['!cols']=Object.keys(data[0]||{}).map(k=>({wch:/商品|分类|内容|来源/.test(k)?40:20}));XLSX.utils.book_append_sheet(wb,sheet,name);
 }
 ctx.set('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
 ctx.set('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent('库存资金与库龄报表.xlsx')}`);
 ctx.body=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
}
module.exports={load,aggregate,dimensions,taxEstimate,bucket,TYPES,exportReport,nonPhysicalReason,categoryPaths};
