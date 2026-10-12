<template>
  <div class="care-credit-report">
    <div class="section-heading">
      <div>
        <h3>CARE卡可用金统计</h3>
        <p>金额为账户累计值，不受其他报表日期筛选影响。</p>
      </div>
      <el-button :loading="loading" @click="loadOverview">刷新余额</el-button>
    </div>

    <el-alert v-if="errorMessage" :title="errorMessage" type="error" show-icon :closable="false" />
    <div class="balance-grid" v-loading="loading">
      <div class="balance-card" role="button" tabindex="0" @click="openDetail()" @keydown.enter="openDetail()">
        <span>获取可用金总额</span><strong>¥{{ money(myWallet.earned) }}</strong><small>点击查看流水 ›</small>
      </div>
      <div class="balance-card"><span>已使用金额</span><strong>¥{{ money(myWallet.spent) }}</strong></div>
      <div class="balance-card primary"><span>现有余额</span><strong>¥{{ money(myWallet.available) }}</strong><small v-if="Number(myWallet.reserved || 0) > 0">另有已锁定 ¥{{ money(myWallet.reserved) }}</small></div>
    </div>

    <section v-if="canManage" class="staff-section">
      <div class="section-heading"><h3>员工可用金统计</h3><span>仅显示有权访问的经销商员工</span></div>
      <el-table :data="staffRows" stripe border v-loading="loading" empty-text="暂无员工账户">
        <el-table-column prop="name" label="员工" min-width="130" />
        <el-table-column label="获取可用金总额" min-width="150" align="right">
          <template #default="{ row }">¥{{ money(row.earned) }}</template>
        </el-table-column>
        <el-table-column label="已使用金额" min-width="130" align="right">
          <template #default="{ row }">¥{{ money(row.spent) }}</template>
        </el-table-column>
        <el-table-column label="现有余额" min-width="130" align="right">
          <template #default="{ row }">¥{{ money(row.available) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="150">
          <template #default="{ row }"><el-button link type="primary" @click="openDetail(row)">查看明细</el-button></template>
        </el-table-column>
      </el-table>
      <div class="batch-adjust-actions">
        <span>可粘贴姓名和目标余额，预览当前余额及差额后批量调整。</span>
        <el-button type="warning" @click="openBatchAdjust">批量调整余额</el-button>
      </div>
    </section>

    <el-dialog v-model="batchAdjustVisible" title="批量调整 CARE 可用金" width="980px" top="5vh" :close-on-click-modal="!batchSubmitting">
      <div class="batch-input-grid">
        <el-form label-position="top">
          <el-form-item label="销售人和目标余额">
            <el-input v-model="batchInput" type="textarea" :rows="9" :disabled="batchSubmitting" placeholder="每行一人，支持：姓名 金额；也支持粘贴两列或 Markdown 表格" />
          </el-form-item>
          <el-form-item label="调整原因">
            <el-input v-model="batchReason" maxlength="200" show-word-limit :disabled="batchSubmitting" placeholder="填写本次批量调整原因" />
          </el-form-item>
        </el-form>
      </div>
      <div class="batch-preview-toolbar">
        <span>目标余额不能小于 0；调整会保留原流水记录。</span>
        <el-button :disabled="batchSubmitting" @click="previewBatchAdjust">预览差额</el-button>
      </div>
      <el-table v-if="batchRows.length" :data="batchRows" stripe border max-height="360">
        <el-table-column prop="name" label="销售人" min-width="120" />
        <el-table-column label="当前账面净余额" width="150" align="right"><template #default="{ row }">¥{{ money(row.currentBalance) }}</template></el-table-column>
        <el-table-column label="目标余额" width="130" align="right"><template #default="{ row }">¥{{ money(row.targetBalance) }}</template></el-table-column>
        <el-table-column label="调整差额" width="130" align="right">
          <template #default="{ row }"><span :class="row.delta >= 0 ? 'increase' : 'decrease'">{{ row.delta > 0 ? '+' : '' }}¥{{ money(row.delta) }}</span></template>
        </el-table-column>
        <el-table-column label="状态" width="130">
          <template #default="{ row }"><el-tag :type="row.statusType" size="small">{{ row.status }}</el-tag></template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button :disabled="batchSubmitting" @click="batchAdjustVisible = false">关闭</el-button>
        <el-button type="primary" :loading="batchSubmitting" :disabled="!batchRows.length" @click="submitBatchAdjust">确认并执行调整</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="detailVisible" :title="`${detailStaff.name}的 CARE 可用金`" width="900px">
      <div class="detail-summary">
        <span>获取可用金总额 ¥{{ money(detail.earned) }}</span>
        <span>已使用金额 ¥{{ money(detail.spent) }}</span>
        <span>现有余额 ¥{{ money(detail.available) }}</span>
        <span v-if="Number(detail.reserved || 0) > 0">已锁定 ¥{{ money(detail.reserved) }}</span>
        <el-button v-if="canManage && detailStaff.staffId" type="primary" @click="openAdjust">调整金额</el-button>
      </div>
      <el-table :data="detail.transactions || []" stripe border v-loading="detailLoading" max-height="480" empty-text="暂无流水">
        <el-table-column label="时间" width="170"><template #default="{ row }">{{ dateTime(row.create_time) }}</template></el-table-column>
        <el-table-column label="金额" width="115" align="right">
          <template #default="{ row }"><span :class="row.type === 'income' ? 'increase' : 'decrease'">{{ row.type === 'income' ? '+' : '-' }}¥{{ money(row.amount) }}</span></template>
        </el-table-column>
        <el-table-column label="状态" width="100"><template #default="{ row }">{{ statusText(row.status) }}</template></el-table-column>
        <el-table-column prop="order_no" label="订单号" min-width="150" />
        <el-table-column prop="remark" label="说明" min-width="250" show-overflow-tooltip />
      </el-table>
      <div class="detail-pagination">
        <el-button v-if="detail.hasMore" :loading="detailLoading" @click="loadMore">加载更多流水</el-button>
      </div>
    </el-dialog>

    <el-dialog v-model="adjustVisible" :title="`调整 ${detailStaff.name} 的 CARE 可用金`" width="480px">
      <el-form label-width="90px">
        <el-form-item label="调整方向" required>
          <el-radio-group v-model="adjustForm.type"><el-radio label="income">增加</el-radio><el-radio label="expense">减少</el-radio></el-radio-group>
        </el-form-item>
        <el-form-item label="调整金额" required>
          <el-input-number v-model="adjustForm.amount" :min="0.01" :max="1000000" :precision="2" :step="10" style="width: 220px" />
        </el-form-item>
        <el-form-item label="调整原因" required>
          <el-input v-model="adjustForm.reason" type="textarea" :rows="3" maxlength="200" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="adjustVisible = false">取消</el-button>
        <el-button type="primary" :loading="adjustSubmitting" @click="submitAdjustment">确认调整</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'
