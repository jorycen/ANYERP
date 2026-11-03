const test=require('node:test'),assert=require('node:assert/strict');
const M=require('../src/models'),S=require('../src/modules/dict/couponSchemes'),C=require('../src/modules/dict/controller'),P=require('../src/modules/sales/couponPricing');
const rule={kind:'douyin',faceAmount:100,purchaseAmount:59,mallRate:50,platformRate:3,mallAccountId:'A',platformAccountId:'A'};
function context(body={},params={}) {return {query:{},params,request:{body:{storeId:'S',...body}},state:{user:{roles:['admin'],accessibleDistributorIds:['D']}},throw:(status,message)=>{throw Object.assign(new Error(message),{status})}}}
test('custom voucher amounts reuse the existing rule engine',()=>{
 const result=P.calculateCoupon(rule,100);assert.equal(result.purchaseAmount,59);assert.equal(result.platformFee,1.77);assert.equal(result.companyAmount,20.5);
});
test('store first save forces single-store scope and reuses existing persistence',async t=>{
 t.mock.method(M.Store,'findByPk',async()=>({store_id:'S',name:'门店甲',distributor_id:'D'}));
 t.mock.method(M.SettlementAccount,'findAll',async()=>[{account_id:'A',account_type:'FUND',distributor_id:'D'}]);
 t.mock.method(C,'createPaymentMethod',async ctx=>{assert.equal(ctx.request.body.isGlobal,false);assert.deepEqual(ctx.request.body.storeConfigs,[{storeId:'S'}]);assert.equal(ctx.request.body.name,'门店甲｜59抵100');assert.equal(ctx.request.body.couponRule.purchaseAmount,59);});
 await S.save(context({name:'59抵100',couponRule:rule,isGlobal:true,storeConfigs:[{storeId:'OTHER'}]}));
});
test('cannot cross distributor boundaries or edit shared legacy schemes',async t=>{
 t.mock.method(M.Store,'findByPk',async()=>({store_id:'S',name:'甲',distributor_id:'OTHER'}));
 await assert.rejects(S.save(context()),e=>e.status===403);
 M.Store.findByPk.mock.restore();
 t.mock.method(M.Store,'findByPk',async()=>({store_id:'S',name:'甲',distributor_id:'D'}));
 t.mock.method(M.PaymentMethod,'findByPk',async()=>({coupon_rule:rule,is_global:1,PaymentMethodStores:[]}));
 await assert.rejects(S.save(context({couponRule:rule},{id:'M'})),/历史共享/);
});
test('used schemes cannot be deleted through legacy or new routes',async t=>{
 t.mock.method(M.PaymentMethod,'findByPk',async()=>({coupon_rule:rule,name:'券',code:'券'}));
 t.mock.method(M.OrderPayment,'count',async()=>1);
 await assert.rejects(C.deletePaymentMethod(context({}, {id:'M'})),/只能停用/);
});
test('new store rule cannot bind another distributor account',async t=>{
 t.mock.method(M.Store,'findByPk',async()=>({store_id:'S',name:'甲',distributor_id:'D'}));
 t.mock.method(M.SettlementAccount,'findAll',async()=>[{account_type:'FUND',distributor_id:'OTHER'}]);
 await assert.rejects(S.save(context({name:'59抵100',couponRule:rule})),/返款账户/);
});
test('expired schemes are hidden while ordinary payments remain available',()=>{
 assert.equal(P.isActiveToday({...rule,validTo:'2020-01-01'}),false);
 assert.equal(P.isActiveToday({...rule,validFrom:'2099-01-01'}),false);
 assert.equal(P.isActiveToday(null),true);
});
