const M=require('../src/models'),F=require('../src/modules/inventory/foundation'),G=require('../src/modules/sales/grossProfit'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {recordBusinessAction}=require('../src/utils/businessActionLog');
const batch='RETURN-TAX-20261107',dir=path.join(__dirname,'../backup/order-corrections',batch),apply=process.argv.includes('--apply');
async function main(){
 fs.mkdirSync(dir,{recursive:true});
 const orders=await M.Order.findAll({where:{order_status:'未归档'},raw:true});
 const results=[];
 for(const old of orders){
  const tx=await M.sequelize.transaction();
  try{
   const order=await M.Order.findByPk(old.order_id,{transaction:tx,lock:tx.LOCK.UPDATE});
   assert.equal(order.order_status,'未归档');
   const snapshot=await M.OrderGrossProfit.findOne({where:{order_id:order.order_id},transaction:tx,lock:tx.LOCK.UPDATE});
   if(snapshot?.snapshot_status==='final'){await tx.rollback();continue;}
   const lines=await G.buildProductPricingDetails(order.order_id,tx);
   const targets=lines.filter(l=>l.pnCode==='ANY-LX-QJTZ'&&l.inventoryFoundation?.basisId&&l.inventoryFoundation.status==='pending');
   if(!targets.length&&!lines.some(l=>l.pricingOrigin?.sourceType==='sales_return'&&l.purchaseTaxBasis?.status!=='confirmed')){await tx.rollback();continue;}
   const before={order:order.toJSON(),snapshot:snapshot?.toJSON(),items:await M.OrderItem.findAll({where:{order_id:order.order_id},raw:true,transaction:tx}),foundations:[]};
   for(const l of targets){const row=await M.InventoryFoundation.findByPk(l.inventoryFoundation.basisId,{transaction:tx,lock:tx.LOCK.UPDATE});before.foundations.push(row.toJSON());}
   if(apply)fs.writeFileSync(path.join(dir,order.order_id+'.json'),JSON.stringify(before,null,2),{flag:'wx'});
   for(const b of before.foundations){
    const row=await M.InventoryFoundation.findByPk(b.basis_id,{transaction:tx});
    await F.confirmTaxEvidence(row,{version:require('../src/modules/sales/purchaseVat').VERSION,status:'confirmed',service:false,invoiceType:'收据',source:'user_confirmed_cleaning_untaxed',confirmationBatch:batch},{name:batch},'用户确认清洁套装未税；保留成本与定价',tx);
   }
   const updated=await G.calculateAndSaveOrderGrossProfit(order.order_id,{transaction:tx,force:true,calculatedBy:batch});
   const decode=v=>typeof v==='string'?JSON.parse(v):v||[];
   const prior=decode(before.snapshot?.product_pricing_details),next=decode(updated.product_pricing_details);
   const newlyConfirmed=next.filter(l=>l.purchaseTaxBasis?.status==='confirmed'&&prior.find(p=>String(p.itemId)===String(l.itemId))?.purchaseTaxBasis?.status!=='confirmed').length;
   if(!targets.length&&!newlyConfirmed){await tx.rollback();continue;}
   const afterItems=await M.OrderItem.findAll({where:{order_id:order.order_id},raw:true,transaction:tx});assert.deepEqual(afterItems,before.items);
   const result={orderNo:order.order_no,cleaningConfirmed:targets.length,profit:updated.gross_profit_amount};
   await recordBusinessAction({businessType:'sales_order',businessId:order.order_id,businessNo:order.order_no,action:'repair_return_tax',user:{name:batch},detail:{batch,beforeSnapshot:before.snapshot,result},transaction:tx});
   if(apply)await tx.commit();else await tx.rollback();results.push(result);
  }catch(e){if(!tx.finished)await tx.rollback();results.push({orderNo:old.order_no,error:e.message});}
 }
 fs.writeFileSync(path.join(dir,apply?'results.json':'preview.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({apply,orders:results.length,cleaning:results.reduce((n,x)=>n+(x.cleaningConfirmed||0),0),errors:results.filter(x=>x.error),results}));
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>M.sequelize.close());
