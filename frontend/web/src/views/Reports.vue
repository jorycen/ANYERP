<template>
  <div class="reports-page">
    <el-card>
      <template #header>
        <span>报表统计</span>
      </template>

      <el-tabs v-model="activeTab" class="module-tabs" @tab-change="onTabChange">
        <el-tab-pane label="经营数据看板" name="dashboard" lazy>
          <BusinessDashboard />
        </el-tab-pane>

        <el-tab-pane label="CARE卡可用金" name="care-credit" lazy>
          <CareCreditReport />
        </el-tab-pane>

        <el-tab-pane label="销售报表" name="sales">
          <div class="sales-statement-toolbar">
            <div class="sales-statement-period">
              <span>统计周期</span>
              <el-date-picker v-model="salesStatementPeriod" type="monthrange" value-format="YYYY-MM" format="YYYY年MM月" range-separator="至" start-placeholder="开始月份" end-placeholder="结束月份" unlink-panels />
              <el-date-picker v-model="salesStatementDateRange" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="指定开始日期（优先）" end-placeholder="指定结束日期" clearable />
              <el-button type="primary" :loading="salesStatementLoading" @click="loadSalesReport">查询</el-button>
              <el-button type="success" :loading="salesStatementExporting" :disabled="salesStatementLoading || !salesStatementRows.length" @click="exportSalesStatement">导出 Excel</el-button>
            </div>
            <span class="sales-statement-hint">按附件分组展示；选择单月或连续月份，数据来自已归档订单及已确认费用</span>
          </div>
          <el-table :data="salesStatementRows" stripe border row-key="storeName" :row-class-name="({ row }) => row.storeName === '合计' ? 'sales-statement-total-row' : ''" v-loading="salesStatementLoading" class="sales-statement-table" empty-text="当前周期暂无已归档销售数据">
            <el-table-column prop="storeId" label="门店编号" width="125" fixed="left" />
            <el-table-column prop="storeName" label="门店名称" width="170" fixed="left" />
            <el-table-column label="经营分析" align="center">
          <el-table-column label="销售额" width="125" align="right"><template #default="{ row }">¥{{ formatMoney(row.salesTotal) }}</template></el-table-column>
          <el-table-column label="毛利" width="125" align="right"><template #default="{ row }">{{ formatStatementProfit(row.grossProfit) }}</template></el-table-column>
          <el-table-column label="费用" width="125" align="right"><template #default="{ row }">{{ formatStatementProfit(row.expenseTotal) }}</template></el-table-column>
          <el-table-column label="净利润" width="125" align="right"><template #default="{ row }">{{ formatStatementProfit(row.netProfit) }}</template></el-table-column>
          <el-table-column label="毛利率" width="100" align="right"><template #default="{ row }">{{ formatStatementPercent(row.grossProfitRate) }}</template></el-table-column>
          <el-table-column label="费用率" width="100" align="right"><template #default="{ row }">{{ formatStatementPercent(row.expenseRate) }}</template></el-table-column>
          <el-table-column v-for="item in statementMarginCategories" :key="'margin-' + item.key" :label="item.label + '毛利率'" width="115" align="right"><template #default="{ row }">{{ formatStatementPercent(row.categoryGrossProfitRate?.[item.key]) }}</template></el-table-column>
        </el-table-column>
        <el-table-column label="销售收入" align="center">
          <el-table-column label="合计" width="125" align="right"><template #default="{ row }">¥{{ formatMoney(row.salesTotal) }}</template></el-table-column>
          <el-table-column v-for="item in statementCategories" :key="'sales-' + item.key" :label="item.label" align="center">
            <el-table-column label="销售额" width="125" align="right"><template #default="{ row }">¥{{ formatMoney(row.sales?.[item.key]) }}</template></el-table-column>
            <el-table-column label="占比" width="85" align="right"><template #default="{ row }">{{ formatStatementPercent(row.salesShare?.[item.key]) }}</template></el-table-column>
          </el-table-column>
        </el-table-column>
        <el-table-column label="毛利构成" align="center">
          <el-table-column label="合计" width="125" align="right"><template #default="{ row }">{{ formatStatementProfit(row.grossProfit) }}</template></el-table-column>
          <el-table-column v-for="item in statementCategories" :key="'profit-' + item.key" :label="item.label" align="center">
            <el-table-column label="毛利" width="125" align="right"><template #default="{ row }">{{ formatStatementProfit(row.categoryGrossProfit?.[item.key]) }}</template></el-table-column>
            <el-table-column label="占比" width="85" align="right"><template #default="{ row }">{{ formatStatementPercent(row.categoryGrossProfitShare?.[item.key]) }}</template></el-table-column>
          </el-table-column>
          <el-table-column label="审批调整及口径差额" width="165" align="right"><template #default="{ row }">{{ formatStatementProfit(row.grossProfitAdjustment) }}</template></el-table-column>
          <el-table-column label="已确认返利（单列）" width="165" align="right"><template #default="{ row }">{{ formatStatementProfit(row.rebate) }}</template></el-table-column>
        </el-table-column>
        <el-table-column label="费用构成" align="center">
          <el-table-column label="合计" width="125" align="right"><template #default="{ row }">{{ formatStatementProfit(row.expenseTotal) }}</template></el-table-column>
          <el-table-column label="固定费用" width="125" align="right"><template #default="{ row }">{{ formatStatementProfit(row.expenses?.fixed) }}</template></el-table-column>
          <el-table-column label="人员费用" width="125" align="right"><template #default="{ row }">{{ formatStatementProfit(row.expenses?.personnel) }}</template></el-table-column>
          <el-table-column label="日常费用" width="125" align="right"><template #default="{ row }">{{ formatStatementProfit(row.expenses?.daily) }}</template></el-table-column>
          <el-table-column label="其他费用" width="125" align="right"><template #default="{ row }">{{ formatStatementProfit(row.expenses?.other) }}</template></el-table-column>
        </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="库存报表" name="inventory">
          <div class="filter-bar">
            <el-select v-model="inventoryParams.storeId" placeholder="选择门店" clearable>
              <el-option label="全部门店" value="" />
              <el-option v-for="store in stores" :key="store.store_id" :label="store.name" :value="store.store_id" />
            </el-select>
            <el-button type="primary" @click="loadInventoryReport">查询</el-button>
          </div>

          <div class="summary-row">
            <div class="summary-item">在库数量：<strong>{{ inventorySummary.totalCount || 0 }}</strong></div>
            <div class="summary-item">成本合计：<strong>¥{{ formatMoney(inventorySummary.totalCost) }}</strong></div>
            <div class="summary-item">滞销数量（库龄＞30天）：<strong>{{ inventorySummary.staleCount || 0 }}</strong></div>
            <div class="summary-item">滞销率：<strong>{{ formatPercent(inventorySummary.staleRate) }}</strong></div>
          </div>

          <el-table :data="inventoryData" stripe border>
            <el-table-column prop="category" label="商品分类" width="110" />
            <el-table-column prop="brand" label="品牌" width="100" />
            <el-table-column prop="series" label="系列" width="120" />
            <el-table-column prop="model" label="型号" min-width="140" />
            <el-table-column prop="totalCount" label="在库数量" width="100" />
            <el-table-column label="成本合计" width="130" align="right">
              <template #default="{ row }">¥{{ formatMoney(row.totalCost) }}</template>
            </el-table-column>
            <el-table-column prop="staleCount" label="滞销数量" width="105" align="right" />
            <el-table-column label="滞销率（库龄＞30天）" width="170" align="right">
              <template #default="{ row }">{{ formatPercent(row.staleRate) }}</template>
            </el-table-column>
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
            <el-select v-model="employeeParams.storeId" placeholder="输入关键词选择门店" filterable clearable style="width: 200px">
              <el-option label="全部门店" value="" />
              <el-option v-for="store in stores" :key="store.store_id" :label="store.name" :value="store.store_id" />
            </el-select>
            <el-select v-model="employeeParams.staffName" placeholder="输入关键词选择员工" filterable clearable style="width: 200px">
              <el-option label="全部员工" value="" />
              <el-option v-for="name in employeeOptions" :key="name" :label="name" :value="name" />
            </el-select>
            <el-input v-model="employeeParams.orderNo" placeholder="订单号" clearable style="width: 190px" @keyup.enter="loadEmployeePerformance" />
            <el-button type="primary" @click="loadEmployeePerformance">查询</el-button>
            <el-button v-if="employeeCanViewProfit" type="success" :loading="employeeExporting" @click="exportEmployeeProfits">导出毛利明细</el-button>
            <el-button @click="openAdjustmentCenter('mine')">我的毛利调整</el-button>
            <el-button v-if="canReviewAdjustments" type="warning" @click="openAdjustmentCenter('review')">待我审核</el-button>
          </div>

          <el-alert
            v-if="employeeSummary.legacyOrderCount > 0"
            type="warning"
            :closable="false"
            style="margin-bottom: 16px"
            :title="`有 ${employeeSummary.legacyOrderCount} 笔历史订单未保存归档毛利，当前使用旧成本口径兼容展示，建议由授权账号逐单重算。`"
          />

          <div class="summary-row">
            <div class="summary-item">订单数：<strong>{{ employeeSummary.orderCount || 0 }}</strong></div>
            <div class="summary-item">退单数：<strong>{{ employeeSummary.returnCount || 0 }}</strong></div>
            <div class="summary-item">销售额：<strong>¥{{ formatMoney(employeeSummary.totalAmount) }}</strong></div>
            <div class="summary-item">实收：<strong>¥{{ formatMoney(employeeSummary.actualPayment) }}</strong></div>
            <div class="summary-item">基础毛利：<strong>¥{{ formatMoney(employeeSummary.baseGrossProfit) }}</strong></div>
            <div class="summary-item">Care可用金抵扣：<strong :class="Number(employeeSummary.careCreditAdjustment || 0) >= 0 ? 'profit-positive' : 'profit-negative'">{{ Number(employeeSummary.careCreditAdjustment || 0) >= 0 ? '+' : '-' }}¥{{ formatMoney(Math.abs(employeeSummary.careCreditAdjustment || 0)) }}</strong></div>
            <div class="summary-item">其他调整：<strong :class="Number(employeeSummary.otherApprovedAdjustment || 0) >= 0 ? 'profit-positive' : 'profit-negative'">{{ Number(employeeSummary.otherApprovedAdjustment || 0) >= 0 ? '+' : '-' }}¥{{ formatMoney(Math.abs(employeeSummary.otherApprovedAdjustment || 0)) }}</strong></div>
            <div class="summary-item">业绩毛利：<strong>¥{{ formatMoney(employeeSummary.grossProfit) }}</strong></div>
            <div v-if="employeeCanViewProfit" class="summary-item">费用扣减：<strong class="profit-negative">¥{{ formatMoney(employeeSummary.expensePerformanceDeduction) }}</strong></div>
            <div v-if="employeeCanViewProfit" class="summary-item">扣减后毛利：<strong :class="Number(employeeSummary.netGrossProfit || 0) >= 0 ? 'profit-positive' : 'profit-negative'">¥{{ formatMoney(employeeSummary.netGrossProfit) }}</strong></div>
          </div>

          <el-table
            v-if="employeeCanViewProfit && (employeeSummary.expenseDeductions || []).length"
            :data="employeeSummary.expenseDeductions"
            stripe
            border
            size="small"
            style="margin: 16px 0"
          >
            <el-table-column prop="staffName" label="员工" width="130" />
            <el-table-column prop="amount" label="费用扣减毛利" width="150">
              <template #default="{ row }"><span class="profit-negative">-¥{{ formatMoney(row.amount) }}</span></template>
            </el-table-column>
            <el-table-column label="说明" min-width="220">
              <template #default>费用分摊审批通过后计入员工绩效毛利，不修改订单原始毛利。</template>
            </el-table-column>
          </el-table>

          <el-table :data="employeeData" stripe border v-loading="employeeLoading">
            <el-table-column type="expand">
              <template #default="{ row }">
                <div class="profit-process">
                  <div class="process-line">{{ row.calculation?.revenueNote }}</div>
                  <div class="process-line">整单毛利：{{ row.calculation?.orderFormula }}</div>
                  <div v-if="row.entryType !== 'return' && (row.careCostAmount || row.careCreditAdjustment)" class="process-line">
                    Care 商品成本 -¥{{ formatMoney(row.careCostAmount) }} 已计入基础毛利；
                    可用金抵扣 {{ row.careCreditAdjustment >= 0 ? '+' : '-' }}¥{{ formatMoney(Math.abs(row.careCreditAdjustment)) }}；
                    净计入员工成本 ¥{{ formatMoney(row.careCostAmount - row.careCreditAdjustment) }}
                  </div>
                  <template v-if="row.calculation?.snapshot">
                    <el-descriptions class="snapshot-breakdown" :column="5" border size="small">
                      <el-descriptions-item label="用户应收">
                        <span class="profit-positive">+¥{{ formatMoney(row.calculation.snapshot.receivableAmount) }}</span>
                      </el-descriptions-item>
                      <el-descriptions-item label="商品定价">
                        <span class="profit-negative">-¥{{ formatMoney(row.calculation.snapshot.productPricingAmount) }}</span>
                      </el-descriptions-item>
                      <el-descriptions-item label="支付手续费">
                        <span class="profit-negative">-¥{{ formatMoney(row.calculation.snapshot.paymentFeeAmount) }}</span>
                      </el-descriptions-item>
                      <el-descriptions-item label="增值税">
                        <span class="profit-negative">-¥{{ formatMoney(row.calculation.snapshot.vatAmount) }}</span>
                      </el-descriptions-item>
                      <el-descriptions-item label="补录净额">
                        <span :class="Number(row.calculation.snapshot.supplementAmount || 0) >= 0 ? 'profit-positive' : 'profit-negative'">
                          {{ Number(row.calculation.snapshot.supplementAmount || 0) >= 0 ? '+' : '' }}¥{{ formatMoney(row.calculation.snapshot.supplementAmount) }}
                        </span>
                      </el-descriptions-item>
                      <el-descriptions-item label="运费">
                        <span class="profit-negative">-¥{{ formatMoney(row.calculation.snapshot.freightCostAmount) }}</span>
                      </el-descriptions-item>
                      <el-descriptions-item label="开票金额">¥{{ formatMoney(row.calculation.snapshot.invoiceAmount) }}</el-descriptions-item>
                      <el-descriptions-item label="外调费">
                        <span class="profit-negative">-¥{{ formatMoney(row.calculation.snapshot.externalAdjustmentFee) }}</span>
                      </el-descriptions-item>
                      <el-descriptions-item label="基础毛利">
                        <strong :class="Number(row.calculation.snapshot.grossProfitAmount || 0) >= 0 ? 'profit-positive' : 'profit-negative'">
                          ¥{{ formatMoney(row.calculation.snapshot.grossProfitAmount) }}
                        </strong>
                      </el-descriptions-item>
                    </el-descriptions>

                    <el-table v-if="row.calculation.snapshot.paymentDetails?.length" :data="row.calculation.snapshot.paymentDetails" size="small" border class="snapshot-detail-table">
                      <el-table-column label="支付方式" min-width="150">
                        <template #default="{ row: detail }">{{ detail.method || detail.paymentMethod || '-' }}</template>
                      </el-table-column>
                      <el-table-column label="支付金额" width="120">
                        <template #default="{ row: detail }">¥{{ formatMoney(detail.amount) }}</template>
                      </el-table-column>
                      <el-table-column label="手续费率" width="110">
                        <template #default="{ row: detail }">{{ Number(detail.taxRate || 0) }}%</template>
                      </el-table-column>
                      <el-table-column label="手续费" width="120">
                        <template #default="{ row: detail }"><span class="profit-negative">-¥{{ formatMoney(detail.fee) }}</span></template>
                      </el-table-column>
                    </el-table>

                    <el-table v-if="row.calculation.snapshot.supplementDetails?.length" :data="row.calculation.snapshot.supplementDetails" size="small" border class="snapshot-detail-table">
                      <el-table-column label="补录项目" min-width="180">
                        <template #default="{ row: detail }">{{ detail.itemName || detail.content || '补录' }}</template>
                      </el-table-column>
                      <el-table-column label="方向" width="100">
                        <template #default="{ row: detail }">{{ detail.amountType === 'decrease' ? '扣减' : '增加' }}</template>
                      </el-table-column>
                      <el-table-column label="金额" width="130">
                        <template #default="{ row: detail }">
                          <span :class="detail.amountType === 'decrease' ? 'profit-negative' : 'profit-positive'">
                            {{ detail.amountType === 'decrease' ? '-' : '+' }}¥{{ formatMoney(detail.amount) }}
                          </span>
                        </template>
                      </el-table-column>
                    </el-table>

                    <el-table v-if="row.calculation.snapshot.freightCostDetails?.length" :data="row.calculation.snapshot.freightCostDetails" size="small" border class="snapshot-detail-table">
                      <el-table-column label="运费来源" min-width="160">
                        <template #default="{ row: detail }">{{ detail.sourceNo || detail.platformName || detail.sourceType || '-' }}</template>
                      </el-table-column>
                      <el-table-column prop="snCode" label="SN" min-width="150" />
                      <el-table-column prop="quantity" label="数量" width="80" />
                      <el-table-column label="运费" width="130">
                        <template #default="{ row: detail }"><span class="profit-negative">-¥{{ formatMoney(detail.amount) }}</span></template>
                      </el-table-column>
                    </el-table>
                  </template>
                  <div v-if="row.participantAllocations?.length" class="snapshot-detail-table">
                    <strong>员工业绩毛利分配</strong>
                    <el-table :data="row.participantAllocations" size="small" border>
                      <el-table-column prop="employeeName" label="销售人" min-width="110" />
                      <el-table-column label="身份" width="90">
                        <template #default="{ row: participant }">{{ participant.role === 'primary' ? '主销售' : '辅助销售' }}</template>
                      </el-table-column>
                      <el-table-column label="分配依据" min-width="120">
                        <template #default="{ row: participant }">{{ row.entryType === 'return' ? '按原销售记录冲回' : participant.role === 'primary' && row.customAllocation ? '剩余毛利' : Number(participant.fixedAmount) > 0 ? `固定 ¥${formatMoney(participant.fixedAmount)}` : Number(participant.ratio) > 0 ? `${participant.ratio}%` : '平均分配' }}</template>
                      </el-table-column>
                      <el-table-column label="基础毛利" width="115">
                        <template #default="{ row: participant }">¥{{ formatMoney(participant.baseGrossProfit) }}</template>
                      </el-table-column>
                      <el-table-column label="业绩毛利" width="115">
                        <template #default="{ row: participant }">¥{{ formatMoney(participant.grossProfit) }}</template>
                      </el-table-column>
                    </el-table>
                  </div>
                  <el-table :data="row.calculation?.items || []" size="small" border>
                    <el-table-column prop="productName" label="商品" min-width="180" />
                    <el-table-column prop="pnCode" label="PN" width="130" />
                    <el-table-column prop="snCode" label="SN" width="130" />
                    <el-table-column prop="quantity" label="数量" width="70" />
                    <el-table-column label="销售小计" width="110">
                      <template #default="{ row: item }">¥{{ formatMoney(item.allocatedRevenue) }}</template>
                    </el-table-column>
                    <el-table-column label="产品定价" width="100">
                      <template #default="{ row: item }">¥{{ formatMoney(item.unitCost) }}</template>
                    </el-table-column>
                    <el-table-column label="定价合计" width="100">
                      <template #default="{ row: item }">¥{{ formatMoney(item.costAmount) }}</template>
                    </el-table-column>
                    <el-table-column prop="formula" label="毛利计算" min-width="180" />
                  </el-table>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="业务类型" width="100">
              <template #default="{ row }"><el-tag :type="row.entryType === 'return' ? 'danger' : 'success'">{{ row.entryType === 'return' ? '退单冲回' : '销售' }}</el-tag></template>
            </el-table-column>
            <el-table-column prop="orderNo" label="销售/退单号" width="180" />
            <el-table-column prop="sourceOrderNo" label="关联原销售单" width="180" />
            <el-table-column prop="orderTime" label="时间" width="160">
              <template #default="{ row }">{{ formatDateTime(row.orderTime) }}</template>
            </el-table-column>
            <el-table-column prop="employeeName" label="员工" width="100" />
            <el-table-column prop="storeName" label="门店" width="120" />
            <el-table-column prop="customerName" label="客户" width="100" />
            <el-table-column label="实收" width="100">
              <template #default="{ row }">¥{{ formatMoney(row.actualPayment) }}</template>
            </el-table-column>
            <el-table-column label="产品定价" width="100">
              <template #default="{ row }">¥{{ formatMoney(row.totalCost) }}</template>
            </el-table-column>
            <el-table-column label="基础毛利" width="105">
              <template #default="{ row }">
                ¥{{ formatMoney(row.baseGrossProfit) }}
                <el-tooltip v-if="row.grossProfitSource === 'legacy_fallback'" content="历史订单兼容口径" placement="top">
                  <el-tag size="small" type="warning">旧</el-tag>
                </el-tooltip>
              </template>
            </el-table-column>
            <el-table-column label="Care可用金抵扣" width="145">
              <template #default="{ row }">
                <span :class="row.careCreditAdjustment >= 0 ? 'profit-positive' : 'profit-negative'">
                  {{ row.careCreditAdjustment >= 0 ? '+' : '-' }}¥{{ formatMoney(Math.abs(row.careCreditAdjustment)) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="其他调整" width="105">
              <template #default="{ row }">
                <span :class="row.otherApprovedAdjustment >= 0 ? 'profit-positive' : 'profit-negative'">{{ row.otherApprovedAdjustment >= 0 ? '+' : '-' }}¥{{ formatMoney(Math.abs(row.otherApprovedAdjustment)) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="业绩毛利" width="110">
              <template #default="{ row }">
                <span :class="row.grossProfit >= 0 ? 'profit-positive' : 'profit-negative'">¥{{ formatMoney(row.grossProfit) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="毛利率" width="90">
              <template #default="{ row }">{{ row.grossRate }}%</template>
            </el-table-column>
            <el-table-column label="操作" width="155" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="openAdjustmentApply(row)">申请调整</el-button>
                <el-button link @click="openOrderAdjustments(row)">记录</el-button>
              </template>
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

    <el-dialog v-model="adjustmentApplyVisible" title="申请订单毛利调整" width="620px" @closed="resetAdjustmentForm">
      <el-form label-width="100px">
        <el-form-item label="订单">
          <span>{{ adjustmentOrder?.orderNo }} / {{ adjustmentOrder?.employeeName }}</span>
        </el-form-item>
        <el-form-item label="基础毛利">¥{{ formatMoney(adjustmentOrder?.baseGrossProfit) }}</el-form-item>
        <el-form-item label="调整方向" required>
          <el-radio-group v-model="adjustmentForm.adjustmentType">
            <el-radio label="increase">增加毛利</el-radio>
            <el-radio label="decrease">减少毛利</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="调整金额" required>
          <el-input-number v-model="adjustmentForm.amount" :min="0.01" :precision="2" :step="100" controls-position="right" style="width: 220px" />
        </el-form-item>
        <el-form-item label="调整原因" required>
          <el-input v-model="adjustmentForm.reason" type="textarea" :rows="4" maxlength="1000" show-word-limit />
        </el-form-item>
        <el-form-item label="证明附件">
          <el-upload
            v-model:file-list="adjustmentUploadFiles"
            :auto-upload="false"
            multiple
            :limit="5"
            accept=".jpg,.jpeg,.png,.pdf,.xls,.xlsx,.doc,.docx"
            :on-change="handleAdjustmentFileChange"
            :on-remove="handleAdjustmentFileChange"
          >
            <el-button>选择文件</el-button>
            <template #tip><div class="el-upload__tip">最多5个，单个不超过10MB</div></template>
          </el-upload>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="adjustmentApplyVisible = false">取消</el-button>
        <el-button type="primary" :loading="adjustmentSubmitting" @click="submitAdjustment">提交申请</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="adjustmentCenterVisible" :title="adjustmentCenterTitle" width="1100px">
      <el-table :data="adjustmentData" stripe border v-loading="adjustmentLoading" max-height="520">
        <el-table-column prop="adjustment_no" label="申请单号" width="190" />
        <el-table-column prop="order_no" label="订单号" width="175" />
        <el-table-column prop="employee_name" label="业绩员工" width="100" />
        <el-table-column prop="applicant_name" label="申请人" width="90" />
        <el-table-column label="调整金额" width="110">
          <template #default="{ row }">
            <span :class="Number(row.signed_amount) >= 0 ? 'profit-positive' : 'profit-negative'">
              {{ Number(row.signed_amount) >= 0 ? '+' : '' }}¥{{ formatMoney(row.signed_amount) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="reason" label="原因" min-width="180" show-overflow-tooltip />
        <el-table-column label="状态" width="115">
          <template #default="{ row }"><el-tag :type="adjustmentStatusType(row.status)">{{ adjustmentStatusText(row.status) }}</el-tag></template>
        </el-table-column>
        <el-table-column label="附件" min-width="140">
          <template #default="{ row }">
            <el-button
              v-for="file in row.attachments || []"
              :key="file.attachment_id"
              link
              type="primary"
              @click="downloadAdjustmentAttachment(file)"
            >{{ file.original_name }}</el-button>
            <span v-if="!(row.attachments || []).length">-</span>
          </template>
        </el-table-column>
        <el-table-column label="审核记录" min-width="180">
          <template #default="{ row }">
            <div v-if="row.finance_reviewer_name">财务：{{ row.finance_reviewer_name }} {{ row.finance_review_comment || '' }}</div>
            <div v-if="row.admin_reviewer_name">admin：{{ row.admin_reviewer_name }} {{ row.admin_review_comment || '' }}</div>
            <span v-if="!row.finance_reviewer_name && !row.admin_reviewer_name">-</span>
          </template>
        </el-table-column>
        <el-table-column v-if="adjustmentScope === 'review'" label="操作" width="125" fixed="right">
          <template #default="{ row }">
            <el-button link type="success" @click="reviewAdjustment(row, 'approve')">通过</el-button>
            <el-button link type="danger" @click="reviewAdjustment(row, 'reject')">拒绝</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination
        v-model:current-page="adjustmentParams.page"
        :page-size="adjustmentParams.pageSize"
        :total="adjustmentTotal"
        layout="total, prev, pager, next"
        @current-change="loadAdjustments"
      />
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import * as echarts from 'echarts'
import api from '../api'
import { getRoleCode } from '../utils/user'
import BusinessDashboard from '../components/BusinessDashboard.vue'
import CareCreditReport from '../components/CareCreditReport.vue'

const route = useRoute()
const activeTab = ref(String(route.meta.tab || 'dashboard'))
const syncTabFromRoute = () => {
  const tab = String(route.meta.tab || 'dashboard')
  if (activeTab.value !== tab) activeTab.value = tab
  onTabChange(tab)
}
const stores = ref([])
const salesData = ref([])
const salesCategoryData = ref([])
const salesStatementLoading = ref(false)
const salesStatementExporting = ref(false)
const salesStatementRows = ref([])
const salesStatementLoadedPeriod = ref(null)
const statementCategories = [
  { key: 'nb', label: 'NB' }, { key: 'dt', label: 'DT' }, { key: 'phone', label: '手机' },
  { key: 'tablet', label: '平板' }, { key: 'service', label: '服务' }, { key: 'option', label: '其他IoT/选件' }
]
const statementMarginCategories = statementCategories.filter(item => item.key !== 'dt')
const currentDate = new Date()
const currentMonth = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}`
const salesStatementPeriod = ref([currentMonth, currentMonth])
const salesStatementDateRange = ref([])
const salesCanViewProfit = ref(false)
const inventoryData = ref([])
const inventorySummary = ref({ totalCount: 0, totalCost: 0, staleCount: 0, staleRate: 0 })
const employeeData = ref([])
const employeeOptions = ref([])
const employeeSummary = ref({})
const employeeTotal = ref(0)
const employeeLoading = ref(false)
const employeeExporting = ref(false)
const salesPerformanceLoading = ref(false)
const salesPerformanceDetails = ref([])
const salesPerformanceCanViewProfit = ref(false)
const dashboardFilterOptions = reactive({ stores: [], employees: [] })
const adjustmentApplyVisible = ref(false)
const adjustmentSubmitting = ref(false)
const adjustmentOrder = ref(null)
const adjustmentFiles = ref([])
const adjustmentUploadFiles = ref([])
const adjustmentCenterVisible = ref(false)
const adjustmentLoading = ref(false)
const adjustmentData = ref([])
const adjustmentTotal = ref(0)
const adjustmentScope = ref('mine')
const adjustmentOrderId = ref('')
const salesChartRef = ref(null)
const inventoryChartRef = ref(null)

const salesPerformanceParams = reactive({
  dateRange: currentWeekRange(),
  storeId: '',
  employeeId: ''
})
const inventoryParams = reactive({ storeId: '' })
const employeeParams = reactive({ dateRange: recentSevenDayRange(), storeId: '', staffName: '', orderNo: '', page: 1, pageSize: 20 })
const adjustmentForm = reactive({ adjustmentType: 'increase', amount: 0.01, reason: '' })
const adjustmentParams = reactive({ page: 1, pageSize: 20 })
const currentRoles = String(getRoleCode() || '').split(',').map(role => role.trim())
const employeeCanViewProfit = computed(() => currentRoles.some(role => ['boss', 'admin', 'finance', 'manager', 'store_manager', 'store_admin'].includes(role)))
const canReviewAdjustments = computed(() => currentRoles.includes('finance') || currentRoles.includes('admin'))
const adjustmentCenterTitle = computed(() => {
  if (adjustmentScope.value === 'review') return '待我审核的毛利调整'
  if (adjustmentScope.value === 'order') return `订单 ${adjustmentOrder.value?.orderNo || ''} 的毛利调整记录`
  return '我的毛利调整申请'
})

onMounted(() => {
  activeTab.value = String(route.meta.tab || 'dashboard')
  loadStores()
  loadDashboardFilterOptions()
  if (activeTab.value === 'sales') loadSalesReport()
  if (activeTab.value === 'employee') loadEmployeePerformance()
})

watch(() => route.path, syncTabFromRoute)

const onTabChange = (tabName) => {

  if (tabName === 'sales') {
    loadSalesReport()
  }
  if (tabName === 'inventory' && inventoryData.value.length === 0) {
    loadInventoryReport()
  }
  if (tabName === 'employee' && employeeData.value.length === 0) {
    loadEmployeePerformance()
  }
}

const loadStores = async () => {
  try {
    const res = await api.getReadableStoreList()
    if (res.code === 0) stores.value = (res.data || []).filter(s => s.store_id != null)
  } catch (err) { console.error(err) }
}

const loadSalesReport = async () => {
  if ((!salesStatementPeriod.value || salesStatementPeriod.value.length !== 2) && salesStatementDateRange.value?.length !== 2) {
    ElMessage.warning('请选择开始月份和结束月份')
    return
  }
  salesStatementLoading.value = true
  try {
    const res = await api.getSalesStatement(salesStatementDateRange.value?.length === 2
      ? { startDate: salesStatementDateRange.value[0], endDate: salesStatementDateRange.value[1] }
      : { startMonth: salesStatementPeriod.value[0], endMonth: salesStatementPeriod.value[1] })
    if (res.code === 0) {
      const data = res.data || {}
      salesCanViewProfit.value = Boolean(data.canViewProfit)
      salesStatementRows.value = data.summary ? [data.summary, ...(data.rows || [])] : (data.rows || [])
      salesStatementLoadedPeriod.value = data.period || { start: salesStatementPeriod.value[0], end: salesStatementPeriod.value[1] }
    }
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '销售报表加载失败')
  } finally {
    salesStatementLoading.value = false
  }
}

const loadDashboardFilterOptions = async () => {
  try {
    const res = await api.getDashboardFilters()
    if (res.code === 0) {
      dashboardFilterOptions.stores = res.data?.stores || []
      dashboardFilterOptions.employees = res.data?.employees || []
    }
  } catch (err) {
    console.error(err)
  }
}

const loadSalesPerformanceDetails = async () => {
  if (!salesPerformanceParams.dateRange || salesPerformanceParams.dateRange.length !== 2) {
    ElMessage.warning('请选择员工业绩明细日期范围')
    return
  }
  salesPerformanceLoading.value = true
  try {
    const res = await api.getDashboardOverview({
      startDate: salesPerformanceParams.dateRange[0],
      endDate: salesPerformanceParams.dateRange[1],
      storeId: salesPerformanceParams.storeId || undefined,
      employeeId: salesPerformanceParams.employeeId || undefined,
      granularity: 'day'
    })
    if (res.code === 0) {
      salesPerformanceDetails.value = res.data?.employeePerformanceDetails || []
      salesPerformanceCanViewProfit.value = Boolean(res.data?.meta?.canViewProfit)
    }
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '加载员工业绩订单明细失败')
  } finally {
    salesPerformanceLoading.value = false
  }
}

const loadInventoryReport = async () => {
  try {
    const res = await api.getInventoryReport(inventoryParams)
    if (res.code === 0) {
      inventoryData.value = res.data?.categoryStats || []
      inventorySummary.value = res.data?.summary || { totalCount: 0, totalCost: 0, staleCount: 0, staleRate: 0 }
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
      orderNo: employeeParams.orderNo,
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
    } else {
      throw new Error(res?.message || `业绩接口返回异常（code: ${res?.code ?? '缺失'}）`)
    }
  } catch (err) {
    console.error('加载员工业绩失败', err)
    ElMessage.error(err?.response?.data?.message || err?.message || '加载员工业绩失败')
  } finally {
    employeeLoading.value = false
  }
}

const exportEmployeeProfits = async () => {
  employeeExporting.value = true
  try {
    const params = {
      storeId: employeeParams.storeId,
      staffName: employeeParams.staffName,
      orderNo: employeeParams.orderNo
    }
    if (employeeParams.dateRange && employeeParams.dateRange.length === 2) {
      params.startDate = employeeParams.dateRange[0]
      params.endDate = employeeParams.dateRange[1]
    }
    await api.exportEmployeePerformanceReport(params)
    ElMessage.success('毛利明细已导出')
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || err?.message || '毛利明细导出失败')
  } finally {
    employeeExporting.value = false
  }
}

const openAdjustmentApply = (row) => {
  adjustmentOrder.value = row
  resetAdjustmentForm()
  adjustmentApplyVisible.value = true
}

const resetAdjustmentForm = () => {
  adjustmentForm.adjustmentType = 'increase'
  adjustmentForm.amount = 0.01
  adjustmentForm.reason = ''
  adjustmentFiles.value = []
  adjustmentUploadFiles.value = []
}

const handleAdjustmentFileChange = (file, uploadFiles) => {
  adjustmentFiles.value = (uploadFiles || []).map(item => item.raw).filter(Boolean)
}

const submitAdjustment = async () => {
  if (!adjustmentOrder.value?.orderId) { ElMessage.warning('请选择订单'); return }
  if (!adjustmentForm.reason.trim()) { ElMessage.warning('请填写调整原因'); return }
  if (Number(adjustmentForm.amount || 0) <= 0) { ElMessage.warning('调整金额必须大于0'); return }
  adjustmentSubmitting.value = true
  try {
    const formData = new FormData()
    formData.append('orderId', adjustmentOrder.value.orderId)
    formData.append('adjustmentType', adjustmentForm.adjustmentType)
    formData.append('amount', String(adjustmentForm.amount))
    formData.append('reason', adjustmentForm.reason.trim())
    adjustmentFiles.value.forEach(file => formData.append('files', file))
    const res = await api.createProfitAdjustment(formData)
    if (res.code === 0) {
      ElMessage.success(res.message || '申请已提交')
      adjustmentApplyVisible.value = false
    } else {
      ElMessage.error(res.message || '提交失败')
    }
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || err?.message || '提交失败')
  } finally {
    adjustmentSubmitting.value = false
  }
}

const openAdjustmentCenter = (scope) => {
  adjustmentScope.value = scope
  adjustmentOrderId.value = ''
  adjustmentOrder.value = null
  adjustmentParams.page = 1
  adjustmentCenterVisible.value = true
  loadAdjustments()
}

const openOrderAdjustments = (row) => {
  adjustmentScope.value = 'order'
  adjustmentOrderId.value = row.orderId
  adjustmentOrder.value = row
  adjustmentParams.page = 1
  adjustmentCenterVisible.value = true
  loadAdjustments()
}

const loadAdjustments = async () => {
  adjustmentLoading.value = true
  try {
    const res = await api.getProfitAdjustments({
      scope: adjustmentScope.value,
      orderId: adjustmentOrderId.value || undefined,
      page: adjustmentParams.page,
      pageSize: adjustmentParams.pageSize
    })
    if (res.code === 0) {
      adjustmentData.value = res.data?.list || []
      adjustmentTotal.value = res.data?.pagination?.total || res.data?.total || 0
    }
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '加载毛利调整记录失败')
  } finally {
    adjustmentLoading.value = false
  }
}

const reviewAdjustment = async (row, action) => {
  try {
    const result = await ElMessageBox.prompt(
      action === 'approve' ? '可填写审核意见' : '请填写拒绝原因',
      action === 'approve' ? '审核通过' : '拒绝申请',
      {
        confirmButtonText: '确认',
        cancelButtonText: '取消',
        inputValidator: value => action === 'approve' || !!String(value || '').trim() || '拒绝原因不能为空'
      }
    )
    const apiMethod = action === 'approve' ? api.approveProfitAdjustment : api.rejectProfitAdjustment
    const res = await apiMethod(row.adjustment_id, { comment: String(result.value || '').trim() })
    if (res.code === 0) {
      ElMessage.success(res.message || '审核完成')
      await loadAdjustments()
      await loadEmployeePerformance()
    }
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(err?.response?.data?.message || '审核失败')
    }
  }
}

const downloadAdjustmentAttachment = async (file) => {
  try {
    const response = await api.downloadProfitAdjustmentAttachment(file.attachment_id)
    const url = window.URL.createObjectURL(new Blob([response.data], { type: file.mime_type || 'application/octet-stream' }))
    const link = document.createElement('a')
    link.href = url
    link.download = file.original_name || '附件'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    window.URL.revokeObjectURL(url)
  } catch (err) {
    ElMessage.error('附件下载失败')
  }
}

const adjustmentStatusText = status => ({
  pending_finance: '待财务初审',
  pending_admin: '待admin复审',
  approved: '已通过',
  rejected: '已拒绝'
}[status] || status)

const adjustmentStatusType = status => ({
  pending_finance: 'warning',
  pending_admin: 'warning',
  approved: 'success',
  rejected: 'danger'
}[status] || 'info')

const handleExport = () => ElMessage.info('导出功能开发中')

const formatStatementPercent = value => value === null || value === undefined ? '-' : `${Number(value || 0).toFixed(2)}%`
const formatStatementProfit = value => salesCanViewProfit.value && value !== null && value !== undefined ? `¥${formatMoney(value)}` : '-'

const formatMoney = (value) => Number(value || 0).toLocaleString('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})

const formatPercent = (value) => `${Number(value || 0).toFixed(2)}%`

const formatSignedMoney = (value) => {
  const amount = Number(value || 0)
  return `${amount > 0 ? '+' : amount < 0 ? '-' : ''}¥${formatMoney(Math.abs(amount))}`
}

function currentWeekRange() {
  const today = new Date()
  const weekday = today.getDay() || 7
  const monday = new Date(today)
  monday.setDate(today.getDate() - weekday + 1)
  const format = date => [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-')
  return [format(monday), format(today)]
}

function recentSevenDayRange() {
  const today = new Date()
  const start = new Date(today)
  start.setDate(today.getDate() - 7)
  const format = date => [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-')
  return [format(start), format(today)]
}

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
const exportSalesStatement = async () => {
  if (!salesStatementRows.value.length) {
    ElMessage.warning('当前没有可导出的报表数据')
    return
  }

  salesStatementExporting.value = true
  try {
    const XLSX = await import('xlsx')
    const columns = []
    const addColumn = (group, label, getValue, options = {}) => columns.push({ group, label, getValue, ...options })
    const addCategory = (group, category, metrics) => metrics.forEach(metric => {
      addColumn(group, category.label, metric.getValue, { category: category.label, leaf: metric.label, percentage: metric.percentage })
    })
    const percent = value => value === null || value === undefined ? '-' : Number(value) / 100
    const moneyOrDash = value => salesCanViewProfit.value && value !== null && value !== undefined ? Number(value || 0) : '-'

    addColumn('经营分析', '销售额', row => Number(row.salesTotal || 0), { vertical: true, money: true })
    addColumn('经营分析', '毛利', row => moneyOrDash(row.grossProfit), { vertical: true, money: true })
    addColumn('经营分析', '费用', row => Number(row.expenseTotal || 0), { vertical: true, money: true })
    addColumn('经营分析', '净利润', row => moneyOrDash(row.netProfit), { vertical: true, money: true })
    addColumn('经营分析', '毛利率', row => salesCanViewProfit.value ? percent(row.grossProfitRate) : '-', { vertical: true, percentage: true })
    addColumn('经营分析', '费用率', row => percent(row.expenseRate), { vertical: true, percentage: true })
    statementMarginCategories.forEach(category => addColumn('经营分析', `${category.label}毛利率`, row => salesCanViewProfit.value ? percent(row.categoryGrossProfitRate?.[category.key]) : '-', { vertical: true, percentage: true }))

    addColumn('销售收入', '合计', row => Number(row.salesTotal || 0), { vertical: true, money: true })
    statementCategories.forEach(category => addCategory('销售收入', category, [
      { label: '销售额', getValue: row => Number(row.sales?.[category.key] || 0), money: true },
      { label: '占比', getValue: row => percent(row.salesShare?.[category.key]), percentage: true }
    ]))

    addColumn('毛利构成', '合计', row => moneyOrDash(row.grossProfit), { vertical: true, money: true })
    statementCategories.forEach(category => addCategory('毛利构成', category, [
      { label: '毛利', getValue: row => moneyOrDash(row.categoryGrossProfit?.[category.key]), money: true },
      { label: '占比', getValue: row => salesCanViewProfit.value ? percent(row.categoryGrossProfitShare?.[category.key]) : '-', percentage: true }
    ]))
    addColumn('毛利构成', '审批调整及口径差额', row => moneyOrDash(row.grossProfitAdjustment), { vertical: true, money: true })
    addColumn('毛利构成', '已确认返利（单列）', row => moneyOrDash(row.rebate), { vertical: true, money: true })

    addColumn('费用构成', '合计', row => Number(row.expenseTotal || 0), { vertical: true, money: true })
    addColumn('费用构成', '固定费用', row => Number(row.expenses?.fixed || 0), { vertical: true, money: true })
    addColumn('费用构成', '人员费用', row => Number(row.expenses?.personnel || 0), { vertical: true, money: true })
    addColumn('费用构成', '日常费用', row => Number(row.expenses?.daily || 0), { vertical: true, money: true })
    addColumn('费用构成', '其他费用', row => Number(row.expenses?.other || 0), { vertical: true, money: true })

    const headerTop = ['门店编号', '门店名称']
    const headerMiddle = ['', '']
    const headerBottom = ['', '']
    const merges = [{ s: { r: 0, c: 0 }, e: { r: 2, c: 0 } }, { s: { r: 0, c: 1 }, e: { r: 2, c: 1 } }]
    let columnIndex = 2
    while (columnIndex < columns.length + 2) {
      const group = columns[columnIndex - 2].group
      const start = columnIndex
      while (columnIndex < columns.length + 2 && columns[columnIndex - 2].group === group) columnIndex += 1
      headerTop[start] = group
      for (let col = start + 1; col < columnIndex; col += 1) headerTop[col] = ''
      if (columnIndex - start > 1) merges.push({ s: { r: 0, c: start }, e: { r: 0, c: columnIndex - 1 } })
    }

    columns.forEach((column, index) => {
      const col = index + 2
      if (column.category) {
        const isFirstCategoryColumn = index === 0 || columns[index - 1].category !== column.category || columns[index - 1].group !== column.group
        headerMiddle[col] = isFirstCategoryColumn ? column.category : ''
        headerBottom[col] = column.leaf
        if (isFirstCategoryColumn) {
          const span = columns.slice(index).findIndex(next => next.group !== column.group || next.category !== column.category)
          const endIndex = span < 0 ? columns.length - 1 : index + span - 1
          if (endIndex > index) merges.push({ s: { r: 1, c: col }, e: { r: 1, c: endIndex + 2 } })
        }
      } else {
        headerMiddle[col] = column.label
        headerBottom[col] = ''
        merges.push({ s: { r: 1, c: col }, e: { r: 2, c: col } })
      }
    })

    const rows = salesStatementRows.value.map(row => [row.storeId || '', row.storeName || '', ...columns.map(column => column.getValue(row))])
    const worksheet = XLSX.utils.aoa_to_sheet([headerTop, headerMiddle, headerBottom, ...rows])
    worksheet['!merges'] = merges
    worksheet['!cols'] = [{ wch: 16 }, { wch: 22 }, ...columns.map(column => ({ wch: column.category ? 13 : 15 }))]
    worksheet['!views'] = [{ state: 'frozen', xSplit: 2, ySplit: 3 }]
    rows.forEach((row, rowIndex) => columns.forEach((column, columnIndex) => {
      const cell = worksheet[XLSX.utils.encode_cell({ r: rowIndex + 3, c: columnIndex + 2 })]
      if (cell && typeof cell.v === 'number' && column.money) cell.z = '¥#,##0.00'
      if (cell && typeof cell.v === 'number' && column.percentage) cell.z = '0.00%'
    }))

    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, '销售报表')
    const period = salesStatementLoadedPeriod.value || {}
    const start = String(period.start || salesStatementPeriod.value[0] || '').replace('-', '.')
    const end = String(period.end || salesStatementPeriod.value[1] || '').replace('-', '.')
    const range = start === end ? start : `${start}-${end}`
    XLSX.writeFile(workbook, `销售报表_${range}.xlsx`)
  } catch (error) {
    console.error('导出销售报表失败:', error)
    ElMessage.error('销售报表导出失败，请稍后重试')
  } finally {
    salesStatementExporting.value = false
  }
}

</script>

<style scoped>
.module-tabs :deep(.el-tabs__header) {
  display: none;
}



.sales-statement-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}
.sales-statement-period {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.sales-statement-hint {
  color: #748196;
  font-size: 12px;
}
.sales-statement-table {
  width: 100%;
}
.sales-statement-table :deep(.sales-statement-total-row td) {
  background: #f0f6ff !important;
  font-weight: 700;
}

.filter-bar {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}
.source-analysis-note {
  margin-bottom: 14px;
}
.source-summary {
  margin-bottom: 16px;
}
.source-summary strong {
  color: #1f2d3d;
  font-size: 20px;
}
.source-metric-label {
  margin-bottom: 6px;
  color: #748196;
  font-size: 12px;
}
.source-category-tag {
  margin: 2px 5px 2px 0;
}
.chart-container {
  margin-top: 20px;
}
.chart {
  height: 300px;
}
.employee-detail-report {
  margin-top: 24px;
  padding-top: 18px;
  border-top: 1px solid #e8edf4;
}
.report-section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}
.report-section-heading h3 {
  margin: 0 0 5px;
  color: #1d2a3e;
  font-size: 16px;
}
.report-section-heading p {
  margin: 0;
  color: #748196;
  font-size: 12px;
}
.employee-detail-filters {
  padding: 12px;
  border: 1px solid #e7edf5;
  border-radius: 8px;
  background: #f8fafd;
}

.performance-reason {
  display: flex;
  flex-direction: column;
  gap: 3px;
  color: #59677a;
  line-height: 1.5;
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
.snapshot-breakdown {
  margin-bottom: 12px;
}
.snapshot-detail-table {
  margin-bottom: 12px;
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
