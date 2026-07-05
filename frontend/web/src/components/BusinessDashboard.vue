<template>
  <div class="bi-dashboard" v-loading="loading">
    <div class="page-heading">
      <div>
        <div class="breadcrumb">ERP&nbsp;&nbsp;/&nbsp;&nbsp;数据看板</div>
        <h1>经营数据看板 <span>（结果层）</span></h1>
      </div>
      <div class="scope-note">
        <el-icon><InfoFilled /></el-icon>
        仅展示经营结果数据：排名、趋势、结构、同比、环比
      </div>
    </div>

    <section class="filter-panel">
      <el-date-picker
        ref="datePickerRef"
        v-model="dateRange"
        type="daterange"
        value-format="YYYY-MM-DD"
        range-separator="~"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
        :clearable="false"
        class="date-filter"
      />
      <label>门店：</label>
      <el-select v-model="filters.storeId" placeholder="全部门店" clearable>
        <el-option label="全部门店" value="" />
        <el-option
          v-for="store in filterOptions.stores"
          :key="store.storeId"
          :label="store.name"
          :value="store.storeId"
        />
      </el-select>
      <label>员工：</label>
      <el-select v-model="filters.employeeId" placeholder="全部员工" clearable filterable>
        <el-option label="全部员工" value="" />
        <el-option
          v-for="employee in filterOptions.employees"
          :key="employee.staffId"
          :label="employee.name"
          :value="String(employee.staffId)"
        />
      </el-select>
      <label>产品线：</label>
      <el-select v-model="filters.productLine" placeholder="全部产品线" clearable>
        <el-option label="全部产品线" value="" />
        <el-option
          v-for="line in filterOptions.productLines"
          :key="line"
          :label="line"
          :value="line"
        />
      </el-select>
      <div class="quick-actions">
        <el-button :type="quickRange === 'today' ? 'primary' : 'default'" @click="setQuickRange('today')">今日</el-button>
        <el-button :type="quickRange === 'week' ? 'primary' : 'default'" @click="setQuickRange('week')">本周</el-button>
        <el-button :type="quickRange === 'month' ? 'primary' : 'default'" @click="setQuickRange('month')">本月</el-button>
        <el-button @click="openCustomRange">自定义</el-button>
        <el-button type="primary" @click="loadOverview">查询</el-button>
      </div>
    </section>

    <div class="dimension-tabs">
      <button
        v-for="tab in dimensionTabs"
        :key="tab.value"
        :class="{ active: activeDimension === tab.value }"
        @click="activeDimension = tab.value"
      >
        {{ tab.label }}
      </button>
    </div>

    <el-alert
      v-if="errorMessage"
      :title="errorMessage"
      type="error"
      show-icon
      :closable="false"
      class="error-alert"
    />

    <section v-if="dashboard.kpis" class="kpi-grid">
      <article v-for="card in kpiCards" :key="card.key" class="kpi-card">
        <div class="kpi-icon" :class="card.color">
          <el-icon><component :is="card.icon" /></el-icon>
        </div>
        <div class="kpi-content">
          <div class="kpi-label">{{ card.label }}</div>
          <div class="kpi-value" :class="{ unavailable: card.value === null }">
            {{ card.value === null ? '无权限' : formatMetric(card) }}
          </div>
          <div class="comparison-row">
            <span>同比</span>
            <ComparisonValue :value="card.yoy" />
            <span>环比</span>
            <ComparisonValue :value="card.periodCompare" />
          </div>
          <div v-if="card.reason" class="unavailable-reason">{{ card.reason }}</div>
        </div>
      </article>
    </section>

    <section v-show="showSection('trend')" class="chart-grid">
      <DashboardPanel title="销售额趋势（按日/周/月）">
        <template #actions>
          <el-radio-group v-model="filters.granularity" size="small" @change="loadOverview">
            <el-radio-button label="day">日</el-radio-button>
            <el-radio-button label="week">周</el-radio-button>
            <el-radio-button label="month">月</el-radio-button>
          </el-radio-group>
        </template>
        <div ref="salesTrendRef" class="large-chart"></div>
      </DashboardPanel>
      <DashboardPanel title="毛利趋势（按日/周/月）">
        <template #actions>
          <span v-if="!dashboard.meta.canViewProfit" class="permission-tip">当前角色无毛利查看权限</span>
        </template>
        <div ref="profitTrendRef" class="large-chart"></div>
      </DashboardPanel>
    </section>

    <section v-show="showSection('store') || showSection('employee') || showSection('productLine')" class="analysis-grid">
      <DashboardPanel v-show="showSection('store')" title="门店销售 / 毛利排名">
        <div ref="storeRankingRef" class="medium-chart"></div>
      </DashboardPanel>

      <DashboardPanel v-show="showSection('employee')" title="员工业绩排名（已按参与人数拆分）">
        <el-table :data="dashboard.employeeRanking" size="small" height="260">
          <el-table-column type="index" label="排名" width="56" />
          <el-table-column prop="employeeName" label="员工" min-width="100" />
          <el-table-column prop="participatedOrderCount" label="参与单量" width="84" align="right" />
          <el-table-column label="销售额" min-width="110" align="right">
            <template #default="{ row }">{{ formatCurrency(row.salesAmount) }}</template>
          </el-table-column>
          <el-table-column v-if="dashboard.meta.canViewProfit" label="业绩毛利" min-width="110" align="right">
            <template #default="{ row }">{{ formatCurrency(row.grossProfit) }}</template>
          </el-table-column>
        </el-table>
      </DashboardPanel>

      <DashboardPanel v-show="showSection('productLine')" title="产品线销售占比">
        <div ref="productLineRef" class="medium-chart"></div>
      </DashboardPanel>
    </section>

    <section v-show="showSection('product')" class="product-grid">
      <DashboardPanel title="产品销售额 Top10">
        <ProductTable
          :rows="dashboard.productAnalysis.salesTop10"
          value-key="salesAmount"
          value-label="销售额"
          variant="sales"
        />
      </DashboardPanel>
      <DashboardPanel title="高毛利产品排行榜">
        <ProductTable
          :rows="dashboard.productAnalysis.highMarginTop10"
          value-key="grossMargin"
          value-label="毛利率"
          value-type="percent"
          variant="profit"
        />
      </DashboardPanel>
      <DashboardPanel title="重点产品销售情况">
        <ProductTable
          :rows="dashboard.productAnalysis.focusProducts"
          value-key="salesAmount"
          value-label="销售额"
          variant="focus"
        />
      </DashboardPanel>
    </section>

    <section v-show="activeDimension === 'overall'" class="inventory-grid">
      <DashboardPanel title="库存总览">
        <div class="inventory-summary">
          <div>
            <span>库存数量</span>
            <strong>{{ formatNumber(dashboard.inventory.inventoryQuantity) }}</strong>
          </div>
          <div>
            <span>SKU数量</span>
            <strong>{{ formatNumber(dashboard.inventory.skuCount) }}</strong>
          </div>
          <div>
            <span>库存金额</span>
            <strong>{{ dashboard.meta.canViewProfit ? formatCurrency(dashboard.inventory.inventoryAmount) : '无权限' }}</strong>
          </div>
          <div>
            <span>库龄口径</span>
            <strong class="small-strong">SN库存</strong>
          </div>
        </div>
      </DashboardPanel>
      <DashboardPanel title="库存库龄结构">
        <div ref="inventoryAgeRef" class="inventory-chart"></div>
      </DashboardPanel>
      <DashboardPanel title="滞销 / 高库龄库存">
        <el-table :data="dashboard.inventory.staleProducts" size="small" height="190">
          <el-table-column prop="productName" label="产品" min-width="140" />
          <el-table-column prop="quantity" label="库存" width="65" align="right" />
          <el-table-column prop="inventoryAgeDays" label="库龄" width="75" align="right">
            <template #default="{ row }">{{ row.inventoryAgeDays === null ? '待补数据' : `${row.inventoryAgeDays}天` }}</template>
          </el-table-column>
          <el-table-column v-if="dashboard.meta.canViewProfit" label="库存金额" width="105" align="right">
            <template #default="{ row }">{{ formatCurrency(row.inventoryAmount) }}</template>
          </el-table-column>
        </el-table>
      </DashboardPanel>
    </section>
  </div>
