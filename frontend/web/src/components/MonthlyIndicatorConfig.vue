<template>
  <el-dialog v-model="open" title="指标配置" width="1050px" @open="load">
    <el-alert v-if="monthKey < currentMonth" title="历史月份指标只读" type="info" :closable="false" />
    <el-button v-if="data.stores.length && monthKey >= currentMonth" type="primary" @click="startCreate">新增指标</el-button>
    <el-table :data="data.indicators" v-loading="loading" stripe border style="margin-top: 12px">
      <el-table-column prop="name" label="指标" min-width="160" />
      <el-table-column label="来源" width="95"><template #default="{ row }">{{ row.source === 'company' ? '公司下发' : '门店自建' }}</template></el-table-column>
      <el-table-column label="门店"><template #default="{ row }">{{ store(row.store_id)?.name }}</template></el-table-column>
      <el-table-column label="类型"><template #default="{ row }">{{ labels[row.metric] }}</template></el-table-column>
      <el-table-column prop="target" label="门店目标" />
      <el-table-column label="状态"><template #default="{ row }">{{ row.status ? '启用' : '停用' }}</template></el-table-column>
      <el-table-column label="操作" width="155">
        <template #default="{ row }">
          <el-button v-if="editable(row) && store(row.store_id)?.manager" link type="primary" @click="startAssign(row)">分解</el-button>
          <el-button v-if="editable(row) && store(row.store_id)?.[row.source === 'company' ? 'company' : 'manager']" link type="danger" @click="disable(row)">停用</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="creating" title="新增月度指标" width="760px" append-to-body>
      <el-form label-width="100px">
        <el-form-item label="来源">
          <el-select v-model="form.source" @change="form.storeIds = []; syncStores([])">
            <el-option v-if="data.stores.some(s => s.company)" label="公司下发" value="company" />
            <el-option v-if="data.stores.some(s => s.manager)" label="门店自建" value="store" />
          </el-select>
        </el-form-item>
        <el-form-item :label="form.kind === 'management' ? '管理指标名称' : '指标名称'"><el-input v-model.trim="form.name" maxlength="128" /></el-form-item>
        <el-form-item label="适用岗位"><el-select v-model="form.roleCodes" multiple filterable placeholder="选择一个或多个岗位">
          <el-option v-for="role in data.roles" :key="role.role_code" :label="role.name" :value="role.role_code" />
        </el-select></el-form-item>
        <el-form-item label="指标类型"><el-select v-model="form.kind">
          <el-option label="经营指标" value="operating" /><el-option label="管理指标" value="management" />
        </el-select></el-form-item>
        <el-form-item v-if="form.kind === 'operating'" label="商品分类">
          <el-cascader v-model="form.categoryIds" :options="categories" :props="categoryProps" filterable clearable collapse-tags collapse-tags-tooltip placeholder="可多选任意层级分类" style="width: 100%" />
        </el-form-item>
        <el-form-item label="门店"><el-select v-model="form.storeIds" multiple filterable placeholder="选择一个或多个门店" @change="syncStores">
          <el-option v-for="s in data.stores.filter(s => s[form.source === 'company' ? 'company' : 'manager'])" :key="s.store_id" :label="s.name" :value="s.store_id" />
        </el-select></el-form-item>
        <el-form-item v-if="form.storeTargets.length" label="门店目标">
          <el-button v-if="form.storeTargets.length > 1" link type="primary" @click="copyFirstTarget">将首行目标应用到全部门店</el-button>
          <el-table :data="form.storeTargets" row-key="storeId" border size="small">
            <el-table-column label="门店" min-width="130"><template #default="{ row }">{{ store(row.storeId)?.name }}</template></el-table-column>
            <template v-if="form.kind === 'operating'">
              <el-table-column v-for="metric in operatingMetrics" :key="metric" :label="labels[metric]" min-width="130">
                <template #default="{ row }">
                  <el-input-number v-model="row[metric]" :controls="false" :precision="metric === 'quantity' ? 0 : 2"
                    :min="metric === 'quantity' ? 1 : 0.01" placeholder="不考核" style="width: 100%" />
                </template>
              </el-table-column>
            </template>
            <el-table-column v-else label="目标次数" min-width="145">
              <template #default="{ row }"><el-input-number v-model="row.management" :min="1" :precision="0" /></template>
            </el-table-column>
          </el-table>
        </el-form-item>
        <template v-if="form.kind === 'management'">
          <el-form-item label="检查方式"><el-select v-model="form.checkMethod">
            <el-option label="上传照片" value="photo" /><el-option label="手工填写结果" value="text" />
          </el-select></el-form-item>
          <el-form-item label="检查要求"><el-input v-model="form.requirements" type="textarea" maxlength="1000" /></el-form-item>
        </template>
      </el-form>
      <template #footer><el-button @click="creating = false">取消</el-button><el-button type="primary" :loading="saving" @click="save">发布</el-button></template>
    </el-dialog>

    <el-dialog v-model="assigning" title="分解目标" width="640px" append-to-body>
      <el-alert :title="`门店目标 ${current?.target ?? 0}，已分解 ${allocated}`" type="info" :closable="false" />
      <el-table :data="assignments" style="margin: 12px 0">
        <el-table-column label="人员"><template #default="{ row }"><el-select v-model="row.staffId" filterable>
          <el-option v-for="person in eligible" :key="person.staff_id" :value="String(person.staff_id)" :label="person.name" />
        </el-select></template></el-table-column>
        <el-table-column label="目标"><template #default="{ row }"><el-input-number v-model="row.target" :min="1" :precision="['management', 'quantity'].includes(current?.metric) ? 0 : 2" /></template></el-table-column>
        <el-table-column width="70"><template #default="{ $index }"><el-button link type="danger" @click="assignments.splice($index, 1)">移除</el-button></template></el-table-column>
      </el-table>
      <el-button plain @click="assignments.push({ staffId: '', target: 1 })">添加人员</el-button>
      <template #footer><el-button @click="assigning = false">取消</el-button><el-button type="primary" :loading="saving" @click="saveAssignments">保存</el-button></template>
    </el-dialog>
  </el-dialog>
