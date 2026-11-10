const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), cp = require('node:child_process');
const M = require('../src/models');
// Use committed reporting semantics, excluding unrelated working-tree repairs.
const file = require.resolve('../src/modules/report/financialProfitEngine');
const engine = new Module(file, module); engine.filename = file; engine.paths = Module._nodeModulePaths(path.dirname(file)); require.cache[file] = engine;
engine._compile(cp.execFileSync('git', ['show','HEAD:backend/src/modules/report/financialProfitEngine.js'], {encoding:'utf8'}), file); engine.loaded = true;
(async () => {
  const stores = await M.Store.findAll({where:{is_deleted:0,status:1},raw:true});
  const report = await require('../src/modules/report/financialProfitController').queryFinancialProfit({storeIds:stores.map(s=>s.store_id),startDate:'2026-10-01',endDate:'2026-10-31',includeStores:true});
  const pending = report.profitDetails.filter(x=>x.profitStatus==='pending');
  const ids = [...new Set(pending.map(x=>x.orderId).filter(Boolean))];
  const settlements = await M.ProductSettlementOrder.findAll({where:{source_order_id:ids},raw:true});
  const rows = pending.sort((a,b)=>String(a.storeName).localeCompare(String(b.storeName),'zh-CN')||a.businessDate.localeCompare(b.businessDate)).map(x=>{
    const parts = [['salesGrossProfit','销售端'],['productGrossProfit','产品端'],['operationsGrossProfit','运营端']].filter(([k])=>x[k]==null).map(([,v])=>v);
    const s = settlements.find(s=>s.source_order_id===x.orderId);
    const items = x.detailItems || [];
    return {eventKey:x.eventKey,orderId:x.orderId,entryNo:x.entryNo,orderNo:x.orderNo||'',store:x.storeName||'',date:x.businessDate,
      type:x.entryTypeLabel||x.entryType,sales:x.salesGrossProfit,product:x.productGrossProfit,operations:x.operationsGrossProfit,
      parts:parts.join('、'),reason:x.profitPendingReason||'',detailReason:x.pendingCostReason||'',
      settlementStatus:s?.status||'未找到原销售产品结算',
      products:items.map(i=>i.productName||i.itemId).join('；'),
      missingCostProducts:items.filter(i=>i.unitCost==null).map(i=>i.productName||i.itemId).join('；'),
      suggestion:parts.includes('销售端')?'核对退货毛利流水与原销售冻结快照，补齐退货销售端冲回依据。':'核对原销售产品结算及对应商品实际采购成本；退货同时核对原结算与产品端冲回状态。'};
  });
  const data={asOf:new Date().toISOString(),version:cp.execFileSync('git',['rev-parse','--short','HEAD'],{encoding:'utf8'}).trim(),rows,
    summary:report.storeSummaries.filter(s=>s.summary.profitPendingCount>0).map(s=>({store:s.storeName,count:s.summary.profitPendingCount})),
    total:rows.length,orders:new Set(rows.map(x=>x.orderId||x.orderNo).filter(Boolean)).size};
  const dir=path.resolve(__dirname,'../../outputs/october-profit-review-20261110');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'source.json'),JSON.stringify(data,null,2));
  console.log(JSON.stringify({total:data.total,orders:data.orders,stores:data.summary.length,product:rows.filter(x=>x.product==null).length,sales:rows.filter(x=>x.sales==null).length}));
})().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>M.sequelize.close());
