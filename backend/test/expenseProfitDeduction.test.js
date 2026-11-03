const test=require('node:test'),assert=require('node:assert/strict');
const M=require('../src/models'),D=require('../src/modules/finance/expenseProfitDeduction'),S=require('../src/modules/finance/expenseService'),A=require('../src/modules/finance/expenseAccountingController');
const tx={LOCK:{UPDATE:'UPDATE'}};
const user={staffId:1,name:'申请人',roles:['admin'],accessibleDistributorIds:['D'],accessibleStoreIds:['S']};
const store={store_id:'S',distributor_id:'D',status:1};
const staff=[{staff_id:1,name:'甲',store_id:'S',distributor_id:'D'},{staff_id:2,name:'乙',store_id:'S',distributor_id:'D'},{staff_id:3,name:'丙',store_id:'S',distributor_id:'D'}];
const row=x=>({...x,async update(p){Object.assign(this,p);return this}});
function setup(t){
 t.mock.method(A,'assertPeriodOpen',async()=>null);t.mock.method(M.sequelize,'query',async()=>[]);
 t.mock.method(M.Store,'findByPk',async()=>store);
 t.mock.method(M.Staff,'findAll',async q=>staff.filter(s=>q.where.staff_id[require('sequelize').Op.in].includes(String(s.staff_id))));
 t.mock.method(M.BusinessActionLog,'create',async data=>data);
}
const input=(method='MANUAL')=>({performanceMonth:'2026-10',method,allocations:[{staffId:1,amount:60},{staffId:2,amount:40}]});
const normalize=(i,extra={})=>D.normalize(i,{amount:100,store,user,transaction:tx,...extra});
test('manual allocation is exact and employee labels come from server',async t=>{setup(t);const result=await normalize(input());assert.equal(result.totalAmount,100);assert.equal(result.remainingAmount,0);assert.equal(result.allocations[0].staffName,'甲');assert.equal(result.mode,'PROFIT_DEDUCTION')});
test('average allocation distributes the final cent exactly once',async t=>{setup(t);const result=await normalize({...input('AVERAGE'),allocations:[{staffId:1},{staffId:2},{staffId:3}]});assert.deepEqual(result.allocations.map(r=>r.amount),[33.33,33.33,33.34]);assert.equal(result.totalAmount,100)});
test('reject mismatched totals, duplicate people, invalid months and money precision',async t=>{setup(t);await assert.rejects(normalize({...input(),allocations:[{staffId:1,amount:99}]}),/合计/);await assert.rejects(normalize({...input(),allocations:[{staffId:1,amount:50},{staffId:1,amount:50}]}),/重复/);await assert.rejects(normalize({...input(),performanceMonth:'2026-13'}),/月份/);await assert.rejects(normalize({...input(),allocations:[{staffId:1,amount:100.001}]}),/小数/)});
test('missing month defaults to Shanghai current month; incomplete draft cannot be submitted',async t=>{setup(t);const result=await normalize({...input(),performanceMonth:''});assert.equal(result.performanceMonth,D.currentMonth());assert.equal((await normalize({allocations:[]},{draft:true})).totalAmount,0);await assert.rejects(normalize({allocations:[]}),/请选择/)});
test('cross distributor, inactive or out-of-scope staff cannot be allocated',async t=>{setup(t);M.Staff.findAll.mock.restore();t.mock.method(M.Staff,'findAll',async()=>[]);await assert.rejects(normalize(input()),/跨经销商/);const where=D.staffWhere(store,{...user,roles:['clerk']});assert.ok(where.store_id);assert.equal(D.staffWhere(store,user).store_id,undefined);await assert.rejects(D.storeContext('OTHER',{...user,accessibleStoreIds:[]}),e=>e.status===403)});
test('both expense and financial closed months reject deductions',async t=>{setup(t);M.sequelize.query.mock.restore();t.mock.method(M.sequelize,'query',async()=>[{MONTH_KEY:'2026-10'}]);await assert.rejects(normalize(input()),/已关账/);A.assertPeriodOpen.mock.restore();t.mock.method(A,'assertPeriodOpen',async()=>{throw Error('已锁定')});await assert.rejects(normalize(input()),/已锁定/)});
function expense(){return row({expense_id:'E',expense_no:'EXP',store_id:'S',distributor_id:'D',accounting_month:'2026-10',amount:100,payment_method:D.METHOD,source_type:'expense',status:'pending_approval',is_deleted:0,applicant_staff_id:1,applicant_name:'申请人',attribution_type:'PRODUCT_SIDE',attribution_details_json:'[]',attachment_urls:JSON.stringify([{url:'https://example.com/a.pdf',name:'a.pdf'}]),recipient_snapshot_json:JSON.stringify({...input(),mode:D.METHOD,allocations:[{staffId:'1',staffName:'甲',storeId:'S',amount:60},{staffId:'2',staffName:'乙',storeId:'S',amount:40}]})})}
test('final expense approval creates approved monthly rows once and never creates payables',async t=>{
 setup(t);const e=expense(),allocations=[];t.mock.method(M.Expense,'findByPk',async()=>e);t.mock.method(M.ExpensePerformanceAllocation,'findAll',async()=>allocations);t.mock.method(M.ExpensePerformanceAllocation,'create',async data=>{allocations.push(row(data));return data});t.mock.method(M.Payable,'findOne',async()=>{throw Error('must not create cash payable')});
 await S.applyExpenseApproval({business_id:'E'},tx,user,'approved');assert.equal(e.status,'approved');assert.equal(allocations.length,2);assert.equal(allocations[0].performance_month,'2026-10');assert.equal(allocations[0].status,'approved');
 await S.applyExpenseApproval({business_id:'E'},tx,user,'approved');assert.equal(allocations.length,2);assert.equal(M.BusinessActionLog.create.mock.calls.length,1);
});
test('rejection produces no deduction and closed-month approval cannot mark expense approved',async t=>{setup(t);const e=expense();t.mock.method(M.Expense,'findByPk',async()=>e);const allocations=t.mock.method(M.ExpensePerformanceAllocation,'create',async()=>{throw Error('must not deduct')});await S.applyExpenseApproval({business_id:'E'},tx,user,'rejected');assert.equal(e.status,'rejected');assert.equal(allocations.mock.calls.length,0);e.status='pending_approval';A.assertPeriodOpen.mock.restore();t.mock.method(A,'assertPeriodOpen',async()=>{throw Error('已锁定')});await assert.rejects(S.applyExpenseApproval({business_id:'E'},tx,user,'approved'),/已锁定/);assert.equal(e.status,'pending_approval')});
test('approved cancellation restores monthly performance by cancelling rows and logs the reversal',async t=>{setup(t);const e=expense();e.status='approved';const allocations=[row({staff_id:1,amount:60,status:'approved'}),row({staff_id:2,amount:40,status:'approved'})];t.mock.method(M.ExpensePerformanceAllocation,'findAll',async()=>allocations);await S.cancelExpenseRecord(e,user,tx,'撤销');assert.equal(e.status,'cancelled');assert.ok(allocations.every(r=>r.status==='cancelled'));assert.equal(M.BusinessActionLog.create.mock.calls[0].arguments[0].action,'reversed_deduction')});
test('all payable creation entry points reject noncash deduction expenses',async()=>{await assert.rejects(S.ensureExpensePayable(expense(),{},tx),/不生成应付/)});

