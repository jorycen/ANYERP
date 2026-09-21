<template>
  <div class="page-container">
    <div class="page-header">
      <h2>采购进项发票管理</h2>
      <div class="header-actions">
        <el-button type="success" :loading="candidateExporting" @click="exportCandidates">导出未登记发票</el-button>
        <el-button type="primary" :loading="importing" @click="invoiceFileInput?.click()">导入发票登记</el-button>
        <input ref="invoiceFileInput" type="file" accept=".xlsx,.xls" class="hidden-file-input" @change="importInvoiceFile" />
      </div>
    </div>
    <el-alert title="先导出全部未登记发票清单，在表格最后填写税号和发票号码后原文件导入；未填写的行会自动跳过。同一张发票对应多笔付款时，请填写相同的税号和发票号码。批量导入按13%专票登记，开票日期默认为导入当天。" type="info" :closable="false" />
    <el-alert title="待收票按有效账户付款流水计算；付款后第20天临期，第30天逾期。点击结算单号可查看该结算单的采购明细。" type="info" :closable="false" />

    <el-row :gutter="12" class="summary">
      <el-col :span="8"><el-statistic title="应收票金额" :value="summary.receivable_amount || 0" prefix="¥" /></el-col>
      <el-col :span="8"><el-statistic title="未收票金额" :value="summary.unreceived_amount || 0" prefix="¥" /></el-col>
      <el-col :span="8"><el-statistic title="逾期未收" :value="summary.overdue_amount || 0" prefix="¥" /></el-col>
    </el-row>

    <el-tabs v-model="activeTab">
      <el-tab-pane label="待收票" name="pending">
        <el-form inline class="filters">
          <el-form-item label="供应商"><el-input v-model="filter.supplier" clearable /></el-form-item>
          <el-form-item label="付款日期"><el-date-picker v-model="filter.dateRange" type="daterange" value-format="YYYY-MM-DD" /></el-form-item>
          <el-form-item label="预警状态">
            <el-select v-model="filter.warning" clearable>
              <el-option label="正常" value="normal" />
              <el-option label="临期" value="near_due" />
              <el-option label="逾期" value="overdue" />
            </el-select>
          </el-form-item>
          <el-button @click="resetFilter">重置</el-button>
          <el-button type="primary" :disabled="!selected.length" @click="openCreate(selected)">统一登记（{{ selected.length }}）</el-button>
        </el-form>
        <el-table :data="filteredRows" border stripe @selection-change="rows => selected = rows">
          <el-table-column type="selection" width="45" />
          <el-table-column prop="supplier_name" label="供应商" min-width="150" />
          <el-table-column label="结算单号" min-width="180">
            <template #default="{ row }"><el-button link type="primary" @click="openSettlementDetail(row)">{{ row.settlement_no || '-' }}</el-button></template>
          </el-table-column>
          <el-table-column prop="payment_time" label="付款时间" width="170" />
          <el-table-column label="付款金额" width="120"><template #default="{ row }">¥{{ money(row.paid_amount) }}</template></el-table-column>
          <el-table-column label="未收票" width="120"><template #default="{ row }">¥{{ money(row.remaining_amount) }}</template></el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }"><el-tag :type="row.warning_status === 'overdue' ? 'danger' : row.warning_status === 'near_due' ? 'warning' : 'success'">{{ warningText(row.warning_status) }}</el-tag></template>
          </el-table-column>
          <el-table-column label="操作" width="90"><template #default="{ row }"><el-button link type="primary" @click="openCreate([row])">登记</el-button></template></el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="已收发票" name="received">
        <div class="received-filters">
          <el-input v-model="invoiceFilter.keyword" clearable placeholder="供应商或发票号码" style="width:220px" @keyup.enter="loadInvoices" />
          <el-date-picker v-model="invoiceFilter.dateRange" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开票开始日期" end-placeholder="开票结束日期" />
          <el-button type="primary" @click="loadInvoices">查询</el-button>
          <el-button @click="resetInvoiceFilter">重置</el-button>
          <el-button type="success" :loading="exporting" @click="exportInvoices">导出</el-button>
        </div>
        <el-table :data="invoices" border stripe>
          <el-table-column prop="supplier_name" label="供应商" min-width="150" />
          <el-table-column prop="invoice_no" label="发票号码" min-width="150" />
          <el-table-column prop="invoice_date" label="开票日期" width="120" />
          <el-table-column prop="invoice_type" label="票种" min-width="150" />
          <el-table-column label="税率" width="90"><template #default="{ row }">{{ taxRateText(row.tax_rate) }}</template></el-table-column>
          <el-table-column label="价税合计" width="120"><template #default="{ row }">¥{{ money(row.total_amount) }}</template></el-table-column>
          <el-table-column label="关联结算单" min-width="230">
            <template #default="{ row }">
              <div v-for="link in row.settlement_links || []" :key="`${row.invoice_id}-${link.settlement_id}`" class="settlement-link">
                <el-button link type="primary" @click="openSettlementDetail(link)">{{ link.settlement_no || '-' }}</el-button>
                <span>分摊 ¥{{ money(link.allocation_amount) }}</span>
              </div>
              <span v-if="!(row.settlement_links || []).length">-</span>
            </template>
          </el-table-column>
          <el-table-column prop="create_user" label="登记人" width="110" />
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="visible" title="登记进项发票" width="860px">
      <el-form :model="form" label-width="100px">
        <el-row :gutter="12">
          <el-col :span="12"><el-form-item label="销方税号" required><el-input v-model="form.supplierTaxNo" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="发票号码" required><el-input v-model="form.invoiceNo" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="开票日期" required><el-date-picker v-model="form.invoiceDate" value-format="YYYY-MM-DD" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="票种" required><el-input v-model="form.invoiceType" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="税率"><el-input-number v-model="form.taxRate" :min="0" :max="1" :step="0.01" /></el-form-item></el-col>
          <el-col :span="8"><el-form-item label="不含税金额"><el-input-number v-model="form.amountWithoutTax" :min="0" :precision="2" /></el-form-item></el-col>
          <el-col :span="8"><el-form-item label="税额"><el-input-number v-model="form.taxAmount" :min="0" :precision="2" /></el-form-item></el-col>
          <el-col :span="8"><el-form-item label="价税合计"><el-input-number v-model="form.totalAmount" :min="0" :precision="2" /></el-form-item></el-col>
        </el-row>
        <el-divider>本票关联付款</el-divider>
        <el-table :data="dialogRows" border>
          <el-table-column prop="supplier_name" label="供应商" min-width="150" />
          <el-table-column label="结算单" min-width="180">
            <template #default="{ row }"><el-button link type="primary" @click="openSettlementDetail(row)">{{ row.settlement_no || '-' }}</el-button></template>
          </el-table-column>
          <el-table-column label="可分摊" width="120"><template #default="{ row }">¥{{ money(row.remaining_amount) }}</template></el-table-column>
          <el-table-column label="本票分摊" width="180"><template #default="{ row }"><el-input-number v-model="amounts[row.payment_id]" :min="0" :max="Number(row.remaining_amount)" :precision="2" /></template></el-table-column>
        </el-table>
      </el-form>
      <template #footer>
        <el-button @click="visible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存并计入已收票</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="settlementDetailVisible" title="结算单采购明细" width="1000px">
      <el-skeleton v-if="settlementDetailLoading" :rows="6" animated />
      <template v-else-if="settlementDetail">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="结算单号">{{ settlementDetail.settlement_no || '-' }}</el-descriptions-item>
          <el-descriptions-item label="供应商">{{ settlementDetail.supplier_name || settlementDetail.payee_name || '-' }}</el-descriptions-item>
          <el-descriptions-item label="结算金额">¥{{ money(settlementDetail.total_amount) }}</el-descriptions-item>
          <el-descriptions-item label="已付金额">¥{{ money(settlementDetail.paid_amount) }}</el-descriptions-item>
          <el-descriptions-item label="结算状态">{{ settlementStatusText(settlementDetail.status) }}</el-descriptions-item>
          <el-descriptions-item label="付款状态">{{ paymentStatusText(settlementDetail.payment_status) }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ settlementDetail.create_time || '-' }}</el-descriptions-item>
          <el-descriptions-item label="备注">{{ settlementDetail.remark || '-' }}</el-descriptions-item>
        </el-descriptions>
        <h4 class="detail-title">本次结算的采购明细</h4>
        <el-table :data="settlementDetail.items || []" border stripe size="small">
          <el-table-column label="采购单号" min-width="170"><template #default="{ row }">{{ row.source_no || row.request_no || '-' }}</template></el-table-column>
          <el-table-column prop="product_name" label="采购商品" min-width="200" />
          <el-table-column label="数量" width="90"><template #default="{ row }">{{ quantity(row.quantity) }}</template></el-table-column>
          <el-table-column label="单价" width="110"><template #default="{ row }">{{ row.unit_price === null || row.unit_price === undefined ? '-' : `¥${money(row.unit_price)}` }}</template></el-table-column>
          <el-table-column label="结算金额" width="120"><template #default="{ row }">¥{{ money(row.amount) }}</template></el-table-column>
        </el-table>
      </template>
      <el-empty v-else description="暂无结算单明细" />
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import * as XLSX from 'xlsx'
import api from '../api'

