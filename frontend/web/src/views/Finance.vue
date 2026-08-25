<template>
  <div class="finance-page">
    <el-card>
      <template #header>
        <span>财务管理</span>
      </template>

      <el-tabs v-model="activeTab" class="module-tabs">
        <el-tab-pane label="日结单" name="daily">
          <div class="filter-bar">
            <el-date-picker v-model="queryParams.dateRange" type="daterange" range-separator="至"
              start-placeholder="开始日期" end-placeholder="结束日期" value-format="YYYY-MM-DD" />
            <el-select v-model="queryParams.storeId" placeholder="选择门店" clearable style="width: 150px" @change="loadDailyData">
              <el-option label="全部门店" value="" />
              <el-option v-for="store in stores" :key="store.store_id" :label="store.name" :value="store.store_id" />
            </el-select>
            <el-select v-model="paymentMethodFilter" placeholder="收款方式" clearable style="width: 130px" @change="loadDailyData">
              <el-option label="全部" value="" />
              <el-option v-for="pm in paymentMethods" :key="pm.method_id" :label="pm.name" :value="pm.name" />
            </el-select>
            <el-select v-model="settledFilter" placeholder="下账状态" clearable style="width: 120px" @change="loadDailyData">
              <el-option label="全部" value="" />
              <el-option label="未下账" value="0" />
              <el-option label="已下账" value="1" />
            </el-select>
            <el-select v-model="settlementAccountFilter" placeholder="结算账号" clearable style="width: 150px" @change="loadDailyData">
              <el-option label="全部" value="" />
              <el-option v-for="acc in settlementAccounts" :key="acc.account_id" :label="acc.account_name" :value="acc.account_id" />
            </el-select>
            <el-button type="primary" @click="loadDailyData">搜索</el-button>
            <el-button type="success" :loading="exportingList === 'daily'" @click="handleExportDaily">导出</el-button>
            <el-button type="success" @click="openBatchSettleDialog" :disabled="selectedDetailIds.length === 0">
              批量下账 ({{ selectedDetailIds.length }})
            </el-button>
          </div>

          <el-table :data="dailyDetails" stripe border @selection-change="onDetailSelectionChange" ref="detailTableRef">
            <el-table-column type="selection" width="40" :selectable="(r) => parseFloat(r.settled || 0) === 0" />
            <el-table-column prop="statement_date" label="日期" width="110" sortable />
            <el-table-column prop="order_no" label="业务单号" width="170" />
            <el-table-column label="业务类型" width="100">
              <template #default="{ row }">{{ dailyBusinessTypeText(row.business_type) }}</template>
            </el-table-column>
            <el-table-column prop="customer_name" label="客户" width="100" />
            <el-table-column prop="payment_method" label="收款方式" width="110" />
            <el-table-column label="收款金额" width="110">
              <template #default="{ row }">¥{{ row.amount }}</template>
            </el-table-column>
            <el-table-column label="结算账号" width="140">
              <template #default="{ row }">
                {{ row.settlementAccount?.account_name || '-' }}
              </template>
            </el-table-column>
            <el-table-column label="门店" width="130">
              <template #default="{ row }">{{ row.store_name || '-' }}</template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="parseFloat(row.settled || 0) > 0 ? 'success' : 'warning'" size="small">
                  {{ parseFloat(row.settled || 0) > 0 ? '已下账' : '未下账' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="下账时间" width="160">
              <template #default="{ row }">{{ row.settled_at ? formatDateTime(row.settled_at) : '-' }}</template>
            </el-table-column>
            <el-table-column label="操作" width="90" fixed="right">
              <template #default="{ row }">
                <el-button
                  v-if="parseFloat(row.settled || 0) === 0"
                  size="small"
                  type="warning"
                  @click="handleSettleDetail(row)"
                >下账</el-button>
                <span v-else style="color: #67c23a; font-size: 12px;">已下账</span>
              </template>
            </el-table-column>
          </el-table>

          <div class="daily-summary">
            <span>共计 <strong>{{ dailyTotal }}</strong> 条记录</span>
            <span style="margin-left: 24px;">总金额：<strong class="total-amount">¥{{ dailyTotalAmount.toFixed(2) }}</strong></span>
          </div>

          <el-pagination
            v-model:current-page="queryParams.page"
            v-model:page-size="queryParams.pageSize"
            :total="dailyTotal"
            layout="total, sizes, prev, pager, next"
            @size-change="loadDailyData"
            @current-change="loadDailyData"
          />
        </el-tab-pane>

        <el-tab-pane label="国补应收单" name="nationalSubsidyReceivable">
          <div class="filter-bar">
            <el-date-picker
              v-model="subsidyQuery.dateRange"
              type="daterange"
              range-separator="至"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              value-format="YYYY-MM-DD"
            />
            <el-select v-model="subsidyQuery.storeId" placeholder="选择门店" clearable style="width: 150px" @change="loadSubsidyReceivables">
              <el-option label="全部门店" value="" />
              <el-option v-for="store in stores" :key="store.store_id" :label="store.name" :value="store.store_id" />
            </el-select>
            <el-select v-model="subsidyQuery.settled" placeholder="到账状态" clearable style="width: 120px" @change="loadSubsidyReceivables">
              <el-option label="全部" value="" />
              <el-option label="待回款" value="0" />
              <el-option label="已发生到账" value="1" />
            </el-select>
            <el-button type="primary" @click="loadSubsidyReceivables">搜索</el-button>
            <el-button type="success" :loading="exportingList === 'subsidy'" @click="handleExportSubsidy">导出</el-button>
            <el-button
              type="success"
              :disabled="selectedSubsidyIds.length === 0"
              @click="openSubsidyReceiptDialog(selectedSubsidyRows)"
            >
              登记到账 ({{ selectedSubsidyIds.length }})
            </el-button>
          </div>

          <el-table
            :data="subsidyReceivables"
            stripe
            border
            v-loading="subsidyLoading"
            @selection-change="onSubsidySelectionChange"
          >
            <el-table-column type="selection" width="40" :selectable="(row) => Number(row.remaining_amount || 0) > 0" />
            <el-table-column prop="statement_date" label="应收日期" width="110" sortable />
            <el-table-column prop="order_no" label="订单号" width="180" />
            <el-table-column prop="customer_name" label="国补客户" width="110" />
            <el-table-column label="国补类型" min-width="180">
              <template #default="{ row }">{{ subsidyPaymentType(row.payment_method) }}</template>
            </el-table-column>
            <el-table-column label="应收金额" width="120">
              <template #default="{ row }">¥{{ Number(row.amount || 0).toFixed(2) }}</template>
            </el-table-column>
            <el-table-column label="累计核销" width="110">
              <template #default="{ row }">¥{{ Number(row.settled || 0).toFixed(2) }}</template>
            </el-table-column>
            <el-table-column label="剩余应收" width="110">
              <template #default="{ row }">¥{{ Number(row.remaining_amount || 0).toFixed(2) }}</template>
            </el-table-column>
            <el-table-column label="应收账户" min-width="150">
              <template #default="{ row }">{{ row.settlementAccount?.account_name || '-' }}</template>
            </el-table-column>
            <el-table-column prop="store_name" label="门店" width="130" />
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="Number(row.remaining_amount || 0) <= 0 ? 'success' : (Number(row.settled || 0) > 0 ? 'warning' : 'info')" size="small">
                  {{ row.receipt_status === 'ADJUSTED' ? '差额结清' : (Number(row.remaining_amount || 0) <= 0 ? '已到账' : (Number(row.settled || 0) > 0 ? '部分到账' : '待回款')) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="结清时间" width="160">
              <template #default="{ row }">{{ row.settled_at ? formatDateTime(row.settled_at) : '-' }}</template>
            </el-table-column>
            <el-table-column label="操作" width="190" fixed="right">
              <template #default="{ row }">
                <el-button
                  v-if="Number(row.remaining_amount || 0) > 0"
                  size="small"
                  type="success"
                  link
                  @click="openSubsidyReceiptDialog([row])"
                >登记到账</el-button>
                <el-button v-if="Number(row.remaining_amount || 0) > 0" size="small" type="warning" link @click="openSubsidyAdjustmentDialog(row)">差额申请</el-button>
              </template>
            </el-table-column>
          </el-table>

          <div class="daily-summary">
            <span>共计 <strong>{{ subsidyTotal }}</strong> 条记录</span>
            <span style="margin-left: 24px;">应收总额：<strong class="total-amount">¥{{ subsidyTotalAmount.toFixed(2) }}</strong></span>
          </div>
          <el-pagination
            v-model:current-page="subsidyQuery.page"
            v-model:page-size="subsidyQuery.pageSize"
            :total="subsidyTotal"
            layout="total, sizes, prev, pager, next"
            @size-change="loadSubsidyReceivables"
            @current-change="loadSubsidyReceivables"
          />

          <el-divider content-position="left">银行到账单与未分配款</el-divider>
          <el-table :data="subsidyReceipts" stripe border size="small">
            <el-table-column prop="receipt_no" label="到账单号" width="190" />
            <el-table-column prop="receipt_date" label="到账日期" width="110" />
            <el-table-column prop="account_name_snapshot" label="实际到账账户" min-width="180" />
            <el-table-column prop="bank_reference" label="银行流水号" min-width="150" />
            <el-table-column label="到账金额" width="110"><template #default="{row}">¥{{ formatMoney(row.amount) }}</template></el-table-column>
            <el-table-column label="未分配" width="110"><template #default="{row}">¥{{ formatMoney(row.unallocated_amount) }}</template></el-table-column>
            <el-table-column label="操作" width="220"><template #default="{row}">
              <el-button v-if="row.status!=='REVERSED' && Number(row.unallocated_amount)>0" link type="primary" @click="openExistingReceiptAllocation(row)">继续核销</el-button>
              <el-button v-if="row.status!=='REVERSED' && Number(row.unallocated_amount)>0" link type="danger" @click="refundSubsidyReceipt(row)">退款</el-button>
              <el-button v-if="row.status!=='REVERSED' && Number(row.refunded_amount||0)===0" link type="danger" @click="reverseSubsidyReceipt(row)">冲销</el-button>
            </template></el-table-column>
          </el-table>

          <el-divider content-position="left">国补差额审批</el-divider>
          <el-table :data="subsidyAdjustments" stripe border size="small">
            <el-table-column prop="detail_id" label="应收明细ID" min-width="190" />
            <el-table-column label="类型" width="100"><template #default="{row}">{{ row.adjustment_type === 'FEE' ? '手续费' : '差额核销' }}</template></el-table-column>
            <el-table-column label="金额" width="110"><template #default="{row}">¥{{ formatMoney(row.amount) }}</template></el-table-column>
            <el-table-column prop="finance_category" label="财务处理科目" width="140" />
            <el-table-column prop="reason" label="原因" min-width="180" />
            <el-table-column prop="applicant_name" label="申请人" width="100" />
            <el-table-column label="状态" width="100"><template #default="{row}">{{ row.status === 'PENDING' ? '待审批' : row.status === 'APPROVED' ? '已通过' : '已拒绝' }}</template></el-table-column>
            <el-table-column label="操作" width="130"><template #default="{row}">
              <template v-if="row.status === 'PENDING'">
                <el-button link type="success" @click="reviewSubsidyAdjustment(row,'approve')">通过</el-button>
                <el-button link type="danger" @click="reviewSubsidyAdjustment(row,'reject')">拒绝</el-button>
              </template>
              <el-button v-else-if="row.status === 'APPROVED'" link type="danger" @click="reverseSubsidyAdjustment(row)">冲销</el-button>
            </template></el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="返利下账" name="rebate-settlement" lazy>
          <RebateSettlement @changed="handleRebateSettlementChanged" />
        </el-tab-pane>

        <el-tab-pane label="费用管理" name="expense">
          <div class="filter-bar">
            <span style="font-weight: bold; line-height: 32px;">费用清单</span>
            <el-button type="primary" @click="handleAddExpense">添加费用</el-button>
            <el-button type="success" :loading="exportingList === 'expense'" @click="handleExportExpense">导出</el-button>
          </div>

          <el-table :data="expenseData" stripe border>
            <el-table-column prop="expense_no" label="费用单号" width="160" />
            <el-table-column prop="create_time" label="时间" width="160" />
            <el-table-column prop="expense_type" label="费用类型" width="100" />
            <el-table-column prop="amount" label="金额" width="120">
              <template #default="{ row }">¥{{ row.amount }}</template>
            </el-table-column>
            <el-table-column prop="store_name" label="门店" width="120" />
            <el-table-column prop="create_user" label="制单人" width="80" />
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
                <el-tag :type="getExpenseStatusType(row.status)" size="small">
                  {{ getExpenseStatusText(row.status) }}
                </el-tag>
            </template>
          </el-table-column>
            <el-table-column prop="remark" label="备注" min-width="120" />
            <el-table-column label="操作" width="220">
              <template #default="{ row }">
                <el-button v-if="row.status === 'draft'" link type="primary" @click="handleEditExpense(row)">编辑</el-button>
                <el-button v-if="row.status === 'draft'" link type="success" @click="handleSubmitExpenseDraft(row)">提交</el-button>
                <el-button v-if="row.status === 'draft'" link type="danger" @click="handleDeleteExpenseDraft(row)">删除</el-button>
                <el-button v-if="row.status === 'pending'" link type="primary" @click="handleSubmitExpense(row)">
                  报销
                </el-button>
                <span v-else-if="row.status === 'processing'" style="color: #e6a23c; font-size: 12px;">
                  支付中 · {{ row.submit_user || '-' }}
                </span>
                <span v-else style="color: #67c23a; font-size: 12px;">已完成</span>
              </template>
            </el-table-column>
          </el-table>

          <el-pagination
            v-model:current-page="expenseQuery.page"
            v-model:page-size="expenseQuery.pageSize"
            :total="expenseTotal"
            layout="total, sizes, prev, pager, next"
            @size-change="loadExpenseData"
            @current-change="loadExpenseData"
          />

          <div class="settlement-section">
            <div class="filter-bar">
              <span style="font-weight: bold; line-height: 32px;">报销结算单</span>
              <el-select v-model="expenseSettleFilter" placeholder="状态筛选" clearable style="width: 130px" @change="loadExpenseSettleData">
                <el-option label="全部" value="" />
                <el-option label="支付中" value="processing" />
                <el-option label="已付款" value="paid" />
              </el-select>
            </div>
            <el-table :data="expenseSettleData" stripe border>
              <el-table-column prop="expense_no" label="费用单号" width="160" />
              <el-table-column prop="create_time" label="时间" width="160" />
              <el-table-column prop="expense_type" label="费用类型" width="100" />
              <el-table-column prop="amount" label="金额" width="120">
                <template #default="{ row }">¥{{ row.amount }}</template>
              </el-table-column>
              <el-table-column prop="store_name" label="门店" width="120" />
              <el-table-column prop="submit_user" label="发起人" width="80" />
              <el-table-column label="状态" width="90">
                <template #default="{ row }">
                  <el-tag :type="row.status === 'paid' ? 'success' : 'warning'" size="small">
                    {{ row.status === 'paid' ? '已付款' : '付款中' }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="settled_payment_method" label="付款方式" width="150">
                <template #default="{ row }">
                  <template v-if="row.SettlementAccount">
                    {{ row.SettlementAccount.account_name }}{{ row.SettlementAccount.bank_name ? ' - ' + row.SettlementAccount.bank_name : '' }}
                  </template>
                  <template v-else>{{ row.settled_payment_method || '-' }}</template>
                </template>
              </el-table-column>
              <el-table-column prop="settle_user" label="付款人" width="80" />
              <el-table-column prop="settled_at" label="付款时间" width="160" />
              <el-table-column label="操作" width="120">
                <template #default="{ row }">
                  <el-button v-if="row.status === 'processing'" link type="success" @click="handlePayExpense(row)">
                    确认付款
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
            <el-pagination
              v-model:current-page="expenseSettleQuery.page"
              v-model:page-size="expenseSettleQuery.pageSize"
              :total="expenseSettleTotal"
              layout="total, sizes, prev, pager, next"
              @size-change="loadExpenseSettleData"
              @current-change="loadExpenseSettleData"
            />
          </div>
        </el-tab-pane>

        <el-tab-pane label="应付管理" name="payable">
          <div class="filter-bar">
            <span style="font-weight: bold; line-height: 32px;">待付款清单</span>
            <el-button type="primary" @click="openSettlementDialog" :disabled="selectedPayableRows.length === 0">生成结算单</el-button>
            <el-button type="success" :loading="exportingList === 'payable'" @click="handleExportPayable">导出</el-button>
            <el-button @click="router.push('/finance/settlement')">应付结算单管理</el-button>
          </div>

          <div class="filter-bar">
            <el-date-picker
              v-model="payableDateRange"
              type="daterange"
              range-separator="至"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              value-format="YYYY-MM-DD"
              style="width: 260px"
              @change="onPayableFilterChange"
            />
            <el-select v-model="payableSupplierFilter" placeholder="供应商筛选" clearable filterable style="width: 180px" @change="onPayableFilterChange">
              <el-option v-for="s in suppliers" :key="s.supplier_id" :label="s.name" :value="s.supplier_id" />
            </el-select>
            <el-select v-model="payableSourceFilter" placeholder="来源类型筛选" clearable style="width: 160px" @change="onPayableFilterChange">
              <el-option label="采购" value="purchase" />
              <el-option label="采购调整" value="purchase_adjustment" />
              <el-option label="费用" value="expense" />
              <el-option label="报销" value="reimbursement" />
            </el-select>
            <el-select v-model="payableStatusFilter" placeholder="状态筛选" clearable style="width: 170px" @change="onPayableFilterChange">
              <el-option label="待付款" value="unpaid" />
              <el-option label="部分结算" value="partial_settled" />
              <el-option label="结算中" value="settling" />
              <el-option label="供应商待抵扣" value="credit" />
              <el-option label="已抵扣" value="offset" />
            </el-select>
            <el-input
              v-model="payableSourceNoFilter"
              placeholder="单号筛选"
              clearable
              style="width: 190px"
              @keyup.enter="onPayableFilterChange"
            />
            <el-button type="primary" @click="onPayableFilterChange">查询</el-button>
          </div>

          <div class="payable-summary">
            <span>筛选结果：<strong>{{ payableFilterSummary.totalCount }}</strong> 条，待结算金额：<strong>¥{{ formatMoney(payableFilterSummary.totalAmount) }}</strong></span>
            <span>已勾选：<strong>{{ selectedPayableRows.length }}</strong> 条，待结算金额：<strong class="total-amount">¥{{ formatMoney(selectedPayableTotalAmount) }}</strong></span>
          </div>

          <el-table
            ref="payableTableRef"
            :data="payableData"
            row-key="payable_id"
            stripe
            border
            @selection-change="onPayableSelectionChange"
          >
            <el-table-column type="selection" width="50" reserve-selection />
            <el-table-column label="来源单号" width="190">
              <template #default="{ row }">
                <el-button v-if="row.source_type === 'purchase' || row.request_id" link type="primary" @click="openPurchaseRequestDetail(row)">
                  {{ row.source_no || row.request_no || '-' }}
                </el-button>
                <span v-else>{{ row.source_no || row.request_no || '-' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="来源类型" width="100">
              <template #default="{ row }">
                <el-tag :type="getPayableSourceTagType(row)" size="small">
                  {{ getPayableSourceText(row) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="税务属性" width="100">
              <template #default="{ row }">
                <el-tag :type="getPayableTaxTagType(row.tax_status)" size="small">
                  {{ getPayableTaxText(row.tax_status) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="收款方" width="150">
              <template #default="{ row }">{{ getPayablePayeeName(row) }}</template>
            </el-table-column>
            <el-table-column label="采购原价" width="120">
              <template #default="{ row }">
                <span v-if="row.source_type === 'purchase'">¥{{ formatMoney(row.purchase_original_amount) }}</span>
                <span v-else>-</span>
              </template>
            </el-table-column>
            <el-table-column label="返利抵扣" width="120">
              <template #default="{ row }">
                <span v-if="row.source_type === 'purchase' && Number(row.purchase_rebate_deduction || 0) > 0">
                  ¥{{ formatMoney(row.purchase_rebate_deduction) }}
                </span>
                <span v-else>-</span>
              </template>
            </el-table-column>
            <el-table-column prop="total_amount" label="应付金额" width="120">
              <template #default="{ row }">¥{{ formatMoney(row.current_total_amount ?? row.total_amount) }}</template>
            </el-table-column>
            <el-table-column prop="paid_amount" label="已付金额" width="120">
              <template #default="{ row }">¥{{ row.paid_amount }}</template>
            </el-table-column>
            <el-table-column prop="remaining_amount" label="剩余待结算" width="120">
              <template #default="{ row }">¥{{ formatMoney(row.remaining_amount) }}</template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="getPayableStatusTagType(row.status)">
                  {{ getPayableStatusText(row.status) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="purchase_initiator" label="采购发起人" width="130">
              <template #default="{ row }">{{ ['purchase', 'purchase_adjustment'].includes(row.source_type) ? (row.purchase_initiator || '-') : '-' }}</template>
            </el-table-column>
            <el-table-column prop="create_time" label="创建时间" width="160" />
            <el-table-column label="操作" width="140">
              <template #default="{ row }">
                <el-button v-if="row.source_type === 'expense' || row.source_type === 'reimbursement'" link type="primary" @click="handleCreateExpenseSettlement(row)">
                  生成结算单
                </el-button>
                <el-button v-else-if="Number(row.remaining_amount || 0) > 0" link type="primary" @click="openSingleSettlementDialog(row)">结算</el-button>
              </template>
            </el-table-column>
          </el-table>

          <el-pagination
            v-model:current-page="payableQuery.page"
            v-model:page-size="payableQuery.pageSize"
            :total="payableTotal"
            layout="total, sizes, prev, pager, next"
            @size-change="loadPayableData"
            @current-change="loadPayableData"
          />

        </el-tab-pane>

        <el-tab-pane label="报销结算" name="reimbursement">
          <div class="filter-bar">
            <span style="font-weight: bold; line-height: 32px;">个人垫付报销结算单</span>
            <el-button type="success" :loading="exportingList === 'reimbursement-settlement'" @click="handleExportReimbursementSettlement">导出</el-button>
              <el-select v-model="reimbursementSettlementStatusFilter" placeholder="结算状态" clearable style="width: 130px" @change="loadReimbursementSettlementData">
                <el-option label="全部" value="" />
                <el-option label="草稿" value="draft" />
                <el-option label="待审批" value="pending_approval" />
                <el-option label="待付款" value="confirmed" />
              <el-option label="已作废" value="voided" />
            </el-select>
            <el-select v-model="reimbursementPaymentStatusFilter" placeholder="付款状态" clearable style="width: 130px" @change="loadReimbursementSettlementData">
              <el-option label="全部" value="" />
              <el-option label="未付款" value="unpaid" />
              <el-option label="部分付款" value="partial_paid" />
              <el-option label="已付款" value="paid" />
            </el-select>
          </div>

          <el-table :data="reimbursementSettlementData" stripe border>
            <el-table-column prop="settlement_no" label="结算单号" width="190" />
            <el-table-column label="报销人" width="130">
              <template #default="{ row }">{{ row.payee_name || row.supplier_name || '-' }}</template>
            </el-table-column>
            <el-table-column label="来源单号" width="180">
              <template #default="{ row }">{{ row.source_no || '-' }}</template>
            </el-table-column>
            <el-table-column prop="total_amount" label="结算金额" width="120">
              <template #default="{ row }">¥{{ row.total_amount }}</template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="getSettlementStatusTagType(row.status)">
                  {{ getSettlementStatusText(row.status) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="payment_status" label="付款状态" width="100">
              <template #default="{ row }">
                <el-tag :type="getPaymentStatusTagType(row.payment_status)">
                  {{ getPaymentStatusText(row.payment_status) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="create_time" label="创建时间" width="160" />
            <el-table-column label="操作" width="220">
              <template #default="{ row }">
                <el-button link type="primary" @click="openSettlementDetail(row)">详情</el-button>
                <el-button v-if="row.status === 'draft'" link type="warning" @click="handleSubmitSettlement(row)">提交</el-button>
                <el-button v-if="row.status !== 'voided'" link type="danger" @click="handleVoidSettlement(row)">作废</el-button>
              </template>
            </el-table-column>
          </el-table>

          <el-pagination
            v-model:current-page="reimbursementSettlementQuery.page"
            v-model:page-size="reimbursementSettlementQuery.pageSize"
            :total="reimbursementSettlementTotal"
            layout="total, sizes, prev, pager, next"
            @size-change="loadReimbursementSettlementData"
            @current-change="loadReimbursementSettlementData"
          />
        </el-tab-pane>

        <el-tab-pane label="付款管理" name="payment" lazy>
          <PaymentManagement embedded />
        </el-tab-pane>

        <el-tab-pane label="返利管理" name="rebate">
          <RebatePostingOrders :key="rebatePostingKey" @changed="handleRebatePostingChanged" />

          <div class="filter-bar">
            <strong style="line-height: 32px;">返利余额流水</strong>
            <el-select v-model="rebateSupplierFilter" placeholder="供应商筛选" clearable style="width: 150px" @change="loadRebateList">
              <el-option v-for="s in suppliers" :key="s.supplier_id" :label="s.name" :value="s.supplier_id" />
            </el-select>
            <el-select v-model="rebateTypeFilter" placeholder="类型筛选" clearable style="width: 120px" @change="loadRebateList">
              <el-option label="全部" value="" />
              <el-option label="上账" value="credit" />
              <el-option label="抵扣" value="debit" />
            </el-select>
          </div>

          <div class="rebate-summary">
            <div class="rebate-summary-header">
              <span>返利余额汇总</span>
              <strong>总余额：¥{{ Number(rebateSummaryTotal).toFixed(2) }}</strong>
            </div>
            <el-table :data="rebateSummary" stripe border size="small" empty-text="暂无返利余额">
              <el-table-column prop="supplier_name" label="供应商" min-width="160" />
              <el-table-column label="当前返利余额" width="140">
                <template #default="{ row }">¥{{ Number(row.balance || 0).toFixed(2) }}</template>
              </el-table-column>
              <el-table-column label="最后变动时间" width="170">
                <template #default="{ row }">{{ row.last_time ? formatDate(row.last_time) : '-' }}</template>
              </el-table-column>
            </el-table>
          </div>

          <el-table :data="rebateData" stripe border>
            <el-table-column prop="supplier_name" label="供应商" width="130" />
            <el-table-column prop="type" label="类型" width="80">
              <template #default="{ row }">
                <el-tag :type="row.type === 'credit' ? 'success' : 'danger'">
                  {{ row.type === 'credit' ? '上账' : '抵扣' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="amount" label="金额" width="120">
              <template #default="{ row }">
                <span :style="{ color: row.type === 'credit' ? '#67c23a' : '#f56c6c' }">
                  {{ row.type === 'credit' ? '+' : '-' }}¥{{ row.amount }}
                </span>
              </template>
            </el-table-column>
            <el-table-column prop="balance" label="余额" width="120">
              <template #default="{ row }">¥{{ row.balance }}</template>
            </el-table-column>
            <el-table-column prop="related_no" label="关联单号" width="160" />
            <el-table-column prop="remark" label="备注" min-width="140" />
            <el-table-column prop="create_user" label="操作人" width="100" />
            <el-table-column prop="create_time" label="时间" width="160" />
          </el-table>

          <el-pagination
            v-model:current-page="rebateQuery.page"
            v-model:page-size="rebateQuery.pageSize"
            :total="rebateTotal"
            layout="total, sizes, prev, pager, next"
            @size-change="loadRebateList"
            @current-change="loadRebateList"
          />

          <div class="settlement-section">
            <div class="filter-bar">
              <span style="font-weight: bold; line-height: 32px;">返利对账（含PO奖励）</span>
              <el-input v-model="rebateEstimateOrderFilter" placeholder="销售单号" clearable style="width: 160px" @keyup.enter="loadRebateEstimates" />
              <el-select v-model="rebateEstimateSupplierFilter" placeholder="供应商" clearable filterable style="width: 180px" @change="loadRebateEstimates">
                <el-option v-for="s in suppliers" :key="s.supplier_id" :label="s.name" :value="s.supplier_id" />
              </el-select>
              <el-select v-model="rebateEstimateStatusFilter" placeholder="状态" clearable style="width: 130px" @change="loadRebateEstimates">
                <el-option label="待确认" value="estimated" />
                <el-option label="已到账" value="received" />
              </el-select>
              <el-button @click="loadRebateEstimates">搜索</el-button>
            </div>
            <el-table :data="rebateEstimateData" stripe border empty-text="暂无返利对账记录">
              <el-table-column prop="sales_order_no" label="销售单号" width="170" />
              <el-table-column prop="supplier_name" label="供应商" min-width="140" />
              <el-table-column prop="product_name" label="商品" min-width="180" />
              <el-table-column prop="sn" label="SN" min-width="150" />
              <el-table-column prop="policy_name" label="政策/权益" min-width="140" />
              <el-table-column label="类型" width="110">
                <template #default="{ row }">{{ row.policy_type === 'PO_REWARD' ? 'PO奖励' : row.policy_type }}</template>
              </el-table-column>
              <el-table-column label="预估金额" width="120">
                <template #default="{ row }">¥{{ Number(row.rebate_estimate_amount || 0).toFixed(2) }}</template>
              </el-table-column>
              <el-table-column label="状态" width="100">
                <template #default="{ row }"><el-tag :type="row.status === 'received' ? 'success' : 'warning'">{{ row.status === 'received' ? '已到账' : '待确认' }}</el-tag></template>
              </el-table-column>
              <el-table-column prop="created_at" label="生成时间" width="170" />
            </el-table>
          </div>

          <div class="settlement-section">
            <div class="filter-bar">
              <span style="font-weight: bold; line-height: 32px;">厂家政策</span>
              <el-button type="primary" @click="openManufacturerPolicyDialog()">新增政策</el-button>
              <el-select v-model="manufacturerPolicySupplierFilter" placeholder="供应商/厂家" clearable filterable style="width: 180px" @change="loadManufacturerPolicies">
                <el-option v-for="s in suppliers" :key="s.supplier_id" :label="s.name" :value="s.supplier_id" />
              </el-select>
              <el-input v-model="manufacturerPolicyPnFilter" placeholder="PN" clearable style="width: 140px" @keyup.enter="loadManufacturerPolicies" />
              <el-button @click="loadManufacturerPolicies">搜索</el-button>
            </div>
            <el-table :data="manufacturerPolicyData" stripe border>
              <el-table-column prop="supplier_name" label="供应商/厂家" width="140" />
              <el-table-column prop="policy_name" label="政策名称" width="160" />
              <el-table-column prop="policy_type" label="类型" width="110" />
              <el-table-column prop="pn" label="PN" width="130" />
              <el-table-column prop="rebate_amount" label="返利金额" width="110">
                <template #default="{ row }">¥{{ row.rebate_amount || 0 }}</template>
              </el-table-column>
              <el-table-column label="影响成本" width="90">
                <template #default="{ row }">
                  <el-tag :type="row.affect_sales_settlement_cost ? 'success' : 'info'">
                    {{ row.affect_sales_settlement_cost ? '是' : '否' }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="cost_adjustment_type" label="调整方式" width="120" />
              <el-table-column prop="cost_adjustment_value" label="调整值" width="100" />
              <el-table-column label="操作" width="90">
                <template #default="{ row }">
                  <el-button link type="primary" @click="openManufacturerPolicyDialog(row)">编辑</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>

          <div class="settlement-section">
            <div class="filter-bar">
              <span style="font-weight: bold; line-height: 32px;">厂家价格管理</span>
              <el-upload
                :auto-upload="false"
                :show-file-list="false"
                accept=".xlsx,.xls"
                :on-change="handleManufacturerPriceImport"
              >
                <el-button type="success">导入价格表</el-button>
              </el-upload>
              <el-select v-model="manufacturerPriceSupplierFilter" placeholder="供应商/厂家" clearable filterable style="width: 180px" @change="loadManufacturerPrices">
                <el-option v-for="s in suppliers" :key="s.supplier_id" :label="s.name" :value="s.supplier_id" />
              </el-select>
              <el-input v-model="manufacturerPricePnFilter" placeholder="PN" clearable style="width: 140px" @keyup.enter="loadManufacturerPrices" />
              <el-button @click="loadManufacturerPrices">搜索</el-button>
            </div>
            <el-table :data="manufacturerPriceData" stripe border>
              <el-table-column prop="supplier_name" label="供应商/厂家" width="140" />
              <el-table-column prop="pn" label="PN" width="130" />
              <el-table-column prop="model" label="型号" width="130" />
              <el-table-column prop="pickup_price" label="提货价" width="110">
                <template #default="{ row }">¥{{ row.pickup_price }}</template>
              </el-table-column>
              <el-table-column prop="p0_price" label="P0价" width="110">
                <template #default="{ row }">¥{{ row.p0_price || 0 }}</template>
              </el-table-column>
              <el-table-column prop="effective_date" label="生效日期" width="160">
                <template #default="{ row }">{{ formatDate(row.effective_date) }}</template>
              </el-table-column>
              <el-table-column prop="expire_date" label="失效日期" width="160">
                <template #default="{ row }">{{ formatDate(row.expire_date) }}</template>
              </el-table-column>
              <el-table-column prop="import_batch_no" label="导入批次" width="160" />
            </el-table>
          </div>

          <div class="settlement-section">
            <div class="filter-bar">
              <span style="font-weight: bold; line-height: 32px;">销售结算成本调整明细</span>
              <el-input v-model="costAdjustmentOrderFilter" placeholder="销售单号" clearable style="width: 160px" @keyup.enter="loadCostAdjustments" />
              <el-input v-model="costAdjustmentPnFilter" placeholder="PN" clearable style="width: 140px" @keyup.enter="loadCostAdjustments" />
              <el-button @click="loadCostAdjustments">搜索</el-button>
            </div>
            <el-table :data="costAdjustmentData" stripe border>
              <el-table-column prop="sales_order_no" label="销售单号" width="170" />
              <el-table-column prop="product_name" label="商品" min-width="160" />
              <el-table-column prop="pn" label="PN" width="130" />
              <el-table-column prop="sn" label="SN" width="150" />
              <el-table-column prop="policy_name" label="政策" width="140" />
              <el-table-column prop="rebate_estimate_amount" label="返利预估" width="110">
                <template #default="{ row }">¥{{ row.rebate_estimate_amount || 0 }}</template>
              </el-table-column>
              <el-table-column prop="cost_adjustment_amount" label="成本调整" width="110">
                <template #default="{ row }">-¥{{ row.cost_adjustment_amount || 0 }}</template>
              </el-table-column>
              <el-table-column prop="final_sales_settlement_cost" label="结算成本" width="110">
                <template #default="{ row }">¥{{ row.final_sales_settlement_cost || 0 }}</template>
              </el-table-column>
            </el-table>
          </div>
        </el-tab-pane>

        <el-tab-pane label="资源权益核销与成本调整" name="resource-rights" lazy>
          <InventoryResourceRights finance-only />
        </el-tab-pane>

        <el-tab-pane label="账户中心" name="account">
          <div class="filter-bar">
            <el-button type="primary" @click="openAccountTransactionDialog()">记账</el-button>
            <el-button @click="refreshAccountBalances">刷新余额</el-button>
          </div>
          <el-table :data="accountList" stripe border>
            <el-table-column prop="account_name" label="账户名称" width="200" />
            <el-table-column label="账户类型" width="140"><template #default="{row}">{{ accountTypeText(row.account_type) }}</template></el-table-column>
            <el-table-column label="厂商" min-width="140">
              <template #default="{ row }">{{ row.supplier_name || '-' }}</template>
            </el-table-column>
            <el-table-column label="银行" min-width="140">
              <template #default="{ row }">{{ row.bank_name || '-' }}</template>
            </el-table-column>
            <el-table-column label="账号" min-width="180">
              <template #default="{ row }">{{ row.account_number || '-' }}</template>
            </el-table-column>
            <el-table-column label="余额" width="140">
              <template #default="{ row }">
                <span :style="{ color: row.balance >= 0 ? '#67c23a' : '#f56c6c', fontWeight: 'bold' }">
                  ¥{{ Number(row.balance).toFixed(2) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="240">
              <template #default="{ row, $index }">
                <el-button link type="primary" :disabled="$index === 0" @click="moveAccount($index, -1)">上移</el-button>
                <el-button link type="primary" :disabled="$index === accountList.length - 1" @click="moveAccount($index, 1)">下移</el-button>
                <el-button link type="primary" @click="openAccountDetail(row)">查询</el-button>
                <el-button link type="primary" @click="openAccountEdit(row)">编辑</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-pagination
            v-model:current-page="accountQuery.page"
            v-model:page-size="accountQuery.pageSize"
            :total="accountTotal"
            layout="total, sizes, prev, pager, next"
            @size-change="loadAccountList"
            @current-change="loadAccountList"
          />
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <el-dialog v-model="subsidyReceiptDialogVisible" :title="subsidyReceiptMode === 'create' ? '登记国补银行到账' : '分配未核销到账款'" width="760px">
      <el-form label-width="110px">
        <el-form-item v-if="subsidyReceiptMode === 'create'" label="到账日期" required>
          <el-date-picker v-model="subsidyReceiptForm.receiptDate" type="date" value-format="YYYY-MM-DD" />
        </el-form-item>
        <el-form-item label="实际到账账户">
          <el-select v-model="subsidyReceiptForm.accountId" disabled style="width:100%">
            <el-option v-for="account in settlementAccounts" :key="account.account_id" :label="account.account_name" :value="account.account_id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="subsidyReceiptMode === 'create'" label="银行到账金额" required>
          <el-input-number v-model="subsidyReceiptForm.amount" :min="0.01" :precision="2" style="width:220px" />
        </el-form-item>
        <el-form-item v-else label="可分配金额">¥{{ formatMoney(subsidyReceiptForm.amount) }}</el-form-item>
        <el-form-item v-if="subsidyReceiptMode === 'create'" label="银行流水号">
          <el-input v-model="subsidyReceiptForm.bankReference" />
        </el-form-item>
        <el-form-item label="核销明细">
          <el-table :data="subsidyReceiptForm.allocations" border size="small" style="width:100%">
            <el-table-column prop="orderNo" label="订单号" min-width="180" />
            <el-table-column label="剩余应收" width="120"><template #default="{row}">¥{{ formatMoney(row.remaining) }}</template></el-table-column>
            <el-table-column label="本次核销" width="180"><template #default="{row}"><el-input-number v-model="row.amount" :min="0" :max="row.remaining" :precision="2" /></template></el-table-column>
          </el-table>
        </el-form-item>
        <el-form-item v-if="subsidyReceiptMode === 'create'" label="未分配金额">
          ¥{{ formatMoney(Math.max(0, Number(subsidyReceiptForm.amount || 0) - subsidyAllocationTotal)) }}
        </el-form-item>
        <el-form-item label="备注"><el-input v-model="subsidyReceiptForm.remark" type="textarea" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="subsidyReceiptDialogVisible=false">取消</el-button><el-button type="primary" @click="submitSubsidyReceipt">确认</el-button></template>
    </el-dialog>

    <el-dialog v-model="subsidyAdjustmentDialogVisible" title="国补差额申请" width="520px">
      <el-form label-width="100px">
        <el-form-item label="订单号">{{ subsidyAdjustmentForm.orderNo }}</el-form-item>
        <el-form-item label="剩余应收">¥{{ formatMoney(subsidyAdjustmentForm.remaining) }}</el-form-item>
        <el-form-item label="差额类型"><el-select v-model="subsidyAdjustmentForm.adjustmentType"><el-option label="手续费" value="FEE" /><el-option label="差额核销" value="WRITEOFF" /></el-select></el-form-item>
        <el-form-item label="差额金额"><el-input-number v-model="subsidyAdjustmentForm.amount" :min="0.01" :max="subsidyAdjustmentForm.remaining" :precision="2" /></el-form-item>
        <el-form-item label="财务科目" required><el-input v-model="subsidyAdjustmentForm.financeCategory" placeholder="按财务要求填写处理科目" /></el-form-item>
        <el-form-item label="原因" required><el-input v-model="subsidyAdjustmentForm.reason" type="textarea" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="subsidyAdjustmentDialogVisible=false">取消</el-button><el-button type="primary" @click="submitSubsidyAdjustment">提交审批</el-button></template>
    </el-dialog>

    <!-- 结算对话框 -->
    <el-dialog v-model="settlementDialogVisible" title="创建结算单" width="700px" @close="resetSettlementForm">
      <el-form label-width="100px">
        <el-form-item label="供应商" required>
          <el-select v-model="settlementForm.supplierId" placeholder="请选择供应商" style="width: 100%" :disabled="settlementSelectionLocked" @change="onSupplierChange">
            <el-option v-for="s in suppliers" :key="s.supplier_id" :label="s.name" :value="s.supplier_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="收款账户" required>
          <el-select v-model="settlementForm.paymentAccountType" placeholder="请选择收款账户" style="width: 100%" @change="onPaymentAccountTypeChange">
            <el-option
              v-for="account in currentSupplierPaymentAccounts"
              :key="account.accountId"
              :label="formatSupplierAccountLabel(account)"
              :value="`saved:${account.accountId}`"
            />
            <el-option label="其他" value="other" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="settlementForm.remark" type="textarea" :rows="2" maxlength="512" show-word-limit placeholder="请输入结算备注" />
        </el-form-item>
        <template v-if="settlementForm.paymentAccountType === 'other'">
          <el-form-item label="其他说明" required>
            <el-input v-model="settlementForm.otherPaymentRemark" type="textarea" rows="2" placeholder="请输入结算账户说明" />
          </el-form-item>
          <el-form-item label="凭证图片" required>
            <el-upload
              :auto-upload="false"
              :limit="1"
              accept="image/*"
              :file-list="otherPaymentFileList"
              :on-change="handleOtherPaymentImageChange"
              :on-remove="handleOtherPaymentImageRemove"
              :on-exceed="handleOtherPaymentImageExceed"
            >
              <el-button>上传图片</el-button>
            </el-upload>
          </el-form-item>
        </template>
      </el-form>

      <div v-if="unpaidList.length > 0">
        <el-table :data="unpaidList" stripe border @selection-change="onSelectionChange" ref="settlementTableRef">
          <el-table-column type="selection" width="50" />
          <el-table-column prop="product_name" label="采购商品" min-width="150" />
          <el-table-column label="本次金额" width="170">
            <template #default="{ row }">
              <el-input-number
                v-model="row.settle_amount"
                :min="0.01"
                :max="Number(row.available_amount || 0)"
                :precision="2"
                size="small"
                controls-position="right"
              />
            </template>
          </el-table-column>
          <el-table-column prop="supplier_name" label="供应商" width="130" />
          <el-table-column prop="request_no" label="采购单号" width="180" />
          <el-table-column prop="total_amount" label="应付金额" width="130">
            <template #default="{ row }">¥{{ row.total_amount }}</template>
          </el-table-column>
          <el-table-column prop="create_time" label="创建时间" width="160" />
        </el-table>
        <div class="settlement-total">
          已选<strong>{{ selectedPayableIds.length }}</strong> 项，
          结算总金额：<strong class="total-amount">¥{{ settlementTotalAmount }}</strong>
        </div>
      </div>
      <div v-else>
        <el-empty :description="settlementForm.supplierId ? '该供应商没有待结算的应付款' : '暂无待结算应付款'" />
      </div>

      <template #footer>
        <el-button @click="settlementDialogVisible = false">取消</el-button>
        <el-button type="info" @click="saveSettlementDraft">保存草稿</el-button>
        <el-button type="primary" @click="handleSettlementSubmit" :loading="settlementLoading" :disabled="selectedPayableIds.length === 0 || Number(settlementTotalAmount) <= 0">
          生成结算单
        </el-button>
      </template>
    </el-dialog>

    <!-- 添加支出对话框-->
    <el-dialog v-model="expenseDialogVisible" :title="expenseForm.expenseId ? '编辑费用草稿' : '添加费用'" width="500px" @close="handleDialogClose">
      <el-form :model="expenseForm" label-width="100px">
        <el-form-item label="报销类型" required>
          <el-select v-model="expenseForm.expenseTypeId" placeholder="请选择类型" style="width: 100%">
            <el-option v-for="item in expenseTypeOptions" :key="item.type_id" :label="item.name" :value="item.type_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="门店" required>
          <el-select v-model="expenseForm.storeId" placeholder="请选择门店" style="width: 100%" :disabled="Boolean(expenseForm.expenseId)">
            <el-option v-for="s in stores" :key="s.store_id" :label="s.name" :value="s.store_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="金额" required>
          <el-input v-model="expenseForm.amount" placeholder="金额" style="width: 100%" />
        </el-form-item>
        <el-form-item label="费用发生方" required>
          <el-input v-model="expenseForm.expenseParty" placeholder="供应商、员工或外部单位" />
        </el-form-item>
        <el-form-item label="费用日期">
          <el-date-picker v-model="expenseForm.expenseDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item label="支付方式">
          <el-select v-model="expenseForm.paymentMethod" placeholder="请选择" style="width: 100%">
            <el-option label="财务对公" value="CORPORATE" />
            <el-option label="私人垫付" value="PERSONAL_ADVANCE" />
          </el-select>
        </el-form-item>
        <el-form-item label="是否有发票">
          <el-switch v-model="expenseForm.hasInvoice" />
        </el-form-item>
        <template v-if="expenseForm.hasInvoice">
          <el-form-item label="发票类型">
            <el-input v-model="expenseForm.invoiceType" placeholder="如：普票、专票" />
          </el-form-item>
          <el-form-item label="发票号码">
            <el-input v-model="expenseForm.invoiceNo" />
          </el-form-item>
        </template>
        <el-form-item label="备注">
          <el-input v-model="expenseForm.remark" type="textarea" rows="3" placeholder="支出备注" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="expenseDialogVisible = false">取消</el-button>
        <el-button type="info" @click="saveExpenseDraft">保存草稿</el-button>
        <el-button type="primary" @click="handleExpenseSubmit" :loading="submitLoading">确定</el-button>
      </template>
    </el-dialog>

    <!-- 确认付款对话框（费用报销） -->
    <el-dialog v-model="payExpenseVisible" title="确认付款" width="450px">
      <el-form label-width="100px">
        <el-form-item label="费用单号">
          <span>{{ payExpenseRow?.expense_no || '-' }}</span>
        </el-form-item>
        <el-form-item label="金额">
          <span style="color: #e6a23c; font-weight: bold;">¥{{ payExpenseRow?.amount || 0 }}</span>
        </el-form-item>
        <el-form-item label="发起人">
          <span>{{ payExpenseRow?.submit_user || '-' }}</span>
        </el-form-item>
        <el-form-item label="结算账号" required>
          <el-select v-model="payExpenseAccountId" placeholder="请选择结算账号" style="width: 100%" filterable>
            <el-option
              v-for="acc in settlementAccounts"
              :key="acc.account_id"
              :label="formatSettlementAccountOption(acc)"
              :value="acc.account_id"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="payExpenseVisible = false">取消</el-button>
        <el-button type="success" @click="doPayExpense" :loading="payExpenseLoading">确认付款</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="settlementDetailVisible" title="应付结算单详情" width="820px">
      <div v-if="settlementDetail">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="结算单号">{{ settlementDetail.settlement_no || '-' }}</el-descriptions-item>
          <el-descriptions-item label="供应商">{{ settlementDetail.supplier_name || '-' }}</el-descriptions-item>
          <el-descriptions-item label="结算金额">¥{{ settlementDetail.total_amount || 0 }}</el-descriptions-item>
          <el-descriptions-item label="已付金额">¥{{ settlementDetail.paid_amount || 0 }}</el-descriptions-item>
          <el-descriptions-item label="结算状态">
            <el-tag :type="getSettlementStatusTagType(settlementDetail.status)">
              {{ getSettlementStatusText(settlementDetail.status) }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="付款状态">
            <el-tag :type="getPaymentStatusTagType(settlementDetail.payment_status)">
              {{ getPaymentStatusText(settlementDetail.payment_status) }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="收款单位">{{ getCounterpartyCompany(settlementDetail) }}</el-descriptions-item>
          <el-descriptions-item label="开户行">{{ getCounterpartyBank(settlementDetail) }}</el-descriptions-item>
          <el-descriptions-item label="收款账号">{{ getCounterpartyAccount(settlementDetail) }}</el-descriptions-item>
          <el-descriptions-item label="收款方税号">{{ getCounterpartyTaxNo(settlementDetail) }}</el-descriptions-item>
          <el-descriptions-item label="收款备注" :span="2">{{ getCounterpartyRemark(settlementDetail) }}</el-descriptions-item>
          <el-descriptions-item label="创建人">{{ settlementDetail.create_user || '-' }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ formatDateTime(settlementDetail.create_time) }}</el-descriptions-item>
          <el-descriptions-item label="提交时间">{{ formatDateTime(settlementDetail.confirmed_time) }}</el-descriptions-item>
          <el-descriptions-item label="作废时间">{{ formatDateTime(settlementDetail.voided_time) }}</el-descriptions-item>
        </el-descriptions>

        <el-table :data="settlementDetail.items || []" stripe border class="mt-20">
          <el-table-column prop="request_no" label="采购单号" min-width="180" />
          <el-table-column prop="amount" label="结算金额" width="130">
            <template #default="{ row }">¥{{ row.amount }}</template>
          </el-table-column>
          <el-table-column prop="payable_id" label="应付款ID" min-width="180" show-overflow-tooltip />
        </el-table>

        <el-table :data="settlementDetail.payments || []" stripe border class="mt-20">
          <el-table-column prop="settlement_no" label="结算单号" width="180" />
          <el-table-column prop="amount" label="付款金额" width="120">
            <template #default="{ row }">¥{{ row.amount }}</template>
          </el-table-column>
          <el-table-column prop="payment_time" label="付款时间" width="160">
            <template #default="{ row }">{{ formatDateTime(row.payment_time) }}</template>
          </el-table-column>
          <el-table-column prop="batch_id" label="付款批次ID" min-width="180" show-overflow-tooltip />
          <el-table-column prop="remark" label="备注" min-width="140" />
        </el-table>
      </div>
    </el-dialog>

    <el-dialog v-model="purchaseDetailVisible" title="采购申请详情" width="1100px">
      <div v-if="purchaseDetail">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="采购单号">{{ purchaseDetail.request_no || '-' }}</el-descriptions-item>
          <el-descriptions-item label="供应商">{{ purchaseDetail.supplier_name || purchaseDetail.Supplier?.name || '-' }}</el-descriptions-item>
          <el-descriptions-item label="申请门店">{{ purchaseDetail.store_name || purchaseDetail.Store?.name || '-' }}</el-descriptions-item>
          <el-descriptions-item label="状态">{{ purchaseDetail.status || '-' }}</el-descriptions-item>
          <el-descriptions-item label="申请金额">¥{{ formatMoney(purchaseDetail.current_total_amount ?? purchaseDetail.total_amount) }}</el-descriptions-item>
          <el-descriptions-item label="是否使用返利">
            <el-tag :type="hasPurchaseRebateDeduction(purchaseDetail) ? 'success' : 'info'">
              {{ hasPurchaseRebateDeduction(purchaseDetail) ? '是' : '否' }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="返利抵扣">-¥{{ formatMoney(purchaseDetail.current_rebate_deduction ?? purchaseDetail.rebate_deduction) }}</el-descriptions-item>
          <el-descriptions-item label="实际应付">¥{{ formatMoney(purchaseActualAmount(purchaseDetail)) }}</el-descriptions-item>
          <el-descriptions-item label="申请时间">{{ purchaseDetail.create_time ? formatDate(purchaseDetail.create_time) : '-' }}</el-descriptions-item>
          <el-descriptions-item label="备注">{{ purchaseDetail.reason || purchaseDetail.remark || '-' }}</el-descriptions-item>
        </el-descriptions>
        <el-table :data="purchaseDetail.items || purchaseDetail.PurchaseRequestItems || []" stripe border size="small" style="margin-top: 14px;">
          <el-table-column prop="product_name" label="商品名称" min-width="180" />
          <el-table-column label="商品编码" width="120" show-overflow-tooltip>
            <template #default="{ row }">{{ row.product_code || '-' }}</template>
          </el-table-column>
          <el-table-column label="厂商编码" width="150" show-overflow-tooltip>
            <template #default="{ row }">{{ row.manufacturer_code || '-' }}</template>
          </el-table-column>
          <el-table-column prop="pn_code" label="PN码" width="140" />
          <el-table-column prop="quantity" label="数量" width="80" />
          <el-table-column prop="unit_price" label="单价" width="110">
            <template #default="{ row }">¥{{ row.unit_price || 0 }}</template>
          </el-table-column>
          <el-table-column prop="subtotal" label="小计" width="110">
            <template #default="{ row }">¥{{ formatMoney(purchaseItemSubtotal(row)) }}</template>
          </el-table-column>
          <el-table-column prop="rebate_deduction" label="返利抵扣" width="110">
            <template #default="{ row }">-¥{{ formatMoney(row.rebate_deduction) }}</template>
          </el-table-column>
          <el-table-column label="抵扣后金额" width="120">
            <template #default="{ row }">¥{{ formatMoney(purchaseItemActualAmount(row)) }}</template>
          </el-table-column>
        </el-table>
      </div>
    </el-dialog>

    <!-- 厂家政策对话框 -->
    <el-dialog
      v-model="manufacturerPolicyDialogVisible"
      :title="manufacturerPolicyEditingId ? '编辑厂家政策' : '新增厂家政策'"
      width="720px"
      @close="resetManufacturerPolicyForm"
    >
      <el-form :model="manufacturerPolicyForm" label-width="130px">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="供应商/厂家" required>
              <el-select v-model="manufacturerPolicyForm.supplierId" filterable placeholder="请选择供应商" style="width: 100%">
                <el-option v-for="s in suppliers" :key="s.supplier_id" :label="s.name" :value="s.supplier_id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="政策名称" required>
              <el-input v-model="manufacturerPolicyForm.policyName" placeholder="如 P差政策/活动补贴" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="政策类型">
              <el-select v-model="manufacturerPolicyForm.policyType" style="width: 100%">
                <el-option label="P差" value="p0_difference" />
                <el-option label="活动补贴" value="activity" />
                <el-option label="教育补贴" value="education" />
                <el-option label="其他" value="other" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="状态">
              <el-switch v-model="manufacturerPolicyForm.status" :active-value="1" :inactive-value="0" active-text="启用" inactive-text="停用" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="PN">
              <el-input v-model="manufacturerPolicyForm.pn" placeholder="为空表示按其他条件匹配" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="型号">
              <el-input v-model="manufacturerPolicyForm.model" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="开始日期">
              <el-date-picker v-model="manufacturerPolicyForm.startDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="结束日期">
              <el-date-picker v-model="manufacturerPolicyForm.endDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="返利计算方式">
              <el-select v-model="manufacturerPolicyForm.rebateCalculationType" style="width: 100%">
                <el-option label="固定金额" value="fixed_amount" />
                <el-option label="按比例" value="percentage" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item :label="manufacturerPolicyForm.rebateCalculationType === 'percentage' ? '返利比例(%)' : '返利金额'">
              <el-input-number
                v-if="manufacturerPolicyForm.rebateCalculationType === 'percentage'"
                v-model="manufacturerPolicyForm.rebateRate"
                :min="0"
                :precision="2"
                style="width: 100%"
              />
              <el-input-number
                v-else
                v-model="manufacturerPolicyForm.rebateAmount"
                :min="0"
                :precision="2"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="影响销售成本">
              <el-switch v-model="manufacturerPolicyForm.affectSalesSettlementCost" active-text="是" inactive-text="否" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="成本调整方式">
              <el-select v-model="manufacturerPolicyForm.costAdjustmentType" style="width: 100%">
                <el-option label="固定金额" value="fixed_amount" />
                <el-option label="按返利比例" value="percentage" />
                <el-option label="自定义规则(预留)" value="custom_rule" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="成本调整值">
              <el-input-number v-model="manufacturerPolicyForm.costAdjustmentValue" :min="0" :precision="2" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="调整上限">
              <el-input-number v-model="manufacturerPolicyForm.maxCostAdjustmentAmount" :min="0" :precision="2" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="成本调整说明">
              <el-input v-model="manufacturerPolicyForm.costAdjustmentRemark" type="textarea" rows="2" />
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="备注">
              <el-input v-model="manufacturerPolicyForm.remark" type="textarea" rows="2" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="manufacturerPolicyDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="manufacturerPolicyLoading" @click="handleManufacturerPolicySubmit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 结算账户流水对话框 -->
    <el-dialog v-model="accountDetailVisible" :title="'账户流水 - ' + (accountDetailRow?.account_name || '')" width="800px">
      <div class="filter-bar" style="margin-bottom: 12px;">
        <span>余额：<b :style="{ color: accountDetailBalance >= 0 ? '#67c23a' : '#f56c6c' }">¥{{ Number(accountDetailBalance).toFixed(2) }}</b></span>
        <el-button
          type="primary"
          size="small"
          :disabled="accountDetailRow?.account_type === 'SUPPLIER_REBATE'"
          @click="openAccountTransactionDialog(accountDetailRow)"
        >
          {{ accountDetailRow?.account_type === 'SUPPLIER_REBATE' ? '返利管理记账' : '记账' }}
        </el-button>
      </div>
      <el-table :data="accountTransactions" stripe border>
        <el-table-column prop="create_time" label="时间" width="160">
          <template #default="{ row }">{{ formatDate(row.create_time) }}</template>
        </el-table-column>
        <el-table-column prop="type" label="类型" width="80">
          <template #default="{ row }">
            <el-tag :type="row.type === 'income' ? 'success' : 'danger'" size="small">
              {{ row.type === 'income' ? '入账' : '出账' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="amount" label="金额" width="120">
          <template #default="{ row }">¥{{ Number(row.amount).toFixed(2) }}</template>
        </el-table-column>
        <el-table-column prop="balance_after" label="余额" width="120">
          <template #default="{ row }">¥{{ Number(row.balance_after).toFixed(2) }}</template>
        </el-table-column>
        <el-table-column prop="description" label="摘要" min-width="140" />
        <el-table-column prop="related_ref" label="关联单号" width="140" />
        <el-table-column prop="create_user" label="操作人" width="80" />
      </el-table>
      <el-pagination
        v-model:current-page="accountTxnQuery.page"
        v-model:page-size="accountTxnQuery.pageSize"
        :total="accountTxnTotal"
        layout="total, sizes, prev, pager, next"
        style="margin-top: 12px;"
        @size-change="loadAccountTransactions"
        @current-change="loadAccountTransactions"
      />
    </el-dialog>

    <!-- 编辑账户对话框-->
    <el-dialog v-model="accountEditVisible" title="编辑账户信息" width="420px">
      <el-form :model="accountEditForm" label-width="100px">
        <el-form-item label="账户名称" required>
          <el-input v-model="accountEditForm.accountName" placeholder="输入账户名称" />
        </el-form-item>
        <el-form-item label="账户类型" required>
          <el-select v-model="accountEditForm.accountType" style="width: 100%">
            <el-option v-for="type in settlementAccountTypes" :key="type.value" :label="type.label" :value="type.value" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="accountEditForm.accountType === 'SUPPLIER_REBATE'" label="厂商" required>
          <el-select v-model="accountEditForm.supplierId" placeholder="请选择厂商" filterable style="width: 100%">
            <el-option v-for="supplier in suppliers" :key="supplier.supplier_id" :label="supplier.name" :value="supplier.supplier_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="开户行">
          <el-input v-model="accountEditForm.bankName" placeholder="输入开户行" />
        </el-form-item>
        <el-form-item label="账号">
          <el-input v-model="accountEditForm.accountNumber" placeholder="输入账号" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="accountEditVisible = false">取消</el-button>
        <el-button type="primary" @click="handleAccountEdit" :loading="accountEditLoading">保存</el-button>
      </template>
    </el-dialog>

    <!-- 记账对话框 -->
    <el-dialog v-model="accountTxnDialogVisible" title="记账" width="450px">
      <el-form :model="accountTxnForm" label-width="100px">
        <el-form-item label="结算账户" required>
          <el-select v-model="accountTxnForm.accountId" placeholder="请选择账户" style="width: 100%" filterable>
            <el-option v-for="a in settlementAccounts" :key="a.account_id" :label="`${a.account_name} - ${a.bank_name || ''}`" :value="a.account_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="类型" required>
          <el-radio-group v-model="accountTxnForm.type">
            <el-radio value="income">入账（存入）</el-radio>
            <el-radio value="expense">出账（支出）</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="金额" required>
          <el-input v-model="accountTxnForm.amount" placeholder="请输入金额" type="number" />
        </el-form-item>
        <el-form-item label="摘要">
          <el-input v-model="accountTxnForm.description" placeholder="输入摘要" />
        </el-form-item>
        <el-form-item label="关联单号">
          <el-input v-model="accountTxnForm.relatedRef" placeholder="关联单号（可选）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="accountTxnDialogVisible = false">取消</el-button>
        <el-button type="info" @click="saveAccountTxnDraft">保存草稿</el-button>
        <el-button type="primary" @click="handleAccountTxnSubmit" :loading="accountTxnLoading">确认</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, nextTick, watch } from 'vue'
import InventoryResourceRights from '../components/InventoryResourceRights.vue'
import RebateSettlement from '../components/RebateSettlement.vue'
import RebatePostingOrders from '../components/RebatePostingOrders.vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import * as XLSX from 'xlsx'
import api from '../api'
import { saveDraft, loadDraft, clearDraft, cloneDraft } from '../utils/draft'
import PaymentManagement from './PaymentManagement.vue'

const route = useRoute()
const router = useRouter()
const activeTab = ref('daily')
const syncTabFromRoute = () => {
  activeTab.value = String(route.meta.tab || 'daily')
}
const FINANCE_EXPENSE_DRAFT_KEY = 'finance-expense-create'
const FINANCE_SETTLEMENT_DRAFT_KEY = 'finance-settlement-create'
const FINANCE_ACCOUNT_TXN_DRAFT_KEY = 'finance-account-transaction-create'
const stores = ref([])
const dailyDetails = ref([])
const dailyTotal = ref(0)
const dailyTotalAmount = ref(0)
const paymentMethods = ref([])
const paymentMethodFilter = ref('')
const settledFilter = ref('')
const settlementAccountFilter = ref('')
const settlementAccounts = ref([])
const selectedDetailIds = ref([])
const exportingList = ref('')
const detailTableRef = ref(null)
const subsidyReceivables = ref([])
const subsidyTotal = ref(0)
const subsidyTotalAmount = ref(0)
const subsidyLoading = ref(false)
const selectedSubsidyIds = ref([])
const selectedSubsidyRows = ref([])
const subsidyAccountRoutes = ref([])
const subsidyReceipts = ref([])
const subsidyAdjustments = ref([])
const subsidyReceiptDialogVisible = ref(false)
const subsidyReceiptMode = ref('create')
const subsidyReceiptForm = reactive({
  receiptId:'', receiptDate:new Date().toISOString().slice(0,10), accountId:'',
  bankReference:'', amount:0, allocations:[], remark:''
})
const subsidyAllocationTotal = computed(() => subsidyReceiptForm.allocations.reduce((sum, row) => sum + Number(row.amount || 0), 0))
const subsidyAdjustmentDialogVisible = ref(false)
const subsidyAdjustmentForm = reactive({ detailId:'', orderNo:'', remaining:0, adjustmentType:'FEE', amount:0, financeCategory:'', reason:'' })
const expenseData = ref([])
const expenseTotal = ref(0)

const expenseDialogVisible = ref(false)
const submitLoading = ref(false)
const expenseSettleData = ref([])
const expenseSettleTotal = ref(0)
const expenseSettleFilter = ref('')
const payExpenseVisible = ref(false)
const payExpenseRow = ref(null)
const payExpenseMethod = ref('银行转账')
const payExpenseAccountId = ref('')
const payExpenseLoading = ref(false)
const payableDateRange = ref([])
const payableSupplierFilter = ref('')
const payableSourceFilter = ref('')
const payableStatusFilter = ref('')
const payableSourceNoFilter = ref('')
const purchaseDetailVisible = ref(false)
const purchaseDetail = ref(null)
const payableTableRef = ref(null)
const selectedPayableRows = ref([])
const payableFilterSummary = ref({ totalCount: 0, totalAmount: 0 })

const toNumber = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

const formatMoney = (value) => toNumber(value).toFixed(2)

const selectedDetailTotalAmount = computed(() => dailyDetails.value
  .filter(row => selectedDetailIds.value.includes(row.detail_id))
  .reduce((sum, row) => sum + toNumber(row.amount), 0))

const getPayableSourceText = (row) => {
  const sourceType = row?.source_type || 'purchase'
  if (sourceType === 'expense') return '费用'
  if (sourceType === 'reimbursement') return '报销'
  if (sourceType === 'purchase_adjustment') return '采购调整'
  return '采购'
}

const getPayableSourceTagType = (row) => {
  const sourceType = row?.source_type || 'purchase'
  return {
    purchase: 'info',
    purchase_adjustment: 'success',
    expense: 'warning',
    reimbursement: 'danger'
}[sourceType] || 'info'
}

const getPayableTaxText = (status) => ({
  TAX_INCLUDED: '含税',
  UNTAXED: '未税',
  UNKNOWN: '未知'
}[status] || '未知')

const getPayableTaxTagType = (status) => ({
  TAX_INCLUDED: 'success',
  UNTAXED: 'warning',
  UNKNOWN: 'info'
}[status] || 'info')

const getPayableStatusText = (status) => ({
  unpaid: '待付款',
  partial_settled: '部分结算',
  settling: '结算中',
  credit: '供应商待抵扣',
  offset: '已抵扣',
  paid: '已付款'
}[status] || '待付款')

const getPayableStatusTagType = (status) => ({
  unpaid: 'danger',
  partial_settled: 'warning',
  settling: 'warning',
  credit: 'warning',
  offset: 'success',
  paid: 'success'
}[status] || 'danger')

const getPayablePayeeName = (row) => row?.payee_name || row?.supplier_name || row?.expense_party || '-'

const hasPurchaseRebateDeduction = (request) => toNumber(request?.current_rebate_deduction ?? request?.rebate_deduction) > 0

const purchaseActualAmount = (request) => {
  const total = toNumber(request?.current_total_amount ?? request?.total_amount)
  const rebate = toNumber(request?.current_rebate_deduction ?? request?.rebate_deduction)
  if (request?.current_actual_total !== undefined && request?.current_actual_total !== null) {
    return toNumber(request.current_actual_total)
  }
  const actual = toNumber(request?.actual_total)
  if (actual > 0 || total === 0) return actual
  return Math.max(0, total - rebate)
}

const purchaseItemSubtotal = (item) => {
  const subtotal = toNumber(item?.subtotal)
  if (subtotal > 0) return subtotal
  return toNumber(item?.unit_price) * toNumber(item?.quantity)
}

const purchaseItemActualAmount = (item) => {
  return Math.max(0, purchaseItemSubtotal(item) - toNumber(item?.rebate_deduction))
}

const expenseSettleQuery = reactive({
  page: 1,
  pageSize: 20
})

// 应付管理
const suppliers = ref([])
const payableData = ref([])
const payableTotal = ref(0)
const settlementDialogVisible = ref(false)
const settlementLoading = ref(false)
const unpaidList = ref([])
const selectedPayables = ref([])
const settlementTableRef = ref(null)
const settlementSelectionLocked = ref(false)
const otherPaymentFileList = ref([])
const reimbursementSettlementData = ref([])
const reimbursementSettlementTotal = ref(0)
const reimbursementSettlementStatusFilter = ref('')
const reimbursementPaymentStatusFilter = ref('')
const settlementDetailVisible = ref(false)
const settlementDetail = ref(null)

// 返利管理
const rebateData = ref([])
const rebatePostingKey = ref(0)
const rebateTotal = ref(0)
const rebateSummary = ref([])
const rebateSummaryTotal = ref(0)
const rebateSupplierFilter = ref('')
const rebateTypeFilter = ref('')
const rebateEstimateData = ref([])
const rebateEstimateOrderFilter = ref('')
const rebateEstimateSupplierFilter = ref('')
const rebateEstimateStatusFilter = ref('')
const manufacturerPolicyData = ref([])
const manufacturerPolicySupplierFilter = ref('')
const manufacturerPolicyPnFilter = ref('')
const manufacturerPolicyDialogVisible = ref(false)
const manufacturerPolicyLoading = ref(false)
const manufacturerPolicyEditingId = ref('')
const manufacturerPriceData = ref([])
const manufacturerPriceSupplierFilter = ref('')
const manufacturerPricePnFilter = ref('')
const costAdjustmentData = ref([])
const costAdjustmentOrderFilter = ref('')
const costAdjustmentPnFilter = ref('')

const rebateQuery = reactive({
  page: 1,
  pageSize: 20
})

const manufacturerPolicyForm = reactive({
  supplierId: '',
  policyName: '',
  policyType: 'activity',
  pn: '',
  model: '',
  startDate: '',
  endDate: '',
  rebateCalculationType: 'fixed_amount',
  rebateAmount: 0,
  rebateRate: 0,
  affectSalesSettlementCost: true,
  costAdjustmentType: 'fixed_amount',
  costAdjustmentValue: 0,
  maxCostAdjustmentAmount: null,
  costAdjustmentRemark: '',
  remark: '',
  status: 1
})

const payableQuery = reactive({
  page: 1,
  pageSize: 20
})

const reimbursementSettlementQuery = reactive({
  page: 1,
  pageSize: 20
})

const settlementForm = reactive({
  supplierId: '',
  paymentAccountType: '',
  supplierAccountId: '',
  otherPaymentRemark: '',
  otherPaymentImage: '',
  remark: ''
})

const accountList = ref([])
const accountTotal = ref(0)
const accountQuery = reactive({ page: 1, pageSize: 100 })
const accountDetailVisible = ref(false)
const accountDetailRow = ref(null)
const accountDetailBalance = ref(0)
const accountTransactions = ref([])
const accountTxnTotal = ref(0)
const accountTxnQuery = reactive({ page: 1, pageSize: 20 })
const accountTxnDialogVisible = ref(false)
const accountTxnLoading = ref(false)
const accountEditVisible = ref(false)
const accountEditLoading = ref(false)
const accountEditForm = reactive({
  accountId: '',
  accountName: '',
  accountType: 'FUND',
  supplierId: '',
  bankName: '',
  accountNumber: ''
})
const settlementAccountTypes = [
  { value: 'FUND', label: '资金账户' },
  { value: 'POLICY_RECEIVABLE', label: '政策补贴应收' },
  { value: 'CARE_CREDIT', label: 'Care可用金' },
  { value: 'SUPPLIER_REBATE', label: '厂商返利' }
]
const accountTxnForm = reactive({
  accountId: '',
  type: 'income',
  amount: 0,
  description: '',
  relatedRef: ''
})

const queryParams = reactive({
  page: 1,
  pageSize: 20,
  date: '',
  storeId: ''
})

const subsidyQuery = reactive({
  page: 1,
  pageSize: 20,
  dateRange: [],
  storeId: '',
  settled: ''
})

const expenseQuery = reactive({
  page: 1,
  pageSize: 20
})

const runListExport = async (key, label, exporter, params) => {
  exportingList.value = key
  try {
    await exporter(params)
    ElMessage.success(`${label}导出成功`)
  } catch (err) {
    ElMessage.error(err.response?.data?.message || `${label}导出失败`)
  } finally {
    exportingList.value = ''
  }
}

const buildDailyExportParams = () => ({
  ...(queryParams.dateRange?.length === 2 ? { startDate: queryParams.dateRange[0], endDate: queryParams.dateRange[1] } : {}),
  ...(queryParams.storeId ? { storeId: queryParams.storeId } : {}),
  ...(paymentMethodFilter.value ? { paymentMethod: paymentMethodFilter.value } : {}),
  ...(settledFilter.value !== '' ? { settled: settledFilter.value } : {}),
  ...(settlementAccountFilter.value ? { settlementAccountId: settlementAccountFilter.value } : {})
})

const buildSubsidyExportParams = () => ({
  ...(subsidyQuery.dateRange?.length === 2 ? { startDate: subsidyQuery.dateRange[0], endDate: subsidyQuery.dateRange[1] } : {}),
  ...(subsidyQuery.storeId ? { storeId: subsidyQuery.storeId } : {}),
  ...(subsidyQuery.settled !== '' ? { settled: subsidyQuery.settled } : {})
})

const handleExportDaily = () => runListExport('daily', '日结单', api.exportDailyDetails, buildDailyExportParams())
const handleExportSubsidy = () => runListExport('subsidy', '国补应收单', api.exportNationalSubsidyReceivables, buildSubsidyExportParams())
const handleExportExpense = () => runListExport('expense', '费用清单', api.exportExpenseList, { ...expenseQuery })
const handleExportPayable = () => runListExport('payable', '应付管理', api.exportPayableList, {
  ...(payableDateRange.value?.length === 2 ? { startDate: payableDateRange.value[0], endDate: payableDateRange.value[1] } : {}),
  ...(payableSupplierFilter.value ? { supplierId: payableSupplierFilter.value } : {}),
  ...(payableSourceFilter.value ? { sourceType: payableSourceFilter.value } : {}),
  ...(payableStatusFilter.value ? { status: payableStatusFilter.value } : {}),
  ...(payableSourceNoFilter.value ? { sourceNo: payableSourceNoFilter.value } : {})
})
const handleExportReimbursementSettlement = () => runListExport('reimbursement-settlement', '报销结算单', api.exportSettlementList, {
  settlementType: 'reimbursement',
  ...(reimbursementSettlementStatusFilter.value ? { status: reimbursementSettlementStatusFilter.value } : {}),
  ...(reimbursementPaymentStatusFilter.value ? { paymentStatus: reimbursementPaymentStatusFilter.value } : {})
})

const expenseForm = reactive({
  expenseId: '',
  expenseTypeId: '',
  storeId: '',
  amount: 0,
  expenseParty: '',
  expenseDate: new Date().toISOString().slice(0, 10),
  paymentMethod: 'CORPORATE',
  hasInvoice: false,
  invoiceType: '',
  invoiceNo: '',
  remark: ''
})

const expenseTypeOptions = ref([])

const selectedPayableIds = computed(() => [...new Set(selectedPayables.value.map(p => p.payable_id))])

const getPayableRemainingAmount = (row) => {
  if (row?.remaining_amount !== undefined && row?.remaining_amount !== null) return toNumber(row.remaining_amount)
  return Math.max(0, toNumber(row?.total_amount) - toNumber(row?.settled_amount))
}

const selectedPayableTotalAmount = computed(() => {
  return selectedPayableRows.value.reduce((sum, row) => sum + getPayableRemainingAmount(row), 0)
})

const settlementLineAmount = (row) => {
  return Number(row.settle_amount || 0)
}

const settlementTotalAmount = computed(() => {
  return selectedPayables.value.reduce((sum, row) => sum + settlementLineAmount(row), 0).toFixed(2)
})

const formatSettlementAccountOption = (account) => {
  return `${account.account_name || '-'}（余额：¥${Number(account.balance || 0).toFixed(2)}）`
}

const effectiveSettlementSupplierId = computed(() => {
  if (settlementForm.supplierId) return settlementForm.supplierId
  const supplierIds = [...new Set(selectedPayables.value.map(p => p.supplier_id).filter(Boolean))]
  return supplierIds.length === 1 ? supplierIds[0] : ''
})

const currentSupplierPaymentAccounts = computed(() => {
  const supplier = suppliers.value.find(s => s.supplier_id === effectiveSettlementSupplierId.value)
  const accounts = supplier?.paymentAccounts || supplier?.SupplierPaymentAccounts || []
  return accounts
    .map(account => ({
      accountId: account.accountId || account.account_id || '',
      companyName: account.companyName || account.company_name || '',
      taxNo: account.taxNo || account.tax_no || '',
      bankName: account.bankName || account.bank_name || '',
      accountNumber: account.accountNumber || account.account_number || '',
      remark: account.remark || ''
    }))
    .filter(account => account.accountId)
})

const formatSupplierAccountLabel = (account) => {
  const company = account.companyName || '未填写公司'
  const bank = account.bankName || '未填写开户行'
  const accountNo = account.accountNumber || '未填写账号'
  return `${company} / ${bank} / ${accountNo}`
}

const getCounterpartyInfo = (row) => row?.counterparty_payment_info || row?.supplier_account_snapshot_parsed || {}
const getCounterpartyCompany = (row) => {
  const info = getCounterpartyInfo(row)
  return info.companyName || row?.payee_name || row?.supplier_name || '-'
}
const getCounterpartyBank = (row) => getCounterpartyInfo(row).bankName || '-'
const getCounterpartyAccount = (row) => getCounterpartyInfo(row).accountNumber || '-'
const getCounterpartyTaxNo = (row) => getCounterpartyInfo(row).taxNo || '-'
const getCounterpartyRemark = (row) => {
  const info = getCounterpartyInfo(row)
  return info.remark || row?.other_payment_remark || '-'
}

const getSettlementStatusText = (status) => {
  const map = {
    draft: '草稿',
    pending_approval: '待审批',
    confirmed: '待付款',
    voided: '已作废',
    unpaid: '草稿',
    paid: '待付款',
    cancelled: '已作废'
  }
  return map[status] || status || '-'
}

const getSettlementStatusTagType = (status) => {
  const map = {
    draft: 'info',
    pending_approval: 'warning',
    confirmed: 'warning',
    voided: 'danger',
    unpaid: 'info',
    paid: 'warning',
    cancelled: 'danger'
  }
  return map[status] || 'info'
}

const getPaymentStatusText = (status) => {
  const map = {
    unpaid: '未付款',
    partial_paid: '部分付款',
    paid: '已付款'
  }
  return map[status] || status || '未付款'
}

const getPaymentStatusTagType = (status) => {
  const map = {
    unpaid: 'info',
    partial_paid: 'warning',
    paid: 'success'
  }
  return map[status] || 'info'
}

const resetPaymentAccountFields = () => {
  settlementForm.paymentAccountType = ''
  settlementForm.supplierAccountId = ''
  settlementForm.otherPaymentRemark = ''
  settlementForm.otherPaymentImage = ''
  otherPaymentFileList.value = []
}

onMounted(() => {
  syncTabFromRoute()
  loadStores()
  loadPaymentMethods()
  loadSettlementAccounts()
  loadDailyData()
  loadSubsidyReceivables()
  loadSubsidyAuxiliary()
  loadExpenseData()
  loadExpenseSettleData()
  loadExpenseTypes()
  loadPayableData()
  loadSuppliers()
  loadReimbursementSettlementData()
  loadRebateList()
  loadRebateSummary()
  loadRebateEstimates()
  loadManufacturerPolicies()
  loadManufacturerPrices()
  loadCostAdjustments()
  loadAccountList()
})

watch(() => route.path, syncTabFromRoute)

// ==============================================
// 日结单 - 逐条清单
// ==============================================
const loadDailyData = async () => {
  try {
    const params = {
      page: queryParams.page,
      pageSize: queryParams.pageSize
    }
    if (queryParams.dateRange && queryParams.dateRange.length === 2) {
      params.startDate = queryParams.dateRange[0]
      params.endDate = queryParams.dateRange[1]
    }
    if (queryParams.storeId) params.storeId = queryParams.storeId
    if (paymentMethodFilter.value) params.paymentMethod = paymentMethodFilter.value
    if (settledFilter.value !== '') params.settled = settledFilter.value
    if (settlementAccountFilter.value) params.settlementAccountId = settlementAccountFilter.value

    const res = await api.getDailyDetails(params)
    if (res.code === 0) {
      dailyDetails.value = res.data?.list || []
      dailyTotal.value = res.data?.pagination?.total || res.data?.total || 0
      dailyTotalAmount.value = res.data?.totalAmount || 0
    }
    selectedDetailIds.value = []
  } catch (err) { ElMessage.error('加载日结清单失败') }
}

const onDetailSelectionChange = (val) => {
  selectedDetailIds.value = val.map(d => d.detail_id)
}

const dailyBusinessTypeText = value => value === 'deposit_receipt' ? '定金收款' : '销售收款'

const subsidyPaymentType = value => String(value || '').replace(/-政策补贴应收$/, '')

const loadSubsidyReceivables = async () => {
  subsidyLoading.value = true
  try {
    const params = {
      page: subsidyQuery.page,
      pageSize: subsidyQuery.pageSize
    }
    if (subsidyQuery.dateRange?.length === 2) {
      params.startDate = subsidyQuery.dateRange[0]
      params.endDate = subsidyQuery.dateRange[1]
    }
    if (subsidyQuery.storeId) params.storeId = subsidyQuery.storeId
    if (subsidyQuery.settled !== '') params.settled = subsidyQuery.settled
    const res = await api.getNationalSubsidyReceivables(params)
    if (res.code === 0) {
      subsidyReceivables.value = res.data?.list || []
      subsidyTotal.value = res.data?.pagination?.total || res.data?.total || 0
      subsidyTotalAmount.value = Number(res.data?.totalAmount || 0)
    }
    selectedSubsidyIds.value = []
    selectedSubsidyRows.value = []
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '加载国补应收单失败')
  } finally {
    subsidyLoading.value = false
  }
}

const onSubsidySelectionChange = rows => {
  selectedSubsidyRows.value = rows
  selectedSubsidyIds.value = rows.map(row => row.detail_id)
}

const loadSubsidyAuxiliary = async () => {
  try {
    const [routeRes, receiptRes, adjustmentRes] = await Promise.all([
      api.getSubsidyAccountRoutes(),
      api.getSubsidyReceipts({ page:1, pageSize:50 }),
      api.getSubsidyAdjustments({ status:'', page:1, pageSize:50 })
    ])
    subsidyAccountRoutes.value = routeRes.data || []
    subsidyReceipts.value = receiptRes.data?.list || []
    subsidyAdjustments.value = adjustmentRes.data?.list || []
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '加载国补到账数据失败')
  }
}

const buildSubsidyAllocations = rows => rows.map(row => ({
  detailId:row.detail_id,
  orderNo:row.order_no,
  remaining:Number(row.remaining_amount || 0),
  amount:Number(row.remaining_amount || 0)
}))

const openSubsidyReceiptDialog = async rows => {
  if (!rows?.length) return ElMessage.warning('请选择国补应收单')
  const regionIds = [...new Set(rows.map(row => row.region_id).filter(Boolean))]
  if (regionIds.length !== 1) return ElMessage.warning('一次到账只能核销同一区域的应收单')
  await loadSubsidyAuxiliary()
  const route = subsidyAccountRoutes.value.find(item => item.region_id === regionIds[0])
  if (!route?.account_id) return ElMessage.warning('该区域尚未配置国补实际到账账户')
  Object.assign(subsidyReceiptForm, {
    receiptId:'',
    receiptDate:new Date().toISOString().slice(0,10),
    accountId:route.account_id,
    bankReference:'',
    amount:rows.reduce((sum,row)=>sum+Number(row.remaining_amount||0),0),
    allocations:buildSubsidyAllocations(rows),
    remark:''
  })
  subsidyReceiptMode.value='create'
  subsidyReceiptDialogVisible.value=true
}

const openExistingReceiptAllocation = row => {
  const selected = selectedSubsidyRows.value
  if (!selected.length) return ElMessage.warning('请先在上方选择需要核销的应收单')
  if (selected.some(item => item.region_id !== row.region_id)) return ElMessage.warning('到账单与应收单区域不一致')
  Object.assign(subsidyReceiptForm, {
    receiptId:row.receipt_id, accountId:row.account_id, amount:Number(row.unallocated_amount||0),
    allocations:buildSubsidyAllocations(selected), remark:''
  })
  let available=Number(row.unallocated_amount||0)
  subsidyReceiptForm.allocations.forEach(item=>{item.amount=Math.min(item.remaining,available);available-=item.amount})
  subsidyReceiptMode.value='allocate'
  subsidyReceiptDialogVisible.value=true
}

const submitSubsidyReceipt = async () => {
  const allocations=subsidyReceiptForm.allocations
    .filter(row=>Number(row.amount)>0)
    .map(row=>({detailId:row.detailId,amount:Number(row.amount)}))
  if(!allocations.length)return ElMessage.warning('请填写本次核销金额')
  try{
    if(subsidyReceiptMode.value==='create'){
      await api.createSubsidyReceipt({
        receiptDate:subsidyReceiptForm.receiptDate,accountId:subsidyReceiptForm.accountId,
        bankReference:subsidyReceiptForm.bankReference,amount:subsidyReceiptForm.amount,
        allocations,remark:subsidyReceiptForm.remark
      })
    }else{
      await api.allocateSubsidyReceipt(subsidyReceiptForm.receiptId,{allocations})
    }
    ElMessage.success(subsidyReceiptMode.value==='create'?'到账登记成功':'核销成功')
    subsidyReceiptDialogVisible.value=false
    await Promise.all([loadSubsidyReceivables(),loadSubsidyAuxiliary(),loadDailyData(),loadAccountList()])
  }catch(err){ElMessage.error(err.response?.data?.message||'操作失败')}
}

const refundSubsidyReceipt = async row => {
  try{
    const {value}=await ElMessageBox.prompt(`可退款未分配金额 ¥${formatMoney(row.unallocated_amount)}`,'登记退款',{inputPattern:/^\d+(\.\d{1,2})?$/,inputErrorMessage:'请输入正确金额'})
    await api.refundSubsidyReceipt(row.receipt_id,{amount:Number(value)})
    ElMessage.success('退款登记成功')
    await Promise.all([loadSubsidyAuxiliary(),loadAccountList()])
  }catch(err){if(err!=='cancel'&&err!=='close')ElMessage.error(err.response?.data?.message||'退款失败')}
}

const reverseSubsidyReceipt = async row => {
  try{
    const {value}=await ElMessageBox.prompt('冲销将反向恢复应收并冲回银行账户流水，请填写原因','冲销国补到账',{inputPattern:/\S+/,inputErrorMessage:'请填写冲销原因'})
    await api.reverseSubsidyReceipt(row.receipt_id,{reason:value})
    ElMessage.success('到账单已冲销')
    await Promise.all([loadSubsidyReceivables(),loadSubsidyAuxiliary(),loadDailyData(),loadAccountList()])
  }catch(err){if(err!=='cancel'&&err!=='close')ElMessage.error(err.response?.data?.message||'冲销失败')}
}

const openSubsidyAdjustmentDialog = row => {
  Object.assign(subsidyAdjustmentForm,{detailId:row.detail_id,orderNo:row.order_no,remaining:Number(row.remaining_amount||0),adjustmentType:'FEE',amount:Number(row.remaining_amount||0),financeCategory:'',reason:''})
  subsidyAdjustmentDialogVisible.value=true
}

const submitSubsidyAdjustment = async () => {
  if(!subsidyAdjustmentForm.financeCategory.trim())return ElMessage.warning('请填写财务处理科目')
  if(!subsidyAdjustmentForm.reason.trim())return ElMessage.warning('请填写差额原因')
  try{
    await api.submitSubsidyAdjustment({
      detailId:subsidyAdjustmentForm.detailId,adjustmentType:subsidyAdjustmentForm.adjustmentType,
      amount:subsidyAdjustmentForm.amount,financeCategory:subsidyAdjustmentForm.financeCategory,reason:subsidyAdjustmentForm.reason
    })
    ElMessage.success('差额审批已提交')
    subsidyAdjustmentDialogVisible.value=false
    await loadSubsidyAuxiliary()
  }catch(err){ElMessage.error(err.response?.data?.message||'提交失败')}
}

const reviewSubsidyAdjustment = async (row,action) => {
  try{
    const {value}=await ElMessageBox.prompt(action==='approve'?'确认通过该差额？':'请输入拒绝原因',action==='approve'?'差额审批通过':'差额审批拒绝')
    await api.reviewSubsidyAdjustment(row.adjustment_id,{action,comment:value||''})
    ElMessage.success('审批完成')
    await Promise.all([loadSubsidyReceivables(),loadSubsidyAuxiliary(),loadDailyData()])
  }catch(err){if(err!=='cancel'&&err!=='close')ElMessage.error(err.response?.data?.message||'审批失败')}
}

const reverseSubsidyAdjustment = async row => {
  try{
    const {value}=await ElMessageBox.prompt('冲销后将恢复对应剩余应收，请填写原因','冲销国补差额',{inputPattern:/\S+/,inputErrorMessage:'请填写冲销原因'})
    await api.reverseSubsidyAdjustment(row.adjustment_id,{reason:value})
    ElMessage.success('差额已冲销')
    await Promise.all([loadSubsidyReceivables(),loadSubsidyAuxiliary(),loadDailyData()])
  }catch(err){if(err!=='cancel'&&err!=='close')ElMessage.error(err.response?.data?.message||'冲销失败')}
}

const handleSettleDetail = async (row) => {
  try {
    await ElMessageBox.confirm(
      `确认将订单 ${row.order_no} 的 ¥${row.amount}（${row.payment_method}）下账到 ${row.settlementAccount?.account_name || '未绑定账号'}？`,
      '下账确认',
      { type: 'warning', confirmButtonText: '确认下账' }
    )
    const res = await api.batchSettle({ detailIds: [row.detail_id] })
    if (res.code === 0) {
      ElMessage.success(res.message || '下账成功')
      loadDailyData()
    } else {
      ElMessage.error(res.message || '下账失败')
    }
  } catch (err) {
    if (err !== 'cancel') ElMessage.error('下账失败')
  }
}

const openBatchSettleDialog = async () => {
  if (selectedDetailIds.value.length === 0) {
    ElMessage.warning('请选择要下账的记录')
    return
  }
  const selectedCount = selectedDetailIds.value.length
  const selectedTotalAmount = selectedDetailTotalAmount.value
  try {
    await ElMessageBox.confirm(
      `确认将选中的 ${selectedCount} 笔记录批量下账，总金额：¥${formatMoney(selectedTotalAmount)}？`,
      '批量下账确认',
      { type: 'warning', confirmButtonText: '确认下账' }
    )
    const res = await api.batchSettle({ detailIds: selectedDetailIds.value })
    if (res.code === 0) {
      ElMessage.success(res.message || `下账成功，共 ${selectedCount} 笔，金额：¥${formatMoney(selectedTotalAmount)}`)
      loadDailyData()
    } else {
      ElMessage.error(res.message || '批量下账失败')
    }
  } catch (err) {
    if (err !== 'cancel') ElMessage.error('批量下账失败')
  }
}

const formatDateTime = (time) => {
  if (!time) return '-'
  const d = new Date(time)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  return `${y}-${m}-${day} ${h}:${min}:${s}`
}

const loadExpenseData = async () => {
  try {
    const params = { ...expenseQuery, status: 'draft,pending_payment,pending_approval,pending' }
    const res = await api.getExpenseList(params)
    if (res.code === 0) {
      expenseData.value = res.data?.list || []
      expenseTotal.value = res.data?.pagination?.total || res.data?.total || 0
    }
  } catch (err) {
    ElMessage.error('加载数据失败')
  }
}

const loadExpenseSettleData = async () => {
  try {
    const params = { ...expenseSettleQuery }
    if (expenseSettleFilter.value) {
      params.status = expenseSettleFilter.value
    } else {
      params.status = 'processing,paid'
    }
    const res = await api.getExpenseList(params)
    if (res.code === 0) {
      expenseSettleData.value = res.data?.list || []
      expenseSettleTotal.value = res.data?.pagination?.total || res.data?.total || 0
    }
  } catch (err) {
    ElMessage.error('加载结算单失败')
  }
}

const loadExpenseTypes = async () => {
  try {
    const res = await api.getExpenseTypes()
    if (res.code === 0) expenseTypeOptions.value = res.data || []
  } catch (err) {
    console.error('Failed to load expense types')
  }
}

const handleSubmitExpense = async (row) => {
  try {
    await ElMessageBox.confirm(
      `确认将费用[${row.expense_no}] ¥${row.amount} 提交报销？`,
      '报销确认',
      { confirmButtonText: '确认报销', cancelButtonText: '取消', type: 'warning' }
    )
    const res = await api.submitExpense(row.expense_id)
    if (res.code === 0) {
      ElMessage.success(res.message || '报销申请已提交')
      loadExpenseData()
      loadExpenseSettleData()
    } else {
      ElMessage.error(res.message || '操作失败')
    }
  } catch (err) {
    if (err !== 'cancel') ElMessage.error('操作失败')
  }
}

const formatQuantity = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return '-'
  return String(number).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
}

const formatQuantityInput = (value) => formatQuantity(value)
const parseQuantityInput = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

const handleEditExpense = (row) => {
  expenseForm.expenseId = row.expense_id || ''
  expenseForm.expenseTypeId = row.expense_type_id || ''
  expenseForm.storeId = row.store_id || ''
  expenseForm.amount = Number(row.amount || 0)
  expenseForm.expenseParty = row.expense_party || ''
  expenseForm.expenseDate = row.expense_date || new Date().toISOString().slice(0, 10)
  expenseForm.paymentMethod = row.payment_method || 'CORPORATE'
  expenseForm.hasInvoice = Boolean(row.has_invoice)
  expenseForm.invoiceType = row.invoice_type || ''
  expenseForm.invoiceNo = row.invoice_no || ''
  expenseForm.remark = row.remark || ''
  expenseDialogVisible.value = true
}

const handleSubmitExpenseDraft = async (row) => {
  try {
    await ElMessageBox.confirm(`确认提交费用单草稿 ${row.expense_no}？`, '提交费用单', {
      confirmButtonText: '确认提交',
      cancelButtonText: '取消',
      type: 'warning'
    })
    const res = await api.submitExpenseDraft(row.expense_id)
    if (res.code === 0) {
      ElMessage.success(res.message || '费用单已提交')
      await loadExpenseData()
      await loadExpenseSettleData()
    } else {
      ElMessage.error(res.message || '提交失败')
    }
  } catch (err) {
    if (err !== 'cancel') ElMessage.error(err.response?.data?.message || '提交失败')
  }
}

const handleDeleteExpenseDraft = async (row) => {
  try {
    await ElMessageBox.confirm(`确认删除费用单草稿 ${row.expense_no}？`, '删除草稿', {
      confirmButtonText: '确认删除',
      cancelButtonText: '取消',
      type: 'warning'
    })
    const res = await api.deleteExpenseDraft(row.expense_id)
    if (res.code === 0) {
      ElMessage.success('费用单草稿已删除')
      await loadExpenseData()
    } else {
      ElMessage.error(res.message || '删除失败')
    }
  } catch (err) {
    if (err !== 'cancel') ElMessage.error(err.response?.data?.message || '删除失败')
  }
}

const handlePayExpense = (row) => {
  payExpenseRow.value = row
  payExpenseMethod.value = '银行转账'
  payExpenseAccountId.value = ''
  payExpenseVisible.value = true
}

const doPayExpense = async () => {
  if (!payExpenseAccountId.value) {
    ElMessage.warning('请选择结算账号')
    return
  }
  payExpenseLoading.value = true
  try {
    const selectedAccount = settlementAccounts.value.find(a => a.account_id === payExpenseAccountId.value)
    const res = await api.payExpense(payExpenseRow.value.expense_id, {
      paymentMethod: selectedAccount ? `${selectedAccount.account_name} - ${selectedAccount.bank_name || ''}` : '银行转账',
      settlementAccountId: payExpenseAccountId.value
    })
    if (res.code === 0) {
      ElMessage.success(res.message || '付款完成')
      payExpenseVisible.value = false
      loadExpenseData()
      loadExpenseSettleData()
    } else {
      ElMessage.error(res.message || '操作失败')
    }
  } catch (err) {
    ElMessage.error('付款操作失败')
  } finally {
    payExpenseLoading.value = false
  }
}

const loadStores = async () => {
  try {
    const res = await api.getStoreList({ page: 1, pageSize: 500 })
    if (res && res.code === 0) {
      const list = res.data?.list
      stores.value = Array.isArray(list) ? list : []
    } else {
      stores.value = []
    }
  } catch (err) {
    stores.value = []
  }
}

const loadPaymentMethods = async () => {
  try {
    const res = await api.getPaymentMethods()
    if (res.code === 0) paymentMethods.value = res.data || []
  } catch (err) { console.error('Failed to load payment methods') }
}

const loadSettlementAccounts = async () => {
  try {
    const res = await api.getSettlementAccountsBalance({ page: 1, pageSize: 500 })
    if (res.code === 0) settlementAccounts.value = (res.data?.list || []).filter(account => account.account_type !== 'SUPPLIER_REBATE')
  } catch (err) { console.error('Failed to load settlement accounts') }
}

const loadSuppliers = async () => {
  try {
    const res = await api.getAllSuppliers()
    if (res.code === 0) {
      suppliers.value = res.data || []
    }
  } catch (err) {
    console.error('Failed to load suppliers')
  }
}

const loadPayableData = async () => {
  try {
    const params = { ...payableQuery, status: payableStatusFilter.value || 'unpaid' }
    if (payableSupplierFilter.value) params.supplierId = payableSupplierFilter.value
    if (payableSourceFilter.value) params.sourceType = payableSourceFilter.value
    if (payableSourceNoFilter.value.trim()) params.sourceNo = payableSourceNoFilter.value.trim()
    if (Array.isArray(payableDateRange.value) && payableDateRange.value.length === 2) {
      params.startDate = payableDateRange.value[0]
      params.endDate = payableDateRange.value[1]
    }
    const res = await api.getPayableList(params)
    if (res.code === 0) {
      payableData.value = res.data?.list || []
      payableTotal.value = res.data?.pagination?.total || res.data?.total || 0
      payableFilterSummary.value = {
        totalCount: Number(res.data?.summary?.totalCount || 0),
        totalAmount: Number(res.data?.summary?.totalAmount || 0)
      }
    }
  } catch (err) {
    console.error('Failed to load payables')
  }
}

const onPayableFilterChange = () => {
  payableQuery.page = 1
  clearPayableSelection()
  loadPayableData()
}

const clearPayableSelection = () => {
  selectedPayableRows.value = []
  payableTableRef.value?.clearSelection()
}

const openPurchaseRequestDetail = async (row) => {
  if (!row.request_id) {
    ElMessage.warning('该应付款未关联采购订单')
    return
  }
  try {
    const res = await api.getPurchaseRequestDetail(row.request_id)
    if (res.code === 0) {
      purchaseDetail.value = res.data || null
      purchaseDetailVisible.value = true
    } else {
      ElMessage.error(res.message || '加载采购订单失败')
    }
  } catch (err) {
    const msg = err.response?.data?.message || err.message || '加载采购订单失败'
    ElMessage.error(msg)
  }
}

const loadReimbursementSettlementData = async () => {
  try {
    const params = { ...reimbursementSettlementQuery, settlementType: 'reimbursement' }
    if (reimbursementSettlementStatusFilter.value) {
      params.status = reimbursementSettlementStatusFilter.value
    }
    if (reimbursementPaymentStatusFilter.value) {
      params.paymentStatus = reimbursementPaymentStatusFilter.value
    }
    const res = await api.getSettlementList(params)
    if (res.code === 0) {
      reimbursementSettlementData.value = res.data?.list || []
      reimbursementSettlementTotal.value = res.data?.pagination?.total || res.data?.total || 0
    }
  } catch (err) {
    console.error('Failed to load reimbursement settlements')
  }
}

const loadRebateSummary = async () => {
  try {
    const res = await api.getRebateSummary()
    if (res.code === 0) {
      rebateSummary.value = res.data?.list || []
      rebateSummaryTotal.value = Number(res.data?.totalBalance || 0)
    }
  } catch (err) {
    console.error('Failed to load rebate summary')
  }
}

const loadRebateList = async () => {
  try {
    const params = { ...rebateQuery }
    if (rebateSupplierFilter.value) params.supplierId = rebateSupplierFilter.value
    if (rebateTypeFilter.value) params.type = rebateTypeFilter.value
    const res = await api.getRebateList(params)
    if (res.code === 0) {
      rebateData.value = res.data?.list || []
      rebateTotal.value = res.data?.pagination?.total || res.data?.total || 0
    }
  } catch (err) {
    console.error('Failed to load rebate list')
  }
}

const handleRebatePostingChanged = () => Promise.all([loadRebateList(), loadRebateSummary()])
const handleRebateSettlementChanged = () => {
  rebatePostingKey.value += 1
}

const resetManufacturerPolicyForm = () => {
  manufacturerPolicyEditingId.value = ''
  Object.assign(manufacturerPolicyForm, {
    supplierId: '',
    policyName: '',
    policyType: 'activity',
    pn: '',
    model: '',
    startDate: '',
    endDate: '',
    rebateCalculationType: 'fixed_amount',
    rebateAmount: 0,
    rebateRate: 0,
    affectSalesSettlementCost: true,
    costAdjustmentType: 'fixed_amount',
    costAdjustmentValue: 0,
    maxCostAdjustmentAmount: null,
    costAdjustmentRemark: '',
    remark: '',
    status: 1
  })
}

const openManufacturerPolicyDialog = (row = null) => {
  resetManufacturerPolicyForm()
  if (row) {
    manufacturerPolicyEditingId.value = row.policy_id
    Object.assign(manufacturerPolicyForm, {
      supplierId: row.supplier_id || '',
      policyName: row.policy_name || '',
      policyType: row.policy_type || 'activity',
      pn: row.pn || '',
      model: row.model || '',
      startDate: row.start_date ? String(row.start_date).slice(0, 10) : '',
      endDate: row.end_date ? String(row.end_date).slice(0, 10) : '',
      rebateCalculationType: row.rebate_calculation_type || 'fixed_amount',
      rebateAmount: Number(row.rebate_amount || 0),
      rebateRate: Number(row.rebate_rate || 0),
      affectSalesSettlementCost: Boolean(row.affect_sales_settlement_cost),
      costAdjustmentType: row.cost_adjustment_type || 'fixed_amount',
      costAdjustmentValue: Number(row.cost_adjustment_value || 0),
      maxCostAdjustmentAmount: row.max_cost_adjustment_amount === null || row.max_cost_adjustment_amount === undefined ? null : Number(row.max_cost_adjustment_amount),
      costAdjustmentRemark: row.cost_adjustment_remark || '',
      remark: row.remark || '',
      status: row.status === 0 ? 0 : 1
    })
  }
  manufacturerPolicyDialogVisible.value = true
}

const handleManufacturerPolicySubmit = async () => {
  if (!manufacturerPolicyForm.supplierId) {
    ElMessage.warning('请选择供应商/厂家')
    return
  }
  if (!manufacturerPolicyForm.policyName) {
    ElMessage.warning('请输入政策名称')
    return
  }
  manufacturerPolicyLoading.value = true
  try {
    const payload = cloneDraft(manufacturerPolicyForm)
    const res = manufacturerPolicyEditingId.value
      ? await api.updateManufacturerPolicy(manufacturerPolicyEditingId.value, payload)
      : await api.createManufacturerPolicy(payload)
    if (res.code === 0) {
      ElMessage.success(res.message || '厂家政策已保存')
      manufacturerPolicyDialogVisible.value = false
      loadManufacturerPolicies()
    } else {
      ElMessage.error(res.message || '保存失败')
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '保存失败')
  } finally {
    manufacturerPolicyLoading.value = false
  }
}

const loadManufacturerPolicies = async () => {
  try {
    const params = { page: 1, pageSize: 100 }
    if (manufacturerPolicySupplierFilter.value) params.supplierId = manufacturerPolicySupplierFilter.value
    if (manufacturerPolicyPnFilter.value) params.pn = manufacturerPolicyPnFilter.value
    const res = await api.getManufacturerPolicyList(params)
    if (res.code === 0) {
      manufacturerPolicyData.value = res.data?.list || []
    }
  } catch (err) {
    ElMessage.error('加载厂家政策失败')
  }
}

const loadRebateEstimates = async () => {
  try {
    const params = { page: 1, pageSize: 100 }
    if (rebateEstimateOrderFilter.value) params.orderNo = rebateEstimateOrderFilter.value
    if (rebateEstimateSupplierFilter.value) params.supplierId = rebateEstimateSupplierFilter.value
    if (rebateEstimateStatusFilter.value) params.status = rebateEstimateStatusFilter.value
    const res = await api.getRebateEstimateList(params)
    if (res.code === 0) rebateEstimateData.value = res.data?.list || []
  } catch (err) {
    ElMessage.error('加载返利对账记录失败')
  }
}

const loadManufacturerPrices = async () => {
  try {
    const params = { page: 1, pageSize: 100 }
    if (manufacturerPriceSupplierFilter.value) params.supplierId = manufacturerPriceSupplierFilter.value
    if (manufacturerPricePnFilter.value) params.pn = manufacturerPricePnFilter.value
    const res = await api.getManufacturerPriceHistory(params)
    if (res.code === 0) {
      manufacturerPriceData.value = res.data?.list || []
    }
  } catch (err) {
    ElMessage.error('加载厂家价格失败')
  }
}

const loadCostAdjustments = async () => {
  try {
    const params = { page: 1, pageSize: 100 }
    if (costAdjustmentOrderFilter.value) params.orderNo = costAdjustmentOrderFilter.value
    if (costAdjustmentPnFilter.value) params.pn = costAdjustmentPnFilter.value
    const res = await api.getSalesCostAdjustmentList(params)
    if (res.code === 0) {
      costAdjustmentData.value = res.data?.list || []
    }
  } catch (err) {
    ElMessage.error('加载销售结算成本明细失败')
  }
}

const readWorkbookRows = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = (event) => {
    try {
      const data = new Uint8Array(event.target.result)
      const workbook = XLSX.read(data, { type: 'array' })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      resolve(XLSX.utils.sheet_to_json(sheet, { defval: '' }))
    } catch (err) {
      reject(err)
    }
  }
  reader.onerror = reject
  reader.readAsArrayBuffer(file)
})

const handleManufacturerPriceImport = async (uploadFile) => {
  const file = uploadFile.raw
  if (!file) return
  try {
    const rows = await readWorkbookRows(file)
    if (!rows.length) {
      ElMessage.warning('价格表没有可导入的数据')
      return
    }
    const res = await api.importManufacturerPrices({ rows, sourceFileUrl: file.name })
    if (res.code === 0) {
      ElMessage.success(`${res.message || '导入成功'}，共 ${res.data?.count || rows.length} 条`)
      loadManufacturerPrices()
    } else {
      const errors = res.data?.errors || []
      const preview = errors.slice(0, 3).map(e => `第${e.row}行：${e.message}`).join('；')
      ElMessage.error(preview || res.message || '导入失败')
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '导入价格表失败')
  }
}

const loadSettlementLines = async (params = {}) => {
  const res = await api.getPayableSettlementItems(params)
  if (res.code !== 0) return []
  return (res.data || []).map(row => ({
    ...row,
    settle_amount: Number(row.available_amount || 0)
  }))
}

const openSettlementDialog = async () => {
  if (!selectedPayableRows.value.length) {
    ElMessage.warning('请选择需要结算的应付款')
    return
  }
  if (selectedPayableRows.value.some(row => row.source_type === 'expense' || row.source_type === 'reimbursement')) {
    ElMessage.warning('费用和报销请在应付清单中单独生成结算单')
    return
  }
  const supplierIds = [...new Set(selectedPayableRows.value.map(row => row.supplier_id).filter(Boolean))]
  if (supplierIds.length !== 1) {
    ElMessage.warning('请选择同一供应商的应付款再进行结算')
    return
  }
  const supplierId = supplierIds[0]
  const payableIds = selectedPayableRows.value.map(row => row.payable_id)
  settlementSelectionLocked.value = true
  settlementForm.supplierId = ''
  settlementForm.remark = ''
  resetPaymentAccountFields()
  unpaidList.value = []
  selectedPayables.value = []
  settlementDialogVisible.value = true
  try {
    settlementForm.supplierId = supplierId
    unpaidList.value = await loadSettlementLines({ supplierId, payableIds: payableIds.join(',') })
    await nextTick()
    const selectedIds = new Set(payableIds.map(String))
    unpaidList.value.forEach(item => {
      if (selectedIds.has(String(item.payable_id))) settlementTableRef.value?.toggleRowSelection(item, true)
    })
  } catch (err) {
    ElMessage.error('获取待结算明细失败')
  }
}

const openSettlementDialogLegacy = async () => {
  settlementSelectionLocked.value = false
  settlementForm.supplierId = ''
  resetPaymentAccountFields()
  unpaidList.value = []
  selectedPayables.value = []
  settlementDialogVisible.value = true
  try {
    const res = await api.getPayableList({ status: 'unpaid', page: 1, pageSize: 100 })
    if (res.code === 0) unpaidList.value = (res.data?.list || []).filter(item => item.source_type !== 'expense')
    restoreSettlementDraft()
  } catch (err) {
    ElMessage.error('获取应付款失败')
  }
}

const openSingleSettlementDialog = async (row) => {
  if (row.source_type === 'expense' || row.source_type === 'reimbursement') {
    await handleCreateExpenseSettlement(row)
    return
  }
  settlementSelectionLocked.value = true
  settlementForm.supplierId = row.supplier_id || ''
  settlementForm.remark = ''
  resetPaymentAccountFields()
  unpaidList.value = []
  selectedPayables.value = []
  settlementDialogVisible.value = true
  try {
    unpaidList.value = await loadSettlementLines({
      supplierId: settlementForm.supplierId,
      payableIds: row.payable_id
    })
    await nextTick()
    if (unpaidList.value.length && settlementTableRef.value) {
      unpaidList.value.forEach(item => settlementTableRef.value.toggleRowSelection(item, true))
    }
  } catch (err) {
    ElMessage.error('获取待结算明细失败')
  }
}

const openSingleSettlementDialogLegacy = async (row) => {
  if (row.source_type === 'expense') {
    await handleCreateExpenseSettlement(row)
    return
  }
  settlementSelectionLocked.value = false
  settlementForm.supplierId = row.supplier_id || ''
  resetPaymentAccountFields()
  unpaidList.value = []
  selectedPayables.value = []
  settlementDialogVisible.value = true

  try {
    const res = settlementForm.supplierId
      ? await api.getUnpaidBySupplier({ supplierId: settlementForm.supplierId })
      : await api.getPayableList({ status: 'unpaid', page: 1, pageSize: 100 })

    if (res.code === 0) {
      unpaidList.value = (Array.isArray(res.data) ? res.data : (res.data?.list || [])).filter(item => item.source_type !== 'expense')
      await nextTick()
      const target = unpaidList.value.find(item => item.payable_id === row.payable_id)
      if (target && settlementTableRef.value) {
        settlementTableRef.value.toggleRowSelection(target, true)
        selectedPayables.value = [target]
      }
    }
  } catch (err) {
    ElMessage.error('获取应付款失败')
  }
}

const handleCreateExpenseSettlement = async (row) => {
  try {
    const { value } = await ElMessageBox.prompt(
      `请输入本次报销金额（剩余 ¥${Number(row.remaining_amount ?? (Number(row.total_amount || 0) - Number(row.settled_amount || 0))).toFixed(2)}）`,
      '生成报销结算单',
      {
        inputValue: Number(row.remaining_amount ?? (Number(row.total_amount || 0) - Number(row.settled_amount || 0))).toFixed(2),
        inputPattern: /^(0*\.?[0-9]+)$/,
        inputErrorMessage: '请输入有效金额'
      }
    )
    const res = await api.createExpenseSettlement({ payableId: row.payable_id, amount: Number(value) })
    if (res.code === 0) {
      ElMessage.success(res.message || '报销结算单已生成')
      await Promise.all([loadPayableData(), loadReimbursementSettlementData()])
    } else {
      ElMessage.error(res.message || '生成失败')
    }
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') ElMessage.error(err?.response?.data?.message || err?.message || '生成失败')
  }
}

const handleCreateExpenseSettlementLegacy = async (row) => {
  try {
    await ElMessageBox.confirm(
      `确认将费用应付[${row.source_no || row.request_no || row.payable_id}]生成结算单？`,
      '生成费用结算单',
      { type: 'warning' }
    )
    const res = await api.createExpenseSettlement({ payableId: row.payable_id })
    if (res.code === 0) {
      ElMessage.success(res.message || '费用结算单已生成')
      await Promise.all([loadPayableData(), loadReimbursementSettlementData()])
    } else {
      ElMessage.error(res.message || '生成失败')
    }
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(err?.response?.data?.message || err?.message || '生成失败')
    }
  }
}

const onSupplierChange = async (supplierId) => {
  resetPaymentAccountFields()
  try {
    unpaidList.value = await loadSettlementLines(supplierId ? { supplierId } : {})
    selectedPayables.value = []
  } catch (err) {
    ElMessage.error('获取待结算明细失败')
  }
}

const onSupplierChangeLegacy = async (supplierId) => {
  resetPaymentAccountFields()
  if (!supplierId) {
    const res = await api.getPayableList({ status: 'unpaid', page: 1, pageSize: 100 })
    if (res.code === 0) unpaidList.value = (res.data?.list || []).filter(item => item.source_type !== 'expense')
    return
  }
  try {
    const res = await api.getUnpaidBySupplier({ supplierId })
    if (res.code === 0) {
      unpaidList.value = (res.data || []).filter(item => item.source_type !== 'expense')
      selectedPayables.value = []
    }
  } catch (err) {
    ElMessage.error('获取应付款失败')
  }
}

const onSelectionChange = (selection) => {
  selectedPayables.value = selection
}

const onPayableSelectionChange = (selection) => {
  selectedPayableRows.value = selection
}

const onPaymentAccountTypeChange = (value) => {
  settlementForm.supplierAccountId = ''
  settlementForm.otherPaymentRemark = ''
  settlementForm.otherPaymentImage = ''
  otherPaymentFileList.value = []

  if (value && value.startsWith('saved:')) {
    settlementForm.supplierAccountId = value.replace('saved:', '')
  }
}

const handleOtherPaymentImageChange = (file) => {
  const rawFile = file.raw
  if (!rawFile) return
  const reader = new FileReader()
  reader.onload = (event) => {
    settlementForm.otherPaymentImage = event.target?.result || ''
    otherPaymentFileList.value = [file]
  }
  reader.readAsDataURL(rawFile)
}

const handleOtherPaymentImageRemove = () => {
  settlementForm.otherPaymentImage = ''
  otherPaymentFileList.value = []
}

const handleOtherPaymentImageExceed = () => {
  ElMessage.warning('只能上传一张图片')
}

const handleSettlementSubmit = async () => {
  if (!selectedPayables.value.length) {
    ElMessage.warning('请选择需要结算的采购明细')
    return
  }
  if (selectedPayables.value.some(row => row.source_type === 'expense' || row.source_type === 'reimbursement')) {
    ElMessage.warning('报销请在应付清单中单独生成报销结算单')
    return
  }
  settlementLoading.value = true
  try {
    const supplierIds = [...new Set(selectedPayables.value.map(row => row.supplier_id).filter(Boolean))]
    const supplierId = settlementForm.supplierId || (supplierIds.length === 1 ? supplierIds[0] : '')
    if (!supplierId || supplierIds.some(id => id !== supplierId)) {
      ElMessage.warning('请选择同一供应商的采购明细')
      return
    }
    const paymentAccountType = settlementForm.paymentAccountType
    const isOtherPaymentAccount = paymentAccountType === 'other'
    if (isOtherPaymentAccount && (!settlementForm.otherPaymentRemark.trim() || !settlementForm.otherPaymentImage)) {
      ElMessage.warning('其他账户必须填写说明并上传凭证')
      return
    }
    if (!isOtherPaymentAccount && !settlementForm.supplierAccountId) {
      ElMessage.warning('请选择供应商付款账户')
      return
    }
    const res = await api.createSettlement({
      supplierId,
      payableIds: selectedPayableIds.value,
      allocations: selectedPayables.value.map(row => ({
        payableId: row.payable_id,
        requestItemId: row.request_item_id,
        amount: Number(row.settle_amount || 0)
      })),
      paymentAccountType: isOtherPaymentAccount ? 'other' : 'saved',
      supplierAccountId: isOtherPaymentAccount ? '' : settlementForm.supplierAccountId,
      otherPaymentRemark: isOtherPaymentAccount ? settlementForm.otherPaymentRemark.trim() : '',
      otherPaymentImage: isOtherPaymentAccount ? settlementForm.otherPaymentImage : '',
      remark: settlementForm.remark.trim()
    })
    if (res.code === 0) {
      ElMessage.success('结算单创建成功')
      clearDraft(FINANCE_SETTLEMENT_DRAFT_KEY)
      clearPayableSelection()
      settlementDialogVisible.value = false
      await Promise.all([loadPayableData(), loadReimbursementSettlementData()])
    } else ElMessage.error(res.message || '创建失败')
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '创建结算单失败')
  } finally {
    settlementLoading.value = false
  }
}

const handleSettlementSubmitLegacy = async () => {
  if (selectedPayables.value.length === 0) {
    ElMessage.warning('请选择需要结算的应付款项')
    return
  }
  if (selectedPayables.value.some(p => p.source_type === 'expense')) {
    ElMessage.warning('公司对公费用请在应付清单中单独生成费用结算单')
    return
  }

  settlementLoading.value = true
  try {
    let supplierId = settlementForm.supplierId
    if (!supplierId) {
      const supplierIds = [...new Set(selectedPayables.value.map(p => p.supplier_id).filter(Boolean))]
      if (supplierIds.length !== 1) {
        ElMessage.warning('请选择同一供应商的应付款，或先选择供应商筛选')
        settlementLoading.value = false
        return
      }
      supplierId = supplierIds[0]
    }

    const paymentAccountType = settlementForm.paymentAccountType
    const isOtherPaymentAccount = paymentAccountType === 'other'
    if (isOtherPaymentAccount) {
      if (!settlementForm.otherPaymentRemark.trim()) {
        ElMessage.warning('请选择其他账户时必须填写说明')
        settlementLoading.value = false
        return
      }
      if (!settlementForm.otherPaymentImage) {
        ElMessage.warning('请选择其他账户时必须上传图片')
        settlementLoading.value = false
        return
      }
    } else if (!settlementForm.supplierAccountId) {
      ElMessage.warning('请选择供应商付款账号')
      settlementLoading.value = false
      return
    }

    const res = await api.createSettlement({
      supplierId,
      payableIds: selectedPayables.value.map(p => p.payable_id),
      paymentAccountType: isOtherPaymentAccount ? 'other' : 'saved',
      supplierAccountId: isOtherPaymentAccount ? '' : settlementForm.supplierAccountId,
      otherPaymentRemark: isOtherPaymentAccount ? settlementForm.otherPaymentRemark.trim() : '',
      otherPaymentImage: isOtherPaymentAccount ? settlementForm.otherPaymentImage : '',
      remark: settlementForm.remark.trim()
    })

    if (res.code === 0) {
      ElMessage.success('结算单创建成功')
      clearDraft(FINANCE_SETTLEMENT_DRAFT_KEY)
      settlementDialogVisible.value = false
      loadPayableData()
    } else {
      ElMessage.error(res.message || '创建失败')
    }
  } catch (err) {
    const msg = err.response?.data?.message || '创建结算单失败'
    ElMessage.error(msg)
  } finally {
    settlementLoading.value = false
  }
}

const openSettlementDetail = async (row) => {
  try {
    const res = await api.getSettlementDetail(row.settlement_id)
    if (res.code === 0) {
      settlementDetail.value = res.data || null
      settlementDetailVisible.value = true
    } else {
      ElMessage.error(res.message || '加载结算单详情失败')
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '加载结算单详情失败')
  }
}

const handleSubmitSettlement = async (row) => {
  try {
    await ElMessageBox.confirm(
      `确认提交结算单 ${row.settlement_no || ''}？提交后将进入审批。`,
      '提交结算单',
      { confirmButtonText: '提交', cancelButtonText: '取消', type: 'warning' }
    )
    const res = await api.submitSettlement({ settlementId: row.settlement_id })
    if (res.code === 0) {
      ElMessage.success(res.message || '结算单已提交，等待审批')
      loadReimbursementSettlementData()
    } else {
      ElMessage.error(res.message || '提交失败')
    }
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error(err.response?.data?.message || '提交失败')
    }
  }
}

const handleVoidSettlement = async (row) => {
  try {
    await ElMessageBox.confirm(
      `确认作废结算单 ${row.settlement_no || ''}？作废后不会回到待付款清单。`,
      '作废确认',
      { confirmButtonText: '确认作废', cancelButtonText: '取消', type: 'warning' }
    )
    const res = await api.voidSettlement({ settlementId: row.settlement_id })
    if (res.code === 0) {
      ElMessage.success(res.message || '结算单已作废')
      loadPayableData()
      loadReimbursementSettlementData()
    } else {
      ElMessage.error(res.message || '作废失败')
    }
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error(err.response?.data?.message || '作废失败')
    }
  }
}

const resetSettlementForm = () => {
  settlementForm.supplierId = ''
  settlementForm.remark = ''
  resetPaymentAccountFields()
  unpaidList.value = []
  selectedPayables.value = []
}

const saveSettlementDraft = () => {
  saveDraft(FINANCE_SETTLEMENT_DRAFT_KEY, {
    settlementForm: cloneDraft(settlementForm),
    selectedPayableIds: cloneDraft(selectedPayableIds.value),
    selectedPayableAmounts: cloneDraft(selectedPayables.value.map(row => ({
      payableId: row.payable_id,
      requestItemId: row.request_item_id || null,
      amount: Number(row.settle_amount || 0)
    })))
  })
  ElMessage.success('草稿已保存')
}

const restoreSettlementDraft = () => {
  const draft = loadDraft(FINANCE_SETTLEMENT_DRAFT_KEY)
  if (!draft) return
  Object.assign(settlementForm, draft.settlementForm || {})
  const ids = new Set(draft.selectedPayableIds || [])
  const amountMap = new Map((draft.selectedPayableAmounts || []).map(item => [
    `${item.payableId}:${item.requestItemId || ''}`,
    Number(item.amount || 0)
  ]))
  unpaidList.value.forEach(item => {
    if (ids.has(item.payable_id)) {
      item.settle_amount = amountMap.get(`${item.payable_id}:${item.request_item_id || ''}`) ?? Number(item.available_amount || 0)
    }
  })
  selectedPayables.value = []
  nextTick(() => {
    unpaidList.value.forEach(row => {
      settlementTableRef.value?.toggleRowSelection(row, ids.has(row.payable_id))
    })
  })
  ElMessage.success('已恢复上次草稿')
}

const handleAddExpense = () => {
  resetForm()
  expenseDialogVisible.value = true
}

const buildExpensePayload = () => ({
  expenseTypeId: expenseForm.expenseTypeId,
  storeId: expenseForm.storeId,
  amount: expenseForm.amount,
  expenseParty: expenseForm.expenseParty,
  expenseDate: expenseForm.expenseDate,
  paymentMethod: expenseForm.paymentMethod,
  hasInvoice: expenseForm.hasInvoice,
  invoiceType: expenseForm.invoiceType,
  invoiceNo: expenseForm.invoiceNo,
  remark: expenseForm.remark
})

const validateExpenseForm = () => {
  if (!expenseForm.expenseTypeId) {
    ElMessage.warning('请选择报销类型')
    return false
  }
  if (!expenseForm.storeId) {
    ElMessage.warning('请选择门店')
    return false
  }
  if (Number(expenseForm.amount) <= 0) {
    ElMessage.warning('请输入正确的金额')
    return false
  }
  if (!String(expenseForm.expenseParty || '').trim()) {
    ElMessage.warning('请填写费用发生方')
    return false
  }
  if (!expenseForm.paymentMethod) {
    ElMessage.warning('请选择支付方式')
    return false
  }
  return true
}

const handleExpenseSubmit = async () => {
  if (!validateExpenseForm()) return

  submitLoading.value = true
  try {
    const data = buildExpensePayload()
    let res
    if (expenseForm.expenseId) {
      res = await api.updateExpenseDraft(expenseForm.expenseId, data)
      if (res.code === 0) res = await api.submitExpenseDraft(expenseForm.expenseId)
    } else {
      res = await api.createExpense(data)
    }
    if (res.code === 0) {
      ElMessage.success(res.message || '添加成功')
      clearDraft(FINANCE_EXPENSE_DRAFT_KEY)
      expenseDialogVisible.value = false
      loadExpenseData()
      loadPayableData()
      loadReimbursementSettlementData()
    } else {
      ElMessage.error(res.message || '添加失败')
    }
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '添加失败')
  } finally {
    submitLoading.value = false
  }
}

const handleDialogClose = () => {
  resetForm()
}

const saveExpenseDraft = () => {
  if (!validateExpenseForm()) return
  submitLoading.value = true
  const data = buildExpensePayload()
  const request = expenseForm.expenseId
    ? api.updateExpenseDraft(expenseForm.expenseId, data)
    : api.saveExpenseDraft(data)
  request.then(res => {
    if (res.code === 0) {
      expenseForm.expenseId = res.data?.expenseId || expenseForm.expenseId
      ElMessage.success(res.data?.message || '费用单草稿已保存')
      clearDraft(FINANCE_EXPENSE_DRAFT_KEY)
      expenseDialogVisible.value = false
      return loadExpenseData()
    }
    ElMessage.error(res.message || '保存草稿失败')
  }).catch(err => {
    ElMessage.error(err.response?.data?.message || '保存草稿失败')
  }).finally(() => {
    submitLoading.value = false
  })
}

const restoreExpenseDraft = () => {
  const draft = loadDraft(FINANCE_EXPENSE_DRAFT_KEY)
  if (!draft) return
  Object.assign(expenseForm, draft)
  ElMessage.success('已恢复上次草稿')
}

const resetForm = () => {
  expenseForm.expenseId = ''
  expenseForm.expenseTypeId = ''
  expenseForm.storeId = ''
  expenseForm.amount = 0
  expenseForm.expenseParty = ''
  expenseForm.expenseDate = new Date().toISOString().slice(0, 10)
  expenseForm.paymentMethod = 'CORPORATE'
  expenseForm.hasInvoice = false
  expenseForm.invoiceType = ''
  expenseForm.invoiceNo = ''
  expenseForm.remark = ''
}

const getExpenseStatusType = (status) => {
  const types = {
    draft: 'info',
    pending: 'warning',
    pending_approval: 'warning',
    pending_payment: 'warning',
    processing: 'warning',
    approved: 'success',
    paid: 'success',
    rejected: 'danger'
  }
  return types[status] || 'info'
}

const getExpenseStatusText = (status) => {
  const texts = {
    draft: '草稿',
    pending: '待提交',
    pending_approval: '待审批',
    pending_payment: '待付款',
    processing: '报销中',
    approved: '待结算',
    paid: '已付款',
    rejected: '已拒绝'
  }
  return texts[status] || status || '-'
}

const formatDate = (time) => {
  if (!time) return '-'
  return new Date(time).toLocaleDateString('zh-CN')
}

const loadAccountList = async () => {
  try {
    const res = await api.getSettlementAccountsBalance({ ...accountQuery })
    if (res.code === 0) {
      accountList.value = res.data?.list || []
      accountTotal.value = res.data?.pagination?.total || 0
    }
  } catch (err) {
    ElMessage.error('加载账户列表失败')
  }
}

const refreshAccountBalances = async () => {
  await loadAccountList()
  await loadSettlementAccounts()
  ElMessage.success('余额已刷新')
}
const accountTypeText = value => ({
  FUND: '资金账户',
  POLICY_RECEIVABLE: '政策补贴应收',
  CARE_CREDIT: 'Care可用金',
  SUPPLIER_REBATE: '厂商返利'
}[value] || '资金账户')

const moveAccount = async (index, direction) => {
  const targetIndex = index + direction
  if (targetIndex < 0 || targetIndex >= accountList.value.length) return

  const sorted = [...accountList.value]
  ;[sorted[index], sorted[targetIndex]] = [sorted[targetIndex], sorted[index]]

  try {
    const res = await api.sortSettlementAccounts({
      items: sorted.map((item, idx) => ({ id: item.account_id, sortOrder: idx }))
    })
    if (res.code === 0) {
      ElMessage.success('排序已更新')
      await loadAccountList()
      await loadSettlementAccounts()
    } else {
      ElMessage.error(res.message || '排序失败')
    }
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '排序失败')
  }
}

const openAccountDetail = async (row) => {
  accountDetailRow.value = row
  accountDetailBalance.value = row.balance || 0
  accountTxnQuery.page = 1
  await loadAccountTransactions()
  accountDetailVisible.value = true
}

const loadAccountTransactions = async () => {
  if (!accountDetailRow.value) return
  try {
    const res = await api.getAccountTransactions(accountDetailRow.value.account_id, { ...accountTxnQuery })
    if (res.code === 0) {
      accountTransactions.value = res.data?.list || []
      accountTxnTotal.value = res.data?.pagination?.total || 0
      accountDetailBalance.value = res.data?.currentBalance ?? 0
    }
  } catch (err) {
    ElMessage.error('加载流水失败')
  }
}

const openAccountTransactionDialog = (row) => {
  accountTxnForm.accountId = row?.account_id || ''
  accountTxnForm.type = 'income'
  accountTxnForm.amount = 0
  accountTxnForm.description = ''
  accountTxnForm.relatedRef = ''
  restoreAccountTxnDraft()
  accountTxnDialogVisible.value = true
}

const openAccountEdit = (row) => {
  accountEditForm.accountId = row.account_id
  accountEditForm.accountName = row.account_name
  accountEditForm.accountType = row.account_type || 'FUND'
  accountEditForm.supplierId = row.supplier_id || ''
  accountEditForm.bankName = row.bank_name || ''
  accountEditForm.accountNumber = row.account_number || ''
  accountEditVisible.value = true
}

const handleAccountEdit = async () => {
  if (!accountEditForm.accountName) {
    ElMessage.warning('请输入账户名称')
    return
  }
  if (!accountEditForm.accountType) {
    ElMessage.warning('请选择账户类型')
    return
  }
  if (accountEditForm.accountType === 'SUPPLIER_REBATE' && !accountEditForm.supplierId) {
    ElMessage.warning('请选择厂商返利账户对应的厂商')
    return
  }
  accountEditLoading.value = true
  try {
    const res = await api.updateSettlementAccount(accountEditForm.accountId, {
      accountName: accountEditForm.accountName,
      accountType: accountEditForm.accountType,
      supplierId: accountEditForm.accountType === 'SUPPLIER_REBATE' ? accountEditForm.supplierId : null,
      bankName: accountEditForm.bankName,
      accountNumber: accountEditForm.accountNumber
    })
    if (res.code === 0) {
      ElMessage.success('更新成功')
      accountEditVisible.value = false
      loadAccountList()
    } else {
      ElMessage.error(res.message || '更新失败')
    }
  } catch (err) {
    ElMessage.error('更新失败')
  } finally {
    accountEditLoading.value = false
  }
}

const handleAccountTxnSubmit = async () => {
  if (!accountTxnForm.accountId) {
    ElMessage.warning('请选择结算账户')
    return
  }
  if (!accountTxnForm.amount || accountTxnForm.amount <= 0) {
    ElMessage.warning('请输入正确的金额')
    return
  }
  accountTxnLoading.value = true
  try {
    const res = await api.addAccountTransaction({
      accountId: accountTxnForm.accountId,
      type: accountTxnForm.type,
      amount: accountTxnForm.amount,
      description: accountTxnForm.description,
      relatedRef: accountTxnForm.relatedRef
    })
    if (res.code === 0) {
      ElMessage.success('记账成功')
      clearDraft(FINANCE_ACCOUNT_TXN_DRAFT_KEY)
      accountTxnDialogVisible.value = false
      loadAccountList()
      if (accountDetailVisible.value) {
        loadAccountTransactions()
      }
    } else {
      ElMessage.error(res.message || '操作失败')
    }
  } catch (err) {
    const msg = err.response?.data?.message || err.message || '操作失败'
    ElMessage.error(msg)
  } finally {
    accountTxnLoading.value = false
  }
}

const saveAccountTxnDraft = () => {
  saveDraft(FINANCE_ACCOUNT_TXN_DRAFT_KEY, cloneDraft(accountTxnForm))
  ElMessage.success('草稿已保存')
}

const restoreAccountTxnDraft = () => {
  const draft = loadDraft(FINANCE_ACCOUNT_TXN_DRAFT_KEY)
  if (!draft) return
  Object.assign(accountTxnForm, draft)
  ElMessage.success('已恢复上次草稿')
}
</script>

<style scoped>
.module-tabs :deep(.el-tabs__header) {
  display: none;
}

.filter-bar {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}
.el-pagination {
  margin-top: 16px;
  justify-content: flex-end;
}
.rebate-summary {
  margin-bottom: 16px;
}
.rebate-summary-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  font-size: 14px;
  color: #303133;
}
.rebate-summary-header strong {
  color: #67c23a;
}
.daily-summary {
  margin-top: 12px;
  padding: 10px 16px;
  background: #f5f7fa;
  border-radius: 4px;
  font-size: 14px;
  display: flex;
  align-items: center;
}
.settlement-total {
  margin-top: 12px;
  padding: 10px 16px;
  background: #f5f7fa;
  border-radius: 4px;
  font-size: 14px;
}
.payable-summary {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
  padding: 10px 16px;
  background: #f5f7fa;
  border-radius: 4px;
  font-size: 14px;
}
.payable-summary strong {
  color: #303133;
}
.total-amount {
  color: #e6a23c;
  font-size: 16px;
}
.mt-20 {
  margin-top: 20px;
}
.settlement-section {
  margin-top: 20px;
}
.settlement-image-preview {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 240px;
}
.settlement-image-preview img {
  max-width: 100%;
  max-height: 70vh;
  object-fit: contain;
}
</style>
