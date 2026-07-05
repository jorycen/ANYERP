<template>
  <div class="reports-page">
    <el-card>
      <template #header>
        <span>报表统计</span>
      </template>

      <el-tabs v-model="activeTab" @tab-change="onTabChange">
        <el-tab-pane label="经营数据看板" name="dashboard">
          <BusinessDashboard />
        </el-tab-pane>

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
            <div class="summary-item">销售额：<strong>¥{{ formatMoney(employeeSummary.totalAmount) }}</strong></div>
            <div class="summary-item">实收：<strong>¥{{ formatMoney(employeeSummary.actualPayment) }}</strong></div>
            <div class="summary-item">基础毛利：<strong>¥{{ formatMoney(employeeSummary.baseGrossProfit) }}</strong></div>
            <div class="summary-item">已审批调整：<strong :class="Number(employeeSummary.approvedAdjustment || 0) >= 0 ? 'profit-positive' : 'profit-negative'">¥{{ formatMoney(employeeSummary.approvedAdjustment) }}</strong></div>
            <div class="summary-item">业绩毛利：<strong>¥{{ formatMoney(employeeSummary.grossProfit) }}</strong></div>
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
                    <el-table-column label="销售小计" width="110">
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
            <el-table-column label="基础毛利" width="105">
              <template #default="{ row }">
                ¥{{ formatMoney(row.baseGrossProfit) }}
                <el-tooltip v-if="row.grossProfitSource === 'legacy_fallback'" content="历史订单兼容口径" placement="top">
                  <el-tag size="small" type="warning">旧</el-tag>
                </el-tooltip>
              </template>
            </el-table-column>
            <el-table-column label="已审调整" width="105">
              <template #default="{ row }">
                <span :class="row.approvedAdjustment >= 0 ? 'profit-positive' : 'profit-negative'">¥{{ formatMoney(row.approvedAdjustment) }}</span>
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
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import * as echarts from 'echarts'
import api from '../api'
import { getRoleCode } from '../utils/user'
import BusinessDashboard from '../components/BusinessDashboard.vue'

const activeTab = ref('dashboard')
const stores = ref([])
const salesData = ref([])
const inventoryData = ref([])
const employeeData = ref([])
const employeeOptions = ref([])
const employeeSummary = ref({})
const employeeTotal = ref(0)
const employeeLoading = ref(false)
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

const salesParams = reactive({ date: '', regionCode: '' })
const inventoryParams = reactive({ storeId: '' })
const employeeParams = reactive({ dateRange: [], storeId: '', staffName: '', page: 1, pageSize: 20 })
const adjustmentForm = reactive({ adjustmentType: 'increase', amount: 0.01, reason: '' })
const adjustmentParams = reactive({ page: 1, pageSize: 20 })
const currentRoles = String(getRoleCode() || '').split(',').map(role => role.trim())
const canReviewAdjustments = computed(() => currentRoles.includes('finance') || currentRoles.includes('admin'))
const adjustmentCenterTitle = computed(() => {
  if (adjustmentScope.value === 'review') return '待我审核的毛利调整'
  if (adjustmentScope.value === 'order') return `订单 ${adjustmentOrder.value?.orderNo || ''} 的毛利调整记录`
  return '我的毛利调整申请'
})

onMounted(() => {
  loadStores()
})

const onTabChange = (tabName) => {
  if (tabName === 'sales' && salesData.value.length === 0) {
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
