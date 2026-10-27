const test=require('node:test');
const assert=require('node:assert/strict');
const {classify,realZero,hash}=require('../scripts/repair-zero-inventory-cost');
const receipt=(price,quantity=10)=>({SOURCE_TYPE:'purchase',STATUS:'completed',RECEIVED_QUANTITY:quantity,QUANTITY:quantity,UNIT_PRICE:price});
const base=()=>({COST_PRICE_LOCKED:0,COST_PRICE:0,PRICE_ID:'P',NEED_SN:0,stockQty:5,sns:[],conversions:[],resources:[],priceLogs:[],inbounds:[receipt(50)],classification:'SOURCE_OR_QUANTITY_REVIEW'});
test('明确且足额单价来源允许补成本，缺少覆盖或来源冲突不修复',()=>{
  assert.equal(classify(base()).cost,50);
  assert.equal(classify({...base(),stockQty:20}).decision,'INSUFFICIENT_COVERAGE');
  assert.equal(classify(base(),[{UNIT_PRICE:0,QUANTITY:5}]).decision,'SOURCE_CONFLICT');
  assert.equal(classify(base(),[{UNIT_PRICE:51,QUANTITY:5}]).decision,'SOURCE_CONFLICT');
  assert.equal(classify({...base(),inbounds:[receipt(0)]}).decision,'REVIEW');
});
test('人工锁定继续保护，多采购价不阻止完整SN来源刷新',()=>{
  const sn={...base(),NEED_SN:1,sns:[{INBOUND_PRICE:100}],classification:'SN_MASTER_REFRESH_CANDIDATE',proposedCost:100};
  assert.equal(classify(sn).cost,100);
  assert.equal(classify({...sn,COST_PRICE_LOCKED:1}).decision,'LOCKED');
  assert.equal(classify({...sn,inbounds:[receipt(50),receipt(100)]}).cost,100);
  assert.equal(classify({...base(),conversions:[{STATUS:'completed'}]}).decision,'REVIEW');
  assert.equal(classify({...base(),priceLogs:[{NEW_PRICE:0}]}).decision,'REVIEW');
});

test('多采购价使用剩余在库数量加权，不使用全历史采购均价',()=>{
  const row={...base(),stockQty:3,inbounds:[receipt(50),receipt(100)]};
  const layers=[{unit_price:100,quantity:2},{unit_price:50,quantity:8}];
  assert.equal(classify(row,[],layers).cost,83.33);
  assert.equal(classify({...row,stockQty:11},[],layers).decision,'INSUFFICIENT_COVERAGE');
  assert.equal(classify({...row,COST_PRICE_LOCKED:1},[],layers).decision,'LOCKED');
  assert.equal(classify(row,[],[{unit_price:0,quantity:3}]).decision,'INSUFFICIENT_COVERAGE');
  assert.equal(classify(row,[],[{unit_price:0,quantity:1,zero_cost_confirmed:1},{unit_price:90,quantity:2}]).cost,60);
});
test('缺失和真实0元不能当作正成本来源，赠品来源不按有价采购单套价',()=>{
  assert.equal(classify({...base(),inbounds:[]}).decision,'REVIEW');
  assert.equal(classify({...base(),inbounds:[receipt(null)]}).decision,'REVIEW');
  assert.equal(classify({...base(),inbounds:[receipt(50),{SOURCE_TYPE:'GIFT',STATUS:'completed'}]}).decision,'REVIEW');
  assert.equal(classify({...base(),sns:[{INBOUND_PRICE:0}]}).decision,'REVIEW');
});
test('真实零成本要求当前SN及已完成拆分成本守恒证据，普通0值不算证明',()=>{
  const sn={SN_ID:'S',INBOUND_PRICE:0,INBOUND_TIME:'2026-10-01'};
  const conversion={SN_ID:'S',STATUS:'completed',LINE_ROLE:'source',CONVERSION_TYPE:'split',TOTAL_SOURCE_COST:1,TOTAL_TARGET_COST:1,CREATE_TIME:'2026-10-27',CONVERSION_NO:'SPL1'};
  assert.equal(realZero({conversions:[]},sn),null);
  assert.equal(realZero({conversions:[conversion]},sn).sourceNo,'SPL1');
  assert.equal(realZero({conversions:[{...conversion,STATUS:'voided'}]},sn),null);
  assert.equal(realZero({conversions:[conversion]},{...sn,INBOUND_PRICE:null}),null);
  assert.equal(realZero({conversions:[conversion]},{...sn,INBOUND_TIME:'2026-10-28'}),null);
});
test('预览哈希不因数据库行返回顺序变化，成本或数量变化必须失效',()=>{
  const a={rows:[{id:1,cost:0,qty:1},{id:2,cost:0,qty:2}]};
  assert.equal(hash(a),hash({rows:[a.rows[1],a.rows[0]]}));
  assert.notEqual(hash(a),hash({rows:[{...a.rows[0],qty:2},a.rows[1]]}));
});
