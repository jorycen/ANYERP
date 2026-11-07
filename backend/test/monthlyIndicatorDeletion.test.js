const test=require('node:test'),a=require('node:assert/strict'),M=require('../src/models'),I=require('../src/modules/sales/monthlyIndicators');
const month=new Date(Date.now()+8*3600000).toISOString().slice(0,7);
const ctx=(role,scope)=>({state:{user:{roles:[role],staffId:2,distributorId:'D'}},params:{indicatorId:'A'},request:{body:{deleteScope:scope}},throw(s,m){throw Object.assign(Error(m),{status:s});}});
test('company deletion needs dealer authority; store deletion by its manager cannot touch another store or evidence',async t=>{
 const row=(id,store)=>({indicator_id:id,definition_id:'DEF',store_id:store,month_key:month,source:'company',status:1,async update(x){Object.assign(this,x);}});
 const rows=[row('A','S1'),row('B','S2')],stores=[{store_id:'S1',distributor_id:'D',manager_staff_id:2},{store_id:'S2',distributor_id:'D',manager_staff_id:3}];
 t.mock.method(M.sequelize,'transaction',async cb=>cb({LOCK:{UPDATE:'UPDATE'}}));
 t.mock.method(M.MonthlyIndicator,'findByPk',async()=>rows[0]);t.mock.method(M.MonthlyIndicator,'findAll',async()=>rows);
 t.mock.method(M.Store,'findByPk',async()=>stores[0]);t.mock.method(M.Store,'findAll',async()=>stores);
 t.mock.method(M.BusinessActionLog,'create',async()=>({}));
 t.mock.method(M.MonthlyIndicatorEvidence,'destroy',async()=>a.fail('Evidence must remain'));
 t.mock.method(M.MonthlyIndicatorAssignment,'destroy',async()=>a.fail('Assignments must remain'));
 await a.rejects(()=>I.update(ctx('manager','indicator')),{status:403});
 await I.update(ctx('manager','store'));a.equal(rows[0].status,-1);a.equal(rows[1].status,1);
});
test('deleting a legacy store-built indicator cannot affect identically named targets in another store',async t=>{
 const rows=['S1','S2'].map((store,index)=>({indicator_id:String(index),store_id:store,source:'store',name:'巡检',role_code:'staff',metric:'management',requirements:'',month_key:month,status:1,async update(x){Object.assign(this,x);}}));
 const stores=rows.map((r,i)=>({store_id:r.store_id,distributor_id:'D',manager_staff_id:i+2}));
 t.mock.method(M.sequelize,'transaction',async cb=>cb({LOCK:{UPDATE:'UPDATE'}}));t.mock.method(M.MonthlyIndicator,'findByPk',async()=>rows[0]);t.mock.method(M.MonthlyIndicator,'findAll',async()=>rows);t.mock.method(M.Store,'findByPk',async()=>stores[0]);t.mock.method(M.Store,'findAll',async()=>stores);t.mock.method(M.BusinessActionLog,'create',async()=>({}));
 await I.update(ctx('manager','indicator'));a.equal(rows[0].status,-1);a.equal(rows[1].status,1);
});
test('deleted management indicators cannot accept new proof submissions',async t=>{
 t.mock.method(M.sequelize,'transaction',async cb=>cb({LOCK:{UPDATE:'UPDATE'}}));t.mock.method(M.MonthlyIndicatorAssignment,'findByPk',async()=>({indicator_id:'I',staff_id:2}));t.mock.method(M.MonthlyIndicator,'findByPk',async()=>({status:-1,metric:'management',month_key:month}));
 const c=ctx('staff','store');c.params={assignmentId:'A'};c.request.body={resultText:'证明'};
 await a.rejects(()=>I.submit(c),{status:409});
});
