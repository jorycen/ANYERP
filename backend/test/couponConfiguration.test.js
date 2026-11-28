const test=require('node:test'),assert=require('node:assert/strict');
const M=require('../src/models'),C=require('../src/modules/sales/couponConfiguration'),P=require('../src/modules/sales/couponPricing');
const rule=(face=100,purchase=59)=>({kind:'douyin',faceAmount:face,purchaseAmount:purchase,mallRate:50,platformRate:3,mallAccountId:'A',platformAccountId:'A'});
const plan=(name,face=100,purchase=59)=>({id:name,name,status:1,rule:rule(face,purchase)});
const parent={method_id:'M',name:'抖音券',is_global:0,status:1,coupon_rule:{version:2,kind:'douyin',global:[],stores:{S1:[plan('59抵100')],S2:[plan('199抵500',500,199)]}}};
function ctx(config,isGlobal=false){return {request:{body:{name:'抖音券',isGlobal,couponRule:config,storeConfigs:isGlobal?[]:[{storeId:'S1'},{storeId:'S2'}]}},state:{user:{roles:['admin'],accessibleDistributorIds:['D']}},throw:(status,message)=>{throw Object.assign(new Error(message),{status})}}}
function mocks(t){t.mock.method(M.PaymentMethod,'findOne',async()=>null);t.mock.method(M.Store,'findAll',async()=>[{store_id:'S1',distributor_id:'D'},{store_id:'S2',distributor_id:'D'}]);t.mock.method(M.SettlementAccount,'findAll',async()=>[{account_id:'A',account_type:'FUND',distributor_id:'D'}]);}
test('one parent expands independent store amounts; no store cannot see store schemes',()=>{
 const first=C.options(parent,'S1'),second=C.options(parent,'S2');
 assert.equal(first[0].name,'抖音券｜59抵100');assert.equal(second[0].coupon_rule.faceAmount,500);
 assert.equal(C.options(parent,'S3').length,0);
 assert.equal(P.calculateCoupon(first[0].coupon_rule,100).companyAmount,20.5);
 const global={...parent,is_global:1,coupon_rule:{version:2,global:[plan('59抵100')],stores:{}}};
 assert.equal(C.options(global,'S1')[0].name,C.options(global,'S2')[0].name);
});
test('normalize saves only selected scope and requires rules for each selected store',async t=>{
 mocks(t);const normalized=await C.normalize(ctx(parent.coupon_rule));
 assert.equal(normalized.stores.S1[0].rule.purchaseAmount,59);
 assert.equal(normalized.stores.S2[0].rule.purchaseAmount,199);
 await assert.rejects(C.normalize(ctx({...parent.coupon_rule,stores:{S1:[plan('59抵100')]}})),/每个适用范围/);
 const global=await C.normalize(ctx({version:2,kind:'douyin',global:[plan('59抵100')],stores:parent.coupon_rule.stores},true));
 assert.deepEqual(global.stores,{});
});
test('used store scheme can be disabled but not deleted or moved to global',async t=>{
 mocks(t);t.mock.method(M.OrderPayment,'count',async()=>1);
 const changed=structuredClone(parent.coupon_rule);changed.stores.S1[0].status=0;
 assert.equal((await C.normalize(ctx(changed),parent)).stores.S1[0].status,0);
 changed.stores.S1=[];await assert.rejects(C.normalize(ctx(changed),parent),/每个适用范围/);
 await assert.rejects(C.normalize(ctx({version:2,kind:'douyin',global:[plan('59抵100')]},true),parent),/已使用/);
});
test('snapshot resolves selected store via same calculation and rejects another store name',async t=>{
 t.mock.method(M.PaymentMethod,'findOne',async()=>null);t.mock.method(M.PaymentMethod,'findAll',async()=>[parent]);
 t.mock.method(M.PaymentMethodStore,'findOne',async query=>{assert.equal(query.where.method_id,'M');return {store_id:'S1'}});
 t.mock.method(M.SettlementAccount,'findAll',async()=>[{account_id:'A',account_type:'FUND',distributor_id:'D'}]);
 t.mock.method(M.Store,'findByPk',async()=>({distributor_id:'D'}));
 const result=await P.paymentSnapshot({method:'抖音券｜59抵100',amount:100},'S1');
 assert.equal(result.purchaseAmount,59);assert.equal(result.platformFee,1.77);
 await assert.rejects(P.paymentSnapshot({method:'抖音券｜199抵500',amount:500},'S1'),/不适用/);
 const previous=[{payment_method:'抖音券｜59抵100',coupon_snapshot:result}];
 parent.status=0;assert.equal((await P.paymentSnapshot({method:'抖音券｜59抵100',amount:100},'S1',null,previous)).platformFee,1.77);parent.status=1;
});
test('legacy alias remains selectable while client cannot forge legacy payment names',async t=>{
 mocks(t);const config=structuredClone(parent.coupon_rule);config.stores.S1[0].legacyName='伪造收款';
 const normalized=await C.normalize(ctx(config));assert.equal(normalized.stores.S1[0].legacyName,undefined);
 const method={...parent,coupon_rule:{version:2,stores:{S1:[{...plan('原方案'),legacyName:'历史券'}]}}};
 assert.equal(C.options(method,'S1')[0].name,'历史券');
});

test('multiple schemes receive unique option keys and disabled plans are not returned',()=>{
 const method=structuredClone(parent);method.coupon_rule.stores.S1.push(plan('79抵200',200,79));
 const options=C.options(method,'S1');assert.equal(new Set(options.map(p=>p.method_id)).size,2);
 method.coupon_rule.stores.S1[0].status=0;assert.equal(C.options(method,'S1').length,1);
});
test('same name cannot masquerade as an ordinary existing payment method',async t=>{
 mocks(t);M.PaymentMethod.findOne.mock.restore();t.mock.method(M.PaymentMethod,'findOne',async()=>({name:'collision'}));
 await assert.rejects(C.normalize(ctx(parent.coupon_rule)),/冲突/);
});

test('stale or unknown scheme names cannot fall back to ordinary payments',async t=>{
 t.mock.method(M.PaymentMethod,'findOne',async()=>null);t.mock.method(M.PaymentMethod,'findAll',async()=>[]);
 await assert.rejects(P.paymentSnapshot({method:'已删除父级｜旧券',amount:100},'S1'),/已删除/);
});

test('shared fund accounts remain usable for global coupon plans',async t=>{
 mocks(t);M.SettlementAccount.findAll.mock.restore();t.mock.method(M.SettlementAccount,'findAll',async()=>[{account_id:'A',account_type:'FUND',distributor_id:null}]);
 const config={version:2,kind:'douyin',global:[plan('59抵100')],stores:{}};
 assert.equal((await C.normalize(ctx(config,true))).global.length,1);
});
