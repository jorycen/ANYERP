const M=require('../src/models'),F=require('../src/modules/inventory/foundation'),V=require('../src/modules/sales/purchaseVat');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),a=require('node:assert/strict'),X=require('xlsx');
const {recordBusinessAction}=require('../src/utils/businessActionLog');
const input='C:/Users/Administrator/Downloads/采购票税批量处理及待确认清单.xlsx';
const original=path.resolve(__dirname,'../backup/order-corrections/ACTIVE-TAX-DRAFT-20261105/采购票税批量处理及待确认清单.xlsx');
const batch='RETURNED-TAX-20261106',dir=path.resolve(__dirname,'../backup/order-corrections',batch),plain=x=>JSON.parse(JSON.stringify(x));
const id='基础档案ID',type='填写：采购含税类型',cost='填写：实际采购成本';
function read(file){const wb=X.readFile(file,{cellFormula:true}),sheet=wb.Sheets['待确认'];a(sheet,'缺少待确认工作表');
  for(const cell of Object.values(sheet))if(cell&&typeof cell==='object')a(!cell.f,'回填表不能包含公式');
  return X.utils.sheet_to_json(sheet,{defval:''});}
async function plan(){
  const rows=read(input),baseline=read(original),baselineMap=new Map(baseline.map(x=>[x[id],x]));
  a.equal(rows.length,10);a.equal(new Set(rows.map(x=>x[id])).size,10);a.equal(baseline.length,10);
  const current=await M.InventoryFoundation.findAll({where:{basis_id:rows.map(x=>x[id])},raw:true});a.equal(current.length,10);
  const catalog=new Map((await F.currentCatalog(current)).map(x=>[x.basisId,x])),exportTime=fs.statSync(original).mtime;
  const plans=[];
  for(const row of rows){const base=baselineMap.get(row[id]),existing=current.find(x=>x.basis_id===row[id]);a(base&&existing,'定位ID不在原清单');
    for(const key of Object.keys(base))if(!key.startsWith('填写：'))a.equal(String(row[key]),String(base[key]),'原始定位或金额列被修改：'+key);
    a.equal(existing.sn_code,row.SN,'SN已变化');a.equal(existing.product_name,row.商品,'商品名称已变化');
    a(new Date(existing.update_time)<=exportTime,'导出后基础档案已修改，须重新核实：'+row.SN);
    const source=typeof existing.source_data==='string'?JSON.parse(existing.source_data):existing.source_data||{};a(!source.identityConflict,'商品身份冲突');
    const invoiceType={'含税':'专票13%','未税':'收据','专票13%':'专票13%','收据':'收据'}[String(row[type]).trim()];a(invoiceType,'采购含税类型不明确');
    a(typeof row[cost]==='number'&&Number.isFinite(row[cost])&&row[cost]>=0&&/^\d{1,10}(\.\d{1,2})?$/.test(String(row[cost])),'实际采购成本必须明确填写非负金额');
    const purchaseCost=F.money(row[cost]);
    if(base.当前采购成本!=='待核实')a.equal(F.money(existing.purchase_cost),F.money(base.当前采购成本),'当前成本与导出时不同');
    if(existing.invoice_type)a.equal(existing.invoice_type,invoiceType,'已有票种与本次填写不同，需单独核实');
    const basis=catalog.get(row[id]);
    plans.push({input:row,before:existing,invoiceType,purchaseCost,costMode:basis.costMode,companyPrice:basis.companyPrice,
      warning:basis.costMode==='COMPANY_PRICE'&&basis.companyPrice!==null&&basis.companyPrice<purchaseCost?'现有公司定价低于实际采购成本，本次保留原定价':''});
  }
  return plans;
}
async function main(){
  const plans=await plan(),sha256=crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex');
  console.log(JSON.stringify({preview:true,count:plans.length,taxed:plans.filter(x=>x.invoiceType==='专票13%').length,untaxed:plans.filter(x=>x.invoiceType==='收据').length,
    costsFilled:plans.filter(x=>F.money(x.before.purchase_cost)!==x.purchaseCost).length,explicitZero:plans.filter(x=>x.purchaseCost===0).length,
    unchangedPriceWarnings:plans.filter(x=>x.warning).map(x=>({name:x.input.商品,pn:x.input.PN,companyPrice:x.companyPrice,purchaseCost:x.purchaseCost}))}));
  if(!process.argv.includes('--apply'))return;
  fs.mkdirSync(dir,{recursive:true});fs.copyFileSync(input,path.join(dir,'用户回填原表.xlsx'),fs.constants.COPYFILE_EXCL);
  const refs=await M.InventoryFoundationRef.findAll({where:{basis_id:plans.map(x=>x.before.basis_id)},raw:true});
  const itemIds=refs.filter(x=>x.reference_key.startsWith('order_item:')).map(x=>x.reference_key.slice(11));
  const items=itemIds.length?await M.OrderItem.findAll({where:{item_id:itemIds},raw:true}):[];
  const orderIds=[...new Set(items.map(x=>x.order_id))];
  const snapshots=orderIds.length?await M.OrderGrossProfit.findAll({where:{order_id:orderIds},raw:true,order:[['gross_profit_id','ASC']]}):[];
  fs.writeFileSync(path.join(dir,'before.json'),JSON.stringify({batch,sha256,plans,refs,items,snapshots},null,2),{flag:'wx'});
  await M.sequelize.transaction(async transaction=>{
    for(const item of [...plans].sort((a,b)=>a.before.basis_id.localeCompare(b.before.basis_id))){
      const row=await M.InventoryFoundation.findByPk(item.before.basis_id,{transaction,lock:transaction.LOCK.UPDATE});
      a.equal(Number(row.revision),Number(item.before.revision),'档案版本已变化');a.deepEqual(plain(row),plain(item.before),'档案内容已变化');
      const source=typeof row.source_data==='string'?JSON.parse(row.source_data):row.source_data||{};
      const evidence={version:V.VERSION,status:'confirmed',service:false,invoiceType:item.invoiceType,purchaseAmount:item.purchaseCost,
        source:'user_returned_excel',confirmationBatch:batch,fileSha256:sha256,sheet:'待确认',basisId:row.basis_id,
        reason:String(item.input['填写：依据说明']||'用户回填确认实际采购成本及含税属性'),zeroCostExplicitlyConfirmed:item.purchaseCost===0};
      await row.update({invoice_type:item.invoiceType,purchase_cost:item.purchaseCost,status:'confirmed',reason:evidence.reason,
        source_data:{...source,taxScope:null,costEstimated:false,purchaseBasis:evidence},revision:Number(row.revision)+1,updated_by:batch,update_time:new Date()},{transaction});
      await recordBusinessAction({businessType:'inventory_foundation',businessId:row.basis_id,action:'apply_returned_tax_review',user:{name:'用户回填Excel（Codex会话）'},
        comment:'按返回清单逐台补齐票税及实际采购成本；公司定价、计价模式、SN原始记录及历史归档金额不变。',
        detail:{batch,fileSha256:sha256,input:item.input,before:item.before,after:plain(row),priceWarning:item.warning},transaction});
    }
  });
  const results=[];
  for(const item of plans){const row=await M.InventoryFoundation.findByPk(item.before.basis_id,{raw:true});
    a.equal(row.invoice_type,item.invoiceType);a.equal(F.money(row.purchase_cost),item.purchaseCost);a.equal(row.status,'confirmed');
    for(const key of Object.keys(item.before))if(!['invoice_type','purchase_cost','status','reason','source_data','revision','updated_by','update_time'].includes(key))a.deepEqual(plain(row[key]),plain(item.before[key]),key);
    results.push({商品:item.input.商品,PN:item.input.PN,SN:item.input.SN,确认含税类型:item.invoiceType==='收据'?'未税':'含税',确认实际采购成本:item.purchaseCost,
      原采购成本:F.money(item.before.purchase_cost)??'待核实',现有公司定价:item.companyPrice,价格提示:item.warning,基础档案ID:row.basis_id});
  }
  const afterCatalog=new Map((await F.currentCatalog(await M.InventoryFoundation.findAll({where:{basis_id:plans.map(x=>x.before.basis_id)},raw:true}))).map(x=>[x.basisId,x]));
  for(const item of plans){a.equal(afterCatalog.get(item.before.basis_id).companyPrice,item.companyPrice);a.equal(afterCatalog.get(item.before.basis_id).costMode,item.costMode);}
  if(orderIds.length)a.deepEqual(plain(await M.OrderGrossProfit.findAll({where:{order_id:orderIds},raw:true,order:[['gross_profit_id','ASC']]})),plain(snapshots),'关联毛利快照应保持原样');
  const output={verified:true,batch,count:results.length,taxed:5,untaxed:5,costsFilled:plans.filter(x=>F.money(x.before.purchase_cost)!==x.purchaseCost).length,explicitZero:1,results};
  fs.writeFileSync(path.join(dir,'verified.json'),JSON.stringify(output,null,2));
  const wb=X.utils.book_new(),sheet=X.utils.json_to_sheet(results);sheet['!cols']=Object.keys(results[0]).map(k=>({wch:k==='商品'||k==='价格提示'?50:28}));sheet['!autofilter']={ref:sheet['!ref']};
  X.utils.book_append_sheet(wb,sheet,'回填结果');const file=path.join(dir,'采购票税回填结果.xlsx');X.writeFile(wb,file);a.equal(X.utils.sheet_to_json(X.readFile(file).Sheets['回填结果']).length,10);
  console.log(JSON.stringify({verified:true,count:10,costsFilled:output.costsFilled,explicitZero:1,unchangedPriceWarnings:plans.filter(x=>x.warning).length,file}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>M.sequelize.close());
