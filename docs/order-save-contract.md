# 订单保存契约

复用 `GET /sales/:orderId`、`PUT /sales/:orderId`、`PUT /sales/draft/:orderId`。沿用现有订单可见范围、草稿编辑权限及审批限制；不增加权限。

读取返回 `saveRevision`，表示该次读取的持久化订单、商品、收款事实。新版编辑提交 `saveContract: 1`、`expectedRevision`、8至64字符的 `requestId`。同一保存重试保留编号和内容，改变输入后生成新编号；不得先读取最新版本再盲目重放旧编辑。

商品数组只提交 `items`，规范售价字段为 `unitPrice`，Web历史 `salePrice` 兼容。后台兼容旧别名，但同时提供的价格必须数值一致。完整商品数组必传单价；数量省略兼容为1，明确0或非法数量拒绝。小计忽略客户端值，由后台整数分乘数量生成。

后台锁定订单，先查同编号已提交日志，再校验读取版本，随后在原事务中执行明细、收款、订单及原有库存/归档流程。任何异常回滚。已占用定金不能由普通编辑替换抵扣金额。

返回 `saveRevision` 和 `savedOrder`（商品金额、实际支付、开票金额、商品与收款明细），均读取实际持久化结果；保留旧状态/提示字段。409表示版本已变或编号内容冲突；页面应保留输入并提示刷新核对。

旧客户端不带版本时兼容接收，仍执行后台金额校验，但不能获得新版防覆盖保证。部署顺序为后台、Web、小程序；历史数据不随部署自动修复。

验证：`node --test test/orderSaveContract.test.js`；`node scripts/verify-order-save-contract.js`仅操作连接级临时表；`node scripts/audit-order-price-consistency.js`只读业务表并将异常清单写入本地backup。
