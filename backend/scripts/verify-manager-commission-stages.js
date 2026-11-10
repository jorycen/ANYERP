// Read-only verification. No settings, orders or frozen profit facts are saved.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const M=require('../src/models'),R=require('../src/modules/report/employeeProfitSummary');
const {money}=require('../src/modules/report/employeeCommission');
(async()=>{
 const query={startDate:'2026-10-01',endDate:'2026-10-31',reportRole:'manager'};
 const user={staffId:9,roles:['boss'],accessibleStoreIds:['*']};
 const result=await R.load(user,query);
 for(const row of result.rows.filter(r=>r.rule==='manager'&&r.status==='estimated')){
  assert.equal(money(row.lowGrossProfit+row.highGrossProfit),row.grossProfit);
  assert.equal(money(row.lowDeduction+row.highDeduction),row.expensePerformanceDeduction);
  assert.equal(money(row.lowNetGrossProfit+row.highNetGrossProfit),row.netGrossProfit);
  assert.equal(money(row.lowCommission+row.highCommission),row.salesCommission);
  assert.equal(money(row.salesCommission+row.storeCommission),row.performanceEstimate);
 }
 const report={verifiedAt:new Date().toISOString(),query,rows:result.rows.map(r=>({name:r.employeeName,store:r.storeName,rule:r.rule,gross:r.grossProfit,lowGross:r.lowGrossProfit,highGross:r.highGrossProfit,expense:r.expensePerformanceDeduction,lowExpense:r.lowDeduction,highExpense:r.highDeduction,lowCommission:r.lowCommission,highCommission:r.highCommission,salesCommission:r.salesCommission,storeCommission:r.storeCommission,performanceEstimate:r.performanceEstimate,status:r.status,reason:r.reason}))};
 const dir=path.resolve(__dirname,'../../outputs/manager-stages-20261110');fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'verification.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(()=>M.sequelize.close());
