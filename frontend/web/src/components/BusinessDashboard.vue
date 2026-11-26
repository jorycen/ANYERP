<template>
  <div class="bi-dashboard" :class="`dimension-${activeDimension}`" v-loading="loading">
    <header class="dashboard-header">
      <h1>经营数据看板 <span>（{{ activeDimension === 'store' ? '门店经营分析' : dimensionTabs.find(tab => tab.value === activeDimension)?.label }}）</span></h1>
      <div class="dimension-tabs">
        <button
          v-for="tab in dimensionTabs"
          :key="tab.value"
          :class="{ active: activeDimension === tab.value }"
          @click="selectDimension(tab.value)"
        >
          <el-icon v-if="tab.icon" class="dimension-tab-icon"><component :is="tab.icon" /></el-icon>
          <span>{{ tab.label }}</span>
        </button>
      </div>
    </header>

    <section class="filter-panel">
      <label>区域：</label>
      <el-select v-model="filters.regionId" placeholder="全部区域" clearable>
        <el-option label="全部区域" value="" />
        <el-option
          v-for="region in filterOptions.regions"
          :key="region.regionId"
          :label="String(region.name || '').replace('区域', '')"
          :value="region.regionId"
        />
      </el-select>
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
      <el-select v-model="filters.productLine" placeholder="全部产品线" clearable @change="onProductLineFilterChange">
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

    <el-alert
      v-if="errorMessage"
      :title="errorMessage"
      type="error"
      show-icon
      :closable="false"
      class="error-alert"
    />

    <section v-if="activeDimension === 'customerSource'" class="customer-source-section">
      <div class="kpi-grid customer-source-kpi-grid">
        <article v-for="card in customerSourceKpiCards" :key="card.key" class="kpi-card">
          <div class="kpi-icon" :class="card.color"><el-icon><component :is="card.icon" /></el-icon></div>
          <div class="kpi-content">
            <div class="kpi-label">{{ card.label }}</div>
            <div class="kpi-value">{{ card.value }}</div>
          </div>
        </article>
      </div>
      <div class="source-overview-grid">
        <DashboardPanel title="客户来源销售额"><div ref="sourceSalesRef" class="medium-chart"></div></DashboardPanel>
        <DashboardPanel title="客户来源经营毛利"><div ref="sourceProfitRef" class="medium-chart"></div></DashboardPanel>
        <DashboardPanel title="客户来源单数（按商品一级分类）">
          <template #actions>
            <el-select v-model="customerSourceCategory" size="small" style="width: 150px" @change="renderCustomerSourceChart">
              <el-option label="全部一级分类" value="" />
              <el-option v-for="item in customerSourceCategoryOptions" :key="item" :label="item" :value="item" />
            </el-select>
          </template>
          <div ref="sourceTrendRef" class="medium-chart"></div>
        </DashboardPanel>
      </div>
      <DashboardPanel :title="customerSourceDimension === 'employee' ? '个人客户来源分析' : '门店渠道销售对比（全部门店）'">
        <template #actions>
          <el-select v-model="customerSourceDimension" style="width: 150px" @change="loadCustomerSourceAnalysis">
            <el-option label="按公司" value="company" />
            <el-option label="按门店" value="store" />
            <el-option label="按员工" value="employee" />
          </el-select>
        </template>
        <p class="customer-source-note">按销售订单客户来源统计；混合商品订单会分别计入涉及类别，售后单数按关联的有效退单统计。</p>
        <div class="source-chart-toolbar">
          <strong>{{ customerSourceDimensionLabel }}客户来源分布</strong>
          <el-radio-group v-model="customerSourceMetric" size="small" @change="renderCustomerSourceChart">
            <el-radio-button label="salesAmount">销售额</el-radio-button>
            <el-radio-button label="orderCount">订单数</el-radio-button>
            <el-radio-button v-if="customerSourceCanViewProfit" label="grossProfit">毛利</el-radio-button>
          </el-radio-group>
        </div>
        <div ref="customerSourceChartRef" class="customer-source-chart" :style="{ height: `${Math.max(300, customerSourceChartData.rows.length * 42 + 100)}px` }"></div>
        <el-table :data="customerSourceRows" stripe v-loading="customerSourceLoading" empty-text="暂无客户来源数据">
          <el-table-column prop="dimensionName" :label="customerSourceDimensionLabel" min-width="130" />
          <el-table-column prop="customerSource" label="客户来源" min-width="130" />
          <el-table-column prop="sourceDetail" label="来源明细" min-width="130" />
          <el-table-column prop="orderCount" label="销售单数" width="100" align="right" />
          <el-table-column label="销售额" width="130" align="right"><template #default="{ row }">{{ formatCurrency(row.salesAmount) }}</template></el-table-column>
          <el-table-column v-if="customerSourceCanViewProfit" label="毛利" width="130" align="right"><template #default="{ row }">{{ formatCurrency(row.grossProfit) }}</template></el-table-column>
          <el-table-column prop="afterSalesOrderCount" label="售后单数" width="100" align="right" />
          <el-table-column label="销售类别单数" min-width="240"><template #default="{ row }"><el-tag v-for="item in row.categories" :key="item.name" size="small" effect="plain" class="source-category-tag">{{ item.name }} {{ item.orderCount }} 单</el-tag><span v-if="!row.categories?.length">-</span></template></el-table-column>
        </el-table>
      </DashboardPanel>
    </section>

    <section v-if="dashboard.kpis && activeDimension !== 'customerSource'" class="kpi-grid">
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

    <section v-show="activeDimension === 'store'" class="store-analysis">
      <DashboardPanel title="门店销售额与经营毛利对比" class="store-comparison">
        <div ref="storeComparisonRef" class="large-chart"></div>
      </DashboardPanel>
      <DashboardPanel title="门店任务达成率">
        <div class="overall-task-progress">
          <el-progress
            type="circle" :width="132" :stroke-width="12" color="#32b880"
            :percentage="Math.min(100, Math.max(0, dashboard.taskProgress?.completionRate ?? 0))"
            :format="() => dashboard.taskProgress?.completionRate == null ? '—' : `${dashboard.taskProgress.completionRate}%`"
          />
          <dl>
            <div><dt>毛利目标</dt><dd>{{ storeMoney(dashboard.taskProgress?.target) }}</dd></div>
            <div><dt>已完成毛利</dt><dd>{{ storeMoney(dashboard.taskProgress?.actual) }}</dd></div>
          </dl>
        </div>
        <p v-if="dashboard.taskProgress?.reason" class="overall-task-note">{{ dashboard.taskProgress.reason }}</p>
      </DashboardPanel>
      <DashboardPanel title="关键经营效率">
        <dl class="store-efficiency">
          <div v-for="label in ['员工人效', '库存周转天数', '库存周转率（周）']" :key="label">
            <dt>{{ label }}</dt><dd>暂不可用</dd>
          </div>
        </dl>
      </DashboardPanel>
      <DashboardPanel title="门店经营排名" class="store-ranking">
        <template #actions>
          <el-select v-model="storeRankingSort" size="small" style="width: 130px" @change="loadOverview">
            <el-option label="按销售额" value="salesAmount" />
            <el-option v-if="dashboard.meta.canViewProfit" label="按经营毛利" value="grossProfit" />
          </el-select>
        </template>
        <el-table :data="dashboard.storeRanking" size="small" max-height="290" empty-text="暂无门店经营数据">
          <el-table-column label="排名" width="55">
            <template #default="{ $index }"><span class="store-rank" :class="`rank-${$index + 1}`">{{ $index + 1 }}</span></template>
          </el-table-column>
          <el-table-column prop="storeName" label="门店" min-width="94" show-overflow-tooltip />
          <el-table-column label="销售额" min-width="108" align="right"><template #default="{ row }">{{ storeMoney(row.salesAmount) }}</template></el-table-column>
          <el-table-column v-if="dashboard.meta.canViewProfit" label="经营毛利" min-width="104" align="right"><template #default="{ row }">{{ storeMoney(row.grossProfit) }}</template></el-table-column>
          <el-table-column v-if="dashboard.meta.canViewProfit" label="毛利率" width="72" align="right"><template #default="{ row }">{{ row.grossMargin == null ? '—' : row.grossMargin + '%' }}</template></el-table-column>
          <el-table-column v-if="dashboard.meta.canViewProfit" label="任务完成率" width="94" align="right"><template #default="{ row }">{{ row.taskCompletionRate == null ? '—' : row.taskCompletionRate + '%' }}</template></el-table-column>
          <el-table-column prop="orderCount" label="成交单量" width="82" align="right" />
          <el-table-column v-if="dashboard.meta.canViewProfit" label="库存金额" min-width="110" align="right"><template #default="{ row }">{{ storeMoney(row.inventoryAmount) }}</template></el-table-column>
          <el-table-column label="操作" width="62"><template #default="{ row }"><el-button link type="primary" @click="openStoreAnalysis(row)">详情</el-button></template></el-table-column>
        </el-table>
      </DashboardPanel>
      <DashboardPanel title="门店销售趋势" class="store-trend">
        <template #actions>
          <el-radio-group v-model="storeTrendMetric" size="small" @change="renderStoreCharts">
            <el-radio-button label="salesAmount">销售额</el-radio-button>
            <el-radio-button v-if="dashboard.meta.canViewProfit" label="grossProfit">经营毛利</el-radio-button>
          </el-radio-group>
          <el-radio-group v-model="filters.granularity" size="small" @change="loadOverview">
            <el-radio-button label="day">日</el-radio-button>
            <el-radio-button label="week">周</el-radio-button>
            <el-radio-button label="month">月</el-radio-button>
          </el-radio-group>
        </template>
        <div ref="storeTrendRef" class="large-chart"></div>
      </DashboardPanel>
    </section>

    <DashboardPanel
      v-if="activeDimension === 'store' && storeFinance.state !== 'hidden'"
      title="门店财务经营利润"
      class="store-finance-panel"
      v-loading="storeFinance.state === 'loading'"
    >
      <p v-if="storeFinance.state === 'filtered'" class="overall-task-note">财务利润按区域、门店和日期查询。清除员工及产品线筛选后查询。</p>
      <el-alert v-else-if="storeFinance.state === 'error'" type="error" :closable="false" title="门店财务经营利润暂不可用，请重新查询。" />
      <el-table v-else-if="storeFinance.state === 'ready'" :data="storeFinance.rows" row-key="storeId" size="small" empty-text="当前范围暂无门店利润数据">
        <el-table-column prop="storeName" label="门店" min-width="120" />
        <el-table-column label="总毛利" min-width="120" align="right">
          <template #default="{ row }">{{ storeMoney(row.operatingMetrics?.grossProfit) }}</template>
        </el-table-column>
        <el-table-column label="成本（经营费用）" min-width="140" align="right">
          <template #default="{ row }">{{ storeMoney(row.operatingMetrics?.cost ?? row.summary?.operatingExpense) }}</template>
        </el-table-column>
        <el-table-column label="经营利润" min-width="120" align="right">
          <template #default="{ row }">
            <span :class="profitTone(storeFinancialProfit(row))">{{ storeMoney(storeFinancialProfit(row)) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="核实状态" min-width="115">
          <template #default="{ row }">
            {{ row.operatingMetrics?.operatingProfit != null ? '已核实' : storeFinancialProfit(row) != null ? '暂估 · 待核实' : '待核算' }}
          </template>
        </el-table-column>
      </el-table>
    </DashboardPanel>

    <section v-show="showSection('trend') && activeDimension !== 'employee'" class="chart-grid trend-section">
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
      <DashboardPanel v-if="activeDimension === 'overall'" title="毛利任务完成进度">
        <template #actions><el-button link type="primary" @click="router.push('/sales/monthly-tasks')">目标设置</el-button></template>
        <div class="overall-task-progress">
          <el-progress type="circle" :width="150" :stroke-width="11" :percentage="Math.min(100,Math.max(0,dashboard.taskProgress?.completionRate || 0))" color="#65be4d" :format="() => dashboard.taskProgress?.completionRate == null ? '未配置' : `${dashboard.taskProgress.completionRate}%`" />
          <dl><div><dt>本期毛利任务</dt><dd>{{ dashboard.taskProgress?.target == null ? '未配置' : formatCurrency(dashboard.taskProgress.target) }}</dd></div><div><dt>已完成毛利</dt><dd>{{ dashboard.taskProgress?.actual == null ? '不可用' : formatCurrency(dashboard.taskProgress.actual) }}</dd></div><div><dt>差额</dt><dd>{{ dashboard.taskProgress?.remaining == null ? '—' : formatCurrency(dashboard.taskProgress.remaining) }}</dd></div></dl>
        </div>
        <p class="overall-task-note">{{ dashboard.taskProgress?.reason || '任务按月度毛利目标、自然日折算；实际沿用本页毛利口径。' }}</p>
      </DashboardPanel>
    </section>

    <section v-if="activeDimension === 'employee'" class="employee-analysis-layout">
      <DashboardPanel title="员工销售业绩排名（按经营毛利排序）">
        <el-table :data="dashboard.employeeRanking" size="small" height="420" empty-text="暂无员工经营数据">
          <el-table-column type="index" label="排名" width="56" />
          <el-table-column prop="employeeName" label="员工" min-width="100" />
          <el-table-column label="销售额" min-width="120" align="right"><template #default="{ row }">{{ formatCurrency(row.salesAmount) }}</template></el-table-column>
          <el-table-column label="毛利额" min-width="120" align="right"><template #default="{ row }">{{ dashboard.meta.canViewProfit ? formatCurrency(row.grossProfit) : '不可用' }}</template></el-table-column>
          <el-table-column label="毛利率" width="90" align="right"><template #default="{ row }">{{ employeeMargin(row) }}</template></el-table-column>
          <el-table-column prop="participatedOrderCount" label="成交单量" width="90" align="right" />
          <el-table-column label="每单毛利" width="105" align="right"><template #default="{ row }">{{ employeeAverageProfit(row) }}</template></el-table-column>
          <el-table-column label="任务完成率" width="105" align="right"><template #default>不可用</template></el-table-column>
          <el-table-column label="操作" width="68"><template #default="{ row }"><el-button link type="primary" @click="focusEmployee(row)">查看</el-button></template></el-table-column>
        </el-table>
      </DashboardPanel>
      <div class="employee-analysis-side">
        <DashboardPanel title="个人业绩趋势（销售额 / 毛利额）">
          <template #actions><el-select v-model="filters.employeeId" clearable filterable placeholder="选择员工" style="width: 150px" @change="loadOverview"><el-option label="全部员工" value="" /><el-option v-for="employee in filterOptions.employees" :key="employee.staffId" :label="employee.name" :value="String(employee.staffId)" /></el-select></template>
          <div ref="employeeTrendRef" class="employee-trend-chart"></div>
        </DashboardPanel>
        <div class="employee-bottom-grid">
          <DashboardPanel title="毛利贡献占比（Top5 员工）"><div ref="employeeContributionRef" class="employee-donut-chart"></div></DashboardPanel>
          <DashboardPanel title="员工分析说明"><div class="employee-note"><strong>统计口径</strong><p>销售额、毛利额和成交单量沿用经营看板 API；多人参与订单按后台分配结果展示。</p><p>任务完成率当前接口未返回，显示为不可用，待后台提供统一任务指标后接入。</p></div></DashboardPanel>
        </div>
      </div>
    </section>

    <section v-show="activeDimension !== 'employee' && (showSection('store') || showSection('employee') || showSection('productLine'))" class="analysis-grid ranking-section">
      <DashboardPanel v-show="showSection('store')" :title="activeDimension === 'store' ? '门店销售品类明细' : '门店经营排名'">
        <template v-if="activeDimension === 'overall'" #actions>
          <el-select v-model="storeRankingSort" style="width:160px" size="small" @change="loadOverview"><el-option label="按销售额排名" value="salesAmount" /><el-option v-if="dashboard.meta.canViewProfit" label="按毛利额排名" value="grossProfit" /><el-option v-if="dashboard.meta.canViewProfit" label="按毛利率排名" value="grossMargin" /><el-option v-if="dashboard.meta.canViewProfit" label="按任务完成率排名" value="taskCompletionRate" /><el-option v-if="dashboard.meta.canViewProfit" label="按库存金额排名" value="inventoryAmount" /></el-select>
        </template>
        <el-table v-if="activeDimension === 'overall'" :data="dashboard.storeRanking" size="small" empty-text="暂无门店经营数据" @sort-change="onStoreRankingSort">
          <el-table-column type="index" label="排名" width="55" />
          <el-table-column prop="storeName" label="门店" min-width="135" />
          <el-table-column prop="salesAmount" sortable="custom" label="销售额" min-width="135" align="right"><template #default="{row}">{{ formatCurrency(row.salesAmount) }}</template></el-table-column>
          <el-table-column label="同比" width="105" align="right"><template #default="{row}"><ComparisonValue :value="row.yoy" /></template></el-table-column>
          <el-table-column label="环比" width="105" align="right"><template #default="{row}"><ComparisonValue :value="row.periodCompare" /></template></el-table-column>
          <el-table-column v-if="dashboard.meta.canViewProfit" prop="grossProfit" sortable="custom" label="毛利额" min-width="130" align="right"><template #default="{row}">{{ formatCurrency(row.grossProfit) }}</template></el-table-column>
          <el-table-column v-if="dashboard.meta.canViewProfit" prop="grossMargin" sortable="custom" label="毛利率" width="105" align="right"><template #default="{row}">{{ row.grossMargin == null ? '—' : `${row.grossMargin}%` }}</template></el-table-column>
          <el-table-column v-if="dashboard.meta.canViewProfit" prop="taskCompletionRate" sortable="custom" label="任务完成率" min-width="155"><template #default="{row}"><el-progress v-if="row.taskCompletionRate != null" :percentage="Math.min(100,Math.max(0,row.taskCompletionRate))" :format="()=>`${row.taskCompletionRate}%`" /><span v-else>未配置</span></template></el-table-column>
          <el-table-column v-if="dashboard.meta.canViewProfit" prop="inventoryAmount" sortable="custom" label="库存金额" min-width="145" align="right"><template #default="{row}">{{ formatCurrency(row.inventoryAmount) }}</template></el-table-column>
          <el-table-column prop="laptopOrderCount" label="笔记本" width="82" align="right" />
          <el-table-column prop="tabletOrderCount" label="平板" width="72" align="right" />
          <el-table-column prop="phoneOrderCount" label="手机" width="72" align="right" />
          <el-table-column prop="desktopOrderCount" label="台机" width="72" align="right" />
          <el-table-column prop="serviceOrderCount" label="服务" width="72" align="right" />
          <el-table-column label="销售趋势（7日）" width="155"><template #default="{row}"><svg viewBox="0 0 140 36" width="140" height="36" role="img" :aria-label="`${row.storeName}最近7日销售趋势`"><title>{{ (row.salesTrend||[]).map(point=>`${point.bucket}：${point.salesAmount}元`).join('；') }}</title><polyline :points="sparklinePoints(row.salesTrend)" fill="none" stroke="#3478ff" stroke-width="2" /></svg></template></el-table-column>
          <el-table-column label="操作" width="90"><template #default="{row}"><el-button link type="primary" @click="openStoreAnalysis(row)">查看详情</el-button></template></el-table-column>
        </el-table>
        <el-table v-else :data="dashboard.storeRanking" class="store-ranking-table" size="small" height="260" table-layout="fixed" empty-text="暂无门店销售数据">
          <el-table-column type="index" label="排名" width="42" />
          <el-table-column label="门店" width="90" show-overflow-tooltip>
            <template #default="{ row }">
              <span>{{ row.storeName }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="salesAmount" sortable label="销售额" min-width="130" align="right"><template #default="{ row }">{{ formatCurrency(row.salesAmount) }}</template></el-table-column>
          <el-table-column v-if="dashboard.meta.canViewProfit" prop="grossProfit" sortable label="销售毛利" min-width="130" align="right"><template #default="{ row }">{{ formatCurrency(row.grossProfit) }}</template></el-table-column>
          <el-table-column v-for="device in storeDeviceColumns" :key="device.key" :label="device.label" :width="device.width" align="right">
            <template #default="{ row }">
              <el-tooltip placement="top" effect="light" :show-after="250">
                <template #content>
                  <div class="store-ranking-tooltip">
                    <strong>{{ device.label }}四级分类</strong>
                    <span v-for="item in storeDeviceCategories(row, device.key)" :key="item.name">{{ item.name }}：{{ formatNumber(item.quantity) }} 台</span>
                    <span v-if="!storeDeviceCategories(row, device.key).length">分类明细暂不可用</span>
                  </div>
                </template>
                <span class="store-device-quantity">{{ formatNumber(row[device.key]) }}</span>
              </el-tooltip>
            </template>
          </el-table-column>
        </el-table>
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

      <DashboardPanel v-show="showSection('productLine')" title="产品线经营分析">
        <template #actions><el-button v-if="filters.productLine" link type="primary" @click="resetProductCategory">返回一级分类</el-button></template>
        <div class="category-breadcrumb">
          <button class="category-crumb" :class="{ active: !filters.productLine }" @click="resetProductCategory">全部产品线</button>
          <template v-for="(part, index) in productCategoryPath" :key="part.path"><span class="category-separator">/</span><button class="category-crumb" :class="{ active: index === productCategoryPath.length - 1 }" @click="selectProductCategory(part.path)">{{ part.name }}</button></template>
          <span class="category-hint">点击分类进入下一级</span>
        </div>
        <div class="category-analysis-grid">
          <div ref="productLineRef" class="medium-chart category-chart"></div>
          <el-table :data="currentProductCategories" size="small" class="category-table" empty-text="当前范围暂无分类数据">
            <el-table-column type="index" label="排名" width="56" />
            <el-table-column label="分类" min-width="140"><template #default="{ row }"><el-button v-if="row.children?.length" link type="primary" @click="selectProductCategory(row.path)">{{ row.name }}</el-button><span v-else>{{ row.name }}</span></template></el-table-column>
            <el-table-column label="销售额" width="130" align="right"><template #default="{ row }">{{ formatCurrency(row.salesAmount) }}</template></el-table-column>
            <el-table-column label="销售占比" width="100" align="right"><template #default="{ row }">{{ categoryShare(row) }}%</template></el-table-column>
            <el-table-column label="毛利额" width="120" align="right"><template #default="{ row }">{{ dashboard.meta.canViewProfit ? formatCurrency(row.grossProfit) : '不可用' }}</template></el-table-column>
            <el-table-column label="毛利率" width="95" align="right"><template #default="{ row }">{{ dashboard.meta.canViewProfit && row.grossMargin != null ? `${row.grossMargin}%` : '不可用' }}</template></el-table-column>
            <el-table-column prop="orderCount" label="成交单量" width="90" align="right" />
          </el-table>
        </div>
      </DashboardPanel>
    </section>

    <section v-show="showSection('product')" class="product-grid product-section">
      <DashboardPanel title="产品销售额 Top10">
        <ProductTable
          :rows="dashboard.productAnalysis.salesTop10"
          value-key="salesAmount"
          value-label="销售额"
          variant="sales"
          :can-view-profit="dashboard.meta.canViewProfit"
        />
      </DashboardPanel>
      <DashboardPanel title="高毛利产品排行榜（笔记本、手机、平板、台机）">
        <ProductTable
          :rows="dashboard.productAnalysis.highMarginTop10"
          value-key="grossMargin"
          value-label="毛利率"
          value-type="percent"
          variant="profit"
          :can-view-profit="dashboard.meta.canViewProfit"
        />
      </DashboardPanel>
      <DashboardPanel title="重点分类销售情况">
        <div class="panel-note">由商品分类管理统一设置，包含下级分类；重叠分类独立展示。</div>
        <ProductTable v-if="dashboard.productAnalysis.focusCategoryMode === 'category'"
          :rows="dashboard.productAnalysis.focusCategories || []" value-key="salesAmount"
          value-label="销售额" variant="focus" :can-view-profit="dashboard.meta.canViewProfit" />
        <el-alert v-else title="分类统计接口尚未升级，请部署后台后查看" type="info" :closable="false" />
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
  Money,
  Shop,
  UserFilled
} from '@element-plus/icons-vue'
import * as echarts from 'echarts'
import api from '../api'
import { useRouter } from 'vue-router'
const router = useRouter()
const storeRankingSort = ref('salesAmount')
function onStoreRankingSort({prop}) { storeRankingSort.value=prop || 'salesAmount'; loadOverview() }
function openStoreAnalysis(row) { filters.storeId=String(row.storeId);activeDimension.value='store';loadOverview() }
function sparklinePoints(rows=[]) {
  const values=rows.map(r=>Number(r.salesAmount || 0)), min=Math.min(...values), max=Math.max(...values);
  return values.map((value,i)=>`${4+i*132/Math.max(1,values.length-1)},${max===min?18:32-(value-min)/(max-min)*28}`).join(' ')
}

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
    variant: { type: String, default: 'sales' },
    canViewProfit: { type: Boolean, default: false }
  },
  setup(props) {
    const format = value => props.valueType === 'percent'
      ? `${Number(value || 0).toFixed(2)}%`
      : formatCurrency(value)
    return () => {
      const showQuantity = props.variant === 'sales' || props.variant === 'focus'
      const showGrossProfit = props.variant === 'profit' || (props.variant === 'focus' && props.canViewProfit)
      return h('div', {
        class: [
          'product-table',
          `product-table--${props.variant}`,
          { 'product-table--with-profit': showGrossProfit }
        ]
      }, [
        h('div', { class: 'product-table-head' }, [
          h('span', '排名'),
          h('span', props.variant === 'focus' ? '重点分类' : '产品名称'),
          ...(showQuantity ? [h('span', '销量')] : []),
          h('span', props.valueLabel),
          ...(showGrossProfit ? [h('span', props.variant === 'focus' ? '销售端毛利' : '毛利额')] : [])
        ]),
        ...(props.rows.length ? (props.variant === 'focus' ? props.rows : props.rows.slice(0, 10)).map((row, index) => h(
          'div',
          { class: 'product-table-row', key: row.productId || index },
          [
            h('b', { class: index < 3 ? `rank rank-${index + 1}` : 'rank' }, String(index + 1)),
            h('div', { class: 'product-name-cell', title: row.categoryPath || row.productName }, [
              h('span', row.productName),
              row.manufacturerCode ? h('small', row.manufacturerCode) : null
            ]),
            ...(showQuantity ? [h('span', { class: 'product-quantity' }, `${formatNumber(row.quantity)}${row.unit ? ' ' + row.unit : ''}`)] : []),
            h('strong', format(row[props.valueKey])),
            ...(showGrossProfit ? [h('strong', { class: 'gross-profit-value' }, formatCurrency(row.grossProfit))] : [])
          ]
        )) : [h('div', { class: 'empty-row' }, props.variant === 'focus' ? '尚未设置重点分类，请在商品分类管理中设置' : '暂无数据')])
      ])
    }
  }
})

