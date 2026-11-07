const M=require('../src/models'),fs=require('node:fs'),path=require('node:path');
async function main(){
 const apply=process.argv.includes('--apply'),dir=path.resolve(__dirname,'../backup/monthly-profit-20261107');fs.mkdirSync(dir,{recursive:true});
 if(apply){
  const tasks=await M.MonthlyTask.findAll({where:{month_key:{[require('sequelize').Op.gte]:'2026-11'}},raw:true});
  const allocations=await M.MonthlyTaskGrossProfitAllocation.findAll({where:{task_id:tasks.map(t=>t.task_id)},raw:true});
  fs.writeFileSync(path.join(dir,'before-'+Date.now()+'.json'),JSON.stringify({tasks,allocations},null,2),{flag:'wx'});
 }
 const result=await require('../src/modules/sales/migrateMonthlyProfit').migrateLegacyProfit({apply});
 fs.writeFileSync(path.join(dir,(apply?'applied':'preview')+'.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 if(result.some(r=>r.error))process.exitCode=1;
}
main().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>M.sequelize.close());
