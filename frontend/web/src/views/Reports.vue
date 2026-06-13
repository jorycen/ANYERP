<template>
  <div class="reports-page">
    <el-card>
      <template #header>
        <span>报表统计</span>
      </template>

      <el-tabs v-model="activeTab" @tab-change="onTabChange">
        <el-tab-pane label="销售报表" name="sales">
          <div class="filter-bar">
            <el-date-picker v-model="salesParams.date" type="date" placeholder="选择日期" />
            <el-select v-model="salesParams.regionCode" placeholder="选择区域" clearable style="width: 150px">
              <el-option label="全部区域" value="" />
              <el-option label="成都" value="CD" />
              <el-option label="重庆" value="CQ" />
              <el-option label="地市" value="DS" />
            </el-select>
            <el-button type="primary" @click="loadSalesReport">查询</el-button>
            <el-button type="success" @click="handleExport">导出</el-button>
          </div>

          <el-table :data="salesData" stripe border show-summary>
            <el-table-column prop="date" label="日期" width="120" />
            <el-table-column prop="regionName" label="区域" width="100" />
            <el-table-column prop="orderCount" label="订单数" width="100" />
            <el-table-column prop="totalAmount" label="销售额" width="120">
              <template #default="{ row }">¥{{ row.totalAmount }}</template>
            </el-table-column>
            <el-table-column prop="nationalSubsidy" label="国补" width="120">
              <template #default="{ row }">¥{{ row.nationalSubsidy }}</template>
            </el-table-column>
            <el-table-column prop="educationSubsidy" label="教补" width="120">
              <template #default="{ row }">¥{{ row.educationSubsidy }}</template>
            </el-table-column>
          </el-table>

          <div class="chart-container">
            <div ref="salesChartRef" class="chart"></div>
          </div>
        </el-tab-pane>

        <el-tab-pane label="库存报表" name="inventory">
          <div class="filter-bar">
            <el-select v-model="inventoryParams.storeId" placeholder="选择门店" clearable>
              <el-option label="全部门店" value="" />
              <el-option v-for="store in stores" :key="store.store_id" :label="store.name" :value="store.store_id" />
            </el-select>
            <el-button type="primary" @click="loadInventoryReport">查询</el-button>
          </div>

          <el-table :data="inventoryData" stripe border>
            <el-table-column prop="productName" label="商品" min-width="150" />
            <el-table-column prop="category" label="分类" width="100" />
            <el-table-column prop="totalStock" label="总库存" width="100" />
            <el-table-column prop="inStockCount" label="在库" width="80" />
            <el-table-column prop="soldCount" label="已售" width="80" />
          </el-table>

          <div class="chart-container">
            <div ref="inventoryChartRef" class="chart"></div>
          </div>
        </el-tab-pane>

        <el-tab-pane label="员工业绩统计" name="employee">
          <div class="filter-bar">
            <el-date-picker
              v-model="employeeParams.dateRange"
              type="daterange"
              range-separator="至"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              value-format="YYYY-MM-DD"
            />
            <el-select v-model="employeeParams.storeId" placeholder="选择门店" clearable style="width: 150px">
              <el-option label="全部门店" value="" />
              <el-option v-for="store in stores" :key="store.store_id" :label="store.name" :value="store.store_id" />
            </el-select>
            <el-select v-model="employeeParams.staffName" placeholder="选择员工" clearable style="width: 150px">
              <el-option label="全部员工" value="" />
              <el-option v-for="name in employeeOptions" :key="name" :label="name" :value="name" />
            </el-select>
            <el-button type="primary" @click="loadEmployeePerformance">查询</el-button>
          </div>

          <div class="summary-row">
            <div class="summary-item">订单数：<strong>{{ employeeSummary.orderCount || 0 }}</strong></div>
            <div class="summary-item">销售额：<strong>¥{{ formatMoney(employeeSummary.totalAmount) }}</strong></div>
            <div class="summary-item">实收：<strong>¥{{ formatMoney(employeeSummary.actualPayment) }}</strong></div>
            <div class="summary-item">本页毛利：<strong>¥{{ formatMoney(employeeSummary.pageGrossProfit) }}</strong></div>
          </div>

          <el-table :data="employeeData" stripe border v-loading="employeeLoading">
            <el-table-column type="expand">
              <template #default="{ row }">
                <div class="profit-process">
                  <div class="process-line">{{ row.calculation?.revenueNote }}</div>
                  <div class="process-line">整单毛利：{{ row.calculation?.orderFormula }}</div>
                  <el-table :data="row.calculation?.items || []" size="small" border>
                    <el-table-column prop="productName" label="商品" min-width="180" />
                    <el-table-column prop="pnCode" label="PN" width="130" />
                    <el-table-column prop="snCode" label="SN" width="130" />
                    <el-table-column prop="quantity" label="数量" width="70" />
                    <el-table-column label="分摊后收入" width="110">
                      <template #default="{ row: item }">¥{{ formatMoney(item.allocatedRevenue) }}</template>
                    </el-table-column>
                    <el-table-column label="单位成本" width="100">
                      <template #default="{ row: item }">¥{{ formatMoney(item.unitCost) }}</template>
                    </el-table-column>
                    <el-table-column label="成本合计" width="100">
                      <template #default="{ row: item }">¥{{ formatMoney(item.costAmount) }}</template>
                    </el-table-column>
                    <el-table-column prop="formula" label="毛利计算" min-width="180" />
                  </el-table>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="orderNo" label="订单号" width="170" />
            <el-table-column prop="orderTime" label="时间" width="160">
              <template #default="{ row }">{{ formatDateTime(row.orderTime) }}</template>
            </el-table-column>
            <el-table-column prop="employeeName" label="员工" width="100" />
            <el-table-column prop="storeName" label="门店" width="120" />
            <el-table-column prop="customerName" label="客户" width="100" />
            <el-table-column label="实收" width="100">
              <template #default="{ row }">¥{{ formatMoney(row.actualPayment) }}</template>
            </el-table-column>
            <el-table-column label="成本" width="100">
              <template #default="{ row }">¥{{ formatMoney(row.totalCost) }}</template>
            </el-table-column>
            <el-table-column label="毛利" width="100">
              <template #default="{ row }">
                <span :class="row.grossProfit >= 0 ? 'profit-positive' : 'profit-negative'">¥{{ formatMoney(row.grossProfit) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="毛利率" width="90">
              <template #default="{ row }">{{ row.grossRate }}%</template>
            </el-table-column>
          </el-table>

          <el-pagination
            v-model:current-page="employeeParams.page"
            v-model:page-size="employeeParams.pageSize"
            :total="employeeTotal"
            :page-sizes="[10, 20, 50]"
            layout="total, sizes, prev, pager, next"
            @size-change="loadEmployeePerformance"
            @current-change="loadEmployeePerformance"
          />
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import * as echarts from 'echarts'
import api from '../api'

const activeTab = ref('sales')
const stores = ref([])
const salesData = ref([])
const inventoryData = ref([])
const employeeData = ref([])
const employeeOptions = ref([])
const employeeSummary = ref({})
const employeeTotal = ref(0)
const employeeLoading = ref(false)
const salesChartRef = ref(null)
const inventoryChartRef = ref(null)

const salesParams = reactive({ date: '', regionCode: '' })
const inventoryParams = reactive({ storeId: '' })
const employeeParams = reactive({ dateRange: [], storeId: '', staffName: '', page: 1, pageSize: 20 })

onMounted(() => {
  loadStores()
  loadSalesReport()
})

const onTabChange = (tabName) => {
  if (tabName === 'inventory' && inventoryData.value.length === 0) {
    loadInventoryReport()
  }
  if (tabName === 'employee' && employeeData.value.length === 0) {
    loadEmployeePerformance()
  }
}

const loadStores = async () => {
  try {
    const res = await api.getStoreList()
    if (res.code === 0) stores.value = (res.data || []).filter(s => s.store_id != null)
  } catch (err) { console.error(err) }
}

const loadSalesReport = async () => {
  try {
    const res = await api.getSalesReport(salesParams)
    if (res.code === 0) {
      salesData.value = res.data?.list || []
      initSalesChart()
    }
  } catch (err) { ElMessage.error('加载失败') }
}

const loadInventoryReport = async () => {
  try {
    const res = await api.getInventoryReport(inventoryParams)
    if (res.code === 0) {
      inventoryData.value = res.data || []
      initInventoryChart()
    }
  } catch (err) { ElMessage.error('加载失败') }
}

const loadEmployeePerformance = async () => {
  employeeLoading.value = true
  try {
    const params = {
      storeId: employeeParams.storeId,
      staffName: employeeParams.staffName,
      page: employeeParams.page,
      pageSize: employeeParams.pageSize
    }
    if (employeeParams.dateRange && employeeParams.dateRange.length === 2) {
      params.startDate = employeeParams.dateRange[0]
      params.endDate = employeeParams.dateRange[1]
    }
    const res = await api.getEmployeePerformanceReport(params)
    if (res.code === 0) {
      employeeData.value = res.data?.list || []
      employeeSummary.value = res.data?.summary || {}
      employeeOptions.value = res.data?.employees || []
      employeeTotal.value = res.data?.pagination?.total || 0
    }
  } catch (err) {
    ElMessage.error('加载员工业绩失败')
  } finally {
    employeeLoading.value = false
  }
}

const handleExport = () => ElMessage.info('导出功能开发中')

const formatMoney = (value) => Number(value || 0).toFixed(2)

const formatDateTime = (value) => {
  if (!value) return '-'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

const initSalesChart = () => {
  if (!salesChartRef.value) return
  const chart = echarts.init(salesChartRef.value)
  chart.setOption({
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: salesData.value.map(d => d.date) },
    yAxis: [{ type: 'value', name: '销售额' } ],
    series: [{ type: 'bar', data: salesData.value.map(d => d.totalAmount) }]
  })
}

const initInventoryChart = () => {
  if (!inventoryChartRef.value) return
  const chart = echarts.init(inventoryChartRef.value)
  chart.setOption({
    tooltip: { trigger: 'item' },
    series: [{ type: 'pie', radius: '60%', data: [
      { value: 35, name: '正常' },
      { value: 25, name: '库存不足' },
      { value: 15, name: '积压' }
    ]}]
  })
}
</script>

<style scoped>
.filter-bar {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}
.chart-container {
  margin-top: 20px;
}
.chart {
  height: 300px;
}
.summary-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 16px;
}
.summary-item {
  padding: 10px 14px;
  border: 1px solid #e4e7ed;
  border-radius: 4px;
  background: #fafafa;
}
.profit-process {
  padding: 8px 12px;
  background: #fafafa;
}
.process-line {
  margin-bottom: 8px;
  color: #606266;
}
.profit-positive {
  color: #67c23a;
  font-weight: 600;
}
.profit-negative {
  color: #f56c6c;
  font-weight: 600;
}
</style>
