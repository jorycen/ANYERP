<template>
  <div class="reports-page">
    <el-card>
      <template #header>
        <span>报表统计</span>
      </template>

      <el-tabs v-model="activeTab">
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
const salesChartRef = ref(null)
const inventoryChartRef = ref(null)

const salesParams = reactive({ date: '', regionCode: '' })
const inventoryParams = reactive({ storeId: '' })

onMounted(() => {
  loadStores()
  loadSalesReport()
})

const loadStores = async () => {
  try {
    const res = await api.getStoreList()
    if (res.code === 0) stores.value = res.data || []
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

const handleExport = () => ElMessage.info('导出功能开发中')

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
</style>
