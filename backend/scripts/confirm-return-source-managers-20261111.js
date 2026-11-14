const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const M=require('../src/models'),H=require('../src/modules/report/storeManagerHistory');
const targets=[['D0214268','2026-06'],['D0215790','2026-09'],['D0214832','2026-09'],['D0218911','2026-09'],['D0215327','2026-09'],['D0218191','2026-09'],['D0218262','2026-09']];
const batch='RETURN-SOURCE-MANAGERS-20261111-JUN-SEP',dir=path.resolve(__dirname,'../backup/order-corrections',batch);
(async()=>{
 const history=await H.Assignment.findAll({raw:true}),plans=[];
 for(const [storeId,month]of targets){
  const store=await M.Store.findByPk(storeId,{raw:true});assert.ok(store);assert.ok(!store.name.includes('自营仓'));
  const prior=H.resolve(history,storeId,'2026-10-01T00:00:00+08:00');assert.equal(String(prior?.staff_id),String(store.manager_staff_id));
  const next=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),1)).toISOString().slice(0,10);
  plans.push({storeId,storeName:store.name,staffId:String(prior.staff_id),from:month+'-01T00:00:00+08:00',to:next+'T00:00:00+08:00'});
 }
 if(!process.argv.includes('--apply')){console.log(JSON.stringify({plans}));return;}
 fs.mkdirSync(dir,{recursive:true});const before=path.join(dir,'before.json');if(!fs.existsSync(before))fs.writeFileSync(before,JSON.stringify({history,plans},null,2),{flag:'wx'});
 await M.sequelize.transaction(async transaction=>{
  for(const p of plans){
   const store=await M.Store.findByPk(p.storeId,{transaction,lock:transaction.LOCK.UPDATE});assert.equal(String(store.manager_staff_id),p.staffId);
   await H.confirm({...p,user:{name:'用户确认原单月份店长（本会话）'},evidence:'用户于2026-11-11确认：财大6月及所列门店9月原销售发生时，均为当前对应同一店长。仅补指定月份，未扩展其他空缺月份。批次'+batch,transaction});
  }
 });
 const after=await H.Assignment.findAll({raw:true});
 for(const p of plans){assert.equal(String(H.resolve(after,p.storeId,p.from)?.staff_id),p.staffId);assert.equal(String(H.resolve(after,p.storeId,new Date(new Date(p.to).getTime()-1))?.staff_id),p.staffId);}
 for(const old of history)assert.deepEqual(after.find(h=>h.id===old.id),old);
 fs.writeFileSync(path.join(dir,'verified.json'),JSON.stringify({plans,history:after},null,2));
 console.log(JSON.stringify({verified:true,count:plans.length,plans,backup:dir}));
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(()=>M.sequelize.close());
