<template>
  <div class="toolbar">
    <el-date-picker v-model="monthKey" type="month" value-format="YYYY-MM" :clearable="false" @change="load" />
    <el-select v-model="filters.source" clearable placeholder="全部来源">
      <el-option v-for="(label, value) in sources" :key="value" :label="label" :value="value" />
    </el-select>
    <el-select v-model="filters.kind" clearable placeholder="全部类型">
      <el-option label="经营指标" value="operating" /><el-option label="管理指标" value="management" /><el-option label="销售能力指标" value="ability" />
    </el-select>
    <el-select v-model="filters.storeId" clearable filterable placeholder="全部门店">
      <el-option v-for="store in data.stores" :key="store.store_id" :label="store.name" :value="store.store_id" />
    </el-select>
    <el-select v-model="filters.allocationStatus" clearable placeholder="全部分解状态">
      <el-option v-for="(label, value) in allocationLabels" :key="value" :label="label" :value="value" />
    </el-select>
    <el-button @click="load">查询</el-button>
    <div v-if="data.stores.length" class="toolbar-actions">
      <el-button @click="showDefinitions">指标配置</el-button>
      <el-button type="primary" :disabled="monthKey < currentMonth" @click="openPublish">下发指标</el-button>
    </div>
  </div>
  <el-alert v-if="monthKey < currentMonth" title="历史月份只读" type="info" :closable="false" style="margin-bottom: 12px" />
  <el-table :data="data.groupedOverview" stripe border v-loading="loading" row-key="id" empty-text="所选月份没有匹配的下发指标">
    <el-table-column prop="name" label="指标" min-width="155" />
    <el-table-column label="所属公司" min-width="130"><template #default="{ row }">{{ distributorName(row.distributorId) }}</template></el-table-column>
    <el-table-column label="来源" width="100"><template #default="{ row }">{{ sources[row.source] }}</template></el-table-column>
    <el-table-column label="门店数" width="90"><template #default="{ row }">{{ row.storeCount }}</template></el-table-column>
    <el-table-column label="总目标" min-width="125"><template #default="{ row }">
      <div v-for="metric in row.metrics" :key="metric.metric">{{ labels[metric.metric] }} {{ metric.target }}</div>
    </template></el-table-column>
    <el-table-column label="已分解" min-width="125"><template #default="{ row }">
      <div v-for="metric in row.metrics" :key="metric.metric">{{ labels[metric.metric] }} 门店 {{ metric.storeAllocated }} / 员工 {{ metric.allocated }}</div>
    </template></el-table-column>
    <el-table-column label="操作" width="240"><template #default="{ row }">
      <el-button link type="primary" @click="openStores(row)">查看分解</el-button>
      <el-button v-if="row.canDelete && row.definitionId && monthKey >= currentMonth" link type="primary" @click="editTotal(row)">调整总目标</el-button>
      <el-button v-if="row.canDelete && monthKey >= currentMonth" link type="danger" @click="deleteTarget({ metrics: [{ indicator_id: row.anchorId }] }, 'indicator')">删除指标</el-button>
    </template></el-table-column>
  </el-table>

  <el-dialog v-model="storesVisible" :title="storeGroup?.name + ' · 门店分解'" width="850px">
    <el-table :data="storeGroup?.stores || []" border stripe>
      <el-table-column prop="storeName" label="门店" min-width="130" />
      <el-table-column label="门店目标" min-width="170"><template #default="{ row }">
        <div v-for="metric in row.metrics" :key="metric.indicator_id">{{ labels[metric.metric] }} {{ metric.target }} / 已分解 {{ metric.allocated }}
          <el-button v-if="monthKey >= currentMonth && storeById(row.storeId)?.[row.source === 'company' ? 'company' : 'manager']" link type="primary" @click="editStoreTarget(metric)">调整</el-button>
          <el-button v-if="canDeleteStore(row)" link type="danger" @click="deleteTarget(row,'metric',metric.indicator_id)">删除</el-button>
        </div>
      </template></el-table-column>
      <el-table-column label="分解状态" width="110"><template #default="{ row }">{{ allocationLabels[row.allocationStatus] }}</template></el-table-column>
      <el-table-column label="操作" width="220"><template #default="{ row }">
        <el-button link type="primary" @click="openAllocation(row)">员工分解</el-button>
        <el-button link type="primary" @click="openReport(row)">业务达成</el-button>
        <el-button v-if="canDeleteStore(row)" link type="danger" @click="deleteTarget(row,'store')">删除门店分解</el-button>
      </template></el-table-column>
    </el-table>
  </el-dialog>
  <el-dialog v-model="totalVisible" title="调整总目标" width="440px">
    <el-form label-width="100px"><el-form-item v-for="metric in totalGroup?.metrics || []" :key="metric.metric" :label="labels[metric.metric]">
      <el-input-number v-model="totalTargets[metric.metric]" :min="precision(metric.metric) ? 0.01 : 1" :precision="precision(metric.metric)" />
    </el-form-item></el-form>
    <template #footer><el-button @click="totalVisible=false">取消</el-button><el-button type="primary" :loading="saving" @click="saveTotal">保存</el-button></template>
  </el-dialog>

  <el-dialog v-model="definitionsVisible" title="指标配置" width="820px">
    <el-alert title="这里定义指标和考核口径。门店和目标值在月度任务主页面下发时填写。" type="info" :closable="false" />
    <el-button type="primary" style="margin: 12px 0" @click="openDefinition()">新增指标定义</el-button>
    <el-table :data="data.definitions" stripe border>
      <el-table-column prop="name" label="指标名称" />
      <el-table-column label="来源"><template #default="{ row }">{{ sources[row.source] }}</template></el-table-column>
      <el-table-column label="范围"><template #default="{ row }">{{ row.source === 'store' ? storeById(row.store_id)?.name : distributorName(row.distributor_id) }}</template></el-table-column>
      <el-table-column label="类型"><template #default="{ row }">{{ kindLabels[row.config.kind] }}</template></el-table-column>
      <el-table-column label="状态"><template #default="{ row }">{{ row.status ? '启用' : '停用' }}</template></el-table-column>
      <el-table-column label="操作" width="130"><template #default="{ row }">
        <el-button link type="primary" @click="openDefinition(row)">{{ row.status ? '编辑' : '编辑并启用' }}</el-button>
        <el-button v-if="row.status" link type="danger" @click="disableDefinition(row)">停用</el-button>
      </template></el-table-column>
    </el-table>
  </el-dialog>

  <el-dialog v-model="definitionVisible" :title="definition.id ? '编辑指标定义' : '新增指标定义'" width="630px" append-to-body>
    <el-form label-width="100px">
      <el-form-item label="来源">
        <el-select v-model="definition.source" :disabled="!!definition.id" @change="chooseScope">
          <el-option v-if="companyScopes.length" label="公司下发" value="company" />
          <el-option v-if="managedStores.length" label="门店自建" value="store" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="definition.source === 'company' && companyScopes.length > 1" label="经销商">
        <el-select v-model="definition.distributorId" :disabled="!!definition.id">
          <el-option v-for="scope in companyScopes" :key="scope" :value="scope" :label="distributorName(scope)" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="definition.source === 'store'" label="所属门店">
        <el-select v-model="definition.storeId" :disabled="!!definition.id">
          <el-option v-for="store in managedStores" :key="store.store_id" :value="store.store_id" :label="store.name" />
        </el-select>
      </el-form-item>
      <el-form-item label="指标名称"><el-input v-model.trim="definition.name" maxlength="128" /></el-form-item>
      <el-form-item label="适用岗位">
        <el-select v-model="definition.roleCodes" multiple filterable>
          <el-option v-for="role in data.roles" :key="role.role_code" :value="role.role_code" :label="role.name" />
        </el-select>
      </el-form-item>
      <el-form-item label="指标类型"><el-select v-model="definition.kind">
        <el-option label="经营指标" value="operating" /><el-option label="管理指标" value="management" /><el-option label="销售能力指标" value="ability" />
      </el-select></el-form-item>
      <template v-if="definition.kind !== 'management'">
        <el-form-item v-if="definition.kind === 'operating'" label="商品分类">
          <span v-if="definition.allProducts">全部商品（迁移的毛利目标）</span>
          <el-cascader v-else v-model="definition.categoryIds" :options="categories" :props="categoryProps" filterable collapse-tags collapse-tags-tooltip placeholder="可多选任意层级" style="width: 100%" />
        </el-form-item>
        <el-form-item v-if="definition.kind === 'ability'" label="能力范围">
          <el-select v-model="definition.abilityType"><el-option label="超龄库存（与首页一致）" value="overdue" /><el-option label="SN特价" value="special" /><el-option label="客户来源" value="source" /></el-select>
        </el-form-item>
        <el-form-item v-if="definition.kind === 'ability' && definition.abilityType === 'source'" label="客户来源">
          <el-select v-model="definition.customerSources" multiple filterable><el-option v-for="source in data.customerSources" :key="source.source_id" :label="source.name" :value="source.name" /></el-select>
        </el-form-item>
        <el-form-item label="考核项">
          <el-select v-model="definition.metrics" multiple>
            <el-option v-for="metric in operatingMetrics" :key="metric" :value="metric" :label="labels[metric]" />
          </el-select>
        </el-form-item>
      </template>
      <template v-else>
        <el-form-item label="检查方式"><el-select v-model="definition.checkMethod">
          <el-option label="上传照片" value="photo" /><el-option label="手工填写结果" value="text" />
        </el-select></el-form-item>
        <el-form-item label="检查要求"><el-input v-model="definition.requirements" type="textarea" maxlength="1000" /></el-form-item>
      </template>
    </el-form>
    <template #footer><el-button @click="definitionVisible = false">取消</el-button><el-button type="primary" :loading="saving" @click="saveDefinition">保存定义</el-button></template>
  </el-dialog>

  <el-dialog v-model="publishVisible" title="下发指标" width="760px">
    <el-form label-width="100px">
      <el-form-item label="月份">{{ monthKey }}</el-form-item>
      <el-form-item label="选择指标">
        <el-select v-model="publication.definitionId" filterable placeholder="选择已启用的指标定义" @change="resetPublicationStores">
          <el-option v-for="item in data.definitions.filter(row => row.status)" :key="item.definition_id" :value="item.definition_id"
            :label="item.name + ' · ' + sources[item.source] + ' · ' + (item.source === 'store' ? storeById(item.store_id)?.name : distributorName(item.distributor_id))" />
        </el-select>
        <el-button link type="primary" @click="showDefinitions">维护指标定义</el-button>
      </el-form-item>
      <el-form-item v-if="selectedDefinition" label="下发门店">
        <el-select v-model="publication.storeIds" multiple filterable @change="syncTargets">
          <el-option v-for="id in selectedDefinition.publishStoreIds" :key="id" :value="id" :label="storeById(id)?.name" />
        </el-select>
      </el-form-item>
      <template v-if="selectedDefinition">
        <el-form-item v-for="metric in selectedDefinition.config.metrics" :key="metric" :label="'总目标·' + labels[metric]">
          <el-input-number v-model="publication.companyTargets[metric]" :disabled="!!existingPlan" :min="precision(metric) ? 0.01 : 1" :precision="precision(metric)" />
        </el-form-item>
      </template>
      <el-form-item v-if="publication.storeTargets.length" label="门店目标">
        <el-button v-if="publication.storeTargets.length > 1" link type="primary" @click="copyTargets">将首行目标应用到全部门店</el-button>
        <el-table :data="publication.storeTargets" border size="small">
          <el-table-column label="门店" min-width="120"><template #default="{ row }">{{ storeById(row.storeId)?.name }}</template></el-table-column>
          <el-table-column v-for="metric in selectedDefinition.config.metrics" :key="metric" :label="labels[metric]" min-width="125">
            <template #default="{ row }"><el-input-number v-model="row[metric]" :controls="false" :precision="precision(metric)"
              :min="precision(metric) ? 0.01 : 1" placeholder="留空不考核" style="width: 100%" /></template>
          </el-table-column>
        </el-table>
      </el-form-item>
    </el-form>
    <template #footer><el-button @click="publishVisible = false">取消</el-button><el-button type="primary" :loading="saving" @click="publish">发布</el-button></template>
  </el-dialog>

  <el-dialog v-model="allocationVisible" :title="allocationGroup ? allocationGroup.name + ' · ' + allocationGroup.storeName : '人员分解'" width="670px">
    <el-select v-model="metricId" @change="readAssignments">
      <el-option v-for="metric in allocationGroup?.metrics || []" :key="metric.indicator_id" :value="metric.indicator_id" :label="labels[metric.metric]" />
    </el-select>
    <el-alert v-if="currentMetric" :title="'门店目标 ' + currentMetric.target + '，已保存分解 ' + currentMetric.allocated" type="info" :closable="false" style="margin-top: 12px" />
    <el-table :data="allocationRows" empty-text="尚未分解到个人" style="margin: 12px 0">
      <el-table-column label="人员"><template #default="{ row }">
        <el-select v-if="canAllocate" v-model="row.staffId" filterable>
          <el-option v-for="person in eligible" :key="person.staff_id" :value="String(person.staff_id)" :label="person.name" />
        </el-select>
        <span v-else>{{ staffName(row.staffId) }}</span>
      </template></el-table-column>
      <el-table-column label="个人目标"><template #default="{ row }">
        <el-input-number v-if="canAllocate" v-model="row.target" :min="precision(currentMetric?.metric) ? 0.01 : 1" :precision="precision(currentMetric?.metric)" />
        <span v-else>{{ row.target }}</span>
      </template></el-table-column>
      <el-table-column v-if="canAllocate" width="75"><template #default="{ $index }">
        <el-button link type="danger" @click="allocationRows.splice($index, 1)">移除</el-button>
      </template></el-table-column>
    </el-table>
    <el-button v-if="canAllocate" plain @click="allocationRows.push({ staffId: '', target: 1 })">添加人员</el-button>
    <template #footer>
      <el-button v-if="canStopMetric" type="danger" plain :disabled="saving" @click="stopMetric">停用当前考核项</el-button>
      <el-button @click="allocationVisible = false">关闭</el-button>
      <el-button v-if="canAllocate" type="primary" :loading="saving" @click="saveAssignments">保存当前考核项</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'

