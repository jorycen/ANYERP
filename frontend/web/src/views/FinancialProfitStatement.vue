<template>
  <div class="page-container financial-profit-page">
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <div>
            <div class="title">财务利润表</div>
            <div class="subtitle">按销售单计算不含税销售收入、不含税存货成本和财务毛利</div>
          </div>
          <el-button type="success" :loading="exporting" @click="exportReport">导出 Excel</el-button>
        </div>
      </template>

      <el-alert
        :title="reportNote"
        type="warning"
        :closable="false"
        show-icon
        style="margin-bottom: 16px"
      />

      <div class="filters">
        <el-date-picker v-model="dateRange" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" />
        <el-select v-model="params.storeId" clearable filterable placeholder="选择门店" style="width: 180px">
          <el-option v-for="store in stores" :key="store.store_id || store.storeId" :label="store.name || store.store_name || store.storeName" :value="store.store_id || store.storeId" />
        </el-select>
        <el-input v-model="params.orderNo" clearable placeholder="销售单号" style="width: 210px" @keyup.enter="search" />
        <el-select v-model="params.status" clearable placeholder="口径状态" style="width: 140px">
          <el-option label="暂估" value="estimated" />
          <el-option label="待补成本" value="cost_pending" />
        </el-select>
        <el-button type="primary" @click="search">查询</el-button>
        <el-button @click="resetFilters">重置</el-button>
      </div>

      <div class="summary-grid">
        <div class="metric"><span>不含税销售收入</span><strong>¥{{ formatMoney(summary.netRevenue) }}</strong></div>
        <div class="metric"><span>不含税存货成本</span><strong>¥{{ formatMoney(summary.bookCost) }}</strong></div>
        <div class="metric primary"><span>财务毛利</span><strong>¥{{ formatMoney(summary.grossProfit) }}</strong></div>
        <div class="metric"><span>财务毛利率</span><strong>{{ Number(summary.grossMargin || 0).toFixed(2) }}%</strong></div>
        <div class="metric"><span>营业费用</span><strong>¥{{ formatMoney(summary.operatingExpense) }}</strong></div>
        <div class="metric warning"><span>门店经营利润</span><strong>¥{{ formatMoney(summary.operatingProfit) }}</strong></div>
      </div>

      <el-table :data="rows" border stripe v-loading="loading" show-overflow-tooltip>
        <el-table-column prop="businessDate" label="日期" width="110" />
        <el-table-column prop="orderNo" label="销售单号" min-width="190" />
        <el-table-column prop="storeName" label="门店" min-width="130" />
        <el-table-column prop="customerName" label="客户" min-width="110" />
        <el-table-column label="含税销售额" width="130" align="right"><template #default="{ row }">¥{{ formatMoney(row.grossRevenue) }}</template></el-table-column>
        <el-table-column label="不含税销售额" width="145" align="right"><template #default="{ row }">¥{{ formatMoney(row.netRevenue) }}</template></el-table-column>
        <el-table-column label="销项税额" width="115" align="right"><template #default="{ row }">¥{{ formatMoney(row.outputVat) }}</template></el-table-column>
        <el-table-column label="含税成本" width="120" align="right"><template #default="{ row }">¥{{ formatMoney(row.grossCost) }}</template></el-table-column>
        <el-table-column label="可抵扣进项税" width="135" align="right"><template #default="{ row }">¥{{ formatMoney(row.deductibleInputVat) }}</template></el-table-column>
        <el-table-column label="不含税存货成本" width="150" align="right"><template #default="{ row }">¥{{ formatMoney(row.bookCost) }}</template></el-table-column>
        <el-table-column label="财务毛利" width="125" align="right"><template #default="{ row }">{{ row.grossProfit === null ? '-' : `¥${formatMoney(row.grossProfit)}` }}</template></el-table-column>
        <el-table-column label="毛利率" width="100" align="right"><template #default="{ row }">{{ row.grossMargin === null ? '-' : `${Number(row.grossMargin).toFixed(2)}%` }}</template></el-table-column>
        <el-table-column label="状态" width="105" fixed="right">
          <template #default="{ row }"><el-tag :type="row.status === 'cost_pending' ? 'danger' : 'warning'">{{ row.status === 'cost_pending' ? '待补成本' : '暂估' }}</el-tag></template>
        </el-table-column>
      </el-table>

      <el-pagination v-model:current-page="params.page" v-model:page-size="params.pageSize" :total="total" :page-sizes="[20, 50, 100]" layout="total, sizes, prev, pager, next" @current-change="loadData" @size-change="loadData" />
    </el-card>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'

const current = new Date()
const localDate = new Date(current.getTime() - current.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
const monthStart = `${localDate.slice(0, 7)}-01`
const dateRange = ref([monthStart, localDate])
const loading = ref(false)
const exporting = ref(false)
const rows = ref([])
const stores = ref([])
const total = ref(0)
const reportNote = ref('当前为财务暂估口径，最终结果需结合发票勾选和月末结转确认。')
const summary = reactive({})
const params = reactive({ storeId: '', orderNo: '', status: '', page: 1, pageSize: 20 })

function requestParams(withPage = true) {
  return {
    startDate: dateRange.value?.[0],
    endDate: dateRange.value?.[1],
    storeId: params.storeId,
    orderNo: params.orderNo,
    status: params.status,
    ...(withPage ? { page: params.page, pageSize: params.pageSize } : {})
  }
}

function formatMoney(value) {
  return Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

async function loadData() {
  loading.value = true
  try {
    const res = await api.getFinancialProfitOrders(requestParams())
    rows.value = res.data?.items || []
    total.value = Number(res.data?.total || 0)
    Object.assign(summary, res.data?.summary || {})
    reportNote.value = res.data?.note || reportNote.value
  } catch (error) {
    ElMessage.error(error?.response?.data?.message || error.message || '加载失败')
  } finally {
    loading.value = false
  }
}

function search() {
  params.page = 1
  loadData()
}

function resetFilters() {
  dateRange.value = [monthStart, localDate]
  params.storeId = ''
  params.orderNo = ''
  params.status = ''
  search()
}

async function exportReport() {
  exporting.value = true
  try {
    await api.exportFinancialProfitOrders(requestParams(false))
    ElMessage.success('导出成功')
  } catch (error) {
    ElMessage.error(error?.response?.data?.message || error.message || '导出失败')
  } finally {
    exporting.value = false
  }
}

onMounted(async () => {
  try {
    const res = await api.getReadableStoreList()
    stores.value = res.data?.list || res.data || []
  } catch (_) {
    stores.value = []
  }
  loadData()
})
</script>

<style scoped>
.page-container { padding: 20px; }
.card-header { display: flex; align-items: center; justify-content: space-between; }
.title { font-size: 18px; font-weight: 600; }
.subtitle { margin-top: 4px; color: #909399; font-size: 13px; }
.filters { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; }
.summary-grid { display: grid; grid-template-columns: repeat(6, minmax(150px, 1fr)); gap: 12px; margin-bottom: 16px; }
.metric { padding: 14px; border: 1px solid #ebeef5; border-radius: 6px; background: #fafafa; }
.metric span { display: block; color: #909399; font-size: 13px; margin-bottom: 8px; }
.metric strong { font-size: 20px; color: #303133; }
.metric.primary strong { color: #409eff; }
.metric.warning strong { color: #e6a23c; }
.el-pagination { margin-top: 16px; justify-content: flex-end; }
@media (max-width: 1200px) { .summary-grid { grid-template-columns: repeat(3, minmax(150px, 1fr)); } }
</style>
