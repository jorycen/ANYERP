// Exact, user-authorized one-order operation. Preview rolls the entire transaction back.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const M=require('../src/models'),I=require('../src/modules/inventory/controller'),P=require('../src/modules/purchase/controller');
const {generateUUID,generateId}=require('../src/utils');
const {recordBusinessAction}=require('../src/utils/businessActionLog');
const batch='RETURN-20261102-PR202609021009593351';
const directory=path.resolve(__dirname,'../backup/purchase-return-corrections',batch);
const requestId='ddbc115483c849c594448a465a320930',inboundId='c5251185ee9b48d5b18b087838b489b0';
const currentId='1263dd38c9fc4cbc87aa239155684f5e',oldId='35272062f1394e97bff82e9fa43a870f';
const user={name:'User confirmation via Codex chat',roles:['boss'],accessibleStoreIds:['D0215790'],accessibleDistributorIds:['DIST001']};
const reason='用户确认U533N7YG与SU533N7YG为同一台，原采购漏录S；修复原采购关联后整单退供应商，原未付450元按原规则生成负向采购应付，不发生现金退款';
const context=body=>({request:{body},state:{user},throw(status,message){throw Object.assign(Error(message),{status});}});
async function run(){
 fs.mkdirSync(directory,{recursive:true});const apply=process.argv.includes('--apply');
 const transaction=await M.sequelize.transaction();
 try{
  const request=await M.PurchaseRequest.findByPk(requestId,{transaction,lock:transaction.LOCK.UPDATE});
  assert.equal(request.status,'approved');assert.equal(Number(request.actual_total),450);
  const supplier=await M.Supplier.findByPk(request.supplier_id,{transaction});
  const inbound=await M.Inbound.findByPk(inboundId,{transaction,lock:transaction.LOCK.UPDATE});assert.equal(inbound.status,'completed');assert.equal(inbound.store_id,'D0215790');
  const originals=await M.PurchaseRequestItem.findAll({where:{request_id:requestId},transaction});assert.equal(originals.length,1);assert.equal(Number(originals[0].quantity),1);assert.equal(Number(originals[0].unit_price),450);
  const item=await M.InboundItem.findByPk(1861,{transaction,lock:transaction.LOCK.UPDATE});assert.equal(item.inbound_id,inboundId);assert.equal(item.sn_id,oldId);assert.equal(Number(item.received_quantity),1);
  const binding=await M.InboundItemSn.findByPk(983,{transaction,lock:transaction.LOCK.UPDATE});assert.equal(binding.sn_id,oldId);
  const current=await M.ProductSn.findByPk(currentId,{transaction,lock:transaction.LOCK.UPDATE});
  const old=await M.ProductSn.findByPk(oldId,{transaction,lock:transaction.LOCK.UPDATE});
  assert.equal(current.sn_code,'SU533N7YG');assert.equal(old.sn_code,'U533N7YG');assert.equal(current.product_id,item.product_id);assert.equal(old.product_id,item.product_id);
  assert.equal(current.status,'in_stock');assert.equal(current.store_id,inbound.store_id);assert.equal(current.inventory_type,'normal_qty');assert.equal(old.status,'out_stock');assert.equal(Number(old.inbound_price),450);
  const payable=await M.Payable.findByPk('e3adf038539e452b9aac1f9f9a55c541',{transaction,lock:transaction.LOCK.UPDATE});
  assert.equal(Number(payable.total_amount),450);for(const key of ['paid_amount','settled_amount','offset_amount'])assert.equal(Number(payable[key]),0);
  for(const [model,where]of [[M.PurchaseAdjustment,{request_id:requestId}],[M.SettlementItem,{payable_id:payable.payable_id}],[M.ReturnStock,{inbound_id:inboundId}]])assert.equal(await model.count({where,transaction}),0,'已有退单、结算或退库，请人工核对');
  const periods=await M.ExpenseAccountingPeriod.findAll({where:{distributor_id:request.distributor_id,month_key:['2026-09','2026-11']},transaction,lock:transaction.LOCK.UPDATE});assert(periods.every(row=>row.status==='open'),'相关期间已锁定');
  const inventory=await M.Inventory.findAll({where:{product_id:current.product_id},transaction,lock:transaction.LOCK.UPDATE});
  const price=await M.ProductPrice.findAll({where:{product_id:current.product_id},transaction,lock:transaction.LOCK.UPDATE});
  const stock=inventory.find(row=>row.store_id===current.store_id&&row.location_id===current.location_id);assert(stock&&Number(stock.normal_qty)>=1,'当前仓位没有可退实物库存');
  const snapshot={batch,authorization:reason,request:request.toJSON(),inbound:inbound.toJSON(),item:item.toJSON(),binding:binding.toJSON(),current:current.toJSON(),old:old.toJSON(),payable:payable.toJSON(),inventory:inventory.map(r=>r.toJSON()),prices:price.map(r=>r.toJSON())};
  if(apply)fs.writeFileSync(path.join(directory,'before.json'),JSON.stringify(snapshot,null,2),{flag:'wx'});
  // Correct only the confirmed source identity; retain old SN and all previous logs.
  await item.update({sn_id:currentId,sn_code:current.sn_code,received_sn_codes:JSON.stringify([current.sn_code])},{transaction});
  await binding.update({sn_id:currentId,sn_code:current.sn_code},{transaction});
  await old.update({remark:`${old.remark||''} [用户确认同机别名：${current.sn_code}；${batch}]`},{transaction});
  await current.update({inbound_price:450,original_pickup_price:450,supplier_id:request.supplier_id,supplier_name:supplier.name,
   remark:`${current.remark||''} [原采购关联纠正：${request.request_no}，原录入SN:${old.sn_code}，用户确认同机]`},{transaction});
  await M.SnLog.create({log_id:generateUUID(),sn_id:currentId,sn_code:current.sn_code,product_id:current.product_id,store_id:current.store_id,
   action:'purchase_cost_correction',remark:JSON.stringify({batch,requestNo:request.request_no,oldAlias:old.sn_code,beforeCost:0,afterCost:450,userConfirmed:true}),create_user:user.name},{transaction});
  const returnId=generateUUID(),returnNo=generateId('RT');
  await M.ReturnStock.create({return_id:returnId,return_no:returnNo,inbound_id:inboundId,inbound_no:inbound.inbound_no,store_id:current.store_id,purchase_request_id:requestId,
   distributor_id:request.distributor_id,supplier_id:request.supplier_id,supplier_name:supplier.name,total_quantity:1,total_amount:450,reason,status:'approved',
   approve_user:user.name,approve_comment:'用户会话已明确确认同机及直接执行整单退库',approve_time:new Date(),create_user:user.name},{transaction});
  await M.ReturnStockItem.create({return_id:returnId,inbound_item_id:item.item_id,product_id:item.product_id,product_name:item.product_name,pn_code:current.pn_code,
   sn_code:current.sn_code,sn_id:currentId,quantity:1,unit_price:450,location_id:current.location_id,inventory_type:current.inventory_type,product_type:item.product_type,remark:batch},{transaction});
  await I.executeReturn(context({returnId}),transaction);
  const pending=await M.Inbound.findAll({where:{purchase_request_id:requestId,status:'pending'},transaction});assert.equal(pending.length,1,'退库后待撤单入库周期不唯一');
  const pendingItems=await M.InboundItem.findAll({where:{inbound_id:pending[0].inbound_id},transaction});assert.equal(pendingItems.length,1);assert.equal(Number(pendingItems[0].quantity),1);
  const cancel=context({requestId,reason,items:[{inboundItemId:pendingItems[0].item_id,returnQuantity:1}]});
  await P.createPurchaseAdjustment(cancel,transaction);
  const updatedRequest=await M.PurchaseRequest.findByPk(requestId,{transaction});assert.equal(updatedRequest.status,'revoked');
  const returned=await M.ProductSn.findByPk(currentId,{transaction});assert.equal(returned.status,'returned');
  const negative=await M.Payable.findByPk(cancel.body.data.payableId,{transaction});assert.equal(Number(negative.total_amount),-450);
  const result={batch,mode:apply?'applied':'preview',requestNo:request.request_no,supplier:supplier.name,sn:current.sn_code,returnNo,
   adjustmentNo:cancel.body.data.adjustmentNo,purchaseStatus:updatedRequest.status,snStatus:returned.status,returnedQuantity:1,amount:450,originalPayable:450,negativePayable:-450,netPayable:0,
   returnId,adjustmentId:cancel.body.data.adjustmentId,negativePayableId:negative.payable_id};
  await recordBusinessAction({businessType:'purchase_request',businessId:requestId,businessNo:request.request_no,action:'confirmed_alias_full_return',user,comment:batch,
   detail:{...result,authorization:reason,oldSnId:oldId,currentSnId:currentId,approvalSource:'explicit_user_confirmation_in_chat',noCashMovement:true},transaction});
  if(apply)await transaction.commit();else await transaction.rollback();
  if(apply){
   const fresh=await M.ProductSn.findByPk(currentId,{raw:true});assert.equal(fresh.status,'returned');
   const freshRequest=await M.PurchaseRequest.findByPk(requestId,{raw:true});assert.equal(freshRequest.status,'revoked');
   const ps=await M.Payable.findAll({where:{request_id:requestId},raw:true});assert.equal(ps.reduce((sum,p)=>sum+Number(p.total_amount),0),0);assert(ps.every(p=>Number(p.paid_amount)===0));
   const remaining=await M.Inbound.count({where:{purchase_request_id:requestId,status:'pending'}});assert.equal(remaining,0);
   const inv=await M.Inventory.findOne({where:{product_id:fresh.product_id,store_id:fresh.store_id,location_id:fresh.location_id},raw:true});assert.equal(Number(inv.normal_qty),Number(stock.normal_qty)-1);
  }
  fs.writeFileSync(path.join(directory,apply?'result.json':'preview.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }catch(error){if(!transaction.finished)await transaction.rollback();throw error;}
}
run().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(()=>M.sequelize.close());
