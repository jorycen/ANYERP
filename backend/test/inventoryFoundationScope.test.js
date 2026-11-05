const test=require('node:test'),a=require('node:assert/strict'),M=require('../src/models'),C=require('../src/modules/inventory/foundationController');
const ctx=body=>({state:{user:{roles:['boss'],name:'测试'}},params:{basisId:'B'},request:{body},throw(s,m){throw Object.assign(Error(m),{status:s});}});
test('统一基础档案修改拒绝超出授权门店的关联记录',async t=>{
  t.mock.method(M.Store,'findAll',async()=>[{store_id:'A'}]);
  t.mock.method(M.InventoryFoundationRef,'findAll',async()=>[{basis_id:'B',store_id:'A'},{basis_id:'B',store_id:'B'}]);
  t.mock.method(M.sequelize,'transaction',async f=>f({LOCK:{UPDATE:'UPDATE'}}));
  t.mock.method(M.InventoryFoundation,'findByPk',async()=>a.fail('不能写超范围档案'));
  await a.rejects(()=>C.update(ctx({revision:1})),/跨越授权门店/);
});
test('缺价格管理权限不能查询或修改基础资料',async t=>{
  t.mock.method(M.Role,'findAll',async()=>[]);t.mock.method(M.RoleMenu,'findAll',async()=>[]);t.mock.method(M.Menu,'findOne',async()=>null);
  const c=ctx({});c.state.user.roles=['clerk'];await a.rejects(()=>C.update(c),/价格管理权限/);
});
test('批次关联来源指针变化时拒绝，不静默重定向',async t=>{
  t.mock.method(M.Store,'findAll',async()=>[{store_id:'A'}]);t.mock.method(M.sequelize,'transaction',async f=>f({LOCK:{UPDATE:'UPDATE'}}));
  t.mock.method(M.InventoryFoundationRef,'findByPk',async()=>({basis_id:'NEW',store_id:'A'}));
  await a.rejects(()=>C.link(ctx({referenceKey:'order_item:1',sourceBasisId:'OLD',targetBasisId:'TARGET',reason:'原始批次'})),/关联已变化/);
});
