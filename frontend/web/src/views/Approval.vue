<template>
  <div class="approval-page">
    <el-card>
      <template #header>
        <div class="page-header"><span>审批管理中心</span><el-button @click="reload">刷新</el-button></div>
      </template>

      <el-tabs v-model="activeTab" class="module-tabs">
        <el-tab-pane label="待我审批" name="tasks">
          <el-table :data="tasks" stripe border v-loading="loading">
            <el-table-column label="审批主题" min-width="220"><template #default="{ row }">{{ row.Instance?.title || '-' }}</template></el-table-column>
            <el-table-column prop="node_name" label="当前节点" width="160" />
            <el-table-column label="业务类型" width="150"><template #default="{ row }">{{ businessTypeText(row.Instance?.business_type) }}</template></el-table-column>
            <el-table-column label="申请编号" width="190"><template #default="{ row }">{{ row.Instance?.instance_no || '-' }}</template></el-table-column>
            <el-table-column prop="create_time" label="提交时间" width="180" />
            <el-table-column label="操作" width="180" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="openInstance(row.instance_id)">查看</el-button>
                <el-button link type="success" @click="review(row, 'approve')">通过</el-button>
                <el-button link type="danger" @click="review(row, 'reject')">拒绝</el-button>
              </template>
            </el-table-column>
          </el-table>

          <div v-if="canReviewSales" class="sales-approval-section">
            <div class="sales-approval-header">
              <span>销售负毛利审批</span>
              <el-tag type="warning">{{ salesTasks.length }} 条</el-tag>
            </div>
            <el-table :data="salesTasks" stripe border v-loading="loading">
              <el-table-column prop="order_no" label="订单号" min-width="190" />
              <el-table-column label="所属门店" min-width="140"><template #default="{ row }">{{ row.Store?.name || '-' }}</template></el-table-column>
              <el-table-column prop="submit_user" label="申请人" width="120" />
              <el-table-column label="最终毛利" width="120">
                <template #default="{ row }"><span class="negative-profit">{{ formatProfit(row.grossProfitSnapshot?.gross_profit_amount) }}</span></template>
              </el-table-column>
              <el-table-column prop="create_time" label="申请时间" width="180" />
              <el-table-column label="审批要求" min-width="170"><template #default>归档前最终毛利为负</template></el-table-column>
              <el-table-column label="操作" width="220" fixed="right">
                <template #default="{ row }">
                  <el-button link type="primary" @click="openSales(row)">查看</el-button>
                  <el-button link type="success" @click="reviewSales(row, 'approve')">通过</el-button>
                  <el-button link type="danger" @click="reviewSales(row, 'reject')">拒绝</el-button>
                </template>
              </el-table-column>
            </el-table>
            <el-empty v-if="!loading && salesTasks.length === 0" description="暂无负毛利销售审批" :image-size="60" />
          </div>
        </el-tab-pane>

        <el-tab-pane label="我的申请" name="instances">
          <el-table :data="instances" stripe border v-loading="loading">
            <el-table-column prop="title" label="审批主题" min-width="220" />
            <el-table-column label="业务类型" width="150"><template #default="{ row }">{{ businessTypeText(row.business_type) }}</template></el-table-column>
            <el-table-column prop="instance_no" label="申请编号" width="190" />
            <el-table-column prop="status" label="状态" width="100">
              <template #default="{ row }"><el-tag :type="statusType(row.status)">{{ statusText(row.status) }}</el-tag></template>
            </el-table-column>
            <el-table-column prop="create_time" label="提交时间" width="180" />
            <el-table-column label="操作" width="150">
              <template #default="{ row }">
                <el-button link type="primary" @click="openInstance(row.instance_id)">详情</el-button>
                <el-button v-if="row.status === 'rejected'" link type="warning" @click="resubmit(row)">重新提交</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane v-if="canConfigure" label="流程配置" name="flows">
          <div class="toolbar"><el-button type="primary" @click="newFlow">新增流程</el-button></div>
          <el-table :data="flows" stripe border>
            <el-table-column prop="name" label="流程名称" min-width="180" />
            <el-table-column prop="flow_code" label="流程编码" width="180" />
            <el-table-column label="业务类型" width="160"><template #default="{ row }">{{ businessTypeText(row.business_type) }}</template></el-table-column>
            <el-table-column prop="version" label="版本" width="80" />
            <el-table-column prop="status" label="状态" width="100" />
            <el-table-column label="操作" width="240">
              <template #default="{ row }">
                <el-button link type="primary" @click="editFlow(row)">编辑</el-button>
                <el-button v-if="row.status === 'draft'" link type="success" @click="publish(row)">发布</el-button>
                <el-button v-if="row.status === 'published'" link type="danger" @click="disable(row)">停用</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <el-dialog v-model="detailVisible" title="审批详情" width="800px">
      <template v-if="currentInstance">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="主题">{{ currentInstance.title }}</el-descriptions-item>
          <el-descriptions-item label="状态">{{ statusText(currentInstance.status) }}</el-descriptions-item>
          <el-descriptions-item label="申请编号">{{ currentInstance.instance_no }}</el-descriptions-item>
          <el-descriptions-item label="业务单据">{{ currentInstance.business_type }} / {{ currentInstance.business_id }}</el-descriptions-item>
          <el-descriptions-item label="说明" :span="2">{{ currentInstance.summary || '-' }}</el-descriptions-item>
        </el-descriptions>
        <el-divider>审批任务</el-divider>
        <el-timeline>
          <el-timeline-item v-for="task in currentInstance.Tasks || []" :key="task.task_id" :timestamp="task.acted_time || task.create_time">
            {{ task.node_name }} - {{ task.Assignee?.name || task.assignee_staff_id }} - {{ taskStatusText(task.status) }}
            <span v-if="task.comment">：{{ task.comment }}</span>
          </el-timeline-item>
        </el-timeline>
      </template>
    </el-dialog>

    <el-dialog v-model="flowDialogVisible" :title="flowForm.definitionId ? '编辑流程草稿' : '新增审批流程'" width="900px">
      <el-form label-width="110px">
        <el-form-item label="流程编码"><el-input v-model="flowForm.flowCode" :disabled="!!flowForm.definitionId" placeholder="如 expense_reimburse" /></el-form-item>
        <el-form-item label="流程名称"><el-input v-model="flowForm.name" /></el-form-item>
        <el-form-item label="业务类型"><el-input v-model="flowForm.businessType" placeholder="如 expense_reimburse" /></el-form-item>
        <el-divider>审批节点</el-divider>
        <div v-for="(node, nodeIndex) in flowForm.nodes" :key="nodeIndex" class="node-card">
          <div class="node-head"><el-input v-model="node.name" placeholder="节点名称" /><el-select v-model="node.signMode" style="width:150px"><el-option label="串行签批" value="serial" /><el-option label="或签（一人通过）" value="or" /></el-select><el-button link type="danger" @click="removeNode(nodeIndex)">删除节点</el-button></div>
          <div v-for="(rule, ruleIndex) in node.approvers" :key="ruleIndex" class="rule-row">
            <el-select v-model="rule.type" style="width:170px" @change="clearRule(rule)">
              <el-option label="门店店长" value="store_manager" />
              <el-option label="直属上级" value="direct_supervisor" />
              <el-option label="指定人员" value="fixed_user" />
              <el-option label="角色+范围" value="role" />
            </el-select>
            <el-select v-if="rule.type === 'fixed_user'" v-model="rule.staffId" filterable style="width:220px" placeholder="选择人员"><el-option v-for="item in assigneeOptions.staff" :key="item.staff_id" :label="`${item.name} (${item.phone})`" :value="item.staff_id" /></el-select>
            <el-select v-if="rule.type === 'role'" v-model="rule.roleCode" style="width:180px" placeholder="选择角色"><el-option v-for="item in assigneeOptions.roles" :key="item.role_code" :label="item.name" :value="item.role_code" /></el-select>
            <el-select v-if="rule.type === 'role'" v-model="rule.scope" style="width:180px"><el-option label="主题人所在门店" value="subject_store" /><el-option label="主题人所在经销商" value="subject_distributor" /></el-select>
            <el-button link type="danger" @click="node.approvers.splice(ruleIndex, 1)">删除审批人</el-button>
          </div>
          <el-button link type="primary" @click="node.approvers.push(newRule())">添加审批人</el-button>
        </div>
        <el-button plain @click="addNode">添加审批节点</el-button>
      </el-form>
      <template #footer><el-button @click="flowDialogVisible = false">取消</el-button><el-button type="primary" @click="saveFlow">保存草稿</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'

