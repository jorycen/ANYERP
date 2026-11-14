const fs=require('node:fs'),path=require('node:path'),a=require('node:assert/strict');
const M=require('../src/models'),H=require('../src/modules/report/storeManagerHistory');
const {isProductWarehouse}=require('../src/modules/report/profitAttribution');
const batch='UNCHANGED-MANAGERS-20261111-SEP01',from=new Date('2026-09-01T00:00:00+08:00'),to=new Date();
const dir=path.resolve(__dirname,'../backup/order-corrections',batch),plain=x=>JSON.parse(JSON.stringify(x));
function gaps(store,history){
 const end=to.getTime();let cursor=from.getTime();const missing=[];
 const rows=history.filter(h=>String(h.store_id)===String(store.store_id)&&new Date(h.effective_from).getTime()<end&&(!h.effective_to||new Date(h.effective_to).getTime()>cursor)).sort((a,b)=>new Date(a.effective_from)-new Date(b.effective_from));
 for(const h of rows){
  a.equal(String(h.staff_id),String(store.manager_staff_id),store.name+'存在不同店长，停止自动处理');
  const start=new Date(h.effective_from).getTime(),finish=h.effective_to?new Date(h.effective_to).getTime():end;
  if(start>cursor)missing.push({from:new Date(cursor).toISOString(),to:new Date(Math.min(start,end)).toISOString()});
  cursor=Math.max(cursor,finish);if(cursor>=end)break;
 }
 if(cursor<end)missing.push({from:new Date(cursor).toISOString(),to:to.toISOString()});
 return missing.map(r=>({...r,storeId:store.store_id,storeName:store.name,staffId:String(store.manager_staff_id)}));
}
(async()=>{
 const history=await H.Assignment.findAll({raw:true}),stores=(await M.Store.findAll({where:{is_deleted:0,status:1},raw:true})).filter(s=>s.manager_staff_id&&!isProductWarehouse(s.store_id)),plans=stores.flatMap(s=>gaps(s,history));
 console.log(JSON.stringify({coveredStores:stores.length,insertCount:plans.length,plans}));
 if(!process.argv.includes('--apply'))return;
 fs.mkdirSync(dir,{recursive:true});const backup=path.join(dir,'before.json');
 a(!fs.existsSync(backup),'已存在执行备份，请勿重复运行');
 fs.writeFileSync(backup,JSON.stringify({batch,from,to,history,stores,plans},null,2),{flag:'wx'});
 await M.sequelize.transaction(async transaction=>{
  for(const store of stores){
   const locked=await M.Store.findByPk(store.store_id,{transaction,lock:transaction.LOCK.UPDATE});a.equal(String(locked.manager_staff_id),String(store.manager_staff_id),'当前店长已变化');
   const latest=await H.Assignment.findAll({where:{store_id:store.store_id},raw:true,transaction,lock:transaction.LOCK.UPDATE});
   a.deepEqual(plain(latest).sort((a,b)=>a.id.localeCompare(b.id)),plain(history.filter(h=>h.store_id===store.store_id)).sort((a,b)=>a.id.localeCompare(b.id)),'任期已变化');
  }
  for(const p of plans)await H.confirm({...p,evidence:'用户于2026-11-11本会话明确确认：2026-09-01至今经营门店店长未变，按当前对应同一人覆盖；仅补任期空缺。批次'+batch,user:{name:'用户确认历史任职（本会话）'},transaction});
 });
 const after=await H.Assignment.findAll({raw:true});
 for(const old of history)a.deepEqual(plain(after.find(h=>h.id===old.id)),plain(old),'原任期被修改');
 for(const store of stores)a.equal(gaps(store,after).length,0,store.name+'仍有缺口');
 for(const p of plans){a.equal(String(H.resolve(after,p.storeId,p.from)?.staff_id),p.staffId);a.equal(String(H.resolve(after,p.storeId,new Date(new Date(p.to).getTime()-1))?.staff_id),p.staffId);}
 fs.writeFileSync(path.join(dir,'verified.json'),JSON.stringify({batch,plans,history:after,coveredStores:stores.length},null,2));
 console.log(JSON.stringify({verified:true,inserted:plans.length,coveredStores:stores.length,from:'2026-09-01 00:00:00+08:00',through:to.toISOString()}));
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(()=>M.sequelize.close());
