require('./test-six-archives-index.cjs');
const M=require('../src/models'),R=require('../src/modules/report/employeeProfitSummary'),F=require('../src/modules/report/financialProfitController'),fs=require('fs'),path=require('path'),a=require('node:assert/strict');
(async()=>{
 const stores=await M.Store.findAll({where:{is_deleted:0,status:1},raw:true}),out=[];
 for(const month of ['2026-10','2026-11']){
  const startDate=month+'-01',endDate=month+(month==='2026-10'?'-31':'-30');
  const r=await R.load({staffId:1,roles:['boss'],accessibleStoreIds:['*']},{startDate,endDate,reportRole:'all'});
  const f=await F.queryFinancialProfit({storeIds:stores.map(s=>s.store_id),startDate,endDate,includeStores:true,salesStageOnly:true});
  const ids=require('../backup/six-returned-archives-20261112/before.json').plan.map(r=>r.orderId),events=f.profitDetails.filter(e=>ids.includes(e.orderId)&&['sale','return'].includes(e.entryType));
  a.equal(events.filter(e=>e.entryType==='sale').length,month==='2026-10'?6:0);a.equal(events.filter(e=>e.entryType==='return').length,month==='2026-10'?6:0);
  out.push({month,salesGross:r.panels.sales.grossProfit,events:events.map(e=>({type:e.entryType,no:e.entryNo,date:e.businessDate,sales:e.salesGrossProfit}))});
 }
 fs.writeFileSync(path.resolve(__dirname,'../backup/six-returned-archives-20261112/report-verification.json'),JSON.stringify(out,null,2));console.log(JSON.stringify(out));
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(()=>M.sequelize.close());