import { getRoleCodes, getUserInfo } from '../utils/user'

const canManage = computed(() => getRoleCodes().some(role => ['admin', 'boss'].includes(role)))
const loading = ref(false)
const errorMessage = ref('')
const myWallet = ref({})
const staffRows = ref([])
const detailVisible = ref(false)
const detailLoading = ref(false)
const detailStaff = reactive({ staffId: '', name: '我' })
const detail = ref({ transactions: [], page: 1, hasMore: false })
const adjustVisible = ref(false)
const adjustSubmitting = ref(false)
const adjustForm = reactive({ type: 'income', amount: 0.01, reason: '' })
const batchAdjustVisible = ref(false)
const batchSubmitting = ref(false)
const batchInput = ref('')
const batchReason = ref('')
const batchRows = ref([])

const money = value => Number(value || 0).toFixed(2)
const dateTime = value => String(value || '').replace('T', ' ').slice(0, 19)
const statusText = status => ({ reserved: '已锁定', cancelled: '已撤销', active: '已入账' }[status] || status || '-')
const body = response => response?.data || response || {}

async function loadOverview() {
  loading.value = true
  errorMessage.value = ''
  try {
    const [mine, staff] = await Promise.all([
      api.getMyCareCredit({ page: 1 }),
      canManage.value ? api.getStaffCareCredits() : Promise.resolve([])
    ])
    myWallet.value = body(mine)
    staffRows.value = canManage.value ? body(staff) : []
  } catch (error) {
    errorMessage.value = error.message || 'CARE 可用金加载失败'
  } finally {
    loading.value = false
  }
}

async function loadDetail(page = 1, append = false) {
  detailLoading.value = true
  try {
    const response = detailStaff.staffId && canManage.value
      ? await api.getStaffCareCredit(detailStaff.staffId, { page })
      : await api.getMyCareCredit({ page })
    const next = body(response)
    detail.value = append
      ? { ...next, transactions: [...(detail.value.transactions || []), ...(next.transactions || [])] }
      : next
  } catch (error) {
    ElMessage.error(error.message || '流水加载失败')
  } finally {
    detailLoading.value = false
  }
}

