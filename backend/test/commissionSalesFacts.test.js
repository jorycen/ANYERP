const {test}=require('node:test'),a=require('node:assert/strict');
const M=require('../src/models'),expenses=require('../src/modules/finance/expenseCostAllocation'),rewards=require('../src/modules/customerOps/profitEvents');
test('internal stage query reads frozen return sales without requiring unrelated financial cost; public financial validation remains strict',async t=>{
 t.mock.method(expenses,'summarizeAllocatedExpenses',async()=>({entries:[]}));
 t.mock.method(rewards,'events',async()=>[]);
 delete require.cache[require.resolve('../src/modules/report/financialProfitEngine')];
 const engine=require('../src/modules/report/financialProfitEngine');
 t.mock.method(M.sequelize,'query',async sql=>{
  if(sql.includes('FROM T_SALES_RETURN_SETTLEMENT sr JOIN'))return [{returnId:'R',returnNo:'RET',orderId:'O',orderNo:'ORD',storeId:'S',returnDate:'2026-10-02',itemId:1,returnedQuantity:1,returnedReceivable:0}];
  if(sql.includes('SELECT RETURN_ID, SUM(GROSS_PROFIT_AMOUNT)'))return [{RETURN_ID:'R',amount:-50}];
  if(sql.includes('SELECT SOURCE_RETURN_ID, GROSS_PROFIT_AMOUNT, STATUS'))return [{SOURCE_RETURN_ID:'R',GROSS_PROFIT_AMOUNT:0,STATUS:'posted'}];
  return [];
 });
 t.mock.method(M.Order,'findByPk',async()=>({order_id:'O',create_time:'2026-10-01',customer_source:'即时零售'}));
 const query={storeIds:['S'],startDate:'2026-10-01',endDate:'2026-10-31'};
 await a.rejects(engine.query(query,()=>{}),{status:409});
 const r=await engine.query({...query,salesStageOnly:true},()=>{});
 a.equal(r.profitDetails[0].salesGrossProfit,-25);a.equal(r.profitDetails[0].operationsGrossProfit,-25);a.equal(r.profitDetails[0].grossCost,null);
});
