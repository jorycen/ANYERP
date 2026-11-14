const fs=require('fs'),cp=require('child_process'),path=require('path'),Module=require('module'),a=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),report=path.resolve(root,'backend/src/modules/report'),baseline=process.argv.includes('--baseline'),reader=Module._extensions['.js'];
Module._extensions['.js']=(m,file)=>{if(file.startsWith(report+path.sep)){let text;try{text=cp.execFileSync('git',['show',(baseline?'HEAD:':':')+path.relative(root,file).replaceAll('\\','/')],{cwd:root,encoding:'utf8',stdio:['pipe','pipe','ignore']});}catch{}if(text!==undefined)return m._compile(text,file);}return reader(m,file);};
const M=require('../src/models'),R=require('../src/modules/report/employeeProfitSummary'),F=require('../src/modules/report/financialProfitController');
const list=require('../src/modules/report/commissionPeriodExceptions.json'),round=n=>Math.round(n*100)/100;
(async()=>{
 const user={staffId:1,roles:['boss'],accessibleStoreIds:['*']},results=[];
 const stores=await M.Store.findAll({where:{is_deleted:0,status:1},raw:true});
 for(const [startDate,endDate]of [['2026-10-01','2026-10-31'],['2026-11-01','2026-11-30']]){
  const query={startDate,endDate,reportRole:'all'},data=await R.load(user,query),financial=await F.queryFinancialProfit({storeIds:stores.map(s=>s.store_id),startDate,endDate,includeStores:true,salesStageOnly:true});
  const events=financial.profitDetails.filter(e=>list.sales.some(s=>e.eventKey==='sale:'+s.orderId)||list.adjustments.some(s=>e.eventKey==='performance:'+s.adjustmentId));
  const isOctober=startDate.startsWith('2026-10');
  if(!baseline){a.equal(events.length,isOctober?65:0,'例外事件跨期重复或遗漏');for(const e of events){const target=list.sales.find(s=>e.eventKey==='sale:'+s.orderId)||list.adjustments.find(s=>e.eventKey==='performance:'+s.adjustmentId);a.equal(e.businessDate,new Date(new Date(target.postingTime).getTime()+28800000).toISOString().slice(0,10));}}
  results.push({month:startDate.slice(0,7),salesGross:data.panels.sales.grossProfit,events:events.map(e=>({key:e.eventKey,date:e.businessDate,sales:e.salesGrossProfit})),managers:data.rows.filter(r=>r.rule==='manager').map(r=>({name:r.employeeName,store:r.storeName,gross:r.grossProfit,storeGross:r.storeGrossProfit,salesCommission:r.salesCommission,storeCommission:r.storeCommission,status:r.status})),staff:data.rows.filter(r=>r.sideName==='销售端').map(r=>({id:r.staffId,name:r.employeeName,gross:r.grossProfit,net:r.netGrossProfit}))});
 }
 const dir=path.resolve(__dirname,'../backup/commission-period-exceptions-20261112');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,baseline?'before.json':'after.json'),JSON.stringify(results,null,2));
 if(!baseline){const before=JSON.parse(fs.readFileSync(path.join(dir,'before.json')));a.equal(round(results[0].salesGross-before[0].salesGross),-12024.25);a.equal(round(results[1].salesGross-before[1].salesGross),12024.25);a.equal(round(results.reduce((s,r)=>s+r.salesGross,0)-before.reduce((s,r)=>s+r.salesGross,0)),0);
  const source=JSON.parse(fs.readFileSync(path.join(dir,'source-records.json'))),ids=[...new Set([...list.sales.map(s=>s.orderId),...list.adjustments.map(s=>s.orderId)])],orders=await M.Order.findAll({where:{order_id:ids},raw:true}),corrections=await M.PerformanceProfitAdjustment.findAll({where:{adjustment_id:list.adjustments.map(r=>r.adjustmentId)},raw:true});
  for(const row of orders){const old=source.orders.find(r=>r.order_id===row.order_id),value=JSON.parse(JSON.stringify(row));for(const key of ['order_status','create_time','archive_time','total_amount','actual_payment','invoice_amount'])a.deepEqual(value[key],old[key],'原订单日期或金额变化');}
  for(const row of corrections){const old=source.corrections.find(r=>r.adjustment_id===row.adjustment_id),value=JSON.parse(JSON.stringify(row));for(const key of ['status','signed_amount','admin_review_time','create_time'])a.deepEqual(value[key],old[key],'审批原始记录变化');}
 }
 console.log(JSON.stringify({baseline,periods:results.map(r=>({month:r.month,sales:r.salesGross,exceptionEvents:r.events.length}))}));
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(()=>M.sequelize.close());
