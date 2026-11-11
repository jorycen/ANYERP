const {test}=require('node:test'),a=require('node:assert/strict');
const H=require('../src/modules/report/storeManagerHistory'),A=require('../src/modules/report/storeCommissionAllocation'),M=require('../src/models');
test('manager history index has an explicit MySQL-safe name',()=>{
 a.equal(H.Assignment.options.indexes[0].name,'idx_store_manager_effective');
 a.ok(H.Assignment.options.indexes.every(i=>i.name.length<=64));
});
test('history uses effective intervals, never current manager or ambiguous overlaps',()=>{
 const rows=[{store_id:'S',staff_id:1,effective_from:'2026-10-01',effective_to:'2026-10-15'},{store_id:'S',staff_id:2,effective_from:'2026-10-15',effective_to:null}];
 a.equal(H.resolve(rows,'S','2026-10-14').staff_id,1);a.equal(H.resolve(rows,'S','2026-10-15').staff_id,2);a.equal(H.resolve(rows,'S','2026-09-30'),null);
 a.equal(H.resolve([...rows,rows[0]],'S','2026-10-10'),null);
});
test('store profit belongs to original business-time manager; return reverses that original manager',()=>{
 const history=[{store_id:'S',staff_id:1,effective_from:'2026-10-01',effective_to:'2026-10-15'},{store_id:'S',staff_id:2,effective_from:'2026-10-15',effective_to:null},{store_id:'T',staff_id:3,effective_from:'2026-10-01',effective_to:null}];
 const events=[{amount:100,storeId:'S',ownershipTime:'2026-10-10'},{amount:200,storeId:'S',ownershipTime:'2026-10-20'},{amount:-50,storeId:'S',ownershipTime:'2026-10-10'},{amount:300,storeId:'T',ownershipTime:'2026-10-20'}];
 const r=A.allocate(events,history,[{staff_id:1,name:'旧店长'},{staff_id:2,name:'唐陈'},{staff_id:3,name:'其他店长'}],{month:'2026-10'});
 a.equal(r.owners.get('1').commission,1.5);a.equal(r.owners.get('2').commission,10);a.equal(r.owners.get('3').commission,9);a.equal(r.missing.length,0);
});
test('unknown history stays unassigned; confirmed absence and staff exceptions do not invent commissions',()=>{
 const r=A.allocate([{storeId:'S',ownershipTime:'2026-09-20',amount:-10},{storeId:'S',ownershipTime:'2026-10-20',amount:100}],[],[],{month:'2026-10'});
 a.equal(r.owners.size,0);a.equal(r.missing.length,2);a.equal(r.missing[0].originalMonth,'2026-09');
 const known=A.allocate([{storeId:'S',ownershipTime:'2026-10-20',amount:100}],[{store_id:'S',staff_id:1,effective_from:'2026-10-01'}],[{staff_id:1,name:'卢珏'}],{month:'2026-10'});a.equal(known.owners.get('1').commission,0);
});
test('history confirmation locks store, rejects conflicting periods and audits the explicit confirmation',async t=>{
 t.mock.method(M.Store,'findByPk',async()=>({distributor_id:'D'}));t.mock.method(M.Staff,'findByPk',async()=>({distributor_id:'D'}));
 t.mock.method(H.Assignment,'findAll',async()=>[{store_id:'S',staff_id:2,effective_from:'2026-10-01',effective_to:'2026-11-01'}]);
 await a.rejects(H.confirm({storeId:'S',staffId:1,from:'2026-10-15',to:'2026-11-15',evidence:'依据',transaction:{LOCK:{UPDATE:'UPDATE'}}}),{status:409});
});

test('first recording of current manager starts now and never fabricates past tenure',async t=>{
 let saved;
 t.mock.method(H.Assignment,'sync',async()=>{});t.mock.method(H.Assignment,'count',async()=>0);t.mock.method(H.Assignment,'create',async row=>{saved=row;return row;});
 t.mock.method(M.Store,'findAll',async()=>[{store_id:'S'}]);t.mock.method(M.Store,'findByPk',async()=>({manager_staff_id:1}));
 t.mock.method(M.sequelize,'transaction',async fn=>fn({LOCK:{UPDATE:'UPDATE'}}));
 const before=Date.now();await H.initialize();a.ok(saved.effective_from.getTime()>=before);a.equal(saved.staff_id,1);a.equal(saved.effective_to,null);
});

test('unknown tenure gap ends exactly at the first confirmed manager time, including intraday boundaries',()=>{
 const boundary='2026-11-11T07:30:00.000Z';
 const r=A.allocate([{storeId:'S',ownershipTime:new Date('2026-11-10T05:00:00Z'),amount:100}],[{store_id:'S',staff_id:1,effective_from:boundary,effective_to:null}],[],{month:'2026-11'});
 a.equal(r.missing[0].to,boundary);a.equal(r.missing[0].from,'2026-10-31T16:00:00.000Z');
 const none=A.allocate([{storeId:'S',ownershipTime:'2026-11-10',amount:100}],[{store_id:'S',staff_id:null,effective_from:'2026-11-01'}],[],{month:'2026-11'});a.equal(none.missing.length,0);a.equal(none.owners.size,0);
});

test('unset current manager is not automatically recorded as confirmed absence',async t=>{
 t.mock.method(H.Assignment,'sync',async()=>{});t.mock.method(M.Store,'findAll',async()=>[{store_id:'S'}]);
 t.mock.method(M.Store,'findByPk',async()=>({manager_staff_id:null}));t.mock.method(M.sequelize,'transaction',async fn=>fn({LOCK:{UPDATE:'UPDATE'}}));
 t.mock.method(H.Assignment,'create',async()=>{throw Error('must not fabricate absence')});await H.initialize();
});

test('manager changes close and start tenure in the same store transaction',async t=>{
 const tx={LOCK:{UPDATE:'UPDATE'}},locked={manager_staff_id:1,async update(v,o){a.equal(o.transaction,tx);Object.assign(this,v)},toJSON(){return {manager_staff_id:this.manager_staff_id}}};
 let closed,created,display;
 t.mock.method(M.sequelize,'transaction',async fn=>fn(tx));t.mock.method(M.Store,'findByPk',async()=>locked);
 t.mock.method(H.Assignment,'findAll',async()=>[{effective_from:new Date('2026-10-01'),effective_to:null,async update(v,o){a.equal(o.transaction,tx);closed=v.effective_to}}]);
 t.mock.method(H.Assignment,'create',async(v,o)=>{a.equal(o.transaction,tx);created=v;return v});t.mock.method(M.BusinessActionLog,'create',async(v,o)=>{a.equal(o.transaction,tx);return v});
 await H.updateStore({store_id:'S',set(v){display=v}},{manager_staff_id:2},{staffId:9});
 a.equal(created.staff_id,2);a.equal(created.effective_from,closed);a.equal(display.manager_staff_id,2);
});

test('historical staff without business in this period are not inserted as report employees',async t=>{
 t.mock.method(H.Assignment,'findAll',async()=>[{store_id:'S',staff_id:1,effective_from:'2020-01-01',effective_to:'2020-02-01'}]);
 t.mock.method(M.Staff,'findAll',async()=>[{staff_id:1,name:'旧店长'}]);
 const r=await A.load({profitDetails:[]},[{store_id:'S'}],{month:'2026-10'});a.equal(r.people.length,0);a.equal(r.owners.size,0);
});
