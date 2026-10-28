const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function page(file, requireMock, wx) {
  let definition;
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../../', file), 'utf8'), {
    require: requireMock, wx, Page: value => { definition = value; }, Date, Math, Error
  });
  definition.data = { ...definition.data };
  definition.setData = values => Object.assign(definition.data, values);
  return definition;
}
test('member submits the chosen pickup store and keeps retry keys separate across stores', async () => {
  const calls = [], storage = new Map();
  const item = {kind:'gift',points:'10',cash_required:'39',hasCash:true,cashText:'39',valid_days:30,can_exchange:true};
  const wx = { showModal: options => options.success({confirm:true}), getStorageSync: key => storage.get(key),
    setStorageSync: (key,value) => storage.set(key,value), removeStorageSync: key => storage.delete(key), redirectTo: () => {} };
  const p = page('member/pages/reward/detail.js', name => name.endsWith('/api') ? {
    request: async (url,method,body,key) => { calls.push({url,method,body,key}); return {id:'exchange'}; }
  } : {reward:value=>value}, wx);
  p.id='gift';p.data.item=item;
  await p.exchange();
  assert.equal(calls.length,0);
  p.data.storeId='store-a';await p.exchange();
  assert.equal(calls[0].body.store_id,'store-a');
  assert.equal(calls[0].body.expected_cash,'39');
  assert.equal(storage.size,0);
  assert.equal(p.data.storeId,'store-a');
});
test('employee preview never auto-confirms receipt and submission carries the chosen account method', async () => {
  const calls=[];
  const p=page('sdxcx/pages/reward-redeem/reward-redeem.js',()=>({customerOps:{
    preview:async()=>({id:'exchange',status:'pending',expiresAt:new Date(),cashRequired:'39',paymentMethods:[{method_id:'cash',account_name:'Fund'}]}),
    redeem:async(id,body)=>{calls.push({id,body});return {status:'redeemed'};}
  }}),{});
  p.data.stores=[{store_id:'store-a'}];p.data.code='code';
  p.data.cashConfirmed=true;await p.preview();
  assert.equal(p.data.cashConfirmed,false);
  assert.equal(p.data.paymentIndex,-1);
  p.data.cashReceived='39';p.data.cashConfirmed=true;p.data.paymentIndex=0;
  p.data.snText='SN-1，SN-2\nSN-3';
  await p.confirm();
  assert.equal(calls[0].body.payment_method_id,'cash');
  assert.equal(calls[0].body.cash_received,'39');
  assert.equal(calls[0].body.cash_confirmed,true);
  assert.equal(calls[0].body.store_id,'store-a');
  assert.deepEqual(Array.from(calls[0].body.sn_codes),['SN-1','SN-2','SN-3']);
  assert.equal(p.data.success,true);
});
