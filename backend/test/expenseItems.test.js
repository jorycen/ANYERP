const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const I=require('../src/modules/finance/expenseItems'),A=require('../src/modules/finance/expenseAmortization');
test('当前启动迁移补明细字段并验证可查询，失败不能跳过',async()=>{
 const s=fs.readFileSync(require.resolve('../src/utils/dbMigration'),'utf8');
 a.match(s.slice(s.indexOf('async function runSchemaMigrations()'),s.indexOf('async function ensureProfitAdjustmentCorrectionSchema()')),/await ensureExpenseItemsSchema\(\)/);
 const body=s.slice(s.indexOf('async function ensureExpenseItemsSchema()'),s.indexOf('async function ensureExpenseAccountingSchema()'));
 let fail=false;const calls=[];const run=vm.runInNewContext(body+';ensureExpenseItemsSchema',{checkAndAddColumn:async(...args)=>calls.push(args),sequelize:{query:async sql=>{calls.push(sql);if(fail)throw Error('missing');}}});
 await run();a.equal(calls[0][1],'EXPENSE_ITEMS_JSON');a.match(calls[1],/SELECT EXPENSE_ITEMS_JSON/);fail=true;await a.rejects(run(),/missing/);
});
const fixture=()=>({expenseId:'E',expenseType:'多类型费用',amount:0.03,sourceStoreId:'S1',businessDate:'2026-11-01',attributionType:'STORE',expenseItemsJson:JSON.stringify(['交通','住宿','办公'].map((name,i)=>({expenseTypeId:String(i),expenseType:name,amount:0.01}))),attributionDetails:[{target_type:'store',target_id:'S1',amount:0.01},{target_type:'store',target_id:'S2',amount:0.02}],amortizationStartMonth:'2026-11',amortizationEndMonth:'2027-01'});
test('分类、门店及跨月分配同时守恒，单独查询月份结果一致',()=>{
 const row=fixture(),months=['2026-11','2026-12','2027-01'];
 const all=I.expand([row],{dateMode:'accounting_month',monthKeys:months});
 a.equal(all.reduce((s,r)=>s+Math.round(r.amount*100),0),3);
 for(const name of ['交通','住宿','办公'])a.equal(all.filter(r=>r.expenseType===name).reduce((s,r)=>s+Math.round(r.amount*100),0),1);
 for(const month of months){const subset=I.expand([row],{dateMode:'accounting_month',monthKeys:[month]});a.deepEqual(subset,all.filter(r=>r.amortizationMonth===month));a.equal(subset.reduce((s,r)=>s+Math.round(r.amount*100),0),1);}
 a.equal(all.flatMap(r=>r.attributionDetails).filter(d=>d.target_id==='S2').reduce((s,d)=>s+Math.round(d.amount*100),0),2);
 a.equal(new Set(all.map(r=>A.expenseEventKey({...r,storeId:'S1'}))).size,all.length);
});
test('明细损坏或金额不守恒拒绝；历史单据兼容单类型',()=>{
 a.throws(()=>I.expand([{...fixture(),amount:2}],{dateMode:'accounting_month',monthKeys:['2026-11']}),/不一致/);
 a.throws(()=>I.read('{bad'),SyntaxError);
 a.equal(I.display({expense_type:'交通',amount:5})[0].amount,5);
 a.equal(A.expenseEventKey({expenseId:'OLD',storeId:'S'}),'expense:OLD:S');
 a.deepEqual(I.allocate(1,[1,1,1]),[1,0,0]);
});
test('门店分类、总体分类和财务明细同源，整单只计一次',async t=>{
 const M=require('../src/models');let call=0;
 const expense={expenseId:'E',expenseType:'多类型费用',amount:30,sourceStoreId:'S1',distributorId:'D',businessDate:'2026-11-16',attributionType:'STORE',expenseItemsJson:JSON.stringify([{expenseTypeId:'A',expenseType:'交通',amount:10},{expenseTypeId:'B',expenseType:'住宿',amount:20}]),attributionDetails:[{target_type:'store',target_id:'S1',amount:15},{target_type:'store',target_id:'S2',amount:15}]};
 t.mock.method(M.sequelize,'query',async()=>++call<=2?[{storeId:'S1',storeName:'一店',distributorId:'D'},{storeId:'S2',storeName:'二店',distributorId:'D'}]:[expense]);
 const result=await require('../src/modules/finance/expenseCostAllocation').summarizeAllocatedExpenses({storeIds:['S1','S2'],startDate:'2026-11-01',endDate:'2026-11-30'});
 a.equal(result.amount,30);a.equal(result.expenseCount,1);a.equal(result.entries.length,4);
 a.equal(result.byType.find(r=>r.expenseType==='住宿').amount,20);
 a.equal(result.byStoreType.find(r=>r.storeId==='S1'&&r.expenseType==='交通').amount,5);
 a.equal(result.entries.reduce((s,r)=>s+r.amount,0),30);
});
