# 技术人员API核查手册
核查日期2026-11-05，仅本地源码。生产域名、部署版本、现场返回、时区及员工权限均需联调【待确认】。
URL：管理员配置的HTTPS域名+下列完整路径。认证为Authorization: Bearer <员工安全凭证>，不得放进知识库、URL或聊天。
index.js挂载/api/v1，业务模块前有认证及门店中间件；各控制器还可能执行独立可见范围判断。
通常成功为code=0,data；分页data含list,total,page,pageSize，部分含totalPages/pagination。同时检查HTTP状态和业务code。
以下为候选复用清单，不是已批准白名单。

## GET /api/v1/product/list
参数keyword,categoryId,activeOnly,page,pageSize；activeOnly=1仅启用。
data.list包含product_id,product_code,name,config,category,manufacturer_code,manufacturer_codes,processor,memory,storage,gpu,need_sn,status,is_focus_product等。
还返回standard_price、extras、remark，需后台按员工权限投影，不能原样全传模型。
结论：候选复用基础资料，重点标记不代表主推排序。

## GET /api/v1/product/search
参数keyword（必需，空值返回空列表）,storeId,page,pageSize（默认10）。
返回商品、pn/pn_list、stock_qty,current_store_stock_qty,other_store_stock_qty,total_stock_qty,store_stock_info,sales_7_qty,sales_30_qty等，还包含成本及底价字段。
结论：候选复用商品检索；需门店范围核验及字段投影，搜索原顺序不能解释为经营主推排名。

## GET /api/v1/inventory/list
参数storeId,regionId,category,keyword,productType,modelFilter,stockOnly,page,pageSize。已确认modelFilter=focus对应商品重点标记，其他枚举不得猜测。
返回product_id,product_name,pn_code,normal_qty,regular_qty,subsidy_qty,second_qty,display_qty,demo_qty,unsellable_qty,pending_qty,rental_demo_qty,current_store_stock_qty,total_stock_qty等。
另含成本、毛利、供应商库存。getList有明确跨经销商/门店库存查询设计，不能假定员工Token天然限制仅本店。
结论：不能原样开放；先确认员工允许范围并由受控后台限制门店与字段，不擅自改变ERP已有政策。

## GET /api/v1/inventory/sn-inventory-list
参数keyword,storeId,locationId,status,resourceType,resourceStatus,specialOnly,minAgeDays,maxAgeDays,productType,sortBy,page,pageSize。
使用resolveAllReadableStoreIds并校验显式storeId，成本可见性另行判断。
结论：候选复用；返回字段、枚举、实际员工范围及投影待联调；不得自行按库龄生成主推榜。

## GET /api/v1/inventory/product-flow
参数storeId,direction（in/out）,keyword,startDate,endDate,page,pageSize（默认20，最大100）。
keyword匹配商品、PN、SN、单号、商品编码；没有独立操作人筛选参数。
日期取输入前10位，拼接00:00:00至23:59:59；建议YYYY-MM-DD，部署数据库时区与精度边界需核验。
响应code=0,data={list,total,page,pageSize}。
行字段flow_id,store_id,store_name,product_id,product_name,product_code,pn_code,sn_code,direction,business_type,quantity,document_no,event_time,operator_name。
由resolveAllReadableStoreIds限制范围；无权限门店列表返回空，显式越权门店返回403。
覆盖入库、销售/退货库存变化、批量出入库/调整、采购退库、调拨出库/退回、拆装及撤销等；由业务单据还原，不是所有业务行为审计。
结论：优先复用；完成身份、字段及范围验收后开放。

## GET /api/v1/inventory/sn-trace/:snCode
路径snCode，查询可选pnCode；SN应URL编码，保留原值。
data包含snCode,currentStatus,currentStatusLabel,productId,productName,pnCode,storeId,storeName,timeline。
关联事件使用canViewSnTraceReference；实际员工可见范围及timeline字段待联调。
结论：候选复用，不保证全部历史都能查询。

## 单据动作记录：受控提取，不传整单
GET /api/v1/inventory/transfer/:transferId：调拨详情data.action_logs，含调拨可见性校验。
GET /api/v1/sales/:orderId：订单详情含action_logs，沿用原订单权限；单号不是内部ID。
内部日志字段包括business_type,business_id,business_no,action,from_status,to_status,actor_staff_id,actor_name,comment,detail,create_time等；只有已记录动作才有日志，不代表完整历史。
结论：复用原详情服务并在后台只提取授权日志；订单详情含客户、收款等信息，禁止整单直接送模型。

## 暂不开放
价格GET接口如/product/price/list、price/export、price/history存在applyPendingProductPriceChanges调用，可能更新价格及日志，不能因GET就视为只读。
禁止任意URL、导出及下载票据、管理员查询、数据库工具和业务写操作。
未确认现成主推排名API、统一全业务日志搜索API或外部员工只读授权设施；不得把建议接口写成已存在接口。
