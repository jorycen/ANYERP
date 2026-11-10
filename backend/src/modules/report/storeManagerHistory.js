const {DataTypes}=require('sequelize');
const M=require('../../models');
const {generateUUID}=require('../../utils');
const {recordBusinessAction}=require('../../utils/businessActionLog');
const Assignment=M.sequelize.define('StoreManagerAssignment',{
 id:{type:DataTypes.STRING(32),primaryKey:true},store_id:{type:DataTypes.STRING(32),allowNull:false},
 staff_id:{type:DataTypes.BIGINT,allowNull:true},effective_from:{type:DataTypes.DATE,allowNull:false},effective_to:{type:DataTypes.DATE,allowNull:true},
 evidence:{type:DataTypes.TEXT,allowNull:false},created_at:{type:DataTypes.DATE,allowNull:false,defaultValue:DataTypes.NOW}
},{tableName:'T_STORE_MANAGER_ASSIGNMENT',timestamps:false,indexes:[{fields:['store_id','effective_from']}]});
const ms=value=>new Date(value).getTime();
function resolve(rows,storeId,time){
 if(!time||!Number.isFinite(ms(time)))return null;
 const found=rows.filter(r=>String(r.store_id)===String(storeId)&&ms(r.effective_from)<=ms(time)&&(!r.effective_to||ms(time)<ms(r.effective_to)));
 return found.length===1?found[0]:null;
}
async function confirm({storeId,staffId,from,to,evidence,user,transaction}){
 if(!from||!to||!Number.isFinite(ms(from))||!Number.isFinite(ms(to))||ms(to)<=ms(from)||!String(evidence||'').trim())throw Object.assign(new Error('店长任职需要有效起止时间及依据，结束时间不包含在任期内'),{status:400});
 const store=await M.Store.findByPk(storeId,{transaction,lock:transaction.LOCK.UPDATE});if(!store)throw Object.assign(new Error('门店不存在'),{status:404});
 const staff=await M.Staff.findByPk(staffId,{transaction});
 if(!staff||String(staff.distributor_id)!==String(store.distributor_id))throw Object.assign(new Error('任职店长必须属于原门店经销商'),{status:400});
 const rows=await Assignment.findAll({where:{store_id:storeId},transaction,lock:transaction.LOCK.UPDATE,raw:true});
 const same=rows.find(r=>ms(r.effective_from)===ms(from)&&ms(r.effective_to)===ms(to)&&String(r.staff_id)===String(staffId));if(same)return same;
 if(rows.some(r=>ms(r.effective_from)<ms(to)&&(!r.effective_to||ms(r.effective_to)>ms(from))))throw Object.assign(new Error('确认任期与已有任职记录重叠'),{status:409});
 const record=await Assignment.create({id:generateUUID(),store_id:storeId,staff_id:staffId,effective_from:new Date(from),effective_to:new Date(to),evidence},{transaction});
 await recordBusinessAction({businessType:'store_manager_history',businessId:record.id,action:'confirm',user,detail:record.toJSON(),transaction});return record;
}
async function updateStore(store,values,user){
 return M.sequelize.transaction(async transaction=>{
  const locked=await M.Store.findByPk(store.store_id,{transaction,lock:transaction.LOCK.UPDATE});
  const before=locked.manager_staff_id,after=values.manager_staff_id,now=new Date();
  await locked.update(values,{transaction});
  if(after!==undefined&&String(before||'')!==String(after||'')){
   const rows=await Assignment.findAll({where:{store_id:store.store_id},transaction,lock:transaction.LOCK.UPDATE});
   for(const row of rows)if(!row.effective_to&&ms(row.effective_from)<=now.getTime())await row.update({effective_to:now},{transaction});
   if(rows.some(r=>ms(r.effective_from)>now.getTime()))throw Object.assign(new Error('已有未来店长任期，请先核实'),{status:409});
   await Assignment.create({id:generateUUID(),store_id:store.store_id,staff_id:after||null,effective_from:now,effective_to:null,evidence:'门店店长变更，生效时间为本次保存时间'},{transaction});
   await recordBusinessAction({businessType:'store_manager_history',businessId:store.store_id,action:'change',user,detail:{before,after,effectiveFrom:now},transaction});
  }
  store.set(locked.toJSON());return store;
 });
}
async function initialize(){
 await Assignment.sync();
 // Capture only the observed present, never backdate a current manager.
 const stores=await M.Store.findAll({where:{is_deleted:0,status:1},attributes:['store_id'],raw:true});
 for(const store of stores)await M.sequelize.transaction(async transaction=>{
  const locked=await M.Store.findByPk(store.store_id,{transaction,lock:transaction.LOCK.UPDATE});
  if(!locked.manager_staff_id)return; // An unset current field is not proof of no historical manager.
  if(await Assignment.count({where:{store_id:store.store_id},transaction}))return;
  await Assignment.create({id:generateUUID(),store_id:store.store_id,staff_id:locked.manager_staff_id||null,effective_from:new Date(),effective_to:null,evidence:'系统首次记录当前店长，仅证明记录时刻及以后，不证明历史任职'},{transaction});
 });
}
async function createStore(values){return M.sequelize.transaction(async transaction=>{
 const store=await M.Store.create(values,{transaction});
 if(store.manager_staff_id)await Assignment.create({id:generateUUID(),store_id:store.store_id,staff_id:store.manager_staff_id,effective_from:new Date(),effective_to:null,evidence:'新建门店时指定的店长'},{transaction});return store;
});}
module.exports={Assignment,resolve,confirm,updateStore,initialize,createStore};
