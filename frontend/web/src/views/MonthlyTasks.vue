<template>
  <div class="monthly-task-page">
    <el-card>
      <template #header>
        <div class="page-header">
          <span>月度任务</span>
          <el-button type="primary" @click="openCreate">新增任务</el-button>
        </div>
      </template>

      <div class="filter-bar">
        <el-date-picker v-model="monthKey" type="month" value-format="YYYY-MM" placeholder="选择月份" />
        <el-select v-model="targetType" style="width: 150px">
          <el-option label="门店任务" value="store" />
          <el-option label="员工任务" value="staff" />
        </el-select>
        <el-button type="primary" :loading="loading" @click="loadTasks">查询</el-button>
      </div>

      <el-alert v-if="monthKey < currentMonthKey" title="历史月份任务只读" type="info" :closable="false" class="history-tip" />
      <el-table :data="filteredTasks" stripe border v-loading="loading">
        <el-table-column prop="targetName" label="任务对象" min-width="150" />
        <el-table-column prop="storeName" label="所属门店" min-width="130" />
        <el-table-column label="销售额目标" width="130" align="right">
          <template #default="{ row }">¥{{ money(row.salesTarget) }}</template>
        </el-table-column>
        <el-table-column label="毛利目标" width="120" align="right">
          <template #default="{ row }">¥{{ money(row.grossProfitTarget) }}</template>
        </el-table-column>
        <el-table-column label="商品批次" width="100" align="center"><template #default="{ row }">{{ row.productBatches?.length || 0 }}</template></el-table-column>
        <el-table-column label="毛利已分摊" width="120" align="right">
          <template #default="{ row }">¥{{ money(row.allocationTotal) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" :disabled="monthKey < currentMonthKey" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" :disabled="monthKey < currentMonthKey" @click="disableTask(row)">停用</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editing ? '编辑月度任务' : '新增月度任务'" width="920px">
      <el-form label-width="110px">
        <el-form-item label="月份"><el-input v-model="form.monthKey" disabled /></el-form-item>
        <el-form-item label="任务类型">
          <el-radio-group v-model="form.targetType" :disabled="editing">
            <el-radio label="store">门店</el-radio>
            <el-radio label="staff">员工</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item :label="form.targetType === 'store' ? '门店' : '员工'">
          <el-select v-model="form.targetId" filterable style="width: 320px" :disabled="editing">
            <el-option v-for="item in targetOptions" :key="item.id" :label="item.label" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-row :gutter="20">
          <el-col :span="12"><el-form-item label="销售额目标"><el-input-number v-model="form.salesTarget" :min="0" :precision="2" :step="1000" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="毛利目标"><el-input-number v-model="form.grossProfitTarget" :min="0" :precision="2" :step="100" /></el-form-item></el-col>
        </el-row>

        <el-divider content-position="left">指定商品销量批次</el-divider>
        <div v-for="(batch, batchIndex) in form.productBatches" :key="batchIndex" class="batch-box">
          <div class="batch-heading">
            <el-input v-model="batch.batchName" placeholder="批次名称，如手机/平板" style="width: 240px" />
            <el-button link type="danger" @click="removeBatch(batchIndex)">删除批次</el-button>
          </div>
          <div v-for="(item, itemIndex) in batch.products" :key="itemIndex" class="batch-product-row">
            <el-select v-model="item.productId" filterable placeholder="选择商品" style="width: 360px">
              <el-option v-for="product in options.products" :key="product.productId" :label="`${product.name}（${product.productCode}）`" :value="product.productId" />
            </el-select>
            <el-input-number v-model="item.targetQuantity" :min="1" :precision="0" controls-position="right" />
            <el-button link type="danger" @click="removeProduct(batchIndex, itemIndex)">删除</el-button>
          </div>
          <el-button link type="primary" @click="addProduct(batchIndex)">添加商品</el-button>
        </div>
        <el-button plain @click="addBatch">添加商品批次</el-button>

        <template v-if="form.targetType === 'store'">
          <el-divider content-position="left">门店毛利目标分摊到员工</el-divider>
          <div v-for="(item, index) in form.grossProfitAllocations" :key="index" class="batch-product-row">
            <el-select v-model="item.staffId" filterable placeholder="选择员工" style="width: 300px">
              <el-option v-for="staff in staffForStore" :key="staff.staffId" :label="staff.name" :value="staff.staffId" />
            </el-select>
            <el-input-number v-model="item.allocatedTarget" :min="0" :precision="2" :step="100" />
            <el-button link type="danger" @click="form.grossProfitAllocations.splice(index, 1)">删除</el-button>
          </div>
          <el-button link type="primary" @click="form.grossProfitAllocations.push({ staffId: '', allocatedTarget: 0 })">添加分摊员工</el-button>
          <div class="allocation-note">已分摊：¥{{ money(allocationTotal) }} / 毛利目标：¥{{ money(form.grossProfitTarget) }}，允许部分分摊。</div>
        </template>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'

const monthKey = ref(new Date().toISOString().slice(0, 7))
const targetType = ref('store')
const currentMonthKey = new Date().toISOString().slice(0, 7)
const loading = ref(false)
const saving = ref(false)
const tasks = ref([])
const options = reactive({ stores: [], staff: [], products: [] })
const dialogVisible = ref(false)
const editing = ref(false)
const form = reactive(emptyForm())