const activeTab = ref('pending')
const candidates = ref([])
const invoices = ref([])
const summary = ref({})
const visible = ref(false)
const saving = ref(false)
const exporting = ref(false)
const candidateExporting = ref(false)
const importing = ref(false)
const invoiceFileInput = ref(null)
const selected = ref([])
const dialogRows = ref([])
const amounts = ref({})
const settlementDetailVisible = ref(false)
const settlementDetailLoading = ref(false)
const settlementDetail = ref(null)
const filter = reactive({ supplier: '', dateRange: [], warning: '' })
const invoiceFilter = reactive({ keyword: '', dateRange: [] })
const blank = () => ({ supplierTaxNo: '', invoiceNo: '', invoiceDate: '', invoiceType: '增值税专用发票', taxRate: 0.13, amountWithoutTax: 0, taxAmount: 0, totalAmount: 0 })
const form = ref(blank())

const money = value => Number(value || 0).toFixed(2)
const quantity = value => Number.isFinite(Number(value)) ? String(Number(value)) : '-'
const taxRateText = value => value === null || value === undefined || value === '' ? '-' : `${Number(value) * 100}%`
const warningText = value => ({ normal: '正常', near_due: '临期', overdue: '逾期' }[value] || '正常')
const settlementStatusText = value => ({ draft: '草稿', pending_approval: '待审批', confirmed: '待付款', voided: '已作废' }[value] || value || '-')
const paymentStatusText = value => ({ unpaid: '未付款', partial_paid: '部分付款', paid: '已付款' }[value] || value || '-')