const activeTab = ref('tasks')
const route = useRoute()
const router = useRouter()
const syncTabFromRoute = () => {
  activeTab.value = String(route.meta.tab || 'tasks')
}
const loading = ref(false)
const tasks = ref([])
const salesTasks = ref([])
const instances = ref([])
const flows = ref([])
const detailVisible = ref(false)
const currentInstance = ref(null)
const flowDialogVisible = ref(false)
const assigneeOptions = reactive({ staff: [], roles: [], stores: [] })
const userInfo = JSON.parse(localStorage.getItem('userInfo') || '{}')
const roleCodes = computed(() => Array.isArray(userInfo.roles) && userInfo.roles.length
  ? userInfo.roles
  : String(userInfo.roleCode || '').split(',').map(role => role.trim()).filter(Boolean))
const canReviewSales = computed(() => roleCodes.value.some(role => ['boss', 'admin', 'manager'].includes(role)))
const canConfigure = computed(() => (userInfo.roles || []).some(role => ['admin', 'boss'].includes(role)))
const flowForm = reactive({ definitionId: '', flowCode: '', name: '', businessType: '', nodes: [] })

const newRule = () => ({ type: 'store_manager', staffId: '', roleCode: '', scope: 'subject_store' })
const newNode = () => ({ name: '', signMode: 'serial', approvers: [newRule()] })

