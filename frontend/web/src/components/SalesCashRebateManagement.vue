<template>
  <div class="sales-cash-rebate-management">
    <el-alert
      title="销售红包按每台已售 SN 计算。套回单经财务审批后进入待收款；财务登记到账账户和实际金额后，系统记账户流水并将到账金额计入对应商品毛利。"
      type="info"
      :closable="false"
      show-icon
      style="margin-bottom: 14px"
    />

    <el-tabs v-model="activeTab" @tab-change="loadActive">
      <el-tab-pane label="红包政策" name="policies">
        <div class="filter-bar">
          <el-input v-model="policyQuery.pn" placeholder="按 PN 搜索" clearable style="width: 190px" @keyup.enter="loadPolicies" />
          <el-button type="primary" @click="loadPolicies">查询</el-button>
          <el-button type="primary" plain @click="downloadTemplate">下载模板</el-button>
          <el-button type="success" :loading="importing" @click="fileInput?.click()">上传政策清单</el-button>
          <input ref="fileInput" type="file" accept=".xlsx,.xls" hidden @change="importPolicies" />
        </div>
        <el-table :data="policies" border stripe v-loading="policyLoading">
          <el-table-column prop="pn_code" label="PN" min-width="140" />
          <el-table-column prop="product_name" label="商品名称" min-width="180" />
          <el-table-column prop="rebate_type" label="红包类型" min-width="130" />
          <el-table-column label="单台金额" width="120" align="right"><template #default="{ row }">¥{{ money(row.amount) }}</template></el-table-column>
          <el-table-column label="供应商" min-width="150"><template #default="{ row }">{{ row.supplier_name || '所有供应商' }}</template></el-table-column>
          <el-table-column label="有效期" min-width="190"><template #default="{ row }">{{ dateText(row.effective_start) }} 至 {{ dateText(row.effective_end) }}</template></el-table-column>
          <el-table-column prop="remark" label="备注" min-width="160" show-overflow-tooltip />
          <el-table-column prop="update_time" label="更新时间" width="170" />
        </el-table>
        <el-pagination
          v-model:current-page="policyQuery.page"
          v-model:page-size="policyQuery.pageSize"
          :total="policyTotal"
          layout="total, sizes, prev, pager, next"
          @size-change="loadPolicies"
          @current-change="loadPolicies"
        />
      </el-tab-pane>

      <el-tab-pane label="可套回销售明细" name="eligible">
        <div class="filter-bar">
          <el-input v-model="eligibleQuery.pn" placeholder="PN" clearable style="width: 160px" @keyup.enter="loadEligible" />
          <el-input v-model="eligibleQuery.snCode" placeholder="SN" clearable style="width: 180px" @keyup.enter="loadEligible" />
          <el-button type="primary" @click="loadEligible">查询</el-button>
          <el-button type="success" :disabled="selectedEligible.length === 0" :loading="claimSubmitting" @click="submitClaim">批量申请套回</el-button>
          <span class="selection-summary">已选 {{ selectedEligible.length }} 台，预计 ¥{{ money(selectedAmount) }}</span>
        </div>
        <el-table :data="eligibleRows" border stripe v-loading="eligibleLoading" @selection-change="selection => selectedEligible = selection">
          <el-table-column type="selection" width="48" />
          <el-table-column prop="archiveTime" label="销售归档时间" width="165"><template #default="{ row }">{{ dateTime(row.archiveTime) }}</template></el-table-column>
          <el-table-column prop="orderNo" label="销售订单" min-width="170" />
          <el-table-column prop="snCode" label="SN" min-width="140" />
          <el-table-column prop="pnCode" label="PN" min-width="120" />
          <el-table-column prop="productName" label="商品名称" min-width="180" />
          <el-table-column prop="supplierName" label="供应商" min-width="140" />
          <el-table-column prop="rebateType" label="红包类型" min-width="120" />
          <el-table-column label="预计套回" width="120" align="right"><template #default="{ row }">¥{{ money(row.amount) }}</template></el-table-column>
        </el-table>
        <el-pagination v-model:current-page="eligibleQuery.page" v-model:page-size="eligibleQuery.pageSize" :total="eligibleTotal" layout="total, sizes, prev, pager, next" @size-change="loadEligible" @current-change="loadEligible" />
      </el-tab-pane>

      <el-tab-pane label="套回申请记录" name="claims">
        <div class="filter-bar">
          <el-select v-model="claimQuery.status" placeholder="全部状态" clearable style="width: 150px" @change="loadClaims">
            <el-option label="待审批" value="pending_finance" />
            <el-option label="审批通过" value="approved" />
            <el-option label="已拒绝" value="rejected" />
          </el-select>
          <el-button @click="loadClaims">刷新</el-button>
        </div>
        <el-table :data="claims" border stripe v-loading="claimLoading" row-key="claim_id">
          <el-table-column type="expand">
            <template #default="{ row }">
              <el-table :data="row.items || []" size="small" border>
                <el-table-column prop="order_no" label="销售订单" min-width="170" />
                <el-table-column prop="sn_code" label="SN" min-width="140" />
                <el-table-column prop="product_name" label="商品名称" min-width="180" />
                <el-table-column prop="rebate_type" label="红包类型" min-width="120" />
                <el-table-column label="金额" width="120" align="right"><template #default="{ row: item }">¥{{ money(item.amount) }}</template></el-table-column>
                <el-table-column prop="resource_settlement_id" label="待收款明细" min-width="180"><template #default="{ row: item }">{{ item.resource_settlement_id || '-' }}</template></el-table-column>
              </el-table>
            </template>
          </el-table-column>
          <el-table-column prop="claim_no" label="套回单号" min-width="190" />
          <el-table-column prop="create_time" label="提交时间" width="170"><template #default="{ row }">{{ dateTime(row.create_time) }}</template></el-table-column>
          <el-table-column prop="supplier_name" label="供应商" min-width="140" />
          <el-table-column prop="rebate_type" label="红包类型" min-width="120" />
          <el-table-column prop="item_count" label="台数" width="80" align="right" />
          <el-table-column label="申请金额" width="120" align="right"><template #default="{ row }">¥{{ money(row.total_amount) }}</template></el-table-column>
          <el-table-column label="状态" width="110"><template #default="{ row }"><el-tag :type="claimStatusType(row.status)">{{ claimStatusText(row.status) }}</el-tag></template></el-table-column>
          <el-table-column prop="applicant_name" label="申请人" width="110" />
          <el-table-column prop="review_comment" label="审批意见" min-width="160" show-overflow-tooltip />
        </el-table>
        <el-pagination v-model:current-page="claimQuery.page" v-model:page-size="claimQuery.pageSize" :total="claimTotal" layout="total, sizes, prev, pager, next" @size-change="loadClaims" @current-change="loadClaims" />
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="importResultVisible" title="导入结果" width="720px">
      <el-result :icon="importResult?.failed ? 'warning' : 'success'" :title="importResult?.message || ''" :sub-title="`成功 ${importResult?.success || 0} 条，失败 ${importResult?.failed || 0} 条`" />
      <el-table v-if="importResult?.rows?.length" :data="importResult.rows" border max-height="320">
        <el-table-column prop="row" label="行号" width="80" />
        <el-table-column prop="pn" label="PN" min-width="150" />
        <el-table-column prop="status" label="结果" width="100"><template #default="{ row }"><el-tag :type="row.status === 'success' ? 'success' : 'danger'">{{ row.status === 'success' ? '成功' : '失败' }}</el-tag></template></el-table-column>
        <el-table-column prop="message" label="说明" min-width="240" />
      </el-table>
      <template #footer><el-button type="primary" @click="importResultVisible = false">关闭</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'

