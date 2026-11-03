# 费用抵扣毛利

## 接口复用结论

原 POST /finance/expense、草稿保存/编辑/提交及原审批流程兼容扩展，paymentMethod=PROFIT_DEDUCTION，profitDeduction={performanceMonth:'YYYY-MM',method:'MANUAL'|'AVERAGE',allocations:[{staffId,amount}]}。后台冻结至已有recipient_snapshot_json；普通付款、费用归属、附件及原接口返回保持兼容，无新表及结构迁移。

新增 GET /finance/expense/profit-deduction-options?storeId=...、POST /finance/expense/profit-deduction-preview {storeId,amount,profitDeduction}。现有人员选项接口依赖已保存expenseId，无法承担新增费用表单，故新增两项。选项返回北京时间currentMonth及权限内业务人员；预览与保存、最终审批共用expenseProfitDeduction.normalize，前端不分摊业务金额。默认月为北京时间当月；一笔可选1至100人，均为所属经销商有效业务人员。经销商管理员范围内全部人员，其他账号按门店权限。

## 生效与撤销

金额按整数分校验；手工合计等于费用全额，平均尾差由最后一人承担，每人必须正数。提交冻结分摊，不立即生成绩效记录；原费用最终审批调用expenseProfitDeduction.apply，事务持有费用锁，以EPD-费用ID-人员ID作为幂等号，直接生成approved绩效扣减，Expense状态approved。无独立分摊二次审批，不生成应付、结算或资金支出；付款接口主动拒绝该方式。已有绩效分摊接口禁止再次分摊。

Expense.period和抵扣月份均受费用期间/财务关账保护。最终审批复核人员启用、经销商及原金额。拒绝不扣；获准取消费用后将原扣减行置cancelled，保留数据并记录reversed_deduction审计，报表恢复该月个人毛利。当前月关闭不能以撤销绕过；须先按现有权限处理期间。允许负毛利，不截成0。

## 报表契约

原销售业绩毛利/订单快照不变。个人绩效扣减读取ExpensePerformanceAllocation已批准记录，按performance_month而非费用日期或审批日期归月，按查询起止日期覆盖的自然月取全额。绩效扣减门店冻结为人员审批时所属门店，无所属门店则沿用费用来源门店；与原费用经营归属分开。查询订单号时不把个人费用摊给订单。loadMonthly为员工报表和看板唯一来源，过滤门店、经销商、人员及自身范围；净毛利统一netProfit计算。没有销售的扣减人员也展示。未取到来源不默认0；产品线筛选不能推断个人费用分摊，因此扣减后毛利返回null。

费用经营归属按原规则计一次，个人绩效扣减不再减少公司销售基础毛利，不另写毛利调整。Web/小程序展示费用扣减和扣减后毛利；个人毛利导出增加费用绩效扣减、个人毛利汇总sheet。费用导出增加支付方式、抵扣月份及人员金额。

## 发布

先部署ANY-ERP后台与Web，再发布sdxcx小程序。小程序代码只留本地，不上传GitHub。无生产数据迁移或历史批处理；老费用不自动改为抵扣毛利。