</template>

<script setup>
import {
  computed,
  defineComponent,
  h,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch
} from 'vue'
import { ElMessage } from 'element-plus'
import {
  Box,
  Coin,
  DataAnalysis,
  Document,
  InfoFilled,
  Money,
  UserFilled
} from '@element-plus/icons-vue'
import * as echarts from 'echarts'
import api from '../api'

const DashboardPanel = defineComponent({
  name: 'DashboardPanel',
  props: { title: { type: String, required: true } },
  setup(props, { slots }) {
    return () => h('article', { class: 'dashboard-panel' }, [
      h('header', { class: 'panel-header' }, [
        h('h3', props.title),
        slots.actions ? h('div', { class: 'panel-actions' }, slots.actions()) : null
      ]),
      h('div', { class: 'panel-body' }, slots.default?.())
    ])
  }
})

const ComparisonValue = defineComponent({
  name: 'ComparisonValue',
  props: { value: { type: Number, default: null } },
  setup(props) {
    return () => {
      if (props.value === null || props.value === undefined) return h('em', { class: 'comparison neutral' }, '--')
      const direction = props.value > 0 ? 'up' : props.value < 0 ? 'down' : 'neutral'
      return h('em', { class: ['comparison', direction] }, `${props.value > 0 ? '+' : ''}${props.value}% ${props.value > 0 ? '↑' : props.value < 0 ? '↓' : ''}`)
    }
  }
})

