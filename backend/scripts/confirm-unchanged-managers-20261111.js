const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const M=require('../src/models'),H=require('../src/modules/report/storeManagerHistory');
const from='2026-10-01T00:00:00+08:00',batch='UNCHANGED-MANAGERS-20261111-OCT01';
const dir=path.resolve(__dirname,'../backup/order-corrections',batch);
(async()=>{
 const history=await H.Assignment.findAll({raw:true}),stores=await M.Store.findAll({where:{is_deleted:0,status:1},raw:true});
 const plans=stores.filter(s=>s.manager_staff_id&&!String(s.name).includes('自营仓')).map(store=>{
  const initial=history.filter(h=>String(h.store_id)===String(store.store_id)&&h.evidence.startsWith('系统首次记录当前店长')).sort((a,b)=>new Date(a.effective_from)-new Date(b.effective_from))[0];
  assert.ok(initial,store.name+'缺少首次记录');assert.equal(String(initial.staff_id),String(store.manager_staff_id));
  return {storeId:store.store_id,storeName:store.name,staffId:String(initial.staff_id),from,to:initial.effective_from};
 });
 if(!process.argv.includes('--apply')){console.log(JSON.stringify({plans}));return;}
 fs.mkdirSync(dir,{recursive:true});const backup=path.join(dir,'before.json');
 if(!fs.existsSync(backup))fs.writeFileSync(backup,JSON.stringify({history,stores,plans},null,2),{flag:'wx'});
 await M.sequelize.transaction(async transaction=>{
  for(const p of plans){
   const store=await M.Store.findByPk(p.storeId,{transaction,lock:transaction.LOCK.UPDATE});assert.equal(String(store.manager_staff_id),p.staffId);
   await H.confirm({...p,evidence:'用户于2026-11-11本会话确认：10月1日至系统首次记录期间未更换店长，按当前同一人覆盖。批次'+batch,user:{name:'用户确认历史任职（本会话）'},transaction});
  }
 });
 const after=await H.Assignment.findAll({raw:true});
 for(const p of plans){const old=H.resolve(after,p.storeId,new Date(p.from));assert.equal(String(old?.staff_id),p.staffId);const end=H.resolve(after,p.storeId,new Date(new Date(p.to).getTime()-1));assert.equal(String(end?.staff_id),p.staffId);}
 for(const old of history)assert.deepEqual(after.find(h=>h.id===old.id),old);
 fs.writeFileSync(path.join(dir,'verified.json'),JSON.stringify({plans,history:after},null,2));
 console.log(JSON.stringify({verified:true,stores:plans.length,from,backup:dir}));
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(()=>M.sequelize.close());
