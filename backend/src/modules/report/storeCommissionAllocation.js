const {Op}=require('sequelize');
const M=require('../../models'),H=require('./storeManagerHistory');
const {eventFacts}=require('./managerCommissionTimeline');
const {money}=require('./employeeCommission');
const {isProductWarehouse}=require('./profitAttribution');
function allocate(events,history,people,period){
 const owners=new Map(),missing=new Map();
 const byStore=new Map();for(const row of history){const key=String(row.store_id);if(!byStore.has(key))byStore.set(key,[]);byStore.get(key).push(row);}
 for(const event of events){
  if(isProductWarehouse(event.ownershipStoreId||event.storeId)||isProductWarehouse(event.storeId))continue;
  if(event.amount===0)continue;
  if(!event.ownershipTime||!Number.isFinite(new Date(event.ownershipTime).getTime())){
   missing.set(`time:${event.eventKey}`,{storeId:String(event.ownershipStoreId||event.storeId),month:period.month,reason:'原业务发生时间未能追溯，历史店长归属待核实',orderNo:event.entryNo,sourceOrderNo:event.orderNo,sourceOrderId:event.sourceOrderId||event.orderId});continue;
  }
  const storeId=String(event.ownershipStoreId||event.storeId),storeHistory=byStore.get(storeId)||[],assignment=H.resolve(storeHistory,storeId,event.ownershipTime);
  if(assignment&&!assignment.staff_id)continue;
  if(!assignment?.staff_id){
   const sourceMonth=event.ownershipTime instanceof Date?new Date(event.ownershipTime.getTime()+28800000).toISOString().slice(0,7):String(event.ownershipTime||period.month).slice(0,7);
   const monthStart=new Date(`${sourceMonth}-01T00:00:00+08:00`).getTime(),monthEnd=new Date(new Date(Date.UTC(Number(sourceMonth.slice(0,4)),Number(sourceMonth.slice(5)),1)).toISOString().slice(0,10)+'T00:00:00+08:00').getTime(),time=new Date(event.ownershipTime).getTime();
   const same=storeHistory;
   const from=new Date(Math.max(monthStart,...same.filter(h=>h.effective_to&&new Date(h.effective_to).getTime()<=time).map(h=>new Date(h.effective_to).getTime()))).toISOString();
   const to=new Date(Math.min(monthEnd,...same.filter(h=>new Date(h.effective_from).getTime()>time).map(h=>new Date(h.effective_from).getTime()))).toISOString();
   const key=`${storeId}:${from}:${to}`,group=missing.get(key)||{storeId,month:period.month,originalMonth:sourceMonth,reason:'业务发生时的店长任职依据未确认',from,to};
   missing.set(key,group);continue;
  }
  const staffId=String(assignment.staff_id),person=people.find(p=>String(p.staff_id)===staffId);
  const owner=owners.get(staffId)||{staffId,commission:0,grossProfit:0,storeIds:[],issues:[],pools:new Map()};
  const pool=owner.pools.get(storeId)||{gross:0,pending:false};
  if(event.amount==null){pool.pending=true;owner.issues.push({month:period.month,originalStoreId:storeId,reason:'原门店销售端毛利依据待核实',orderNo:event.entryNo,sourceOrderNo:event.orderNo,sourceOrderId:event.sourceOrderId||event.orderId});}else pool.gross=money(pool.gross+Number(event.amount));
  owner.pools.set(storeId,pool);if(!owner.storeIds.includes(storeId))owner.storeIds.push(storeId);
  if(!person)owner.issues.push({month:period.month,originalStoreId:storeId,reason:'历史店长员工档案未能定位'});
  owners.set(staffId,owner);
 }
 for(const owner of owners.values()){
  const person=people.find(p=>String(p.staff_id)===owner.staffId),staffRule=['卢珏','葛宇'].includes(person?.name);
  if(!person)owner.commission=null;
  for(const [storeId,pool]of owner.pools){
   if(pool.pending){owner.commission=null;owner.grossProfit=null;owner.issues.push({month:period.month,originalStoreId:storeId,reason:'原门店销售端毛利依据待核实'});}
   else {if(owner.grossProfit!==null)owner.grossProfit=money(owner.grossProfit+pool.gross);if(owner.commission!==null)owner.commission=money(owner.commission+(staffRule?0:money(pool.gross*(['石高铭','唐陈'].includes(person?.name)?.05:.03))));}
  }
  delete owner.pools;
 }
 return {owners,missing:[...missing.values()]};
}
async function load(financial,stores,period){
 const events=await eventFacts(financial.profitDetails||[],stores.map(s=>String(s.store_id)));
 const history=await H.Assignment.findAll({where:{store_id:{[Op.in]:stores.map(s=>s.store_id)}},raw:true});
 const staffIds=[...new Set(history.map(h=>h.staff_id).filter(Boolean))];
 const people=staffIds.length?await M.Staff.findAll({where:{staff_id:{[Op.in]:staffIds}},raw:true}):[];
 const result=allocate(events,history,people,period);
 return {...result,people:people.filter(p=>result.owners.has(String(p.staff_id)))};
}
module.exports={allocate,load};
