const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const E = require('../src/modules/report/financialProfitEngine');
const C = require('../src/modules/report/financialProfitControl');
const { calculateOrder, resolveFinancialCost } = require('../src/modules/report/financialProfitController');
function event(overrides = {}) { const value = { eventKey:'sale:O',entryType:'sale',entryNo:'ORD1',orderId:'O',storeId:'S',businessDate:'2026-09-01',grossRevenue:113,netRevenue:100,grossCost:56.5,bookCost:50,outputVat:13,deductibleInputVat:6.5,grossProfit:50,status:'estimated',taxStatus:'estimated',detailItems:[{itemId:1,productName:'P',quantity:1,unitCost:56.5,costSource:'product_settlement',grossRevenue:113,grossCost:56.5,bookCost:50,outputVat:13,estimatedInputVat:6.5,outputRate:0.13}],...overrides };value.sourceHash=E.sourceHash(value);return value; }
const proof = { reason:'核对原始凭据',evidence:'已与原采购及开票记录核对',invoiceNo:'INV1' };
function ctx(body = {}) { return { request:{body},query:{},state:{user:{roles:['finance'],name:'测试财务',accessibleStoreIds:['S'],accessibleDistributorIds:['D']}},throw(status,message){throw Object.assign(new Error(message),{status})} }; }
test('unknown current cost cannot rewrite historical profit; explicit sold-cost zero remains valid',()=>{
  assert.equal(resolveFinancialCost({ currentCostPrice:999,costPriceLocked:1 }).unitCost,null);
  assert.equal(resolveFinancialCost({ purchaseUnitCost:0,purchaseCostStatus:'pending',purchaseCostSource:'manual_sold_cost',currentCostPrice:999 }).unitCost,0);
});
test('complete-range margin uses the same revenue population and partial profit is never final operating profit',()=>{
  const known=event(), missing=event({eventKey:'sale:X',grossProfit:null,status:'cost_pending',netRevenue:100});
  const summary=E.summarize([known,missing],10);
  assert.equal(summary.grossMargin,50);assert.equal(summary.completeRevenue,100);assert.equal(summary.pendingRevenue,100);
  assert.equal(summary.overallGrossMargin,null);assert.equal(summary.operatingProfit,null);
  assert.equal(summary.costCompleteness,50);
});
test('later returns remain separate events; cumulative rounding conserves full tax and cost',()=>{
  const original=event({grossRevenue:1,grossCost:0.51,outputVat:0.03,deductibleInputVat:0.01,detailItems:[{itemId:1,quantity:3,unitCost:0.17,grossRevenue:1,grossCost:0.511,outputVat:0.03,estimatedInputVat:0.01}]});
  const returns=[0.33,0.33,0.34].map((amount,i)=>E.returnEvent([{returnId:`R${i}`,returnNo:`RET${i}`,orderId:'O',orderNo:'ORD1',storeId:'S',returnDate:'2026-10-02',itemId:1,returnedQuantity:-1,returnedReceivable:-amount,cumulativeQuantity:i+1,cumulativeRevenue:i===2?1:0.33*(i+1)}],original,calculateOrder));
  assert.ok(returns.every(row=>row.businessDate==='2026-10-02'));
  assert.equal(E.money(returns.reduce((n,row)=>n+row.outputVat,0)),-0.03);
  assert.equal(E.money(returns.reduce((n,row)=>n+row.deductibleInputVat,0)),-0.01);
  assert.equal(E.money(returns.reduce((n,row)=>n+row.grossCost,0)),-0.51);
  assert.equal(original.grossRevenue,1);
});
test('mixed-tax reviews require matching per-item allocation and returns retain that allocation',()=>{
  const base=event({grossRevenue:219,grossCost:100,detailItems:[{itemId:1,quantity:1,unitCost:50,grossRevenue:113,grossCost:50,outputVat:13},{itemId:2,quantity:1,unitCost:50,grossRevenue:106,grossCost:50,outputVat:6}]});
  assert.throws(()=>C.reviewAmounts(base,{...proof,inputTaxMode:'non_deductible',outputVat:19,inputVat:0}),/逐行/);
  const saved=C.reviewAmounts(base,{...proof,inputTaxMode:'non_deductible',outputVat:19,inputVat:0,itemTaxes:[{itemId:1,outputVat:13,inputVat:0},{itemId:2,outputVat:6,inputVat:0}]});
  const reviewed=E.applyReview(base,{SOURCE_HASH:base.sourceHash,REVIEW_JSON:JSON.stringify(saved),REVISION:1});
  const returned=E.returnEvent([{returnId:'R',returnDate:'2026-10-01',itemId:2,returnedQuantity:-1,returnedReceivable:-106}],reviewed,calculateOrder);
  assert.equal(returned.outputVat,-6);assert.equal(returned.netRevenue,-100);
});
test('review proof freezes tax; current tax estimates do not invalidate it, changed cost does',()=>{
  const base=event(),saved=C.reviewAmounts(base,{...proof,inputTaxMode:'deductible',outputVat:13,inputVat:6.5});
  const record={SOURCE_HASH:base.sourceHash,REVIEW_JSON:JSON.stringify(saved),REVISION:1};
  const changedRate=event({outputVat:9,netRevenue:104});
  assert.equal(E.applyReview(changedRate,record).outputVat,13);
  const changedCost=event({grossCost:70});
  assert.equal(E.applyReview(changedCost,record).status,'source_changed');
  assert.equal(E.applyReview(changedCost,record).grossCost,70);
});
test('education is reviewed on full company policy, without adding employee/product shares twice',()=>{
  const policy=event({entryType:'policy',policyAmount:1000,productAllocation:200,grossRevenue:0,grossCost:0});
  const saved=C.reviewAmounts(policy,{...proof,treatment:'reduce_cost',eligibleAmount:1000,taxImpact:100});
  assert.equal(saved.amounts.policyImpact,900);
  assert.equal(C.reviewAmounts(policy,{...proof,treatment:'defer_inventory'}).amounts.policyImpact,0);
  assert.equal(C.reviewAmounts({...policy,policyAmount:-1000},{...proof,treatment:'other_income',eligibleAmount:1000,taxImpact:100}).amounts.policyImpact,-900);
  assert.throws(()=>C.reviewAmounts(policy,{...proof,treatment:'other_income',eligibleAmount:1100,taxImpact:0}),/全额/);
});
test('closed period overlay preserves stored facts and costs while exposing later changes',()=>{
  const saved=event({status:'confirmed',taxStatus:'confirmed'}),live=event({grossCost:99});
  const facts={items:[live],policyItems:[],expenseEntries:[],periods:[{MONTH_KEY:'2026-09',SNAPSHOT_JSON:JSON.stringify({items:[saved],policyItems:[],expenseEntries:[]})}]};
  const differences=E.overlayClosed(facts,{storeIds:['S'],startDate:'2026-09-01',endDate:'2026-09-30'});
  assert.equal(facts.items[0].grossCost,56.5);assert.equal(facts.items[0].closed,true);assert.equal(differences.length,1);
});
test('month close refuses unreviewed costs, tax and policies; pending unearned policy is allowed',()=>{
  const report={items:[event()],policyItems:[event({entryType:'policy_pending',status:'policy_pending'})],expenseEntries:[]};
  assert.equal(C.closeBlockers(report).length,1);
  report.items[0].status='confirmed';assert.equal(C.closeBlockers(report).length,0);
  report.policyItems.push(event({entryType:'policy',status:'policy_unreviewed'}));assert.equal(C.closeBlockers(report).length,1);
  assert.throws(()=>C.monthRange('2026-13'),/有效/);assert.throws(()=>C.validDate('2026-02-30'),/有效/);
});
test('review endpoint scopes, rejects stale preview, validates registered invoice and atomically audits',async t=>{
  const writes=[],logs=[],tx={LOCK:{UPDATE:'UPDATE'}};let invoiceAvailable=false;
  t.mock.method(M.sequelize,'transaction',async fn=>fn(tx));
  t.mock.method(M.Store,'findByPk',async()=>({store_id:'S',distributor_id:'D'}));
  t.mock.method(M.PurchaseInvoice,'findOne',async()=>invoiceAvailable?({invoice_id:'I',invoice_no:'INV1',tax_amount:10,distributor_id:'D'}):null);
  t.mock.method(M.BusinessActionLog,'create',async(value,options)=>{assert.equal(options.transaction,tx);logs.push(value)});
  t.mock.method(M.sequelize,'query',async(sql,options)=>{
    if(sql.includes('INSERT INTO T_FINANCIAL_PROFIT_REVIEW')){assert.equal(options.transaction,tx);writes.push(options.replacements);return[]}
    if(sql.includes('FROM T_ORDER o'))return[{orderId:'O',orderNo:'ORD1',storeId:'S',businessDate:'2026-09-01',totalAmount:113,quantity:1,subtotal:113,itemId:1,purchaseUnitCost:56.5,purchaseCostStatus:'ready',outputTaxRate:0.13,inputTaxRate:0.13,inputTaxDeductible:1}];
    return[];
  });
  const raw=await require('../src/modules/report/financialProfitController').queryFinancialProfit({storeIds:['S'],startDate:'2026-09-01',endDate:'2026-09-01'});
  const source=raw.items[0];const request=ctx({...proof,eventKey:source.eventKey,storeId:'S',businessDate:'2026-09-01',sourceHash:source.sourceHash,outputVat:13,inputVat:6.5,inputTaxMode:'deductible'});
  request.state.user.accessibleStoreIds=['OTHER'];await assert.rejects(C.review(request),/无权/);assert.equal(writes.length,0);
  request.state.user.accessibleStoreIds=['S'];request.request.body.sourceHash='stale';await assert.rejects(C.review(request),/已变化/);assert.equal(writes.length,0);
  request.request.body.sourceHash=source.sourceHash;await assert.rejects(C.review(request),/有效发票/);assert.equal(writes.length,0);invoiceAvailable=true;await C.review(request);
  assert.equal(writes.length,1);assert.equal(logs.length,1);assert.equal(JSON.parse(writes[0].json).invoiceReference.invoiceId,'I');
});
test('closing is preview-bound, company-wide, role checked and auditable',async t=>{
  let closed=false;const writes=[],tx={LOCK:{UPDATE:'UPDATE'}};
  t.mock.method(M.sequelize,'transaction',async fn=>fn(tx));
  t.mock.method(M.Store,'findAll',async options=>{if(options.transaction)assert.equal(options.lock,'UPDATE');return[{store_id:'S'}]});
  t.mock.method(M.BusinessActionLog,'create',async(value,options)=>{assert.equal(options.transaction,tx);return value});
  t.mock.method(M.sequelize,'query',async(sql,options)=>{if(sql.includes('INSERT INTO T_FINANCIAL_PROFIT_PERIOD')){closed=true;writes.push(options.replacements);return[]}
    if(sql.includes('SELECT MONTH_KEY FROM T_FINANCIAL_PROFIT_PERIOD'))return closed?[{MONTH_KEY:'2026-01'}]:[];return[]});
  const request=ctx({month:'2026-01',...proof});await assert.rejects(C.previewClose(request),/BOSS/);
  request.state.user.roles=['boss'];request.state.user.accessibleStoreIds=['*'];await C.previewClose(request);
  request.request.body.previewHash='stale';await assert.rejects(C.close(request),/重新预览/);assert.equal(writes.length,0);
  request.request.body.previewHash=request.body.data.previewHash;await C.close(request);assert.equal(writes.length,1);
  await assert.rejects(C.close(request),/已经关账/);
});
test('cross-period adjustments require a closed source, open target and idempotency token',async t=>{
  const original=event({status:'confirmed'}),writes=[],tx={LOCK:{UPDATE:'UPDATE'}};let duplicate=false;
  t.mock.method(M.sequelize,'transaction',async fn=>fn(tx));
  t.mock.method(M.Store,'findByPk',async()=>({store_id:'S',distributor_id:'D'}));
  t.mock.method(M.BusinessActionLog,'create',async(value,options)=>{assert.equal(options.transaction,tx);return value});
  t.mock.method(M.sequelize,'query',async(sql,options)=>{
    if(sql.includes('SELECT * FROM T_FINANCIAL_PROFIT_PERIOD'))return[{MONTH_KEY:'2026-09',SNAPSHOT_JSON:JSON.stringify({items:[original],policyItems:[],expenseEntries:[]})}];
    if(sql.includes('SELECT ADJUSTMENT_ID'))return duplicate?[{ADJUSTMENT_ID:'A'}]:[];
    if(sql.includes('INSERT INTO T_FINANCIAL_PROFIT_ADJUSTMENT')){writes.push(options.replacements);duplicate=true;assert.equal(options.transaction,tx)}return[];
  });
  const request=ctx({...proof,storeId:'S',businessDate:'2026-10-01',sourceEventKey:original.eventKey,grossRevenue:0,outputVat:0,grossCost:10,inputVat:0,requestKey:'1234567890ABCDEF'});
  await C.adjust(request);assert.equal(JSON.parse(writes[0].json).amounts.grossProfit,-10);
  await assert.rejects(C.adjust(request),/不能重复/);assert.equal(writes.length,1);
});


