const {test}=require('node:test'),a=require('node:assert/strict'),X=require('xlsx');
const M=require('../src/models'),R=require('../src/modules/report/employeeProfitSummary'),C=require('../src/modules/report/commissionConfig');
const Review=require('../src/modules/report/employeeProfitReview'),Import=require('../src/modules/report/employeeProfitImport');
async function fixture(t){
 const data={reportRole:'manager',rows:[{reviewKey:'staff:1',staffId:'1',employeeName:'甲',storeId:'S',storeName:'门店',role:'店长',issues:[{month:'2026-10',originalMonth:'2026-09',originalStoreId:'S',reason:'2026-09门店盈亏平衡线未配置'}]}]};
 const user={staffId:9,roles:['boss']},query={startDate:'2026-10-01',endDate:'2026-10-31',reportRole:'manager'};
 t.mock.method(R,'load',async()=>data);t.mock.method(C,'scope',async()=>[{store_id:'S',name:'门店',distributor_id:'D'}]);
 t.mock.method(C,'options',async()=>({stores:[{storeId:'S',breakEvenLine:null,revision:0}],employees:[]}));
 const ctx={state:{user},query,set(){}};await Review.exportReview(ctx,data);
 const wb=X.read(ctx.body,{type:'buffer'}),sheet=wb.Sheets['待核算清单'],rows=X.utils.sheet_to_json(sheet,{header:1});
 const col=rows[0].indexOf('确认值'),address=X.utils.encode_cell({r:1,c:col});sheet[address]={t:'n',v:0};
 return {user,wb,buffer:()=>X.write(wb,{type:'buffer',bookType:'xlsx'}),address};
}
test('upload preview accepts explicit zero, is read-only, then commits once with a signed preview',async t=>{
 const f=await fixture(t),logs=[];let writes=0;
 t.mock.method(M.BusinessActionLog,'findOne',async({where})=>logs.find(l=>l.business_type===where.business_type&&l.business_id===where.business_id&&l.action===where.action));
 t.mock.method(M.BusinessActionLog,'create',async row=>{logs.push(row);return row;});
 t.mock.method(M.Staff,'findByPk',async()=>({staff_id:9}));
 t.mock.method(M.sequelize,'transaction',async fn=>fn({LOCK:{UPDATE:'UPDATE'}}));
 t.mock.method(C,'save',async(ctx,tx)=>{a.ok(tx);a.equal(ctx.request.body.amount,0);writes++;});
 const ctx={state:{user:f.user},file:{buffer:f.buffer()},request:{body:{}}};
 await Import.preview(ctx);a.equal(ctx.body.data.valid,true);a.equal(writes,0);const token=ctx.body.data.token;
 ctx.request.body.token=token;await Import.apply(ctx);a.equal(writes,1);await Import.apply(ctx);a.equal(writes,1);
});
test('tampering, formulas, missing data, and unauthorized upload cannot write records',async t=>{
 const f=await fixture(t);
 f.wb.Sheets['待核算清单'][f.address]={t:'n',v:1,f:'1+0'};a.throws(()=>Import.parse(f.buffer()),/公式/);
 f.wb.Sheets['待核算清单'][f.address]={t:'s',v:'-1'};const invalid=await Import.plan(f.user,f.buffer());a.equal(invalid.valid,false);a.match(invalid.rows[0].message,/非负/);
 f.wb.Sheets['待核算清单'][f.address]={t:'s',v:''};const empty=await Import.plan(f.user,f.buffer());a.equal(empty.valid,false);a.equal(empty.rows[0].status,'skipped');
 await a.rejects(Import.plan({staffId:1,roles:['staff']},f.buffer()),{status:403});
 const meta=f.wb.Sheets['系统校验'],grid=X.utils.sheet_to_json(meta,{header:1}),address=X.utils.encode_cell({r:1,c:grid[0].indexOf('指纹')}),original=meta[address];meta[address]={t:'s',v:'stale'};
 f.wb.Sheets['待核算清单'][f.address]={t:'n',v:0};await a.rejects(Import.plan(f.user,f.buffer()),/校验信息被修改/);
 meta[address]=original;t.mock.method(R,'load',async()=>({reportRole:'manager',rows:[]}));const stale=await Import.plan(f.user,f.buffer());a.equal(stale.valid,false);a.match(stale.rows[0].message,/资料已变化/);
});

test('history upload accepts split non-overlapping tenures and rejects overlap',async t=>{
 const H=require('../src/modules/report/storeManagerHistory'),f=await fixture(t);
 const data={reportRole:'manager',rows:[{reviewKey:'history:S',employeeName:'待确认',storeId:'S',storeName:'门店',role:'历史店长',issues:[{month:'2026-10',originalMonth:'2026-10',originalStoreId:'S',reason:'业务发生时的店长任职依据未确认',from:'2026-09-30T16:00:00.000Z',to:'2026-10-31T16:00:00.000Z'}]}]};
 t.mock.method(R,'load',async()=>data);t.mock.method(M.Staff,'findAll',async({where})=>[{staff_id:where.staff_id,name:'店长'+where.staff_id,distributor_id:'D'}]);t.mock.method(H.Assignment,'findAll',async()=>[]);
 const ctx={state:{user:f.user},query:{reportRole:'manager',startDate:'2026-10-01',endDate:'2026-10-31'},set(){}};await Review.exportReview(ctx,data);
 const wb=X.read(ctx.body,{type:'buffer'}),rows=X.utils.sheet_to_json(wb.Sheets['待核算清单'],{defval:''}),first={...rows[0],确认值:'2',生效开始:'2026-10-01',生效结束:'2026-10-15',依据说明:'任职记录'},second={...rows[0],确认值:'3',生效开始:'2026-10-15',生效结束:'2026-11-01',依据说明:'交接记录'};
 wb.Sheets['待核算清单']=X.utils.json_to_sheet([first,second]);
 const buffer=()=>X.write(wb,{type:'buffer',bookType:'xlsx'});let plan=await Import.plan(f.user,buffer());a.equal(plan.valid,true);a.equal(plan.actions.length,2);
 second.生效开始='2026-10-14';wb.Sheets['待核算清单']=X.utils.json_to_sheet([first,second]);plan=await Import.plan(f.user,buffer());a.equal(plan.valid,false);a.match(plan.rows[1].message,/重叠/);
 a.equal(Import.date('2026-11-11 15:30:00'),'2026-11-11T07:30:00.000Z');a.throws(()=>Import.date('2026-02-30'),/无效/);
 a.equal(Import.date(new Date('2026-11-11T15:30:00Z')),'2026-11-11T07:30:00.000Z');
});
