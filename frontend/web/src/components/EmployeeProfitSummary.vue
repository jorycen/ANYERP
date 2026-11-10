<template>
  <div v-loading="loading">
    <div class="toolbar">
      <el-date-picker v-model="dates" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" />
      <el-radio-group v-model="reportRole" @change="changeRole"><el-radio-button v-for="r in reportRoles" :key="r.value" :label="r.value">{{ r.label }}</el-radio-button></el-radio-group>
      <el-select v-model="storeId" filterable clearable placeholder="选择门店" style="width:180px"><el-option v-for="s in filters.stores" :key="s.storeId" :label="s.storeName || s.name" :value="String(s.storeId)" /></el-select>
      <el-select v-if="!['product','operations'].includes(reportRole)" v-model="employeeId" filterable clearable placeholder="选择员工" style="width:160px"><el-option v-for="s in filters.employees" :key="s.staffId" :label="s.employeeName || s.name" :value="String(s.staffId)" /></el-select>
      <el-button type="primary" @click="load">查询</el-button>
      <el-button type="success" :disabled="!applied || loading" :loading="exporting" @click="exportFile">导出员工汇总</el-button>
      <el-button v-if="data.canConfigure" @click="openConfig">提成参数配置</el-button>
    </div>
    <el-row :gutter="16" class="panels">
      <el-col v-for="p in visiblePanels" :key="p.key" :span="visiblePanels.length === 1 ? 24 : 8"><el-card shadow="never"><div>{{ p.name }}毛利 / 提成</div><strong>{{ money(data.panels?.[p.key]?.grossProfit) }} / {{ money(data.panels?.[p.key]?.commission, p.key === 'sales' ? (data.panels?.sales?.status === 'pending' ? '待核算' : '待配置') : '待定') }}</strong></el-card></el-col>
    </el-row>
    <el-alert v-if="data.note" :title="data.note" type="info" :closable="false" class="note" />
    <el-table :data="data.rows || []" border stripe>
      <el-table-column v-if="data.reportRole === 'manager'" type="expand"><template #default="{row}">
        <el-table :data="row.commissionDetails || []" border size="small" style="margin:12px;width:calc(100% - 24px)">
          <el-table-column prop="businessDate" label="业绩日期" width="120" />
          <el-table-column prop="orderNo" label="业务单号" min-width="220" />
          <el-table-column prop="sourceOrderNo" label="原销售单号" min-width="220" />
          <el-table-column v-for="f in stageDetailColumns" :key="f.key" :label="f.label" min-width="150"><template #default="{row:detail}">{{ money(detail[f.key]) }}</template></el-table-column>
        </el-table>
        <p class="detail-note">费用扣减按两个阶段个人毛利占比分摊，见汇总列；退货冲回原单阶段。</p>
      </template></el-table-column>
      <el-table-column v-for="c in data.columns || []" :key="c.key" :label="c.label" :min-width="c.key === 'remark' ? 300 : 125"><template #default="{ row }">{{ typeof row.cells?.[c.key] === 'number' ? money(row.cells[c.key]) : row.cells?.[c.key] }}</template></el-table-column>
    </el-table>
    <el-dialog v-model="configOpen" title="月度提成参数配置" width="900px" destroy-on-close>
      <div class="toolbar"><el-date-picker v-model="month" type="month" value-format="YYYY-MM" :clearable="false" @change="loadConfig" /><span>按月独立保存，0 表示明确零基数</span></div>
      <div v-loading="configLoading">
        <h4>个人提成基数</h4>
        <el-table :data="config.employees" max-height="320" border><el-table-column prop="employeeName" label="员工" /><el-table-column prop="storeName" label="门店" /><el-table-column label="提成基数"><template #default="{ row }"><el-input v-model="row.commissionBase" placeholder="待配置" /></template></el-table-column><el-table-column label="操作" width="90"><template #default="{ row }"><el-button link type="primary" :disabled="saving" @click="save('staff', row)">保存</el-button></template></el-table-column></el-table>
        <h4>门店盈亏平衡线（按当月全店销售端流水累计；跨线前个人毛利15%，跨线后个人毛利25%）</h4>
        <el-table :data="config.stores" max-height="260" border><el-table-column prop="storeName" label="门店" /><el-table-column label="盈亏平衡线"><template #default="{ row }"><el-input v-model="row.breakEvenLine" placeholder="待配置" /></template></el-table-column><el-table-column label="操作" width="90"><template #default="{ row }"><el-button link type="primary" :disabled="saving" @click="save('store', row)">保存</el-button></template></el-table-column></el-table>
      </div>
      <template #footer><el-button @click="configOpen = false">关闭</el-button></template>
    </el-dialog>
  </div>
