const M=require('../src/models'),G=require('../src/modules/sales/grossProfit'),V=require('../src/modules/sales/purchaseVat'),F=require('../src/modules/inventory/foundation'),fs=require('node:fs'),path=require('node:path');
const dir=path.resolve(__dirname,'../backup/order-corrections/RETURN-TAX-FULL-20261107');
async function main(){
 fs.mkdirSync(dir,{recursive:true});
 const snapshots=await M.OrderGrossProfit.findAll({raw:true}),jobs=new Map();
 for(const s of snapshots){const lines=typeof s.product_pricing_details==='string'?JSON.parse(s.product_pricing_details):s.product_pricing_details||[];if(lines.some(l=>l.pricingOrigin?.sourceType==='sales_return'))jobs.set(s.order_id,{snapshot:s,lines});}
 const drafts=await M.Order.findAll({where:{order_status:'未归档',is_deleted:0},raw:true});
 for(const o of drafts){const lines=await G.buildProductPricingDetails(o.order_id);if(lines.some(l=>l.pricingOrigin?.sourceType==='sales_return'))jobs.set(o.order_id,{lines,snapshot:snapshots.find(s=>s.order_id===o.order_id)});}
 const report=[];
 for(const [orderId,job] of jobs){const o=await M.Order.findByPk(orderId,{raw:true});if(!o||o.is_deleted)continue;const candidates=job.lines.filter(l=>l.pricingOrigin?.sourceType==='sales_return');const attached=await F.salesBasis(o,candidates);const resolved=await V.resolveDocumentTaxBasis(o,attached);
 for(let i=0;i<candidates.length;i++){const l=candidates[i],r=resolved[i],b=r.purchaseTaxBasis;report.push({orderId,orderNo:o.order_no,status:o.order_status,itemId:l.itemId,productId:l.productId,name:l.productName,pn:l.pnCode,returnNo:l.pricingOrigin.sourceNo,service:V.isService(l),before:l.purchaseTaxBasis||null,after:b,basisId:r.inventoryFoundation?.basisId||null,hadSnapshot:!!job.snapshot,line:r});}}
 fs.writeFileSync(path.join(dir,'audit.json'),JSON.stringify(report,null,2));const pending=report.filter(r=>r.after?.status!=='confirmed'&&!r.service);const fixed=report.filter(r=>r.before?.status!=='confirmed'&&r.after?.status==='confirmed'&&!r.service);console.log(JSON.stringify({orders:new Set(report.map(r=>r.orderNo)).size,lines:report.length,service:report.filter(r=>r.service).length,confirmed:report.filter(r=>!r.service&&r.after?.status==='confirmed').length,newlyResolvable:fixed.length,pending:pending.length,pendingOrders:new Set(pending.map(r=>r.orderNo)).size,pending:pending.map(({orderNo,name,after})=>({orderNo,name,reason:after?.reason})),newlyResolvableDetails:fixed.map(({orderNo,name,after})=>({orderNo,name,source:after.source}))}));
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>M.sequelize.close());