const loading = ref(false)
const errorMessage = ref('')
const datePickerRef = ref(null)
const storeComparisonRef = ref(null)
const storeTrendRef = ref(null)
const storeFinance = reactive({ state: 'hidden', rows: [] })
const storeTrendMetric = ref('salesAmount')
const salesTrendRef = ref(null)
const profitTrendRef = ref(null)
const productLineRef = ref(null)
const employeeTrendRef = ref(null)
const employeeContributionRef = ref(null)
const inventoryAgeRef = ref(null)
const quickRange = ref('week')
const storeDeviceColumns = [
  { key: 'laptopQuantity', label: '笔记本', width: 72 },
  { key: 'phoneQuantity', label: '手机', width: 58 },
  { key: 'tabletQuantity', label: '平板', width: 58 },
  { key: 'desktopQuantity', label: '台机', width: 58 }
]
const activeDimension = ref('overall')
const charts = new Map()

const dimensionTabs = [
  { label: '总体', value: 'overall', icon: DataAnalysis },
  { label: '门店', value: 'store', icon: Shop },
  { label: '员工', value: 'employee', icon: UserFilled },
  { label: '产品线', value: 'productLine', icon: Coin },
  { label: '产品', value: 'product', icon: Box },
  { label: '客户来源', value: 'customerSource', icon: DataAnalysis }
]

