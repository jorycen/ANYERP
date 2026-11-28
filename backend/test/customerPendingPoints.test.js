const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
test('pending preview scans all pages and excludes claimed orders using shared calculation',async()=>{
 const gt=Symbol('gt'),op={gt,lte:Symbol('lte'),or:Symbol('or')};
 const orders=Array.from({length:105},(_,i)=>({order_id:String(i).padStart(4,'0'),order_status:'已归档',store_id:'store'}));
 const models={Order:{findAll:async({where,limit})=>orders.filter(o=>!where.order_id||o.order_id>where.order_id[gt]).slice(0,limit)},
 Store:{findByPk:async()=>({distributor_id:'dist'})},OrderItem:{findAll:async()=>[{}]},SalesReturnRequest:{findAll:async()=>[]}};
 const customer={Binding:{findOne:async({where})=>where.order_id==='0000'?{}:null},Rule:{findOne:async()=>({})}};
 const math={makeSnapshot:()=>({}),remaining:()=>({}),points:()=>10n};
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/modules/customerOps/service.js'),'utf8'),{module,require:name=>{
 if(name==='sequelize')return {Op:op};if(name==='../../models')return models;
 if(name==='./models')return customer;if(name==='./math')return math;
 return {};
 },console});
 const api=module.exports;
 const empty=await api.pendingClaims({});assert.equal(empty.hasPhone,false);
 const result=await api.pendingClaims({purchase_phone:'13000000000'});
 assert.equal(result.pendingPoints,'1040');assert.equal(result.pendingCount,104);assert.equal(result.phone,'130****0000');
 const value=await api.claimCalculation({},orders[1],'13000000000');assert.equal(value.awarded,10n);
 const claimed=await api.claimCalculation({},orders[0],'13000000000');assert.equal(claimed.status,'already_claimed');
});