const ProductTable = defineComponent({
  name: 'ProductTable',
  props: {
    rows: { type: Array, default: () => [] },
    valueKey: { type: String, required: true },
    valueLabel: { type: String, required: true },
    valueType: { type: String, default: 'currency' },
    variant: { type: String, default: 'sales' }
  },
  setup(props) {
    const format = value => props.valueType === 'percent'
      ? `${Number(value || 0).toFixed(2)}%`
      : formatCurrency(value)
    const descriptions = {
      sales: '按销售额由高到低',
      profit: '按毛利率由高到低',
      focus: '已标记重点产品'
    }
    return () => {
      const maxValue = Math.max(...props.rows.map(row => Number(row[props.valueKey] || 0)), 0)
      return h('div', { class: ['product-table', `product-table--${props.variant}`] }, [
      h('div', { class: 'product-table-summary' }, [
        h('span', { class: 'product-table-kicker' }, props.variant === 'focus' ? 'FOCUS' : 'TOP 10'),
        h('span', descriptions[props.variant] || descriptions.sales),
        h('b', `${props.rows.length} 项`)
      ]),
      h('div', { class: 'product-table-head' }, [
        h('span', '排名'),
        h('span', '产品名称'),
        h('span', props.valueLabel)
      ]),
      ...(props.rows.length ? props.rows.slice(0, 10).map((row, index) => {
        const width = maxValue > 0 ? Math.max(4, Number(row[props.valueKey] || 0) / maxValue * 100) : 0
        return h('div', { class: 'product-table-row', key: row.productId || index }, [
          h('b', { class: index < 3 ? `rank rank-${index + 1}` : 'rank' }, String(index + 1)),
          h('div', { class: 'product-name-cell', title: row.productName }, [
            h('span', row.productName),
            h('i', { class: 'product-value-track' }, [
              h('i', { class: 'product-value-fill', style: { width: `${width}%` } })
            ])
          ]),
          h('strong', format(row[props.valueKey]))
        ])
      }) : [h('div', { class: 'empty-row' }, '暂无数据')])
    ])
    }
  }
})

const loading = ref(false)
const errorMessage = ref('')
const datePickerRef = ref(null)
const salesTrendRef = ref(null)
const profitTrendRef = ref(null)
const storeRankingRef = ref(null)
const productLineRef = ref(null)
const inventoryAgeRef = ref(null)
const quickRange = ref('week')
const activeDimension = ref('overall')
const charts = new Map()

const dimensionTabs = [
  { label: '总体', value: 'overall' },
  { label: '门店', value: 'store' },
  { label: '员工', value: 'employee' },
  { label: '产品线', value: 'productLine' },
  { label: '产品', value: 'product' }
]

const filterOptions = reactive({ stores: [], employees: [], productLines: [] })
const filters = reactive({ storeId: '', employeeId: '', productLine: '', granularity: 'day' })
const dateRange = ref(currentWeekRange())
const dashboard = reactive(emptyDashboard())

