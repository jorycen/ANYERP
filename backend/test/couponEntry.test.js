const test=require('node:test'),a=require('node:assert/strict');
const C=require('../src/modules/sales/couponConfiguration');
test('entry API supplies grouping and fixed face amount without changing pricing rules',()=>{
  const rule={kind:'douyin',faceAmount:300,purchaseAmount:99,mallRate:50,platformRate:3,mallAccountId:'A',platformAccountId:'A'};
  const method={name:'抖音减满券｜99抵300',coupon_rule:rule};
  const entry=C.entry(method);a.equal(entry.coupon_entry.group,'抖音减满券');a.equal(entry.coupon_entry.amount,300);a.equal(entry.coupon_entry.available,true);
  a.deepEqual(entry.coupon_rule,rule);a.equal(C.entry({name:'现金'}).coupon_entry,null);
  a.equal(C.entry({name:'商场优惠券'}).coupon_entry.available,false);
  a.equal(C.entry({name:'Mall',coupon_rule:{kind:'mall',faceAmount:0,mallRate:0}}).coupon_entry.available,false);
});
