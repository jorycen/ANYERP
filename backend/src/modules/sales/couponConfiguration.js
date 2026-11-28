// Configuration only. All money calculations remain in couponPricing.
const parse=value=>typeof value==='string'?JSON.parse(value):value;
const bundle=value=>parse(value)?.version===2;
const paymentName=(parent,plan)=>plan.legacyName || `${parent.name}｜${plan.name}`;
function allPlans(config) {
  return [...(config.global||[]).map(plan=>({scope:'*',plan})),...Object.entries(config.stores||{}).flatMap(([scope,plans])=>plans.map(plan=>({scope,plan})))];
}
function options(method,storeId,{includeInactive=false}={}) {
  const config=parse(method.coupon_rule);
  if(!bundle(config)) return [method];
  const plans=Number(method.is_global)?config.global:config.stores?.[String(storeId)];
  return (plans||[]).filter(p=>includeInactive||p.status===1).map(plan=>({...method,method_id:`${method.method_id}:${plan.id}`,status:Number(method.status)===1?plan.status:0,name:paymentName(method,plan),code:paymentName(method,plan),coupon_rule:plan.rule,scheme_id:plan.id,parent_method_id:method.method_id}));
}
function entry(method) {
  const rule = require('./couponPricing').normalizeRule(method.coupon_rule);
  if (!rule) {
    const group = ['商场优惠券','抖音减满券','抖音优惠券'].includes(method.name) ? (method.name === '抖音优惠券' ? '抖音减满券' : method.name) : null;
    return {...method,coupon_entry:group ? {group,label:'未配置方案',amount:null,available:false,reason:'请先配置优惠券方案'} : null};
  }
  return {...method,coupon_entry:{group:rule.kind==='douyin'?'抖音减满券':'商场优惠券',
    label:method.scheme_label || method.name,amount:rule.faceAmount > 0 ? rule.faceAmount : null,
    available:rule.faceAmount > 0,reason:rule.faceAmount > 0 ? '' : '此方案未配置固定抵扣面额，请先完善方案配置'}};
}
async function normalize(ctx,existing, {transaction} = {}) {
  const M=require('../../models'),{Op}=require('sequelize'),pricing=require('./couponPricing');
  const {canAccessDistributor}=require('../../utils/distributorScope');
  const input=parse(ctx.request.body.couponRule),isGlobal=!!ctx.request.body.isGlobal;
  if(!bundle(input))return null;
  if(!ctx.state.user.roles?.some(r=>['admin','boss'].includes(r)))ctx.throw(403,'仅配置管理员可管理优惠券');
  const name=String(ctx.request.body.name??existing?.name??'').trim();
  if(!name || name.length>30)ctx.throw(400,'优惠券收款名称须为1至30字');
  const configs=ctx.request.body.storeConfigs || [];
  const storeIds=[...new Set(configs.map(r=>String(r.storeId)))];
  if(!isGlobal && !storeIds.length)ctx.throw(400,'请先勾选适用门店');
  const stores=storeIds.length?await M.Store.findAll({where:{store_id:{[Op.in]:storeIds}}}):[];
  if(stores.length!==storeIds.length||stores.some(s=>!canAccessDistributor(ctx.state.user,s.distributor_id)))ctx.throw(403,'存在无权配置的门店');
  const oldConfig=existing?.coupon_rule?parse(existing.coupon_rule):null;
  const oldPlans=oldConfig&&bundle(oldConfig)?allPlans(oldConfig):[];
  const normalizePlans=(plans)=>{
    if(!Array.isArray(plans)||!plans.length||plans.length>50)ctx.throw(400,'每个适用范围须配置1至50个券方案');
    const names=new Set(),ids=new Set();
    return plans.map(p=>{
      const planName=String(p.name||'').trim();
      if(!planName||paymentName({name},{name:planName}).length>50||names.has(planName))ctx.throw(400,'券方案名称不能为空、不能重名，收款名称与方案名合计最多49字');
      names.add(planName);const id=p.id||require('crypto').randomUUID().replace(/-/g,'');
      if(ids.has(id))ctx.throw(400,'券方案标识重复');ids.add(id);
      const legacy=oldPlans.find(item=>item.plan.id===id)?.plan.legacyName || (oldConfig&&!bundle(oldConfig)&&id==='legacy'?existing.name:null);
      return {id,...(legacy?{legacyName:legacy}:{}),name:planName,status:p.status===0?0:1,rule:pricing.normalizeRule({...p.rule,kind:input.kind})};
    });
  };
  const result={version:2,kind:input.kind,global:isGlobal?normalizePlans(input.global):[],stores:{}};
  if(!isGlobal)for(const id of storeIds)result.stores[id]=normalizePlans(input.stores?.[id]);
  for(const {scope,plan} of allPlans(result)) {
    const candidate=paymentName({name},plan);
    const collision=await M.PaymentMethod.findOne({where:{[Op.or]:[{name:candidate},{code:candidate}],...(existing?{method_id:{[Op.ne]:existing.method_id}}:{})},transaction});
    if(collision)ctx.throw(400,'券方案的销售名称与已有收款方式冲突，请更换方案名称');

    const ids=[...new Set([plan.rule.mallAccountId,plan.rule.platformAccountId].filter(Boolean))];
    const accounts=ids.length?await M.SettlementAccount.findAll({where:{account_id:{[Op.in]:ids},status:1}}):[];
    if(accounts.length!==ids.length||accounts.some(a=>a.account_type!=='FUND'||(a.distributor_id&&!canAccessDistributor(ctx.state.user,a.distributor_id))))ctx.throw(400,'返款账户不可用或不在权限范围');
    const target=stores.find(s=>String(s.store_id)===scope);
    if(target && accounts.some(a=>a.distributor_id&&String(a.distributor_id)!==String(target.distributor_id)))ctx.throw(400,'门店券返款账户经销商不一致');
  }
  if(existing?.coupon_rule){
    const old=parse(existing.coupon_rule);
    const bindings=!bundle(old)&&!Number(existing.is_global)?await M.PaymentMethodStore.findAll({where:{method_id:existing.method_id},transaction}):[];
    const previous=bundle(old)?allPlans(old):(Number(existing.is_global)?['*']:bindings.map(b=>String(b.store_id))).map(scope=>({scope,plan:{id:'legacy',name:'原方案',legacyName:existing.name,rule:old}}));
    for(const {scope,plan} of previous){
      const oldName=paymentName(existing,plan);
      const next=allPlans(result).find(p=>p.scope===scope&&p.plan.name===plan.name&&paymentName({name},p.plan)===oldName);
      if(name===existing.name&&next)continue;
      const used=await M.OrderPayment.count({transaction,where:{payment_method:oldName},...(scope==='*'?{}:{include:[{model:M.Order,required:true,attributes:[],where:{store_id:scope}}]})});
      if(used)ctx.throw(400,'已使用的方案不能删除、改名或移动范围，请保留原方案并停用，再新增目标方案');
    }
  }
  return result;
}
module.exports={bundle,options,entry,allPlans,paymentName,normalize};
