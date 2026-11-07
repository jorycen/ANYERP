const M=require('../src/models'),G=require('../src/modules/sales/grossProfit'),V=require('../src/modules/sales/purchaseVat'),F=require('../src/modules/inventory/foundation'),fs=require('node:fs'),path=require('node:path'),a=require('node:assert/strict');
const {recordBusinessAction}=require('../src/utils/businessActionLog');
const batch='RETURN-TAX-FULL-20261107',dir=path.resolve(__dirname,'../backup/order-corrections',batch),apply=process.argv.includes('--apply');
async function main(){
 const report=JSON.parse(fs.readFileSync(path.join(dir,'audit.json'))),ids=[...new Set(report.filter(r=>!r.service&&r.after?.status==='confirmed'&&(r.before?.status!=='confirmed'||r.status==='未归档')).map(r=>r.orderId))],results=[];
 for(const id of ids){const tx=await M.sequelize.transaction();try{
  const order=await M.Order.findByPk(id,{transaction:tx,lock:tx.LOCK.UPDATE});
  const oldSnapshot=await M.OrderGrossProfit.findOne({where:{order_id:id},transaction:tx,lock:tx.LOCK.UPDATE});
  const entries=report.filter(r=>r.orderId===id&&!r.service&&r.after?.status==='confirmed');
  const before={order:order.toJSON(),snapshot:oldSnapshot?.toJSON()||null,items:await M.OrderItem.findAll({where:{order_id:id},raw:true,transaction:tx}),foundations:[]};
  const fresh=order.order_status==='未归档'?await G.buildProductPricingDetails(id,tx):entries.map(r=>r.line);
  const resolved=await V.resolveDocumentTaxBasis(order,await F.salesBasis(order,fresh,tx),tx);
  const changes=[];
  for(const l of resolved){if(l.purchaseTaxBasis?.status!=='confirmed'||V.isService(l))continue;const basis=l.inventoryFoundation;if(!basis?.basisId||basis.status!=='pending')continue;
   const row=await M.InventoryFoundation.findByPk(basis.basisId,{transaction:tx,lock:tx.LOCK.UPDATE});if(row.status!=='pending')continue;
   const source=typeof row.source_data==='string'?JSON.parse(row.source_data):row.source_data;if(source?.taxScope||source?.identityConflict)continue;
   before.foundations.push(row.toJSON());changes.push({row,tax:l.purchaseTaxBasis,itemId:l.itemId});
  }
  if(apply)fs.writeFileSync(path.join(dir,'before-'+id+'.json'),JSON.stringify(before,null,2),{flag:'wx'});
  for(const c of changes)await F.confirmTaxEvidence(c.row,c.tax,{name:batch},'退货票税按可追溯原采购或有效库存一致性依据确认，保留成本与定价',tx);
  let estimate=null;
  if(order.order_status==='未归档'){
   const ready=await G.buildProductPricingDetails(id,tx);
   if(ready.every(l=>l.purchaseTaxBasis?.status==='confirmed')&&ready.every(l=>l.unitPricing!==null&&l.unitPricing!==undefined))estimate=await G.calculateAndSaveOrderGrossProfit(id,{transaction:tx,force:true,requireComplete:true,calculatedBy:batch});
  }
  // The existing draft estimator refreshes the derived freight field from
  // freight records. All original merchandise facts must remain identical.
  const facts=rows=>rows.map(({freight_cost,...x})=>x);
  a.deepEqual(facts(await M.OrderItem.findAll({where:{order_id:id},raw:true,transaction:tx})),facts(before.items));
  if(order.order_status!=='未归档')a.deepEqual((await M.OrderGrossProfit.findOne({where:{order_id:id},raw:true,transaction:tx}))||null,before.snapshot);
  const result={orderNo:order.order_no,orderId:id,confirmed:changes.map(c=>({basisId:c.row.basis_id,itemId:c.itemId,invoiceType:c.tax.invoiceType})),estimate:estimate?.gross_profit_amount??null};
  await recordBusinessAction({businessType:'sales_order',businessId:id,businessNo:order.order_no,action:'repair_return_tax_full',user:{name:batch},detail:result,transaction:tx});
  if(apply)await tx.commit();else await tx.rollback();results.push(result);
 }catch(e){if(!tx.finished)await tx.rollback();results.push({orderId:id,error:e.message});}}
 fs.writeFileSync(path.join(dir,apply?'repair-results.json':'repair-preview.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({apply,orders:results.length,confirmed:results.reduce((n,x)=>n+(x.confirmed?.length||0),0),results}));
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>M.sequelize.close());