function emptyDashboard() {
  return {
    meta: { canViewProfit: false },
    kpis: null,
    trend: [],
    storeRanking: [],
    employeeRanking: [],
    employeePerformanceDetails: [],
    productLineAnalysis: [],
    productAnalysis: {
      salesTop10: [],
      grossProfitTop10: [],
      quantityTop10: [],
      highMarginTop10: [],
      focusProducts: []
    },
    inventory: { inventoryQuantity: 0, skuCount: 0, inventoryAmount: null, ageStructure: [], staleProducts: [] }
  }
}

const kpiCards = computed(() => {
  const kpis = dashboard.kpis || {}
  return [
    card('salesAmount', '销售额', Money, 'blue', 'currency', kpis.salesAmount),
    card('grossProfit', '毛利额', DataAnalysis, 'green', 'currency', kpis.grossProfit),
    card('grossMargin', '毛利率', Coin, 'orange', 'percent', kpis.grossMargin),
    card('orderCount', '成交单量', Document, 'purple', 'number', kpis.orderCount),
    card('averageOrderValue', '客单价', UserFilled, 'cyan', 'currency', kpis.averageOrderValue),
    card('inventoryAmount', '库存金额', Box, 'red', 'currency', kpis.inventoryAmount)
  ]
})

function card(key, label, icon, color, type, data = {}) {
  return {
    key, label, icon, color, type,
    value: data?.value ?? null,
    yoy: data?.yoy ?? null,
    periodCompare: data?.periodCompare ?? null,
    reason: data?.unavailableReason || ''
  }
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function dateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function currentWeekRange() {
  const today = new Date()
  const weekday = today.getDay() || 7
  const monday = new Date(today)
  monday.setDate(today.getDate() - weekday + 1)
  return [dateKey(monday), dateKey(today)]
}

function setQuickRange(type) {
  const today = new Date()
  let start = new Date(today)
  if (type === 'week') {
    const weekday = today.getDay() || 7
    start.setDate(today.getDate() - weekday + 1)
  } else if (type === 'month') {
    start = new Date(today.getFullYear(), today.getMonth(), 1)
  }
  quickRange.value = type
  dateRange.value = [dateKey(start), dateKey(today)]
  loadOverview()
}

function openCustomRange() {
  quickRange.value = 'custom'
  datePickerRef.value?.focus?.()
}

function showSection(section) {
  if (activeDimension.value === 'overall') return true
  if (section === 'trend') return ['store'].includes(activeDimension.value)
  return activeDimension.value === section
}

async function loadFilterOptions() {
  try {
    const res = await api.getDashboardFilters()
    if (res.code === 0) Object.assign(filterOptions, res.data || {})
  } catch (error) {
    ElMessage.error(error.response?.data?.message || '筛选条件加载失败')
  }
}

async function loadOverview() {
  if (!Array.isArray(dateRange.value) || dateRange.value.length !== 2) {
    ElMessage.warning('请选择日期范围')
    return
  }
  loading.value = true
  errorMessage.value = ''
  try {
    const res = await api.getDashboardOverview({
      startDate: dateRange.value[0],
      endDate: dateRange.value[1],
      storeId: filters.storeId || undefined,
      employeeId: filters.employeeId || undefined,
      productLine: filters.productLine || undefined,
      granularity: filters.granularity
    })
    if (res.code === 0) {
      Object.assign(dashboard, emptyDashboard(), res.data || {})
      await nextTick()
      renderCharts()
    }
  } catch (error) {
    errorMessage.value = error.response?.data?.message || error.message || '经营看板加载失败'
  } finally {
    loading.value = false
  }
}

function getChart(element, key) {
  if (!element) return null
  let chart = charts.get(key)
  if (!chart) {
    chart = echarts.init(element)
    charts.set(key, chart)
  }
  return chart
}

function percentageAxis(value) {
  return `${value}%`
}

function trendOption(kind) {
  const isProfit = kind === 'profit'
  const rows = dashboard.trend || []
  const actualKey = isProfit ? 'grossProfit' : 'salesAmount'
  const yoyKey = isProfit ? 'grossYoy' : 'salesYoy'
  const periodKey = isProfit ? 'grossPeriodCompare' : 'salesPeriodCompare'
  return {
    color: ['#1769e0', '#54a6ff', '#35b76f'],
    tooltip: { trigger: 'axis' },
    legend: { top: 0, data: [isProfit ? '毛利额（元）' : '销售额（元）', '同比（%）', '环比（%）'] },
    grid: { left: 58, right: 48, top: 42, bottom: 32 },
    xAxis: {
      type: 'category',
      data: rows.map(row => row.bucket),
      axisLine: { lineStyle: { color: '#dfe6f1' } },
      axisLabel: { color: '#67758a' }
    },
    yAxis: [
      {
        type: 'value',
        axisLabel: { formatter: value => compactNumber(value), color: '#67758a' },
        splitLine: { lineStyle: { type: 'dashed', color: '#e8edf4' } }
      },
      {
        type: 'value',
        axisLabel: { formatter: percentageAxis, color: '#67758a' },
        splitLine: { show: false }
      }
    ],
    series: [
      {
        name: isProfit ? '毛利额（元）' : '销售额（元）',
        type: 'bar',
        barMaxWidth: 22,
        itemStyle: { borderRadius: [4, 4, 0, 0], color: '#79b1f5' },
        data: rows.map(row => row[actualKey])
      },
      {
        name: '同比（%）',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        symbolSize: 6,
        data: rows.map(row => row[yoyKey])
      },
      {
        name: '环比（%）',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        symbolSize: 6,
        lineStyle: { type: 'dashed' },
        data: rows.map(row => row[periodKey])
      }
    ]
  }
}

function renderCharts() {
  getChart(salesTrendRef.value, 'sales')?.setOption(trendOption('sales'), true)
  const profitChart = getChart(profitTrendRef.value, 'profit')
  if (profitChart) {
    profitChart.setOption(
      dashboard.meta.canViewProfit
        ? trendOption('profit')
        : { title: { text: '当前角色无毛利查看权限', left: 'center', top: 'middle', textStyle: { color: '#94a0b2', fontSize: 14 } } },
      true
    )
  }

  getChart(storeRankingRef.value, 'store')?.setOption({
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { top: 0, data: dashboard.meta.canViewProfit ? ['销售额', '毛利额'] : ['销售额'] },
    grid: { left: 90, right: 35, top: 38, bottom: 20 },
    xAxis: { type: 'value', axisLabel: { formatter: compactNumber }, splitLine: { lineStyle: { type: 'dashed', color: '#e8edf4' } } },
    yAxis: { type: 'category', inverse: true, data: dashboard.storeRanking.map(row => row.storeName) },
    series: [
      { name: '销售额', type: 'bar', barMaxWidth: 12, data: dashboard.storeRanking.map(row => row.salesAmount), itemStyle: { color: '#1769e0', borderRadius: 6 } },
      ...(dashboard.meta.canViewProfit ? [{ name: '毛利额', type: 'bar', barMaxWidth: 12, data: dashboard.storeRanking.map(row => row.grossProfit), itemStyle: { color: '#72c786', borderRadius: 6 } }] : [])
    ]
  }, true)

  getChart(productLineRef.value, 'productLine')?.setOption({
    tooltip: { trigger: 'item', formatter: '{b}<br/>销售额：{c}<br/>占比：{d}%' },
    legend: { orient: 'vertical', right: 8, top: 'center' },
    series: [{
      name: '销售占比',
      type: 'pie',
      radius: ['45%', '70%'],
      center: ['36%', '52%'],
      label: { show: false },
      data: dashboard.productLineAnalysis.map(row => ({ name: row.productLine, value: row.salesAmount }))
    }]
  }, true)

  getChart(inventoryAgeRef.value, 'inventoryAge')?.setOption({
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 58, right: 20, top: 16, bottom: 28 },
    xAxis: { type: 'category', data: dashboard.inventory.ageStructure.map(row => row.ageBucket) },
    yAxis: { type: 'value', axisLabel: { formatter: compactNumber }, splitLine: { lineStyle: { type: 'dashed', color: '#e8edf4' } } },
    series: [{
      type: 'bar',
      barMaxWidth: 28,
      data: dashboard.inventory.ageStructure.map((row, index) => ({
        value: row.quantity,
        itemStyle: { color: ['#2f7fe8', '#31b978', '#f4a62a', '#7c5ce7', '#ed5b62'][index] }
      }))
    }]
  }, true)
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(Number(value || 0))
}