const filterOptions = reactive({ stores: [], employees: [], productLines: [], regions: [] })
const filters = reactive({ regionId: '', storeId: '', employeeId: '', productLine: '', granularity: 'day' })
let focusOverviewSequence = 0
const dateRange = ref(currentWeekRange())
const dashboard = reactive(emptyDashboard())
const customerSourceDimension = ref('store')
const customerSourceDimensionLabel = computed(() => ({ company: '公司', store: '门店', employee: '员工' }[customerSourceDimension.value] || '公司'))
const customerSourceMetric = ref('salesAmount')
const customerSourceChartRef = ref(null)
const sourceSalesRef = ref(null)
const sourceProfitRef = ref(null)
const sourceTrendRef = ref(null)
const sourceDistribution = ref([])
const categorySourceDistribution = ref([])
const customerSourceCategoryOptions = ref([])
const customerSourceCategory = ref('')
const customerSourceRows = ref([])
const customerSourceSummary = ref({})
const customerSourceCanViewProfit = ref(false)
const customerSourceLoading = ref(false)
// 顶部“产品线”是全局筛选；产品线经营分析内部点击的下级分类只在本板块内导航。
const productCategoryPathValue = ref('')
const productCategoryPath = computed(() => String(productCategoryPathValue.value || '').split('/').filter(Boolean).map((name, index, parts) => ({ name, path: parts.slice(0, index + 1).join('/') })))
function findCategoryNode(nodes, path) {
  for (const node of nodes || []) {
    if (node.path === path) return node
    const found = findCategoryNode(node.children, path)
    if (found) return found
  }
  return null
}
const currentProductCategories = computed(() => {
  const tree = dashboard.productCategoryAnalysis || []
  return productCategoryPathValue.value ? (findCategoryNode(tree, productCategoryPathValue.value)?.children || []) : tree
})
const customerSourceKpiCards = computed(() => [
  { key: 'orders', label: '销售单数', value: formatNumber(customerSourceSummary.value.orderCount), icon: Document, color: 'blue' },
  { key: 'sales', label: '销售额', value: formatCurrency(customerSourceSummary.value.salesAmount), icon: Money, color: 'green' },
  ...(customerSourceCanViewProfit.value ? [{ key: 'profit', label: '毛利额', value: formatCurrency(customerSourceSummary.value.grossProfit), icon: DataAnalysis, color: 'orange' }] : []),
  ...(customerSourceCanViewProfit.value ? [{ key: 'margin', label: '毛利率', value: customerSourceSummary.value.grossMargin == null ? '不可用' : `${customerSourceSummary.value.grossMargin}%`, icon: Coin, color: 'purple' }] : []),
  { key: 'average', label: '客单价', value: customerSourceSummary.value.averageOrderValue == null ? '不可用' : formatCurrency(customerSourceSummary.value.averageOrderValue), icon: UserFilled, color: 'cyan' },
  { key: 'stores', label: '涉及门店数', value: customerSourceSummary.value.storeCount == null ? '不可用' : formatNumber(customerSourceSummary.value.storeCount), icon: Shop, color: 'orange' }
])
const customerSourceChartRows = ref([])
const customerSourceChartData = computed(() => ({
  rows: [...customerSourceChartRows.value].sort((a, b) => b[customerSourceMetric.value] - a[customerSourceMetric.value]),
  sources: sourceDistribution.value.map(row => row.customerSource)
}))

