const crypto=require('node:crypto');
const {Op}=require('sequelize');
const M=require('../../models');
const C=require('./commissionConfig');
const {sendExcel}=require('../../utils/excelExport');
const headers=['问题编号','数据核对指纹','开始日期','结束日期','报表分类','员工编号','员工','当前门店编号','当前门店','角色','问题月份','原销售月份','业务单号','原销售单号','原销售门店编号','原销售门店','商品','PN','SN','原商品行编号','原销售记录编号','退单记录编号','具体原因','影响字段','建议处理方式','请填确认归属门店','请填确认月份','请填盈亏平衡线或提成基数','请填补充数据及依据说明','请填确认处理意见'];
function advice(reason){
 if(reason.includes('盈亏平衡线'))return ['个人销售提成、绩效合计','补充原因所指原月份、原门店的盈亏平衡线及依据；不要用当前月代替。'];
 if(reason.includes('提成基数'))return ['个人销售提成、绩效合计','确认该员工问题月份的个人提成基数。'];
 if(reason.includes('门店不一致')||reason.includes('门店未匹配'))return ['阶段归属、个人销售提成、绩效合计','确认原销售门店、任职月份及应采用的门店阶段；提供调店或任职依据，不直接修改原销售单。'];
 if(reason.includes('费用'))return ['阶段费用、个人销售提成、绩效合计','补充费用分摊单及所属阶段依据；不自行将未知费用归属置零。'];
 if(reason.includes('产品端'))return ['产品端毛利','核对原产品结算的成本、定价及冻结依据，填写需补资料和依据单号。'];
 return ['毛利或提成核算','核实所列原销售/退单冻结记录、日期和分摊依据，填写确认意见；已有资料由系统修复，勿猜测价格或阶段。'];
}
async function buildRows(user,query,data){
 const chosen=data.rows.filter(r=>(!query.reviewRowKey||r.reviewKey===query.reviewRowKey)&&(r.issues||[]).length);
 const ids=[...new Set(chosen.flatMap(r=>r.issues.map(i=>i.sourceOrderId||i.orderId)).filter(x=>x&&!String(x).includes(':')).map(String))];
 const [orders,items,stores]=await Promise.all([
  ids.length?M.Order.findAll({where:{order_id:{[Op.in]:ids}},attributes:['order_id','order_no','store_id','create_time','archive_time','update_time'],raw:true}):[],
  ids.length?M.OrderItem.findAll({where:{order_id:{[Op.in]:ids}},attributes:['order_id','item_id','product_name','pn_code','sn_code'],raw:true}):[],C.scope(user)
 ]);
 const names=new Map(stores.map(s=>[String(s.store_id),s.name])),out=[],seen=new Set();
 for(const order of orders)for(const key of ['create_time','archive_time'])if(order[key] instanceof Date)order[key]=new Date(order[key].getTime()+28800000).toISOString();
 for(const row of chosen)for(const issue of row.issues){
  const sourceId=String(issue.sourceOrderId||issue.orderId||''),order=orders.find(o=>String(o.order_id)===sourceId);
  const lines=items.filter(i=>String(i.order_id)===sourceId);
  for(const item of lines.length?lines:[{}]){
   const identity={version:1,staffId:String(row.staffId||''),side:row.sideName,storeId:row.storeId,month:issue.month,reason:issue.reason,sourceId,orderNo:issue.orderNo||'',returnId:issue.returnId||'',itemId:item.item_id||''};
   const key=crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');if(seen.has(key))continue;seen.add(key);
   const fingerprint=crypto.createHash('sha256').update(JSON.stringify({identity,order,item,gross:row.grossProfit,base:row.commissionBase,line:row.breakEvenLine})).digest('hex');
   const [affected,suggestion]=advice(issue.reason);
   out.push({'问题编号':key,'数据核对指纹':fingerprint,'开始日期':query.startDate,'结束日期':query.endDate,'报表分类':data.reportRole,'员工编号':String(row.staffId||''),'员工':row.employeeName,'当前门店编号':row.storeId,'当前门店':row.storeName,'角色':row.role,'问题月份':issue.month||'','原销售月份':issue.originalMonth||String(order?.archive_time||order?.create_time||'').slice(0,7),'业务单号':issue.orderNo||'','原销售单号':issue.sourceOrderNo||order?.order_no||'','原销售门店编号':issue.originalStoreId||order?.store_id||'','原销售门店':names.get(String(issue.originalStoreId||order?.store_id||''))||'','商品':item.product_name||'','PN':item.pn_code||'','SN':item.sn_code||'','原商品行编号':String(item.item_id||''),'原销售记录编号':sourceId,'退单记录编号':issue.returnId||'','具体原因':issue.reason,'影响字段':affected,'建议处理方式':suggestion,'请填确认归属门店':'','请填确认月份':'','请填盈亏平衡线或提成基数':'','请填补充数据及依据说明':'','请填确认处理意见':''});
  }
 }
 return out;
}
async function exportReview(ctx,data){
 const rows=await buildRows(ctx.state.user,ctx.query,data);
 const columnWidths=Object.fromEntries(headers.map(h=>[h,h.startsWith('请填')?36:24]));
 Object.assign(columnWidths,{'具体原因':70,'建议处理方式':70,'商品':45,'问题编号':36,'数据核对指纹':36});
 sendExcel(ctx,rows,headers,'毛利待核算需补资料清单.xlsx','待核算清单',{textHeaders:headers,columnWidths,autoFilter:true,sheets:[{name:'填写说明',columnWidths:[110],rows:[{说明:'系统信息列请勿修改；仅填写“请填”开头的栏目。价格、SN和记录编号保持文本。'},{说明:'商品信息为关联原单商品，供核对定位；阶段/配置问题不代表这些商品本身有错误。'},{说明:'填写后上传本聊天，先按编号与核对指纹复核当前资料，再预览处理方案；此文件不自动回写系统。'},{说明:rows.length?'不确定请保留空白，不要以0代替未知。':'当前筛选无需要补充的核算问题；产品/运营提成待定不纳入资料缺失。'}]}]});
}
module.exports={headers,advice,buildRows,exportReview};
