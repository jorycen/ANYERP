<template>
  <el-dialog v-model="visible" title="库存毛利计价方式调整" width="95%" top="4vh" @opened="load">
    <el-alert title="按具体在库SN调整，支持所有商品类别。只影响选中库存的后续销售，不改变商品默认方式、实际采购价或已归档订单。无SN数量库存暂不在此列表中。" type="info" :closable="false" show-icon />
    <div class="pricing-filters">
      <el-input v-model="filters.keyword" placeholder="商品／PN／SN／批次" clearable style="width:210px" @keyup.enter="search" />
      <el-select v-model="filters.category" placeholder="全部类别" clearable filterable style="width:150px"><el-option v-for="c in categories" :key="c" :label="c" :value="c" /></el-select>
      <el-select v-model="filters.storeId" placeholder="全部门店" clearable filterable style="width:160px"><el-option v-for="s in stores" :key="s.store_id" :label="s.name" :value="s.store_id" /></el-select>
      <el-select v-model="filters.mode" placeholder="当前计价方式" clearable style="width:150px"><el-option label="按采购价" value="PURCHASE_PRICE" /><el-option label="按公司定价" value="COMPANY_PRICE" /></el-select>
      <el-select v-model="filters.minDays" placeholder="全部库龄" clearable style="width:150px"><el-option v-for="days in [7,15,30]" :key="days" :label="`入库至少${days}天`" :value="days" /></el-select>
      <el-button type="primary" @click="search">查询</el-button>
    </div>
    <el-table ref="table" :data="rows" v-loading="loading" border max-height="430" row-key="snId" @selection-change="selection = $event; invalidate()">
      <el-table-column type="selection" width="45" :selectable="r => !r.blocked" />
      <el-table-column prop="productName" label="商品" min-width="180" show-overflow-tooltip />
      <el-table-column prop="category" label="类别" width="100" />
      <el-table-column prop="snCode" label="SN" min-width="170" />
      <el-table-column prop="pnCode" label="PN" width="140" />
      <el-table-column label="门店" width="110"><template #default="{row}">{{ storeName(row.storeId) }}</template></el-table-column>
      <el-table-column prop="batchNo" label="入库批次" width="140" />
      <el-table-column label="首次入库／库龄" width="165"><template #default="{row}">{{ date(row.inboundTime) }}／{{ row.ageDays ?? '-' }}天</template></el-table-column>
      <el-table-column label="采购价/件" width="110"><template #default="{row}">{{ money(row.purchasePrice) }}</template></el-table-column>
      <el-table-column label="公司定价/件" width="110"><template #default="{row}">{{ money(row.standardPrice) }}</template></el-table-column>
      <el-table-column label="当前方式" width="120"><template #default="{row}">{{ modeText(row.mode) }}</template></el-table-column>
      <el-table-column prop="blocked" label="不可调整原因" min-width="160" />
      <el-table-column label="记录" width="80" fixed="right"><template #default="{row}"><el-button link type="primary" @click="showHistory(row)">历史</el-button></template></el-table-column>
    </el-table>
    <el-pagination v-model:current-page="filters.page" :page-size="filters.pageSize" :total="total" layout="total, prev, pager, next" @current-change="load" />
    <div class="pricing-filters">
      <span>已选 {{ selection.length }} 条</span>
      <el-select v-model="targetMode" style="width:180px" @change="invalidate"><el-option label="改为公司定价" value="COMPANY_PRICE" /><el-option label="改为采购价" value="PURCHASE_PRICE" /></el-select>
      <el-button type="primary" :disabled="!selection.length" :loading="previewLoading" @click="preview">预览调整</el-button>
    </div>
    <template v-if="previewData">
      <el-table :data="previewData.list" border max-height="260">
        <el-table-column prop="snCode" label="SN" min-width="160" />
        <el-table-column label="调整前 → 调整后" min-width="190"><template #default="{row}">{{ modeText(row.mode) }} → {{ modeText(row.targetMode) }}</template></el-table-column>
        <el-table-column label="调整后当前计价/件" width="170"><template #default="{row}">{{ money(row.targetMode === 'COMPANY_PRICE' ? row.standardPrice : row.purchasePrice) }}</template></el-table-column>
        <el-table-column label="校验结果" min-width="180"><template #default="{row}"><span :style="{color: row.blocked ? '#f56c6c' : '#e6a23c'}">{{ row.blocked || row.warning || '可调整' }}</span></template></el-table-column>
      </el-table>
      <p>预览金额使用当前价格；按公司定价的库存销售时读取有效定价，归档后冻结。</p>
      <el-input v-model="reason" type="textarea" :rows="2" maxlength="512" show-word-limit placeholder="调整原因（必填）" />
      <el-checkbox v-if="hasWarning" v-model="confirmBelowCost">我已确认公司定价低于实际采购价，并在原因中说明</el-checkbox>
    </template>
    <template #footer><el-button @click="visible = false">关闭</el-button><el-button type="primary" :disabled="!canApply" :loading="applying" @click="apply">确认调整</el-button></template>
    <el-dialog v-model="historyVisible" title="库存计价调整记录" width="800px" append-to-body>
      <el-table :data="historyRows" border>
        <el-table-column prop="actor_name" label="操作人" width="100" />
        <el-table-column label="时间" width="170"><template #default="{row}">{{ new Date(row.create_time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) }}</template></el-table-column>
        <el-table-column label="调整前 → 调整后" width="200"><template #default="{row}">{{ modeText(row.from_status) }} → {{ modeText(row.to_status) }}</template></el-table-column>
        <el-table-column prop="comment" label="原因" min-width="200" />
      </el-table>
    </el-dialog>
  </el-dialog>