function emptyDashboard() {
  return {
    meta: { canViewProfit: false },
    kpis: null,
    trend: [],
    storeRanking: [],
    employeeRanking: [],
    employeePerformanceDetails: [],
    productLineAnalysis: [],
    productCategoryAnalysis: [],
    productAnalysis: {
      salesTop10: [],
      grossProfitTop10: [],
      quantityTop10: [],
      highMarginTop10: [],
      focusProducts: []
    },
    inventory: { inventoryQuantity: 0, skuCount: 0, inventoryAmount: null, ageStructure: [], staleProducts: [] },
    decisionInsights: [],
    aiAdvisor: null
  }
}

function insightTagType(level) {
  return level === 'critical' ? 'danger' : level === 'warning' ? 'warning' : 'info'
}

function insightLevelText(level) {
  return level === 'critical' ? '高风险' : level === 'warning' ? '需关注' : '正常'
}

const kpiCards = computed(() => {
  const kpis = dashboard.kpis || {}
  return [
    card('salesAmount', '销售额', Money, 'blue', 'currency', kpis.salesAmount),
    card('grossProfit', '经营毛利', DataAnalysis, 'green', 'currency', kpis.grossProfit),
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

async function selectDimension(value) {
  activeDimension.value = value
  if (value === 'customerSource') {
    await nextTick()
    await loadCustomerSourceAnalysis()
  } else await loadOverview()
}

function selectProductCategory(path) {
  productCategoryPathValue.value = path
  renderCharts()
}

function resetProductCategory() {
  productCategoryPathValue.value = ''
  renderCharts()
}

function onProductLineFilterChange() {
  productCategoryPathValue.value = ''
  loadOverview()
}

function categoryShare(row) {
  const total = currentProductCategories.value.reduce((sum, item) => sum + Number(item.salesAmount || 0), 0)
  return total ? ((Number(row.salesAmount || 0) / total) * 100).toFixed(2) : '0.00'
}

function employeeMargin(row) {
  if (!dashboard.meta.canViewProfit || row.grossProfit == null || !Number(row.salesAmount)) return '不可用'
  return `${(Number(row.grossProfit) / Number(row.salesAmount) * 100).toFixed(2)}%`
}

function employeeAverageProfit(row) {
  if (!dashboard.meta.canViewProfit || row.grossProfit == null || !Number(row.participatedOrderCount)) return '不可用'
  return formatCurrency(Number(row.grossProfit) / Number(row.participatedOrderCount))
}

function focusEmployee(row) {
  filters.employeeId = String(row.staffId || '')
  loadOverview()
}

let customerSourceSequence = 0
async function loadCustomerSourceAnalysis() {
  if (!Array.isArray(dateRange.value) || dateRange.value.length !== 2) return
  const sequence = ++customerSourceSequence
  customerSourceLoading.value = true
  try {
    const res = await api.getCustomerSourceAnalysis({ startDate: dateRange.value[0], endDate: dateRange.value[1], dimension: customerSourceDimension.value, regionId: filters.regionId || undefined, storeId: filters.storeId || undefined, employeeId: filters.employeeId || undefined, productLine: filters.productLine || undefined })
    if (sequence !== customerSourceSequence || activeDimension.value !== 'customerSource') return
    if (res.code === 0 && res.data?.formulaVersion === 'OPERATING_FROZEN_EVENTS_V1') {
      customerSourceChartRows.value = res.data.chartRows
      customerSourceRows.value = res.data?.rows || []
      customerSourceSummary.value = res.data?.summary || {}
      sourceDistribution.value = res.data?.sourceDistribution || []
      categorySourceDistribution.value = res.data?.categorySourceDistribution || []
      customerSourceCategoryOptions.value = res.data?.productCategoryOptions || []
      if (customerSourceCategory.value && !customerSourceCategoryOptions.value.includes(customerSourceCategory.value)) customerSourceCategory.value = ''
      customerSourceCanViewProfit.value = Boolean(res.data?.canViewProfit)
      if (!customerSourceCanViewProfit.value && customerSourceMetric.value === 'grossProfit') customerSourceMetric.value = 'salesAmount'
      await nextTick()
      renderCustomerSourceChart()
    } else {
      throw new Error('统一经营流水的客户来源数据暂不可用')
    }
  } catch (error) {
    if (sequence !== customerSourceSequence || activeDimension.value !== 'customerSource') return
    customerSourceRows.value = []
    customerSourceChartRows.value = []
    customerSourceSummary.value = {}
    sourceDistribution.value = []
    categorySourceDistribution.value = []
    customerSourceCanViewProfit.value = false
    renderCustomerSourceChart()
    ElMessage.error(error.response?.data?.message || error.message || '客户来源分析加载失败')
  } finally {
    if (sequence === customerSourceSequence) customerSourceLoading.value = false
  }
}

function showSection(section) {
  if (activeDimension.value === 'overall') return ['trend', 'store'].includes(section)
  if (activeDimension.value === 'customerSource') return false
  if (section === 'trend') return ['employee', 'productLine', 'product'].includes(activeDimension.value)
  return activeDimension.value === section
}

async function loadFilterOptions() {
  try {
    const res = await api.getDashboardFilters()
    if (res.code === 0) Object.assign(filterOptions, res.data || {}, { regions: res.data?.regions || [] })
  } catch (error) {
    ElMessage.error(error.response?.data?.message || '筛选条件加载失败')
  }
}

async function loadOverview() {
  if (activeDimension.value === 'customerSource') return loadCustomerSourceAnalysis()
  const sequence = ++focusOverviewSequence
  if (!Array.isArray(dateRange.value) || dateRange.value.length !== 2) {
    ElMessage.warning('请选择日期范围')
    return
  }
  loading.value = true
  errorMessage.value = ''
  Object.assign(storeFinance, { state: 'hidden', rows: [] })
  try {
    const params = {
      startDate: dateRange.value[0],
      endDate: dateRange.value[1],
      regionId: filters.regionId || undefined,
      storeId: filters.storeId || undefined,
      employeeId: filters.employeeId || undefined,
      productLine: filters.productLine || undefined,
      granularity: filters.granularity,
      overallMetrics: ['overall', 'store'].includes(activeDimension.value) ? '1' : undefined,
      storeSort: storeRankingSort.value,
    }
    const res = await api.getDashboardOverview(params)
    if(sequence!==focusOverviewSequence)return
    if (res.code === 0) {
      Object.assign(dashboard, emptyDashboard(), res.data || {})
      await nextTick()
      renderCharts()
      if (activeDimension.value === 'store') void loadStoreFinance(params, sequence)
    }
  } catch (error) {
    if(sequence===focusOverviewSequence)errorMessage.value = error.response?.data?.message || error.message || '经营看板加载失败'
  } finally {
    if(sequence===focusOverviewSequence)loading.value = false
  }
}

async function loadStoreFinance({ startDate, endDate, regionId, storeId, employeeId, productLine }, sequence) {
  if (employeeId || productLine) {
    storeFinance.state = 'filtered'
    return
  }
  storeFinance.state = 'loading'
  const isCurrent = () => sequence === focusOverviewSequence && activeDimension.value === 'store'
  try {
    const response = await api.getFinancialProfitOrders({
      mobile: '1', startDate, endDate, regionId, storeId, page: 1, pageSize: 1
    })
    if (!isCurrent()) return
    const data = response.data
    if (response.code !== 0 || !Array.isArray(data?.storeSummaries)) {
      storeFinance.state = 'error'
      return
    }
    Object.assign(storeFinance, { state: 'ready', rows: data.storeSummaries })
  } catch (error) {
    if (isCurrent()) storeFinance.state = error.response?.status === 403 ? 'hidden' : 'error'
  }
}

function storeFinancialProfit({ operatingMetrics }) {
  return operatingMetrics?.operatingProfit ?? operatingMetrics?.estimatedOperatingProfit
}

function profitTone(value) {
  if (Number(value) > 0) return 'store-profit-positive'
  if (Number(value) < 0) return 'store-profit-negative'
  return ''
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

function renderCustomerSourceChart() {
  for (const [element, key, field] of [[sourceSalesRef.value, 'sourceSales', 'salesAmount'], [sourceProfitRef.value, 'sourceProfit', 'grossProfit']]) {
    const chart = getChart(element, key)
    if (!chart) continue
    const available = field !== 'grossProfit' || customerSourceCanViewProfit.value
    const rows = available ? sourceDistribution.value : []
    chart.setOption({
      color: [field === 'grossProfit' ? '#32b880' : '#2874f8'],
      tooltip: { trigger: 'axis', valueFormatter: storeMoney },
      grid: { left: 8, right: 16, top: 12, bottom: 8, containLabel: true },
      xAxis: { type: 'category', data: rows.map(row => row.customerSource), axisLabel: { hideOverlap: true } },
      yAxis: { type: 'value', axisLabel: { formatter: compactNumber } },
      dataZoom: rows.length > 10 ? [{ type: 'inside', endValue: 9 }] : [],
      series: [{ type: 'bar', barMaxWidth: 24, data: rows.map(row => row[field]) }],
      title: available ? undefined : { text: '无毛利查看权限', left: 'center', top: 'middle', textStyle: { fontSize: 13 } }
    }, true)
  }
  const trendChart = getChart(sourceTrendRef.value, 'sourceTrend')
  if (trendChart) {
    const rows = categorySourceDistribution.value.filter(row => !customerSourceCategory.value || row.category === customerSourceCategory.value)
    const counts = customerSourceCategory.value ? rows : sourceDistribution.value
    trendChart.setOption({ color: ['#3084ff', '#66c587', '#ffd43b', '#ff766c', '#60cddd', '#9c80ed', '#a5adba'], tooltip: { trigger: 'item', formatter: '{b}<br/>单数：{c} 单（{d}%）' }, legend: { type: 'scroll', orient: 'vertical', right: 0, top: 'middle' }, series: [{ type: 'pie', radius: ['48%', '73%'], center: ['32%', '50%'], label: { show: false }, data: counts.map(row => ({ name: row.customerSource, value: row.orderCount })) }] }, true)
  }
  const { rows, sources } = customerSourceChartData.value
  const valueKey = customerSourceMetric.value
  const valueLabel = { salesAmount: '销售额', orderCount: '订单数', grossProfit: '毛利' }[valueKey] || '销售额'
  const formatValue = value => valueKey === 'orderCount' ? `${formatNumber(value)} 单` : formatCurrency(value)
  const chart = getChart(customerSourceChartRef.value, 'customerSource')
  if (!chart) return
  chart.resize()
  if (!rows.length) {
    chart.clear()
    return
  }
  const dataZoom = []
  chart.setOption({
    color: ['#3978d4', '#27a875', '#f2a93b', '#e56c72', '#36a8bd', '#8965ca', '#ee8152', '#70849d', '#bd6caa', '#6b9f48'],
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: params => {
        const entityName = params?.[0]?.axisValue || ''
        const lines = params
          .filter(item => Number(item.value || 0) !== 0)
          .map(item => `${item.marker}${item.seriesName}：${formatValue(item.value)}`)
        return `${entityName}<br/>${lines.join('<br/>') || '暂无客户来源数据'}`
      }
    },
    legend: {
      type: 'scroll',
      top: 0,
      left: 125,
      right: 22,
      height: 34,
      textStyle: { color: '#53627a', fontSize: 12 },
      data: sources
    },
    grid: { left: 130, right: 24, top: 48, bottom: 30, containLabel: false },
    xAxis: {
      type: 'value',
      axisLabel: { color: '#7a8799', formatter: value => valueKey === 'orderCount' ? formatNumber(value) : `¥${compactNumber(value)}` },
      splitLine: { lineStyle: { type: 'dashed', color: '#e8edf4' } }
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: rows.map(row => row.name),
      axisLabel: { color: '#53627a', width: 112, overflow: 'truncate' },
      axisTick: { show: false }
    },
    dataZoom,
    series: sources.map(source => ({
      name: source,
      type: 'bar',
      stack: 'customer-source',
      barMaxWidth: 22,
      emphasis: { focus: 'series' },
      data: rows.map(row => Object.hasOwn(row.sources, source) ? row.sources[source][valueKey] : null)
    }))
  }, true)
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

function storeMoney(value) {
  return value == null ? '—' : formatCurrency(value)
}

function renderStoreCharts() {
  if (activeDimension.value !== 'store') return
  const rows = dashboard.storeRanking
  const canViewProfit = dashboard.meta.canViewProfit
  const colors = ['#2874f8', '#32b880']
  const moneyAxis = { type: 'value', axisLabel: { formatter: compactNumber }, splitLine: { lineStyle: { color: '#edf1f8' } } }
  const categoryAxis = data => ({ type: 'category', data, axisLabel: { hideOverlap: true }, axisTick: { show: false } })
  const sales = { key: 'salesAmount', name: '销售额' }
  const profit = { key: 'grossProfit', name: '经营毛利' }
  getChart(storeComparisonRef.value, 'storeComparison')?.setOption({
    color: colors,
    tooltip: { trigger: 'axis', valueFormatter: storeMoney },
    legend: { top: 0 },
    grid: { left: 12, right: 16, top: 36, bottom: 12, containLabel: true },
    xAxis: categoryAxis(rows.map(row => row.storeName)),
    yAxis: moneyAxis,
    series: (canViewProfit ? [sales, profit] : [sales]).map(({ key, name }) => ({
      name, type: 'bar', barMaxWidth: 28,
      itemStyle: { borderRadius: [4, 4, 0, 0] },
      data: rows.map(row => row[key])
    }))
  }, true)

  const metric = canViewProfit && storeTrendMetric.value === profit.key ? profit : sales
  getChart(storeTrendRef.value, 'storeTrend')?.setOption({
    color: colors,
    tooltip: { trigger: 'axis', valueFormatter: storeMoney },
    grid: { left: 12, right: 16, top: 16, bottom: 12, containLabel: true },
    xAxis: categoryAxis(dashboard.trend.map(row => row.bucket)),
    yAxis: moneyAxis,
    series: [{
      name: metric.name, type: 'line', smooth: true, symbolSize: 6,
      areaStyle: { opacity: 0.08 }, data: dashboard.trend.map(row => row[metric.key])
    }]
  }, true)
  if (rows.length) resizeCharts()
}

function renderCharts() {
  renderStoreCharts()
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

  getChart(productLineRef.value, 'productLine')?.setOption({
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: params => `${params[0]?.name}<br/>销售额：${formatCurrency(params[0]?.value)}` },
    grid: { left: 12, right: 24, top: 16, bottom: 36, containLabel: true },
    xAxis: { type: 'category', data: currentProductCategories.value.map(row => row.name), axisLabel: { color: '#53627a', interval: 0, rotate: currentProductCategories.value.length > 6 ? 25 : 0 } },
    yAxis: { type: 'value', axisLabel: { color: '#7a8799', formatter: value => compactNumber(value) }, splitLine: { lineStyle: { type: 'dashed', color: '#e8edf4' } } },
    series: [{ type: 'bar', barMaxWidth: 28, itemStyle: { color: '#4d8df7', borderRadius: [4, 4, 0, 0] }, data: currentProductCategories.value.map(row => row.salesAmount) }]
  }, true)

  getChart(employeeTrendRef.value, 'employeeTrend')?.setOption({
    tooltip: { trigger: 'axis' },
    legend: { top: 0, data: ['销售额（元）', '毛利额（元）'] },
    grid: { left: 52, right: 18, top: 34, bottom: 30 },
    xAxis: { type: 'category', data: dashboard.trend.map(row => row.bucket), axisLabel: { color: '#67758a' } },
    yAxis: { type: 'value', axisLabel: { color: '#67758a', formatter: value => compactNumber(value) }, splitLine: { lineStyle: { type: 'dashed', color: '#e8edf4' } } },
    series: [
      { name: '销售额（元）', type: 'bar', barMaxWidth: 24, itemStyle: { color: '#4d8df7', borderRadius: [4, 4, 0, 0] }, data: dashboard.trend.map(row => row.salesAmount) },
      { name: '毛利额（元）', type: 'bar', barMaxWidth: 24, itemStyle: { color: '#54b879', borderRadius: [4, 4, 0, 0] }, data: dashboard.trend.map(row => row.grossProfit) }
    ]
  }, true)

  const topEmployees = (dashboard.employeeRanking || []).slice(0, 5)
  getChart(employeeContributionRef.value, 'employeeContribution')?.setOption({
    tooltip: { trigger: 'item', formatter: params => `${params.name}<br/>毛利额：${formatCurrency(params.value)}<br/>占比：${params.percent}%` },
    legend: { orient: 'vertical', right: 0, top: 'center', type: 'scroll' },
    series: [{ type: 'pie', radius: ['45%', '72%'], center: ['34%', '52%'], label: { show: false }, data: dashboard.meta.canViewProfit ? topEmployees.map(row => ({ name: row.employeeName, value: row.grossProfit })) : [] }]
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

function storeDeviceCategories(row, key) {
  return row?.categoryBreakdown?.[key] || []
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
  min-width: 0;
  color: var(--text);
  padding: 2px 2px 18px;
}

.filter-panel {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: #f8fbff;
  box-shadow: 0 2px 8px rgba(35, 59, 96, 0.035);
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
  gap: 4px;
  padding: 0 6px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 12px;
}

.dimension-tabs button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  position: relative;
  border: 0;
  background: transparent;
  padding: 12px 14px;
  color: #344156;
  cursor: pointer;
}

.dimension-tab-icon {
  font-size: 15px;
}

.dimension-tabs button.active {
  color: var(--primary);
  font-weight: 600;
}

.dimension-tabs button:hover {
  color: var(--primary);
  background: #f3f7ff;
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

.trend-section { grid-template-columns: repeat(12, minmax(0, 1fr)); }
.trend-section .dashboard-panel:first-child { grid-column: span 7; }
.trend-section .dashboard-panel:last-child { grid-column: span 5; }

.analysis-grid,
.product-grid,
.inventory-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 10px;
}

.ranking-section, .product-section { grid-template-columns: repeat(12, minmax(0, 1fr)); }
.ranking-section .dashboard-panel:first-child { grid-column: span 7; }
.ranking-section .dashboard-panel:nth-child(2) { grid-column: span 5; }
.ranking-section .dashboard-panel:nth-child(3) { grid-column: 1 / -1; }
.product-section .dashboard-panel { grid-column: span 4; }

.customer-source-section {
  display: grid;
  gap: 10px;
}
.source-overview-grid { display: grid; grid-template-columns: 1fr 1fr 1.5fr; gap: 14px; }
@media (max-width: 980px) { .source-overview-grid { grid-template-columns: 1fr; } }

.customer-source-section .customer-source-kpi-grid { margin-bottom: 0; }
.customer-source-section .customer-source-kpi-grid .kpi-card { min-height: 96px; }
.customer-source-section .dashboard-panel { box-shadow: 0 4px 16px rgba(35, 59, 96, 0.06); }
.customer-source-section .el-table { margin-top: 10px; }

.dashboard-panel {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 3px 12px rgba(35, 59, 96, 0.04);
}

.dashboard-panel :deep(.panel-header) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 42px;
  padding: 0 14px;
  border-bottom: 1px solid #eef1f5;
  background: linear-gradient(180deg, #fff, #fbfcfe);
}

.dashboard-panel :deep(.panel-header h3) {
  margin: 0;
  color: #1f2b3d;
  font-size: 14px;
  font-weight: 700;
}

.dashboard-panel :deep(.panel-actions) {
  color: var(--muted);
  font-size: 11px;
}

.dashboard-panel :deep(.panel-body) {
  padding: 10px 12px 12px;
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

.product-table :deep(.product-table-head),
.product-table :deep(.product-table-row) {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) 58px 102px;
  align-items: center;
  min-height: 34px;
  column-gap: 8px;
  font-size: 12px;
}

.product-table {
  --list-accent: #1769e0;
  --list-soft: #edf5ff;
  min-height: 174px;
}

.product-table--profit {
  --list-accent: #1f9d68;
  --list-soft: #eaf8f1;
}

.product-table--profit :deep(.product-table-head),
.product-table--profit :deep(.product-table-row) {
  grid-template-columns: 42px minmax(0, 1fr) 72px 102px;
}

.product-table--focus {
  --list-accent: #e58a17;
  --list-soft: #fff5e6;
}

.product-table--focus.product-table--with-profit :deep(.product-table-head),
.product-table--focus.product-table--with-profit :deep(.product-table-row) {
  grid-template-columns: 42px minmax(0, 1fr) 52px 92px 92px;
}

.product-table :deep(.product-table-head) {
  min-height: 30px;
  padding: 0 8px;
  border-radius: 4px;
  color: #637086;
  background: #f3f6fa;
  font-size: 11px;
  font-weight: 600;
}

.product-table :deep(.product-table-head span:nth-child(n + 3)) {
  text-align: right;
}

.product-table :deep(.product-table-row) {
  position: relative;
  padding: 3px 8px;
  border-bottom: 1px solid #edf1f6;
  transition: background .15s ease;
}

.product-table :deep(.product-table-row:last-child) {
  border-bottom: 0;
}

.product-table :deep(.product-table-row:hover) {
  background: var(--list-soft);
}

.product-table :deep(.product-name-cell) {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 1px;
}

.product-table :deep(.product-name-cell > span) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #2f3b4e;
  font-weight: 600;
}

.product-table :deep(.product-name-cell small) {
  overflow: hidden;
  color: #9aa4b3;
  font-size: 10px;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.product-table :deep(.product-name-cell .product-device-category) {
  width: fit-content;
  padding: 1px 5px;
  border-radius: 8px;
  color: #3472c7;
  background: #edf4ff;
}

.product-table :deep(.product-quantity),
.product-table :deep(.product-table-row strong) {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.product-table :deep(.product-quantity) {
  color: #5f6c80;
}

.product-table :deep(.product-table-row strong) {
  color: var(--list-accent);
  font-size: 12px;
  font-weight: 650;
}

.product-table :deep(.gross-profit-value) {
  color: #4f5e72;
}

.product-table :deep(.rank) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 5px;
  color: #7b8798;
  background: #eef1f5;
  font-size: 11px;
  font-weight: 700;
}

.product-table :deep(.rank-1) {
  color: #fff;
  background: linear-gradient(135deg, #ff6b47, #ef3434);
  box-shadow: 0 3px 7px rgba(239, 52, 52, .24);
}

.product-table :deep(.rank-2) {
  color: #fff;
  background: linear-gradient(135deg, #ffb447, #f18920);
  box-shadow: 0 3px 7px rgba(241, 137, 32, .22);
}

.product-table :deep(.rank-3) {
  color: #fff;
  background: linear-gradient(135deg, #f3cf4b, #d9a71e);
  box-shadow: 0 3px 7px rgba(217, 167, 30, .2);
}

.product-table :deep(.empty-row) {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 142px;
  color: #a0a9b8;
  font-size: 12px;
}

.inventory-summary {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
  min-height: 170px;
}

.customer-source-note { margin: 0 0 14px; color: #718096; font-size: 12px; }
.customer-source-kpi-grid { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.source-chart-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 18px 0 4px; color: #303c50; font-size: 13px; }
.customer-source-chart { height: 420px; margin-bottom: 20px; }
.store-ranking-tooltip { display: flex; flex-direction: column; gap: 5px; min-width: 150px; }
.store-device-quantity { cursor: help; }
.store-ranking-table :deep(.el-scrollbar__bar.is-vertical) {
  width: 8px;
  opacity: 0.75;
}

.source-category-tag { margin: 2px 5px 2px 0; }

.decision-panel {
  margin-bottom: 16px;
  padding: 16px;
  border: 1px solid #e4eaf2;
  border-radius: 10px;
  background: #fff;
}

.decision-panel-heading,
.decision-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.decision-panel-heading h2 {
  margin: 0;
  color: #26364d;
  font-size: 16px;
}

.decision-panel-heading p,
.decision-card p {
  margin: 6px 0 0;
  color: #718096;
  font-size: 12px;
}

.decision-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 10px;
  margin-top: 14px;
}

.decision-card {
  padding: 12px;
  border: 1px solid #edf0f5;
  border-radius: 8px;
  background: #fbfcfe;
}

.decision-card-head strong {
  color: #34445c;
  font-size: 13px;
}

.decision-action {
  display: block;
  margin-top: 10px;
  color: #1769e0;
  font-size: 12px;
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

/* Compact desktop proportions follow the six-column reference dashboard. */
.bi-dashboard { --primary: #165dff; --text: #101b38; --border: #dfe6f3; }
.filter-panel { background: #fff; border: 0; box-shadow: none; padding: 10px 0 14px; gap: 8px; }
.filter-panel :deep(.el-select) { width: 132px; }
.date-filter { width: 270px !important; flex-grow: 1; max-width: 420px; }
.quick-actions { margin-left: auto; }
.dimension-tabs { margin-bottom: 14px; }
.dimension-tabs button { font-size: 14px; padding: 12px 20px; }
.kpi-grid { gap: 12px; margin-bottom: 14px; }
.kpi-card { min-height: 108px; padding: 16px 12px; gap: 10px; box-sizing: border-box; }
.kpi-value { font-variant-numeric: tabular-nums; font-size: clamp(18px, 1.45vw, 25px); letter-spacing: -.5px; }
.chart-grid, .analysis-grid, .product-grid, .inventory-grid { gap: 14px; margin-bottom: 14px; }
.dashboard-panel :deep(.panel-header h3) { font-size: 16px; color: #101b38; }
.dashboard-panel :deep(.el-table th.el-table__cell) { background: #f2f6fc; color: #172647; font-weight: 600; }
.dashboard-panel :deep(.el-table .cell) { font-variant-numeric: tabular-nums; }
.category-breadcrumb { display: flex; align-items: center; gap: 8px; min-height: 34px; margin: -4px 0 10px; color: #7a8799; font-size: 12px; }
.category-crumb { padding: 0; border: 0; color: #53627a; background: transparent; cursor: pointer; font: inherit; }
.category-crumb:hover, .category-crumb.active { color: #165dff; font-weight: 600; }
.category-separator { color: #c1cad8; }
.category-hint { margin-left: auto; color: #98a2b3; }
.category-analysis-grid { display: grid; grid-template-columns: minmax(320px, 0.85fr) minmax(520px, 1.5fr); gap: 18px; align-items: stretch; }
.category-chart { min-height: 300px; }
.category-table { min-width: 0; }
.employee-analysis-layout { display: grid; grid-template-columns: minmax(560px, 1.05fr) minmax(520px, 1fr); gap: 10px; margin-bottom: 10px; }
.employee-analysis-layout > .dashboard-panel { min-width: 0; }
.employee-analysis-side { display: grid; gap: 10px; min-width: 0; }
.employee-trend-chart { height: 330px; }
.employee-bottom-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; min-width: 0; }
.employee-donut-chart { height: 260px; }
.employee-note { min-height: 260px; padding: 18px; color: #53627a; font-size: 13px; line-height: 1.7; }
.employee-note strong { color: #172647; font-size: 14px; }
.employee-note p { margin: 12px 0 0; }
.large-chart, .medium-chart { height: 245px; }
.dimension-store .ranking-section .dashboard-panel:first-child,
.dimension-overall .ranking-section .dashboard-panel:first-child,
.dimension-productLine .ranking-section .dashboard-panel:nth-child(3),
.dimension-employee .ranking-section .dashboard-panel:nth-child(2) { grid-column: 1 / -1; }

@media (max-width: 1150px) {
  .kpi-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}

@media (max-width: 980px) {
  .filter-panel :deep(.el-select),
  .date-filter {
    width: 180px !important;
  }

  .chart-grid,
  .analysis-grid,
  .product-grid,
  .inventory-grid {
    grid-template-columns: 1fr;
  }

  .trend-section .dashboard-panel,
  .ranking-section .dashboard-panel,
  .product-section .dashboard-panel {
    grid-column: auto;
  }

  .large-chart,
  .medium-chart {
    height: 280px;
  }
}

@media (max-width: 680px) {
  .kpi-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .dimension-tabs {
    gap: 4px;
    overflow-x: auto;
  }

  .dimension-tabs button {
    flex: 0 0 auto;
    padding-inline: 8px;
  }

  .filter-panel {
    align-items: stretch;
  }

  .filter-panel :deep(.el-select),
  .date-filter {
    width: 100% !important;
  }

  .quick-actions {
    width: 100%;
    margin-left: 0;
  }

  .quick-actions .el-button {
    flex: 1;
  }

  .kpi-card {
    padding: 12px 10px;
  }

  .kpi-icon {
    width: 34px;
    height: 34px;
    flex-basis: 34px;
    font-size: 17px;
  }

  .kpi-value {
    font-size: 17px;
  }
}
.dimension-overall .trend-section { grid-template-columns: minmax(0,1fr) minmax(0,1fr) minmax(320px,.8fr); }
.overall-task-progress { min-height:210px; display:flex; align-items:center; gap:20px; padding:12px 4px; }
.overall-task-progress dl { flex:1; margin:0; min-width:0; font-size:13px; }
.overall-task-progress dl div { display:flex; justify-content:space-between; gap:12px; padding:14px 0; border-bottom:1px solid #edf1f7; }
.overall-task-progress dt { color:#53627a; }
.overall-task-progress dd { margin:0; font-weight:600; font-variant-numeric:tabular-nums; }
.overall-task-note { margin:0; color:#53627a; font-size:12px; line-height:1.6; }
@media(max-width:1300px) { .dimension-overall .trend-section { grid-template-columns:1fr 1fr; } .dimension-overall .trend-section > :last-child { grid-column:1 / -1; } }
@media(max-width:760px) { .dimension-overall .trend-section { grid-template-columns:1fr; } }

.dashboard-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0 22px;
  padding: 0 14px;
  background: #1043a6;
  color: #fff;
  border-radius: 8px 8px 0 0;
}
.dashboard-header h1 { margin: 10px 0; font-size: 20px; }
.dashboard-header h1 span { font-size: 16px; }
.dashboard-header .dimension-tabs { border: 0; margin: 0; padding: 0; max-width: 100%; }
.dashboard-header .dimension-tabs button { color: #fff; white-space: nowrap; }
.dashboard-header .dimension-tabs button:hover { background: #2056bd; }
.dashboard-header .dimension-tabs button.active { background: #1b5ff2; }
.dashboard-header .dimension-tabs button.active::after { display: none; }
.filter-panel { padding-inline: 12px; }
.store-analysis {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 12px;
}
.store-analysis > .dashboard-panel { grid-column: span 3; min-width: 0; }
.store-analysis > .store-comparison { grid-column: span 6; }
.store-analysis > .store-ranking { grid-column: span 8; }
.store-analysis > .store-trend { grid-column: span 4; }
.store-analysis :deep(.panel-header) { flex-wrap: wrap; gap: 8px; }
.store-trend .el-radio-group + .el-radio-group { margin-inline-start: 8px; }
.store-efficiency { display: grid; gap: 8px; margin: 0; }
.store-efficiency div { display: flex; justify-content: space-between; padding: 12px; background: #f3f7fc; border-radius: 6px; }
.store-efficiency dd { margin: 0; color: #53627a; }
.store-rank { display: inline-grid; place-items: center; width: 23px; height: 23px; border-radius: 5px; background: #eef2f8; font-weight: 700; }
.store-rank.rank-1 { background: #cc3e2b; color: white; }
.store-rank.rank-2 { background: #9e5000; color: white; }
.store-rank.rank-3 { background: #ffca37; }
@media (max-width: 1200px) {
  .store-analysis > .dashboard-panel { grid-column: span 6; }
  .store-analysis > .store-ranking { grid-column: span 12; }
}
@media (max-width: 720px) {
  .store-analysis > .dashboard-panel { grid-column: span 12; }
  .dashboard-header .dimension-tabs { overflow-x: auto; }
}
.store-finance-panel { margin-bottom: 12px; min-height: 76px; }
.store-profit-positive, .store-profit-negative { border-radius: 4px; padding: 3px 6px; }
.store-profit-positive { background: #eaf7ee; color: #14663c; }
.store-profit-negative { background: #fff0ed; color: #a52b20; }
</style>
