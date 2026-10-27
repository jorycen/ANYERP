# 批量审批 API

沿用审批模块登录认证、门店/经销商范围及原审批入口权限，两端共用，无新增数据库字段。

## 获取当前列表的批量能力

`POST /approval/batch-options`，请求 `{ "items": [...] }`，每次1至100条。每条使用一种描述，key仅用于客户端关联结果：

* 业务待办：`{ "key":"local-key", "kind":"business", "businessType":"purchase_request", "businessId":"..." }`
* 通用待办：`{ "key":"local-key", "kind":"instance", "instanceId":"..." }`
* 兼容销售待办：`{ "key":"local-key", "kind":"sales", "businessId":"..." }`

返回 `{ "code":0, "data":[{ "key":"local-key", "eligible":true, "token":"..." }] }`。不支持/无权限/非当前节点返回eligible:false和reason，不改变审批数据。托管实例自动解析到原业务入口。

## 通过已勾选待办

`POST /approval/batch-approve`，请求同上，每项增加选项接口返回的token。不接受action或业务补填字段，固定为通过；需要补填资料必须进入详情。

返回 `{ "code":0, "data":{ "results":[{ "key":"local-key", "success":true, "pending":true, "message":"本次审批已记录，等待其他审批人或下一节点" }], "succeeded":1, "failed":0 } }`。单张失败以success:false及message返回，其他单继续。参数缺失/超过100条整批400。每单使用原业务事务和日志；同单别名去重，事务内复核令牌，阻止重试通过下一节点。

客户端仅提交当前列表明确勾选的数据，在确认框前冻结描述及令牌。成功清除选择；失败且令牌未变可保留；刷新后令牌变化清除勾选。pending:true表示本节点审批已记录，不可提示整单终审。网络失败应保留原令牌，不自动刷新令牌后重放。
