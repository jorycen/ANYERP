<template>
  <div class="approval-page">
    <el-card>
      <template #header>
        <div class="page-header"><span>审批管理中心</span><el-button @click="reload">刷新</el-button></div>
      </template>

      <el-tabs v-model="activeTab" class="module-tabs">
        <el-tab-pane label="待我审批" name="tasks">
          <el-table :data="mergedTasks" stripe border v-loading="loading">
            <el-table-column label="审批主题" min-width="220"><template #default="{ row }">{{ taskTitle(row) }}</template></el-table-column>
            <el-table-column label="当前节点" width="160"><template #default="{ row }">{{ taskNode(row) }}</template></el-table-column>
            <el-table-column label="业务类型" width="150"><template #default="{ row }">{{ taskBusinessType(row) }}</template></el-table-column>
            <el-table-column label="申请编号" width="190"><template #default="{ row }">{{ taskNo(row) }}</template></el-table-column>
            <el-table-column label="金额/毛利" width="120"><template #default="{ row }"><span :class="{ 'negative-profit': row.isSalesApproval }">{{ taskAmount(row) }}</span></template></el-table-column>
            <el-table-column label="提交时间" width="180"><template #default="{ row }">{{ taskCreateTime(row) }}</template></el-table-column>
            <el-table-column label="操作" width="220" fixed="right">
              <template #default="{ row }">
                <template v-if="row.isSalesApproval">
                  <el-button link type="primary" @click="openSales(row.salesRow)">查看</el-button>
                  <el-button link type="success" @click="reviewSales(row.salesRow, 'approve')">通过</el-button>
                  <el-button link type="danger" @click="reviewSales(row.salesRow, 'reject')">拒绝</el-button>
                </template>
                <template v-else-if="row.isModuleApproval">
                  <el-button link type="primary" @click="openModule(row)">查看</el-button>
                  <el-button link type="success" @click="reviewModule(row, 'approve')">通过</el-button>
                  <el-button link type="danger" @click="reviewModule(row, 'reject')">拒绝</el-button>
                </template>
                <template v-else>
                  <el-button link type="primary" @click="openInstance(row.instance_id)">查看</el-button>
                  <el-button link type="success" @click="review(row, 'approve')">通过</el-button>
                  <el-button link type="danger" @click="review(row, 'reject')">拒绝</el-button>
                </template>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-if="!loading && mergedTasks.length === 0" description="暂无待审批单据" :image-size="60" />
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
const moduleTasks = ref([])
const instances = ref([])
const flows = ref([])
const detailVisible = ref(false)
const currentInstance = ref(null)
const flowDialogVisible = ref(false)
const assigneeOptions = reactive({ staff: [], roles: [], stores: [] })
const userInfo = JSON.parse(localStorage.getItem('userInfo') || '{}')
const roleCodes = computed(() => {
  const rawRoles = Array.isArray(userInfo.roles) && userInfo.roles.length
    ? userInfo.roles
    : String(userInfo.roleCode || userInfo.userRole || userInfo.role || '').split(',')
  const roleAliases = { distributor: 'admin', system_admin: 'admin', store_admin: 'manager' }
  return [...new Set(rawRoles.map(role => String(role || '').trim().toLowerCase()).filter(Boolean).map(role => roleAliases[role] || role))]
})
const canReviewSales = computed(() => roleCodes.value.some(role => ['boss', 'admin', 'manager', 'store_manager', 'store_admin'].includes(role)))
const canConfigure = computed(() => roleCodes.value.some(role => ['admin', 'boss'].includes(role)))
const flowForm = reactive({ definitionId: '', flowCode: '', name: '', businessType: '', nodes: [] })
const mergedTasks = computed(() => {
  const genericTasks = tasks.value.map(row => ({ ...row, isSalesApproval: false }))
  const salesApprovalTasks = salesTasks.value.map(row => ({
    isSalesApproval: true,
    salesRow: row,
    node_name: '负毛利归档审批',
    create_time: row.create_time,
    Instance: {
      title: `销售订单 ${row.order_no || '-'}`,
      business_type: 'sales_negative_gross_profit',
      instance_no: row.order_no,
      create_time: row.create_time,
      summary: '归档前最终毛利为负'
    }
  }))
  return genericTasks.concat(salesApprovalTasks, moduleTasks.value).sort((left, right) => (
    new Date(taskCreateTime(right)).getTime() - new Date(taskCreateTime(left)).getTime()
  ))
})

const newRule = () => ({ type: 'store_manager', staffId: '', roleCode: '', scope: 'subject_store' })
const newNode = () => ({ name: '', signMode: 'serial', approvers: [newRule()] })