function formatCurrency(value) {
  return `¥ ${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(Number(value || 0))}`
}

function formatMetric(card) {
  if (card.type === 'currency') return formatCurrency(card.value)
  if (card.type === 'percent') return card.value === null ? '--' : `${Number(card.value || 0).toFixed(2)}%`
  return formatNumber(card.value)
}

function compactNumber(value) {
  const number = Number(value || 0)
  if (Math.abs(number) >= 100000000) return `${(number / 100000000).toFixed(1)}亿`
  if (Math.abs(number) >= 10000) return `${(number / 10000).toFixed(1)}万`
  return formatNumber(number)
}

function resizeCharts() {
  charts.forEach(chart => chart.resize())
}

watch(activeDimension, async () => {
  await nextTick()
  renderCharts()
  resizeCharts()
})

onMounted(async () => {
  window.addEventListener('resize', resizeCharts)
  await loadFilterOptions()
  await loadOverview()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', resizeCharts)
  charts.forEach(chart => chart.dispose())
  charts.clear()
})
</script>

<style scoped>
.bi-dashboard {
  --primary: #1769e0;
  --text: #172033;
  --muted: #758298;
  --border: #e6ebf2;
  min-width: 1060px;
  color: var(--text);
}

.page-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-bottom: 10px;
}

