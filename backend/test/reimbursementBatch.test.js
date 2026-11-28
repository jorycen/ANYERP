const test=require('node:test'),assert=require('node:assert/strict');
const B=require('../src/modules/finance/batchSubmission'),M=require('../src/models');
const E=require('../src/modules/finance/controller'),S=require('../src/modules/finance/payableController');
const {Op}=require('sequelize');
const ctx=body=>({request:{body},state:{user:{roles:['finance'],accessibleDistributorIds:['A'],accessibleStoreIds:['s'],name:'tester'}},throw(status,message){throw Object.assign(Error(message),{status});}});
test('selection deduplicates ids, enforces batch limits, and sums exact cents',()=>{
 assert.deepEqual(B.ids(['a','a','b']),['a','b']);assert.throws(()=>B.ids([]));assert.throws(()=>B.ids(Array.from({length:101},(_,i)=>String(i))));
 assert.deepEqual(B.totals([{amount:'1.11'},{amount:'2.22'}],'amount'),{selectedCount:2,totalAmount:3.33});
 assert.throws(()=>B.totals([{amount:null}],'amount'),/金额缺失/);
});
test('batch expense submission reuses original transitions, locks each row, and reports independent failures',async t=>{
 const transaction={LOCK:{UPDATE:'UPDATE'}};
 t.mock.method(M.sequelize,'transaction',async fn=>fn(transaction));
 const rows={a:{expense_id:'a',status:'pending',distributor_id:'A'},b:{expense_id:'b',status:'paid',distributor_id:'A'},c:{expense_id:'c',status:'pending',distributor_id:'B'}};
 for(const row of Object.values(rows))row.update=async patch=>Object.assign(row,patch);
 t.mock.method(M.Expense,'findByPk',async(id,options)=>{assert.equal(options.lock,'UPDATE');return rows[id];});
 const first=ctx({ids:['a','a','b','c']});await E.batchSubmitExpenses(first);
 assert.equal(first.body.data.successCount,1);assert.equal(first.body.data.failedCount,2);assert.equal(rows.a.status,'processing');assert.equal(rows.c.status,'pending');
 const retry=ctx({ids:['a']});await E.batchSubmitExpenses(retry);assert.equal(retry.body.data.successCount,0);
});
test('settlement selection enforces dealer scope and deduplicates selected ids',async t=>{
 let where;t.mock.method(M.Settlement,'findAll',async options=>{where=options.where;return [{settlement_id:'x',total_amount:'123.45'}];});
 const selected=ctx({ids:['x','x']});await S.previewSettlementSelection(selected);
 assert.deepEqual(where.settlement_id,{[Op.in]:['x']});assert.deepEqual(where[Op.and],[{distributor_id:{[Op.in]:['A']}}]);
 assert.equal(selected.body.data.totalAmount,123.45);
 t.mock.method(M.Settlement,'findAll',async()=>[]);await assert.rejects(S.previewSettlementSelection(ctx({ids:['inaccessible']})),/无权限/);
});