async function loadTasks() { tasks.value = responseList(await api.getApprovalTasks({ status: 'pending' })) }
async function loadSalesTasks() {
  if (!canReviewSales.value) {
    salesTasks.value = []
    return
  }
  const response = await api.getSalesApprovalList({ page: 1, pageSize: 100 })
  salesTasks.value = responseList(response)
}
function responseList(response) {
  const payload = response?.data ?? response
  if (Array.isArray(payload)) return payload
  return payload?.list || payload?.rows || payload?.items || payload?.records || []
}
function canReviewRole(allowedRoles) {
  return roleCodes.value.includes('boss') || roleCodes.value.some(role => allowedRoles.includes(role))
}
function moduleTask(type, row, fields) {
  const id = fields.id
  if (!id) return null
  const no = fields.no || id
  const createTime = fields.createTime || row.create_time || row.createTime || ''
  return {
    isModuleApproval: true,
    moduleType: type,
    moduleRow: row,
    instance_id: `${type}:${id}`,
    node_name: fields.node || '待审批',
    create_time: createTime,
    amountText: fields.amountText || '-',
    Instance: {
      title: fields.title || no,
      business_type: type,
      instance_no: no,
      business_id: id,
      create_time: createTime,
      summary: fields.summary || '-'
    }
  }
}
function moneyText(value, signed = false) {
  const amount = Number(value || 0)
  if (!Number.isFinite(amount)) return '-'
  const prefix = signed && amount >= 0 ? '+' : ''
  return `${prefix}¥${amount.toFixed(2)}`
}
async function loadPurchaseApprovalRows() {
  const params = { scope: 'review', page: 1, pageSize: 100 }
  const responses = await Promise.all([
    api.getPurchaseRequestList({ ...params, status: 'pending' }).catch(() => null),
    api.getPurchaseRequestList({ ...params, status: 'pending_approval' }).catch(() => null)
  ])
  const rows = responses.flatMap(response => response ? responseList(response) : [])
  const seen = new Set()
  return rows.filter(row => {
    const key = row.request_id || row.requestId || row.request_no || row.requestNo
    if (!key || seen.has(String(key))) return false
    seen.add(String(key))
    return true
  })
}
async function loadOtherApprovalTasks() {
  const loaders = [
    {
      type: 'return',
      request: () => api.getReturnList({ status: 'pending', scope: 'review', page: 1, pageSize: 100 }),
      map: row => moduleTask('return', row, {
        id: row.return_id || row.returnId,
        no: row.return_no || row.returnNo,
        title: row.supplier_name || row.supplierName || '退库申请',
        summary: `原入库单 ${row.inbound_no || row.inboundNo || '-'}，共 ${row.total_quantity || row.totalQuantity || 0} 件`,
        amountText: moneyText(row.total_amount || row.totalAmount),
        node: '退库审批'
      })
    },
    {
      type: 'sales_return',
      request: () => api.getSalesReturnRequests({ status: 'pending', scope: 'review', page: 1, pageSize: 100 }),
      map: row => {
        const stage = row.approval_stage || row.approvalStage || 'pending_store'
        if (stage === 'pending_distributor' && !canReviewRole(['admin'])) return null
        if (stage !== 'pending_distributor' && !canReviewRole(['admin', 'manager'])) return null
        return moduleTask('sales_return', row, {
          id: row.return_id || row.returnId || row.id,
          no: row.return_no || row.returnNo,
          title: row.customer_name || row.customerName || '销售退单申请',
          summary: `原订单 ${row.order_no || row.orderNo || '-'}，退款 ${moneyText(row.refund_amount || row.refundAmount || row.total_amount || row.totalAmount)}`,
          amountText: moneyText(row.refund_amount || row.refundAmount || row.total_amount || row.totalAmount),
          node: stage === 'pending_distributor' ? '经销商审批' : '店长审批'
        })
      }
    }
  ]
  if (canReviewRole(['admin', 'purchaser'])) {
    loaders.push({
      type: 'purchase',
      request: loadPurchaseApprovalRows,
      map: row => moduleTask('purchase', row, {
        id: row.request_id || row.requestId,
        no: row.request_no || row.requestNo,
        title: row.supplier_name || row.supplierName || '采购申请',
        summary: row.items_summary || '采购商品明细',
        amountText: moneyText(row.total_amount || row.totalAmount),
        node: '采购审批'
      })
    })
  }
  if (canReviewRole(['admin'])) {
    loaders.push({
      type: 'expense',
      request: () => api.getExpenseList({ status: 'pending_approval', scope: 'review', page: 1, pageSize: 100 }),
      map: row => moduleTask('expense', row, {
        id: row.expense_id || row.expenseId,
        no: row.expense_no || row.expenseNo,
        title: `${row.expense_type || '费用'} · ${row.expense_party || '-'}`,
        summary: row.source_type === 'purchase' ? `采购个人垫付 ${row.source_no || ''}` : `${row.region_name || row.store_name || ''} 费用报销`,
        amountText: moneyText(row.amount),
        node: '报销审批'
      })
    })
  }
  if (canReviewRole(['admin', 'finance', 'purchaser'])) {
    loaders.push({
      type: 'product',
      request: () => api.getProductApplicationList({ status: 'pending', scope: 'review', page: 1, pageSize: 100 }),
      map: row => moduleTask('product', row, {
        id: row.application_id || row.applicationId,
        no: row.application_no || row.applicationNo,
        title: row.product_name || row.productName || '新建商品审批',
        summary: `${row.category_name || '未分类'} · 商品信息审批`,
        node: '商品审批'
      })
    })
  }
  if (canReviewRole(['finance'])) {
    loaders.push({
      type: 'resource',
      request: () => api.getResourceClaimList({ approvalStatus: 'pending_finance', scope: 'review', page: 1, pageSize: 100 }),
      map: row => moduleTask('resource', row, {
        id: row.change_id || row.changeId,
        no: row.change_order_no || row.changeOrderNo,
        title: `${row.resource_type || '资源'}套回`,
        summary: `SN ${row.sn_code || '-'}，套回金额 ${moneyText(row.change_amount)}`,
        amountText: moneyText(row.change_amount),
        node: '财务审批'
      })
    })
  }
  if (canReviewRole(['admin', 'finance'])) {
    loaders.push({
      type: 'profit',
      request: () => api.getProfitAdjustments({ scope: 'review', page: 1, pageSize: 100 }),
      map: row => moduleTask('profit', row, {
        id: row.adjustment_id || row.adjustmentId,
        no: row.adjustment_no || row.adjustmentNo,
        title: `${row.employee_name || '员工'}业绩毛利调整`,
        summary: `订单 ${row.order_no || '-'}，调整 ${moneyText(row.signed_amount, true)}`,
        amountText: moneyText(row.signed_amount, true),
        node: row.status === 'pending_admin' ? '管理员复审' : '财务初审'
      })
    })
  }
  const groups = await Promise.all(loaders.map(async loader => {
    try {
      return responseList(await loader.request()).map(loader.map).filter(Boolean)
    } catch (error) {
      console.warn(`加载${loader.type}审批失败:`, error)
      return []
    }
  }))
  moduleTasks.value = groups.flat()
}
async function loadInstances() { instances.value = (await api.getApprovalInstances({ scope: 'mine' })).data || [] }
async function loadFlows() { if (canConfigure.value) flows.value = (await api.getApprovalFlows()).data || [] }
async function loadOptions() { if (canConfigure.value) Object.assign(assigneeOptions, (await api.getApprovalAssigneeOptions()).data || {}) }
async function reload() { loading.value = true; try { await Promise.all([loadTasks(), loadSalesTasks(), loadOtherApprovalTasks(), loadInstances(), loadFlows(), loadOptions()]) } finally { loading.value = false } }

