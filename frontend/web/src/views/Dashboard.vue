<template>
  <div class="dashboard-page">
    <section class="welcome-panel">
      <div>
        <p class="welcome-eyebrow">经营工作台</p>
        <h2>{{ greeting }}，{{ userName }}</h2>
        <p>今天是 {{ todayText }}，这里是当前账号可查看的经营概况。</p>
      </div>
      <div class="welcome-badge"><el-icon><DataAnalysis /></el-icon><span>数据实时更新</span></div>
    </section>

    <section class="metric-grid">
      <article v-for="metric in metrics" :key="metric.label" class="metric-card">
        <div class="metric-icon" :class="metric.tone"><el-icon><component :is="metric.icon" /></el-icon></div>
        <div class="metric-content"><span>{{ metric.label }}</span><strong>{{ metric.value }}</strong><small>{{ metric.note }}</small></div>
      </article>
    </section>

    <section class="content-card">
      <header class="section-header">
        <div><h3>最近销售订单</h3><p>快速查看最近提交的销售记录</p></div>
        <el-button v-if="canOpenSales" type="primary" plain @click="$router.push('/sales/order')">查看全部</el-button>
      </header>
      <el-table v-loading="loading" :data="recentOrders" stripe>
        <el-table-column prop="order_no" label="订单号" min-width="190" />
        <el-table-column prop="create_time" label="提交时间" width="180"><template #default="{ row }">{{ formatDateTime(row.create_time) }}</template></el-table-column>
        <el-table-column prop="customer_name" label="客户" min-width="130"><template #default="{ row }">{{ row.customer_name || '-' }}</template></el-table-column>
        <el-table-column prop="total_amount" label="订单金额" width="140" align="right"><template #default="{ row }"><strong class="money">{{ money(row.total_amount) }}</strong></template></el-table-column>
        <el-table-column prop="order_status" label="状态" width="120"><template #default="{ row }"><el-tag :type="statusType(row.order_status)" effect="light">{{ statusText(row.order_status) }}</el-tag></template></el-table-column>
        <template #empty><el-empty description="暂无最近销售订单" :image-size="72" /></template>
      </el-table>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { Box, DataAnalysis, Money, Tickets, Timer } from '@element-plus/icons-vue'
import api from '../api'

const loading = ref(false)
const recentOrders = ref([])
const userInfo = JSON.parse(localStorage.getItem('userInfo') || '{}')
const userName = computed(() => userInfo.name || '伙伴')
function menusContainPath(menus, prefix) { return (menus || []).some(menu => String(menu.path || '').startsWith(prefix) || menusContainPath(menu.children, prefix)) }
const canOpenSales = computed(() => menusContainPath(userInfo.menus, '/sales'))
const stats = reactive({ todaySales: 0, todayOrders: 0, inventoryCount: 0 })
const now = new Date()
const greeting = computed(() => now.getHours() < 12 ? '上午好' : now.getHours() < 18 ? '下午好' : '晚上好')
const todayText = computed(() => new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(now))
const metrics = computed(() => [
  { label: '今日销售额', value: money(stats.todaySales), note: '按当前数据权限统计', icon: Money, tone: 'blue' },
  { label: '今日订单', value: number(stats.todayOrders), note: '今日销售订单数量', icon: Tickets, tone: 'violet' },
  { label: '库存商品', value: number(stats.inventoryCount), note: '当前可查询商品记录', icon: Box, tone: 'green' },
  { label: '最近记录', value: number(recentOrders.value.length), note: '首页展示的订单数量', icon: Timer, tone: 'orange' }
])

