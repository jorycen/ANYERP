<template>
  <div class="settlement-management-page">
    <el-card>
      <template #header>
        <div class="page-header">
          <span>应付结算单管理</span>
          <el-button link type="primary" @click="router.push('/finance')">返回财务管理</el-button>
        </div>
      </template>

      <div class="filter-bar">
        <el-select v-model="query.status" placeholder="结算状态" clearable style="width: 150px" @change="reload">
          <el-option label="全部" value="" />
          <el-option label="草稿" value="draft" />
          <el-option label="待审批" value="pending_approval" />
          <el-option label="待付款" value="confirmed" />
          <el-option label="已作废" value="voided" />
        </el-select>
        <el-select v-model="query.paymentStatus" placeholder="付款状态" clearable style="width: 150px" @change="reload">
          <el-option label="全部" value="" />
          <el-option label="未付款" value="unpaid" />
          <el-option label="部分付款" value="partial_paid" />
          <el-option label="已付款" value="paid" />
        </el-select>
        <el-button type="primary" @click="loadData">查询</el-button>
      </div>

      <el-table v-loading="loading" :data="data" stripe border>
        <el-table-column prop="settlement_no" label="结算单号" width="190" />
        <el-table-column label="收款方" width="150">
          <template #default="{ row }">{{ row.payee_name || row.supplier_name || '-' }}</template>
        </el-table-column>
        <el-table-column prop="total_amount" label="结算金额" width="120">
          <template #default="{ row }">¥{{ money(row.total_amount) }}</template>
        </el-table-column>
        <el-table-column prop="paid_amount" label="已付金额" width="120">
          <template #default="{ row }">¥{{ money(row.paid_amount) }}</template>
        </el-table-column>
        <el-table-column label="剩余应付" width="120">
          <template #default="{ row }">¥{{ money(remaining(row)) }}</template>
        </el-table-column>
        <el-table-column prop="status" label="结算状态" width="110">
          <template #default="{ row }">
            <el-tag :type="statusType(row.status)">{{ statusText(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="payment_status" label="付款状态" width="110">
          <template #default="{ row }">
            <el-tag :type="paymentStatusType(row.payment_status)">{{ paymentStatusText(row.payment_status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="180" show-overflow-tooltip />
        <el-table-column prop="create_time" label="创建时间" width="170">
          <template #default="{ row }">{{ dateTime(row.create_time) }}</template>
        </el-table-column>
        <el-table-column label="操作" min-width="250" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)">详情</el-button>
            <el-button v-if="row.status === 'pending_approval'" link type="success" @click="approve(row)">通过</el-button>
            <el-button v-if="row.status === 'pending_approval'" link type="danger" @click="reject(row)">退回</el-button>
            <el-button v-if="row.status === 'draft' && !row.submit_time" link type="warning" @click="submit(row)">提交</el-button>
            <el-button v-if="row.status === 'draft' && !row.submit_time" link type="danger" @click="deleteDraft(row)">删除</el-button>
            <el-button v-if="row.status === 'confirmed' && remaining(row) > 0" link type="primary" @click="openPayment(row)">部分付款</el-button>
            <el-button v-if="row.status !== 'voided' && row.payment_status === 'unpaid'" link type="danger" @click="voidSettlement(row)">作废</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        v-model:current-page="query.page"
        v-model:page-size="query.pageSize"
        :total="total"
        layout="total, sizes, prev, pager, next"
        @size-change="loadData"
        @current-change="loadData"
      />
    </el-card>

    <el-dialog v-model="detailVisible" title="应付结算单详情" width="900px">
      <div v-if="detail">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="结算单号">{{ detail.settlement_no || '-' }}</el-descriptions-item>
          <el-descriptions-item label="收款方">{{ detail.payee_name || detail.supplier_name || '-' }}</el-descriptions-item>
          <el-descriptions-item label="结算金额">¥{{ money(detail.total_amount) }}</el-descriptions-item>
          <el-descriptions-item label="已付金额">¥{{ money(detail.paid_amount) }}</el-descriptions-item>
          <el-descriptions-item label="结算状态">
            <el-tag :type="statusType(detail.status)">{{ statusText(detail.status) }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="付款状态">
            <el-tag :type="paymentStatusType(detail.payment_status)">{{ paymentStatusText(detail.payment_status) }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="创建人">{{ detail.create_user || '-' }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ dateTime(detail.create_time) }}</el-descriptions-item>
          <el-descriptions-item label="提交时间">{{ dateTime(detail.submit_time || detail.confirmed_time) }}</el-descriptions-item>
          <el-descriptions-item label="审批人">{{ detail.approval_user || '-' }}</el-descriptions-item>
          <el-descriptions-item label="审批时间">{{ dateTime(detail.approval_time) }}</el-descriptions-item>
          <el-descriptions-item label="备注" :span="2">{{ detail.remark || '-' }}</el-descriptions-item>
          <el-descriptions-item label="审批意见" :span="2">{{ detail.approval_comment || '-' }}</el-descriptions-item>
        </el-descriptions>

        <el-table :data="detail.items || []" stripe border class="detail-table">
          <el-table-column prop="request_no" label="采购单号" width="180" />
          <el-table-column prop="product_name" label="采购商品" min-width="180" />
          <el-table-column label="结算数量" width="110">
            <template #default="{ row }">{{ row.quantity === null || row.quantity === undefined ? '-' : quantity(row.quantity) }}</template>
          </el-table-column>
          <el-table-column prop="unit_price" label="单价" width="110">
            <template #default="{ row }">{{ row.unit_price === null || row.unit_price === undefined ? '-' : money(row.unit_price) }}</template>
          </el-table-column>
          <el-table-column prop="amount" label="金额" width="120">
            <template #default="{ row }">¥{{ money(row.amount) }}</template>
          </el-table-column>
        </el-table>

        <el-table :data="detail.payments || []" stripe border class="detail-table">
          <el-table-column prop="amount" label="付款金额" width="120">
            <template #default="{ row }">¥{{ money(row.amount) }}</template>
          </el-table-column>
          <el-table-column prop="payment_time" label="付款时间" width="170">
            <template #default="{ row }">{{ dateTime(row.payment_time) }}</template>
          </el-table-column>
          <el-table-column prop="remark" label="付款备注" min-width="180" />
        </el-table>
      </div>
    </el-dialog>

    <el-dialog v-model="paymentVisible" title="部分付款" width="560px">
      <el-descriptions v-if="paymentSettlement" :column="1" border size="small">
        <el-descriptions-item label="结算单号">{{ paymentSettlement.settlement_no }}</el-descriptions-item>
        <el-descriptions-item label="剩余应付">¥{{ money(remaining(paymentSettlement)) }}</el-descriptions-item>
      </el-descriptions>
      <el-form label-width="100px" class="payment-form">
        <el-form-item label="付款金额" required>
          <el-input-number v-model="paymentForm.amount" :min="0.01" :max="paymentRemaining" :precision="2" :step="100" controls-position="right" style="width: 100%" />
        </el-form-item>
        <el-form-item label="付款账户" required>
          <el-select v-model="paymentForm.accountId" placeholder="请选择付款账户" filterable style="width: 100%">
            <el-option v-for="account in accounts" :key="account.account_id" :label="accountLabel(account)" :value="account.account_id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="paymentVisible = false">取消</el-button>
        <el-button type="primary" :loading="paymentSubmitting" @click="submitPayment">确认付款</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'

const router = useRouter()
const data = ref([])
const total = ref(0)
const loading = ref(false)
const accounts = ref([])
const detailVisible = ref(false)
const detail = ref(null)
const paymentVisible = ref(false)
const paymentSettlement = ref(null)
const paymentSubmitting = ref(false)
const paymentForm = reactive({ accountId: '', amount: 0 })
const query = reactive({ page: 1, pageSize: 20, settlementType: 'supplier,expense,reimbursement', status: '', paymentStatus: '' })

const paymentRemaining = computed(() => Math.max(0, remaining(paymentSettlement.value)))

const money = value => Number(value || 0).toFixed(2)
const quantity = value => {
  const number = Number(value)
  if (!Number.isFinite(number)) return '-'
  return String(number).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
}
const dateTime = value => {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString('zh-CN', { hour12: false })
}
const remaining = row => Math.max(0, Number(row?.total_amount || 0) - Number(row?.paid_amount || 0))
const accountLabel = account => `${account.account_name || '-'}（余额：¥${money(account.balance)}）`
const statusText = status => ({ draft: '草稿', pending_approval: '待审批', confirmed: '待付款', voided: '已作废' }[status] || status || '-')
const statusType = status => ({ draft: 'info', pending_approval: 'warning', confirmed: 'success', voided: 'danger' }[status] || 'info')
const paymentStatusText = status => ({ unpaid: '未付款', partial_paid: '部分付款', paid: '已付款' }[status] || status || '-')
const paymentStatusType = status => ({ unpaid: 'info', partial_paid: 'warning', paid: 'success' }[status] || 'info')

const reload = () => {
  query.page = 1
  loadData()
}

const loadData = async () => {
  loading.value = true
  try {
    const res = await api.getSettlementList(query)
    if (res.code === 0) {
      data.value = res.data?.list || []
      total.value = res.data?.pagination?.total || res.data?.total || 0
    } else ElMessage.error(res.message || '加载结算单失败')
  } catch (error) {
    ElMessage.error(error.response?.data?.message || '加载结算单失败')
  } finally {
    loading.value = false
  }
}

const loadAccounts = async () => {
  try {
    const res = await api.getSettlementAccountsBalance({ page: 1, pageSize: 500 })
    if (res.code === 0) accounts.value = (res.data?.list || []).filter(item => item.account_type !== 'SUPPLIER_REBATE')
  } catch (error) {
    ElMessage.error(error.response?.data?.message || '加载付款账户失败')
  }
}

const openDetail = async row => {
  try {
    const res = await api.getSettlementDetail(row.settlement_id)
    if (res.code === 0) {
      detail.value = res.data
      detailVisible.value = true
    } else ElMessage.error(res.message || '加载详情失败')
  } catch (error) {
    ElMessage.error(error.response?.data?.message || '加载详情失败')
  }
}

const submit = async row => {
  try {
    await ElMessageBox.confirm(`确认提交结算单 ${row.settlement_no}？`, '提交结算单', { type: 'warning' })
    const res = await api.submitSettlement({ settlementId: row.settlement_id })
    if (res.code === 0) {
      ElMessage.success(res.message || '已提交审批')
      await loadData()
    } else ElMessage.error(res.message || '提交失败')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error.response?.data?.message || '提交失败')
  }
}

const deleteDraft = async row => {
  try {
    await ElMessageBox.confirm(`确认删除结算单草稿 ${row.settlement_no}？`, '删除草稿', { type: 'warning' })
    const res = await api.deleteSettlementDraft(row.settlement_id)
    if (res.code === 0) {
      ElMessage.success(res.message || '结算单草稿已删除')
      await loadData()
    } else ElMessage.error(res.message || '删除失败')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error.response?.data?.message || '删除失败')
  }
}

const approve = async row => {
  try {
    const result = await ElMessageBox.prompt('审批意见（可选）', '审批通过', { inputPlaceholder: '请输入审批意见' })
    const res = await api.confirmSettlement({ settlementId: row.settlement_id, comment: result.value || '' })
    if (res.code === 0) {
      ElMessage.success(res.message || '审批通过')
      await loadData()
    } else ElMessage.error(res.message || '审批失败')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error.response?.data?.message || '审批失败')
  }
}

const reject = async row => {
  try {
    const result = await ElMessageBox.prompt('请输入退回原因', '退回草稿', { inputPlaceholder: '退回原因', inputValidator: value => String(value || '').trim() ? true : '退回原因不能为空' })
    const res = await api.rejectSettlement({ settlementId: row.settlement_id, comment: result.value || '' })
    if (res.code === 0) {
      ElMessage.success(res.message || '已退回草稿')
      await loadData()
    } else ElMessage.error(res.message || '退回失败')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error.response?.data?.message || '退回失败')
  }
}

const openPayment = row => {
  paymentSettlement.value = row
  paymentForm.accountId = ''
  paymentForm.amount = Number(remaining(row).toFixed(2))
  paymentVisible.value = true
}

const submitPayment = async () => {
  const row = paymentSettlement.value
  const amount = Number(paymentForm.amount)
  if (!row) return
  if (!paymentForm.accountId) return ElMessage.warning('请选择付款账户')
  if (!Number.isFinite(amount) || amount <= 0 || amount > paymentRemaining.value) return ElMessage.warning('付款金额必须大于0且不能超过剩余应付')
  paymentSubmitting.value = true
  try {
    const res = await api.createDirectSettlementPayment({ settlementId: row.settlement_id, accountId: paymentForm.accountId, amount })
    if (res.code === 0) {
      ElMessage.success(res.message || '付款登记成功')
      paymentVisible.value = false
      await Promise.all([loadData(), loadAccounts()])
    } else ElMessage.error(res.message || '付款登记失败')
  } catch (error) {
    ElMessage.error(error.response?.data?.message || '付款登记失败')
  } finally {
    paymentSubmitting.value = false
  }
}

const voidSettlement = async row => {
  try {
    await ElMessageBox.confirm(`确认作废结算单 ${row.settlement_no}？`, '作废结算单', { type: 'warning' })
    const res = await api.voidSettlement({ settlementId: row.settlement_id })
    if (res.code === 0) {
      ElMessage.success(res.message || '已作废')
      await loadData()
    } else ElMessage.error(res.message || '作废失败')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error.response?.data?.message || '作废失败')
  }
}

onMounted(() => {
  loadData()
  loadAccounts()
})
</script>

<style scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.filter-bar {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}

.detail-table {
  margin-top: 20px;
}

.payment-form {
  margin-top: 20px;
}
</style>
