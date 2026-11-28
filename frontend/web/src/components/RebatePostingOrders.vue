<template>
  <div class="rebate-posting-orders">
    <div class="section-header">
      <strong>已上账返利</strong>
      <el-button type="primary" @click="openCreate">登记到账</el-button>
      <el-button type="success" :disabled="selectedPostingRows.length === 0" @click="openBatchLink">批量关联待下账返利</el-button>
      <el-date-picker
        v-model="query.dateRange"
        type="daterange"
        range-separator="至"
        start-placeholder="上账开始日期"
        end-placeholder="上账结束日期"
        value-format="YYYY-MM-DD"
        style="width: 250px"
      />
      <el-select v-model="query.supplierId" placeholder="供应商" clearable filterable style="width: 170px">
        <el-option v-for="item in suppliers" :key="item.supplier_id" :label="item.name" :value="item.supplier_id" />
      </el-select>
      <el-select v-model="query.status" placeholder="关联状态" clearable style="width: 145px">
        <el-option v-for="item in statusOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-input v-model="query.remark" placeholder="备注（模糊查询）" clearable style="width: 190px" @keyup.enter="search" />
      <el-button @click="search">查询</el-button>
      <el-button @click="resetQuery">重置</el-button>
    </div>

    <el-alert
      title="这里记录已上账返利。可在本页批量选择返利单并关联待下账返利池明细；关联仅勾稽两边金额，不重复增加返利余额。"
      type="info"
      :closable="false"
      show-icon
      class="page-alert"
    />

    <el-table :data="rows" border stripe v-loading="loading" empty-text="暂无已上账返利单" @selection-change="handlePostingSelectionChange">
      <el-table-column type="expand" width="45">
        <template #default="{ row }">
          <div class="allocation-detail">
            <div v-if="!row.Allocations?.length">暂无待下账返利关联记录</div>
            <el-table v-else :data="row.Allocations" size="small" border>
              <el-table-column label="待下账返利单号" min-width="180">
                <template #default="{ row: item }">{{ item.Settlement?.settlement_no || '-' }}</template>
              </el-table-column>
              <el-table-column label="关联金额" width="130" align="right">
                <template #default="{ row: item }">¥{{ money(item.amount) }}</template>
              </el-table-column>
              <el-table-column label="待下账状态" width="130">
                <template #default="{ row: item }">{{ settlementStatusText(item.Settlement?.status) }}</template>
              </el-table-column>
              <el-table-column label="关联时间" width="175">
                <template #default="{ row: item }">{{ formatDateTime(item.create_time) }}</template>
              </el-table-column>
              <el-table-column prop="create_user" label="关联人" width="110" />
              <el-table-column label="返利池备注" min-width="220">
                <template #default="{ row: item }">{{ item.Settlement?.remark || '-' }}</template>
              </el-table-column>
            </el-table>
          </div>
        </template>
      </el-table-column>
      <el-table-column type="selection" width="48" :selectable="isPostingSelectable" />
      <el-table-column prop="posting_no" label="已上账返利单号" min-width="190" fixed />
      <el-table-column prop="posting_date" label="上账日期" width="115" />
      <el-table-column prop="supplier_name" label="供应商" min-width="150" />
      <el-table-column label="到账金额" width="125" align="right">
        <template #default="{ row }">¥{{ money(row.amount) }}</template>
      </el-table-column>
      <el-table-column label="已关联金额" width="125" align="right">
        <template #default="{ row }">¥{{ money(row.matched_amount) }}</template>
      </el-table-column>
      <el-table-column label="剩余待关联" width="135" align="right">
        <template #default="{ row }">¥{{ money(row.remaining_amount) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="115">
        <template #default="{ row }">
          <el-tag :type="statusType(row.status)">{{ statusText(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="remark" label="厂商结算说明" min-width="220" show-overflow-tooltip />
      <el-table-column prop="create_user" label="创建人" width="105" />
      <el-table-column label="创建时间" width="170">
        <template #default="{ row }">{{ formatDateTime(row.create_time) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="160" fixed="right">
        <template #default="{ row }">
          <el-button v-if="isPostingSelectable(row)" link type="success" @click="openLinkForPosting(row)">去关联</el-button>
          <el-button
            v-if="row.status !== 'REVERSED' && Number(row.matched_amount || 0) === 0"
            link
            type="danger"
            @click="reverse(row)"
          >冲销</el-button>
          <span v-else-if="row.status === 'REVERSED'">已冲销</span>
          <span v-else-if="row.status !== 'REVERSED' && Number(row.matched_amount || 0) > 0">先撤销关联</span>
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

    <el-dialog v-model="linkVisible" title="选择待下账返利并关联" width="1050px">
      <el-alert
        :title="`已选 ${selectedPostingRows.length} 张已上账返利单，可关联余额 ¥${money(selectedPostingRemaining)}`"
        type="warning"
        :closable="false"
        show-icon
        class="page-alert"
      />
      <div class="link-filters">
        <el-select :model-value="linkSupplierId" disabled style="width:220px">
          <el-option v-for="item in suppliers" :key="item.supplier_id" :label="item.name" :value="item.supplier_id" />
        </el-select>
        <el-select v-model="linkQuery.resourceType" placeholder="返利类型" clearable style="width:180px">
          <el-option v-for="item in resourceOptions" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
        <el-date-picker v-model="linkQuery.dateRange" type="daterange" range-separator="至" start-placeholder="创建开始日期" end-placeholder="创建结束日期" value-format="YYYY-MM-DD" style="width:250px" />
        <el-input v-model="linkQuery.snCode" placeholder="SN（模糊查询）" clearable style="width:160px" @keyup.enter="loadLinkableSettlements" />
        <el-input v-model="linkQuery.remark" placeholder="备注（模糊查询）" clearable style="width:180px" @keyup.enter="loadLinkableSettlements" />
        <el-button type="primary" :loading="linkLoading" @click="loadLinkableSettlements">查询</el-button>
        <el-button @click="resetLinkQuery">重置</el-button>
      </div>
      <el-table :data="linkableSettlements" border stripe v-loading="linkLoading" max-height="480" @selection-change="handleSettlementSelectionChange">
        <el-table-column type="selection" width="48" :selectable="isSettlementSelectable" />
        <el-table-column prop="settlement_no" label="待下账返利单号" min-width="190" />
        <el-table-column label="创建时间" width="165"><template #default="{ row }">{{ formatDateTime(row.create_time) }}</template></el-table-column>
        <el-table-column label="类型" width="130"><template #default="{ row }">{{ row.ResourceCategory?.name || row.resource_type }}</template></el-table-column>
        <el-table-column prop="counterparty_name" label="供应商" min-width="145" />
        <el-table-column label="金额" width="115" align="right"><template #default="{ row }">¥{{ money(row.amount) }}</template></el-table-column>
        <el-table-column label="已关联" width="115" align="right"><template #default="{ row }">¥{{ money(row.matched_amount) }}</template></el-table-column>
        <el-table-column label="剩余待关联" width="125" align="right"><template #default="{ row }">¥{{ money(remainingSettlement(row)) }}</template></el-table-column>
        <el-table-column prop="remark" label="备注" min-width="200" show-overflow-tooltip />
      </el-table>
      <div class="link-summary">已选待下账返利余额：<strong>¥{{ money(selectedSettlementRemaining) }}</strong>；本次最多关联：<strong>¥{{ money(Math.min(selectedSettlementRemaining, selectedPostingRemaining)) }}</strong></div>
      <template #footer>
        <el-button @click="linkVisible = false">取消</el-button>
        <el-button type="primary" :loading="linkSaving" @click="submitSelectedAssociations">确认关联</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="createVisible" title="登记已上账返利" width="540px" @closed="resetForm">
      <el-form label-width="95px">
        <el-form-item label="到账日期" required>
          <el-date-picker v-model="form.postingDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item label="供应商" required>
          <el-select v-model="form.supplierId" filterable placeholder="请选择供应商" style="width: 100%">
            <el-option v-for="item in suppliers" :key="item.supplier_id" :label="item.name" :value="item.supplier_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="到账类型" required>
          <el-radio-group v-model="form.direction">
            <el-radio value="increase">增加（默认）</el-radio>
            <el-radio value="decrease">扣减</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="到账金额" required>
          <el-input-number v-model="form.amount" :min="0.01" :precision="2" :step="1000" style="width: 100%" />
        </el-form-item>
        <el-form-item label="厂商结算说明" required>
          <el-input
            v-model="form.remark"
            type="textarea"
            :rows="4"
            maxlength="512"
            show-word-limit
            placeholder="请填写活动名称、厂商承诺或返利依据"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="create">确认登记</el-button>
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
const createVisible = ref(false)
const linkVisible = ref(false)
const linkLoading = ref(false)
const linkSaving = ref(false)
const rows = ref([])
const total = ref(0)
const suppliers = ref([])
const resourceOptions = ref([])
const selectedPostingRows = ref([])
const linkableSettlements = ref([])
const selectedSettlementRows = ref([])
const linkQuery = reactive({ resourceType: '', dateRange: [], snCode: '', remark: '' })
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
const statusOptions = [
  { label: '待关联', value: 'UNMATCHED' },
  { label: '部分关联', value: 'PARTIALLY_MATCHED' },
  { label: '已关联', value: 'MATCHED' },
  { label: '已冲销', value: 'REVERSED' }
]
const query = reactive({
  page: 1,
  pageSize: 20,
  dateRange: [],
  supplierId: '',
  status: '',
  remark: ''
})
const form = reactive({ postingDate: today(), supplierId: '', direction: 'increase', amount: 0, remark: '' })
const linkSupplierId = computed(() => String(selectedPostingRows.value[0]?.supplier_id || ''))
const selectedPostingRemaining = computed(() => selectedPostingRows.value.reduce((sum, row) => sum + Math.max(0, Number(row.remaining_amount || 0)), 0))
const remainingSettlement = row => Math.max(0, Number(row?.amount || 0) - Number(row?.matched_amount || 0))
const selectedSettlementRemaining = computed(() => selectedSettlementRows.value.reduce((sum, row) => sum + remainingSettlement(row), 0))

const money = value => Number(value || 0).toFixed(2)
const formatDateTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-'
const statusText = value => statusOptions.find(item => item.value === value)?.label || value
const statusType = value => ({
  UNMATCHED: 'warning',
  PARTIALLY_MATCHED: 'primary',
  MATCHED: 'success',
  REVERSED: 'info'
}[value] || 'info')
const settlementStatusText = value => ({
  PENDING: '待关联',
  PARTIALLY_SETTLED: '部分关联',
  SETTLED: '已关联',
  CANCELLED: '已取消',
  REVERSED: '已冲销'
}[value] || value || '-')

const isPostingSelectable = row => Number(row?.amount || 0) > 0
  && Number(row?.remaining_amount || 0) > 0
  && ['UNMATCHED', 'PARTIALLY_MATCHED'].includes(row?.status)
const isSettlementSelectable = row => Number(row?.amount || 0) > 0
  && remainingSettlement(row) > 0
  && String(row?.counterparty_id || '') === linkSupplierId.value
  && ['PENDING', 'PARTIALLY_SETTLED'].includes(row?.status)

function handlePostingSelectionChange(selection) {
  selectedPostingRows.value = selection
}

function handleSettlementSelectionChange(selection) {
  selectedSettlementRows.value = selection
}

async function loadSuppliers() {
  const [res, categoryRes] = await Promise.all([
    api.getSupplierList({ page: 1, pageSize: 500 }),
    api.getResourceCategories({ activeOnly: 1 })
  ])
  suppliers.value = res.data?.list || res.data || []
  resourceOptions.value = (categoryRes.data || []).map(item => ({ label: item.name, value: item.category_code }))
}

function openLinkForPosting(row) {
  selectedPostingRows.value = [row]
  linkQuery.resourceType = ''
  linkQuery.dateRange = []
  linkQuery.snCode = ''
  linkQuery.remark = ''
  selectedSettlementRows.value = []
  linkableSettlements.value = []
  linkVisible.value = true
  loadLinkableSettlements()
}

function openBatchLink() {
  if (!selectedPostingRows.value.length) return ElMessage.warning('请先选择已上账返利单')
  const supplierIds = [...new Set(selectedPostingRows.value.map(row => String(row.supplier_id || '')))]
  if (supplierIds.length !== 1 || !supplierIds[0]) return ElMessage.warning('批量关联必须选择同一供应商的已上账返利单')
  linkQuery.resourceType = ''
  linkQuery.dateRange = []
  linkQuery.snCode = ''
  linkQuery.remark = ''
  selectedSettlementRows.value = []
  linkableSettlements.value = []
  linkVisible.value = true
  loadLinkableSettlements()
}

async function loadLinkableSettlements() {
  if (!linkSupplierId.value) return ElMessage.warning('所选已上账返利单缺少供应商')
  linkLoading.value = true
  try {
    const params = {
      supplierId: linkSupplierId.value,
      linkableOnly: 1,
      resourceType: linkQuery.resourceType,
      snCode: linkQuery.snCode,
      remark: linkQuery.remark,
      page: 1,
      pageSize: 500
    }
    if (linkQuery.dateRange?.length === 2) {
      params.startDate = linkQuery.dateRange[0]
      params.endDate = linkQuery.dateRange[1]
    }
    const res = await api.getResourceSettlements(params)
    linkableSettlements.value = res.data?.list || []
    selectedSettlementRows.value = []
  } catch (error) {
    ElMessage.error(error.response?.data?.message || '加载待下账返利失败')
  } finally {
    linkLoading.value = false
  }
}

function resetLinkQuery() {
  linkQuery.resourceType = ''
  linkQuery.dateRange = []
  linkQuery.snCode = ''
  linkQuery.remark = ''
  loadLinkableSettlements()
}

function buildAssociationItems() {
  const settlements = [...selectedSettlementRows.value]
    .sort((left, right) => new Date(left.create_time || 0) - new Date(right.create_time || 0))
    .map(row => ({ settlementId: row.settlement_id, remaining: Math.round(remainingSettlement(row) * 100), allocations: [] }))
  const postings = [...selectedPostingRows.value]
    .sort((left, right) => String(left.posting_date || '').localeCompare(String(right.posting_date || '')))
    .map(row => ({ postingId: row.posting_id, remaining: Math.round(Number(row.remaining_amount || 0) * 100) }))
  let postingIndex = 0
  for (const settlement of settlements) {
    while (settlement.remaining > 0 && postingIndex < postings.length) {
      const posting = postings[postingIndex]
      if (posting.remaining <= 0) {
        postingIndex += 1
        continue
      }
      const amount = Math.min(settlement.remaining, posting.remaining)
      settlement.allocations.push({ postingId: posting.postingId, amount: amount / 100 })
      settlement.remaining -= amount
      posting.remaining -= amount
    }
  }
  return settlements.filter(row => row.allocations.length).map(({ settlementId, allocations }) => ({ settlementId, allocations }))
}

async function submitSelectedAssociations() {
  if (!selectedSettlementRows.value.length) return ElMessage.warning('请至少选择一笔待下账返利')
  const items = buildAssociationItems()
  if (!items.length) return ElMessage.warning('已上账返利单没有可关联余额')
  linkSaving.value = true
  try {
    const res = await api.batchSettleRebateResources({ items })
    ElMessage.success(res.data?.message || res.message || '返利关联成功')
    linkVisible.value = false
    selectedPostingRows.value = []
    await load()
    emit('changed')
  } catch (error) {
    ElMessage.error(error.response?.data?.message || '返利关联失败')
  } finally {
    linkSaving.value = false
  }
}

async function load() {
  loading.value = true
  try {
    const params = {
      page: query.page,
      pageSize: query.pageSize,
      supplierId: query.supplierId,
      status: query.status,
      remark: query.remark
    }
    if (query.dateRange?.length === 2) {
      params.startDate = query.dateRange[0]
      params.endDate = query.dateRange[1]
    }
    const res = await api.getRebatePostingOrders(params)
    rows.value = res.data?.list || []
    total.value = res.data?.pagination?.total || res.data?.total || 0
  } catch (error) {
    ElMessage.error(error.response?.data?.message || '加载返利上账单失败')
  } finally {
    loading.value = false
  }
}

function search() {
  query.page = 1
  load()
}

function resetQuery() {
  Object.assign(query, { page: 1, dateRange: [], supplierId: '', status: '', remark: '' })
  load()
}

function resetForm() {
  Object.assign(form, { postingDate: today(), supplierId: '', direction: 'increase', amount: 0, remark: '' })
}

function openCreate() {
  resetForm()
  createVisible.value = true
}

async function create() {
  if (!form.postingDate) return ElMessage.warning('请选择上账日期')
  if (!form.supplierId) return ElMessage.warning('请选择供应商')
  if (Number(form.amount || 0) <= 0) return ElMessage.warning('请输入正确的上账金额')
  if (!String(form.remark || '').trim()) return ElMessage.warning('返利上账必须填写备注')
  saving.value = true
  try {
    const res = await api.addRebate(form)
    ElMessage.success(res.message || '返利到账记录已生效')
    createVisible.value = false
    await load()
    emit('changed')
  } catch (error) {
    ElMessage.error(error.response?.data?.message || '返利上账失败')
  } finally {
    saving.value = false
  }
}

async function reverse(row) {
  try {
    const { value } = await ElMessageBox.prompt(
      '冲销会扣回本单上账金额；如返利已用于采购，必须先完成采购退单。请输入冲销原因。',
      '冲销返利到账记录',
      { inputPattern: /\S+/, inputErrorMessage: '必须填写冲销原因', type: 'warning' }
    )
    await api.reverseRebatePostingOrder(row.posting_id, { reason: value })
    ElMessage.success('返利到账记录已冲销')
    await load()
    emit('changed')
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(error.response?.data?.message || '冲销失败')
  }
}

onMounted(async () => {
  try {
    await loadSuppliers()
  } catch (_) {
    ElMessage.error('加载供应商失败')
  }
  load()
})
</script>

<style scoped>
.rebate-posting-orders {
  margin-bottom: 22px;
}
.section-header {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.section-header strong {
  margin-right: 4px;
}
.page-alert {
  margin-bottom: 12px;
}
.link-filters {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.link-summary {
  margin-top: 12px;
  text-align: right;
  color: #606266;
}
.allocation-detail {
  padding: 8px 46px;
}
.el-pagination {
  margin-top: 12px;
  justify-content: flex-end;
}
</style>