function money(value) { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2 }).format(Number(value || 0)) }
function number(value) { return new Intl.NumberFormat('zh-CN').format(Number(value || 0)) }
function formatDateTime(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-' }
function statusText(status) { return ({ completed: '已完成', archived: '已归档', '已归档': '已归档', cancelled: '已取消', pending: '待处理', draft: '草稿' })[status] || status || '-' }
function statusType(status) { return ({ completed: 'success', archived: 'success', '已归档': 'success', cancelled: 'danger', pending: 'warning', draft: 'info' })[status] || 'info' }

onMounted(async () => {
  loading.value = true
  try {
    const [salesResult, inventoryResult, ordersResult] = await Promise.allSettled([
      api.getSalesReport({ date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now) }),
      api.getInventoryReport(),
      api.getSalesList({ page: 1, pageSize: 8 })
    ])
    if (salesResult.status === 'fulfilled' && salesResult.value.code === 0) {
      stats.todaySales = salesResult.value.data?.totalAmount || 0
      stats.todayOrders = salesResult.value.data?.orderCount || 0
    }
    if (inventoryResult.status === 'fulfilled' && inventoryResult.value.code === 0) {
      const inventoryData = inventoryResult.value.data
      stats.inventoryCount = Array.isArray(inventoryData) ? inventoryData.length : Number(inventoryData?.total || inventoryData?.count || 0)
    }
    if (ordersResult.status === 'fulfilled' && ordersResult.value.code === 0) recentOrders.value = ordersResult.value.data?.list || ordersResult.value.data || []
  } finally { loading.value = false }
})
</script>

<style scoped>
.dashboard-page { display: flex; flex-direction: column; gap: 18px; }
.welcome-panel { position: relative; display: flex; min-height: 142px; align-items: center; justify-content: space-between; overflow: hidden; padding: 28px 32px; border-radius: 12px; color: #fff; background: linear-gradient(120deg, #172554 0%, #1e3a8a 58%, #2563eb 100%); box-shadow: 0 8px 20px rgba(30, 58, 138, .13); }
.welcome-panel::after { position: absolute; right: -60px; top: -100px; width: 300px; height: 300px; border: 1px solid rgba(255,255,255,.14); border-radius: 50%; content: ''; }
.welcome-eyebrow { margin-bottom: 7px; color: #bfdbfe; font-size: 12px; font-weight: 600; letter-spacing: .12em; }
.welcome-panel h2 { margin: 0; font-size: 25px; font-weight: 650; letter-spacing: -.02em; }
.welcome-panel p:last-child { margin-top: 9px; color: #dbeafe; font-size: 13px; }
.welcome-badge { position: relative; z-index: 1; display: flex; align-items: center; gap: 8px; padding: 9px 13px; border: 1px solid rgba(255,255,255,.16); border-radius: 999px; background: rgba(255,255,255,.08); font-size: 12px; }
.metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
.metric-card { display: flex; min-height: 118px; align-items: center; gap: 16px; padding: 20px; border: 1px solid var(--erp-border-soft); border-radius: 11px; background: #fff; box-shadow: var(--erp-shadow); }
.metric-icon { display: flex; flex: 0 0 46px; width: 46px; height: 46px; align-items: center; justify-content: center; border-radius: 10px; font-size: 21px; }
.metric-icon.blue { color: #2563eb; background: #eff6ff; }.metric-icon.violet { color: #7c3aed; background: #f5f3ff; }.metric-icon.green { color: #079455; background: #ecfdf3; }.metric-icon.orange { color: #dc6803; background: #fff7ed; }
.metric-content { display: flex; min-width: 0; flex-direction: column; }.metric-content > span { color: #667085; font-size: 12px; }.metric-content strong { margin-top: 4px; overflow: hidden; color: #182230; font-size: 22px; font-weight: 680; letter-spacing: -.02em; text-overflow: ellipsis; white-space: nowrap; }.metric-content small { margin-top: 5px; color: #98a2b3; font-size: 10px; }
.content-card { padding: 0 20px 20px; border: 1px solid var(--erp-border-soft); border-radius: 11px; background: #fff; box-shadow: var(--erp-shadow); }
.section-header { display: flex; min-height: 70px; align-items: center; justify-content: space-between; gap: 20px; }.section-header h3 { margin: 0; color: #182230; font-size: 16px; font-weight: 650; }.section-header p { margin-top: 4px; color: #98a2b3; font-size: 11px; }.money { color: #344054; font-weight: 650; }
@media (max-width: 1320px) { .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
