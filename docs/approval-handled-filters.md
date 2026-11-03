# 我的审批筛选接口

复用 GET /api/v1/approval/instances，scope=handled。权限仍为当前用户 assignee_staff_id 的 approved/rejected 任务，不开放其他人的审批。

参数：title（主题包含）、businessType（精确类型）、instanceNo（申请编号包含）、pn/sn（商品字段包含，最多128字符）、reviewStatus（approved/rejected）、status（单据状态）、dateType（reviewed默认/submitted）、startDate/endDate（YYYY-MM-DD，北京时间含首尾自然日）、page/pageSize（最多100）。所有条件按单据交集；PN、SN允许命中同单不同商品。

审批时间和结果作用于本人任务，任一次满足即入选；my_review_* 展示匹配任务中最近一次，当前单据进度与处理结果分别展示。详情保留全部节点记录。日期以次日00:00为排他上界。

返回兼容原list/total/page/pageSize/totalPages，新增businessTypes（本人全部已办类型码，独立于当前筛选和分页）。其他scope不变。不将自由备注全文搜索当作PN/SN；旧记录没有对应商品字段、来源已删除时不能凭空推断命中。

实现集中在后台 handledFilters.js，复用业务registry定位来源，不新增表和审批流程。Web不做当前页过滤或计数。PN/SN读取业务明细实际字段及产品厂商编码；这不是重新冻结历史商品资料，不写入库存和财务。
