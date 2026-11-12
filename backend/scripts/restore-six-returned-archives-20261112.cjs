// Explicitly authorized six-order repair. Preview by default; --apply writes once.
const fs=require('node:fs'),path=require('node:path'),a=require('node:assert/strict');
const M=require('../src/models'),{recordBusinessAction}=require('../src/utils/businessActionLog');
const ids=['90a5db6654b742c281b5e4f443aa72e9','e25010ea45b1441b908230b7e1954c84','6087bf82c91e4d1ebcbd31af1a89a24c','919f1c66be1245d8a8c5a1f9ab66784e','c9c7b307713a42b081dde18bcfcc2666','41a80e8076e8488c99c051235456b703'];
const dir=path.resolve(__dirname,'../backup/six-returned-archives-20261112');
const month=x=>new Date(new Date(x).getTime()+28800000).toISOString().slice(0,7);
async function snapshot(transaction){
 const opts={transaction,raw:true,lock:transaction.LOCK.UPDATE};
 return {orders:await M.Order.findAll({...opts,where:{order_id:ids},order:[['order_id','ASC']]}),profits:await M.OrderGrossProfit.findAll({...opts,where:{order_id:ids},order:[['order_id','ASC']]}),returns:await M.SalesReturnGrossProfitLedger.findAll({...opts,where:{order_id:ids},order:[['ledger_id','ASC']]})};
}
(async()=>{
 const apply=process.argv.includes('--apply');
 await M.sequelize.transaction(async transaction=>{
  const periods=await M.sequelize.query("SELECT * FROM T_FINANCIAL_PROFIT_PERIOD WHERE MONTH_KEY IN ('2026-10','2026-11') FOR UPDATE",{transaction,type:M.sequelize.QueryTypes.SELECT});
  for(const p of periods)a.equal(String(p.STATUS||p.status).toLowerCase(),'open','财务期间未开放');
  const expense=await M.ExpenseAccountingPeriod.findAll({where:{month_key:['2026-10','2026-11']},transaction,lock:transaction.LOCK.UPDATE,raw:true});
  for(const p of expense)a.equal(p.status,'open','费用期间未开放');
  const before=await snapshot(transaction);a.equal(before.orders.length,6);
  const logs=await M.BusinessActionLog.findAll({where:{business_id:ids,action:'archived'},transaction,raw:true});
  const plan=before.orders.map(o=>{
   a.equal(o.order_status,'returned');a.equal(o.archive_time,null,'禁止重复覆盖归档时间');
   const found=logs.filter(l=>l.business_id===o.order_id);a.equal(found.length,1,'必须唯一原始归档日志');
   const at=found[0].create_time;a.equal(month(at),'2026-10');
   const returns=before.returns.filter(r=>r.order_id===o.order_id);a(returns.length);returns.forEach(r=>a.equal(month(r.create_time),'2026-10'));
   const profit=before.profits.find(p=>p.order_id===o.order_id);a(profit);
   return {orderId:o.order_id,orderNo:o.order_no,archiveTime:at,auditLogId:found[0].log_id,positive:Number(profit.gross_profit_amount),negative:returns.reduce((s,r)=>s+Number(r.gross_profit_amount),0)};
  });
  a.equal(Math.round(plan.reduce((s,r)=>s+r.positive,0)*100),196597);
  a.equal(Math.round(plan.reduce((s,r)=>s+r.negative,0)*100),-196597);
  console.log(JSON.stringify({apply,plan},null,2));if(!apply)return;
  fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'before.json'),JSON.stringify({before,plan},null,2),{flag:'wx'});
  for(const r of plan){
   const [count]=await M.Order.update({archive_time:r.archiveTime},{where:{order_id:r.orderId,archive_time:null},transaction});a.equal(count,1);
   await recordBusinessAction({businessType:'sales_order',businessId:r.orderId,businessNo:r.orderNo,action:'archive_time_restored',user:{name:'用户授权（本会话）'},comment:'方案1：按原始归档日志恢复10月正毛利；退货负毛利保留真实10月入账。',detail:{batch:'SIX-RETURNED-ARCHIVES-20261112',...r},transaction});
  }
  const after=await snapshot(transaction);
  a.deepEqual(after.profits,before.profits);a.deepEqual(after.returns,before.returns);
  for(let i=0;i<6;i++){const x={...after.orders[i]},y={...before.orders[i]};delete x.archive_time;delete y.archive_time;delete x.update_time;delete y.update_time;a.deepEqual(x,y);}
  fs.writeFileSync(path.join(dir,'transaction-after.json'),JSON.stringify(after,null,2),{flag:'wx'});
 });
 if(apply){const rows=await M.Order.findAll({where:{order_id:ids},attributes:['order_id','order_no','archive_time','order_status'],raw:true});a(rows.every(r=>month(r.archive_time)==='2026-10'&&r.order_status==='returned'));fs.writeFileSync(path.join(dir,'committed-readback.json'),JSON.stringify(rows,null,2),{flag:'wx'});console.log('COMMITTED: six original October positives restored; return ledgers and all GP amounts unchanged.');}
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(()=>M.sequelize.close());