async function openDetail(staff = null) {
  detailStaff.staffId = staff?.staffId || ''
  detailStaff.name = staff?.name || getUserInfo().name || '我'
  detail.value = { transactions: [], page: 1, hasMore: false }
  detailVisible.value = true
  await loadDetail()
}

function loadMore() {
  if (detailLoading.value || !detail.value.hasMore) return
  loadDetail(Number(detail.value.page || 1) + 1, true)
}

function openAdjust() {
  adjustForm.type = 'income'
  adjustForm.amount = 0.01
  adjustForm.reason = ''
  adjustVisible.value = true
}

async function submitAdjustment() {
  if (adjustSubmitting.value || !canManage.value || !detailStaff.staffId) return
  const amount = Number(adjustForm.amount)
  const reason = String(adjustForm.reason || '').trim()
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) return ElMessage.warning('请输入有效调整金额')
  if (reason.length < 2) return ElMessage.warning('请填写至少两个字的调整原因')
  const signedAmount = adjustForm.type === 'expense' ? -amount : amount
  if (signedAmount < 0 && amount > Number(detail.value.available || 0)) {
    return ElMessage.warning('减少金额不能超过现有余额')
  }
  try {
    await ElMessageBox.confirm(`确认给 ${detailStaff.name}${signedAmount > 0 ? '增加' : '减少'} ¥${money(amount)}？\n原因：${reason}`, '确认 CARE 可用金调整', { type: 'warning' })
  } catch { return }
  const operationId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`
  adjustSubmitting.value = true
  try {
    await api.adjustStaffCareCredit(detailStaff.staffId, { amount: signedAmount, reason, operationId })
    ElMessage.success('调整已记入流水')
    adjustVisible.value = false
    await Promise.all([loadOverview(), loadDetail()])
  } catch (error) {
    ElMessage.error(error.message || '金额调整失败')
  } finally {
    adjustSubmitting.value = false
  }
}

function openBatchAdjust() {
  if (!canManage.value) return
  batchAdjustVisible.value = true
  previewBatchAdjust()
}

function previewBatchAdjust() {
  if (batchSubmitting.value) return
  const staffByName = new Map()
  for (const staff of staffRows.value) {
    const name = String(staff.name || '').trim()
    if (!staffByName.has(name)) staffByName.set(name, [])
    staffByName.get(name).push(staff)
  }
  const parsed = []
  const seenNames = new Set()
  const lines = batchInput.value.split(/\r?\n/)
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim()
    if (!line || /^\|?\s*:?-{3,}/.test(line)) continue
    const fields = (line.includes('|') ? line.split('|') : line.split(/[\t,，\s]+/))
      .map(value => value.trim()).filter(Boolean)
    if (fields.length < 2) {
      parsed.push({ name: line, targetBalance: 0, currentBalance: 0, delta: 0, invalid: true, status: `第 ${index + 1} 行格式错误`, statusType: 'danger' })
      continue
    }
    const name = fields[0].replace(/^[-*]\s*/, '').trim()
    const amountText = fields[1].replace(/[¥￥,，]/g, '')
    if (/销售人|姓名|本月结余|目标余额/.test(name) || /^(?:金额|余额)$/.test(amountText)) continue
    const targetBalance = Number(amountText)
    if (!name || !Number.isFinite(targetBalance) || targetBalance < 0 || targetBalance > 1000000
      || Math.abs(targetBalance * 100 - Math.round(targetBalance * 100)) > 0.000001) {
      parsed.push({ name: name || line, targetBalance: 0, currentBalance: 0, delta: 0, invalid: true, status: `第 ${index + 1} 行金额无效`, statusType: 'danger' })
      continue
    }
    if (seenNames.has(name)) {
      parsed.push({ name, targetBalance, currentBalance: 0, delta: 0, invalid: true, status: '姓名重复', statusType: 'danger' })
      continue
    }
    seenNames.add(name)
    const matches = staffByName.get(name) || []
    if (matches.length !== 1) {
      parsed.push({ name, targetBalance, currentBalance: 0, delta: 0,
        invalid: true, status: matches.length ? '员工姓名不唯一' : '未找到员工', statusType: 'danger' })
      continue
    }
    const staff = matches[0]
    const currentBalance = Number(staff.available || 0) - Number(staff.recoveryDue || 0)
    const delta = Math.round((targetBalance - currentBalance) * 100) / 100
    if (Math.abs(delta) > 1000000) {
      parsed.push({ staffId: staff.staffId, name, targetBalance, currentBalance, delta,
        invalid: true, status: '差额超过单笔上限 100 万', statusType: 'danger' })
      continue
    }
    parsed.push({ staffId: staff.staffId, name, targetBalance, currentBalance, delta,
      operationId: `care_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
      status: Math.abs(delta) < 0.005 ? '余额已一致' : '待调整',
      statusType: Math.abs(delta) < 0.005 ? 'info' : 'warning' })
  }
  batchRows.value = parsed
  if (!parsed.length) ElMessage.warning('请粘贴至少一条有效的姓名和目标余额')
}

