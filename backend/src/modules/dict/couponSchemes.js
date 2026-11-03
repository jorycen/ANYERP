const M = require('../../models');
const { Op } = require('sequelize');
const { canAccessDistributor } = require('../../utils/distributorScope');
const pricing = require('../sales/couponPricing');
async function storeContext(ctx) {
  if (!ctx.state.user.roles?.some(r => ['admin','boss'].includes(r))) ctx.throw(403,'仅配置管理员可管理优惠券方案');
  const id=String(ctx.query.storeId || ctx.request.body?.storeId || '');
  if (!id) ctx.throw(400,'请先选择门店');
  const store=await M.Store.findByPk(id);
  if (!store || !canAccessDistributor(ctx.state.user,store.distributor_id)) ctx.throw(403,'无权管理该门店');
  return store;
}
async function owned(ctx, store) {
  const row=await M.PaymentMethod.findByPk(ctx.params.id,{include:[{model:M.PaymentMethodStore}]});
  if (!row?.coupon_rule) ctx.throw(404,'优惠券方案不存在');
  const configs=row.PaymentMethodStores || [];
  if (Number(row.is_global) || configs.length!==1 || String(configs[0].store_id)!==String(store.store_id)) ctx.throw(400,'历史共享方案不能在单店直接修改，请新建本店方案');
  return row;
}
async function list(ctx) {
  const store=await storeContext(ctx);
  const rows=await M.PaymentMethod.findAll({where:{coupon_rule:{[Op.ne]:null}},include:[{model:M.PaymentMethodStore}],order:[['sort_order','ASC']]});
  const list=rows.filter(r=>!require('../sales/couponConfiguration').bundle(r.coupon_rule)).filter(r=>Number(r.is_global)||(r.PaymentMethodStores||[]).some(c=>String(c.store_id)===String(store.store_id))).map(r=>{
    const data=r.toJSON(),rule=pricing.normalizeRule(data.coupon_rule);
    const shared=Number(r.is_global)===1 || r.PaymentMethodStores.length!==1;
    return {...data,coupon_rule:rule,shared,display_name:data.name.startsWith(store.name+'｜')?data.name.slice(store.name.length+1):data.name};
  });
  ctx.body={code:0,data:list};
}
async function save(ctx) {
  const store=await storeContext(ctx), input=ctx.request.body;
  const old=ctx.params.id ? await owned(ctx,store) : null;
  const rule=pricing.normalizeRule(input.couponRule);
  if (!rule) ctx.throw(400,'必须配置优惠券规则');
  const display=String(input.name||'').trim();
  if (!display) ctx.throw(400,'请输入方案名称');
  const name=old?.name || `${store.name}｜${display}`;
  if (name.length>50) ctx.throw(400,'门店与方案名称合计不能超过50字');
  const ids=[...new Set([rule.mallAccountId,rule.platformAccountId].filter(Boolean))];
  const accounts=await M.SettlementAccount.findAll({where:{account_id:{[Op.in]:ids},status:1}});
  if (accounts.length!==ids.length || accounts.some(a=>a.account_type!=='FUND'||(a.distributor_id && String(a.distributor_id)!==String(store.distributor_id)))) ctx.throw(400,'返款账户不属于当前门店经销商或已停用');
  ctx.request.body={name,couponRule:rule,isGlobal:false,defaultTaxRate:0,status:input.status===0?0:1,storeConfigs:[{storeId:store.store_id}]};
  const controller=require('./controller');
  return old ? controller.updatePaymentMethod(ctx) : controller.createPaymentMethod(ctx);
}
async function remove(ctx) {
  const store=await storeContext(ctx);await owned(ctx,store);
  return require('./controller').deletePaymentMethod(ctx);
}
module.exports={list,save,remove};