test('monthly report query scopes to approved people and selected months, not source expense dates',async t=>{
 const find=t.mock.method(M.ExpensePerformanceAllocation,'findAll',async options=>{const Op=require('sequelize').Op;assert.equal(options.where.status,'approved');assert.equal(options.where.performance_month[Op.gte],'2026-10');assert.equal(options.where.performance_month[Op.lte],'2026-11');assert.equal(options.where.staff_id,'2');return [{staff_id:2,staff_name:'乙',amount:'40.00'}]});
 const result=await D.loadMonthly({storeIds:['S'],user,startDate:'2026-10-15',endDate:'2026-11-03',staffId:'2'});assert.equal(result[0].amount,40);assert.equal(find.mock.calls.length,1);
 assert.deepEqual(await D.loadMonthly({storeIds:['S'],user,orderNo:'ORD1'}),[]);
});
test('staff net profit uses the shared deduction source and includes people without sales',()=>{
 const result=D.attachMonthly([{staffId:'1',employeeName:'甲',grossProfit:10}],[{staffId:'1',staffName:'甲',amount:60},{staffId:'2',staffName:'乙',amount:40}]);
 assert.equal(result.length,2);assert.equal(result[0].netGrossProfit,-50);assert.equal(result[1].netGrossProfit,-40);
 assert.equal(D.attachMonthly([{staffId:'1',grossProfit:10}],null)[0].netGrossProfit,null);
});
test('Excel extra sheets expose deductions alongside original sales details',()=>{
 const X=require('xlsx');const ctx={set(){}};require('../src/utils/excelExport').sendExcel(ctx,[{销售:100}],['销售'],'test.xlsx','销售',{sheets:[{name:'费用绩效扣减',rows:[{员工:'甲',金额:60}]}]});const book=X.read(ctx.body,{type:'buffer'});assert.deepEqual(book.SheetNames,['销售','费用绩效扣减']);assert.equal(X.utils.sheet_to_json(book.Sheets['费用绩效扣减'])[0].金额,60);
});

test('create expense accepts noncash mode without payee fields and snapshots allocations before normal approval',async t=>{
 setup(t);const C=require('../src/modules/finance/controller'),approval=require('../src/modules/approval/service');
 t.mock.method(M.sequelize,'transaction',async callback=>callback(tx));
 t.mock.method(M.ExpenseType,'findOne',async()=>({type_id:'T',name:'费用'}));
 t.mock.method(M.ApprovalFlowDefinition,'findOne',async()=>({definition_id:'F'}));
 const begin=t.mock.method(approval,'startInstance',async input=>{assert.equal(input.businessType,'expense');assert.equal(input.payload.profitDeduction.allocations.length,2)});
 const create=t.mock.method(M.Expense,'create',async values=>{assert.equal(values.status,'pending_approval');assert.equal(values.payment_method,D.METHOD);assert.equal(JSON.parse(values.recipient_snapshot_json).allocations[0].amount,60);return row(values)});
 const context={state:{user},request:{body:{storeId:'S',expenseTypeId:'T',expenseParty:'费用',amount:100,paymentMethod:D.METHOD,profitDeduction:input(),expenseDate:'2026-11-03',attributionType:'PRODUCT_SIDE',attachmentUrls:[{url:'https://example.com/a.pdf',name:'a.pdf'}]}},params:{},throw(status,message){throw Object.assign(Error(message),{status})}};
 await C.createExpense(context);assert.equal(context.body.status,'pending_approval');assert.equal(create.mock.calls.length,1);assert.equal(begin.mock.calls.length,1);
});

test('staff store snapshot must stay within the expense distributor',async t=>{
 setup(t);M.Staff.findAll.mock.restore();t.mock.method(M.Staff,'findAll',async()=>[{staff_id:1,name:'甲',store_id:'OTHER',distributor_id:'D'}]);t.mock.method(M.Store,'findAll',async()=>[]);
 await assert.rejects(normalize({performanceMonth:'2026-10',method:'MANUAL',allocations:[{staffId:1,amount:100}]}),/所属门店/);
});
