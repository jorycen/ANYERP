const test=require('node:test');
const assert=require('node:assert/strict');
const RP=require('../src/modules/customerOps/rewardProducts');
const choices=[{product_id:'a',units_per_reward:1},{product_id:'b',units_per_reward:2}];
test('one chosen product retains its quantity and original voucher is unchanged',()=>{
 const snapshot={product_id:'a',units_per_reward:1,product_options:choices};
 assert.throws(()=>RP.select(snapshot),{status:400});
 assert.throws(()=>RP.select(snapshot,['a','b']),{status:400});
 assert.throws(()=>RP.select(snapshot,'other'),{status:400});
 const selected=RP.select(snapshot,'b');assert.equal(selected.product_id,'b');assert.equal(selected.units_per_reward,2);assert.equal(snapshot.product_id,'a');
});
test('legacy single-product vouchers still resolve without client selection',()=>{
 assert.equal(RP.select({product_id:'legacy',units_per_reward:3}).product_id,'legacy');
});
test('duplicate, empty and invalid quantity selections cannot be saved',()=>{
 assert.deepEqual(RP.validate({product_options:choices}),choices);
 assert.throws(()=>RP.validate({product_id:'legacy',product_options:[]}),{status:400});
 assert.throws(()=>RP.validate({product_options:[choices[0],choices[0]]}),{status:400});
 assert.throws(()=>RP.validate({product_options:[{product_id:'a',units_per_reward:0}]}),{status:400});
});