.breadcrumb {
  color: #6f7b8e;
  font-size: 13px;
  margin-bottom: 8px;
}

.page-heading h1 {
  margin: 0;
  font-size: 24px;
  line-height: 1.2;
}

.page-heading h1 span {
  font-size: 19px;
}

.scope-note {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #4e6079;
  font-size: 12px;
}

.scope-note .el-icon {
  color: var(--primary);
}

.filter-panel {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 0;
  flex-wrap: wrap;
}

.filter-panel label {
  color: #3f4a5c;
  font-size: 13px;
}

.filter-panel :deep(.el-select) {
  width: 150px;
}

.date-filter {
  width: 240px !important;
}

.quick-actions {
  display: flex;
  gap: 4px;
  margin-left: 6px;
}

.quick-actions .el-button + .el-button {
  margin-left: 0;
}

.dimension-tabs {
  display: flex;
  gap: 24px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 12px;
}

.dimension-tabs button {
  position: relative;
  border: 0;
  background: transparent;
  padding: 10px 12px;
  color: #344156;
  cursor: pointer;
}

.dimension-tabs button.active {
  color: var(--primary);
  font-weight: 600;
}

.dimension-tabs button.active::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  background: var(--primary);
}

.error-alert {
  margin-bottom: 12px;
}

.kpi-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 9px;
  margin-bottom: 10px;
}

.kpi-card {
  display: flex;
  gap: 12px;
  min-width: 0;
  padding: 16px 13px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 3px 12px rgba(35, 59, 96, 0.05);
}

.kpi-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
  color: #fff;
  border-radius: 50%;
  font-size: 20px;
}

