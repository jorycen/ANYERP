<template>
  <div class="rebate-settlement">
    <div class="filter-bar">
      <el-button type="primary" @click="openCreateDialog">新增待下账返利</el-button>
      <el-button type="success" :disabled="selectedRows.length === 0" @click="openBatchReconcile">批量核销</el-button>
      <el-date-picker
        v-model="query.dateRange"
        type="daterange"
        range-separator="至"
        start-placeholder="创建开始日期"
        end-placeholder="创建结束日期"
        value-format="YYYY-MM-DD"
        style="width: 250px"
      />
      <el-input v-model="query.snCode" placeholder="SN（模糊查询）" clearable style="width: 170px" @keyup.enter="search" />
      <el-input v-model="query.remark" placeholder="备注（模糊查询）" clearable style="width: 190px" @keyup.enter="search" />
      <el-select v-model="query.resourceType" placeholder="返利/资源类型" clearable style="width: 155px">
        <el-option v-for="item in resourceOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-select v-model="query.sourceType" placeholder="来源类型" clearable style="width: 140px">
        <el-option v-for="item in sourceOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-select v-model="query.status" placeholder="下账状态" clearable style="width: 130px">
        <el-option v-for="item in statusOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-select v-model="query.supplierId" placeholder="供应商" clearable filterable style="width: 170px">
        <el-option v-for="item in suppliers" :key="item.supplier_id" :label="item.name" :value="item.supplier_id" />
      </el-select>
      <el-button type="primary" @click="search">查询</el-button>
      <el-button @click="resetQuery">重置</el-button>
    </div>

    <el-alert
      title="返利必须先通过“返利上账单”形成可用额度；返利下账只负责关联核销，不会再次增加返利余额。"
      type="info"
      :closable="false"
      show-icon
      class="page-alert"
    />

    <el-table :data="rows" border stripe v-loading="loading" @selection-change="handleSelectionChange">
      <el-table-column
        type="selection"
        width="50"
        :selectable="isBatchSelectable"
      />
      <el-table-column prop="settlement_no" label="下账单号" min-width="185" fixed />
      <el-table-column label="创建时间" width="165">
        <template #default="{ row }">{{ formatDateTime(row.create_time) }}</template>
      </el-table-column>
      <el-table-column label="SN" min-width="145">
        <template #default="{ row }">{{ row.sn_code || '-' }}</template>
      </el-table-column>
      <el-table-column label="类型" width="130">
        <template #default="{ row }">{{ row.ResourceCategory?.name || resourceText(row.resource_type) }}</template>
      </el-table-column>
      <el-table-column label="来源" width="110">
        <template #default="{ row }">{{ sourceText(row.source_type) }}</template>
      </el-table-column>
      <el-table-column prop="counterparty_name" label="供应商" min-width="150" />
      <el-table-column label="金额" width="120" align="right">
        <template #default="{ row }">¥{{ money(row.amount) }}</template>
      </el-table-column>
      <el-table-column label="已核销" width="120" align="right">
        <template #default="{ row }">¥{{ money(row.matched_amount) }}</template>
      </el-table-column>
      <el-table-column label="剩余待核销" width="130" align="right">
        <template #default="{ row }">¥{{ money(remainingAmount(row)) }}</template>
      </el-table-column>
      <el-table-column label="关联上账单" min-width="200">
        <template #default="{ row }">
          {{ allocationPostingNos(row) || '-' }}
        </template>
      </el-table-column>
      <el-table-column prop="remark" label="备注" min-width="190" show-overflow-tooltip />
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="statusType(row.status)">{{ statusText(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="create_user" label="创建人" width="100" />
      <el-table-column prop="settled_by_name" label="下账人" width="100" />
      <el-table-column label="下账时间" width="165">
        <template #default="{ row }">{{ row.settled_at ? formatDateTime(row.settled_at) : '-' }}</template>
      </el-table-column>
      <el-table-column label="取消/冲销信息" min-width="190" show-overflow-tooltip>
        <template #default="{ row }">
          <span v-if="row.correction_reason">
            {{ row.cancelled_by_name || row.reversed_by_name || '-' }}：{{ row.correction_reason }}
          </span>
          <span v-else>-</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="145" fixed="right">
        <template #default="{ row }">
          <el-button
            v-if="['PENDING', 'PARTIALLY_SETTLED'].includes(row.status)"
            link
            type="success"
            @click="openReconcile(row)"
          >核销</el-button>
          <el-button
            v-if="row.status === 'PENDING' && row.source_type === 'MANUAL_REBATE'"
            link
            type="danger"
            @click="cancel(row)"
          >取消</el-button>
          <el-button
            v-if="['PARTIALLY_SETTLED', 'SETTLED'].includes(row.status)"
            link
            type="danger"
            @click="reverse(row)"
          >撤销核销</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      v-model:current-page="query.page"
      v-model:page-size="query.pageSize"
      :total="total"
      :page-sizes="[20, 50, 100]"
      layout="total, sizes, prev, pager, next"
      @size-change="load"
      @current-change="load"
    />

    <el-dialog v-model="createVisible" title="新增待下账返利" width="520px" @closed="resetForm">
      <el-form label-width="90px">
        <el-form-item label="返利类型">
          <el-input model-value="手工返利" disabled />
        </el-form-item>
        <el-form-item label="供应商" required>
          <el-select v-model="form.supplierId" filterable placeholder="请选择承诺返利的供应商" style="width: 100%">
            <el-option v-for="item in suppliers" :key="item.supplier_id" :label="item.name" :value="item.supplier_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="返利金额" required>
          <el-input-number v-model="form.amount" :min="0.01" :precision="2" :step="1000" style="width: 100%" />
        </el-form-item>
        <el-form-item label="备注" required>
          <el-input
            v-model="form.remark"
            type="textarea"
            :rows="4"
            maxlength="512"
            show-word-limit
            placeholder="请填写活动名称、厂商承诺或返利原因"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="createManualRebate">确认新增</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="reconcileVisible" :title="reconcileMode === 'batch' ? '批量关联返利上账单核销' : '关联返利上账单核销'" width="880px">
      <el-alert
        :title="reconcileMode === 'batch'
          ? `已选 ${selectedSettlements.length} 笔下账单，合计剩余待核销 ¥${money(selectedRemainingTotal)}`
          : `下账单 ${currentSettlement?.settlement_no || ''} 剩余待核销 ¥${money(currentRemaining)}`"
        type="warning"
        :closable="false"
        show-icon
        class="page-alert"
      />
      <el-table v-if="reconcileMode === 'batch'" :data="selectedSettlements" border stripe max-height="180" class="selected-settlements">
        <el-table-column prop="settlement_no" label="下账单号" min-width="190" />
        <el-table-column prop="counterparty_name" label="供应商" min-width="140" />
        <el-table-column label="剩余待核销" width="140" align="right">
          <template #default="{ row }">¥{{ money(remainingAmount(row)) }}</template>
        </el-table-column>
      </el-table>
      <el-table :data="postingOrders" border stripe max-height="430" empty-text="该供应商暂无可核销的返利上账单">
        <el-table-column prop="posting_no" label="上账单号" min-width="190" />
        <el-table-column prop="posting_date" label="上账日期" width="115" />
        <el-table-column prop="remark" label="活动/备注" min-width="210" show-overflow-tooltip />
        <el-table-column label="上账金额" width="120" align="right">
          <template #default="{ row }">¥{{ money(row.amount) }}</template>
        </el-table-column>
        <el-table-column label="剩余待核销" width="130" align="right">
          <template #default="{ row }">¥{{ money(row.remaining_amount) }}</template>
        </el-table-column>
        <el-table-column label="本次核销" width="165">
          <template #default="{ row }">
            <el-input-number
              v-model="row.allocationAmount"
              :min="0"
              :max="Math.min(Number(row.remaining_amount || 0), currentRemaining)"
              :precision="2"
              :step="100"
              controls-position="right"
              style="width: 145px"
            />
          </template>
        </el-table-column>
      </el-table>
      <div class="allocation-summary">
        本次核销合计：<strong>¥{{ money(allocationTotal) }}</strong>
        <span>{{ reconcileMode === 'batch' ? '核销后所选下账单合计剩余' : '核销后下账单剩余' }}：¥{{ money(Math.max(0, (reconcileMode === 'batch' ? selectedRemainingTotal : currentRemaining) - allocationTotal)) }}</span>
      </div>
      <template #footer>
        <el-button @click="reconcileVisible = false">取消</el-button>
        <el-button type="primary" :loading="reconciling" @click="submitReconciliation">确认核销</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'

const emit = defineEmits(['changed'])
const loading = ref(false)
const saving = ref(false)
const reconciling = ref(false)
const rows = ref([])
const total = ref(0)
const suppliers = ref([])
const resourceOptions = ref([])
const createVisible = ref(false)
const reconcileVisible = ref(false)
const reconcileMode = ref('single')
const currentSettlement = ref(null)
const selectedSettlements = ref([])
const selectedRows = ref([])
const postingOrders = ref([])

const sourceOptions = [
  { label: '手工新增', value: 'MANUAL_REBATE' },
  { label: '返利收款', value: 'REBATE_RECEIPT' },
  { label: '自动生成', value: 'MANUFACTURER_REBATE' },
  { label: '销售使用', value: 'SALE_USE' },
  { label: '公司套回', value: 'COMPANY_CLAIM' }
]
const statusOptions = [
  { label: '待核销', value: 'PENDING' },
  { label: '部分核销', value: 'PARTIALLY_SETTLED' },
  { label: '已核销', value: 'SETTLED' },
  { label: '已取消', value: 'CANCELLED' },
  { label: '已冲销', value: 'REVERSED' }
]
const query = reactive({
  page: 1,
  pageSize: 20,
  dateRange: [],
  snCode: '',
  remark: '',
  resourceType: '',
  sourceType: '',
  status: '',
  supplierId: ''
})
const form = reactive({ supplierId: '', amount: 0, remark: '' })

const money = value => Number(value || 0).toFixed(2)
const remainingAmount = row => Math.max(0, Number(row?.amount || 0) - Number(row?.matched_amount || 0))
const currentRemaining = computed(() => remainingAmount(currentSettlement.value))
const selectedRemainingTotal = computed(() => selectedSettlements.value.reduce((sum, row) => sum + remainingAmount(row), 0))
const allocationTotal = computed(() => postingOrders.value.reduce(
  (sum, row) => sum + Number(row.allocationAmount || 0),
  0
))
const allocationPostingNos = row => (row.Allocations || [])
  .map(item => item.PostingOrder?.posting_no)
  .filter(Boolean)
  .join('、')
const resourceText = value => resourceOptions.value.find(item => item.value === value)?.label || value
const sourceText = value => sourceOptions.find(item => item.value === value)?.label || value
const statusText = value => statusOptions.find(item => item.value === value)?.label || value
const statusType = value => ({
  PENDING: 'warning',
  PARTIALLY_SETTLED: 'primary',
  SETTLED: 'success',
  CANCELLED: 'info',
  REVERSED: 'danger'
}[value] || 'info')
const formatDateTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-'
const isBatchSelectable = row => ['PENDING', 'PARTIALLY_SETTLED'].includes(row.status)
  && Boolean(row.counterparty_id)
  && ['MANUAL_REBATE', 'MANUFACTURER_REBATE', 'REBATE_RECEIPT'].includes(row.source_type)

async function loadAuxiliary() {
  try {
    const [supplierRes, categoryRes] = await Promise.all([
      api.getSupplierList({ page: 1, pageSize: 500 }),
      api.getResourceCategories({ activeOnly: 1 })
    ])
    suppliers.value = supplierRes.data?.list || supplierRes.data || []
    resourceOptions.value = (categoryRes.data || []).map(item => ({
      label: item.name,
      value: item.category_code
    }))
  } catch (error) {
    ElMessage.error('加载返利基础资料失败')
  }
}

async function load() {
  loading.value = true
  try {
    const params = {
      page: query.page,
      pageSize: query.pageSize,
      snCode: query.snCode,
      remark: query.remark,
      resourceType: query.resourceType,
      sourceType: query.sourceType,
      status: query.status,
      supplierId: query.supplierId
    }
    if (query.dateRange?.length === 2) {
      params.startDate = query.dateRange[0]
      params.endDate = query.dateRange[1]
    }
    const res = await api.getResourceSettlements(params)
    rows.value = res.data?.list || []
    total.value = res.data?.pagination?.total || res.data?.total || 0
  } catch (error) {
    ElMessage.error(error.response?.data?.message || '加载返利下账清单失败')
  } finally {
    loading.value = false
  }
}

function search() {
  query.page = 1
  load()
}

function resetQuery() {
  Object.assign(query, {
    page: 1,
    dateRange: [],
    snCode: '',
    remark: '',
    resourceType: '',
    sourceType: '',
    status: '',
    supplierId: ''
  })
  load()
}

function resetForm() {
  Object.assign(form, { supplierId: '', amount: 0, remark: '' })
}

function handleSelectionChange(selection) {
  selectedRows.value = selection
}

function openCreateDialog() {
  resetForm()
  createVisible.value = true
}

async function createManualRebate() {
  if (!form.supplierId) return ElMessage.warning('请选择供应商')
  if (Number(form.amount || 0) <= 0) return ElMessage.warning('请输入正确的返利金额')
  if (!String(form.remark || '').trim()) return ElMessage.warning('手工返利必须填写备注')
  saving.value = true
  try {
    const res = await api.createManualRebateSettlement(form)
    ElMessage.success(res.data?.message || res.message || '待核销返利下账单已添加')
    createVisible.value = false
    search()
  } catch (error) {
    ElMessage.error(error.response?.data?.message || '新增待下账返利失败')
  } finally {
    saving.value = false
  }
}

async function openReconcile(row) {
  reconcileMode.value = 'single'
  currentSettlement.value = row
  selectedSettlements.value = [row]
  postingOrders.value = []
  try {
    const res = await api.getRebatePostingOrders({
      supplierId: row.counterparty_id,
      unmatchedOnly: 1,
      page: 1,
      pageSize: 500
    })
    postingOrders.value = (res.data?.list || []).map(item => ({ ...item, allocationAmount: 0 }))
    reconcileVisible.value = true
  } catch (error) {
    ElMessage.error(error.response?.data?.message || '加载可核销返利上账单失败')
  }
}

async function openBatchReconcile() {
  if (selectedRows.value.length === 0) return ElMessage.warning('请先选择待核销返利下账单')
  const supplierIds = [...new Set(selectedRows.value.map(row => String(row.counterparty_id || '')))]
  if (supplierIds.length !== 1 || !supplierIds[0]) return ElMessage.warning('批量核销必须选择同一供应商的返利下账单')
  if (selectedRows.value.some(row => !isBatchSelectable(row))) return ElMessage.warning('所选记录包含不可批量核销的下账单')
  reconcileMode.value = 'batch'
  currentSettlement.value = null
  selectedSettlements.value = [...selectedRows.value].sort((left, right) => new Date(left.create_time || 0) - new Date(right.create_time || 0))
  postingOrders.value = []
  try {
    const res = await api.getRebatePostingOrders({ supplierId: supplierIds[0], unmatchedOnly: 1, page: 1, pageSize: 500 })
    postingOrders.value = (res.data?.list || []).map(item => ({ ...item, allocationAmount: 0 }))
    reconcileVisible.value = true
  } catch (error) {
    ElMessage.error(error.response?.data?.message || '加载可核销返利上账单失败')
  }
}

async function submitReconciliation() {
  if (reconcileMode.value === 'batch') return submitBatchReconciliation()
  const allocations = postingOrders.value
    .filter(item => Number(item.allocationAmount || 0) > 0)
    .map(item => ({ postingId: item.posting_id, amount: Number(item.allocationAmount) }))
  if (allocations.length === 0) return ElMessage.warning('请至少填写一笔核销金额')
  if (allocationTotal.value > currentRemaining.value + 0.0001) {
    return ElMessage.warning('本次核销金额不能超过下账单剩余金额')
  }
  reconciling.value = true
  try {
    const res = await api.settleResource(currentSettlement.value.settlement_id, { allocations })
    ElMessage.success(res.data?.message || res.message || '返利核销成功')
    reconcileVisible.value = false
    await load()
    emit('changed')
  } catch (error) {
    ElMessage.error(error.response?.data?.message || '返利核销失败')
  } finally {
    reconciling.value = false
  }
}

function buildBatchItems() {
  const remainingBySettlement = selectedSettlements.value.map(row => ({
    settlementId: row.settlement_id,
    remainingCents: Math.round(remainingAmount(row) * 100),
    allocations: []
  }))
  const postingAllocations = postingOrders.value
    .map(row => ({ postingId: row.posting_id, remainingCents: Math.round(Number(row.allocationAmount || 0) * 100) }))
    .filter(row => row.remainingCents > 0)
  let settlementIndex = 0
  for (const posting of postingAllocations) {
    let postingRemaining = posting.remainingCents
    while (postingRemaining > 0 && settlementIndex < remainingBySettlement.length) {
      const settlement = remainingBySettlement[settlementIndex]
      if (settlement.remainingCents <= 0) {
        settlementIndex += 1
        continue
      }
      const amountCents = Math.min(postingRemaining, settlement.remainingCents)
      settlement.allocations.push({ postingId: posting.postingId, amount: amountCents / 100 })
      settlement.remainingCents -= amountCents
      postingRemaining -= amountCents
    }
  }
  return remainingBySettlement.filter(item => item.allocations.length > 0).map(item => ({
    settlementId: item.settlementId,
    allocations: item.allocations
  }))
}

async function submitBatchReconciliation() {
  if (allocationTotal.value <= 0) return ElMessage.warning('请至少填写一笔核销金额')
  if (allocationTotal.value > selectedRemainingTotal.value + 0.0001) return ElMessage.warning('本次核销金额不能超过所选下账单剩余金额')
  const items = buildBatchItems()
  if (items.length === 0) return ElMessage.warning('请至少填写一笔核销金额')
  reconciling.value = true
  try {
    const res = await api.batchSettleRebateResources({ items })
    ElMessage.success(res.data?.message || res.message || '批量返利核销成功')
    reconcileVisible.value = false
    selectedRows.value = []
    await load()
    emit('changed')
  } catch (error) {
    ElMessage.error(error.response?.data?.message || '批量返利核销失败')
  } finally {
    reconciling.value = false
  }
}

async function cancel(row) {
  try {
    const { value } = await ElMessageBox.prompt(
      '取消后该记录不再允许下账，请填写取消原因。',
      '取消待下账返利',
      { inputPattern: /\S+/, inputErrorMessage: '必须填写取消原因', type: 'warning' }
    )
    await api.cancelResourceSettlement(row.settlement_id, { reason: value })
    ElMessage.success('待下账返利已取消')
    load()
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(error.response?.data?.message || '取消失败')
  }
}

async function reverse(row) {
  try {
    const { value } = await ElMessageBox.prompt(
      '撤销后，本单全部有效核销金额将退回对应返利上账单，不影响供应商返利余额。请输入原因。',
      '撤销返利下账核销',
      { inputPattern: /\S+/, inputErrorMessage: '必须填写冲销原因', type: 'warning' }
    )
    await api.reverseResourceSettlement(row.settlement_id, { reason: value })
    ElMessage.success('返利下账核销已撤销')
    await load()
    emit('changed')
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(error.response?.data?.message || '撤销核销失败')
  }
}

onMounted(async () => {
  await loadAuxiliary()
  load()
})
</script>

<style scoped>
.filter-bar {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.page-alert {
  margin-bottom: 14px;
}
.allocation-summary {
  display: flex;
  justify-content: flex-end;
  gap: 24px;
  margin-top: 14px;
}
.selected-settlements {
  margin-bottom: 14px;
}
.el-pagination {
  margin-top: 14px;
  justify-content: flex-end;
}
</style>
