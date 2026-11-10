const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const M=require('../src/models'),S=require('../src/modules/report/productCostSupplement');
const orderId='eb49d710fde44539ac28d53f80880653',itemId=5831,settlementId='082692c45e3b401bbec4a90fd964d8b1';
const batch='USER-ZERO-STYLUS-20261110-46793',dir=path.resolve(__dirname,'../backup/order-corrections',batch);
const plain=v=>JSON.parse(JSON.stringify(v));
async function facts(){
 const [order,items,gp,settlement,settlementItems,adjustments]=await Promise.all([
  M.Order.findByPk(orderId,{raw:true}),M.OrderItem.findAll({where:{order_id:orderId},order:[['item_id','ASC']],raw:true}),
  M.OrderGrossProfit.findOne({where:{order_id:orderId},raw:true}),M.ProductSettlementOrder.findByPk(settlementId,{raw:true}),
  M.ProductSettlementItem.findAll({where:{settlement_id:settlementId},order:[['settlement_item_id','ASC']],raw:true}),
  M.ProductSettlementAdjustment.findAll({where:{source_order_id:orderId},order:[['adjustment_id','ASC']],raw:true})]);
 const returnItems=await M.ProductSettlementAdjustmentItem.findAll({where:{adjustment_id:adjustments.map(x=>x.adjustment_id)},order:[['adjustment_item_id','ASC']],raw:true});
 return plain({order,items,gp,settlement,settlementItems,adjustments,returnItems});
}
function ctx(body){return{params:{settlementId},request:{body},state:{user:{name:'用户明确确认剩余手写笔零成本（本会话授权）',roles:['boss'],accessibleStoreIds:['*'],accessibleDistributorIds:['*']}},throw(status,message){throw Object.assign(new Error(message),{status})}}}
(async()=>{
 const before=await facts();assert.equal(before.order.order_no,'ORD202610200254535940');
 const item=before.settlementItems.find(x=>x.settlement_item_id===itemId);assert(item);assert.equal(String(item.source_order_item_id),'46793');assert.equal(item.pn_code,'ZG38C07820');assert.equal(Number(item.product_unit_price),380);
 if(item.cost_status==='ready'&&item.cost_source==='manual_sold_cost'&&Number(item.purchase_unit_cost)===0){console.log(JSON.stringify({alreadyConfirmed:true,orderNo:before.order.order_no}));return;}
 assert.equal(item.cost_status,'pending');assert.equal(Number(item.purchase_unit_cost),0);
 const months=[...new Set([before.settlement.business_date,...before.adjustments.map(x=>x.business_date)].map(v=>new Date(new Date(v).getTime()+28800000).toISOString().slice(0,7)))];
 const closed=await M.sequelize.query('SELECT MONTH_KEY FROM T_FINANCIAL_PROFIT_PERIOD WHERE MONTH_KEY IN (:months)',{replacements:{months},type:M.sequelize.QueryTypes.SELECT});assert.equal(closed.length,0,'相关月份已关账');
 const body={items:[{itemId:String(itemId),unitCost:0,confirmZero:true}]},preview=ctx(body);await S.preview(preview);
 assert.equal(preview.body.data.items[0].after.product_unit_price,380);assert.equal(preview.body.data.items[0].after.cost_status,'ready');
 fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'before.json'),JSON.stringify({before,preview:preview.body.data},null,2),{flag:'wx'});
 const apply=ctx({...body,previewHash:preview.body.data.previewHash,reason:batch+'；用户明确要求剩余此项也调整为0成本；仅确认原商品实际零成本，原结算定价380元保持'});await S.apply(apply);
 const after=await facts();assert.deepEqual(after.order,before.order);assert.deepEqual(after.items,before.items);assert.deepEqual(after.gp,before.gp);
 const updated=after.settlementItems.find(x=>x.settlement_item_id===itemId);assert.equal(Number(updated.purchase_unit_cost),0);assert.equal(Number(updated.product_unit_price),380);assert.equal(updated.cost_status,'ready');
 const related=after.returnItems.filter(x=>String(x.source_order_item_id)==='46793');assert.equal(related.length,1);assert.equal(Number(related[0].purchase_unit_cost),0);assert.equal(related[0].cost_status,'ready');assert.equal(Number(related[0].gross_profit_amount),-380);
 assert.equal(after.settlement.status,'posted');for(const a of after.adjustments)assert.equal(a.status,'posted');
 const result={batch,verified:true,orderNo:after.order.order_no,product:item.product_name,unitCost:0,unitPrice:380,saleProductProfit:after.settlement.gross_profit_amount,returnProductProfit:after.adjustments.map(a=>({returnNo:a.source_return_no,profit:a.gross_profit_amount})),salesSnapshotUnchanged:true};
 fs.writeFileSync(path.join(dir,'verified.json'),JSON.stringify({result,after,application:apply.body.data},null,2));console.log(JSON.stringify(result,null,2));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>M.sequelize.close());