const filteredTasks = computed(() => tasks.value.filter(row => row.targetType === targetType.value))
const targetOptions = computed(() => form.targetType === 'store'
  ? options.stores.map(item => ({ id: item.storeId, label: item.name }))
  : options.staff.map(item => ({ id: item.staffId, label: item.name })))
const staffForStore = computed(() => form.targetType !== 'store'
  ? []
  : options.staff.filter(item => !form.targetId || item.storeId === form.targetId || (item.storeIds || []).includes(form.targetId)))
const allocationTotal = computed(() => form.grossProfitAllocations.reduce((sum, item) => sum + Number(item.allocatedTarget || 0), 0))

function emptyForm() {
  return { taskId: '', monthKey: monthKey.value, targetType: 'store', targetId: '', salesTarget: 0, grossProfitTarget: 0, productBatches: [], grossProfitAllocations: [] }
}

function money(value) { return Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }
function isMissingMonthlyTaskApi(error) {
  return Number(error?.response?.status || error?.statusCode || 0) === 404
}

function showMonthlyTaskDeploymentHint() {
  ElMessage.warning('月度任务服务尚未部署（/api/v1/sales/monthly-tasks/options），请重新部署最新 ANY-ERP 后端，并确认部署目录为 backend')
}

async function loadOptions() {
  try {
    const res = await api.getMonthlyTaskOptions()
    const data = res.data?.data || res.data || {}
    options.stores = data.stores || []
    options.staff = data.staff || []
    options.products = data.products || []
  } catch (error) {
    options.stores = []
    options.staff = []
    options.products = []
    if (isMissingMonthlyTaskApi(error)) {
      showMonthlyTaskDeploymentHint()
    } else {
      ElMessage.error(error.message || '月度任务选项加载失败')
    }
  }
}

async function loadTasks() {
  loading.value = true
  try {
    const res = await api.getMonthlyTasks({ monthKey: monthKey.value })
    tasks.value = res.data?.data?.list || res.data?.list || []
  } catch (error) {
    if (isMissingMonthlyTaskApi(error)) showMonthlyTaskDeploymentHint()
    else ElMessage.error(error.message || '月度任务加载失败')
  } finally { loading.value = false }
}

function resetForm() { Object.assign(form, emptyForm(), { monthKey: monthKey.value, targetType: targetType.value }) }
function openCreate() { editing.value = false; resetForm(); dialogVisible.value = true }
function openEdit(row) {
  editing.value = true
  Object.assign(form, JSON.parse(JSON.stringify({ ...row, taskId: row.taskId, targetType: row.targetType, targetId: row.targetId })))
  form.monthKey = monthKey.value
  dialogVisible.value = true
}
function addBatch() { form.productBatches.push({ batchName: `批次${form.productBatches.length + 1}`, products: [{ productId: '', targetQuantity: 1 }] }) }
function removeBatch(index) { form.productBatches.splice(index, 1) }
function addProduct(index) { form.productBatches[index].products.push({ productId: '', targetQuantity: 1 }) }
function removeProduct(batchIndex, itemIndex) { form.productBatches[batchIndex].products.splice(itemIndex, 1) }

async function save() {
  if (!form.targetId) return ElMessage.warning('请选择任务对象')
  if (form.grossProfitAllocations.some(item => !item.staffId)) return ElMessage.warning('请选择毛利分摊员工')
  if (allocationTotal.value > Number(form.grossProfitTarget || 0)) return ElMessage.warning('员工毛利分摊合计不能超过毛利目标')
  saving.value = true
  try {
    const payload = { monthKey: form.monthKey, targetType: form.targetType, targetId: form.targetId, salesTarget: form.salesTarget, grossProfitTarget: form.grossProfitTarget, productBatches: form.productBatches, grossProfitAllocations: form.grossProfitAllocations }
    if (editing.value) await api.updateMonthlyTask(form.taskId, payload)
    else await api.saveMonthlyTask(payload)
    ElMessage.success('保存成功')
    dialogVisible.value = false
    await loadTasks()
  } catch (error) { ElMessage.error(error.message || '保存失败') } finally { saving.value = false }
}

async function disableTask(row) {
  try {
    await ElMessageBox.confirm(`确定停用“${row.targetName}”的月度任务吗？`, '确认')
    await api.disableMonthlyTask(row.taskId)
    ElMessage.success('已停用')
    await loadTasks()
  } catch (error) { if (error !== 'cancel') ElMessage.error(error.message || '停用失败') }
}

watch(() => form.targetType, () => { if (!editing.value) { form.targetId = ''; form.grossProfitAllocations = [] } })
watch(monthKey, loadTasks)
onMounted(async () => { await loadOptions(); await loadTasks() })
</script>

<style scoped>
.page-header { display: flex; justify-content: space-between; align-items: center; }
.history-tip { margin-bottom: 14px; }
.batch-box { border: 1px solid var(--el-border-color); padding: 12px; margin-bottom: 12px; border-radius: 4px; }
.batch-heading { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.batch-product-row { display: flex; gap: 10px; align-items: center; margin: 8px 0; }
.allocation-note { color: #909399; margin-top: 10px; font-size: 13px; }
</style>
