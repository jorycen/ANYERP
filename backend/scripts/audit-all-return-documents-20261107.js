const M=require('../src/models'),V=require('../src/modules/sales/purchaseVat'),fs=require('node:fs'),path=require('node:path');
const dir=path.resolve(__dirname,'../backup/order-corrections/RETURN-TAX-FULL-20261107');
async function main(){
 const returns=await M.SalesReturnRequest.findAll({where:{status:'completed'},raw:true});
 const items=await M.SalesReturnRequestItem.findAll({raw:true}),report=[];
 const receipts=await M.sequelize.query(`SELECT i.SOURCE_NO returnNo,ii.PRODUCT_ID productId,ii.UNIT_PRICE cost FROM T_INBOUND i JOIN T_INBOUND_ITEM ii ON ii.INBOUND_ID=i.INBOUND_ID WHERE LOWER(i.SOURCE_TYPE)='sales_return' AND i.STATUS='completed'`,{type:M.sequelize.QueryTypes.SELECT});
 for(const ret of returns){for(const item of items.filter(x=>x.return_id===ret.return_id)){
  const costs=[...new Set(receipts.filter(x=>x.returnNo===ret.return_no&&x.productId===item.product_id).map(x=>x.cost).filter(x=>x!==null))];
  const line={itemId:item.order_item_id,productId:item.product_id,productName:item.product_name,pnCode:item.pn_code,snCode:item.sn_code||'',purchasePrice:costs.length===1?Number(costs[0]):null,quantity:Number(item.quantity),pricingOrigin:{sourceType:'sales_return',sourceNo:ret.return_no,returnItemId:item.item_id}};
  const order={order_status:'已归档',store_id:ret.store_id,archive_time:ret.complete_time||ret.update_time||ret.create_time};
  const resolved=(await V.resolveDocumentTaxBasis(order,[line]))[0];
  report.push({returnNo:ret.return_no,returnId:ret.return_id,returnItemId:item.item_id,originalItemId:item.order_item_id,product:item.product_name,productId:item.product_id,pn:item.pn_code,service:V.isService(line),basis:resolved.purchaseTaxBasis});
 }}
 fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'all-return-documents.json'),JSON.stringify(report,null,2));
 const pending=report.filter(x=>!x.service&&x.basis?.status!=='confirmed');console.log(JSON.stringify({returnOrders:returns.length,returnItems:report.length,service:report.filter(x=>x.service).length,confirmed:report.filter(x=>!x.service&&x.basis?.status==='confirmed').length,pending:pending.length,pendingReturnOrders:new Set(pending.map(x=>x.returnNo)).size,reasons:pending.reduce((a,x)=>{const k=x.basis?.reason||'unknown';a[k]=(a[k]||0)+1;return a;},{})}));
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>M.sequelize.close());
