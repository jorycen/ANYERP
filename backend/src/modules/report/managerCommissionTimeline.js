// Chronological commission stages consume the same frozen sales-side events
// as the company/store profit report. No prices or tax rules are recalculated.
const {Op}=require('sequelize');
const M=require('../../models');
const C=require('./commissionConfig');
const {money}=require('./employeeCommission');
const commissionDates=require('./commissionDates');
const day=value=>value instanceof Date?new Date(value.getTime()+28800000).toISOString().slice(0,10):String(value||'').slice(0,10);
const known=value=>value!==null&&value!==undefined&&Number.isFinite(Number(value));
const validLine=value=>known(value)&&String(value).trim()!==''&&Number(value)>=0;
function timeKey(event,value){
  const text=value instanceof Date?new Date(value.getTime()+28800000).toISOString():String(value||'');
  return `${event.businessDate} ${text.slice(11,23)||'00:00:00'}`;
}
function buildTimeline(events,line){
  let cumulative=0;
  const entries=[],saleStages=new Map();
  for(const event of [...events].sort((a,b)=>String(a.time).localeCompare(String(b.time))||
    (a.entryType==='sale'?0:1)-(b.entryType==='sale'?0:1)||a.eventKey.localeCompare(b.eventKey))){
    const before=cumulative,amount=known(event.amount)?Number(event.amount):null;
    let reason=event.reason||'',fraction=null;
    if(!validLine(line))reason='门店盈亏平衡线未配置';
    else if(amount===null)reason='门店销售端毛利待核算';
    else if(amount===0)fraction=0;
    else if(before!==null){
      const after=money(before+amount),upper=money(Math.max(0,after-Number(line))-Math.max(0,before-Number(line)));
      fraction=upper/amount;
    }else reason='此前门店销售端毛利待核算，无法确定提成阶段';
    const allocations=(event.allocations||[]).map(row=>{
      const high=fraction===null||reason?null:money(Number(row.grossProfit)*fraction);
      return {...row,low:high===null?null:money(Number(row.grossProfit)-high),high};
    });
    if(amount===null||event.reason==='销售流水发生时间缺失')cumulative=null;
    else if(cumulative!==null)cumulative=money(cumulative+amount);
    if(event.entryType==='sale')saleStages.set(String(event.orderId),{fraction:reason?null:fraction,eventKey:event.eventKey,reason,line});
    entries.push({...event,reason,fraction:reason?null:fraction,line,before,after:cumulative,allocations});
  }
  return {entries,saleStages,cumulative};
}
async function eventFacts(events,storeIds){
  const returnIds=events.filter(e=>e.entryType==='return').map(e=>e.eventKey.slice('return:'.length));
  const adjustmentIds=events.filter(e=>e.entryType==='performance_adjustment').map(e=>e.eventKey.slice('performance:'.length));
  const rewardIds=events.filter(e=>e.entryType==='reward_redemption').map(e=>e.eventKey.slice('reward:'.length));
  const [returnLedgers,adjustments,rewards]=await Promise.all([
    returnIds.length?M.SalesReturnGrossProfitLedger.findAll({where:{return_id:{[Op.in]:returnIds}},attributes:['return_id','create_time'],raw:true}):[],
    adjustmentIds.length?M.PerformanceProfitAdjustment.findAll({where:{adjustment_id:{[Op.in]:adjustmentIds}},raw:true}):[],
    rewardIds.length?M.sequelize.query('SELECT id,staff_id,created_at FROM T_REWARD_REDEMPTION WHERE id IN (:ids) AND store_id IN (:storeIds)',{replacements:{ids:rewardIds,storeIds},type:M.sequelize.QueryTypes.SELECT}):[]
  ]);
  const orderIds=[...new Set([...events.map(e=>e.orderId),...adjustments.map(a=>a.order_id)].filter(Boolean).map(String))];
  const orders=orderIds.length?await M.Order.findAll({where:{order_id:{[Op.in]:orderIds}},attributes:['order_id','store_id','create_time','archive_time'],raw:true}):[];
  const orderMap=new Map(orders.map(o=>[String(o.order_id),o]));
  const normalized=events.map(event=>{
    const order=orderMap.get(String(event.orderId)),id=event.eventKey.split(':').at(-1);
    let timestamp,reason='';
    if(event.entryType==='sale'){
      timestamp=order?commissionDates.saleTime(order):null;
    }else if(event.entryType==='return'){
      timestamp=returnLedgers.filter(r=>String(r.return_id)===id&&r.create_time&&Number.isFinite(new Date(r.create_time).getTime())).sort((a,b)=>new Date(a.create_time)-new Date(b.create_time))[0]?.create_time;
    }else if(event.entryType==='performance_adjustment'){
      const adjustment=adjustments.find(a=>String(a.adjustment_id)===id);
      timestamp=adjustment?commissionDates.adjustmentTime(adjustment):null;
    }else if(event.entryType==='reward_redemption'){
      const reward=rewards.find(r=>String(r.id)===id);timestamp=reward?.created_at;
    }
    if(Number(event.salesGrossProfit)!==0&&!timestamp)reason=reason||'销售流水发生时间缺失';
    const adjustment=adjustments.find(a=>String(a.adjustment_id)===id),origin=order||orderMap.get(String(adjustment?.order_id));
    const originalTime=origin?commissionDates.saleTime(origin):null;
    // Posting date determines the commission month/stage. Store entitlement
    // retains the original business-time owner, including legacy returned
    // orders whose archive field was not retained. Never substitute a current owner.
    return {...event,amount:event.salesGrossProfit,time:timeKey(event,timestamp),reason,ownershipTime:origin?.create_time||(['return','performance_adjustment'].includes(event.entryType)?null:timestamp),ownershipStoreId:origin?.store_id||event.storeId,sourceOrderId:origin?.order_id||event.orderId,originalDate:originalTime?day(originalTime):null,originalMonth:originalTime?day(originalTime).slice(0,7):null};
  });
  return normalized;
}
function createLoader({user,stores}){
  const cache=new Map(),snapshots=new Map();
  async function month(monthKey,knownConfigs,scopeStoreId,throughDate){
    const key=`${monthKey}:${scopeStoreId||'*'}:${throughDate||'full'}`;
    if(cache.has(key))return cache.get(key);
    const promise=(async()=>{
      const scope=scopeStoreId?stores.filter(s=>String(s.store_id)===String(scopeStoreId)):stores;
      const configs=await (knownConfigs||C.options(user,monthKey));
      const lineFor=store=>configs.stores.find(s=>String(s.storeId)===String(store.store_id))?.breakEvenLine;
      const result=new Map(scope.filter(s=>!validLine(lineFor(s))).map(s=>[String(s.store_id),{entries:[],saleStages:new Map(),reason:`${monthKey}门店盈亏平衡线未配置`}]));
      const usable=scope.filter(s=>validLine(lineFor(s))),ids=usable.map(s=>String(s.store_id));
      if(!ids.length)return result;
      const endDate=throughDate||new Date(Date.UTC(Number(monthKey.slice(0,4)),Number(monthKey.slice(5)),0)).toISOString().slice(0,10);
      const financial=(!throughDate&&snapshots.get(monthKey))||await require('./financialProfitController').queryFinancialProfit({storeIds:ids,startDate:`${monthKey}-01`,endDate,includeStores:true,salesStageOnly:true});
      const events=await eventFacts((financial.profitDetails||[]).filter(e=>ids.includes(String(e.storeId))),ids);
      for(const store of usable){
        const selected=events.filter(e=>String(e.storeId)===String(store.store_id));
        const line=configs.stores.find(s=>String(s.storeId)===String(store.store_id))?.breakEvenLine;
        result.set(String(store.store_id),buildTimeline(selected,line));
      }
      return result;
    })();
    cache.set(key,promise);return promise;
  }
  async function forStaff({period,storeId,staffId,configs,performanceDetails=[]}){
    const context=(await month(period.month,configs)).get(String(storeId));
    let low=0,high=0,reason='';const details=[],issues=[];
    const addIssue=(message,share,extra={})=>{reason=reason||message;issues.push({reason:message,month:period.month,orderId:share?.orderId,orderNo:share?.orderNo,sourceOrderId:share?.sourceOrderId,sourceOrderNo:share?.sourceOrderNo,returnId:share?.returnId,...extra});};
    for(const share of performanceDetails.filter(row=>String(row.staffId)===String(staffId))){
      const actualStoreId=String(share.storeId||storeId);
      const actualContext=actualStoreId===String(storeId)?context:(await month(period.month,configs,actualStoreId)).get(actualStoreId);
      const gross=share.allocatedGrossProfit;
      if(!known(gross)){addIssue('个人冻结毛利不完整',share);continue;}
      let event;
      const currentReturn=share.sourceEntryType==='return'||share.sourceEntryType==='return_adjustment';
      if(share.sourceEntryType==='return')event=actualContext?.entries.find(e=>e.eventKey===`return:${share.returnId}`);
      else if(currentReturn&&share.sourceEntryType==='return_adjustment')event=actualContext?.entries.find(e=>e.eventKey===`performance:${String(share.orderId).replace(/^return-adjustment:/,'')}`);
      else if(share.sourceEntryType==='reward_redemption')event=actualContext?.entries.find(e=>e.eventKey===share.orderId);
      else if(share.sourceEntryType==='sale')event=actualContext?.entries.find(e=>e.entryType==='sale'&&String(e.orderId)===String(share.orderId));
      // All approved differences use the approval month's stage, not the source sale's.
      const originalId=String(share.sourceOrderId||share.orderId);
      let stage=event?{fraction:event.fraction}:currentReturn?null:actualContext?.saleStages.get(originalId);
      if(!stage&&Number(gross)!==0&&!currentReturn){
        const original=await M.Order.findByPk(originalId,{raw:true});
        const originStoreId=String(original?.store_id||actualStoreId);
        const originalTime=original?commissionDates.saleTime(original):null;
        const originalMonth=originalTime?day(originalTime).slice(0,7):null;
        if(originalMonth){
          try{
            const originalContext=(await month(originalMonth,undefined,originStoreId,day(originalTime))).get(originStoreId);
            stage=originalContext?.saleStages.get(originalId);
            if(!stage&&originalContext?.reason)stage={fraction:null,reason:originalContext.reason};
            event=originalContext?.entries.find(e=>e.entryType==='sale'&&String(e.orderId)===originalId);
          }catch(error){if(error.status!==409)throw error;addIssue(`${share.orderNo}：原销售月份依据待核实：${error.message}`,share,{originalMonth});}
        }
      }
      const fraction=Number(gross)===0?0:stage?.fraction;
      if(!known(fraction)){
        addIssue(`${share.orderNo}：${event?.reason||stage?.reason||actualContext?.reason||(currentReturn?'退货当月毛利流水或阶段依据不完整':'原订单提成阶段未能追溯')}`,share,{basisMonth:currentReturn?period.month:undefined,originalMonth:event?.originalMonth,originalStoreId:actualStoreId});
        for(const prior of actualContext?.entries||[])if(prior.amount===null&&(!event||prior.time<=event.time))addIssue(`${prior.entryNo||prior.eventKey}：门店销售端毛利待核算，影响后续跨线判断`,null,{orderId:prior.orderId,orderNo:prior.entryNo,sourceOrderId:prior.orderId,sourceOrderNo:prior.orderNo,originalStoreId:actualStoreId});
        continue;
      }
      const upper=money(Number(gross)*fraction),lower=money(Number(gross)-upper);
      low=money(low+lower);high=money(high+upper);
      details.push({eventKey:share.orderId,orderNo:share.orderNo,sourceOrderNo:share.sourceOrderNo,storeId:actualStoreId,businessDate:day(share.orderTime),time:share.orderTime,
        breakEvenLine:event?.line??stage?.line??null,storeGrossBefore:event?.before??null,storeGrossAfter:event?.after??null,grossProfit:gross,lowGrossProfit:lower,highGrossProfit:upper});
    }
    return {lowGrossProfit:reason?null:low,highGrossProfit:reason?null:high,reason,details,issues};
  }
  return {forStaff,seed:(monthKey,financial)=>snapshots.set(monthKey,financial)};
}
function netStages(stages,grossProfit,deduction,mode){
  const result={...stages,lowNetGrossProfit:null,highNetGrossProfit:null,lowDeduction:null,highDeduction:null};
  if(stages.reason)return result;
  if(!known(grossProfit)||!known(deduction)||!known(stages.lowGrossProfit)||!known(stages.highGrossProfit)||
    money(stages.lowGrossProfit+stages.highGrossProfit)!==money(grossProfit))return {...result,reason:'个人毛利与分阶段冻结流水不一致，需核对统计日期或分摊依据'};
  let lowDeduction=0;
  if(Number(deduction)!==0){
    if(mode==='low')lowDeduction=Number(deduction);
    else if(mode==='proportional'&&stages.lowGrossProfit>=0&&stages.highGrossProfit>=0&&Number(grossProfit)>0)
      lowDeduction=money(Number(deduction)*stages.lowGrossProfit/Number(grossProfit));
    else return {...result,reason:'费用扣减的提成阶段依据待确认'};
  }
  const highDeduction=money(Number(deduction)-lowDeduction);
  return {...result,lowDeduction,highDeduction,lowNetGrossProfit:money(stages.lowGrossProfit-lowDeduction),highNetGrossProfit:money(stages.highGrossProfit-highDeduction)};
}
module.exports={buildTimeline,eventFacts,createLoader,netStages};
