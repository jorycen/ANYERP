// User-authorized nine-order correction. Preview by default; never includes the disputed repair order.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const XLSX=require('xlsx');
const M=require('../src/models');
const GP=require('../src/modules/sales/grossProfit');
const C=require('../src/modules/report/settlementPriceCorrection');
const {recordBusinessAction}=require('../src/utils/businessActionLog');
const targets=[
 ['ORD202610111103260628','YXOMNS08',5759,5800],
 ['ORD202610150505311157','GM192WJX',8500,8500],
 ['ORD202610170703541744','MP312Y2V',8500,9500],
 ['ORD202610171232599799','PF6B0PQT',15999,17050],
 ['ORD202610180529523374','MP2ZEKAE',4249,4500],
 ['ORD202610190619315159','MP2ZEEPG',4249,4500],
 ['ORD202610190901392496','HA2Q5294',5849,5500],
 ['ORD202610220853547227','870052131R61S0908',7700,7700],
 ['ORD202610270940556351','GM1DA5TB',9800,9800]
];
const batch='EXTERNAL-20261102-NINE';
const directory=path.resolve(__dirname,'../backup/order-corrections',batch);
const parse=value=>typeof value==='string'?JSON.parse(value):value||[];
const cents=value=>Math.round(Number(value||0)*100);
const equal=(a,b,message)=>assert.equal(cents(a),cents(b),message);
function calculate(snapshot,lines,invoiceStatus){
 const supplements=parse(snapshot.supplement_details);
 return GP.calculateGrossProfitValues({receivableAmount:snapshot.receivable_amount,productPricingDetails:lines,
  paymentDetails:parse(snapshot.payment_fee_details),supplementDetails:supplements.filter(row=>row.source!=='freight_cost'),
  freightCostDetails:supplements.filter(row=>row.source==='freight_cost'),invoiceAmount:snapshot.invoice_amount,invoiceStatus});
}
async function plan(target,transaction){
 const [no,snCode,oldPrice,price]=target;
 const order=await M.Order.findOne({where:{order_no:no},transaction,lock:transaction.LOCK.UPDATE});
 assert(order&&!order.is_deleted&&['已归档','archived','completed'].includes(order.order_status),'订单状态不符');
 const store=await M.Store.findByPk(order.store_id,{transaction});
 const period=await M.ExpenseAccountingPeriod.findOne({where:{distributor_id:store.distributor_id,month_key:'2026-10'},transaction,lock:transaction.LOCK.UPDATE});
 assert(!period||period.status==='open','10月已锁定');
 assert.equal(await M.BusinessActionLog.count({where:{business_id:order.order_id,comment:batch},transaction}),0,'本批次已执行');
 for(const [model,where]of [[M.SalesReturnRequest,{order_id:order.order_id}],[M.SalesReturnGrossProfitLedger,{order_id:order.order_id}],[M.SalesSettlementCostAdjustment,{sales_order_id:order.order_id}]])assert.equal(await model.count({where,transaction}),0,`${no}存在其他调整或退货`);
 const adjustments=await M.PerformanceProfitAdjustment.findAll({where:{order_id:order.order_id},transaction,lock:transaction.LOCK.UPDATE,raw:true});
 assert(adjustments.every(row=>row.status==='approved'&&row.adjustment_type==='increase'&&row.reason==='个人 CARE 可用金优先抵扣本单 CARE 商品成本'),'存在未核实的其他调整');
 const snapshot=await M.OrderGrossProfit.findOne({where:{order_id:order.order_id},transaction,lock:transaction.LOCK.UPDATE});
 assert(snapshot?.snapshot_status==='final'&&snapshot.formula_version===GP.FORMULA_VERSION,'非当前最终快照');
 const before=snapshot.toJSON(),lines=parse(before.product_pricing_details);
 const line=lines.find(row=>row.snCode===snCode);assert(line,'SN快照不匹配');
 equal(line.unitPricing,oldPrice,'当前计价已变化');equal(line.purchasePrice,price,'归档采购价不符');
 assert(!line.correctionId,'已有其他纠错');
 const item=await M.OrderItem.findOne({where:{order_id:order.order_id,item_id:line.itemId,sn_code:snCode},transaction,lock:transaction.LOCK.UPDATE});assert(item,'原销售行不存在');
 const sn=await M.ProductSn.findOne({where:{sn_id:item.sn_id,sn_code:snCode,product_id:item.product_id,is_deleted:0},transaction});
 assert(sn,'找不到原SN');equal(sn.inbound_price,price,'SN实际采购成本已变化');
 assert(order.archive_time&&sn.inbound_time&&new Date(sn.inbound_time)<=new Date(order.archive_time),'SN入库已变化');
 const beforeValues=calculate(before,lines,order.invoice_status);
 for(const [stored,key]of Object.entries({product_pricing_amount:'productPricingAmount',payment_fee_amount:'paymentFeeAmount',vat_amount:'vatAmount',vat_taxable_amount:'vatTaxableAmount',supplement_amount:'supplementAmount',freight_cost_amount:'freightCostAmount',gross_profit_amount:'grossProfitAmount'}))equal(before[stored],beforeValues[key],`原快照无法复算:${stored}`);
 assert.equal(beforeValues.externalAdjustmentFee,0,'已有外调费，避免重复');
 assert(Number(line.grossProfitUpliftAmount)===200||Number(sn.gross_profit_uplift_amount)===200,'外调额度依据不符');
 const next=lines.map(row=>row!==line?row:{...row,unitPricing:price,pricingAmount:GP.roundMoney(price*row.quantity),isCompanyPriced:false,
  source:'approved_purchase_price_correction',costModeSnapshot:'PURCHASE_PRICE',correctionId:batch,
  grossProfitUpliftAmount:200,externalAdjustmentEligible:true,externalAdjustmentRuleVersion:'SUPPLIER_UPLIFT_V3'});
 const values=calculate(before,next,order.invoice_status);
 equal(values.externalAdjustmentFee,200,'不满足外调费原门槛');
 equal(values.freightCostAmount,before.freight_cost_amount,'运费不得变化');
 const settlement=await M.ProductSettlementOrder.findOne({where:{source_order_id:order.order_id},transaction,lock:transaction.LOCK.UPDATE});assert(settlement,'缺产品结算');
 const settlementItems=await M.ProductSettlementItem.findAll({where:{settlement_id:settlement.settlement_id},transaction,lock:transaction.LOCK.UPDATE});
 const settlementItem=settlementItems.find(row=>String(row.source_order_item_id)===String(line.itemId));assert(settlementItem,'产品结算行不存在');
 equal(settlementItem.product_unit_price,oldPrice,'产品端当前计价与原快照不一致');
 // Only pricing corrections change the product settlement; external fees are sales-side deductions.
 const product=oldPrice===price?null:C.productPatch(settlementItems.map(row=>row.toJSON()),line.itemId,price);
 if(product)product.items.find(row=>String(row.source_order_item_id)===String(line.itemId)).product_price_source='approved_purchase_price_correction';
 if(product)equal(product.summary.purchase_cost_amount,settlement.purchase_cost_amount,'实际采购成本不得变化');
 return {order,snapshot,item,sn,settlement,settlementItems,settlementItem,before,lines,next,values,product,adjustments,
  summary:{订单号:no,门店:store.name,SN:snCode,原计价:oldPrice,纠正计价:price,运费:Number(before.freight_cost_amount),补计外调费:200,
   原销售毛利:Number(before.gross_profit_amount),新销售毛利:values.grossProfitAmount,
   原产品毛利:Number(settlement.gross_profit_amount),新产品毛利:product?product.summary.gross_profit_amount:Number(settlement.gross_profit_amount)}};
}
async function run(){
 fs.mkdirSync(directory,{recursive:true});
 const apply=process.argv.includes('--apply');
 const verifyOnly=process.argv.includes('--verify');
 const summaries=verifyOnly?JSON.parse(fs.readFileSync(path.join(directory,'preview.json'),'utf8')).summaries:await M.sequelize.transaction(async transaction=>{
  const plans=[];
  for(const target of targets)plans.push(await plan(target,transaction));
  if(apply){
   for(const p of plans){
    fs.writeFileSync(path.join(directory,`${p.order.order_no}.json`),JSON.stringify({batch,order:p.order.toJSON(),snapshot:p.before,item:p.item.toJSON(),sn:p.sn.toJSON(),settlement:p.settlement.toJSON(),settlementItems:p.settlementItems.map(row=>row.toJSON()),adjustments:p.adjustments,after:p.values,product:p.product},null,2),{flag:'wx'});
    await p.snapshot.update({product_pricing_details:p.values.productPricingDetails,product_pricing_amount:p.values.productPricingAmount,
     vat_taxable_amount:p.values.vatTaxableAmount,vat_amount:p.values.vatAmount,gross_profit_amount:p.values.grossProfitAmount,
     calculated_by:batch,calculated_at:new Date(),update_time:new Date()},{transaction});
    if(p.product){
     const after=p.product.items.find(row=>String(row.source_order_item_id)===String(p.item.item_id));
     await p.settlementItem.update({product_unit_price:after.product_unit_price,product_price_source:after.product_price_source,gross_profit_amount:after.gross_profit_amount},{transaction});
     await p.settlement.update({...p.product.summary,update_time:new Date()},{transaction});
     await p.item.update({sales_settlement_cost:after.product_unit_price,sales_gross_profit:GP.roundMoney(Number(p.item.subtotal)-after.product_unit_price*Number(p.item.quantity))},{transaction});
    }
    await recordBusinessAction({businessType:'sales_order',businessId:p.order.order_id,businessNo:p.order.order_no,action:'correct_external_pricing',
     user:{name:'User confirmation via Codex chat'},comment:batch,transaction,
     detail:{authorization:'用户确认除ORD202610190158486358外其余9单按采购价参考及原外调费规则纠正',batch,...p.summary,freightPreserved:true}});
   }
  }
  return plans.map(p=>p.summary);
 });
 if(apply||verifyOnly)for(const s of summaries){
  const backup=JSON.parse(fs.readFileSync(path.join(directory,`${s.订单号}.json`),'utf8'));
  const snapshot=await M.OrderGrossProfit.findOne({where:{order_id:backup.order.order_id},raw:true});
  equal(snapshot.gross_profit_amount,s.新销售毛利);equal(snapshot.freight_cost_amount,s.运费);
  assert.deepEqual(snapshot.supplement_details,backup.snapshot.supplement_details,'运费明细及补录不得变化');
  const forced=await GP.calculateAndSaveOrderGrossProfit(backup.order.order_id,{force:true,persist:false});
  equal(forced.gross_profit_amount,s.新销售毛利,'强制重算不应覆盖纠错');
  const settlement=await M.ProductSettlementOrder.findByPk(backup.settlement.settlement_id,{raw:true});equal(settlement.gross_profit_amount,s.新产品毛利);
  const sn=await M.ProductSn.findByPk(backup.sn.sn_id,{raw:true});assert.deepEqual(JSON.parse(JSON.stringify(sn)),backup.sn,'实际库存及采购成本不得变化');
  const adjustments=await M.PerformanceProfitAdjustment.findAll({where:{order_id:backup.order.order_id},raw:true});assert.deepEqual(JSON.parse(JSON.stringify(adjustments)),backup.adjustments,'原审批调整不得变化');
  const order=await M.Order.findByPk(backup.order.order_id,{raw:true});assert.deepEqual(JSON.parse(JSON.stringify(order)),backup.order,'原销售单收付款及状态不得变化');
 }
 const result={batch,mode:apply||verifyOnly?'applied':'preview',count:summaries.length,externalFees:1800,salesProfitDelta:GP.roundMoney(summaries.reduce((sum,s)=>sum+s.新销售毛利-s.原销售毛利,0)),summaries};
 fs.writeFileSync(path.join(directory,apply||verifyOnly?'result.json':'preview.json'),JSON.stringify(result,null,2));
 const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(summaries),'纠正结果');XLSX.writeFile(wb,path.join(directory,apply||verifyOnly?'九单计价及外调费纠正结果.xlsx':'preview.xlsx'));
 console.log(JSON.stringify(result));
}
run().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>M.sequelize.close());
