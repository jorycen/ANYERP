const test = require('node:test');
const assert = require('node:assert/strict');
const {summarize} = require('../src/modules/inventory/receiptProgress');
const M = require('../src/models');
const {executeInboundInTransaction} = require('../src/modules/inventory/controller');
const {isPurchaseInboundItemProgressComplete} = require('../src/modules/inventory/controller')._test;
const tx = {LOCK:{UPDATE:'UPDATE'}};
const fail = (status,message)=>{throw Object.assign(new Error(message),{status});};

test('five ordered, three received remains partial; receiving remaining two completes',()=>{
  assert.deepEqual(summarize([{quantity:5,received_quantity:3}]),{expectedQuantity:5,receivedQuantity:3,remainingQuantity:2,progressStatus:'partially_received',statusLabel:'部分入库'});
  assert.equal(summarize([{quantity:5,received_quantity:5}]).progressStatus,'completed');
  assert.equal(summarize([{quantity:5,received_quantity:0}]).progressStatus,'pending');
  assert.equal(summarize([{original_quantity:5,quantity:2,received_quantity:3}]).expectedQuantity,5);
});
test('serialized receipt completion requires distinct SN for the full quantity',()=>{
  assert.equal(isPurchaseInboundItemProgressComplete({quantity:5,received_quantity:3,received_sn_codes:'["A","B","C"]'},{need_sn:1}),false);
  assert.equal(isPurchaseInboundItemProgressComplete({quantity:5,received_quantity:5,received_sn_codes:'["A","B","C"]'},{need_sn:1}),false);
  assert.equal(isPurchaseInboundItemProgressComplete({quantity:5,received_quantity:5,received_sn_codes:'["A","B","C","D","E"]'},{need_sn:1}),true);
  assert.equal(isPurchaseInboundItemProgressComplete({quantity:5,received_quantity:5,received_sn_codes:'["A","B","C","D","D"]'},{need_sn:1}),false);
});

test('retry with same receipt request returns saved result before any inventory mutation', async t=>{
  const items=[{productId:'p',quantity:3}];
  const requestHash=require('crypto').createHash('sha256').update(JSON.stringify(items)).digest('hex');
  const response={code:0,data:{receivedQuantity:3,remainingQuantity:2}};
  t.mock.method(M.Inbound,'findByPk',async()=>({store_id:'s',status:'pending'}));
  t.mock.method(M.BusinessActionLog,'findOne',async()=>({detail_json:JSON.stringify({requestHash,response})}));
  t.mock.method(M.InboundItem,'findAll',async()=>{throw Error('must not repeat receipt');});
  assert.deepEqual(await executeInboundInTransaction({inboundId:'in',requestId:'r',items,user:{accessibleStoreIds:['s']},fail},tx),response);
  await assert.rejects(executeInboundInTransaction({inboundId:'in',requestId:'r',items:[{productId:'p',quantity:2}],user:{},fail},tx),/请求已提交/);
});

test('receipt retries cannot bypass store permissions', async t=>{
  t.mock.method(M.Inbound,'findByPk',async()=>({store_id:'other',status:'pending'}));
  await assert.rejects(executeInboundInTransaction({inboundId:'in',items:[{quantity:1}],requestId:'r',user:{accessibleStoreIds:['s']},fail},tx),/无权操作/);
});

test('real receipt controller counts each batch once: 3 of 5, then 2 of 5; oversupply is rejected',async t=>{
  const model=value=>Object.assign(value,{async update(patch){Object.assign(this,patch);return this;}});
  const inbound=model({inbound_id:'in',inbound_no:'IN',source_type:'purchase',status:'pending',store_id:'s'});
  const item=model({item_id:1,product_id:'p',product_name:'test',quantity:5,received_quantity:0,pn_code:'PN',unit_price:0,location_id:'l',gross_profit_use_standard_price:1});
  const product={product_id:'p',name:'test',need_sn:0,status:1,manufacturer_code:'PN'};
  const pn=model({product_id:'p',pn_code:'PN',status:1,is_deleted:0});
  const inventory=model({normal_qty:0,regular_qty:0});
  const logs=[];
  t.mock.method(M.Inbound,'findByPk',async()=>inbound);
  t.mock.method(M.InboundItem,'findAll',async()=>[item]);
  t.mock.method(M.Product,'findAll',async()=>[product]);
  t.mock.method(M.Product,'findByPk',async()=>product);
  t.mock.method(M.ProductPn,'findAll',async()=>[pn]);
  t.mock.method(M.Location,'findOne',async()=>({location_id:'l',type:'normal_qty'}));
  t.mock.method(M.Inventory,'findOne',async()=>inventory);
  t.mock.method(M.BusinessActionLog,'create',async row=>{logs.push(row);return row;});
  const receive=quantity=>executeInboundInTransaction({inboundId:'in',items:[{inboundItemId:1,productId:'p',quantity,pnCode:'PN',locationId:'l'}],user:{name:'tester'},fail},tx);
  const first=await receive(3);
  assert.equal(first.data.progressStatus,'partially_received');
  assert.equal(inbound.status,'pending');
  assert.equal(item.received_quantity,3);
  assert.equal(inventory.normal_qty,3);
  await assert.rejects(receive(3),/最多还能入库 2 件/);
  const second=await receive(2);
  assert.equal(second.data.progressStatus,'completed');
  assert.equal(inbound.status,'completed');
  assert.equal(item.received_quantity,5);
  assert.equal(inventory.normal_qty,5);
  assert.equal(logs.length,2);
  await assert.rejects(receive(1),/已处理/);
});