</template>

<script setup>
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'
const props = defineProps({ monthKey: String, currentMonth: String })
const open = defineModel({ type: Boolean })
const labels = { sales: '销售额', profit: '销售毛利', quantity: '销售数量', management: '管理任务' }
const operatingMetrics = ['sales', 'profit', 'quantity']
const categories = ref([])
const categoryProps = { value: 'category_id', label: 'name', multiple: true, checkStrictly: true, emitPath: false }
const data = ref({ stores: [], staff: [], roles: [], indicators: [], assignments: [] })
const loading = ref(false), saving = ref(false), creating = ref(false), assigning = ref(false)
const current = ref(null), assignments = ref([]), form = ref({})
const store = id => data.value.stores.find(s => s.store_id === id)
const editable = row => row.status && props.monthKey >= props.currentMonth
const eligible = computed(() => {
  const row = current.value
  if (!row) return []
  return data.value.staff.filter(person => (person.store_id === row.store_id || String(person.staff_id) === String(store(row.store_id)?.manager_staff_id))
    && ((row.role_codes || [row.role_code]).includes(person.role_code) ||
      (row.source === 'store' && String(person.staff_id) === String(store(row.store_id)?.manager_staff_id))))
})
const allocated = computed(() => assignments.value.reduce((sum, row) => sum + Number(row.target || 0), 0).toFixed(2))
const errorText = error => error.response?.data?.message || error.message || '操作失败'
async function load() {
  loading.value = true
  try {
    const [setup, tree] = await Promise.all([api.getMonthlyIndicators({ monthKey: props.monthKey }), api.getCategoryTree()])
    data.value = setup.data
    categories.value = tree.data
  }
  catch (error) { ElMessage.error(errorText(error)) }
  finally { loading.value = false }
}
function startCreate() {
  form.value = { source: data.value.stores.some(s => s.company) ? 'company' : 'store', storeIds: [], roleCodes: [],
    kind: 'operating', storeTargets: [], categoryIds: [], name: '', checkMethod: 'photo', requirements: '' }
  creating.value = true
}
async function apply(action, dialog) {
  saving.value = true
  try { await action(); if (dialog) dialog.value = false; ElMessage.success('已保存'); await load() }
  catch (error) { ElMessage.error(errorText(error)) }
  finally { saving.value = false }
}
function syncStores(ids) {
  const existing = new Map(form.value.storeTargets.map(row => [row.storeId, row]))
  form.value.storeTargets = ids.map(storeId => existing.get(storeId) || { storeId, management: 1 })
}
function copyFirstTarget() {
  const [first, ...rest] = form.value.storeTargets
  const keys = form.value.kind === 'management' ? ['management'] : operatingMetrics
  for (const row of rest) for (const metric of keys) row[metric] = first[metric]
}
function save() { return apply(() => api.createMonthlyIndicator({ ...form.value, monthKey: props.monthKey }), creating) }
function startAssign(row) {
  current.value = row
  assignments.value = data.value.assignments.filter(item => item.indicator_id === row.indicator_id)
    .map(item => ({ staffId: String(item.staff_id), target: Number(item.target) }))
  assigning.value = true
}
function saveAssignments() { return apply(() => api.updateMonthlyIndicator(current.value.indicator_id, { assignments: assignments.value }), assigning) }
async function disable(row) {
  try { await ElMessageBox.confirm('停用后保留历史达成记录，员工将无法继续提交。', '停用指标') } catch { return }
  await apply(() => api.updateMonthlyIndicator(row.indicator_id, { disable: true }))
}
</script>
