<template>
  <div v-loading="loading">
    <el-select v-model="resourceType" :disabled="loading || saving" @change="load" style="margin-bottom:16px"><el-option label="销量报号 → CARE可用金" value="SALES_REPORT" /><el-option label="教育补贴 → 员工80% / 产品端20%" value="EDU_SUBSIDY" /></el-select>
    <el-alert :title="resourceType === 'EDU_SUBSIDY' ? '教育补贴 · 毛利确认' : '销量报号 · 销售员 Care 可用金'" type="info" :closable="false">
      SN 须具有对应资源资格。销售归档时冻结金额，完成截图经店长 → 张欢 → 邓红梅审批通过后入账。教育补贴总额按员工80%、产品端20%分配，公司只确认同一笔全额。PN规则优先，每台同类权益只匹配一条；退货按原金额冲回。
    </el-alert>
    <p>类别规则可包含下级类别；金额填 0 可排除指定 PN 或类别。删除全部规则并保存后，后续归档不再产生此奖励。规则调整不重算历史成本、毛利及已归档奖励。</p>
    <p v-if="usingDefault">当前使用默认规则：笔记本及其下级类别，每台 160 元。保存后以本页规则为准。</p>
    <div class="actions">
      <el-button v-if="canEdit" @click="add">新增规则</el-button>
      <el-button @click="load">刷新</el-button>
      <el-button v-if="canEdit" type="primary" :disabled="!ready" :loading="saving" @click="save">保存规则</el-button>
    </div>
    <el-table :data="rules" border empty-text="暂无奖励规则">
      <el-table-column label="名称" min-width="160"><template #default="{row}"><el-input v-model="row.name" :disabled="!canEdit" maxlength="100" /></template></el-table-column>
      <el-table-column label="匹配范围" width="125"><template #default="{row}">
        <el-select v-model="row.scope" :disabled="!canEdit"><el-option label="PN" value="PN" /><el-option label="商品类别" value="CATEGORY" /></el-select>
      </template></el-table-column>
      <el-table-column label="PN / 商品类别" min-width="220"><template #default="{row}">
        <el-input v-if="row.scope === 'PN'" v-model="row.pnCode" :disabled="!canEdit" placeholder="填写完整PN" maxlength="128" />
        <template v-else>
          <el-select v-model="row.categoryId" filterable :disabled="!canEdit" placeholder="选择商品类别" style="width:100%">
            <el-option v-for="category in categoryOptions" :key="category.id" :label="category.label" :value="category.id" />
          </el-select>
          <el-checkbox v-model="row.includeDescendants" :disabled="!canEdit">包含下级类别</el-checkbox>
        </template>
      </template></el-table-column>
      <el-table-column :label="resourceType === 'EDU_SUBSIDY' ? '每台补贴总额（元）' : '每台可用金（元）'" width="175"><template #default="{row}"><el-input-number v-model="row.amount" :min="0" :max="1000000" :precision="2" :disabled="!canEdit" style="width:150px" /></template></el-table-column>
      <el-table-column label="有效日期（含当天）" min-width="185"><template #default="{row}">
        <el-date-picker v-model="row.start" type="date" value-format="YYYY-MM-DD" placeholder="开始，不限可留空" :disabled="!canEdit" style="width:170px" />
        <el-date-picker v-model="row.end" type="date" value-format="YYYY-MM-DD" placeholder="结束，不限可留空" :disabled="!canEdit" style="width:170px;margin-top:4px" />
      </template></el-table-column>
      <el-table-column label="启用" width="75"><template #default="{row}"><el-switch v-model="row.enabled" :disabled="!canEdit" /></template></el-table-column>
      <el-table-column v-if="canEdit" label="操作" width="75"><template #default="{row}"><el-button link type="danger" @click="rules = rules.filter(item => item.id !== row.id)">删除</el-button></template></el-table-column>
    </el-table>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
import { hasRole } from '../utils/user'
const canEdit = hasRole(['boss', 'admin'])
const resourceType = ref('SALES_REPORT')
const rules = ref([]), categories = ref([]), revision = ref(0), usingDefault = ref(false)
const loading = ref(false), saving = ref(false), ready = ref(false)
const categoryOptions = computed(() => {
  const map = new Map(categories.value.map(row => [String(row.category_id), row]))
  return categories.value.map(row => {
    const parts = [], seen = new Set()
    let current = row
    while (current && !seen.has(current.category_id)) { seen.add(current.category_id); parts.unshift(current.name); current = map.get(String(current.parent_id)) }
    return { id: String(row.category_id), label: parts.join(' / ') }
  }).sort((a,b) => a.label.localeCompare(b.label, 'zh-CN'))
})
async function load() {
  loading.value = true
  try {
    const { data } = await api.getResourceRewardRules({ resourceType: resourceType.value })
    rules.value = data.rules; categories.value = data.categories; revision.value = data.revision; usingDefault.value = data.usingDefault; ready.value = true
  } catch (error) { ready.value = false; ElMessage.error(error.response?.data?.message || '加载奖励规则失败') }
  finally { loading.value = false }
}
function add() {
  rules.value.push({ id: `rule-${Date.now()}-${Math.random().toString(36).slice(2)}`, name: '', scope: 'CATEGORY', categoryId: '', pnCode: '', includeDescendants: true, amount: resourceType.value === 'SALES_REPORT' ? 160 : 0, start: '', end: '', enabled: true })
}
async function save() {
  saving.value = true
  try {
    const { data } = await api.saveResourceRewardRules({ resourceType: resourceType.value, rules: rules.value, revision: revision.value })
    revision.value = data.revision; usingDefault.value = false; ElMessage.success(data.message)
  } catch (error) { ElMessage.error(error.response?.data?.message || '保存失败，请检查规则后重试') }
  finally { saving.value = false }
}
onMounted(load)
</script>

<style scoped>
.actions { display:flex; gap:8px; margin:16px 0; }
p { color:#606266; line-height:1.6; }
</style>
