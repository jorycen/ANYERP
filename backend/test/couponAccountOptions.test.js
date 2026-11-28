const test=require('node:test'),assert=require('node:assert/strict'),{Op}=require('sequelize');
const M=require('../src/models'),C=require('../src/modules/dict/controller');
function ctx(query){return {query,state:{user:{roles:['boss'],accessibleStoreIds:['*'],accessibleDistributorIds:['*']}},throw(status,message){throw Object.assign(Error(message),{status})}}}
test('coupon account lookup uses actual store distributor, not incomplete frontend store fields',async t=>{
 t.mock.method(M.Store,'findByPk',async()=>({store_id:'S',distributor_id:'DIST001'}));
 const find=t.mock.method(M.SettlementAccount,'findAll',async options=>{assert.equal(options.where.status,1);assert.equal(options.where.account_type,'FUND');assert.deepEqual(options.where[Op.and][0][Op.or],[{distributor_id:'DIST001'},{distributor_id:null}]);return [{account_id:'A',account_name:'四川银行（艾诺云）'}]});
 const context=ctx({purpose:'coupon',storeId:'S'});await C.getAllSettlementAccounts(context);assert.equal(context.body.data[0].account_name,'四川银行（艾诺云）');assert.equal(find.mock.calls.length,1);
});
test('ordinary account lookups preserve types and scoped coupon lookup cannot widen user permission',async t=>{
 t.mock.method(M.SettlementAccount,'findAll',async options=>{assert.equal(options.where.account_type,undefined);return []});await C.getAllSettlementAccounts(ctx({}));
 t.mock.method(M.Store,'findByPk',async()=>({store_id:'S',distributor_id:'OTHER'}));const context=ctx({purpose:'coupon',storeId:'S'});context.state.user.roles=['admin'];context.state.user.accessibleDistributorIds=['DIST001'];await assert.rejects(C.getAllSettlementAccounts(context),e=>e.status===403);
});