const monthKey = defineModel('monthKey', { type: String })
const currentMonth = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7)
const router = useRouter()
const sources = { company: '公司下发', store: '门店自建' }
const kindLabels={operating:'经营指标',management:'管理指标',ability:'销售能力指标'}
const allocationLabels = { assigned: '已分解', partial: '部分分解', unassigned: '未分解', disabled: '已停用' }
const labels = { sales: '销售额', profit: '毛利', quantity: '数量', management: '次数' }
const operatingMetrics = ['sales', 'profit', 'quantity']
const precision = metric => ['sales', 'profit'].includes(metric) ? 2 : 0
const filters = reactive({ source: '', kind: '', storeId: '', allocationStatus: '' })
const data = ref({ stores: [], staff: [], roles: [], distributors: [], overview: [], definitions: [], assignments: [] })
const loading = ref(false), saving = ref(false)
const definitionsVisible = ref(false), definitionVisible = ref(false), publishVisible = ref(false), allocationVisible = ref(false)
const definition = ref({}), publication = ref({ definitionId: '', storeIds: [], storeTargets: [],companyTargets:{} }), categories = ref([])
const storesVisible=ref(false),storeGroup=ref(null)
const totalVisible=ref(false),totalGroup=ref(null),totalTargets=ref({})
const allocationGroup = ref(null), metricId = ref(''), allocationRows = ref([])
const categoryProps = { value: 'category_id', label: 'name', multiple: true, checkStrictly: true, emitPath: false }
const storeById = id => data.value.stores.find(store => store.store_id === id)
const distributorName = id => data.value.distributors.find(item => item.distributor_id === id)?.name || id
const staffName = id => data.value.staff.find(item => String(item.staff_id) === String(id))?.name || id
const companyScopes = computed(() => [...new Set(data.value.stores.filter(store => store.company).map(store => store.distributor_id))])
const managedStores = computed(() => data.value.stores.filter(store => store.manager))
const selectedDefinition = computed(() => data.value.definitions.find(item => item.definition_id === publication.value.definitionId))
const existingPlan=computed(()=>data.value.plans?.find(p=>p.definition_id===publication.value.definitionId&&p.status===1))
const currentMetric = computed(() => allocationGroup.value?.metrics.find(metric => metric.indicator_id === metricId.value))
const canAllocate = computed(() => currentMetric.value?.status && storeById(allocationGroup.value.storeId)?.manager && monthKey.value >= currentMonth)
const canStopMetric = computed(() => {
  const metric = currentMetric.value
  return metric?.status && monthKey.value >= currentMonth &&
    storeById(metric.store_id)?.[metric.source === 'company' ? 'company' : 'manager']
})
const eligible = computed(() => {
  const metric = currentMetric.value
  const store = storeById(metric?.store_id)
  if (!store || !metric) return []
  return data.value.staff.filter(person => {
    const manager = String(person.staff_id) === String(store.manager_staff_id)
    return (person.store_id === store.store_id || manager) &&
      ((metric.role_codes || [metric.role_code]).includes(person.role_code) || (metric.source === 'store' && manager))
  })
})
const errorText = error => error.response?.data?.message || error.message || '操作失败'
let request = 0
async function load() {
  const id = ++request
  loading.value = true
  try {
    const response = await api.getMonthlyIndicators({ monthKey: monthKey.value, ...filters })
    if (id !== request) return
    if (!Array.isArray(response.data?.groupedOverview)) throw new Error('请部署支持公司指标总览的后台版本')
    data.value = response.data
    if(storeGroup.value)storeGroup.value=data.value.groupedOverview.find(r=>r.id===storeGroup.value.id)||null
    if(!storeGroup.value)storesVisible.value=false
    if(allocationGroup.value){allocationGroup.value=data.value.overview.find(r=>r.id===allocationGroup.value.id)||null;if(!allocationGroup.value)allocationVisible.value=false}
  } catch (error) { if (id === request) ElMessage.error(errorText(error)) }
  finally { if (id === request) loading.value = false }
}
onMounted(load)

