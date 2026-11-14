// One-off correction explicitly requested by the user; does not change approval facts.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const M=require('../src/models');
const {recordBusinessAction}=require('../src/utils/businessActionLog');
const batch='RETURN-POSTING-20261111-RET202609300916536583';
const target=new Date('2026-09-30T23:40:00+08:00');
const dir=path.resolve(__dirname,'../backup/order-corrections',batch);
const plain=x=>JSON.parse(JSON.stringify(x));
async function read(transaction,lock=false){
 const opt={transaction,raw:true,...(lock?{lock:transaction.LOCK.UPDATE}:{})};
 const request=await M.SalesReturnRequest.findOne({where:{return_no:'RET202609300916536583'},...opt});
 assert(request,'退单不存在');
 return {request,settlements:await M.SalesReturnSettlement.findAll({where:{return_id:request.return_id},...opt}),
  ledgers:await M.SalesReturnGrossProfitLedger.findAll({where:{return_id:request.return_id},...opt}),
  order:await M.Order.findByPk(request.order_id,opt)};
}
function verify(before,after){
 assert.deepEqual(plain(after.request),plain(before.request),'审批记录变化');
 assert.deepEqual(plain(after.order),plain(before.order),'原销售单变化');
 for(const key of ['settlements','ledgers']){
  assert.equal(after[key].length,before[key].length);
  const id=key==='settlements'?'settlement_id':'ledger_id';
  for(const r of after[key]){
   const expected=plain(before[key].find(x=>x[id]===r[id]));
   expected.create_time=target.toISOString();
   // MySQL updates the maintenance timestamp automatically; this is not a business date.
   if(key==='settlements')expected.update_time=plain(r).update_time;
   assert.deepEqual(plain(r),expected,'除统计时间外不应有变化');
  }
 }
}
(async()=>{
 fs.mkdirSync(dir,{recursive:true});
 let before;
 await M.sequelize.transaction(async transaction=>{
  before=await read(transaction,true);
  assert.equal(before.request.status,'completed');assert.equal(before.settlements.length,1);assert.equal(before.ledgers.length,1);
  assert.equal(Number(before.ledgers[0].gross_profit_amount),-2227.27);
  assert.equal(before.request.order_no,'ORD202609261416054441');
  const already=before.settlements.every(x=>new Date(x.create_time).getTime()===target.getTime())&&before.ledgers.every(x=>new Date(x.create_time).getTime()===target.getTime());
  if(already){console.log('已为指定时间，无需重复修改');return;}
  assert.equal(new Date(before.settlements[0].create_time).toISOString(),'2026-09-30T16:01:33.000Z');
  assert.equal(new Date(before.ledgers[0].create_time).toISOString(),'2026-09-30T16:01:32.000Z');
  const store=await M.Store.findByPk(before.request.store_id,{transaction,lock:transaction.LOCK.UPDATE});
  const months=['2026-09','2026-10'];
  const locked=await M.sequelize.query('SELECT MONTH_KEY FROM T_FINANCIAL_PROFIT_PERIOD WHERE MONTH_KEY IN (:months) FOR UPDATE',{replacements:{months},transaction,type:M.sequelize.QueryTypes.SELECT});
  assert.equal(locked.length,0,'财务期间已关账');
  const expense=await M.ExpenseAccountingPeriod.findAll({where:{distributor_id:store.distributor_id,month_key:months},transaction,lock:transaction.LOCK.UPDATE,raw:true});
  assert(expense.every(p=>p.status==='open'),'费用期间已锁定');
  const adjustments=await M.PerformanceProfitAdjustment.findAll({where:{order_id:before.request.order_id},transaction,lock:transaction.LOCK.UPDATE,raw:true});
  assert.equal(adjustments.length,0,'有关联调整，需要另行核实');
  const backup=path.join(dir,'before.json');
  if(fs.existsSync(backup))assert.deepEqual(JSON.parse(fs.readFileSync(backup,'utf8')).before,plain(before),'备份后原单变化');
  else fs.writeFileSync(backup,JSON.stringify({batch,target:target.toISOString(),before},null,2),{flag:'wx'});
  if(!process.argv.includes('--apply')){console.log('预览通过，未修改');return;}
  await M.SalesReturnSettlement.update({create_time:target},{where:{settlement_id:before.settlements[0].settlement_id},transaction});
  await M.SalesReturnGrossProfitLedger.update({create_time:target},{where:{ledger_id:before.ledgers[0].ledger_id},transaction});
  const after=await read(transaction);verify(before,after);
  await recordBusinessAction({businessType:'sales_return',businessId:before.request.return_id,businessNo:before.request.return_no,
   action:'correct_return_posting_time',user:{name:'用户授权（Codex会话）'},comment:batch,
   detail:{authorization:'用户要求将本退单归档统计时间调整为2026-09-30 23:40北京时间，避免计入10月',
    preserved:'真实审批记录、原销售单、退款及毛利金额保持',
    before:{settlement:before.settlements[0].create_time,ledger:before.ledgers[0].create_time},after:target.toISOString()},transaction});
 });
 if(process.argv.includes('--apply')){const after=await read();verify(before,after);fs.writeFileSync(path.join(dir,'verified.json'),JSON.stringify(after,null,2));
  console.log(JSON.stringify({returnNo:after.request.return_no,postingTime:'2026-09-30 23:40:00+08:00',grossProfit:after.ledgers[0].gross_profit_amount,verified:true}));}
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>M.sequelize.close());
