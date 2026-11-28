const test = require('node:test'), assert = require('node:assert/strict');
const { normalizeRule, calculateCoupon, settlementLines, reversalLines, paymentSnapshot } = require('../src/modules/sales/couponPricing');
const { calculateGrossProfitValues } = require('../src/modules/sales/grossProfit');
const M = require('../src/models');
const douyin = { kind: 'douyin', faceAmount: 300, purchaseAmount: 99, platformRate: 3, mallRate: 50, mallAccountId: 'mall', platformAccountId: 'platform' };
test('99/300 and 199/500 match confirmed funding and net settlement', () => {
  const a = calculateCoupon(douyin, 300);
  assert.deepEqual([a.platformFee,a.platformNet,a.mallAmount,a.companyAmount,a.settlementAmount,a.totalCost], [2.97,96.03,100.5,100.5,196.53,103.47]);
  const b = calculateCoupon({ ...douyin, faceAmount:500, purchaseAmount:199 }, 500);
  assert.deepEqual([b.platformFee,b.platformNet,b.mallAmount,b.companyAmount,b.settlementAmount,b.totalCost], [5.97,193.03,150.5,150.5,343.53,156.47]);
});
test('mall coupon is split once, variable amount and per-coupon cents conserve face value', () => {
  const a=calculateCoupon({kind:'mall',faceAmount:0,mallRate:70,mallAccountId:'mall'},100);
  assert.equal(a.mallAmount,70);assert.equal(a.companyAmount,30);assert.equal(a.totalCost,30);assert.equal(a.settlementAmount,70);
  const b=calculateCoupon({...douyin,faceAmount:1.01,purchaseAmount:0.01,mallRate:33.33},3.03);
  assert.equal(b.count,3);assert.equal(b.mallAmount,0.99);
  assert.equal(Math.round((b.settlementAmount+b.totalCost)*100),303);
});
test('reject invalid amounts, incomplete accounts, unsupported rates and fractional vouchers', () => {
  for(const amount of [0,-1,99,300.001,NaN]) assert.throws(()=>calculateCoupon(douyin,amount));
  for(const values of [{mallRate:101},{platformRate:-1},{purchaseAmount:301},{mallAccountId:''},{platformAccountId:''}]) assert.throws(()=>normalizeRule({...douyin,...values}));
});
test('coupon cost does not inherit normal fee allocation and does not double count platform fees', () => {
  const c=calculateCoupon(douyin,300);
  const gp=calculateGrossProfitValues({receivableAmount:1000,invoiceStatus:'不开票',paymentDetails:[{method:'cash',amount:700,taxRate:0},{method:'coupon',amount:300,taxRate:99,couponSnapshot:c}],productPricingDetails:[{unitPricing:500,pricingAmount:500}]});
  assert.equal(gp.paymentFeeAmount,2.97);assert.equal(gp.supplementAmount,-100.5);assert.equal(gp.grossProfitAmount,396.53);
  const again=calculateGrossProfitValues({receivableAmount:1000,invoiceStatus:'不开票',paymentDetails:gp.paymentDetails,productPricingDetails:gp.productPricingDetails,supplementDetails:gp.supplementDetails});
  assert.equal(again.grossProfitAmount,396.53);
});
test('daily settlement receives only platform net and mall share, not coupon face', () => {
  const lines=settlementLines({payment_method:'douyin',amount:300,coupon_snapshot:calculateCoupon(douyin,300)});
  assert.deepEqual(lines.map(x=>[x.amount,x.coupon_account_id]),[[96.03,'platform'],[100.5,'mall']]);
  assert.deepEqual(settlementLines({payment_method:'cash',amount:20}),[{payment_method:'cash',amount:20}]);
});
test('partial return reversals accumulate to exact frozen settlement without generating cash refund', () => {
  const p=[{payment_method:'douyin',coupon_snapshot:calculateCoupon(douyin,300)}];
  const lines=[...reversalLines(p,0,1,3),...reversalLines(p,1,1,3),...reversalLines(p,2,1,3)];
  assert.equal(lines.reduce((s,l)=>s+Math.round(l.amount*100),0),19653);
  assert.ok(lines.every(l=>l.coupon_settlement));
});
test('server snapshots ignore client forgery and retain original rule on edit', async t => {
  t.mock.method(M.Store,'findByPk',async()=>({distributor_id:'D'}));
  t.mock.method(M.SettlementAccount,'findAll',async()=>[{account_type:'FUND'},{account_type:'FUND'}]);
  t.mock.method(M.PaymentMethod,'findOne',async()=>({status:1,is_global:1,coupon_rule:douyin}));
  const a=await paymentSnapshot({method:'coupon',amount:300,coupon_snapshot:{totalCost:0}},'S');
  assert.equal(a.totalCost,103.47);
  t.mock.method(M.PaymentMethod,'findOne',async()=>{throw Error('Must not read current config');});
  const b=await paymentSnapshot({method:'coupon',amount:600},'S',null,[{payment_method:'coupon',coupon_snapshot:a}]);
  assert.equal(b.totalCost,206.94);
  assert.equal(await paymentSnapshot({method:'coupon',amount:300},'S',null,[{payment_method:'coupon',coupon_snapshot:null}]),null);
});
test('store restricted coupon rejects another store',async t=>{
  t.mock.method(M.PaymentMethod,'findOne',async()=>({method_id:'X',status:1,is_global:0,coupon_rule:douyin}));
  t.mock.method(M.PaymentMethodStore,'findOne',async()=>null);
  await assert.rejects(paymentSnapshot({method:'coupon',amount:300},'OTHER'),/不适用/);
});
test('new legacy voucher payments require a configured scheme while old orders remain unchanged',async t=>{
 t.mock.method(M.PaymentMethod,'findOne',async()=>({name:'抖音减满券',coupon_rule:null}));
 await assert.rejects(paymentSnapshot({method:'抖音减满券',amount:300},'S'),/配置优惠券分担方案/);
 assert.equal(await paymentSnapshot({method:'抖音减满券',amount:300},'S',null,[{payment_method:'抖音减满券',coupon_snapshot:null}]),null);
});
