<template>
  <div class="finance-page">
    <el-card>
      <template #header>
        <span>财务管理</span>
      </template>

      <el-tabs v-model="activeTab">
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
            <el-button type="success" @click="openBatchSettleDialog" :disabled="selectedDetailIds.length === 0">
              批量下账 ({{ selectedDetailIds.length }})
            </el-button>
          </div>

          <el-table :data="dailyDetails" stripe border @selection-change="onDetailSelectionChange" ref="detailTableRef">
            <el-table-column type="selection" width="40" :selectable="(r) => parseFloat(r.settled || 0) === 0" />
            <el-table-column prop="statement_date" label="日期" width="110" sortable />
            <el-table-column prop="order_no" label="订单号" width="170" />
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
                  link
                  type="success"
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

        <el-tab-pane label="费用管理" name="expense">
          <div class="filter-bar">
            <span style="font-weight: bold; line-height: 32px;">费用清单</span>
            <el-button type="primary" @click="handleAddExpense">添加费用</el-button>
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
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="row.status === 'paid' ? 'success' : row.status === 'processing' ? 'warning' : 'info'" size="small">
                  {{ row.status === 'paid' ? '已付款' : row.status === 'processing' ? '报销中' : '待报销' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="remark" label="备注" min-width="120" />
            <el-table-column label="操作" width="120">
              <template #default="{ row }">
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
                    {{ row.status === 'paid' ? '已付款' : '支付中' }}
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
            <el-button type="primary" @click="openSettlementDialog">结算</el-button>
          </div>

          <el-table :data="payableData" stripe border>
            <el-table-column prop="request_no" label="采购单号" width="180" />
            <el-table-column prop="supplier_name" label="供应商" width="120" />
            <el-table-column prop="total_amount" label="应付金额" width="120">
              <template #default="{ row }">¥{{ row.total_amount }}</template>
            </el-table-column>
            <el-table-column prop="paid_amount" label="已付金额" width="120">
              <template #default="{ row }">¥{{ row.paid_amount }}</template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="100">
              <template #default="{ row }">
                <el-tag type="danger">待付款</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="create_time" label="创建时间" width="160" />
          </el-table>

          <el-pagination
            v-model:current-page="payableQuery.page"
            v-model:page-size="payableQuery.pageSize"
            :total="payableTotal"
            layout="total, sizes, prev, pager, next"
            @size-change="loadPayableData"
            @current-change="loadPayableData"
          />

          <div class="settlement-section">
            <div class="filter-bar">
              <span style="font-weight: bold; line-height: 32px;">结算单列表</span>
              <el-select v-model="settlementStatusFilter" placeholder="状态筛选" clearable style="width: 130px" @change="loadSettlementData">
                <el-option label="全部" value="" />
                <el-option label="付款中" value="unpaid" />
                <el-option label="已付款" value="paid" />
              </el-select>
            </div>
          </div>

          <el-table :data="settlementData" stripe border>
            <el-table-column prop="settlement_no" label="结算单号" width="180" />
            <el-table-column prop="supplier_name" label="供应商" width="120" />
            <el-table-column prop="total_amount" label="结算金额" width="120">
              <template #default="{ row }">¥{{ row.total_amount }}</template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="row.status === 'paid' ? 'success' : 'warning'">
                  {{ row.status === 'paid' ? '已付款' : '付款中' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="create_time" label="创建时间" width="160" />
            <el-table-column label="操作" width="120">
              <template #default="{ row }">
                <el-button v-if="row.status === 'unpaid'" link type="success" @click="handleConfirmPayment(row)">
                  已付款
                </el-button>
              </template>
            </el-table-column>
          </el-table>

          <el-pagination
            v-model:current-page="settlementQuery.page"
            v-model:page-size="settlementQuery.pageSize"
            :total="settlementTotal"
            layout="total, sizes, prev, pager, next"
            @size-change="loadSettlementData"
            @current-change="loadSettlementData"
          />
        </el-tab-pane>

        <el-tab-pane label="返利管理" name="rebate">
          <div class="filter-bar">
            <el-button type="success" @click="rebateDialogVisible = true; loadRebateSuppliers()">返利上账</el-button>
            <el-select v-model="rebateSupplierFilter" placeholder="供应商筛选" clearable style="width: 150px" @change="loadRebateList">
              <el-option v-for="s in suppliers" :key="s.supplier_id" :label="s.name" :value="s.supplier_id" />
            </el-select>
            <el-select v-model="rebateTypeFilter" placeholder="类型筛选" clearable style="width: 120px" @change="loadRebateList">
              <el-option label="全部" value="" />
              <el-option label="上账" value="credit" />
              <el-option label="抵扣" value="debit" />
            </el-select>
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
        </el-tab-pane>

        <el-tab-pane label="结算账户" name="account">
          <div class="filter-bar">
            <el-button type="primary" @click="openAccountTransactionDialog()">记账</el-button>
          </div>
          <el-table :data="accountList" stripe border>
            <el-table-column prop="account_name" label="账户名称" width="200" />
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
            <el-table-column label="操作" width="140">
              <template #default="{ row }">
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

    <!-- 结算对话框 -->
    <el-dialog v-model="settlementDialogVisible" title="创建结算单" width="700px" @close="resetSettlementForm">
      <el-form label-width="100px">
        <el-form-item label="供应商" required>
          <el-select v-model="settlementForm.supplierId" placeholder="请选择供应商" style="width: 100%" @change="onSupplierChange">
            <el-option v-for="s in suppliers" :key="s.supplier_id" :label="s.name" :value="s.supplier_id" />
          </el-select>
        </el-form-item>
      </el-form>

      <div v-if="unpaidList.length > 0">
        <el-table :data="unpaidList" stripe border @selection-change="onSelectionChange" ref="settlementTableRef">
          <el-table-column type="selection" width="50" />
          <el-table-column prop="request_no" label="采购单号" width="180" />
          <el-table-column prop="total_amount" label="应付金额" width="130">
            <template #default="{ row }">¥{{ row.total_amount }}</template>
          </el-table-column>
          <el-table-column prop="create_time" label="创建时间" width="160" />
        </el-table>
        <div class="settlement-total">
          已选 <strong>{{ selectedPayableIds.length }}</strong> 项，
          结算总金额：<strong class="total-amount">¥{{ settlementTotalAmount }}</strong>
        </div>
      </div>
      <div v-else-if="settlementForm.supplierId">
        <el-empty description="该供应商没有待结算的应付款" />
      </div>

      <template #footer>
        <el-button @click="settlementDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleSettlementSubmit" :loading="settlementLoading" :disabled="selectedPayableIds.length === 0">
          确认结算
        </el-button>
      </template>
    </el-dialog>

    <!-- 添加支出对话框 -->
    <el-dialog v-model="expenseDialogVisible" title="添加费用" width="500px" @close="handleDialogClose">
      <el-form :model="expenseForm" label-width="100px">
        <el-form-item label="支出类型" required>
          <el-select v-model="expenseForm.expenseType" placeholder="请选择类型" style="width: 100%">
            <el-option label="办公用品" value="办公用品" />
            <el-option label="水电费" value="水电费" />
            <el-option label="运费" value="运费" />
            <el-option label="维修费" value="维修费" />
            <el-option label="工资" value="工资" />
            <el-option label="其他" value="其他" />
          </el-select>
        </el-form-item>
        <el-form-item label="门店" required>
          <el-select v-model="expenseForm.storeId" placeholder="请选择门店" style="width: 100%">
            <el-option v-for="s in stores" :key="s.store_id" :label="s.name" :value="s.store_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="金额" required>
          <el-input v-model="expenseForm.amount" placeholder="金额" style="width: 100%" />
        </el-form-item>
        <el-form-item label="支付方式">
          <el-select v-model="expenseForm.paymentMethod" placeholder="请选择" style="width: 100%">
            <el-option label="现金" value="cash" />
            <el-option label="微信支付" value="wechat" />
            <el-option label="支付宝" value="alipay" />
            <el-option label="银行转账" value="bank" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="expenseForm.remark" type="textarea" rows="3" placeholder="支出备注" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="expenseDialogVisible = false">取消</el-button>
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
              :label="`${acc.account_name} - ${acc.bank_name || ''}（${acc.account_number || ''}）`"
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

    <!-- 确认付款对话框（应付结算） -->
    <el-dialog v-model="payablePayVisible" title="确认付款" width="450px">
      <el-form label-width="100px">
        <el-form-item label="结算单号">
          <span>{{ payablePayRow?.settlement_no || '-' }}</span>
        </el-form-item>
        <el-form-item label="供应商">
          <span>{{ payablePayRow?.supplier_name || '-' }}</span>
        </el-form-item>
        <el-form-item label="金额">
          <span style="color: #e6a23c; font-weight: bold;">¥{{ payablePayRow?.total_amount || 0 }}</span>
        </el-form-item>
        <el-form-item label="结算账号" required>
          <el-select v-model="payablePayAccountId" placeholder="请选择结算账号" style="width: 100%" filterable>
            <el-option
              v-for="acc in settlementAccounts"
              :key="acc.account_id"
              :label="`${acc.account_name} - ${acc.bank_name || ''}（${acc.account_number || ''}）`"
              :value="acc.account_id"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="payablePayVisible = false">取消</el-button>
        <el-button type="success" @click="doConfirmPayment" :loading="payablePayLoading">确认已付</el-button>
      </template>
    </el-dialog>

    <!-- 返利上账对话框 -->
    <el-dialog v-model="rebateDialogVisible" title="返利上账" width="500px" @close="resetRebateForm">
      <el-form label-width="100px">
        <el-form-item label="供应商" required>
          <el-select v-model="rebateForm.supplierId" placeholder="请选择供应商" style="width: 100%">
            <el-option v-for="s in allRebateSuppliers" :key="s.supplier_id" :label="s.name" :value="s.supplier_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="返利金额" required>
          <el-input v-model="rebateForm.amount" placeholder="金额" style="width: 100%" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="rebateForm.remark" type="textarea" rows="3" placeholder="返利说明" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="rebateDialogVisible = false">取消</el-button>
        <el-button type="success" @click="handleRebateSubmit" :loading="rebateLoading">确认上账</el-button>
      </template>
    </el-dialog>

    <!-- 结算账户流水对话框 -->
    <el-dialog v-model="accountDetailVisible" :title="'账户流水 - ' + (accountDetailRow?.account_name || '')" width="800px">
      <div class="filter-bar" style="margin-bottom: 12px;">
        <span>余额：<b :style="{ color: accountDetailBalance >= 0 ? '#67c23a' : '#f56c6c' }">¥{{ Number(accountDetailBalance).toFixed(2) }}</b></span>
        <el-button type="primary" size="small" @click="openAccountTransactionDialog(accountDetailRow)">记账</el-button>
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

    <!-- 编辑账户对话框 -->
    <el-dialog v-model="accountEditVisible" title="编辑账户信息" width="420px">
      <el-form :model="accountEditForm" label-width="100px">
        <el-form-item label="账户名称" required>
          <el-input v-model="accountEditForm.accountName" placeholder="输入账户名称" />
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
        <el-button type="primary" @click="handleAccountTxnSubmit" :loading="accountTxnLoading">确认</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'

const activeTab = ref('daily')
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
const detailTableRef = ref(null)
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
const payablePayVisible = ref(false)
const payablePayRow = ref(null)
const payablePayAccountId = ref('')
const payablePayLoading = ref(false)
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
const settlementData = ref([])
const settlementTotal = ref(0)
const settlementStatusFilter = ref('')

// 返利管理
const rebateDialogVisible = ref(false)
const rebateLoading = ref(false)
const rebateData = ref([])
const rebateTotal = ref(0)
const rebateSupplierFilter = ref('')
const rebateTypeFilter = ref('')
const allRebateSuppliers = ref([])

const rebateQuery = reactive({
  page: 1,
  pageSize: 20
})

const rebateForm = reactive({
  supplierId: '',
  amount: 0,
  remark: ''
})

const payableQuery = reactive({
  page: 1,
  pageSize: 20
})

const settlementQuery = reactive({
  page: 1,
  pageSize: 20
})

const settlementForm = reactive({
  supplierId: ''
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
  bankName: '',
  accountNumber: ''
})
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

const expenseQuery = reactive({
  page: 1,
  pageSize: 20
})

const expenseForm = reactive({
  expenseType: '',
  storeId: '',
  amount: 0,
  paymentMethod: 'cash',
  remark: ''
})

const selectedPayableIds = computed(() => selectedPayables.value.map(p => p.payable_id))

const settlementTotalAmount = computed(() => {
  return selectedPayables.value.reduce((sum, p) => sum + parseFloat(p.total_amount || 0), 0).toFixed(2)
})

onMounted(() => {
  loadStores()
  loadPaymentMethods()
  loadSettlementAccounts()
  loadDailyData()
  loadExpenseData()
  loadExpenseSettleData()
  loadPayableData()
  loadSuppliers()
  loadSettlementData()
  loadRebateList()
  loadAccountList()
})

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
  try {
    await ElMessageBox.confirm(
      `确认将选中的 ${selectedDetailIds.value.length} 笔记录批量下账？`,
      '批量下账确认',
      { type: 'warning', confirmButtonText: '确认下账' }
    )
    const res = await api.batchSettle({ detailIds: selectedDetailIds.value })
    if (res.code === 0) {
      ElMessage.success(res.message || '批量下账成功')
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
    const params = { ...expenseQuery, status: 'pending' }
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

const handleSubmitExpense = async (row) => {
  try {
    await ElMessageBox.confirm(
      `确认将费用 [${row.expense_no}] ¥${row.amount} 提交报销？`,
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
    const res = await api.getAllSettlementAccounts()
    if (res.code === 0) settlementAccounts.value = res.data || []
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
    const params = { ...payableQuery, status: 'unpaid' }
    const res = await api.getPayableList(params)
    if (res.code === 0) {
      payableData.value = res.data?.list || []
      payableTotal.value = res.data?.pagination?.total || res.data?.total || 0
    }
  } catch (err) {
    console.error('Failed to load payables')
  }
}

const loadSettlementData = async () => {
  try {
    const params = { ...settlementQuery }
    if (settlementStatusFilter.value) {
      params.status = settlementStatusFilter.value
    }
    const res = await api.getSettlementList(params)
    if (res.code === 0) {
      settlementData.value = res.data?.list || []
      settlementTotal.value = res.data?.pagination?.total || res.data?.total || 0
    }
  } catch (err) {
    console.error('Failed to load settlements')
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

const loadRebateSuppliers = async () => {
  try {
    const res = await api.getAllSuppliers()
    if (res.code === 0) {
      allRebateSuppliers.value = res.data || []
    }
  } catch (err) {
    console.error('Failed to load suppliers')
  }
}

const handleRebateSubmit = async () => {
  if (!rebateForm.supplierId) {
    ElMessage.warning('请选择供应商')
    return
  }
  if (rebateForm.amount <= 0) {
    ElMessage.warning('请输入正确的金额')
    return
  }

  rebateLoading.value = true
  try {
    const res = await api.addRebate({
      supplierId: rebateForm.supplierId,
      amount: rebateForm.amount,
      remark: rebateForm.remark
    })
    if (res.code === 0) {
      ElMessage.success('返利上账成功')
      rebateDialogVisible.value = false
      loadRebateList()
    } else {
      ElMessage.error(res.message || '操作失败')
    }
  } catch (err) {
    const msg = err.response?.data?.message || '操作失败'
    ElMessage.error(msg)
  } finally {
    rebateLoading.value = false
  }
}

const resetRebateForm = () => {
  rebateForm.supplierId = ''
  rebateForm.amount = 0
  rebateForm.remark = ''
}

const openSettlementDialog = () => {
  settlementForm.supplierId = ''
  unpaidList.value = []
  selectedPayables.value = []
  settlementDialogVisible.value = true
}

const onSupplierChange = async (supplierId) => {
  if (!supplierId) {
    unpaidList.value = []
    return
  }
  try {
    const res = await api.getUnpaidBySupplier({ supplierId })
    if (res.code === 0) {
      unpaidList.value = res.data || []
      selectedPayables.value = []
    }
  } catch (err) {
    ElMessage.error('获取应付款失败')
  }
}

const onSelectionChange = (selection) => {
  selectedPayables.value = selection
}

const handleSettlementSubmit = async () => {
  if (selectedPayables.value.length === 0) {
    ElMessage.warning('请选择需要结算的应付款项')
    return
  }

  settlementLoading.value = true
  try {
    const res = await api.createSettlement({
      supplierId: settlementForm.supplierId,
      payableIds: selectedPayables.value.map(p => p.payable_id)
    })

    if (res.code === 0) {
      ElMessage.success('结算单创建成功')
      settlementDialogVisible.value = false
      loadPayableData()
      loadSettlementData()
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

const handleConfirmPayment = (row) => {
  payablePayRow.value = row
  payablePayAccountId.value = ''
  payablePayVisible.value = true
}

const doConfirmPayment = async () => {
  if (!payablePayAccountId.value) {
    ElMessage.warning('请选择结算账号')
    return
  }
  payablePayLoading.value = true
  try {
    const res = await api.confirmPayment({ settlementId: payablePayRow.value.settlement_id, settlementAccountId: payablePayAccountId.value })
    if (res.code === 0) {
      ElMessage.success('付款确认成功')
      payablePayVisible.value = false
      loadPayableData()
      loadSettlementData()
    } else {
      ElMessage.error(res.message || '操作失败')
    }
  } catch (err) {
    ElMessage.error('操作失败')
  } finally {
    payablePayLoading.value = false
  }
}

const resetSettlementForm = () => {
  settlementForm.supplierId = ''
  unpaidList.value = []
  selectedPayables.value = []
}

const handleAddExpense = () => {
  resetForm()
  expenseDialogVisible.value = true
}

const handleExpenseSubmit = async () => {
  if (!expenseForm.expenseType) {
    ElMessage.warning('请选择支出类型')
    return
  }
  if (!expenseForm.storeId) {
    ElMessage.warning('请选择门店')
    return
  }
  if (expenseForm.amount <= 0) {
    ElMessage.warning('请输入正确的金额')
    return
  }

  submitLoading.value = true
  try {
    const data = {
      expenseType: expenseForm.expenseType,
      storeId: expenseForm.storeId,
      amount: expenseForm.amount,
      paymentMethod: expenseForm.paymentMethod,
      remark: expenseForm.remark
    }
    const res = await api.createExpense(data)
    if (res.code === 0) {
      ElMessage.success('添加成功')
      expenseDialogVisible.value = false
      loadExpenseData()
    } else {
      ElMessage.error(res.message || '添加失败')
    }
  } catch (err) {
    ElMessage.error('添加失败')
  } finally {
    submitLoading.value = false
  }
}

const handleDialogClose = () => {
  resetForm()
}

const resetForm = () => {
  expenseForm.expenseType = ''
  expenseForm.storeId = ''
  expenseForm.amount = 0
  expenseForm.paymentMethod = 'cash'
  expenseForm.remark = ''
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
  accountTxnDialogVisible.value = true
}

const openAccountEdit = (row) => {
  accountEditForm.accountId = row.account_id
  accountEditForm.accountName = row.account_name
  accountEditForm.bankName = row.bank_name || ''
  accountEditForm.accountNumber = row.account_number || ''
  accountEditVisible.value = true
}

const handleAccountEdit = async () => {
  if (!accountEditForm.accountName) {
    ElMessage.warning('请输入账户名称')
    return
  }
  accountEditLoading.value = true
  try {
    const res = await api.updateSettlementAccount(accountEditForm.accountId, {
      accountName: accountEditForm.accountName,
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
</script>

<style scoped>
.filter-bar {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}
.el-pagination {
  margin-top: 16px;
  justify-content: flex-end;
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
</style>