</template>
<script setup>
import { ref, reactive, computed } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
const visible = defineModel({ type: Boolean, default: false })
const filters = reactive({ keyword: '', category: '', storeId: '', mode: 'PURCHASE_PRICE', minDays: '', page: 1, pageSize: 50 })
const rows = ref([]), stores = ref([]), categories = ref([]), total = ref(0), selection = ref([]), table = ref(null)
const loading = ref(false), previewLoading = ref(false), applying = ref(false), targetMode = ref('COMPANY_PRICE')
const previewData = ref(null), reason = ref(''), confirmBelowCost = ref(false)
const historyVisible = ref(false), historyRows = ref([])
const modeText = m => m === 'COMPANY_PRICE' ? '按公司定价' : '按采购价'
const money = v => v === null || v === undefined ? '待补' : `¥${Number(v).toFixed(2)}`
const date = v => v ? new Date(v).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '-'
const storeName = id => stores.value.find(s => s.store_id === id)?.name || id
const hasWarning = computed(() => previewData.value?.list.some(r => r.warning))
const canApply = computed(() => previewData.value && !previewData.value.list.some(r => r.blocked) && reason.value.trim() && (!hasWarning.value || confirmBelowCost.value))
const invalidate = () => { previewData.value = null; confirmBelowCost.value = false }
let sequence = 0
async function load() {
  const requestId = ++sequence
  invalidate(); table.value?.clearSelection(); selection.value = []; loading.value = true
  try {
    const res = await api.getInventoryPricing({ ...filters })
    if (requestId !== sequence) return
    if (res.code !== 0) throw new Error(res.message)
    rows.value = res.data.list; total.value = res.data.total; stores.value = res.data.stores; categories.value = res.data.categories
  } catch (e) { ElMessage.error(e.response?.data?.message || e.message || '读取库存失败') }
  finally { if (requestId === sequence) loading.value = false }
}
function search() { filters.page = 1; load() }
async function showHistory(row) {
  try {
    const res = await api.getInventoryPricingHistory(row.snId)
    if (res.code !== 0) throw new Error(res.message)
    historyRows.value = res.data; historyVisible.value = true
  } catch (e) { ElMessage.error(e.response?.data?.message || e.message || '读取历史失败') }
}
async function preview() {
  previewLoading.value = true
  const snIds = selection.value.map(r => r.snId), mode = targetMode.value
  const selectedKey = JSON.stringify([snIds, mode])
  try {
    const res = await api.previewInventoryPricing({ snIds, mode })
    if (JSON.stringify([selection.value.map(r => r.snId), targetMode.value]) !== selectedKey) return
    if (res.code !== 0) throw new Error(res.message)
    previewData.value = { ...res.data, snIds, mode }; confirmBelowCost.value = false
  } catch (e) { ElMessage.error(e.response?.data?.message || e.message || '预览失败') }
  finally { previewLoading.value = false }
}
async function apply() {
  if (!canApply.value || applying.value) return
  applying.value = true
  try {
    const { snIds, mode, previewHash } = previewData.value
    const res = await api.applyInventoryPricing({ snIds, mode, previewHash, reason: reason.value.trim(), confirmBelowCost: confirmBelowCost.value })
    if (res.code !== 0) throw new Error(res.message)
    ElMessage.success(res.message); reason.value = ''; await load()
  } catch (e) { ElMessage.error(e.response?.data?.message || e.message || '调整失败'); invalidate() }
  finally { applying.value = false }
}
</script>
<style scoped>.pricing-filters{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:14px 0}</style>