const activeTab = ref('policies')
const fileInput = ref(null)
const importing = ref(false)
const policyLoading = ref(false)
const eligibleLoading = ref(false)
const claimLoading = ref(false)
const claimSubmitting = ref(false)
const importResultVisible = ref(false)
const importResult = ref(null)
const policies = ref([])
const policyTotal = ref(0)
const eligibleRows = ref([])
const eligibleTotal = ref(0)
const selectedEligible = ref([])
const claims = ref([])
const claimTotal = ref(0)
const policyQuery = reactive({ pn: '', page: 1, pageSize: 20 })
const eligibleQuery = reactive({ pn: '', snCode: '', page: 1, pageSize: 20 })
const claimQuery = reactive({ status: '', page: 1, pageSize: 20 })
const selectedAmount = computed(() => selectedEligible.value.reduce((sum, row) => sum + Number(row.amount || 0), 0))
const money = value => Number(value || 0).toFixed(2)
const dateText = value => value ? String(value).slice(0, 10) : '不限'
const dateTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-'
const claimStatusText = value => ({ pending_finance: '待审批', approved: '审批通过', rejected: '已拒绝' }[value] || value)
const claimStatusType = value => ({ pending_finance: 'warning', approved: 'success', rejected: 'danger' }[value] || 'info')
const unwrap = response => response.data?.data ?? response.data

