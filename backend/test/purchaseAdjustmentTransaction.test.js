const test=require('node:test'),assert=require('node:assert/strict');
const M=require('../src/models'),P=require('../src/modules/purchase/controller');
const ctx=()=>({request:{body:{requestId:'missing',items:[{inboundItemId:1,returnQuantity:1}]}},state:{user:{}},throw(status,message){throw Object.assign(Error(message),{status});}});
test('purchase cancellation shares an explicit parent transaction without committing or rolling it back',async t=>{
 let commits=0,rollbacks=0;
 const parent={LOCK:{UPDATE:'UPDATE'},commit:async()=>commits++,rollback:async()=>rollbacks++};
 t.mock.method(M.sequelize,'transaction',async()=>{throw Error('must not open nested transaction');});
 t.mock.method(M.PurchaseRequest,'findByPk',async(_,options)=>{assert.equal(options.transaction,parent);return null;});
 await assert.rejects(P.createPurchaseAdjustment(ctx(),parent),/不存在/);
 assert.equal(commits,0);assert.equal(rollbacks,0);
});
test('Koa next callback does not masquerade as a parent transaction',async t=>{
 let rollbacks=0;const transaction={LOCK:{UPDATE:'UPDATE'},rollback:async()=>rollbacks++};
 t.mock.method(M.sequelize,'transaction',async()=>transaction);
 t.mock.method(M.PurchaseRequest,'findByPk',async(_,options)=>{assert.equal(options.transaction,transaction);return null;});
 await assert.rejects(P.createPurchaseAdjustment(ctx(),async()=>{}),/不存在/);assert.equal(rollbacks,1);
});