function statusText(value) { return ({ pending: '审批中', approved: '已通过', rejected: '已拒绝' }[value] || value || '-') }
function businessTypeText(value) {
  return ({
    sn_change: 'SN修改申请',
    sales_negative_gross_profit: '销售负毛利',
    purchase: '采购审批',
    expense: '报销审批',
    product: '商品审批',
    return: '退库审批',
    sales_return: '销售退单',
    resource: '资源套回',
    profit: '毛利调整'
  }[value] || value || '-')
}
function statusType(value) { return ({ pending: 'warning', approved: 'success', rejected: 'danger' }[value] || 'info') }
function taskStatusText(value) { return ({ pending: '待审批', waiting: '等待中', approved: '已通过', rejected: '已拒绝', cancelled: '已取消' }[value] || value) }
function formatMoney(value) { return Number(value || 0).toFixed(2) }
function formatProfit(value) { return value === undefined || value === null ? '-' : `¥${formatMoney(value)}` }
function taskTitle(row) { return row.isSalesApproval ? `销售订单 ${row.salesRow?.order_no || '-'}` : row.Instance?.title || '-' }
function salesApprovalStage(row = {}) {
  const stage = row.approval_stage || row.approvalStage
  if (stage === 'store' || stage === 'distributor') return stage
  if (['pending_store_approval', 'pending_approval'].includes(row.order_status)) return 'store'
  if (row.order_status === 'pending_distributor_approval') return 'distributor'
  return ''
}
function salesApprovalStageText(row = {}) {
  return salesApprovalStage(row) === 'distributor' ? '待经销商总权限审批' : '待店长审批'
}
function taskNode(row) { return row.isSalesApproval ? salesApprovalStageText(row.salesRow || {}) : row.node_name || '-' }
function taskBusinessType(row) { return businessTypeText(row.isSalesApproval ? 'sales_negative_gross_profit' : row.Instance?.business_type) }
function taskNo(row) { return row.isSalesApproval ? row.salesRow?.order_no || '-' : row.Instance?.instance_no || '-' }
function taskCreateTime(row) { return row.isSalesApproval ? row.salesRow?.create_time || '-' : row.create_time || row.Instance?.create_time || '-' }
function taskAmount(row) {
  if (row.isSalesApproval) return formatProfit(row.salesRow?.grossProfitSnapshot?.gross_profit_amount)
  return row.amountText || '-'
}
async function openInstance(id) { currentInstance.value = (await api.getApprovalInstance(id)).data; detailVisible.value = true }
function openSales(row) { router.push({ name: 'Sales', query: { orderId: row.order_id } }) }
function openModule(row) {
  currentInstance.value = {
    title: taskTitle(row),
    status: 'pending',
    instance_no: taskNo(row),
    business_type: taskBusinessType(row),
    business_id: row.Instance?.business_id || '-',
    summary: row.Instance?.summary || '-',
    Tasks: []
  }
  detailVisible.value = true
}
async function reviewSales(row, action) {
  const stage = salesApprovalStage(row)
  let comment = ''
  if (action === 'reject') {
    const result = await ElMessageBox.prompt('请输入拒绝原因', '拒绝负毛利审批', { inputType: 'textarea' }).catch(() => null)
    if (!result) return
    comment = result.value
  } else if (!(await ElMessageBox.confirm(
    stage === 'store' ? '确认通过店长初审？通过后将进入经销商总权限复审。' : '确认通过经销商总权限复审？通过后订单将自动归档。',
    '审批确认',
    { type: 'warning' }
  ).catch(() => false))) return
  try {
    if (action === 'approve') await api.approveOrder(row.order_id)
    else await api.rejectOrder(row.order_id, { reason: comment })
    ElMessage.success(action === 'approve'
      ? (stage === 'store' ? '店长初审通过，已进入经销商总权限复审' : '经销商总权限复审通过，订单已自动归档')
      : `${stage === 'store' ? '店长初审' : '经销商总权限复审'}已拒绝，订单已退回未归档`)
    await reload()
  } catch (error) {
    ElMessage.error(error.response?.data?.message || error.message || '销售审批处理失败')
  }
}
async function reviewModule(row, action) {
  let comment = ''
  if (action === 'reject') {
    const result = await ElMessageBox.prompt('请输入拒绝原因', '拒绝审批', { inputType: 'textarea' }).catch(() => null)
    if (!result) return
    comment = result.value
  } else if (!(await ElMessageBox.confirm('确认通过该审批？', '审批确认', { type: 'warning' }).catch(() => false))) return

  const moduleRow = row.moduleRow || {}
  const approved = action === 'approve' ? 'approved' : 'rejected'
  const id = row.Instance?.business_id
  try {
    if (row.moduleType === 'purchase') await api.approvePurchaseRequest(id, { status: approved, comment })
    else if (row.moduleType === 'expense') await api.reviewExpense(id, { action: approved, comment })
    else if (row.moduleType === 'product') await api.reviewProductApplication(id, { action: approved, comment })
    else if (row.moduleType === 'return') await api.approveReturn({ returnId: id, storeId: moduleRow.store_id || moduleRow.storeId || '', action: approved, comment })
    else if (row.moduleType === 'sales_return') await api.reviewSalesReturn(id, {
      action: approved,
      comment,
      postToDailyStatement: action === 'approve',
      post_to_daily_statement: action === 'approve',
      createNegativeDailyStatement: action === 'approve',
      create_negative_daily_statement: action === 'approve',
      reviewerRole: userInfo.roleCode || '',
      reviewerId: userInfo.staffId || userInfo.userId || ''
    })
    else if (row.moduleType === 'resource') await api.reviewResourceClaim(id, { action: action === 'approve' ? 'approve' : 'reject', comment })
    else if (row.moduleType === 'profit') {
      if (action === 'approve') await api.approveProfitAdjustment(id, { comment })
      else await api.rejectProfitAdjustment(id, { comment })
    } else throw new Error('不支持的审批类型')
    ElMessage.success(action === 'approve' ? '审批通过' : '审批已拒绝')
    await reload()
  } catch (error) {
    ElMessage.error(error.response?.data?.message || error.message || '审批处理失败')
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
.negative-profit { color: var(--el-color-danger); font-weight: 600; }
.page-header,.toolbar,.node-head,.rule-row{display:flex;align-items:center;gap:10px}.page-header{justify-content:space-between}.toolbar{margin-bottom:12px}.node-card{border:1px solid var(--el-border-color);padding:12px;margin-bottom:12px;border-radius:4px}.node-head{margin-bottom:10px}.node-head .el-input{max-width:360px}.rule-row{margin:8px 0;flex-wrap:wrap}
</style>