async function loadTasks() { tasks.value = (await api.getApprovalTasks({ status: 'pending' })).data || [] }
async function loadSalesTasks() {
  if (!canReviewSales.value) {
    salesTasks.value = []
    return
  }
  const response = await api.getSalesApprovalList({ page: 1, pageSize: 100 })
  salesTasks.value = response.data?.list || []
}
async function loadInstances() { instances.value = (await api.getApprovalInstances({ scope: 'mine' })).data || [] }
async function loadFlows() { if (canConfigure.value) flows.value = (await api.getApprovalFlows()).data || [] }
async function loadOptions() { if (canConfigure.value) Object.assign(assigneeOptions, (await api.getApprovalAssigneeOptions()).data || {}) }
async function reload() { loading.value = true; try { await Promise.all([loadTasks(), loadSalesTasks(), loadInstances(), loadFlows(), loadOptions()]) } finally { loading.value = false } }

function statusText(value) { return ({ pending: '审批中', approved: '已通过', rejected: '已拒绝' }[value] || value || '-') }
function businessTypeText(value) { return ({ sn_change: 'SN修改申请' }[value] || value || '-') }
function statusType(value) { return ({ pending: 'warning', approved: 'success', rejected: 'danger' }[value] || 'info') }
function taskStatusText(value) { return ({ pending: '待审批', waiting: '等待中', approved: '已通过', rejected: '已拒绝', cancelled: '已取消' }[value] || value) }
function formatMoney(value) { return Number(value || 0).toFixed(2) }
function formatProfit(value) { return value === undefined || value === null ? '-' : `¥${formatMoney(value)}` }
async function openInstance(id) { currentInstance.value = (await api.getApprovalInstance(id)).data; detailVisible.value = true }
function openSales(row) { router.push({ name: 'Sales', query: { orderId: row.order_id } }) }
async function reviewSales(row, action) {
  let comment = ''
  if (action === 'reject') {
    const result = await ElMessageBox.prompt('请输入拒绝原因', '拒绝负毛利审批', { inputType: 'textarea' }).catch(() => null)
    if (!result) return
    comment = result.value
  } else if (!(await ElMessageBox.confirm('确认通过该负毛利销售审批？通过后订单将自动归档。', '审批确认', { type: 'warning' }).catch(() => false))) return
  try {
    if (action === 'approve') await api.approveOrder(row.order_id)
    else await api.rejectOrder(row.order_id, { reason: comment })
    ElMessage.success(action === 'approve' ? '审批通过，订单已自动归档' : '审批已拒绝，订单已退回未归档')
    await reload()
  } catch (error) {
    ElMessage.error(error.response?.data?.message || error.message || '销售审批处理失败')
  }
}
async function review(row, action) {
  let comment = ''
  if (action === 'reject') { const result = await ElMessageBox.prompt('请输入拒绝原因', '拒绝审批', { inputType: 'textarea' }).catch(() => null); if (!result) return; comment = result.value }
  else if (!(await ElMessageBox.confirm('确认通过该审批？', '审批确认', { type: 'warning' }).catch(() => false))) return
  await api.actionApproval(row.instance_id, { action, comment }); ElMessage.success('审批处理完成'); await reload()
}
async function resubmit(row) { const result = await ElMessageBox.prompt('可填写重新提交说明', '重新提交', { inputType: 'textarea' }).catch(() => null); if (result === null) return; await api.resubmitApproval(row.instance_id, { comment: result.value }); ElMessage.success('已重新提交'); await reload() }
function newFlow() { Object.assign(flowForm, { definitionId: '', flowCode: '', name: '', businessType: '', nodes: [newNode()] }); flowDialogVisible.value = true }
function editFlow(row) { Object.assign(flowForm, { definitionId: row.definition_id, flowCode: row.flow_code, name: row.name, businessType: row.business_type, nodes: JSON.parse(JSON.stringify(row.config.nodes || [])) }); flowDialogVisible.value = true }
function addNode() { flowForm.nodes.push(newNode()) }
function removeNode(index) { flowForm.nodes.splice(index, 1) }
function clearRule(rule) { rule.staffId = ''; rule.roleCode = '' }
async function saveFlow() { const data = { flowCode: flowForm.flowCode, name: flowForm.name, businessType: flowForm.businessType, config: { nodes: flowForm.nodes } }; if (flowForm.definitionId) await api.updateApprovalFlow(flowForm.definitionId, data); else await api.createApprovalFlow(data); ElMessage.success('流程草稿已保存'); flowDialogVisible.value = false; await loadFlows() }
async function publish(row) { const confirmed = await ElMessageBox.confirm('发布后将作为新申请的审批规则，是否继续？', '发布流程').then(() => true).catch(() => false); if (!confirmed) return; await api.publishApprovalFlow(row.definition_id); ElMessage.success('流程已发布'); await loadFlows() }
async function disable(row) { await api.disableApprovalFlow(row.definition_id); ElMessage.success('流程已停用'); await loadFlows() }
watch(activeTab, value => { if (value === 'flows') loadFlows() })
watch(() => route.path, syncTabFromRoute)
onMounted(() => { syncTabFromRoute(); reload() })
</script>

<style scoped>
.module-tabs :deep(.el-tabs__header) { display: none; }
.sales-approval-section { margin-top: 24px; }
.sales-approval-header { display: flex; align-items: center; gap: 10px; margin: 12px 0; font-weight: 600; }
.negative-profit { color: var(--el-color-danger); font-weight: 600; }
.page-header,.toolbar,.node-head,.rule-row{display:flex;align-items:center;gap:10px}.page-header{justify-content:space-between}.toolbar{margin-bottom:12px}.node-card{border:1px solid var(--el-border-color);padding:12px;margin-bottom:12px;border-radius:4px}.node-head{margin-bottom:10px}.node-head .el-input{max-width:360px}.rule-row{margin:8px 0;flex-wrap:wrap}
</style>
