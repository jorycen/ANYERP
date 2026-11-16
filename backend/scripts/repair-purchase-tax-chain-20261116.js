const M=require('../src/models'),F=require('../src/modules/inventory/foundation'),V=require('../src/modules/sales/purchaseVat'),fs=require('node:fs'),path=require('node:path');
const dir=path.resolve(__dirname,'../backup/order-corrections/PURCHASE-TAX-CHAIN-20261116');
async function main(){
 const pending=await M.InventoryFoundation.findAll({where:{status:'pending'}}),plan=[],review=[];
 for(const row of pending){
  const refs=await M.InventoryFoundationRef.findAll({where:{basis_id:row.basis_id},raw:true});
  const itemRefs=refs.filter(r=>r.reference_key.startsWith('order_item:'));
  for(const ref of itemRefs){
   const item=await M.OrderItem.findByPk(ref.reference_key.slice(11),{raw:true});if(!item)continue;
   const order=await M.Order.findByPk(item.order_id,{raw:true});if(!order||order.is_deleted)continue;
   const line={itemId:item.item_id,productId:item.product_id,productName:item.product_name,pnCode:item.pn_code,snCode:item.sn_code,quantity:item.quantity,purchasePrice:Number(row.purchase_cost)};
   let tax;
   if(order.order_no==='ORD202611160615412002'&&item.pn_code==='QX31S92469')tax={version:V.VERSION,status:'confirmed',service:false,invoiceType:'收据',purchaseAmount:Number(row.purchase_cost)*Number(item.quantity),source:'user_confirmation_20261116',reason:'用户明确确认本单实际采购收据（未税）'};
   else if(row.purchase_cost!==null){const resolved=await V.resolveDocumentTaxBasis(order,[line]);tax=resolved[0]?.purchaseTaxBasis;}
   if(tax?.status==='confirmed')plan.push({basisId:row.basis_id,revision:row.revision,orderNo:order.order_no,orderId:order.order_id,status:order.order_status,tax,before:row.toJSON()});
   else review.push({basisId:row.basis_id,orderNo:order.order_no,pn:item.pn_code,reason:tax?.reason||'缺少可追溯采购成本或票税'});
  }
 }
 fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'preview.json'),JSON.stringify({plan,review},null,2));
 if(process.argv.includes('--apply')){
  await M.sequelize.transaction(async transaction=>{for(const p of [...new Map(plan.map(p=>[p.basisId,p])).values()]){const row=await M.InventoryFoundation.findByPk(p.basisId,{transaction,lock:transaction.LOCK.UPDATE});if(row.status!=='pending'||Number(row.revision)!==Number(p.revision))throw Error('档案已变化 '+p.basisId);await F.confirmTaxEvidence(row,p.tax,{name:'PURCHASE-TAX-CHAIN-20261116'},'采购票税来源复核及用户确认修复',transaction);}});
 }
 const target=await M.InventoryFoundation.findOne({where:{identity_key:'import_sale:48909'},raw:true});
 fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({applied:process.argv.includes('--apply'),updated:plan.length,review,target},null,2));
 console.log(JSON.stringify({applied:process.argv.includes('--apply'),planned:plan.length,review:review.length,target:{status:target?.status,invoiceType:target?.invoice_type}}));
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>M.sequelize.close());
