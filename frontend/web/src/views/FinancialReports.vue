<template>
  <div class="financial-reports-page">
    <el-card shadow="never" class="report-shell">
      <template #header>
        <div class="report-heading">
          <div>
            <div class="eyebrow">FINANCIAL REPORTS</div>
            <h1>财务报表</h1>
            <p>汇总经营成果、资金余额、应收应付与库存资产；所有指标均来自 ANY-ERP 实时业务数据。</p>
          </div>
          <el-button type="primary" :loading="loading" @click="loadOverview">刷新数据</el-button>
        </div>
      </template>

      <div class="filter-bar">
        <el-radio-group v-model="periodType" @change="loadOverview">
          <el-radio-button label="day">按日</el-radio-button>
          <el-radio-button label="month">按月</el-radio-button>
          <el-radio-button label="year">按年</el-radio-button>
        </el-radio-group>
        <el-date-picker v-model="selectedDate" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" @change="loadOverview" />
        <el-select v-model="regionId" clearable filterable placeholder="全部区域" class="region-select" @change="onRegionChange">
          <el-option v-for="region in regions" :key="region.regionId" :label="region.name" :value="String(region.regionId)" />
        </el-select>
        <el-select v-model="storeId" clearable filterable placeholder="全部门店" class="store-select" @change="loadOverview">
          <el-option v-for="store in filteredStores" :key="store.storeId" :label="store.name" :value="String(store.storeId)" />
        </el-select>
        <el-switch v-model="includeDemo" active-text="包含样机库存" inactive-text="不含样机" @change="loadOverview" />
      </div>

      <el-alert v-if="errorMessage" :title="errorMessage" type="error" show-icon :closable="false" class="report-alert" />
      <el-alert v-if="data.productSettlement?.costPendingOrderCount" type="warning" show-icon :closable="false" class="report-alert">
        <template #title>有 {{ data.productSettlement.costPendingOrderCount }} 笔产品端结算待补成本，待补金额 ¥{{ money(data.productSettlement.costPendingAmount) }}。</template>
      </el-alert>

      <div class="metric-grid" v-loading="loading">
        <div class="metric-card revenue"><span>营业额</span><strong>¥{{ money(data.revenue) }}</strong><small>{{ periodLabel }}</small></div>
        <div class="metric-card profit"><span>财务毛利</span><strong>¥{{ money(data.grossProfit) }}</strong><small>毛利率 {{ percent(data.grossMargin) }}</small></div>
        <div class="metric-card"><span>销售毛利</span><strong>¥{{ money(data.salesGrossProfit) }}</strong><small>毛利率 {{ percent(data.salesGrossMargin) }}</small></div>
        <div class="metric-card"><span>产品端毛利</span><strong>¥{{ money(data.productGrossProfit) }}</strong><small>毛利率 {{ percent(data.productGrossMargin) }}</small></div>
        <div class="metric-card expense"><span>门店经营费用</span><strong>¥{{ money(data.operatingExpense?.amount) }}</strong><small>{{ Number(data.operatingExpense?.expenseCount || 0) }} 笔已确认费用</small></div>
        <div class="metric-card operating"><span>门店经营利润</span><strong>¥{{ money(data.storeOperatingProfit) }}</strong><small>财务毛利减已确认经营费用</small></div>
      </div>

      <el-tabs v-model="activeTab" class="report-tabs" @tab-change="onTabChange">
        <el-tab-pane label="财务总览" name="overview">
          <div class="section-grid">
            <section class="report-section">
              <div class="section-heading"><div><h2>利润构成</h2><p>区分销售端毛利与产品端已确认收益。</p></div></div>
              <div ref="profitChartRef" class="chart-box"></div>
              <el-descriptions :column="2" border size="small" class="profit-descriptions">
                <el-descriptions-item label="产品定价金额">¥{{ money(data.productSettlement?.productPricingAmount) }}</el-descriptions-item>
                <el-descriptions-item label="采购成本">¥{{ money(data.productSettlement?.purchaseCostAmount) }}</el-descriptions-item>
                <el-descriptions-item label="政策收益已核销">¥{{ money(data.productSettlement?.policyIncome?.recognizedAmount) }}</el-descriptions-item>
                <el-descriptions-item label="政策收益预估">¥{{ money(data.productSettlement?.policyIncome?.estimatedAmount) }}</el-descriptions-item>
              </el-descriptions>
              <p class="data-note">{{ data.productSettlement?.policyIncome?.note || '预估政策收益仅供经营判断，不计入产品端已实现毛利。' }}</p>
            </section>
            <section class="report-section">
              <div class="section-heading"><div><h2>经营费用结构</h2><p>仅统计已确认且计入门店经营利润的费用。</p></div></div>
              <div ref="expenseChartRef" class="chart-box"></div>
              <el-table :data="data.operatingExpense?.byType || []" stripe size="small" empty-text="暂无费用数据">
                <el-table-column prop="expenseType" label="费用类型" min-width="150" />
                <el-table-column prop="expenseCount" label="笔数" width="90" align="right" />
                <el-table-column label="金额" width="150" align="right"><template #default="{ row }">¥{{ money(row.amount) }}</template></el-table-column>
              </el-table>
            </section>
          </div>
          <section class="report-section detail-section">
            <div class="section-heading"><div><h2>门店经营费用排行</h2><p>按所选区域、门店及统计周期汇总。</p></div></div>
            <el-table :data="data.operatingExpense?.byStore || []" stripe border empty-text="暂无门店费用数据">
              <el-table-column prop="storeName" label="门店" min-width="180" />
              <el-table-column prop="expenseCount" label="费用笔数" width="120" align="right" />
              <el-table-column label="费用金额" width="180" align="right"><template #default="{ row }">¥{{ money(row.amount) }}</template></el-table-column>
            </el-table>
          </section>
        </el-tab-pane>

        <el-tab-pane label="利润明细" name="profit">
          <el-alert :title="profitNote" type="info" :closable="false" class="report-alert" />
          <div class="profit-actions"><span>当前利润明细共 {{ profitTotal.toLocaleString('zh-CN') }} 笔</span><el-button type="success" plain :loading="exportingProfit" @click="exportProfitDetails">导出 Excel</el-button></div>
          <div class="profit-summary">
            <div><span>不含税销售收入</span><strong>¥{{ money(profitSummary.netRevenue) }}</strong></div>
            <div><span>不含税存货成本</span><strong>¥{{ money(profitSummary.bookCost) }}</strong></div>
            <div><span>财务毛利</span><strong>¥{{ money(profitSummary.grossProfit) }}</strong></div>
            <div><span>门店经营利润</span><strong>¥{{ money(profitSummary.operatingProfit) }}</strong></div>
            <div><span>待补成本单数</span><strong>{{ Number(profitSummary.pendingOrderCount || 0) }}</strong></div>
          </div>
          <el-table :data="profitRows" stripe border v-loading="profitLoading" empty-text="当前筛选范围暂无利润明细">
            <el-table-column prop="businessDate" label="日期" width="110" />
            <el-table-column prop="orderNo" label="销售单号" min-width="175" />
            <el-table-column prop="storeName" label="门店" min-width="130" />
            <el-table-column prop="customerName" label="客户" min-width="110" />
            <el-table-column label="含税销售额" width="130" align="right"><template #default="{ row }">¥{{ money(row.grossRevenue) }}</template></el-table-column>
            <el-table-column label="不含税收入" width="135" align="right"><template #default="{ row }">¥{{ money(row.netRevenue) }}</template></el-table-column>
            <el-table-column label="销项税额" width="120" align="right"><template #default="{ row }">¥{{ money(row.outputVat) }}</template></el-table-column>
            <el-table-column label="含税成本" width="130" align="right"><template #default="{ row }">¥{{ money(row.grossCost) }}</template></el-table-column>
            <el-table-column label="可抵扣进项税" width="135" align="right"><template #default="{ row }">¥{{ money(row.deductibleInputVat) }}</template></el-table-column>
            <el-table-column label="不含税成本" width="135" align="right"><template #default="{ row }">¥{{ money(row.bookCost) }}</template></el-table-column>
            <el-table-column label="财务毛利" width="130" align="right"><template #default="{ row }">{{ row.grossProfit === null ? '—' : `¥${money(row.grossProfit)}` }}</template></el-table-column>
            <el-table-column label="毛利率" width="105" align="right"><template #default="{ row }">{{ percent(row.grossMargin) }}</template></el-table-column>
            <el-table-column label="状态" width="110"><template #default="{ row }"><el-tag :type="row.status === 'cost_pending' ? 'warning' : 'success'">{{ row.status === 'cost_pending' ? '待补成本' : '已估算' }}</el-tag></template></el-table-column>
          </el-table>
          <el-pagination v-model:current-page="profitPage" v-model:page-size="profitPageSize" :total="profitTotal" :page-sizes="[20, 50, 100]" layout="total, sizes, prev, pager, next" @current-change="loadProfitDetails" @size-change="loadProfitDetails" />
        </el-tab-pane>

        <el-tab-pane label="应收与返利" name="receivable">
          <div class="receivable-kpis">
            <div><span>国补应收</span><strong>¥{{ money(policyReceivableAmount) }}</strong></div>
            <div><span>已到账返利</span><strong>¥{{ money(data.rebate?.receivedAmount) }}</strong></div>
            <div><span>未到账返利</span><strong>¥{{ money(data.rebate?.pendingAmount) }}</strong></div>
          </div>
          <div class="section-grid">
            <section class="report-section">
              <div class="section-heading"><div><h2>结算账户余额</h2><p>含资金账户、政策补贴应收、Care 可用金及厂商返利账户。</p></div><strong class="section-total">¥{{ money(data.accounts?.totalAmount) }}</strong></div>
              <div ref="accountChartRef" class="chart-box compact-chart"></div>
              <el-table :data="data.accounts?.accounts || []" stripe size="small" empty-text="暂无账户">
                <el-table-column prop="accountName" label="账户名称" min-width="180" />
                <el-table-column prop="accountType" label="账户类型" min-width="150" />
                <el-table-column label="余额" width="150" align="right"><template #default="{ row }">¥{{ money(row.balance) }}</template></el-table-column>
              </el-table>
            </section>
            <section class="report-section">
              <div class="section-heading"><div><h2>返利资金池</h2><p>已到账余额与待确认返利分开呈现。</p></div></div>
              <div class="rebate-metrics"><div><span>已到账返利</span><strong>¥{{ money(data.rebate?.receivedAmount) }}</strong></div><div><span>未到账返利</span><strong>¥{{ money(data.rebate?.pendingAmount) }}</strong></div></div>
              <h3 class="subheading">已到账返利 · 按供应商</h3>
              <el-table :data="data.rebate?.receivedList || []" stripe size="small" max-height="250" empty-text="暂无已到账返利">
                <el-table-column prop="supplierName" label="供应商" min-width="160" />
                <el-table-column label="可用余额" width="140" align="right"><template #default="{ row }">¥{{ money(row.amount) }}</template></el-table-column>
              </el-table>
              <h3 class="subheading">未到账返利 · 按供应商</h3>
              <el-table :data="data.rebate?.pendingList || []" stripe size="small" max-height="250" empty-text="暂无待确认返利">
                <el-table-column prop="supplierName" label="供应商" min-width="160" />
                <el-table-column label="预估金额" width="140" align="right"><template #default="{ row }">¥{{ money(row.amount) }}</template></el-table-column>
              </el-table>
            </section>
          </div>
        </el-tab-pane>

        <el-tab-pane label="应付与资金" name="payable">
          <div class="payment-kpis">
            <div><span>待付款合计</span><strong>¥{{ money(data.payments?.all) }}</strong></div>
            <div><span>采购类待付</span><strong>¥{{ money(data.payments?.purchase) }}</strong></div>
            <div><span>费用/报销待付</span><strong>¥{{ money(data.payments?.expense) }}</strong></div>
            <div><span>已生成结算单待付</span><strong>¥{{ money(data.payments?.created) }}</strong></div>
            <div><span>累计已付款</span><strong>¥{{ money(data.payments?.paid) }}</strong></div>
          </div>
          <div ref="paymentChartRef" class="chart-box payment-chart"></div>
          <div class="section-grid">
            <section v-for="group in supplierGroups" :key="group.key" class="report-section">
              <div class="section-heading"><div><h2>{{ group.label }} · 待付前五</h2><p>{{ group.description }}</p></div></div>
              <el-table :data="data.payments?.supplierTop?.[group.key] || []" stripe size="small" empty-text="暂无待付供应商">
                <el-table-column type="index" label="#" width="55" />
                <el-table-column prop="name" label="供应商/收款方" min-width="170" />
                <el-table-column label="待付款" width="140" align="right"><template #default="{ row }">¥{{ money(row.amount) }}</template></el-table-column>
              </el-table>
            </section>
          </div>
        </el-tab-pane>

        <el-tab-pane label="库存资产" name="inventory">
          <div class="inventory-head"><div><span>库存资产金额</span><strong>¥{{ money(data.inventory?.totalAmount) }}</strong></div><el-tag type="info" effect="plain">{{ data.inventory?.includeDemo ? '包含样机' : '不含样机' }}</el-tag></div>
          <el-alert title="库存金额按系统库存成本口径汇总；分类最多展开至四级，分类及超期率均以库存接口返回值为准。" type="info" :closable="false" class="report-alert" />
          <el-table :data="inventoryRows" stripe border row-key="key" v-loading="loading" empty-text="当前权限及筛选范围内暂无库存分类">
            <el-table-column label="分类 / 商品" min-width="280">
              <template #default="{ row }">
                <button class="tree-button" :style="{ paddingLeft: `${(row.level - 1) * 22}px` }" :disabled="!row.hasChildren" @click="toggleInventory(row)">
                  <span class="tree-icon">{{ row.hasChildren ? (expandedKeys.has(row.key) ? '−' : '+') : '·' }}</span>{{ row.name }}
                </button>
              </template>
            </el-table-column>
            <el-table-column prop="level" label="层级" width="80" align="center"><template #default="{ row }">{{ row.level }}级</template></el-table-column>
            <el-table-column label="数量" width="130" align="right"><template #default="{ row }">{{ Number(row.quantity || 0).toLocaleString('zh-CN') }}</template></el-table-column>
            <el-table-column label="库存金额" width="170" align="right"><template #default="{ row }">¥{{ money(row.amount) }}</template></el-table-column>
            <el-table-column label="超期率" width="130" align="right"><template #default="{ row }">{{ percent(row.overdueRate) }}</template></el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
      <div class="report-footer">数据按当前账号授权的门店范围查询。财务毛利为系统财务报表口径；缺少成本的数据会标记为待补，不以估算值冒充实际值。</div>
    </el-card>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import * as echarts from 'echarts'
