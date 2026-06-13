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

      <el-table :data="paymentCandidateData" stripe border>
        <el-table-column prop="settlement_no" label="结算单号" width="180">
          <template #default="{ row }">
            <el-button link type="primary" @click="openSettlementDetail(row)">
              {{ row.settlement_no || '-' }}
            </el-button>
          </template>
        </el-table-column>
        <el-table-column prop="supplier_name" label="供应商" width="150" />
        <el-table-column prop="total_amount" label="结算金额" width="120">
          <template #default="{ row }">¥{{ row.total_amount }}</template>
        </el-table-column>
        <el-table-column prop="paid_amount" label="已付金额" width="120">
          <template #default="{ row }">¥{{ row.paid_amount || 0 }}</template>
        </el-table-column>
        <el-table-column prop="remaining_amount" label="剩余应付" width="120">
          <template #default="{ row }">¥{{ row.remaining_amount }}</template>
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

      <el-table :data="paymentBatchData" stripe border>
        <el-table-column prop="batch_no" label="付款批次号" width="190" />
        <el-table-column prop="account_name" label="付款账户" width="180" />
        <el-table-column prop="total_amount" label="付款总额" width="120">
          <template #default="{ row }">¥{{ row.total_amount }}</template>
        </el-table-column>
        <el-table-column prop="total_count" label="笔数" width="80" />
        <el-table-column prop="status" label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 'active' ? 'success' : 'info'">
              {{ row.status === 'active' ? '正常' : '已撤销' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="create_user" label="导入人" width="110" />
        <el-table-column prop="create_time" label="导入时间" width="170">
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
          <el-descriptions-item label="付款总额">¥{{ paymentBatchDetail.total_amount || 0 }}</el-descriptions-item>
          <el-descriptions-item label="付款笔数">{{ paymentBatchDetail.total_count || 0 }}</el-descriptions-item>
          <el-descriptions-item label="状态">{{ paymentBatchDetail.status === 'active' ? '正常' : '已撤销' }}</el-descriptions-item>
          <el-descriptions-item label="导入时间">{{ formatDateTime(paymentBatchDetail.create_time) }}</el-descriptions-item>
          <el-descriptions-item label="撤销时间">{{ formatDateTime(paymentBatchDetail.void_time) }}</el-descriptions-item>
          <el-descriptions-item label="撤销原因">{{ paymentBatchDetail.void_reason || '-' }}</el-descriptions-item>
        </el-descriptions>
        <el-table :data="paymentBatchDetail.records || []" stripe border class="mt-20">
          <el-table-column prop="settlement_no" label="结算单号" width="180" />
          <el-table-column prop="supplier_name" label="供应商" width="130" />
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
const paymentCandidateStatusFilter = ref('')
const paymentBatchData = ref([])
const paymentBatchTotal = ref(0)
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

const paymentCandidateQuery = reactive({ page: 1, pageSize: 20 })
const paymentBatchQuery = reactive({ page: 1, pageSize: 20 })

const selectedPaymentAccountName = computed(() => {
  const account = settlementAccounts.value.find(acc => acc.account_id === paymentAccountId.value)
  return account ? formatSettlementAccountOption(account) : '-'
})

onMounted(() => {
  loadSettlementAccounts()
  loadPaymentCandidates()
  loadPaymentBatches()
})

const formatSettlementAccountOption = (account) => {
  return `${account.account_name || '-'}（余额：¥${Number(account.balance || 0).toFixed(2)}）`
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
    if (res.code === 0) settlementAccounts.value = res.data?.list || []
  } catch (err) {
    ElMessage.error('加载付款账户失败')
  }
}

const loadPaymentCandidates = async () => {
  try {
    const params = { ...paymentCandidateQuery }
    if (paymentCandidateStatusFilter.value) params.paymentStatus = paymentCandidateStatusFilter.value
    const res = await api.getSettlementPaymentCandidates(params)
    if (res.code === 0) {
      paymentCandidateData.value = res.data?.list || []
      paymentCandidateTotal.value = res.data?.pagination?.total || res.data?.total || 0
    }
  } catch (err) {
    ElMessage.error('加载待付款清单失败')
  }
}

const loadPaymentBatches = async () => {
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

const handleExportPayments = async () => {
  try {
    const params = {}
    if (paymentCandidateStatusFilter.value) params.paymentStatus = paymentCandidateStatusFilter.value
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
