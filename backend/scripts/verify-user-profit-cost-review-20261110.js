const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),Module=require('node:module'),cp=require('node:child_process');
const M=require('../src/models');
const dir=path.resolve(__dirname,'../backup/order-corrections/USER-PRODUCT-COST-20261110-6229c06e44');
const snapshot=x=>JSON.parse(JSON.stringify(x));
(async()=>{
 const result=JSON.parse(fs.readFileSync(path.join(dir,'result.json'),'utf8'));
 let verifiedItems=0;
 for(const applied of result.applied){
  const row=applied.rows[0],item=await M.ProductSettlementItem.findByPk(row.itemId,{raw:true});
  const s=await M.ProductSettlementOrder.findByPk(item.settlement_id,{raw:true});
  const before=JSON.parse(fs.readFileSync(path.join(dir,item.settlement_id+'.before.json'),'utf8')).before;
  const [o,oi,gp,allItems,adjustments]=await Promise.all([
   M.Order.findByPk(s.source_order_id,{raw:true}),M.OrderItem.findAll({where:{order_id:s.source_order_id},order:[['item_id','ASC']],raw:true}),
   M.OrderGrossProfit.findOne({where:{order_id:s.source_order_id},raw:true}),
   M.ProductSettlementItem.findAll({where:{settlement_id:s.settlement_id},raw:true}),
   M.ProductSettlementAdjustment.findAll({where:{source_order_id:s.source_order_id},raw:true})]);
  assert.deepEqual(snapshot(o),before.order);assert.deepEqual(snapshot(oi),before.items);assert.deepEqual(snapshot(gp),before.snap);
  for(const r of applied.rows){const i=allItems.find(x=>String(x.settlement_item_id)===r.itemId);assert.equal(Number(i.purchase_unit_cost),r.unitCost);assert.equal(Number(i.product_unit_price),Number(r.beforePrice));verifiedItems++;}
  const summary=require('../src/modules/report/productCostSupplement').summaryPatch(allItems);
  assert.equal(Number(s.gross_profit_amount),summary.gross_profit_amount);assert.equal(s.status,summary.status);
  for(const a of adjustments){const items=await M.ProductSettlementAdjustmentItem.findAll({where:{adjustment_id:a.adjustment_id},raw:true});const sum=require('../src/modules/report/productCostSupplement').summaryPatch(items);assert.equal(Number(a.gross_profit_amount),sum.gross_profit_amount);assert.equal(a.status,sum.status);}
 }
 const confirmed=await M.ProductSettlementItem.findAll({where:{settlement_item_id:result.alreadyConfirmed.map(r=>r.itemId)},raw:true});
 for(const r of result.alreadyConfirmed){const item=confirmed.find(i=>String(i.settlement_item_id)===r.itemId);assert(item);assert.equal(Number(item.purchase_unit_cost),r.unitCost);}
 const file=require.resolve('../src/modules/report/financialProfitEngine'),engine=new Module(file,module);engine.filename=file;engine.paths=Module._nodeModulePaths(path.dirname(file));require.cache[file]=engine;
 engine._compile(cp.execFileSync('git',['show','HEAD:backend/src/modules/report/financialProfitEngine.js'],{encoding:'utf8'}),file);engine.loaded=true;
 const stores=await M.Store.findAll({where:{is_deleted:0,status:1},raw:true});
 const report=await require('../src/modules/report/financialProfitController').queryFinancialProfit({storeIds:stores.map(x=>x.store_id),startDate:'2026-10-01',endDate:'2026-10-31',includeStores:true});
 const pending=report.profitDetails.filter(x=>x.profitStatus==='pending');
 const output={verified:true,verifiedItems,appliedOrders:result.applied.length,alreadyConfirmed:result.alreadyConfirmed.length,failed:result.failed.length,skipped:result.skipped,
  report:{beforePending:369,afterPending:pending.length,salesPending:pending.filter(x=>x.salesGrossProfit==null).length,productPending:pending.filter(x=>x.productGrossProfit==null).length,
   stores:report.storeSummaries.filter(x=>x.summary.profitPendingCount>0).map(x=>({store:x.storeName,count:x.summary.profitPendingCount}))}};
 fs.writeFileSync(path.join(dir,'independent-verification.json'),JSON.stringify(output,null,2));console.log(JSON.stringify(output,null,2));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>M.sequelize.close());