</template>
<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
const local = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
const dates = ref([local.slice(0,7) + '-01', local]), storeId = ref(''), employeeId = ref('')
const filters = ref({ stores: [], employees: [] }), data = ref({}), applied = ref(null), loading = ref(false), exporting = ref(false)
const configOpen = ref(false), configLoading = ref(false), saving = ref(false), month = ref(local.slice(0,7)), config = ref({ employees: [], stores: [] })
const panels = [{ key: 'sales', name: '销售端' }, { key: 'product', name: '产品端' }, { key: 'operations', name: '运营端' }]
const reportRole=ref('all')
const reportRoles=[{value:'all',label:'全部'},{value:'staff',label:'店员'},{value:'manager',label:'店长'},{value:'product',label:'产品'},{value:'operations',label:'运营'}]
const stageDetailColumns=[{key:'storeGrossBefore',label:'门店累计毛利（前）'},{key:'storeGrossAfter',label:'门店累计毛利（后）'},{key:'grossProfit',label:'个人毛利'},{key:'lowGrossProfit',label:'15%阶段个人毛利'},{key:'highGrossProfit',label:'25%阶段个人毛利'}]
const visiblePanels=computed(()=>panels.filter(p=>!data.value.reportRole||data.value.reportRole==='all'||p.key===(['staff','manager'].includes(data.value.reportRole)?'sales':data.value.reportRole)))
async function changeRole(){if(['product','operations'].includes(reportRole.value))employeeId.value='';await load()}
const money = (v, empty = '待核算') => v == null || v === '' ? empty : '¥' + Number(v).toLocaleString('zh-CN', {minimumFractionDigits:2,maximumFractionDigits:2})
const error = e => ElMessage.error(e.response?.data?.message || e.message || '操作失败')
async function load() {
  if (!dates.value?.[0] || !dates.value?.[1]) return ElMessage.warning('请选择日期范围')
  loading.value = true
  const params = {startDate:dates.value[0],endDate:dates.value[1],storeId:storeId.value,employeeId:employeeId.value,reportRole:reportRole.value}
  try { const r = await api.getEmployeeProfitSummary(params); data.value = r.data; applied.value = {...params} } catch(e) { data.value = {}; applied.value = null; error(e) } finally { loading.value = false }
}
async function exportFile() { exporting.value = true; try { await api.exportEmployeeProfitSummary(applied.value) } catch(e) { error(e) } finally { exporting.value = false } }
async function loadConfig() { configLoading.value = true; try { const r = await api.getCommissionConfig({month:month.value,storeId:storeId.value}); config.value = r.data; config.value.employees.forEach(e => {e.storeName = config.value.stores.find(s => s.storeId === e.storeId)?.storeName || ''}) } catch(e) { config.value = {employees:[],stores:[]}; error(e) } finally { configLoading.value = false } }
async function openConfig() { month.value = dates.value?.[0]?.slice(0,7) || local.slice(0,7); configOpen.value = true; await loadConfig() }
async function save(type,row) {
  saving.value = true
  try { await api.saveCommissionConfig({month:month.value,entityType:type,entityId:type==='staff'?row.staffId:row.storeId,amount:type==='staff'?row.commissionBase:row.breakEvenLine,revision:row.revision}); ElMessage.success('已保存'); await loadConfig(); await load() } catch(e) {error(e)} finally {saving.value=false}
}
onMounted(async()=>{try{const r=await api.getDashboardFilters(); filters.value=r.data || filters.value}catch(e){error(e)} await load()})
</script>
<style scoped>
.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:18px}.panels{margin-bottom:18px}.panels strong{display:block;font-size:21px;margin-top:12px}.note{margin-bottom:16px}h4{margin:20px 0 12px}
</style>