async function submitBatchAdjust() {
  if (!canManage.value || batchSubmitting.value) return
  const reason = String(batchReason.value || '').trim()
  if (reason.length < 2 || reason.length > 200) return ElMessage.warning('请填写 2 到 200 个字的调整原因')
  const invalidRows = batchRows.value.filter(row => row.invalid)
  if (invalidRows.length) return ElMessage.warning('请先修正未匹配、重复或格式错误的行')
  const pending = batchRows.value.filter(row => row.staffId && Math.abs(row.delta) >= 0.005 && row.status !== '已完成')
  if (!pending.length) return ElMessage.info('没有需要调整的余额')
  const totalIncome = pending.reduce((sum, row) => sum + Math.max(0, row.delta), 0)
  const totalExpense = pending.reduce((sum, row) => sum + Math.max(0, -row.delta), 0)
  try {
    await ElMessageBox.confirm(
      `将调整 ${pending.length} 位员工。增加合计 ¥${money(totalIncome)}，减少合计 ¥${money(totalExpense)}。请核对预览中的当前余额、目标余额和差额。`,
      '确认批量调整 CARE 可用金', { type: 'warning', confirmButtonText: '确认调整', cancelButtonText: '返回核对' }
    )
  } catch { return }

  batchSubmitting.value = true
  try {
    for (const row of pending) {
      row.status = '处理中'
      row.statusType = 'warning'
      try {
        const response = await api.setStaffCareCreditBalance(row.staffId, {
          targetBalance: row.targetBalance,
          reason,
          operationId: row.operationId
        })
        const result = body(response)
        row.delta = Number(result.adjustmentAmount || 0)
        row.currentBalance = Math.round((row.targetBalance - row.delta) * 100) / 100
        row.status = '已完成'
        row.statusType = 'success'
        row.transactionId = result.transactionId
        const staff = staffRows.value.find(item => String(item.staffId) === String(row.staffId))
        if (staff) {
          staff.earned = result.earned
          staff.spent = result.spent
          staff.available = result.available
          staff.reserved = result.reserved
          staff.recoveryDue = result.recoveryDue
        }
      } catch (error) {
        row.status = `失败：${error.message || '请求失败'}`
        row.statusType = 'danger'
      }
    }
    const failed = batchRows.value.filter(row => row.statusType === 'danger').length
    if (failed) ElMessage.warning(`批量调整完成，${failed} 条失败；修正问题后可重新预览并重试。`)
    else ElMessage.success(`批量调整完成，共处理 ${pending.length} 条。`)
    await loadOverview()
  } finally {
    batchSubmitting.value = false
  }
}

onMounted(loadOverview)
</script>

<style scoped>
.care-credit-report { padding: 8px 2px 16px; }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: 0 0 18px; }
.section-heading h3 { margin: 0 0 5px; font-size: 18px; color: #243247; }
.section-heading p, .section-heading span { margin: 0; color: #7b899c; font-size: 13px; }
.balance-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-bottom: 26px; }
.balance-card { display: flex; flex-direction: column; gap: 9px; padding: 20px; border: 1px solid #e5eaf2; border-radius: 10px; background: #fafcff; }
.balance-card span { color: #65758b; font-size: 13px; }.balance-card strong { color: #213249; font-size: 25px; }.balance-card small { color: #3479d6; }
.balance-card.primary { cursor: pointer; border-color: #cce0fb; background: #f1f7ff; }.balance-card.primary strong { color: #1769c9; }
.staff-section { margin-top: 18px; }.detail-summary { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; margin-bottom: 16px; color: #44546a; }
.batch-adjust-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 14px 0 4px; color: #7b899c; font-size: 13px; }
.batch-input-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; }
.batch-preview-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 12px; color: #7b899c; font-size: 13px; }
.detail-pagination { display: flex; justify-content: center; margin-top: 15px; }.increase { color: #179060; }.decrease { color: #d65353; }
@media (max-width: 700px) { .balance-grid { grid-template-columns: 1fr; }.batch-adjust-actions, .batch-preview-toolbar { align-items: flex-start; flex-direction: column; } }
</style>
