<template>
  <div class="dashboard">
    <el-row :gutter="20" class="stat-cards">
      <el-col :span="6">
        <div class="stat-card">
          <div class="stat-icon sales">
            <el-icon><Sell /></el-icon>
          </div>
          <div class="stat-info">
            <p class="stat-label">今日销售额</p>
            <p class="stat-value">¥{{ stats.todaySales || 0 }}</p>
          </div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="stat-card">
          <div class="stat-icon orders">
            <el-icon><Document /></el-icon>
          </div>
          <div class="stat-info">
            <p class="stat-label">今日订单</p>
            <p class="stat-value">{{ stats.todayOrders || 0 }}</p>
          </div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="stat-card">
          <div class="stat-icon inventory">
            <el-icon><Box /></el-icon>
          </div>
          <div class="stat-info">
            <p class="stat-label">库存商品</p>
            <p class="stat-value">{{ stats.inventoryCount || 0 }}</p>
          </div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="stat-card">
          <div class="stat-icon purchase">
            <el-icon><ShoppingCart /></el-icon>
          </div>
          <div class="stat-info">
            <p class="stat-label">待采购</p>
            <p class="stat-value">{{ stats.pendingPurchase || 0 }}</p>
          </div>
        </div>
      </el-col>
    </el-row>

    <el-row :gutter="20" class="charts">
      <el-col :span="12">
        <el-card class="chart-card">
          <template #header>
            <span>销售趋势</span>
          </template>
          <div ref="salesChartRef" class="chart"></div>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card class="chart-card">
          <template #header>
            <span>库存预警</span>
          </template>
          <div ref="inventoryChartRef" class="chart"></div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="20" class="recent-orders">
      <el-col :span="24">
        <el-card>
          <template #header>
            <span>Recent Sales Orders</span>
          </template>
          <el-table :data="recentOrders" stripe>
            <el-table-column prop="order_no" label="订单号" width="180" />
            <el-table-column prop="create_time" label="时间" width="160" />
            <el-table-column prop="customer_name" label="客户" width="120" />
            <el-table-column prop="total_amount" label="金额" width="120">
              <template #default="{ row }">
                ¥{{ row.total_amount }}
              </template>
            </el-table-column>
            <el-table-column prop="order_status" label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="getStatusType(row.order_status)">
                  {{ row.order_status }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, onMounted, reactive } from 'vue'
import { ElMessage } from 'element-plus'
import { Sell, Document, Box, ShoppingCart } from '@element-plus/icons-vue'
import * as echarts from 'echarts'
import api from '../api'

const salesChartRef = ref(null)
const inventoryChartRef = ref(null)

const stats = reactive({
  todaySales: 0,
  todayOrders: 0,
  inventoryCount: 0,
  pendingPurchase: 0
})

const recentOrders = ref([])

onMounted(async () => {
  // Try to load dashboard data
  try {
    const [salesRes, inventoryRes] = await Promise.allSettled([
      api.getSalesReport({ date: new Date().toISOString().split('T')[0] }),
      api.getInventoryReport()
    ])

    if (salesRes.status === 'fulfilled' && salesRes.value.code === 0) {
      stats.todaySales = salesRes.value.data?.totalAmount || 0
      stats.todayOrders = salesRes.value.data?.orderCount || 0
    }

    if (inventoryRes.status === 'fulfilled' && inventoryRes.value.code === 0) {
      stats.inventoryCount = inventoryRes.value.data?.length || 0
    }
  } catch (err) {
    console.error('Failed to load dashboard data:', err)
  }

  // Load recent orders
  try {
    const res = await api.getSalesList({ page: 1, pageSize: 10 })
    if (res.code === 0) {
      recentOrders.value = res.data?.list || []
    }
  } catch (err) {
    console.error('Failed to load recent orders:', err)
  }

  // Init charts
  initSalesChart()
  initInventoryChart()
})

const initSalesChart = () => {
  if (!salesChartRef.value) return
  const chart = echarts.init(salesChartRef.value)
  const option = {
    tooltip: { trigger: 'axis' },
    legend: { data: ['销售额', '订单数'] },
    xAxis: {
      type: 'category',
      data: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    },
    yAxis: [
      { type: 'value', name: '销售额', axisLabel: { formatter: '¥{value}' } },
      { type: 'value', name: '订单数', axisLabel: '{value}' }
    ],
    series: [
      { name: '销售额', type: 'bar', data: [12000, 18000, 15000, 22000, 19000, 25000, 28000] },
      { name: '订单数', type: 'line', yAxisIndex: 1, data: [12, 18, 15, 22, 19, 25, 28] }
    ]
  }
  chart.setOption(option)
}

const initInventoryChart = () => {
  if (!inventoryChartRef.value) return
  const chart = echarts.init(inventoryChartRef.value)
  const option = {
    tooltip: { trigger: 'item' },
    legend: { bottom: 0 },
    series: [{
      type: 'pie',
      radius: ['40%', '70%'],
      data: [
        { value: 35, name: '正常' },
        { value: 25, name: '库存不足' },
        { value: 15, name: '积压' },
        { value: 10, name: '过期' }
      ]
    }]
  }
  chart.setOption(option)
}

const getStatusType = (status) => {
  const types = { completed: 'success', pending: 'warning', cancelled: 'danger' }
  return types[status] || 'info'
}
</script>

<style scoped>
.dashboard {
  padding: 0;
}

.stat-cards {
  margin-bottom: 20px;
}

.stat-card {
  display: flex;
  align-items: center;
  padding: 20px;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.05);
}

.stat-icon {
  width: 60px;
  height: 60px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: 16px;
  font-size: 24px;
  color: #fff;
}

.stat-icon.sales { background: linear-gradient(135deg, #667eea, #764ba2); }
.stat-icon.orders { background: linear-gradient(135deg, #f093fb, #f5576c); }
.stat-icon.inventory { background: linear-gradient(135deg, #4facfe, #00f2fe); }
.stat-icon.purchase { background: linear-gradient(135deg, #43e97b, #38f9d7); }

.stat-info {
  flex: 1;
}

.stat-label {
  color: #666;
  font-size: 14px;
  margin-bottom: 4px;
}

.stat-value {
  font-size: 24px;
  font-weight: 600;
  color: #333;
}

.charts {
  margin-bottom: 20px;
}

.chart-card {
  height: 350px;
}

.chart {
  height: 280px;
}

.recent-orders {
  margin-bottom: 20px;
}
</style>