const filteredRows = computed(() => candidates.value.filter(row => (
  (!filter.supplier || String(row.supplier_name || '').includes(filter.supplier))
  && (!filter.warning || row.warning_status === filter.warning)
  && (!filter.dateRange.length || (String(row.payment_time).slice(0, 10) >= filter.dateRange[0] && String(row.payment_time).slice(0, 10) <= filter.dateRange[1]))
)))

const invoiceParams = () => ({
  ...(invoiceFilter.keyword ? { keyword: invoiceFilter.keyword } : {}),
  ...(invoiceFilter.dateRange?.length === 2 ? { startDate: invoiceFilter.dateRange[0], endDate: invoiceFilter.dateRange[1] } : {})
})

const loadCandidates = async () => {
  const response = await api.getPurchaseInvoiceCandidates({ status: 'open' })
  candidates.value = response.data?.list || []
  summary.value = response.data?.summary || {}
}
const loadInvoices = async () => {
  const response = await api.getPurchaseInvoices(invoiceParams())
  invoices.value = response.data?.list || []
}
const load = async () => Promise.all([loadCandidates(), loadInvoices()])
const resetFilter = () => Object.assign(filter, { supplier: '', dateRange: [], warning: '' })
const resetInvoiceFilter = () => { Object.assign(invoiceFilter, { keyword: '', dateRange: [] }); loadInvoices() }

