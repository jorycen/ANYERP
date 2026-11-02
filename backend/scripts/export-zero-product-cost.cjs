// Read-only export of zero purchase costs in historical product settlements.
const fs = require('node:fs'), path = require('node:path'), XLSX = require('xlsx');
const M = require('../src/models');
const { QueryTypes } = require('sequelize');
const china = value => value instanceof Date ? new Date(value.getTime()+28800000).toISOString().slice(0,19).replace('T',' ') : String(value || '');
async function main() {
  let rows = await M.sequelize.query(`SELECT i.SETTLEMENT_ITEM_ID itemId,s.SOURCE_ORDER_NO orderNo,
      s.SETTLEMENT_NO settlementNo,s.BUSINESS_DATE businessDate,st.NAME storeName,s.STORE_ID storeId,
      i.PRODUCT_ID productId,p.PRODUCT_CODE productCode,i.PRODUCT_NAME productName,i.PN_CODE pn,i.SN_CODE sn,
      i.QUANTITY quantity,i.PRODUCT_UNIT_PRICE pricing,i.PURCHASE_UNIT_COST purchaseCost,
      i.PURCHASE_COST_AMOUNT purchaseCostAmount,i.COST_STATUS costStatus,i.COST_SOURCE costSource,
      s.STATUS settlementStatus,oi.SUPPLIER_NAME supplierName
    FROM T_PRODUCT_SETTLEMENT_ITEM i
    JOIN T_PRODUCT_SETTLEMENT_ORDER s ON s.SETTLEMENT_ID=i.SETTLEMENT_ID
    JOIN T_ORDER o ON o.ORDER_ID=s.SOURCE_ORDER_ID
    LEFT JOIN T_STORE st ON st.STORE_ID=s.STORE_ID
    LEFT JOIN T_PRODUCT p ON p.PRODUCT_ID=i.PRODUCT_ID
    LEFT JOIN T_ORDER_ITEM oi ON oi.ITEM_ID=i.SOURCE_ORDER_ITEM_ID
    WHERE i.PURCHASE_UNIT_COST=0 AND o.IS_DELETED=0
      AND o.ORDER_STATUS IN ('已归档','completed','archived')
    ORDER BY s.BUSINESS_DATE DESC,s.SOURCE_ORDER_NO,i.SETTLEMENT_ITEM_ID`, { type: QueryTypes.SELECT });
  const onlyStock = process.argv.includes('--in-stock');
  let stock = [];
  const stockByProduct = new Map(), currentCost = new Map();
  if (onlyStock && rows.length) {
    const ids = [...new Set(rows.map(row => row.productId))];
    stock = await M.sequelize.query(`SELECT v.PRODUCT_ID productId,p.PRODUCT_CODE code,p.NAME name,s.NAME storeName,
      v.STORE_ID storeId,l.NAME locationName,v.NORMAL_QTY sales,v.DISPLAY_QTY display,v.DEMO_QTY demo,
      v.RENTAL_DEMO_QTY rental,v.UNSELLABLE_QTY unsellable,
      COALESCE(v.NORMAL_QTY,0)+COALESCE(v.DISPLAY_QTY,0)+COALESCE(v.DEMO_QTY,0)+COALESCE(v.RENTAL_DEMO_QTY,0)+COALESCE(v.UNSELLABLE_QTY,0) stockQuantity
      FROM T_INVENTORY v JOIN T_PRODUCT p ON p.PRODUCT_ID=v.PRODUCT_ID
      LEFT JOIN T_STORE s ON s.STORE_ID=v.STORE_ID LEFT JOIN T_LOCATION l ON l.LOCATION_ID=v.LOCATION_ID
      WHERE v.PRODUCT_ID IN (:ids) AND p.IS_DELETED=0
      HAVING stockQuantity>0`,{replacements:{ids},type:QueryTypes.SELECT});
    for(const row of stock) stockByProduct.set(row.productId,(stockByProduct.get(row.productId)||0)+Number(row.stockQuantity));
    const prices=await M.ProductPrice.findAll({where:{product_id:[...stockByProduct.keys()]},attributes:['product_id','cost_price'],raw:true});
    for(const row of prices)currentCost.set(row.product_id,row.cost_price==null?null:Number(row.cost_price));
    rows=rows.filter(row=>stockByProduct.has(row.productId));
  }
  const workbook = XLSX.utils.book_new();
  const headers = ['订单号','结算单号','经营日期','门店','商品编码','商品名称','PN','SN','数量','产品结算定价','采购单价','采购成本金额','成本确认状态','整单结算状态','成本来源','原单供应商','商品ID','结算明细ID'];
  const detail = rows.map(row => ({
    订单号:row.orderNo,结算单号:row.settlementNo,经营日期:china(row.businessDate),门店:row.storeName || row.storeId,
    商品编码:row.productCode || '',商品名称:row.productName,PN:row.pn || '',SN:row.sn || '',数量:Number(row.quantity),
    产品结算定价:Number(row.pricing),采购单价:Number(row.purchaseCost),采购成本金额:row.purchaseCostAmount == null ? '未填写' : Number(row.purchaseCostAmount),
    成本确认状态:row.costStatus==='ready'?'已确认零成本':'待确认',整单结算状态:row.settlementStatus,
    成本来源:row.costSource || '',原单供应商:row.supplierName || '未记录',商品ID:row.productId,结算明细ID:String(row.itemId)
  }));
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.productId}|${row.pn || ''}`;
    if (!groups.has(key)) groups.set(key,{商品编码:row.productCode || '',商品名称:row.productName,PN:row.pn || '',零成本明细数:0,
      商品数量:0,待确认明细数:0,已确认零成本明细数:0,orders:new Set(),stores:new Set(),sns:new Set(),商品ID:row.productId});
    const group=groups.get(key); group.零成本明细数++;group.商品数量+=Number(row.quantity);
    if(row.costStatus==='ready')group.已确认零成本明细数++;else group.待确认明细数++;
    group.orders.add(row.orderNo);group.stores.add(row.storeName || row.storeId);if(row.sn)group.sns.add(row.sn);
  }
  const summary = [...groups.values()].sort((a,b)=>b.待确认明细数-a.待确认明细数 || b.零成本明细数-a.零成本明细数).map(({orders,stores,sns,...row})=>({...row,
    ...(onlyStock?{当前库存数量:stockByProduct.get(row.商品ID),当前商品主档成本:currentCost.get(row.商品ID)??'未维护',当前库存门店:[...new Set(stock.filter(item=>item.productId===row.商品ID).map(item=>item.storeName||item.storeId))].join('、')}:{}),
    涉及订单数:orders.size,涉及SN数:sns.size,涉及门店:[...stores].join('、')}));
  const pending=detail.filter(row=>row.成本确认状态==='待确认'),known=detail.filter(row=>row.成本确认状态==='已确认零成本');
  const now=china(new Date());
  function append(name,data,cols) {
    const sheet=XLSX.utils.json_to_sheet(data,cols?{header:cols}:{});
    sheet['!autofilter']={ref:sheet['!ref'] || 'A1:A1'};
    const names=cols || Object.keys(data[0] || {});
    sheet['!cols']=names.map(name=>({wch:['商品名称','涉及门店','成本来源'].includes(name)?44:name.includes('单号')?28:18}));
    XLSX.utils.book_append_sheet(workbook,sheet,name);
  }
  append('导出口径',[
    {项目:'导出时间（北京时间）',内容:now},
    {项目:'数据范围',内容:'全部已归档、未删除且存在产品端结算记录的订单，不限日期、门店；不限整单结算状态。'},
    {项目:'零成本条件',内容:'产品端结算明细采购单价严格等于0；不把未填写NULL当作0。'},
    {项目:'口径说明',内容:'为刚才排查的历史产品端采购成本，非商品主档当前成本，非当前在库SN成本。客户获赠不自动代表采购成本为0。'},
    {项目:'当前库存筛选',内容:onlyStock?'在上一份历史零采购成本清单基础上，仅保留当前有库存的商品。库存为销售仓、铺货仓、样机仓、租赁样机仓及不可售仓合计，不含待入库。当前商品成本另列，可能已不为0。':'未筛选当前库存'},
    {项目:'确认状态',内容:'按已保存产品端明细cost_status，ready列为已确认零成本，其余列为待确认；不自动确认或更改历史金额。'},
    {项目:'商品汇总粒度',内容:'商品ID＋PN；明细数为结算商品行数，数量另列，SN/订单按去重统计。'},
    {项目:'商品种数（按商品ID去重）',内容:new Set(rows.map(row=>row.productId)).size},
    {项目:'商品与PN组合数',内容:summary.length},
    {项目:'全部零成本明细行数',内容:detail.length},
    {项目:'待确认明细行数',内容:pending.length},
    {项目:'已确认零成本明细行数',内容:known.length},
    {项目:'涉及订单数',内容:new Set(rows.map(row=>row.orderNo)).size},
    {项目:'涉及SN数',内容:new Set(rows.map(row=>row.sn).filter(Boolean)).size}
  ]);
  append('商品汇总',summary);
  append('全部零成本明细',detail,headers);
  append('待确认明细',pending,headers);
  append('已确认零成本',known,headers);
  if(onlyStock)append('当前库存明细',stock.map(row=>({商品编码:row.code,商品名称:row.name,门店:row.storeName||row.storeId,库位:row.locationName||'',
    库存合计:Number(row.stockQuantity),销售仓:Number(row.sales||0),铺货仓:Number(row.display||0),样机仓:Number(row.demo||0),租赁样机仓:Number(row.rental||0),不可售仓:Number(row.unsellable||0),
    当前商品主档成本:currentCost.get(row.productId)??'未维护',商品ID:row.productId})));
  const directory=path.resolve(__dirname,'../backup/exports');fs.mkdirSync(directory,{recursive:true});
  const output=path.join(directory,onlyStock?'采购成本为0商品清单-仅有库存-20261029.xlsx':'采购成本为0商品清单-20261029.xlsx');
  XLSX.writeFile(workbook,output);
  const check=XLSX.readFile(output), exported=XLSX.utils.sheet_to_json(check.Sheets['全部零成本明细']);
  if(exported.length!==rows.length || exported.some(row=>row.采购单价!==0))throw Error('Export validation failed');
  if(pending.length+known.length!==rows.length)throw Error('Status counts mismatch');
  process.stdout.write(JSON.stringify({output,goods:new Set(rows.map(row=>row.productId)).size,productPnGroups:summary.length,rows:rows.length,
    pending:pending.length,confirmedZero:known.length,orders:new Set(rows.map(row=>row.orderNo)).size,sheets:check.SheetNames}));
}
main().catch(error=>{process.stderr.write(error.stack);process.exitCode=1;}).finally(()=>M.sequelize.close());
