const M=require('../src/models'),F=require('../src/modules/inventory/foundation'),V=require('../src/modules/sales/purchaseVat');
const GP=require('../src/modules/sales/grossProfit'),{Op}=require('sequelize'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),X=require('xlsx');
const batch=process.argv.includes('--extra-services')?'ACTIVE-TAX-EXTRA-SERVICE-20261105':process.argv.includes('--finalize')?'ACTIVE-TAX-FINAL-20261105':process.argv.includes('--services')?'ACTIVE-TAX-SERVICE-20261105':'ACTIVE-TAX-20261105',dir=path.resolve(__dirname,'../backup/order-corrections',batch);
const plain=x=>JSON.parse(JSON.stringify(x)),parse=x=>typeof x==='string'?JSON.parse(x):x||{};
const openStatuses=['未归档','draft','草稿','pending_store_approval','pending_distributor_approval','pending_approval'];
const accessoryCategories=new Set(['配件','电脑配件','选件','服务']);
async function audit(){
  const [rows,refs,products,sns,inventory,orders]=await Promise.all([
    M.InventoryFoundation.findAll({raw:true}),M.InventoryFoundationRef.findAll({raw:true}),M.Product.findAll({raw:true}),
    M.ProductSn.findAll({where:{is_deleted:0,status:{[Op.in]:['in_stock','reserved','occupied']}},raw:true}),M.Inventory.findAll({raw:true}),
    M.Order.findAll({where:{is_deleted:0,order_status:{[Op.in]:openStatuses},create_time:{[Op.gte]:new Date('2026-11-01T00:00:00+08:00')}},raw:true})]);
  const byProduct=new Map(products.map(x=>[x.product_id,x])),bySn=new Map(sns.map(x=>[x.sn_id,x])),byInventory=new Map(inventory.map(x=>[String(x.inventory_id),x]));
  const itemLines=new Map(),pendingOrders=[];
  for(const order of orders){
    try{const result=await GP.calculateAndSaveOrderGrossProfit(order.order_id,{persist:false,final:false});
      for(const line of result.product_pricing_details||[])itemLines.set(String(line.itemId),{line,order});
      pendingOrders.push({no:order.order_no,id:order.order_id,status:order.order_status,taxPending:result.tax_calculation_status==='pending'});
    }catch(error){pendingOrders.push({no:order.order_no,id:order.order_id,error:error.message});}
  }
  const byBasis=new Map();for(const ref of refs){if(!byBasis.has(ref.basis_id))byBasis.set(ref.basis_id,[]);byBasis.get(ref.basis_id).push(ref);}
  const plan=[],review=[];let checked=0;
  for(const row of rows){
    const contexts=[];
    for(const ref of byBasis.get(row.basis_id)||[]){
      if(ref.reference_key.startsWith('order_item:')){const saved=itemLines.get(ref.reference_key.slice(11));if(saved)contexts.push(saved);}
      else if(ref.reference_key.startsWith('sn_current:')){const sn=bySn.get(ref.reference_key.slice(11));if(sn)contexts.push({order:{store_id:sn.store_id},line:{productId:row.product_id,snCode:sn.sn_code,quantity:1,purchasePrice:F.money(row.purchase_cost),supplierId:sn.supplier_id}});}
      else if(ref.reference_key.startsWith('inventory:')){const [,id,field]=ref.reference_key.split(':'),inv=byInventory.get(id);if(inv&&Number(inv[field])>0)contexts.push({order:{store_id:inv.store_id},line:{productId:row.product_id,quantity:1,purchasePrice:F.money(row.purchase_cost)}});}
    }
    if(!contexts.length)continue;
    const product=byProduct.get(row.product_id)||{},effective=F.view(row);
    if(effective.status==='confirmed' || (row.invoice_type && effective.status!=='conflict'))continue;
    checked++;
    const base={basisId:row.basis_id,productId:row.product_id,name:row.product_name||product.name,pn:product.manufacturer_code||'',category:product.category,
      sn:row.sn_code||'',orders:[...new Set(contexts.map(c=>c.order.order_no).filter(Boolean))].join('、'),purchaseCost:F.money(row.purchase_cost)};
    if(effective.status==='conflict'||parse(row.source_data).identityConflict){review.push({...base,reason:effective.reason||'身份或原始采购事实冲突'});continue;}
    const evidence=[];
    for(const context of contexts){
      const line={...context.line,productName:base.name,category:product.category};
      let tax=line.purchaseTaxBasis;
      if(tax?.status!=='confirmed'){
        const copy={...line};delete copy.purchaseTaxBasis;
        tax=(await V.resolveDocumentTaxBasis(context.order,[copy]))[0].purchaseTaxBasis;
      }
      evidence.push(tax);
    }
    const types=[...new Set(evidence.filter(x=>x.status==='confirmed').map(x=>x.service?'SERVICE':x.invoiceType))];
    const conflict=evidence.some(x=>x.status!=='confirmed'&&/不唯一|不一致|冲突|循环|无效/.test(x.reason||''));
    let tax,reason;
    if(types.length>1||conflict){review.push({...base,reason:'可追溯采购依据存在分歧或身份不唯一'});continue;}
    if(types.length===1){tax=evidence.find(x=>x.status==='confirmed');reason='自动复核原采购/退货原单的明确票税依据';}
    else if(accessoryCategories.has(product.category)){
      tax={version:V.VERSION,status:'confirmed',service:false,invoiceType:'收据',purchaseAmount:base.purchaseCost,
        source:'user_confirmed_missing_accessory_tax',confirmationBatch:batch,reason:'用户确认缺失采购票税的同类配件、选件按未税处理；内部经营核算，不代表已取得发票'};
      reason='用户确认同类历史导入/退货配件未税，仅补齐缺失依据';
    }else{review.push({...base,reason:evidence.map(x=>x.reason).filter(Boolean).join('；')||'未取得明确采购票税，类别不在本次未税确认范围'});continue;}
    plan.push({...base,before:row,tax,reason});
    if(checked%50===0)console.log(JSON.stringify({checked,planned:plan.length,review:review.length}));
  }
  return {batch,checked,plan,review,orders:pendingOrders};
}
async function main(){
  const result=await audit();fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'preview.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({preview:true,checked:result.checked,planned:result.plan.length,products:new Set(result.plan.map(x=>x.productId)).size,review:result.review.length,orders:result.orders}));
  if(!process.argv.includes('--apply'))return;
  fs.writeFileSync(path.join(dir,'before.json'),JSON.stringify(result.plan,null,2),{flag:'wx'});
  const applied=[],failed=[];
  for(const item of result.plan){try{await M.sequelize.transaction(async transaction=>{
    const row=await M.InventoryFoundation.findByPk(item.basisId,{transaction,lock:transaction.LOCK.UPDATE});
    assert.equal(Number(row.revision),Number(item.before.revision),'档案版本已变化');
    assert.equal(row.invoice_type,item.before.invoice_type,'票种已变化');
    await F.confirmTaxEvidence(row,item.tax,{name:batch},item.reason,transaction);
  });applied.push(item);}catch(error){failed.push({...item,error:error.message});}}
  for(const item of applied){const row=await M.InventoryFoundation.findByPk(item.basisId,{raw:true});
    assert.equal(row.invoice_type,item.tax.invoiceType||null);assert.equal(row.status,'confirmed');
    for(const key of Object.keys(item.before))if(!['invoice_type','status','reason','source_data','revision','updated_by','update_time'].includes(key))assert.deepEqual(plain(row[key]),plain(item.before[key]),key);
  }
  const afterOrders=[];
  for(const item of result.orders){try{const row=await GP.calculateAndSaveOrderGrossProfit(item.id,{persist:false,final:false,requireComplete:true});
    afterOrders.push({...item,complete:true,profit:Number(row.gross_profit_amount),vat:Number(row.vat_amount),needsNegativeProfitApproval:Number(row.gross_profit_amount)<0});
  }catch(error){afterOrders.push({...item,complete:false,reason:error.message});}}
  const output={batch,verified:true,applied:applied.length,products:new Set(applied.map(x=>x.productId)).size,failed:failed.map(x=>({basisId:x.basisId,error:x.error})),review:result.review,orders:afterOrders};
  fs.writeFileSync(path.join(dir,'verified.json'),JSON.stringify(output,null,2));
  const wb=X.utils.book_new();
  const records=applied.map(x=>({'商品':x.name,'PN':x.pn,'SN':x.sn,'类别':x.category,'关联未归档订单':x.orders,'处理':x.tax.service?'服务税基0':x.tax.invoiceType==='收据'?'未税':'含税','依据':x.reason,'来源':x.tax.source||x.tax.purchaseNo||'原采购','采购成本':x.purchaseCost??'待核实','基础档案ID':x.basisId}));
  X.utils.book_append_sheet(wb,X.utils.json_to_sheet(records),'已处理');
  X.utils.book_append_sheet(wb,X.utils.json_to_sheet(result.review.map(x=>({'商品':x.name,'PN':x.pn,'SN':x.sn,'类别':x.category,'关联订单':x.orders,'待确认原因':x.reason,'基础档案ID':x.basisId}))),'待确认');
  X.utils.book_append_sheet(wb,X.utils.json_to_sheet(afterOrders.map(x=>({'订单号':x.no,'核算通过':x.complete?'是':'否','增值税':x.vat??'','毛利':x.profit??'','需负毛利审批':x.needsNegativeProfitApproval?'是':'','其他原因':x.reason||x.error||''}))),'订单复核');
  const file=path.join(dir,'当前库存及未归档订单采购票税处理清单.xlsx');X.writeFile(wb,file);
  assert.equal(X.utils.sheet_to_json(X.readFile(file).Sheets['已处理']).length,applied.length);
  console.log(JSON.stringify({...output,review:result.review.length,file}));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>M.sequelize.close());