async function apply(action, dialog, message) {
  if (saving.value) return
  saving.value = true
  try {
    await action()
    if (dialog) dialog.value = false
    ElMessage.success(message)
    await load()
  } catch (error) { ElMessage.error(errorText(error)) }
  finally { saving.value = false }
}
function showDefinitions() { definitionsVisible.value = true }
function chooseScope() {
  definition.value.distributorId = companyScopes.value[0] || ''
  definition.value.storeId = managedStores.value[0]?.store_id || ''
}
async function openDefinition(row) {
  if (row) definition.value = { id: row.definition_id, name: row.name, source: row.source,
    storeId: row.store_id, distributorId: row.distributor_id, ...JSON.parse(JSON.stringify(row.config)) }
  else {
    definition.value = { id: '', name: '', source: companyScopes.value.length ? 'company' : 'store',
      kind: 'operating', roleCodes: [], categoryIds: [], metrics: [], abilityType:'overdue',customerSources:[],checkMethod: 'photo', requirements: '' }
    chooseScope()
  }
  definitionVisible.value = true
  if (!categories.value.length) {
    try { categories.value = (await api.getCategoryTree()).data || [] }
    catch (error) { ElMessage.error(errorText(error)) }
  }
}
function saveDefinition() {
  const form = definition.value
  const payload = { ...form, distributorId: form.source === 'store' ? storeById(form.storeId)?.distributor_id : form.distributorId }
  return apply(() => form.id ? api.updateMonthlyIndicatorDefinition(form.id, payload) : api.createMonthlyIndicatorDefinition(payload),
    definitionVisible, '指标定义已保存')
}
async function disableDefinition(row) {
  try { await ElMessageBox.confirm('停用后不可继续下发，已下发记录保留。', '停用指标定义') } catch { return }
  await apply(() => api.updateMonthlyIndicatorDefinition(row.definition_id, { disable: true }), null, '指标定义已停用')
}
function openPublish() {
  publication.value = { definitionId: '', storeIds: [], storeTargets: [],companyTargets:{} }
  publishVisible.value = true
}
function resetPublicationStores() {
  publication.value.storeIds = []
  publication.value.storeTargets = []
  publication.value.companyTargets={...(existingPlan.value?.company_targets||{})}
}
function syncTargets(ids) {
  const previous = new Map(publication.value.storeTargets.map(row => [row.storeId, row]))
  publication.value.storeTargets = ids.map(storeId => previous.get(storeId) || { storeId })
}
function copyTargets() {
  const [first, ...remaining] = publication.value.storeTargets
  for (const row of remaining) for (const metric of selectedDefinition.value.config.metrics) row[metric] = first[metric]
}
function publish() {
  const { definitionId, storeTargets,companyTargets } = publication.value
  if (!definitionId) return ElMessage.warning('请选择指标定义')
  if (!storeTargets.length) return ElMessage.warning('请选择下发门店')
  return apply(() => api.createMonthlyIndicator({ definitionId, storeTargets, companyTargets,monthKey: monthKey.value }), publishVisible, '指标已下发')
}
function openStores(row){storeGroup.value=row;storesVisible.value=true}
function editTotal(row){totalGroup.value=row;totalTargets.value=Object.fromEntries(row.metrics.map(m=>[m.metric,m.target]));totalVisible.value=true}
function saveTotal(){return apply(()=>api.updateMonthlyIndicator(totalGroup.value.anchorId,{companyTargets:totalTargets.value}),totalVisible,'总目标已更新')}
async function editStoreTarget(metric){
 let value;try{value=(await ElMessageBox.prompt('填写'+labels[metric.metric]+'目标','调整门店目标',{inputValue:String(metric.target)})).value}catch{return}
 return apply(()=>api.updateMonthlyIndicator(metric.indicator_id,{target:value}),null,'门店目标已更新')
}
function canDeleteStore(row){const s=storeById(row.storeId);return monthKey.value>=currentMonth&&(s?.company||s?.manager)}
async function deleteTarget(row,scope,id){
 try{await ElMessageBox.confirm(scope==='indicator'?'删除本月整个指标及门店、员工分解，保留已有证明和审批记录。':scope==='store'?'删除本门店及其员工分解，保留证明和审批记录。':'删除本门店当前考核项及其员工分解，保留证明和审批记录。','确认删除')}catch{return}
 await apply(()=>api.updateMonthlyIndicator(id||row.metrics[0].indicator_id,{deleteScope:scope}),null,'已删除')
}
function openAllocation(row) {
  allocationGroup.value = row
  metricId.value = row.metrics[0]?.indicator_id
  readAssignments()
  allocationVisible.value = true
}
function readAssignments() {
  allocationRows.value = data.value.assignments.filter(item => item.indicator_id === metricId.value)
    .map(item => ({ staffId: String(item.staff_id), target: Number(item.target) }))
}
function saveAssignments() {
  return apply(() => api.updateMonthlyIndicator(metricId.value, { assignments: allocationRows.value }), allocationVisible, '人员分解已保存')
}
async function stopMetric() {
  const id = metricId.value
  try { await ElMessageBox.confirm('停用后保留分解和提交记录。', '停用考核项') } catch { return }
  await apply(() => api.updateMonthlyIndicator(id, { disable: true }), allocationVisible, '考核项已停用')
}
function openReport(row) {
  router.push({ path: '/reports/achievement', query: { monthKey: monthKey.value, storeId: row.storeId,
    ...(row.metrics[0]?.definition_id ? { definitionId: row.metrics[0].definition_id } : { indicatorId: row.indicatorId }) } })
}
</script>

<style scoped>
.toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 14px; }
.toolbar :deep(.el-select) { width: 130px; }
.toolbar-actions { margin-left: auto; }
.muted { color: var(--el-text-color-secondary); }
</style>
