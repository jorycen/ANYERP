// Read-only: compare two rule versions against the SAME current database.
const cp=require('child_process'),fs=require('fs'),path=require('path'),Module=require('module');
const ref=process.argv[2]||'HEAD',root=path.resolve(__dirname,'../..'),base=path.resolve(root,'backend/src/modules/report'),read=Module._extensions['.js'];
Module._extensions['.js']=(m,file)=>{
 if(file.startsWith(base+path.sep)){
  let code;try{code=cp.execFileSync('git',['show',ref+':'+path.relative(root,file).replaceAll('\\','/')],{cwd:root,encoding:'utf8',stdio:['pipe','pipe','ignore']});}catch{}
  if(code!==undefined)return m._compile(code,file);
 }
 return read(m,file);
};
const M=require('../src/models'),R=require('../src/modules/report/employeeProfitSummary');
(async()=>{
 const query={startDate:'2026-10-01',endDate:'2026-10-31',reportRole:'all'},data=await R.load({staffId:1,roles:['boss'],accessibleStoreIds:['*']},query);
 const result={ref,query,panels:data.panels,rows:data.rows.filter(r=>r.sideName==='销售端').map(r=>({id:r.staffId,name:r.employeeName,store:r.storeName,storeId:r.storeId,rule:r.rule,gross:r.grossProfit,expense:r.expensePerformanceDeduction,net:r.netGrossProfit,personalCommission:r.salesCommission,storeGross:r.storeGrossProfit,storeCommission:r.storeCommission,total:r.performanceEstimate,status:r.status,issues:(r.issues||[]).map(x=>x.reason)}))};
 const dir=path.resolve(__dirname,'../backup/commission-rule-impact-20261111');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,ref+'.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({ref,panels:result.panels,count:result.rows.length}));
 if(process.argv.includes('--facts')){
  const D=require('../src/modules/report/dashboardDataSource').RealtimeSqlDashboardDataSource,B=require('../src/modules/report/dashboardService'),stores=await M.Store.findAll({where:{is_deleted:0,status:1},raw:true}),source=new D(),filters={storeIds:stores.filter(s=>!['D028000','D023000'].includes(s.store_id)).map(s=>s.store_id),archiveScope:'archived'},range=B.buildRanges(query).current;
  const [orders,adjustments]=await Promise.all([source.getEmployeeOrderRows(filters,range),source.getApprovedAdjustments(filters,range)]),performance=B.buildEmployeePerformance(orders,adjustments,'',true,{allDetails:true});
  fs.writeFileSync(path.join(dir,ref+'-facts.json'),JSON.stringify({details:performance.details,ranking:performance.ranking},null,2));
 }
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(()=>M.sequelize.close());
