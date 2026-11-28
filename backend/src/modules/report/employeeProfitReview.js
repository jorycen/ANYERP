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
   const identity={version:3,staffId:String(row.staffId||''),side:row.sideName,storeId:row.storeId,month:issue.month,basisMonth:issue.basisMonth,originalMonth:issue.originalMonth,originalStoreId:issue.originalStoreId,from:issue.from,to:issue.to,reason:issue.reason,sourceId,orderNo:issue.orderNo||'',returnId:issue.returnId||'',itemId:item.item_id||''};
   const key=crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');if(seen.has(key))continue;seen.add(key);
   const fingerprint=crypto.createHash('sha256').update(JSON.stringify({identity,order,item,deduction:issue.reason.includes('费用')?row.expensePerformanceDeduction:undefined})).digest('hex');
   const [affected,suggestion]=advice(issue.reason);
   out.push({'问题编号':key,'数据核对指纹':fingerprint,'开始日期':query.startDate,'结束日期':query.endDate,'报表分类':data.reportRole,'员工编号':String(row.staffId||''),'员工':row.employeeName,'当前门店编号':row.storeId,'当前门店':row.storeName,'角色':row.role,'问题月份':issue.month||'','原销售月份':issue.originalMonth||String(order?.archive_time||order?.create_time||'').slice(0,7),'业务单号':issue.orderNo||'','原销售单号':issue.sourceOrderNo||order?.order_no||'','原销售门店编号':issue.originalStoreId||order?.store_id||'','原销售门店':names.get(String(issue.originalStoreId||order?.store_id||''))||'','商品':item.product_name||'','PN':item.pn_code||'','SN':item.sn_code||'','原商品行编号':String(item.item_id||''),'原销售记录编号':sourceId,'退单记录编号':issue.returnId||'','具体原因':issue.reason,'影响字段':affected,'建议处理方式':suggestion,'请填确认归属门店':'','请填确认月份':'','请填盈亏平衡线或提成基数':'','请填补充数据及依据说明':'','请填确认处理意见':''});
   Object.assign(out.at(-1),{'任期开始':issue.from||'','任期结束':issue.to||'','核算依据月份':issue.basisMonth||''});
  }
 }
 return out;
}
async function exportReview(ctx,data){
 const groups=compact(await buildRows(ctx.state.user,ctx.query,data)),rows=groups.map(g=>g.row);
 const visible=['序号','员工','门店','月份','问题','关联单号','建议','需补字段','确认值','生效开始','生效结束','依据说明'];
 if(rows.some(r=>r.SN||r.商品))visible.splice(6,0,'商品','SN');
 sendExcel(ctx,rows.map(r=>Object.fromEntries(visible.map(h=>[h,r[h]??'']))),visible,'毛利待核算需补资料清单.xlsx','待核算清单',{textHeaders:visible,columnWidths:{问题:55,建议:55,关联单号:35,依据说明:40},autoFilter:true,sheets:[
  {name:'填写说明',columnWidths:[110],rows:[{说明:'只填写确认值、任期生效开始/结束、依据说明。月度基数填写金额；历史店长填写员工编号或唯一姓名。'},{说明:'同一店铺月份可复制同一序号行填写不同店长的互不重叠任期；结束日期不包含在任期内。'},{说明:'上传页面先预览再确认。仅明确的基数和历史任期可自动保存；单据、价格等问题仅记录待人工处理，不自动改历史单。'},{说明:'隐藏的系统校验页请保留。资料过期请重新下载；空白不覆盖，0代表明确零金额。'}]},
  {name:'系统校验',hidden:true,rows:groups.map(g=>{
   const meta={版本:'3',序号:g.row.序号,问题组:g.id,指纹:g.fingerprint,查询:JSON.stringify({startDate:ctx.query.startDate,endDate:ctx.query.endDate,reportRole:ctx.query.reportRole||'all',storeId:ctx.query.storeId||'',employeeId:ctx.query.employeeId||'',reviewRowKey:ctx.query.reviewRowKey||''}),原始栏位:JSON.stringify(Object.fromEntries(Object.entries(g.row).filter(([key])=>!['确认值','生效开始','生效结束','依据说明'].includes(key))))};
   return {...meta,校验签名:templateSignature(meta)};
  })}
 ]});
}
function typeOf(reason){return reason.includes('店长任职')?'managerHistory':reason.includes('盈亏平衡线')?'storeLine':reason.includes('提成基数')?'staffBase':'manual';}
function compact(rows){
 const groups=new Map();
 for(const source of rows){
  const type=typeOf(source.具体原因),month=type==='staffBase'?source.问题月份:source.核算依据月份||source.原销售月份||source.问题月份;
  const storeId=source.原销售门店编号||source.当前门店编号;
  const productIssue=/产品|商品|成本|票税|SN|定价/.test(source.具体原因);
  const identity={type,month,storeId,staffId:type==='staffBase'?source.员工编号:'',from:type==='managerHistory'?source.任期开始:'',to:type==='managerHistory'?source.任期结束:'',manual:type==='manual'?(productIssue?source.问题编号:[source.具体原因,source.原销售记录编号,source.业务单号].join('|')):''};
  const id=crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const group=groups.get(id)||{id,target:identity,sources:[],row:{员工:source.员工,门店:source.原销售门店||source.当前门店,月份:month,问题:type==='managerHistory'?'业务发生时的店长任职待确认':type==='storeLine'?'门店盈亏平衡线未配置':type==='staffBase'?'个人提成基数未配置':source.具体原因,建议:type==='managerHistory'?'填写业务发生时的店长员工编号或唯一姓名及有效任期':source.建议处理方式,需补字段:type==='managerHistory'?'店长及任期':type==='manual'?'确认意见及依据':'金额',确认值:'',生效开始:type==='managerHistory'?`${month}-01`:'',生效结束:type==='managerHistory'?new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),1)).toISOString().slice(0,10):'',依据说明:'',商品:type==='manual'?source.商品:'',SN:type==='manual'?source.SN:''}};
  if(type==='managerHistory'){
   const local=value=>new Date(new Date(value).getTime()+28800000).toISOString().slice(0,19).replace('T',' ');
   if(source.任期开始)group.row.生效开始=local(source.任期开始);
   if(source.任期结束)group.row.生效结束=local(source.任期结束);
  }
  if(!productIssue){group.row.商品='';group.row.SN='';}
  if(type==='storeLine')group.row.员工='门店配置';
  group.sources.push(source);groups.set(id,group);
 }
 return [...groups.values()].map((g,i)=>{g.row.序号=`R${String(i+1).padStart(4,'0')}`;const refs=[...new Set(g.sources.flatMap(s=>[s.业务单号,s.原销售单号]).filter(Boolean))];g.row.关联单号=refs.slice(0,4).join('、')+(refs.length>4?` 等${refs.length}单`:'');g.fingerprint=crypto.createHash('sha256').update(JSON.stringify(g.target.type==='manual'?g.sources.map(s=>s.数据核对指纹).sort():g.target)).digest('hex');return g;});
}
function templateSignature(meta){return crypto.createHmac('sha256',require('../../config').jwt.secret).update('profit-review-template:'+JSON.stringify([String(meta.版本),String(meta.序号),meta.问题组,meta.指纹,meta.查询,meta.原始栏位])).digest('hex');}
module.exports={headers,advice,buildRows,exportReview,compact,typeOf,templateSignature};
