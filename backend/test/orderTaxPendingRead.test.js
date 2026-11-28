const test=require('node:test'),a=require('node:assert/strict');
const GP=require('../src/modules/sales/grossProfit');
const {readCostSnapshot,applyPendingCost}=require('../src/modules/sales/costPreview');
test('订单只读预览对采购票税待核实返回空毛利，不阻断原单信息且不写库',async t=>{
  const error=Object.assign(Error('采购票税依据待核实，不能计算税费'),{code:'ORDER_PURCHASE_TAX_PENDING',status:409});
  t.mock.method(GP,'calculateAndSaveOrderGrossProfit',async(id,options)=>{a.equal(options.persist,false);throw error;});
  const result=await readCostSnapshot('O',{persist:true});
  a.equal(result.snapshot,null);a.equal(result.pending.grossProfitAmount,null);a.equal(result.pending.vatAmount,null);
  const original={total_amount:'19999.00',OrderItems:[{item_id:1,subtotal:'19999.00',sales_gross_profit:0}]};
  const shown=applyPendingCost(original,result.pending);
  a.equal(shown.total_amount,'19999.00');a.equal(shown.OrderItems[0].subtotal,'19999.00');
  a.equal(shown.OrderItems[0].sales_gross_profit,null);a.equal(original.OrderItems[0].sales_gross_profit,0);
  a.throws(()=>require('../src/modules/sales/purchaseVat').calculateVat([{purchaseTaxBasis:{status:'pending'}}],19999,'普通发票'),/采购票税/);
});
test('订单只读预览不吞掉数据库或其他业务错误',async t=>{
  t.mock.method(GP,'calculateAndSaveOrderGrossProfit',async()=>{throw Error('database unavailable');});
  await a.rejects(()=>readCostSnapshot('O'),/database unavailable/);
});