import api from '../api'

const today = new Date()
const selectedDate = ref(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`)
const periodType = ref('month')
const regionId = ref('')
const storeId = ref('')
const includeDemo = ref(true)
const regions = ref([])
const stores = ref([])
const data = reactive({})
const loading = ref(false)
const errorMessage = ref('')
const activeTab = ref('overview')
const profitRows = ref([])
const profitLoading = ref(false)
const exportingProfit = ref(false)
const profitPage = ref(1)
const profitPageSize = ref(20)
const profitTotal = ref(0)
const profitSummary = reactive({})
const profitNote = ref('财务利润采用系统财务利润表口径；缺失成本的订单单独列示，不纳入已确认毛利。')
const expandedKeys = reactive(new Set())
const profitChartRef = ref(null)
const expenseChartRef = ref(null)
const accountChartRef = ref(null)
const paymentChartRef = ref(null)
const charts = new Map()
const supplierGroups = [
  { key: 'all', label: '全部应付', description: '未结清采购、费用及报销应付款' },
  { key: 'uncreated', label: '未生成结算单', description: '尚未进入结算单的应付款' },
  { key: 'created', label: '已生成结算单', description: '已进入结算单但尚未付清' }
]

const periodLabel = computed(() => ({ day: '按日', month: '按月', year: '按年' }[periodType.value]))
const filteredStores = computed(() => regionId.value
  ? stores.value.filter(store => String(store.regionId || store.region_id || '') === String(regionId.value))
  : stores.value)
const policyReceivableAmount = computed(() => (data.accounts?.accounts || [])
  .filter(account => account.accountType === 'POLICY_RECEIVABLE')
  .reduce((sum, account) => sum + (Number(account.balance) || 0), 0))
const inventoryRows = computed(() => {
  const rows = []
  const visit = (items, level = 1, parent = '') => {
    if (level > 4) return
    ;(items || []).forEach((item, index) => {
      const segment = String(item.key || item.categoryId || item.category_id || item.name || index)
      const key = parent ? `${parent}/${segment}` : segment
      const children = item.children || []
      rows.push({ ...item, key, level, hasChildren: children.length > 0 })
      if (children.length && expandedKeys.has(key)) visit(children, level + 1, key)
    })
  }
  visit(data.inventory?.categories || [])
  return rows
})

function money(value) {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  return Number.isFinite(number) ? number.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'
}

function percent(value) {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  return Number.isFinite(number) ? `${number.toFixed(2)}%` : '—'
}

function getPeriodRange() {
  const [year, month, day] = selectedDate.value.split('-').map(Number)
  if (periodType.value === 'day') return { startDate: selectedDate.value, endDate: selectedDate.value }
  if (periodType.value === 'year') return { startDate: `${year}-01-01`, endDate: `${year}-12-31` }
  const last = new Date(year, month, 0).getDate()
  return { startDate: `${year}-${String(month).padStart(2, '0')}-01`, endDate: `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}` }
}

function currentFilters() {
  return {
    periodType: periodType.value,
    date: selectedDate.value,
    regionId: regionId.value || '',
    storeId: storeId.value || '',
    includeDemo: includeDemo.value
  }
}

async function loadOptions() {
  try {
    const result = await api.getDashboardFilters()
    regions.value = result.data?.regions || []
    stores.value = (result.data?.stores || []).map(store => ({
      ...store,
      storeId: store.storeId || store.store_id,
      regionId: store.regionId || store.region_id
    }))
  } catch (error) {
    ElMessage.error(error?.response?.data?.message || '加载区域及门店筛选项失败')
  }
}

async function loadOverview() {
  loading.value = true
  profitPage.value = 1
  errorMessage.value = ''
  try {
    const result = await api.getFinanceOverview(currentFilters())
    Object.assign(data, result.data || {})
    expandedKeys.clear()
    await nextTick()
    renderVisibleCharts()
    if (activeTab.value === 'profit') await loadProfitDetails()
  } catch (error) {
    errorMessage.value = error?.response?.data?.message || error.message || '财务报表加载失败'
    ElMessage.error(errorMessage.value)
  } finally {
    loading.value = false
  }
}

function onRegionChange() {
  if (storeId.value && !filteredStores.value.some(store => String(store.storeId) === String(storeId.value))) storeId.value = ''
  loadOverview()
}

async function loadProfitDetails() {
  profitLoading.value = true
  try {
    const result = await api.getFinancialProfitOrders({
      ...getPeriodRange(), regionId: regionId.value || '', storeId: storeId.value || '',
      page: profitPage.value, pageSize: profitPageSize.value
    })
    profitRows.value = result.data?.items || []
    profitTotal.value = Number(result.data?.total || 0)
    Object.assign(profitSummary, result.data?.summary || {})
    profitNote.value = result.data?.note || profitNote.value
  } catch (error) {
    ElMessage.error(error?.response?.data?.message || error.message || '利润明细加载失败')
  } finally {
    profitLoading.value = false
  }
}

async function exportProfitDetails() {
  exportingProfit.value = true
  try {
    await api.exportFinancialProfitOrders({
      ...getPeriodRange(), regionId: regionId.value || '', storeId: storeId.value || ''
    })
    ElMessage.success('财务利润明细已导出')
  } catch (error) {
    ElMessage.error(error?.response?.data?.message || error.message || '利润明细导出失败')
  } finally {
    exportingProfit.value = false
  }
}

function onTabChange(tab) {
  if (tab === 'profit') loadProfitDetails()
  nextTick(renderVisibleCharts)
}

function toggleInventory(row) {
  if (!row.hasChildren) return
  if (expandedKeys.has(row.key)) expandedKeys.delete(row.key)
  else expandedKeys.add(row.key)
}

function setChart(key, element, option) {
  if (!element) return
  let chart = charts.get(key)
  if (!chart || chart.isDisposed()) {
    chart = echarts.init(element)
    charts.set(key, chart)
  }
  chart.resize()
  chart.setOption(option, true)
}

function renderVisibleCharts() {
  const palette = ['#4263eb', '#12b886', '#f59f00', '#e64980', '#7950f2', '#0ca678', '#e8590c']
  const profitParts = [
    { name: '销售毛利', value: Number(data.salesGrossProfit) || 0 },
    { name: '产品端毛利', value: Number(data.productGrossProfit) || 0 }
  ]
  setChart('profit', profitChartRef.value, {
    color: palette, tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 95, right: 35, top: 25, bottom: 30 },
    xAxis: { type: 'value', axisLabel: { formatter: value => `¥${Number(value).toLocaleString('zh-CN')}` } },
    yAxis: { type: 'category', data: profitParts.map(item => item.name) },
    series: [{ type: 'bar', barMaxWidth: 30, data: profitParts.map(item => item.value), itemStyle: { borderRadius: [0, 6, 6, 0] }, label: { show: true, position: 'right', formatter: item => `¥${money(item.value)}` } }]
  })
  const expenses = data.operatingExpense?.byType || []
  setChart('expense', expenseChartRef.value, {
    color: palette, tooltip: { trigger: 'item', formatter: item => `${item.name}<br/>¥${money(item.value)} (${item.percent}%)` },
    series: [{ type: 'pie', radius: ['35%', '65%'], data: expenses.map(row => ({ name: row.expenseType, value: Number(row.amount) || 0 })), label: { formatter: '{b}: {d}%' } }]
  })
  const accounts = data.accounts?.byType || []
  setChart('accounts', accountChartRef.value, {
    color: palette, tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 125, right: 35, top: 18, bottom: 20 },
    xAxis: { type: 'value', axisLabel: { formatter: value => `¥${Number(value).toLocaleString('zh-CN')}` } },
    yAxis: { type: 'category', data: accounts.map(row => row.name) },
    series: [{ type: 'bar', barMaxWidth: 24, data: accounts.map(row => Number(row.amount) || 0), itemStyle: { borderRadius: [0, 6, 6, 0] }, label: { show: true, position: 'right', formatter: item => `¥${money(item.value)}` } }]
  })
  const payments = data.payments || {}
  setChart('payments', paymentChartRef.value, {
    color: palette, tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } }, grid: { left: 120, right: 35, top: 18, bottom: 20 },
    xAxis: { type: 'value', axisLabel: { formatter: value => `¥${Number(value).toLocaleString('zh-CN')}` } },
    yAxis: { type: 'category', data: ['未生成结算单', '已生成待付', '已付款'] },
    series: [{ type: 'bar', barMaxWidth: 28, data: [Number(payments.uncreated) || 0, Number(payments.created) || 0, Number(payments.paid) || 0], itemStyle: { borderRadius: [0, 6, 6, 0] }, label: { show: true, position: 'right', formatter: item => `¥${money(item.value)}` } }]
  })
}

function resizeCharts() { charts.forEach(chart => chart.resize()) }

onMounted(async () => {
  await loadOptions()
  await loadOverview()
  window.addEventListener('resize', resizeCharts)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', resizeCharts)
  charts.forEach(chart => chart.dispose())
  charts.clear()
})
</script>

<style scoped>
.financial-reports-page { padding: 20px; color: #243247; }
.report-shell { border: 1px solid #e7edf5; border-radius: 12px; }
.report-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.eyebrow { color: #5472d3; font-size: 11px; font-weight: 700; letter-spacing: .12em; }
.report-heading h1 { margin: 5px 0; font-size: 22px; }
.report-heading p { margin: 0; color: #748196; font-size: 13px; }
.filter-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin: 2px 0 20px; padding: 14px; border: 1px solid #e7edf5; border-radius: 10px; background: #f8fafd; }
.region-select { width: 165px; }
.store-select { width: 190px; }
.report-alert { margin: 12px 0; }
.metric-grid { display: grid; grid-template-columns: repeat(6, minmax(145px, 1fr)); gap: 12px; margin-bottom: 18px; }
.metric-card { min-height: 102px; padding: 15px 16px; border: 1px solid #e8edf4; border-radius: 10px; background: linear-gradient(145deg, #fff, #f8fafd); }
.metric-card span, .metric-card small { display: block; color: #748196; font-size: 12px; }
.metric-card strong { display: block; margin: 8px 0 5px; color: #243247; font-size: 21px; font-variant-numeric: tabular-nums; }
.metric-card.revenue strong, .metric-card.profit strong { color: #3d5dcc; }
.metric-card.expense strong { color: #d97706; }
.metric-card.operating strong { color: #16836a; }
.report-tabs :deep(.el-tabs__item) { font-weight: 600; }
.section-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.report-section { min-width: 0; padding: 17px; border: 1px solid #e7edf5; border-radius: 10px; background: #fff; }
.section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.section-heading h2 { margin: 0 0 5px; font-size: 16px; }
.section-heading p { margin: 0; color: #8490a2; font-size: 12px; }
.section-total { color: #3d5dcc; font-size: 18px; }
.chart-box { height: 270px; }
.compact-chart { height: 220px; }
.profit-descriptions { margin-top: 8px; }
.data-note, .report-footer { color: #8490a2; font-size: 12px; line-height: 1.6; }
.detail-section { margin-top: 16px; }
.profit-summary, .payment-kpis { display: grid; grid-template-columns: repeat(5, minmax(145px, 1fr)); gap: 10px; margin: 14px 0; }
.profit-summary > div, .payment-kpis > div { padding: 13px; border: 1px solid #e7edf5; border-radius: 8px; background: #f8fafd; }
.profit-summary span, .payment-kpis span, .rebate-metrics span, .inventory-head span { display: block; color: #748196; font-size: 12px; }
.profit-summary strong, .payment-kpis strong { display: block; margin-top: 7px; font-size: 18px; font-variant-numeric: tabular-nums; }
.el-pagination { justify-content: flex-end; margin-top: 16px; }
.profit-actions { display: flex; align-items: center; justify-content: space-between; margin: 10px 0; color: #748196; font-size: 12px; }
.rebate-metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 16px; }
.receivable-kpis { display: grid; grid-template-columns: repeat(3, minmax(160px, 1fr)); gap: 12px; margin: 14px 0; }
.receivable-kpis > div { padding: 15px; border: 1px solid #e7edf5; border-radius: 9px; background: #f8fafd; }
.receivable-kpis span { display: block; color: #748196; font-size: 12px; }
.receivable-kpis strong { display: block; margin-top: 7px; color: #3d5dcc; font-size: 20px; }
.rebate-metrics > div, .inventory-head { padding: 15px; border-radius: 9px; background: #f5f8ff; }
.rebate-metrics strong, .inventory-head strong { display: block; margin-top: 7px; color: #3d5dcc; font-size: 21px; }
.subheading { margin: 16px 0 8px; font-size: 13px; }
.payment-chart { height: 250px; margin: 8px 0 18px; }
.inventory-head { display: flex; align-items: center; justify-content: space-between; margin: 12px 0; }
.tree-button { display: inline-flex; align-items: center; gap: 7px; border: 0; background: transparent; color: #243247; font: inherit; cursor: pointer; }
.tree-button:disabled { cursor: default; }
.tree-icon { display: inline-flex; width: 18px; height: 18px; align-items: center; justify-content: center; border: 1px solid #ccd5e2; border-radius: 4px; color: #5472d3; font-weight: 700; }
.report-footer { margin-top: 18px; padding-top: 12px; border-top: 1px solid #edf0f5; }
@media (max-width: 1250px) { .metric-grid { grid-template-columns: repeat(3, minmax(145px, 1fr)); } .profit-summary, .payment-kpis { grid-template-columns: repeat(3, minmax(145px, 1fr)); } }
@media (max-width: 800px) { .financial-reports-page { padding: 10px; } .section-grid { grid-template-columns: 1fr; } .metric-grid { grid-template-columns: repeat(2, minmax(130px, 1fr)); } .profit-summary, .payment-kpis { grid-template-columns: repeat(2, minmax(130px, 1fr)); } .report-heading { align-items: flex-start; } }
</style>
