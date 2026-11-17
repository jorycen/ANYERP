const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const M = require('../src/models');
const { listInstances } = require('../src/modules/approval/controller');

const context = query => ({ query, state: { user: { staffId:47, roles:['admin'], accessibleStoreIds:[] } },
  throw(status,message) { throw Object.assign(new Error(message),{status}); } });

test('我的申请超过100条可翻至末页，总数与筛选同源且不扩张本人范围', async t => {
  const calls=[];
  const all=Array.from({length:125},(_,i)=>({instance_id:String(i),applicant_staff_id:47,status:'approved',business_type:'expense'}));
  t.mock.method(M.ApprovalFlowInstance,'findAndCountAll',async options=>{
    calls.push(options);
    return {count:all.length,rows:all.slice(options.offset,options.offset+options.limit)};
  });
  t.mock.method(M.ApprovalFlowInstance,'findAll',async options=>{
    assert.deepEqual(options.where,{applicant_staff_id:47});
    assert.deepEqual(options.attributes,['business_type']);
    return [{business_type:'expense'},{business_type:'purchase_request'}];
  });
  t.mock.method(M.Staff,'findAll',async()=>[{staff_id:47,name:'申请人'}]);
  const ctx=context({scope:'mine',page:'7',pageSize:'20',title:'报销',businessType:'expense',instanceNo:'AP2026',status:'approved',startDate:'2026-11-01',endDate:'2026-11-17'});
  await listInstances(ctx);
  assert.equal(ctx.body.total,125); assert.equal(ctx.body.totalPages,7); assert.equal(ctx.body.list.length,5);
  assert.deepEqual(ctx.body.businessTypes,['expense','purchase_request']);
  const options=calls[0];
  assert.equal(options.offset,120); assert.equal(options.limit,20);
  assert.deepEqual(options.where[Op.and][0],{applicant_staff_id:47});
  assert.equal(options.where.business_type,'expense'); assert.equal(options.where.status,'approved');
  assert.equal(options.where.title[Op.substring],'报销'); assert.equal(options.where.instance_no[Op.substring],'AP2026');
  assert.equal(options.where.create_time[Op.gte].toISOString(),'2026-10-31T16:00:00.000Z');
  assert.equal(options.where.create_time[Op.lt].toISOString(),'2026-11-17T16:00:00.000Z');
  assert.deepEqual(options.order,[['create_time','DESC'],['instance_id','DESC']]);
});

test('我的申请校验日期及PN/SN，不接受无效范围', async () => {
  for(const query of [{startDate:'2026-02-30'},{startDate:'2026-11-20',endDate:'2026-11-01'},{pn:'x'.repeat(129)},{sn:'x'.repeat(129)}]) {
    await assert.rejects(listInstances(context({scope:'mine',page:1,...query})),error=>error.status===400);
  }
});

test('旧调用保留数组响应，零结果分页明确返回total=0', async t => {
  t.mock.method(M.ApprovalFlowInstance,'findAll',async options=>{
    if(options.attributes) return [];
    assert.equal(options.limit,100); return [];
  });
  t.mock.method(M.ApprovalFlowInstance,'findAndCountAll',async()=>({rows:[],count:0}));
  const legacy=context({scope:'mine'}); await listInstances(legacy); assert.deepEqual(legacy.body,[]);
  const paginated=context({scope:'mine',page:1,pageSize:20}); await listInstances(paginated);
  assert.deepEqual(paginated.body.list,[]); assert.equal(paginated.body.total,0); assert.equal(paginated.body.totalPages,0);
});
