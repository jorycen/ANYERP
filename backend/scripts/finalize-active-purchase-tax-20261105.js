const M=require('../src/models'),GP=require('../src/modules/sales/grossProfit'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),X=require('xlsx');
const {recordBusinessAction}=require('../src/utils/businessActionLog');
const root=path.resolve(__dirname,'../backup/order-corrections'),batch='ACTIVE-TAX-DRAFT-20261105',dir=path.join(root,batch);
const read=(b,file)=>JSON.parse(fs.readFileSync(path.join(root,b,file),'utf8'));
const plain=x=>x===undefined?null:JSON.parse(JSON.stringify(x));
async function main(){
  const batches=['ACTIVE-TAX-20261105','ACTIVE-TAX-SERVICE-20261105','ACTIVE-TAX-FINAL-20261105','ACTIVE-TAX-EXTRA-SERVICE-20261105'];
  const plans=batches.flatMap(b=>read(b,'before.json')),last=read(batches[batches.length-1],'verified.json');
  assert(batches.every(b=>read(b,'verified.json').verified&&read(b,'verified.json').failed.length===0));
  const before=[];
  for(const item of last.orders){const order=await M.Order.findByPk(item.id,{raw:true});
    if(order.order_status!=='未归档')continue;
    const snapshot=await M.OrderGrossProfit.findOne({where:{order_id:item.id},raw:true});
    assert(!snapshot||snapshot.snapshot_status!=='final');
    before.push({order,snapshot,items:await M.OrderItem.findAll({where:{order_id:item.id},raw:true})});
  }
  fs.mkdirSync(dir,{recursive:true});
  const prior=!process.argv.includes('--apply')&&fs.existsSync(path.join(dir,'verified.json'))?JSON.parse(fs.readFileSync(path.join(dir,'verified.json'),'utf8')):{};
  const refreshed=prior.refreshed||[],skipped=prior.skipped||[];
  if(process.argv.includes('--apply')){
    fs.writeFileSync(path.join(dir,process.argv.includes('--retry')?'retry-before.json':'before.json'),JSON.stringify(before,null,2),{flag:'wx'});
    for(const old of before){try{await M.sequelize.transaction(async transaction=>{
      const order=await M.Order.findByPk(old.order.order_id,{transaction,lock:transaction.LOCK.UPDATE});
      assert.equal(order.order_status,'未归档','订单状态已变化');
      const existing=await M.OrderGrossProfit.findOne({where:{order_id:order.order_id},transaction,lock:transaction.LOCK.UPDATE});
      assert(!existing||existing.snapshot_status!=='final','不能改归档快照');
      assert.deepEqual(plain(order),plain(old.order),'订单资料已变化');
      const items=await M.OrderItem.findAll({where:{order_id:order.order_id},raw:true,transaction,order:[['item_id','ASC']]});
      assert.deepEqual(plain(items),plain(old.items.sort((a,b)=>Number(a.item_id)-Number(b.item_id))),'商品资料已变化');
      const result=await GP.calculateAndSaveOrderGrossProfit(order.order_id,{persist:true,final:false,requireComplete:true,calculatedBy:batch,transaction});
      assert.equal(result.snapshot_status,'draft');
      const afterItems=await M.OrderItem.findAll({where:{order_id:order.order_id},raw:true,transaction});
      for(const item of afterItems){const prior=old.items.find(x=>String(x.item_id)===String(item.item_id));for(const key of Object.keys(prior))if(key!=='freight_cost')assert.deepEqual(plain(item[key]),plain(prior[key]),key);}
      await recordBusinessAction({businessType:'sales_order',businessId:order.order_id,businessNo:order.order_no,action:'refresh_draft_profit',user:{name:batch},
        comment:'用户要求补齐采购票税后的未归档毛利预估刷新，不归档、不改变审批或采购成本/价格。',
        detail:{before:old.snapshot,after:plain(result),sourceBatches:batches},transaction});
      refreshed.push({orderId:order.order_id,orderNo:order.order_no,profit:Number(result.gross_profit_amount),vat:Number(result.vat_amount),snapshotId:result.gross_profit_id});
    });}catch(error){skipped.push({orderNo:old.order.order_no,reason:error.message.split('\n')[0]});}}
    for(const item of refreshed){const row=await M.OrderGrossProfit.findByPk(item.snapshotId,{raw:true});assert.equal(Number(row.gross_profit_amount),item.profit);assert.equal(Number(row.vat_amount),item.vat);}
  }
  const orders=[];
  for(const item of read(batches[0],'verified.json').orders){try{
    const order=await M.Order.findByPk(item.id,{raw:true});
    const snapshot=await GP.calculateAndSaveOrderGrossProfit(item.id,{persist:false,final:false,requireComplete:true});
    orders.push({no:item.no,status:order.order_status,complete:true,vat:Number(snapshot.vat_amount),profit:Number(snapshot.gross_profit_amount),negative:Number(snapshot.gross_profit_amount)<0});
  }catch(error){orders.push({no:item.no,complete:false,reason:error.message});}}
  const currentRows=await M.InventoryFoundation.findAll({where:{basis_id:last.review.map(x=>x.basisId)},raw:true});
  const current=new Map(currentRows.map(x=>[x.basis_id,require('../src/modules/inventory/foundation').view(x)]));
  const review=last.review.filter(x=>current.get(x.basisId)?.status!=='confirmed').map(x=>({...x,reason:current.get(x.basisId)?.reason||x.reason}));
  const result={verified:true,confirmed:plans.length,products:new Set(plans.map(x=>x.productId)).size,review:review.length,refreshed,skipped,orders};
  fs.writeFileSync(path.join(dir,'verified.json'),JSON.stringify(result,null,2));
  const wb=X.utils.book_new();
  X.utils.book_append_sheet(wb,X.utils.aoa_to_sheet([['项目','说明'],['范围','当前实存库存及2026年11月未归档/待审批订单，未自动改已归档金额。'],['处理','优先原采购及退货原单；无凭证的同类配件按用户确认未税。明确服务沿用税基0。'],['金额','实际采购成本和定价未修改；未归档快照按统一服务刷新。负毛利仍按原流程审批。'],['待确认','未覆盖类别或事实冲突保留，以下仅待确认表需补充。']]),'说明');
  const applied=plans.map(x=>({'商品':x.name,'PN':x.pn,'SN':x.sn,'类别':x.category,'关联订单':x.orders,'处理':x.tax.service?'服务税基0':x.tax.invoiceType==='收据'?'未税':'含税','依据':x.reason,'采购成本':x.purchaseCost??'待核实','基础档案ID':x.basisId}));
  X.utils.book_append_sheet(wb,X.utils.json_to_sheet(applied),'已处理');
  X.utils.book_append_sheet(wb,X.utils.json_to_sheet(review.map(x=>({'商品':x.name,'PN':x.pn,'SN':x.sn,'类别':x.category,'当前采购成本':x.purchaseCost??'待核实','待确认原因':x.reason,'填写：采购含税类型':'','填写：实际采购成本':'','填写：确认人':'','填写：依据说明':'','填写：无法确认原因':'','基础档案ID':x.basisId}))),'待确认');
  X.utils.book_append_sheet(wb,X.utils.json_to_sheet(orders.map(x=>({'订单号':x.no,'当前状态':x.status||'','核算通过':x.complete?'是':'否','增值税':x.vat??'','毛利':x.profit??'','需负毛利审批':x.negative?'是':'','其他原因':x.reason||''}))),'订单复核');
  for(const name of wb.SheetNames){const sheet=wb.Sheets[name],headers=X.utils.sheet_to_json(sheet,{header:1})[0]||[];
    sheet['!cols']=headers.map(h=>({wch:/商品|原因|依据|说明/.test(String(h))?48:/ID/.test(String(h))?36:24}));
    if(name!=='说明'&&sheet['!ref'])sheet['!autofilter']={ref:sheet['!ref']};
  }
  const file=path.join(dir,'采购票税批量处理及待确认清单.xlsx');X.writeFile(wb,file);
  const verify=X.readFile(file);assert.equal(X.utils.sheet_to_json(verify.Sheets['已处理']).length,plans.length);assert.equal(X.utils.sheet_to_json(verify.Sheets['待确认']).length,review.length);
  console.log(JSON.stringify({...result,file}));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>M.sequelize.close());
