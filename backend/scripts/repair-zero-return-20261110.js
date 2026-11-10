// Explicitly authorized repair of this one completed zero-price return only.
// Default is read-only; --apply writes an immutable zero ledger and audit.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const M=require('../src/models');
const {randomUUID}=require('node:crypto');
const {createSalesReturnGrossProfitLedger}=require('../src/modules/sales/grossProfit');
const returnId='5e0fa8cc3b4c4e3fa20f8efc390ac11d';
const batch='ZERO-RETURN-20261110-RET202610260946469134';
const dir=path.resolve(__dirname,'../backup/order-corrections',batch);
async function facts(transaction){
 const request=await M.SalesReturnRequest.findByPk(returnId,{transaction,lock:transaction?.LOCK.UPDATE});
 assert.equal(request?.return_no,'RET202610260946469134');assert.equal(request.status,'completed');
 const items=await M.SalesReturnRequestItem.findAll({where:{return_id:returnId},transaction,raw:true});
 assert.equal(items.length,1);assert.equal(Number(items[0].order_item_id),47206);
 assert.equal(Number(items[0].quantity),2);assert.equal(Number(items[0].unit_price),0);
 const inbound=await M.sequelize.query('SELECT * FROM T_INBOUND WHERE SOURCE_NO=:no AND STATUS=:status',{replacements:{no:request.return_no,status:'completed'},type:M.sequelize.QueryTypes.SELECT,transaction});
 assert.equal(inbound.length,1);assert.ok(inbound[0].RECEIVE_TIME);
 const order=await M.Order.findByPk(request.order_id,{transaction,raw:true});
 const snapshot=await M.OrderGrossProfit.findAll({where:{order_id:request.order_id},transaction,raw:true});
 const ledger=await M.SalesReturnGrossProfitLedger.findAll({where:{return_id:returnId},transaction,raw:true});
 return {request:request.toJSON(),items,inbound,order,snapshot,ledger};
}
(async()=>{
 const before=await facts();
 if(!process.argv.includes('--apply')){console.log(JSON.stringify({batch,ledger:before.ledger,completion:before.inbound[0].RECEIVE_TIME}));return;}
 fs.mkdirSync(dir,{recursive:true});
 const backup=path.join(dir,'before.json');
 if(!fs.existsSync(backup))fs.writeFileSync(backup,JSON.stringify(before,null,2),{flag:'wx'});
 await M.sequelize.transaction(async transaction=>{
   const current=await facts(transaction);
   if(current.ledger.length){assert.ok(current.ledger.every(r=>Number(r.gross_profit_amount)===0&&Number(r.returned_sales_amount)===0));return;}
   const rows=await createSalesReturnGrossProfitLedger({returnRequest:current.request,transaction,createdBy:batch});
   assert.ok(rows.length>0);
   for(const row of rows){assert.equal(Number(row.gross_profit_amount),0);await row.update({create_time:current.inbound[0].RECEIVE_TIME},{transaction});}
   await M.BusinessActionLog.create({log_id:randomUUID().replaceAll('-',''),business_type:'sales_return',business_id:returnId,business_no:current.request.return_no,action:'repair_zero_return_ledger',actor_name:'用户授权修复',detail_json:JSON.stringify({batch,reason:'零元退货原被跳过，补记明确零冲减；沿用原入库完成日期',before:current.ledger,after:rows.map(r=>r.toJSON())})},{transaction});
 });
 const after=await facts();
 assert.deepEqual(after.order,before.order);assert.deepEqual(after.snapshot,before.snapshot);
 assert.ok(after.ledger.length>0);assert.ok(after.ledger.every(r=>Number(r.gross_profit_amount)===0&&Number(r.returned_sales_amount)===0));
 fs.writeFileSync(path.join(dir,'verified.json'),JSON.stringify(after,null,2));
 console.log(JSON.stringify({batch,verified:true,ledger:after.ledger}));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>M.sequelize.close());
