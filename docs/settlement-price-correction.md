# 订单结算定价纠错 API

2026-10-27 用户确认第一期，所有路径位于 `/api/v1/report`。API为计算及权限单一来源。

## 接口复用结论

原 `/profit-adjustments` 只支持手填增减金额，不能表达价格来源。兼容扩展原申请表（新增 nullable JSON `CORRECTION_DATA`）、历史查询、附件和现有统一审批，不另建平行审批体系。仅补充原API缺少的商品选项和只读预览能力；计算复用 `sales/grossProfit.calculateGrossProfitValues` 和产品结算汇总函数。

## 选项

`GET /profit-adjustments/correction-options?orderId=...`

返回 `code:0, data:{options:[{itemId,productName,snCode,quantity,unitPrice,label}]}`。校验登录用户门店范围、归档状态、期间、退货和产品结算状态；仅列出公司结算定价商品。无完整归档依据的行不能提交。查询不建快照、不修改价格。

## 影响预览

`POST /profit-adjustments/price-preview`

JSON：`{orderId,itemId,unitPrice,confirmZero}`。定价非负、最多两位小数、最多9位整数，零元需 `confirmZero:true`。

返回 `code:0, data:{itemId,productName,snCode,quantity,beforeUnitPrice,afterUnitPrice,salesBefore,salesAfter,productBefore,productAfter,salesDelta,productDelta,productProfitVisible,previewHash,note}`。金额均为后台计算，前端只格式化。`previewHash` 绑定原订单、毛利快照、产品结算及商品数据，不只校验价差。产品毛利沿用原财务入口的 `isDealerAccount` 权限，受限账号 `productProfitVisible=false`，三个产品毛利字段返回null并明确提示权限，不显示为零。

## 提交

`POST /profit-adjustments`，multipart：

- `orderId`、`adjustmentType=price_correction`、`itemId`、`unitPrice`、`confirmZero`。
- `reason`：错误说明，1至1000字；`evidence`：定价依据/凭据说明，2至2000字。
- `previewHash`：当前只读预览返回值。
- `files`：可选，最多5个，每个不超过10MB，沿用原支持格式。

后台重新预览并锁定原单数据；同订单只允许一笔待审纠错。返回 `data.adjustmentId`。原 `increase/decrease` 手填申请返回400，不再接收任意毛利金额。

## 审批和历史

沿用 `POST /profit-adjustments/:adjustmentId/approve|reject`（`{comment}`）、`GET /profit-adjustments`（`scope=mine|order|review,orderId,status,page,pageSize`）及原附件下载路径。

统一审批配置决定实际节点和审批人。所有节点完成才执行；再次校验原数据、期间、退货和范围。最终审批、销售快照、商品销售结算成本、产品结算及操作日志共事务，失败全部回滚。纠错 `signed_amount=0`，不再叠加到已修正基础毛利。历史批准记录不转换；旧手填待审单只能拒绝后重提。

查询、统一待办及实例详情额外提供 `correction_type_name,correction_evidence,correction_product,correction_before_price,correction_after_price,correction_sales_before,correction_sales_after,correction_sales_delta,correction_product_before,correction_product_after,correction_product_delta,correction_product_profit_visible`，Web与小程序均展示这些后台字段；产品毛利继续执行原财务权限。数据库 `correction_data` 保存原始前后快照及生效时间，不在这些公开响应中返回完整内部快照，避免泄露实际采购成本。

## 口径及边界

- 只影响本订单指定商品内部结算定价，不改变客户成交价、数量、应收、实收、采购成本或商品主档。
- 仅采用完整现行公式的final快照。支付费率、应收、开票金额、运费、补录及未选商品取原归档数据；价格导致的增值税和外调费依赖按统一公式重算。若原快照与这些依据不能核对，拒绝修改。
- 金额以元为单位，两位小数。字段缺失/成本未确认明确报错，不以当前主档、零值或旧公式替代。
- 员工业绩按原单日期及现有人员分摊口径；产品端保留原结算业务日期。期间检查使用北京时间，覆盖原单创建月、归档月和产品结算月。
- 已退货/在途退货、已锁定期间、采购价口径、缺少结算或成本待补先阻止。退货后纠错及锁定期间跨期处理未在本期开放，须另行确认规则。
- 更正再撤销，通过另一笔有依据的纠错申请将定价改回；原记录保留。以后新增退货复用修正后的有效原单及产品结算数据。
- 公司财务利润仍使用实际收入及采购成本；不能把销售/产品管理口径合计冒充财务利润。

## 上线与验收

部署后端及Web静态资源前确认结构兼容迁移成功新增 `CORRECTION_DATA`；不执行历史业务回填。小程序改动仅在 `sdxcx` 保留本地，不随ANY-ERP上传。

专项用例覆盖只读预览、双端守恒示例、税费依赖、权限、退货/关账拦截、最终审批/中间节点/拒绝、失败回滚、旧预览、重复待审和反向纠错。验收时使用同账号权限、门店、订单、日期和数据时点核对Web及小程序审批影响、员工业绩和产品结算结果。当前仅本地模拟依赖测试和Web构建通过，真实数据库迁移及线上跨端联调尚未执行。
