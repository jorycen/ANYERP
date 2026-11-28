const test=require('node:test'),assert=require('node:assert/strict');
const M=require('../src/models'),C=require('../src/modules/finance/invoiceController');
const {Op}=require('sequelize');
const user={roles:['finance'],accessibleDistributorIds:['A']};
const context=(query={},body={})=>({query,request:{body},state:{user},throw(status,message){throw Object.assign(new Error(message),{status});}});
function mock(t){
 t.mock.method(M.sequelize,'query',async()=>[
  {payment_id:'1',distributor_id:'A',paid_amount:1.23,invoiced_amount:0.23,payment_time:'2026-10-01 12:00:00'},
  {payment_id:'2',distributor_id:'A',paid_amount:2.5,invoiced_amount:0,payment_time:'2026-10-02 12:00:00'},
  {payment_id:'other',distributor_id:'B',paid_amount:999,invoiced_amount:0,payment_time:'2026-10-01 12:00:00'}]);
 t.mock.method(M.Distributor,'findAll',async()=>[{distributor_id:'A',name:'经销商甲'}]);
}
test('candidate dealer and date filters share the backend summary without expanding scope',async t=>{
 mock(t);const ctx=context({distributorId:'A',startDate:'2026-10-02'});await C.getInvoiceCandidates(ctx);
 assert.equal(ctx.body.data.list.length,1);assert.equal(ctx.body.data.list[0].distributor_name,'经销商甲');assert.equal(ctx.body.data.summary.unreceived_amount,2.5);
 const denied=context({distributorId:'B'});await C.getInvoiceCandidates(denied);assert.equal(denied.body.data.list.length,0);
});
test('selected invoice total uses current authorized remaining amounts, deduplicates ids and rejects inaccessible payments',async t=>{
 mock(t);const ctx=context({}, {paymentIds:['1','2','1'],totalAmount:99999});await C.previewInvoice(ctx);
 assert.deepEqual(ctx.body.data,{selectedCount:2,selectedRemainingAmount:3.5});
 await assert.rejects(C.previewInvoice(context({}, {paymentIds:['other']})),/无权限/);
 await assert.rejects(C.previewInvoice(context({}, {paymentIds:['deleted']})),/已变化/);
 const empty=context({}, {paymentIds:[]});await C.previewInvoice(empty);assert.equal(empty.body.data.selectedRemainingAmount,0);
});
test('received dealer filter intersects the original permission condition',async t=>{
 let where;t.mock.method(M.PurchaseInvoice,'findAll',async options=>{where=options.where;return [];});
 await C.listInvoices(context({distributorId:'B'}));
 assert.deepEqual(where.distributor_id,{[Op.in]:['A']});assert.deepEqual(where[Op.and],[{distributor_id:'B'}]);
});
