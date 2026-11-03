// Read-only review workbook. Business amounts come from inventoryReport.load/aggregate.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),XLSX=require('xlsx');
const M=require('../src/models'),R=require('../src/modules/report/inventoryReport');
async function run(){
 const batch=`INV-REVIEW-${new Date(Date.now()+8*3600000).toISOString().slice(0,10).replaceAll('-','')}-${crypto.randomBytes(3).toString('hex')}`;
 const dir=path.resolve(__dirname,'../backup/inventory-report-review',batch);fs.mkdirSync(dir,{recursive:true});
 const user={roles:['boss'],accessibleStoreIds:['*'],accessibleDistributorIds:['*']};
 const transaction=M.sequelize.transaction.bind(M.sequelize);let report,products,sns,inventories,locations,prices;
 await transaction({readOnly:true,isolationLevel:'REPEATABLE READ'},async tx=>{
  M.sequelize.transaction=async(...args)=>args.at(-1)(tx);
  try{
   report=await R.load({dimensions:'product'},user);
   const ids=[...new Set(report.details.map(d=>d.productId))];
   const {Op}=require('sequelize');
   [products,sns,inventories,locations,prices]=await Promise.all([
    M.Product.findAll({where:{product_id:{[Op.in]:ids}},attributes:['product_id','product_code','name','need_sn','category','brand','unit'],raw:true,transaction:tx}),
    M.ProductSn.findAll({where:{product_id:{[Op.in]:ids},status:'in_stock',is_deleted:0},attributes:['sn_id','sn_code','product_id','store_id','location_id','inbound_price','batch_no','update_time','inbound_time'],raw:true,transaction:tx}),
    M.Inventory.findAll({where:{product_id:{[Op.in]:ids}},raw:true,transaction:tx}),
    M.Location.findAll({attributes:['location_id','name'],raw:true,transaction:tx}),
    M.ProductPrice.findAll({where:{product_id:{[Op.in]:ids},status:1},raw:true,transaction:tx})]);
  }finally{M.sequelize.transaction=transaction;}
 });
 const pmap=new Map(products.map(p=>[p.product_id,p])),lmap=new Map(locations.map(l=>[l.location_id,l.name]));
 const groups=R.aggregate(report.details,['product']),nonSn=report.details.filter(d=>!d.sn),nonGroups=R.aggregate(nonSn,['product']);
 const manifest={batch,asOf:report.meta.asOf,summary:report.summary,meta:report.meta,rows:{}};
 const wb=XLSX.utils.book_new(),style={sheets:[]};
 const blank={是否处理:'',核实说明或凭证:''};
 function sheet(name,rows,headers,editable=[],validation={}){
  const ws=XLSX.utils.json_to_sheet(rows,{header:headers});ws['!cols']=headers.map(h=>({wch:/名称|商品$|分类|原因|说明|候选/.test(h)?38:/标识|编码|单号|SN|PN/.test(h)?24:18}));
  ws['!autofilter']={ref:XLSX.utils.encode_range({r:0,c:0},{r:rows.length,c:headers.length-1})};
  XLSX.utils.book_append_sheet(wb,ws,name);style.sheets.push({name,headers,editable,validation,rows:rows.length});
 }
 function register(prefix,index,original){const key=`${prefix}-${String(index+1).padStart(5,'0')}`;manifest.rows[key]=original;return key;}
 function snOriginal(d){const found=sns.filter(s=>s.product_id===d.productId&&s.store_id===d.storeId&&s.sn_code===d.sn);if(found.length!==1)throw Error('SN定位不唯一: '+d.sn);return found[0];}
 function inventoryOriginal(d){const found=inventories.filter(i=>i.product_id===d.productId&&i.store_id===d.storeId&&(lmap.get(i.location_id)||i.location_id||'未指定库位')===d.location);if(found.length!==1)throw Error('非SN库存定位不唯一: '+d.productCode+' '+d.storeName+' '+d.location);return found[0];}
 const summary=report.summary;
 const instructions=[
  {项目:'回填批次',说明:batch},{项目:'统计时点',说明:report.meta.asOf},{项目:'范围',说明:'全公司当前在库；数据来自库存报表统一后台服务，Excel不另算库存或税费。'},
  {项目:'实物库存数量（含范围待核对项）',说明:summary.totalCount},{项目:'成本待补数量',说明:summary.missingCostCount},{项目:'税务依据待补数量',说明:summary.taxPendingCount},
  {项目:'先填写哪些页',说明:'先填 SN成本、非SN成本、实物属性；税务资料另填 SN税务、非SN批次。两类问题不要混在一起。'},
  {项目:'如何填写',说明:'黄色列可填，灰色列为原值。只处理“是否处理=是”的行；不确定填“暂不处理”，空白不代表0，不清楚不要猜。'},
  {项目:'真实零成本',说明:'确认真实0元时填写0，并将“确认真实零成本”选“是”，补充依据；不要用1元占位。'},
  {项目:'非SN成本影响范围',说明:'一行一个商品，确认的是全公司共用的非SN采购成本档案/估值，不是门店单独成本，也不是销售定价。不同批次成本不同的请在非SN批次页说明，不填一个值强行覆盖。'},
  {项目:'实物属性',说明:'按商品统一确认实物/服务/虚拟/待核对；服务、虚拟项不要求硬填采购成本。本表不删除库存、不自动冲账。'},
  {项目:'成本确认后如何使用',说明:'回填后对原采购或成本档案做有依据的纠正；如需人工锁定非SN成本，须在“是否锁定确认成本”明确选择，避免覆盖后续自动加权成本。'},
  {项目:'税率填写',说明:'填写百分数，例如13表示13%，不得填0.13；含税不自动等于专票，必须按真实凭证确认。'},
  {项目:'税务回填不是直接改金额',说明:'填写采购单、入库单、发票或证据，先修正确来源；预计扣税后金额仍由后台统一服务计算，不能直接填写预计税额。'},
  {项目:'非SN混合批次',说明:'非SN批次页可复制同一行标识，分别填采购批次及核实覆盖数量；同一原始库存行覆盖数量合计不能超过原数量。其他页不要复制行。'},
  {项目:'防止重复修改',说明:'成本只在SN成本或非SN成本页填写；税务页不再填写成本。跨页冲突会先停止相关行，不重复入账。'},
  {项目:'保持定位',说明:'不要修改行标识、商品编码、门店、SN、原值；可筛选排序，不要删除表头。隐藏校验页请保留。'},
  {项目:'回传后处理',说明:'先校验批次、定位、原值变化、重复与冲突，再备份并复用既有后台服务更新；对已售出、调走或已改变的记录单独列出，不盲目覆盖。'},
  {项目:'本次状态',说明:'仅导出核查表，没有修改业务数据；表内尚未填写的行不会自动处理。'}];
 sheet('填写说明',instructions,['项目','说明']);
 const costEdit=['是否处理','确认采购单价','确认真实零成本','核实说明或凭证'];
 const snCost=report.details.filter(d=>d.sn&&d.costAmount===null).map((d,i)=>{
  const sn=snOriginal(d),key=register('SN',i,{kind:'sn_cost',detail:d,sn});
  return {行标识:key,门店:d.storeName,商品编码:d.productCode,商品:d.productName,PN:d.pn,SN:d.sn,库存状态:d.typeName,原SN入库价:sn.inbound_price,原批次:sn.batch_no,关联采购单:d.purchaseRequestNo||'',关联入库单:d.sourceInboundNo||'',待核实原因:d.costSource,...blank,确认采购单价:'',确认真实零成本:''};
 });
 const snHeaders=['行标识','门店','商品编码','商品','PN','SN','库存状态','原SN入库价','原批次','关联采购单','关联入库单','待核实原因',...costEdit];
 sheet('SN成本',snCost,snHeaders,costEdit,{是否处理:'是,否,暂不处理',确认真实零成本:'是,否',确认采购单价:'decimal'});
 const nonCost=nonGroups.filter(g=>g.missingCostCount>0).map((g,i)=>{
  const p=pmap.get(g.productId),key=register('NC',i,{kind:'product_cost',product:p,prices:prices.filter(v=>v.product_id===g.productId),details:nonSn.filter(d=>d.productId===g.productId)});
  return {行标识:key,商品编码:g.productCode,商品:g.productName,分类:report.details.find(d=>d.productId===g.productId)?.category||'',涉及库存数量:g.totalCount,成本待补数量:g.missingCostCount,原成本状态:g.costStatus,适用范围:'该商品全公司共用成本档案',...blank,确认采购单价:'',确认真实零成本:'',是否锁定确认成本:''};
 });
 const nonEdit=[...costEdit,'是否锁定确认成本'];sheet('非SN成本',nonCost,['行标识','商品编码','商品','分类','涉及库存数量','成本待补数量','原成本状态','适用范围',...nonEdit],nonEdit,{是否处理:'是,否,暂不处理',确认真实零成本:'是,否',是否锁定确认成本:'是,否',确认采购单价:'decimal'});
 const suspectIds=new Set(nonSn.filter(d=>d.scopeWarning||/维修|服务|care|纯利润|安装|重装|延保|保险|换新/i.test(d.productName+' '+d.category)).map(d=>d.productId));
 const physical=groups.filter(g=>suspectIds.has(g.productId)).map((g,i)=>{const p=pmap.get(g.productId),key=register('SC',i,{kind:'physical_scope',product:p,details:nonSn.filter(d=>d.productId===g.productId)});return {行标识:key,商品编码:g.productCode,商品:g.productName,分类:p.category||'',原品牌:p.brand||'',原单位:p.unit||'',涉及库存数量:g.totalCount,提醒:'仅列待人工确认候选，不代表已判定非实物',...blank,确认属性:''};});
 sheet('实物属性',physical,['行标识','商品编码','商品','分类','原品牌','原单位','涉及库存数量','提醒','是否处理','确认属性','核实说明或凭证'],['是否处理','确认属性','核实说明或凭证'],{是否处理:'是,否,暂不处理',确认属性:'实物,服务,虚拟,待核对'});
 const taxEdit=['是否处理','确认采购单号','确认入库单号','确认发票号码','确认票种','确认税率百分数','核实说明或凭证'];
 const taxRows=(rows,prefix,kind)=>rows.map((d,i)=>{
  const original=d.sn?{sn:snOriginal(d)}:{inventory:inventoryOriginal(d)};
  const key=register(prefix,i,{kind,detail:d,...original});
  return {行标识:key,门店:d.storeName,库位:d.location,商品编码:d.productCode,商品:d.productName,PN:d.pn,SN:d.sn,库存状态:d.typeName,库存数量:d.quantity,原采购单价:d.unitCost===null?'未确认':d.unitCost,原票据依据:d.invoiceType,原关联采购单:d.purchaseRequestNo||'',原关联入库单:d.sourceInboundNo||'',原发票号:d.invoiceNos||'',采购候选:(d.sourceCandidates||[]).map(c=>c.requestNo+' / '+c.inboundNo).join('；'),待核实原因:d.evidenceReason||'',...blank,确认采购单号:'',确认入库单号:'',确认发票号码:'',确认票种:'',确认税率百分数:'',...(kind==='non_sn_batch'?{核实覆盖数量:''}:{})};
 });
 const taxHeader=['行标识','门店','库位','商品编码','商品','PN','SN','库存状态','库存数量','原采购单价','原票据依据','原关联采购单','原关联入库单','原发票号','采购候选','待核实原因'];
 const taxValidation={是否处理:'是,否,暂不处理',确认票种:'增值税专用发票,普通发票,收据,待核对',确认税率百分数:'rate'};
 const snTax=taxRows(report.details.filter(d=>d.sn&&d.netEstimate===null),'ST','sn_tax');sheet('SN税务',snTax,[...taxHeader,...taxEdit],taxEdit,taxValidation);
 const nonTax=taxRows(nonSn.filter(d=>d.netEstimate===null),'BT','non_sn_batch');sheet('非SN批次',nonTax,[...taxHeader,...taxEdit,'核实覆盖数量'],[...taxEdit,'核实覆盖数量'],{...taxValidation,核实覆盖数量:'integer'});
 const excluded=report.excluded.map(d=>({门店:d.storeName,商品编码:d.productCode,商品:d.productName,分类:d.category,数量:d.quantity,单列原因:d.reason}));sheet('已单列参考',excluded,['门店','商品编码','商品','分类','数量','单列原因']);
 const hash=crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
 const metadata=[{类型:'manifest',内容:JSON.stringify({batch,hash,asOf:report.meta.asOf})},...Object.entries(manifest.rows).flatMap(([key,value])=>{const text=JSON.stringify(value),chunks=[];for(let i=0;i<text.length;i+=20000)chunks.push({类型:`${key}#${i/20000}`,内容:text.slice(i,i+20000)});return chunks;})];sheet('_校验信息',metadata,['类型','内容']);
 for(const ws of Object.values(wb.Sheets))for(const key of Object.keys(ws)){if(key.startsWith('!'))continue;const cell=ws[key];if(cell.t==='s'&&/^[=+@]/.test(cell.v))cell.t='s';}
 const output=path.join(dir,'库存核实回填表.xlsx');XLSX.writeFile(wb,output);
 fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({...manifest,hash},null,2));fs.writeFileSync(path.join(dir,'format.json'),JSON.stringify(style,null,2));
 console.log(JSON.stringify({file:output,dir,batch,asOf:report.meta.asOf,summary:{quantity:summary.totalCount,missingCost:summary.missingCostCount,taxPending:summary.taxPendingCount},sheets:{snCost:snCost.length,nonSnCost:nonCost.length,scope:physical.length,snTax:snTax.length,nonSnTax:nonTax.length},hash},null,2));
}
run().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>M.sequelize.close());
