const test=require('node:test'),assert=require('node:assert/strict');
const {supplierReturnEligibility:eligible}=require('../src/modules/inventory/supplierReturnEligibility');
test('only completed purchase receipts with original purchase binding use the current supplier return flow',()=>{
 assert.equal(eligible({status:'completed',source_type:'purchase',purchase_request_id:'p'}).can_request_return,true);
 for(const source_type of ['SALES_RETURN','TRANSFER','batch_inbound','GIFT']){
  const result=eligible({status:'completed',source_type});assert.equal(result.can_request_return,false);assert.match(result.supplier_return_reason,/不是采购入库单/);
 }
 assert.equal(eligible({status:'completed',source_type:'purchase'}).can_request_return,false);
 assert.equal(eligible({status:'pending',source_type:'purchase',purchase_request_id:'p'}).can_request_return,false);
});
test('sales-return receipt is rejected before any supplier-return document is created',async t=>{
 const M=require('../src/models'),controller=require('../src/modules/inventory/controller');let writes=0,rollbacks=0;
 t.mock.method(M.sequelize,'transaction',async()=>({LOCK:{UPDATE:'UPDATE'},rollback:async()=>{rollbacks++;}}));
 t.mock.method(M.Inbound,'findByPk',async()=>({status:'completed',source_type:'SALES_RETURN',inbound_id:'i'}));
 t.mock.method(M.ReturnStock,'create',async()=>{writes++;});
 t.mock.method(console,'error',()=>{});
 const ctx={request:{body:{inboundId:'i',items:[{inboundItemId:1,quantity:1,snIds:['sn']}]}},state:{user:{}},throw(status,message){throw Object.assign(Error(message),{status});}};
 await assert.rejects(controller.requestReturn(ctx),/不是采购入库单/);assert.equal(writes,0);assert.equal(rollbacks,1);
});