const openCreate = rows => {
  if (!rows.length) return
  const first = rows[0]
  if (rows.some(row => String(row.distributor_id || '') !== String(first.distributor_id || '') || String(row.supplier_name || '') !== String(first.supplier_name || ''))) {
    ElMessage.warning('一张发票只能登记同一经销商、同一供应商的付款')
    return
  }
  form.value = blank()
  dialogRows.value = rows
  amounts.value = Object.fromEntries(rows.map(row => [row.payment_id, Number(row.remaining_amount || 0)]))
  visible.value = true
}

const save = async () => {
  saving.value = true
  try {
    await api.createPurchaseInvoice({ ...form.value, allocations: dialogRows.value.map(row => ({ paymentId: row.payment_id, amount: amounts.value[row.payment_id] || 0 })) })
    ElMessage.success('发票已登记')
    visible.value = false
    selected.value = []
    await load()
  } catch (error) {
    ElMessage.error(error.response?.data?.message || error.message || '发票登记失败')
  } finally {
    saving.value = false
  }
}

const openSettlementDetail = async row => {
  if (!row?.settlement_id) return ElMessage.warning('该记录未关联结算单')
  settlementDetail.value = null
  settlementDetailLoading.value = true
  settlementDetailVisible.value = true
  try {
    const response = await api.getSettlementDetail(row.settlement_id)
    if (response.code === 0) settlementDetail.value = response.data || null
    else ElMessage.error(response.message || '加载结算单明细失败')
  } catch (error) {
    settlementDetailVisible.value = false
    ElMessage.error(error.response?.data?.message || error.message || '加载结算单明细失败')
  } finally {
    settlementDetailLoading.value = false
  }
}

const exportInvoices = async () => {
  exporting.value = true
  try {
    await api.exportPurchaseInvoices(invoiceParams())
    ElMessage.success('采购进项发票导出成功')
  } catch (error) {
    ElMessage.error(error.response?.data?.message || '采购进项发票导出失败')
  } finally {
    exporting.value = false
  }
}

const exportCandidates = async () => {
  candidateExporting.value = true
  try {
    await api.exportPurchaseInvoiceCandidates()
    ElMessage.success('未登记发票清单导出成功')
  } catch (error) {
    ElMessage.error(error.response?.data?.message || '未登记发票清单导出失败')
  } finally {
    candidateExporting.value = false
  }
}

const importInvoiceFile = async event => {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  importing.value = true
  try {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
    const worksheet = workbook.Sheets[workbook.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json(worksheet, { defval: '', raw: false })
    if (!rows.length) return ElMessage.warning('导入文件没有数据')
    const importRows = rows.map((row, index) => ({
      excelRow: index + 2,
      paymentId: row['付款流水ID'],
      supplierTaxNo: row['税号'],
      invoiceNo: row['发票号码']
    })).filter(row => String(row.supplierTaxNo || '').trim() || String(row.invoiceNo || '').trim())
    if (!importRows.length) return ElMessage.warning('请先在导出文件中填写税号和发票号码')
    const response = await api.importPurchaseInvoices(importRows)
    if (response.code !== 0) {
      const firstError = response.data?.errors?.[0]
      throw new Error(firstError ? `第${firstError.row || '-'}行：${firstError.message}` : response.message || '导入失败')
    }
    ElMessage.success(response.message || '发票导入登记成功')
    await load()
  } catch (error) {
    const firstError = error.response?.data?.data?.errors?.[0]
    ElMessage.error(firstError ? `第${firstError.row || '-'}行：${firstError.message}` : error.response?.data?.message || error.message || '发票导入失败')
  } finally {
    importing.value = false
  }
}

onMounted(() => load().catch(error => ElMessage.error(error.response?.data?.message || '采购发票数据加载失败')))
</script>

<style scoped>
.page-header,.header-actions,.received-filters,.settlement-link{display:flex;align-items:center}.page-header{justify-content:space-between}.header-actions,.received-filters{gap:12px}.hidden-file-input{display:none}.summary{margin:16px 0}.filters{margin:16px 0 4px}.received-filters{margin:12px 0}.settlement-link{gap:8px}.detail-title{margin:18px 0 8px}
</style>
