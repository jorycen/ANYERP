<template>
  <div class="rebate-posting-orders">
    <div class="section-header">
      <strong>返利上账单</strong>
      <el-button type="primary" @click="openCreate">返利上账</el-button>
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
      <el-select v-model="query.status" placeholder="核销状态" clearable style="width: 145px">
        <el-option v-for="item in statusOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-input v-model="query.remark" placeholder="备注（模糊查询）" clearable style="width: 190px" @keyup.enter="search" />
      <el-button @click="search">查询</el-button>
      <el-button @click="resetQuery">重置</el-button>
    </div>

    <el-alert
      title="返利上账单生效后立即增加供应商可用返利；返利下账仅关联核销，不会再次增加余额。"
      type="info"
      :closable="false"
      show-icon
      class="page-alert"
    />

    <el-table :data="rows" border stripe v-loading="loading" empty-text="暂无返利上账单">
      <el-table-column type="expand" width="45">
        <template #default="{ row }">
          <div class="allocation-detail">
            <div v-if="!row.Allocations?.length">暂无下账核销记录</div>
            <el-table v-else :data="row.Allocations" size="small" border>
              <el-table-column label="返利下账单号" min-width="180">
                <template #default="{ row: item }">{{ item.Settlement?.settlement_no || '-' }}</template>
              </el-table-column>
              <el-table-column label="核销金额" width="130" align="right">
                <template #default="{ row: item }">¥{{ money(item.amount) }}</template>
              </el-table-column>
              <el-table-column label="下账单状态" width="130">
                <template #default="{ row: item }">{{ settlementStatusText(item.Settlement?.status) }}</template>
              </el-table-column>
              <el-table-column label="核销时间" width="175">
                <template #default="{ row: item }">{{ formatDateTime(item.create_time) }}</template>
              </el-table-column>
              <el-table-column prop="create_user" label="核销人" width="110" />
              <el-table-column label="下账备注" min-width="220">
                <template #default="{ row: item }">{{ item.Settlement?.remark || '-' }}</template>
              </el-table-column>
            </el-table>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="posting_no" label="上账单号" min-width="190" fixed />
      <el-table-column prop="posting_date" label="上账日期" width="115" />
      <el-table-column prop="supplier_name" label="供应商" min-width="150" />
      <el-table-column label="上账金额" width="125" align="right">
        <template #default="{ row }">¥{{ money(row.amount) }}</template>
      </el-table-column>
      <el-table-column label="已核销" width="125" align="right">
        <template #default="{ row }">¥{{ money(row.matched_amount) }}</template>
      </el-table-column>
      <el-table-column label="剩余待核销" width="135" align="right">
        <template #default="{ row }">¥{{ money(row.remaining_amount) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="115">
        <template #default="{ row }">
          <el-tag :type="statusType(row.status)">{{ statusText(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="remark" label="活动/备注" min-width="220" show-overflow-tooltip />
      <el-table-column prop="create_user" label="创建人" width="105" />
      <el-table-column label="创建时间" width="170">
        <template #default="{ row }">{{ formatDateTime(row.create_time) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="105" fixed="right">
        <template #default="{ row }">
          <el-button
            v-if="row.status !== 'REVERSED' && Number(row.matched_amount || 0) === 0"
            link
            type="danger"
            @click="reverse(row)"
          >冲销</el-button>
          <span v-else-if="row.status === 'REVERSED'">已冲销</span>
          <span v-else>先撤销核销</span>
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

    <el-dialog v-model="createVisible" title="新增返利上账单" width="540px" @closed="resetForm">
      <el-form label-width="95px">
        <el-form-item label="上账日期" required>
          <el-date-picker v-model="form.postingDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item label="供应商" required>
          <el-select v-model="form.supplierId" filterable placeholder="请选择供应商" style="width: 100%">
            <el-option v-for="item in suppliers" :key="item.supplier_id" :label="item.name" :value="item.supplier_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="上账金额" required>
          <el-input-number v-model="form.amount" :min="0.01" :precision="2" :step="1000" style="width: 100%" />
        </el-form-item>
        <el-form-item label="活动/备注" required>
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
        <el-button type="primary" :loading="saving" @click="create">确认上账</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'

const emit = defineEmits(['changed'])
const loading = ref(false)
const saving = ref(false)
const createVisible = ref(false)
const rows = ref([])
const total = ref(0)
const suppliers = ref([])
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
const statusOptions = [
  { label: '待核销', value: 'UNMATCHED' },
  { label: '部分核销', value: 'PARTIALLY_MATCHED' },
  { label: '已核销', value: 'MATCHED' },
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
const form = reactive({ postingDate: today(), supplierId: '', amount: 0, remark: '' })

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
  PENDING: '待核销',
  PARTIALLY_SETTLED: '部分核销',
  SETTLED: '已核销',
  CANCELLED: '已取消',
  REVERSED: '已冲销'
}[value] || value || '-')

async function loadSuppliers() {
  const res = await api.getSupplierList({ page: 1, pageSize: 500 })
  suppliers.value = res.data?.list || res.data || []
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
  Object.assign(form, { postingDate: today(), supplierId: '', amount: 0, remark: '' })
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
    ElMessage.success(res.message || '返利上账单已生效')
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
      '冲销返利上账单',
      { inputPattern: /\S+/, inputErrorMessage: '必须填写冲销原因', type: 'warning' }
    )
    await api.reverseRebatePostingOrder(row.posting_id, { reason: value })
    ElMessage.success('返利上账单已冲销')
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
.allocation-detail {
  padding: 8px 46px;
}
.el-pagination {
  margin-top: 12px;
  justify-content: flex-end;
}
</style>