async function loadPolicies() {
  policyLoading.value = true
  try {
    const data = unwrap(await api.getSalesCashRebatePolicies(policyQuery))
    policies.value = data?.list || []
    policyTotal.value = data?.pagination?.total ?? data?.total ?? 0
  } catch (error) { ElMessage.error(error.response?.data?.message || '加载红包政策失败') }
  finally { policyLoading.value = false }
}

async function loadEligible() {
  eligibleLoading.value = true
  selectedEligible.value = []
  try {
    const data = unwrap(await api.getEligibleSalesCashRebateItems(eligibleQuery))
    eligibleRows.value = data?.list || []
    eligibleTotal.value = data?.total ?? 0
  } catch (error) { ElMessage.error(error.response?.data?.message || '加载可套回销售明细失败') }
  finally { eligibleLoading.value = false }
}

async function loadClaims() {
  claimLoading.value = true
  try {
    const data = unwrap(await api.getSalesCashRebateClaims(claimQuery))
    claims.value = data?.list || []
    claimTotal.value = data?.pagination?.total ?? data?.total ?? 0
  } catch (error) { ElMessage.error(error.response?.data?.message || '加载套回申请记录失败') }
  finally { claimLoading.value = false }
}

function loadActive(tab) {
  if (tab === 'policies') loadPolicies()
  else if (tab === 'eligible') loadEligible()
  else loadClaims()
}

async function downloadTemplate() {
  try {
    const response = await api.getSalesCashRebateTemplate()
    const blob = new Blob([response.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = '商品销售红包模板.xlsx'
    anchor.click()
    URL.revokeObjectURL(url)
  } catch (error) { ElMessage.error(error.response?.data?.message || '下载模板失败') }
}

async function importPolicies(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  importing.value = true
  try {
    importResult.value = unwrap(await api.importSalesCashRebatePolicies(file))
    importResultVisible.value = true
    await loadPolicies()
    await loadEligible()
  } catch (error) { ElMessage.error(error.response?.data?.message || '导入红包政策失败') }
  finally { importing.value = false }
}

async function submitClaim() {
  if (!selectedEligible.value.length) return ElMessage.warning('请先选择可套回的商品')
  const supplierIds = new Set(selectedEligible.value.map(row => String(row.supplierId || '')))
  const rebateTypes = new Set(selectedEligible.value.map(row => String(row.rebateType || '')))
  if (supplierIds.size !== 1 || rebateTypes.size !== 1) return ElMessage.warning('同一张套回单请只选择同一供应商、同一红包类型的商品')
  const total = money(selectedAmount.value)
  try {
    await ElMessageBox.confirm(`将为 ${selectedEligible.value.length} 台商品提交销售红包套回，预计金额 ¥${total}，提交后进入审批。`, '确认批量套回', { type: 'warning' })
    claimSubmitting.value = true
    const result = unwrap(await api.createSalesCashRebateClaim({ items: selectedEligible.value.map(row => ({ orderItemId: row.orderItemId })) }))
    ElMessage.success(result?.message || '套回申请已提交审批')
    selectedEligible.value = []
    await Promise.all([loadEligible(), loadClaims()])
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error.response?.data?.message || '提交套回申请失败')
  } finally { claimSubmitting.value = false }
}

onMounted(() => loadPolicies())
</script>

<style scoped>
.selection-summary { color: #606266; margin-left: 8px; }
</style>