.kpi-icon.blue { background: linear-gradient(135deg, #1769e0, #56a5ff); }
.kpi-icon.green { background: linear-gradient(135deg, #20a864, #72d89a); }
.kpi-icon.orange { background: linear-gradient(135deg, #ee921c, #ffc15c); }
.kpi-icon.purple { background: linear-gradient(135deg, #6b49d7, #a584ff); }
.kpi-icon.cyan { background: linear-gradient(135deg, #3379df, #6bb8ff); }
.kpi-icon.red { background: linear-gradient(135deg, #f06416, #ff9d4d); }

.kpi-content {
  min-width: 0;
  flex: 1;
}

.kpi-label {
  color: #303c50;
  font-size: 13px;
  font-weight: 600;
}

.kpi-value {
  margin: 6px 0 8px;
  font-size: 21px;
  font-weight: 700;
  white-space: nowrap;
}

.kpi-value.unavailable {
  color: #98a3b4;
  font-size: 16px;
}

.comparison-row {
  display: grid;
  grid-template-columns: auto 1fr auto 1fr;
  gap: 4px;
  color: var(--muted);
  font-size: 11px;
}

.comparison {
  font-style: normal;
  white-space: nowrap;
}

.comparison.up { color: #e44843; }
.comparison.down { color: #14945e; }
.comparison.neutral { color: #8c98aa; }

.unavailable-reason {
  color: #9aa5b4;
  font-size: 10px;
  margin-top: 5px;
}

.chart-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 10px;
}

.analysis-grid,
.product-grid,
.inventory-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 10px;
}

.dashboard-panel {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 3px 12px rgba(35, 59, 96, 0.04);
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 40px;
  padding: 0 14px;
  border-bottom: 1px solid #eef1f5;
}

.panel-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
}

.panel-actions {
  color: var(--muted);
  font-size: 11px;
}

.panel-body {
  padding: 8px 12px;
}

.large-chart {
  height: 260px;
}

.medium-chart {
  height: 260px;
}

.permission-tip,
.panel-note {
  color: #9a6d19;
}

.product-table-head,
.product-table-row {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) 110px;
  align-items: center;
  min-height: 36px;
  gap: 8px;
  font-size: 12px;
}

.product-table {
  --list-accent: #1769e0;
  --list-soft: #edf5ff;
  margin: -2px -4px 0;
}

.product-table--profit {
  --list-accent: #1f9d68;
  --list-soft: #eaf8f1;
}

.product-table--focus {
  --list-accent: #e58a17;
  --list-soft: #fff5e6;
}

.product-table-summary {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 8px;
  min-height: 42px;
  margin-bottom: 7px;
  padding: 0 10px;
  border: 1px solid color-mix(in srgb, var(--list-accent) 18%, white);
  border-radius: 8px;
  color: #68758a;
  background: linear-gradient(105deg, var(--list-soft), #fff 78%);
  font-size: 11px;
}

.product-table-kicker {
  padding: 3px 7px;
  border-radius: 10px;
  color: #fff;
  background: var(--list-accent);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .5px;
}

.product-table-summary b {
  color: var(--list-accent);
  font-weight: 650;
}

.product-table-head {
  padding: 0 5px;
  border-radius: 6px;
  color: #69768a;
  background: #f6f8fb;
  font-weight: 600;
}

.product-table-head span:last-child {
  text-align: right;
}

.product-table-row {
  position: relative;
  padding: 3px 5px;
  border-bottom: 1px solid #f0f2f6;
  transition: background .18s ease, transform .18s ease;
}

.product-table-row:hover {
  z-index: 1;
  border-radius: 6px;
  background: var(--list-soft);
  transform: translateX(2px);
}

.product-name-cell {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 5px;
}

.product-name-cell > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #354156;
  font-weight: 550;
}

.product-value-track {
  display: block;
  width: 100%;
  height: 3px;
  overflow: hidden;
  border-radius: 4px;
  background: #edf0f5;
}

.product-value-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--list-accent), color-mix(in srgb, var(--list-accent) 48%, white));
}

.product-table-row strong {
  color: var(--list-accent);
  text-align: right;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.rank {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-left: 6px;
  border-radius: 50%;
  color: #68758a;
  background: #f1f3f7;
  font-size: 11px;
}

.rank-1 {
  color: #fff;
  background: linear-gradient(135deg, #ff6b47, #ef3434);
  box-shadow: 0 3px 7px rgba(239, 52, 52, .24);
}

.rank-2 {
  color: #fff;
  background: linear-gradient(135deg, #ffb447, #f18920);
  box-shadow: 0 3px 7px rgba(241, 137, 32, .22);
}

.rank-3 {
  color: #fff;
  background: linear-gradient(135deg, #f3cf4b, #d9a71e);
  box-shadow: 0 3px 7px rgba(217, 167, 30, .2);
}

.empty-row {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 120px;
  color: #a0a9b8;
}

.inventory-summary {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
  min-height: 170px;
}

.inventory-summary > div {
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 10px;
  border: 1px solid #e8edf4;
  border-radius: 7px;
  background: #fbfcfe;
}

.inventory-summary span {
  color: var(--muted);
  font-size: 12px;
}

.inventory-summary strong {
  margin-top: 8px;
  font-size: 20px;
}

.inventory-summary .small-strong {
  font-size: 15px;
}

.inventory-chart {
  height: 180px;
}

@media (max-width: 1300px) {
  .kpi-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}
</style>