test('a closed expense moved into an open month is not counted twice',()=>{
  const saved=event({eventKey:'expense:E:S',entryType:'expense',businessDate:'2026-09-01',category:'store',grossRevenue:0,status:'confirmed'});
  const moved=event({...saved,businessDate:'2026-10-01'});
  const facts={items:[],policyItems:[],expenseEntries:[moved],periods:[{MONTH_KEY:'2026-09',SNAPSHOT_JSON:JSON.stringify({items:[],policyItems:[],expenseEntries:[saved]})}]};
  const differences=E.overlayClosed(facts,{storeIds:['S'],startDate:'2026-10-01',endDate:'2026-10-31'});
  assert.equal(facts.expenseEntries.length,0);assert.equal(differences.length,1);
  assert.match(differences[0].reason,/其他期间/);
});
test('invalidated registered invoice requires reconfirmation while source financial amounts remain frozen in close',()=>{
  const base=event(),saved=C.reviewAmounts(base,{...proof,inputTaxMode:'deductible',outputVat:13,inputVat:6.5});
  const changed=E.applyReview(base,{SOURCE_HASH:base.sourceHash,REVIEW_JSON:JSON.stringify(saved),REVISION:1,INVALID_INVOICE:true});
  assert.equal(changed.status,'source_changed');
});

test('unallocated company expense and its corrections require the complete store scope',()=>{
  const company={storeId:null,scopeStoreIds:['A','B'],businessDate:'2026-10-01',bookCost:100};
  assert.equal(E.expensesForScope([company],['A'],'2026-10-01','2026-10-31').length,0);
  assert.equal(E.expensesForScope([company],['A','B'],'2026-10-01','2026-10-31').length,1);
});

test('unperiodized expenses block month close without inventing an accounting date',()=>{
  const blockers=C.closeBlockers({items:[],policyItems:[],expenseEntries:[],unperiodizedExpenses:[{eventKey:'expense:X',status:'period_pending',pendingCostReason:'缺少归属月份'}]});
  assert.equal(blockers.length,1);assert.match(blockers[0].reason,/归属/);
});
