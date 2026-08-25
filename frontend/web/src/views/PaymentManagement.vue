<template>
  <div class="payment-management-page">
    <component :is="embedded ? 'div' : 'el-card'" :class="{ 'embedded-payment-panel': embedded }">
      <template v-if="!embedded" #header>
        <span>付款管理</span>
      </template>

      <div class="section-header">
        <span>待付款清单</span>
        <div class="toolbar">
          <el-select v-model="paymentAccountId" placeholder="选择付款账户" clearable filterable style="width: 260px">
            <el-option
              v-for="acc in settlementAccounts"
              :key="acc.account_id"
              :label="formatSettlementAccountOption(acc)"
              :value="acc.account_id"
            />
          </el-select>
          <el-select v-model="paymentCandidateStatusFilter" placeholder="付款状态" clearable style="width: 140px" @change="loadPaymentCandidates">
            <el-option label="全部" value="" />
            <el-option label="未付款" value="unpaid" />
            <el-option label="部分付款" value="partial_paid" />
          </el-select>
          <el-select v-model="paymentCandidateDistributorFilter" placeholder="经销商" clearable style="width: 150px" @change="loadPaymentCandidates">
            <el-option v-for="item in distributorOptions" :key="item.distributor_id" :label="item.name" :value="item.distributor_id" />
          </el-select>
          <el-select v-model="paymentCandidateTaxFilter" placeholder="税务属性" clearable style="width: 140px" @change="loadPaymentCandidates">
            <el-option label="含税" value="TAX_INCLUDED" />
            <el-option label="未税" value="UNTAXED" />
          </el-select>
          <el-button type="primary" @click="handleExportPayments">导出付款清单</el-button>
          <el-upload
            :auto-upload="false"
            :show-file-list="false"
            accept=".xlsx,.xls"
            :on-change="handlePaymentImportFile"
          >
            <el-button type="success">导入付款结果</el-button>
          </el-upload>
        </div>
      </div>

      <el-table v-loading="paymentCandidatesLoading" :data="paymentCandidateData" stripe border>
        <el-table-column prop="settlement_no" label="结算单号" width="180">
          <template #default="{ row }">
            <el-button link type="primary" @click="openSettlementDetail(row)">
              {{ row.settlement_no || '-' }}
            </el-button>
          </template>
        </el-table-column>
        <el-table-column prop="supplier_name" label="供应商" width="150" />
        <el-table-column prop="distributor_name" label="经销商" width="130">
          <template #default="{ row }">{{ distributorText(row) }}</template>
        </el-table-column>
        <el-table-column prop="tax_status" label="税务属性" width="100">
          <template #default="{ row }">
            <el-tag :type="taxStatusTagType(row.tax_status)" size="small">{{ taxStatusText(row.tax_status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="对方收款信息" min-width="230">
          <template #default="{ row }">{{ counterpartySummary(row) }}</template>
        </el-table-column>
        <el-table-column prop="total_amount" label="结算金额" width="120">
          <template #default="{ row }">¥{{ formatAmount(row.total_amount) }}</template>
        </el-table-column>
        <el-table-column prop="paid_amount" label="已付金额" width="120">
          <template #default="{ row }">¥{{ formatAmount(row.paid_amount) }}</template>
        </el-table-column>
        <el-table-column prop="remaining_amount" label="剩余应付" width="120">
          <template #default="{ row }">¥{{ formatAmount(row.remaining_amount) }}</template>
        </el-table-column>
        <el-table-column prop="payment_status" label="付款状态" width="110">
          <template #default="{ row }">
            <el-tag :type="getPaymentStatusTagType(row.payment_status)">
              {{ getPaymentStatusText(row.payment_status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="confirmed_time" label="提交时间" width="170">
          <template #default="{ row }">{{ formatDateTime(row.confirmed_time) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="110" fixed="right">
          <template #default="{ row }">
            <el-button v-if="Number(row.remaining_amount) > 0" link type="primary" @click="openImmediatePayment(row)">立即付款</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        v-model:current-page="paymentCandidateQuery.page"
        v-model:page-size="paymentCandidateQuery.pageSize"
        :total="paymentCandidateTotal"
        layout="total, sizes, prev, pager, next"
        @size-change="loadPaymentCandidates"
        @current-change="loadPaymentCandidates"
      />

      <div class="section-header batch-header">
        <span>付款批次</span>
        <el-select v-model="paymentBatchStatusFilter" placeholder="批次状态" clearable style="width: 140px" @change="loadPaymentBatches">
          <el-option label="全部" value="" />
          <el-option label="正常" value="active" />
          <el-option label="已撤销" value="voided" />
        </el-select>
      </div>

      <el-table v-loading="paymentBatchesLoading" :data="paymentBatchData" stripe border>
        <el-table-column prop="batch_no" label="付款批次号" width="190" />
        <el-table-column prop="account_name" label="付款账户" width="180" />
        <el-table-column prop="distributor_name" label="经销商" width="130">
          <template #default="{ row }">{{ distributorText(row) }}</template>
        </el-table-column>
        <el-table-column prop="tax_status" label="税务属性" width="100">
          <template #default="{ row }">
            <el-tag :type="taxStatusTagType(row.tax_status)" size="small">{{ taxStatusText(row.tax_status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="total_amount" label="付款总额" width="120">
          <template #default="{ row }">¥{{ formatAmount(row.total_amount) }}</template>
        </el-table-column>
        <el-table-column prop="total_count" label="笔数" width="80" />
        <el-table-column prop="status" label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 'active' ? 'success' : 'info'">
              {{ row.status === 'active' ? '正常' : '已撤销' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="create_user" label="操作人" width="110" />
        <el-table-column prop="create_time" label="操作时间" width="170">
          <template #default="{ row }">{{ formatDateTime(row.create_time) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="160">
          <template #default="{ row }">
            <el-button link type="primary" @click="openPaymentBatchDetail(row)">查看</el-button>
            <el-button v-if="row.status === 'active'" link type="danger" @click="handleVoidPaymentBatch(row)">撤销</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        v-model:current-page="paymentBatchQuery.page"
        v-model:page-size="paymentBatchQuery.pageSize"
        :total="paymentBatchTotal"
        layout="total, sizes, prev, pager, next"
        @size-change="loadPaymentBatches"
        @current-change="loadPaymentBatches"
      />
    </component>

    <el-dialog v-model="settlementDetailVisible" title="应付结算单详情" width="820px">
      <div v-if="settlementDetail">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="结算单号">{{ settlementDetail.settlement_no || '-' }}</el-descriptions-item>
          <el-descriptions-item label="供应商">{{ settlementDetail.supplier_name || '-' }}</el-descriptions-item>
          <el-descriptions-item label="经销商">{{ distributorText(settlementDetail) }}</el-descriptions-item>
          <el-descriptions-item label="税务属性"><el-tag :type="taxStatusTagType(settlementDetail.tax_status)" size="small">{{ taxStatusText(settlementDetail.tax_status) }}</el-tag></el-descriptions-item>
          <el-descriptions-item label="收款单位">{{ counterpartyCompany(settlementDetail) }}</el-descriptions-item>
          <el-descriptions-item label="开户行">{{ counterpartyBank(settlementDetail) }}</el-descriptions-item>
          <el-descriptions-item label="收款账号">{{ counterpartyAccount(settlementDetail) }}</el-descriptions-item>
          <el-descriptions-item label="收款方税号">{{ counterpartyTaxNo(settlementDetail) }}</el-descriptions-item>
          <el-descriptions-item label="收款备注" :span="2">{{ counterpartyRemark(settlementDetail) }}</el-descriptions-item>
          <el-descriptions-item label="结算金额">¥{{ settlementDetail.total_amount || 0 }}</el-descriptions-item>
          <el-descriptions-item label="已付金额">¥{{ settlementDetail.paid_amount || 0 }}</el-descriptions-item>
          <el-descriptions-item label="付款状态">
            <el-tag :type="getPaymentStatusTagType(settlementDetail.payment_status)">
              {{ getPaymentStatusText(settlementDetail.payment_status) }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="提交时间">{{ formatDateTime(settlementDetail.confirmed_time) }}</el-descriptions-item>
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

    <el-dialog v-model="immediatePaymentVisible" title="付款登记" width="560px">
      <el-descriptions v-if="immediatePaymentSettlement" :column="1" border size="small">
        <el-descriptions-item label="结算单号">{{ immediatePaymentSettlement.settlement_no || '-' }}</el-descriptions-item>
        <el-descriptions-item label="供应商">{{ immediatePaymentSettlement.supplier_name || '-' }}</el-descriptions-item>
        <el-descriptions-item label="经销商">{{ distributorText(immediatePaymentSettlement) }}</el-descriptions-item>
        <el-descriptions-item label="税务属性"><el-tag :type="taxStatusTagType(immediatePaymentSettlement.tax_status)" size="small">{{ taxStatusText(immediatePaymentSettlement.tax_status) }}</el-tag></el-descriptions-item>
        <el-descriptions-item label="对方收款单位">{{ counterpartyCompany(immediatePaymentSettlement) }}</el-descriptions-item>
        <el-descriptions-item label="对方开户行">{{ counterpartyBank(immediatePaymentSettlement) }}</el-descriptions-item>
        <el-descriptions-item label="对方收款账号">{{ counterpartyAccount(immediatePaymentSettlement) }}</el-descriptions-item>
        <el-descriptions-item label="收款备注">{{ counterpartyRemark(immediatePaymentSettlement) }}</el-descriptions-item>
        <el-descriptions-item label="剩余应付">¥{{ formatAmount(immediatePaymentRemaining) }}</el-descriptions-item>
      </el-descriptions>

      <el-form label-width="100px" class="mt-20">
        <el-form-item label="付款金额" required>
          <el-input-number
            v-model="immediatePaymentForm.amount"
            :min="0.01"
            :max="immediatePaymentRemaining"
            :precision="2"
            :step="100"
            controls-position="right"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="付款账户" required>
          <el-select v-model="immediatePaymentForm.accountId" placeholder="请选择付款账户" filterable style="width: 100%">
            <el-option
              v-for="acc in settlementAccounts"
              :key="acc.account_id"
              :label="formatSettlementAccountOption(acc)"
              :value="acc.account_id"
            />
          </el-select>
        </el-form-item>
      </el-form>

      <el-alert
        v-if="immediatePaymentAccount"
        :title="`当前余额 ¥${formatAmount(immediatePaymentAccount.balance)}，付款后余额 ¥${formatAmount(immediatePaymentProjectedBalance)}`"
        :type="immediatePaymentProjectedBalance < 0 ? 'warning' : 'info'"
        show-icon
        :closable="false"
      />

      <template #footer>
        <el-button @click="immediatePaymentVisible = false">取消</el-button>
        <el-button type="primary" :loading="immediatePaymentSubmitting" @click="submitImmediatePayment">
          确定付款
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="paymentImportPreviewVisible" title="付款导入确认" width="860px">
      <div v-if="paymentImportErrors.length > 0">
        <el-alert title="导入校验失败，整批未处理" type="error" show-icon :closable="false" />
        <el-table :data="paymentImportErrors" stripe border class="mt-20">
          <el-table-column prop="row" label="行号" width="80" />
          <el-table-column prop="settlementNo" label="结算单号" width="180" />
          <el-table-column prop="message" label="错误原因" min-width="260" />
        </el-table>
      </div>
      <div v-else>
        <el-alert
          :title="`本次将从账户「${selectedPaymentAccountName}」扣款，付款 ${paymentImportPreview.totalCount || 0} 笔，合计 ¥${paymentImportPreview.totalAmount || 0}`"
          type="warning"
          show-icon
          :closable="false"
        />
        <el-table :data="paymentImportRows" stripe border class="mt-20">
          <el-table-column prop="settlementNo" label="结算单号" width="180" />
          <el-table-column prop="supplierName" label="供应商" width="130" />
          <el-table-column prop="distributorName" label="经销商" width="130">
            <template #default="{ row }">{{ distributorText({ distributor_name: row.distributorName, distributor_id: row.distributorId }) }}</template>
          </el-table-column>
          <el-table-column prop="taxStatus" label="税务属性" width="100">
            <template #default="{ row }"><el-tag :type="taxStatusTagType(row.taxStatus)" size="small">{{ taxStatusText(row.taxStatus) }}</el-tag></template>
          </el-table-column>
          <el-table-column label="对方收款信息" min-width="230">
            <template #default="{ row }">{{ counterpartySummary(row) }}</template>
          </el-table-column>
          <el-table-column label="对方开户行" min-width="180" show-overflow-tooltip>
            <template #default="{ row }">{{ counterpartyBank(row) }}</template>
          </el-table-column>
          <el-table-column label="对方收款账号" min-width="180" show-overflow-tooltip>
            <template #default="{ row }">{{ counterpartyAccount(row) }}</template>
          </el-table-column>
          <el-table-column prop="remainingAmount" label="剩余应付" width="120">
            <template #default="{ row }">¥{{ row.remainingAmount }}</template>
          </el-table-column>
          <el-table-column prop="amount" label="本次付款" width="120">
            <template #default="{ row }">¥{{ row.amount }}</template>
          </el-table-column>
          <el-table-column prop="paymentTime" label="付款时间" width="170">
            <template #default="{ row }">{{ formatDateTime(row.paymentTime) }}</template>
          </el-table-column>
          <el-table-column prop="remark" label="备注" min-width="140" />
        </el-table>
      </div>
      <template #footer>
        <el-button @click="paymentImportPreviewVisible = false">关闭</el-button>
        <el-button
          v-if="paymentImportErrors.length === 0"
          type="primary"
          :loading="paymentImportCommitting"
          @click="commitPaymentImport"
        >
          确认扣款并入账
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="paymentBatchDetailVisible" title="付款批次详情" width="860px">
      <div v-if="paymentBatchDetail">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="批次号">{{ paymentBatchDetail.batch_no || '-' }}</el-descriptions-item>
          <el-descriptions-item label="付款账户">{{ paymentBatchDetail.account_name || '-' }}</el-descriptions-item>
          <el-descriptions-item label="经销商">{{ distributorText(paymentBatchDetail) }}</el-descriptions-item>
          <el-descriptions-item label="税务属性"><el-tag :type="taxStatusTagType(paymentBatchDetail.tax_status)" size="small">{{ taxStatusText(paymentBatchDetail.tax_status) }}</el-tag></el-descriptions-item>
          <el-descriptions-item label="付款总额">¥{{ paymentBatchDetail.total_amount || 0 }}</el-descriptions-item>
          <el-descriptions-item label="付款笔数">{{ paymentBatchDetail.total_count || 0 }}</el-descriptions-item>
          <el-descriptions-item label="状态">{{ paymentBatchDetail.status === 'active' ? '正常' : '已撤销' }}</el-descriptions-item>
          <el-descriptions-item label="操作时间">{{ formatDateTime(paymentBatchDetail.create_time) }}</el-descriptions-item>
          <el-descriptions-item label="撤销时间">{{ formatDateTime(paymentBatchDetail.void_time) }}</el-descriptions-item>
          <el-descriptions-item label="撤销原因">{{ paymentBatchDetail.void_reason || '-' }}</el-descriptions-item>
        </el-descriptions>
        <el-table :data="paymentBatchDetail.records || []" stripe border class="mt-20">
          <el-table-column prop="settlement_no" label="结算单号" width="180" />
          <el-table-column prop="supplier_name" label="供应商" width="130" />
          <el-table-column prop="distributor_name" label="经销商" width="130">
            <template #default="{ row }">{{ distributorText(row) }}</template>
          </el-table-column>
          <el-table-column prop="tax_status" label="税务属性" width="100">
            <template #default="{ row }"><el-tag :type="taxStatusTagType(row.tax_status)" size="small">{{ taxStatusText(row.tax_status) }}</el-tag></template>
          </el-table-column>
          <el-table-column label="对方收款信息" min-width="230">
            <template #default="{ row }">{{ counterpartySummary(row) }}</template>
          </el-table-column>
          <el-table-column label="对方开户行" min-width="180" show-overflow-tooltip>
            <template #default="{ row }">{{ counterpartyBank(row) }}</template>
          </el-table-column>
          <el-table-column label="对方收款账号" min-width="180" show-overflow-tooltip>
            <template #default="{ row }">{{ counterpartyAccount(row) }}</template>
          </el-table-column>
          <el-table-column prop="amount" label="付款金额" width="120">
            <template #default="{ row }">¥{{ row.amount }}</template>
          </el-table-column>
          <el-table-column prop="payment_time" label="付款时间" width="160">
            <template #default="{ row }">{{ formatDateTime(row.payment_time) }}</template>
          </el-table-column>
          <el-table-column prop="status" label="状态" width="90">
            <template #default="{ row }">{{ row.status === 'active' ? '正常' : '已撤销' }}</template>
          </el-table-column>
          <el-table-column prop="remark" label="备注" min-width="140" />
        </el-table>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import * as XLSX from 'xlsx'
import api from '../api'

defineProps({
  embedded: {
    type: Boolean,
    default: false
  }
})

const settlementAccounts = ref([])
const paymentAccountId = ref('')
const paymentCandidateData = ref([])
const paymentCandidateTotal = ref(0)
const paymentCandidatesLoading = ref(false)
const paymentCandidateStatusFilter = ref('')
const paymentCandidateDistributorFilter = ref('')
const paymentCandidateTaxFilter = ref('')
const distributorOptions = ref([
  { distributor_id: 'DIST001', name: '艾诺云' },
  { distributor_id: 'DIST002', name: '艾诺志兴' }
])
const paymentBatchData = ref([])
const paymentBatchTotal = ref(0)
const paymentBatchesLoading = ref(false)
const paymentBatchStatusFilter = ref('')
const settlementDetailVisible = ref(false)
const settlementDetail = ref(null)
const paymentImportPreviewVisible = ref(false)
const paymentImportPreview = ref({})
const paymentImportRows = ref([])
const paymentImportRawRows = ref([])
const paymentImportErrors = ref([])
const paymentImportCommitting = ref(false)
const paymentBatchDetailVisible = ref(false)
const paymentBatchDetail = ref(null)
const immediatePaymentVisible = ref(false)
const immediatePaymentSettlement = ref(null)
const immediatePaymentSubmitting = ref(false)
const immediatePaymentForm = reactive({ accountId: '', amount: 0 })

const paymentCandidateQuery = reactive({ page: 1, pageSize: 20 })
const paymentBatchQuery = reactive({ page: 1, pageSize: 20 })

const selectedPaymentAccountName = computed(() => {
  const account = settlementAccounts.value.find(acc => acc.account_id === paymentAccountId.value)
  return account ? formatSettlementAccountOption(account) : '-'
})

const immediatePaymentRemaining = computed(() => Number(immediatePaymentSettlement.value?.remaining_amount || 0))
const immediatePaymentAccount = computed(() => {
  return settlementAccounts.value.find(acc => acc.account_id === immediatePaymentForm.accountId) || null
})
const immediatePaymentProjectedBalance = computed(() => {
  return Number(immediatePaymentAccount.value?.balance || 0) - Number(immediatePaymentForm.amount || 0)
})

onMounted(() => {
  loadDistributorOptions()
  loadSettlementAccounts()
  loadPaymentCandidates()
  loadPaymentBatches()
})

const formatSettlementAccountOption = (account) => {
  return `${account.account_name || '-'}（余额：¥${Number(account.balance || 0).toFixed(2)}）`
}

const formatAmount = (amount) => Number(amount || 0).toFixed(2)

const distributorText = row => row?.distributor_name || distributorOptions.value.find(item => String(item.distributor_id) === String(row?.distributor_id))?.name || row?.distributor_id || '未知经销商'
const taxStatusText = status => ({ TAX_INCLUDED: '含税', UNTAXED: '未税', MIXED: '含税+未税', UNKNOWN: '未知' }[String(status || '').toUpperCase()] || '未知')
const taxStatusTagType = status => ({ TAX_INCLUDED: 'success', UNTAXED: 'warning', MIXED: 'danger', UNKNOWN: 'info' }[String(status || '').toUpperCase()] || 'info')

const counterpartyInfo = row => row?.counterparty_payment_info || row?.supplier_account_snapshot_parsed || row?.counterpartyPaymentInfo || row?.supplierAccount || {}
const counterpartyCompany = row => counterpartyInfo(row).companyName || row?.payee_name || row?.supplier_name || row?.supplierName || '-'
const counterpartyBank = row => counterpartyInfo(row).bankName || '-'
const counterpartyAccount = row => counterpartyInfo(row).accountNumber || '-'
const counterpartyTaxNo = row => counterpartyInfo(row).taxNo || '-'
const counterpartyRemark = row => counterpartyInfo(row).remark || row?.other_payment_remark || '-'
const maskAccount = value => {
  const account = String(value || '').trim()
  if (!account) return ''
  if (account.length <= 8) return account
  return `${account.slice(0, 4)} **** ${account.slice(-4)}`
}
const counterpartySummary = row => {
  const info = counterpartyInfo(row)
  const values = [counterpartyCompany(row)]
  if (info.bankName) values.push(info.bankName)
  if (info.accountNumber) values.push(maskAccount(info.accountNumber))
  if (values.length === 1 && !info.remark && !row?.other_payment_remark) return '未配置'
  return values.join(' / ')
}

const formatDateTime = (time) => {
  if (!time) return '-'
  const d = new Date(time)
  if (Number.isNaN(d.getTime())) return '-'
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  return `${y}-${m}-${day} ${h}:${min}:${s}`
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

const loadSettlementAccounts = async () => {
  try {
    const res = await api.getSettlementAccountsBalance({ page: 1, pageSize: 500 })
    if (res.code === 0) settlementAccounts.value = (res.data?.list || []).filter(account => account.account_type !== 'SUPPLIER_REBATE')
  } catch (err) {
    ElMessage.error('加载付款账户失败')
  }
}

const loadDistributorOptions = async () => {
  try {
    const res = await api.getUserDistributors()
    if (res.code === 0 && Array.isArray(res.data) && res.data.length) distributorOptions.value = res.data
  } catch (err) {
    // 固定的双经销商只读展示项保留，筛选接口失败不影响付款数据加载。
  }
}

const loadPaymentCandidates = async () => {
  paymentCandidatesLoading.value = true
  try {
    const params = { ...paymentCandidateQuery }
    if (paymentCandidateStatusFilter.value) params.paymentStatus = paymentCandidateStatusFilter.value
    if (paymentCandidateDistributorFilter.value) params.distributorId = paymentCandidateDistributorFilter.value
    if (paymentCandidateTaxFilter.value) params.taxStatus = paymentCandidateTaxFilter.value
    const res = await api.getSettlementPaymentCandidates(params)
    if (res.code === 0) {
      paymentCandidateData.value = res.data?.list || []
      paymentCandidateTotal.value = res.data?.pagination?.total || res.data?.total || 0
    }
  } catch (err) {
    ElMessage.error('加载待付款清单失败')
  } finally {
    paymentCandidatesLoading.value = false
  }
}

const loadPaymentBatches = async () => {
  paymentBatchesLoading.value = true
  try {
    const params = { ...paymentBatchQuery }
    if (paymentBatchStatusFilter.value) params.status = paymentBatchStatusFilter.value
    const res = await api.getSettlementPaymentBatches(params)
    if (res.code === 0) {
      paymentBatchData.value = res.data?.list || []
      paymentBatchTotal.value = res.data?.pagination?.total || res.data?.total || 0
    }
  } catch (err) {
    ElMessage.error('加载付款批次失败')
  } finally {
    paymentBatchesLoading.value = false
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

const openImmediatePayment = (row) => {
  immediatePaymentSettlement.value = row
  immediatePaymentForm.accountId = paymentAccountId.value || ''
  immediatePaymentForm.amount = Number(row.remaining_amount || 0)
  immediatePaymentVisible.value = true
}

const submitImmediatePayment = async () => {
  const settlement = immediatePaymentSettlement.value
  const amount = Number(immediatePaymentForm.amount)
  if (!settlement) return
  if (!immediatePaymentForm.accountId) {
    ElMessage.warning('请选择付款账户')
    return
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    ElMessage.warning('付款金额必须大于0')
    return
  }
  if (amount > immediatePaymentRemaining.value) {
    ElMessage.warning('付款金额不能超过剩余应付金额')
    return
  }

  if (immediatePaymentProjectedBalance.value < 0) {
    try {
      await ElMessageBox.confirm(
        `账户余额不足，本次付款后余额为 ¥${formatAmount(immediatePaymentProjectedBalance.value)}。仍要登记付款吗？`,
        '余额不足提示',
        { confirmButtonText: '继续付款', cancelButtonText: '取消', type: 'warning' }
      )
    } catch (err) {
      if (err === 'cancel' || err === 'close') return
      throw err
    }
  }

  immediatePaymentSubmitting.value = true
  try {
    const res = await api.createDirectSettlementPayment({
      settlementId: settlement.settlement_id,
      accountId: immediatePaymentForm.accountId,
      amount
    })
    if (res.code === 0) {
      immediatePaymentVisible.value = false
      if (Number(res.data?.balanceAfter) < 0) {
        ElMessage.warning(`${res.message}，付款后余额 ¥${formatAmount(res.data.balanceAfter)}`)
      } else {
        ElMessage.success(res.message || '付款登记成功')
      }
      await Promise.all([loadPaymentCandidates(), loadPaymentBatches(), loadSettlementAccounts()])
    } else {
      ElMessage.error(res.message || '付款登记失败')
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '付款登记失败')
  } finally {
    immediatePaymentSubmitting.value = false
  }
}

const handleExportPayments = async () => {
  try {
    const params = {}
    if (paymentCandidateStatusFilter.value) params.paymentStatus = paymentCandidateStatusFilter.value
    if (paymentCandidateDistributorFilter.value) params.distributorId = paymentCandidateDistributorFilter.value
    if (paymentCandidateTaxFilter.value) params.taxStatus = paymentCandidateTaxFilter.value
    await api.exportSettlementPayments(params)
  } catch (err) {
    ElMessage.error('导出付款清单失败')
  }
}

const handlePaymentImportFile = async (file) => {
  if (!paymentAccountId.value) {
    ElMessage.warning('请先选择付款账户')
    return
  }

  const rawFile = file.raw
  if (!rawFile) return

  try {
    const buffer = await rawFile.arrayBuffer()
    const workbook = XLSX.read(buffer, { type: 'array', cellDates: true })
    const sheetName = workbook.SheetNames[0]
    const worksheet = workbook.Sheets[sheetName]
    const rows = XLSX.utils.sheet_to_json(worksheet, { defval: '' })
    if (!rows.length) {
      ElMessage.warning('导入文件没有数据')
      return
    }

    paymentImportRawRows.value = rows
    const res = await api.validateSettlementPaymentImport({
      accountId: paymentAccountId.value,
      rows
    })

    paymentImportPreview.value = res.data || {}
    paymentImportRows.value = res.data?.list || []
    paymentImportErrors.value = res.data?.errors || []
    paymentImportPreviewVisible.value = true
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '解析导入文件失败')
  }
}

const commitPaymentImport = async () => {
  if (!paymentAccountId.value) {
    ElMessage.warning('请先选择付款账户')
    return
  }

  paymentImportCommitting.value = true
  try {
    const res = await api.commitSettlementPaymentImport({
      accountId: paymentAccountId.value,
      rows: paymentImportRawRows.value
    })

    if (res.code === 0) {
      ElMessage.success(res.message || '付款导入成功')
      paymentImportPreviewVisible.value = false
      paymentImportPreview.value = {}
      paymentImportRows.value = []
      paymentImportRawRows.value = []
      paymentImportErrors.value = []
      loadPaymentCandidates()
      loadPaymentBatches()
      loadSettlementAccounts()
    } else {
      paymentImportErrors.value = res.data?.errors || [{ row: 0, message: res.message || '导入失败' }]
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.message || '付款导入失败')
  } finally {
    paymentImportCommitting.value = false
  }
}

const openPaymentBatchDetail = async (row) => {
  try {
    const res = await api.getSettlementPaymentBatchDetail(row.batch_id)
    if (res.code === 0) {
      paymentBatchDetail.value = res.data || null
      paymentBatchDetailVisible.value = true
    }
  } catch (err) {
    ElMessage.error('加载付款批次详情失败')
  }
}

const handleVoidPaymentBatch = async (row) => {
  try {
    await ElMessageBox.confirm(
      `确认撤销付款批次 ${row.batch_no || ''}？撤销后将生成反向流水并恢复账户余额。`,
      '撤销付款批次',
      { confirmButtonText: '确认撤销', cancelButtonText: '取消', type: 'warning' }
    )
    const res = await api.voidSettlementPaymentBatch({ batchId: row.batch_id })
    if (res.code === 0) {
      ElMessage.success(res.message || '付款批次已撤销')
      loadPaymentCandidates()
      loadPaymentBatches()
      loadSettlementAccounts()
    } else {
      ElMessage.error(res.message || '撤销失败')
    }
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error(err.response?.data?.message || '撤销失败')
    }
  }
}
</script>

<style scoped>
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
  font-weight: 700;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.batch-header {
  margin-top: 28px;
}

.el-pagination {
  margin-top: 16px;
  justify-content: flex-end;
}

.mt-20 {
  margin-top: 20px;
}
</style>
