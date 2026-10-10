<template>
  <div class="care-credit-report">
    <div class="section-heading">
      <div>
        <h3>CARE卡可用金余额</h3>
        <p>账户余额为累计金额，不受其他报表日期筛选影响。</p>
      </div>
      <el-button :loading="loading" @click="loadOverview">刷新余额</el-button>
    </div>

    <el-alert v-if="errorMessage" :title="errorMessage" type="error" show-icon :closable="false" />
    <div class="balance-grid" v-loading="loading">
      <div class="balance-card primary" role="button" tabindex="0" @click="openDetail()" @keydown.enter="openDetail()">
        <span>我的可用余额</span><strong>¥{{ money(myWallet.available) }}</strong><small>点击查看流水 ›</small>
      </div>
      <div class="balance-card"><span>已锁定</span><strong>¥{{ money(myWallet.reserved) }}</strong></div>
      <div class="balance-card"><span>待追回</span><strong>¥{{ money(myWallet.recoveryDue) }}</strong></div>
    </div>

    <section v-if="canManage" class="staff-section">
      <div class="section-heading"><h3>员工可用金余额</h3><span>仅显示有权访问的经销商员工</span></div>
      <el-table :data="staffRows" stripe border v-loading="loading" empty-text="暂无员工账户">
        <el-table-column prop="name" label="员工" min-width="130" />
        <el-table-column label="可用余额" min-width="130" align="right">
          <template #default="{ row }">¥{{ money(row.available) }}</template>
        </el-table-column>
        <el-table-column label="已锁定" min-width="120" align="right">
          <template #default="{ row }">¥{{ money(row.reserved) }}</template>
        </el-table-column>
        <el-table-column label="待追回" min-width="120" align="right">
          <template #default="{ row }">¥{{ money(row.recoveryDue) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="150">
          <template #default="{ row }"><el-button link type="primary" @click="openDetail(row)">查看明细</el-button></template>
        </el-table-column>
      </el-table>
    </section>

    <el-dialog v-model="detailVisible" :title="`${detailStaff.name}的 CARE 可用金`" width="900px">
      <div class="detail-summary">
        <span>可用 ¥{{ money(detail.available) }}</span>
        <span>已锁定 ¥{{ money(detail.reserved) }}</span>
        <span>待追回 ¥{{ money(detail.recoveryDue) }}</span>
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
.detail-pagination { display: flex; justify-content: center; margin-top: 15px; }.increase { color: #179060; }.decrease { color: #d65353; }
@media (max-width: 700px) { .balance-grid { grid-template-columns: 1fr; } }
</style>
