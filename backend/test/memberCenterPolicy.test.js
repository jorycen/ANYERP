const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/modules/customerOps/rewardPolicy');
const math = require('../src/modules/customerOps/math');
const item = { id: 'a', points: '1500', on_sale: true, stock: 3, per_member_limit: null, sort: 0 };
test('exact points gap and ranking prioritize usable rewards before near targets', () => {
  assert.equal(P.availability(item, '1349').points_shortfall, '151');
  assert.equal(P.availability(item, '1500').can_exchange, true);
  assert.equal(P.availability(item, '-10').points_shortfall, '1510');
  const rows = ['1600','800','1500'].map((points, i) => ({...item,id:String(i),points,...P.availability({...item,points},'1349')}));
  assert.deepEqual(rows.sort(P.compare).map(r=>r.points), ['800','1500','1600']);
  const sold = {...item,points:'1',stock:0};
  const sorted = [P.dto(sold,P.availability(sold,'1349')), ...rows].sort(P.compare);
  assert.equal(sorted.at(-1).stock,0);
});
test('time, inventory, lifetime limits and active stores gate eligibility', () => {
  const now = new Date('2026-09-14T00:00:00Z');
  for (const changed of [{stock:0},{on_sale:false},{per_member_limit:0},{valid_start_time:'2026-09-15T00:00:00Z'},{valid_end_time:now}]) {
    assert.equal(P.availability({...item,...changed},'9999',0,true,now).can_exchange,false);
  }
  assert.equal(P.availability({...item,per_member_limit:2},'9999',2).eligible,false);
  assert.equal(P.availability(item,'9999',0,false).eligible,false);
});
test('money validation prevents negative cash, fractional cents and unsafe values', () => {
  assert.equal(P.money('39'),'39.00');
  assert.equal(P.money('39.9'),'39.90');
  for(const value of ['-1','39.999','1e3','10000000000',NaN]) assert.throws(()=>P.money(value));
  assert.throws(()=>P.validate({kind:'coupon',coupon_scope:'配件',cash_required:'1'}),/纯积分/);
  assert.throws(()=>P.validate({kind:'coupon'}),/使用范围/);
  assert.throws(()=>P.validate({valid_start_time:'2026-09-15',valid_end_time:'2026-09-14'}),/结束时间/);
  assert.throws(()=>P.validate({valid_start_time:'invalid'}),/时间格式/);
  assert.equal(P.validate({kind:'coupon',coupon_scope:'电脑清灰',instructions:'到店使用'}).coupon_value,'0.00');
});
test('ten yuan earns one point and historical snapshots keep their ratio', () => {
  const lines = [{item_id:1,product_id:'pc',sale_price:'13499.99',quantity:1}];
  const snapshot = math.makeSnapshot({},lines,{id:'new',numerator:'1',denominator:'1000',product_ids:[]});
  assert.equal(math.points(math.remaining(snapshot),snapshot),1349n);
  const old = {...snapshot,denominator:'100'};
  assert.equal(math.points(math.remaining(old),old),13499n);
  assert.equal(math.points(999n,snapshot),0n);
});
