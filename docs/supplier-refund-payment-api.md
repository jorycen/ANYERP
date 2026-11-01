# 供应商退款进入付款管理（2026-10-29 用户确认）

## 统计与展示

复用 GET /finance/settlement-payment/candidates：同一权限、经销商、日期、单号及税务筛选下，包含 confirmed 且未付清的正金额结算，以及 confirmed、pending_refund 且有剩余退款的负金额结算。负金额保留，不与普通付款自动冲抵。新增 fund_direction、fund_direction_label、refund_remaining_amount；剩余金额统一由后台计算，分页前筛选。

已完成退款不进入待处理清单；历史已到账单据不重写、不重新生成任务。导出的“实际付款”只保留普通付款，另表“供应商退款待到账”列示退款，避免负数混入扣款导入。

## 确认到账

POST /finance/settlement-payment/supplier-refund：settlementId、accountId、amount（正的本次实收金额，最多两位小数）、evidence（必填到账凭证链接或银行流水号，最多200字）、requestId（16—48位字母数字下划线连字符）、remark（最多150字）。沿用经销商和资金账户权限，只接受有效 FUND 账户。

账户先锁定、结算单后锁定，沿用普通付款锁顺序。核对负结算已确认及待退款状态、本次金额不超剩余应收；同一 requestId 同内容重试返回原结果，不再入账，同编号不同内容409。网络失败重试保留原编号。

同事务：生成 income 账户流水（金额为正、增加余额）、RF 批次及负金额收付记录、结算单 paid_amount 扣减本次实收、业务审计与凭据。部分到账保持 pending_refund，全部到账改为 refunded。记录或审计失败整体回滚。已有退款后不能撤销、作废或绕过已发生资金的保护。

旧 POST /finance/settlement/supplier-refund 返回410并指向付款管理；结算单只保留查看及操作提示。详情新增 refund_receipts 和 refund_received_amount，兼容保留 refund_receipt，并从实际账户流水汇总历史及分次到账。

不新增核心表、不自动改生产数据、不扩大到账权限、不将退款作为普通批量付款或付款导入扣款。到账事实由财务人工核实后提交；本轮只改供应商退款流程，其他账户业务不在此轮迁移。
