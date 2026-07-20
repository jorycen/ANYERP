<template>
  <div class="sn-trace-page">
    <div class="search-box">
      <el-input
        v-model="snCode"
        placeholder="输入SN码查询追踪记录"
        size="large"
        clearable
        style="width: 400px"
        @keyup.enter="doSearch"
      >
        <template #prepend>SN码</template>
      </el-input>
      <el-button type="primary" size="large" @click="doSearch" :loading="loading" style="margin-left: 12px;">
        <el-icon><Search /></el-icon> 查询
      </el-button>
    </div>

    <div v-if="hasResult" class="result-area">
      <el-card class="info-card" shadow="hover">
        <el-descriptions title="SN信息" :column="4" border>
          <el-descriptions-item label="SN码">
            <el-tag>{{ traceData.snCode }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="当前状态">
            <el-tag :type="statusType">{{ statusText }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="商品">{{ traceData.productName || '-' }}</el-descriptions-item>
          <el-descriptions-item label="门店">{{ traceData.storeName || '-' }}</el-descriptions-item>
        </el-descriptions>
      </el-card>

      <el-card class="timeline-card" shadow="hover" style="margin-top: 20px;">
        <template #header>
          <span>全流程跟踪</span>
          <el-tag size="small" type="info" style="margin-left: 8px;">共 {{ traceData.timeline.length }} 条记录</el-tag>
        </template>

        <el-timeline v-if="traceData.timeline.length > 0">
          <el-timeline-item
            v-for="(event, idx) in traceData.timeline"
            :key="idx"
            :timestamp="formatDateTime(event.time)"
            :color="eventColor(event.type)"
            :type="timelineType(event.type)"
            placement="top"
          >
            <el-card shadow="hover" class="event-card">
              <div class="event-header">
                <el-tag :type="tagType(event.type)" size="small">{{ event.label }}</el-tag>
                <span class="event-desc">{{ event.description }}</span>
              </div>
              <div v-if="event.oldSnCode" class="event-extra">
                <span style="color: #e6a23c;">原SN: {{ event.oldSnCode }}</span>
              </div>
              <div class="event-footer">
                <span class="event-user">{{ event.user || '-' }}</span>
                <span class="event-time">{{ formatDateTime(event.time) }}</span>
                <el-button
                  v-if="event.can_view_order && event.ref_id && canOpenReference(event)"
                  size="small"
                  :type="referenceButtonType(event)"
                  @click="goToReference(event)"
                  style="margin-left: 12px;"
                >{{ referenceButtonLabel(event) }}</el-button>
              </div>
            </el-card>
          </el-timeline-item>
        </el-timeline>

        <el-empty v-else description="暂无追踪记录" />
      </el-card>
    </div>

    <div v-else-if="searched" class="empty-state">
      <el-empty description="未找到该SN码的追踪记录" />
    </div>

    <div v-else class="hint-state">
      <el-empty description="请输入SN码进行查询" :image-size="120">
        <template #image>
          <el-icon :size="80" color="#c0c4cc"><Search /></el-icon>
        </template>
      </el-empty>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { Search } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import api from '../api'

const router = useRouter()

const snCode = ref('')
const loading = ref(false)
const searched = ref(false)
const traceData = ref({
  snCode: '',
  currentStatus: '',
  productName: '',
  storeId: '',
  storeName: '',
  timeline: []
})

const hasResult = computed(() => searched.value && traceData.value.snCode)

const statusType = computed(() => {
  const s = traceData.value.currentStatus
  if (s === 'in_stock') return 'success'
  if (s === 'sold') return 'danger'
  if (s === 'returned') return 'warning'
  if (s === 'return_pending') return 'warning'
  if (s === 'transferring') return 'info'
  return 'info'
})

const statusText = computed(() => {
  const s = traceData.value.currentStatus
  if (s === 'in_stock') return '在库'
  if (s === 'sold') return '已售'
  if (s === 'returned') return '已退库'
  if (s === 'return_pending') return '退库待入库'
  if (s === 'transferring') return '调拨中'
  return s || '-'
})

const doSearch = async () => {
  const code = snCode.value.trim()
  if (!code) {
    ElMessage.warning('请输入SN码')
    return
  }

  loading.value = true
  searched.value = true
  try {
    const res = await api.snTrace(code)
    if (res.code === 0) {
      traceData.value = res.data || { snCode: code, currentStatus: '', productName: '', storeId: '', storeName: '', timeline: [] }
    } else {
      traceData.value = { snCode: code, currentStatus: '', productName: '', storeId: '', storeName: '', timeline: [] }
      ElMessage.info(res.message || '未找到记录')
    }
  } catch (err) {
    traceData.value = { snCode: code, currentStatus: '', productName: '', storeId: '', storeName: '', timeline: [] }
    ElMessage.error('查询失败')
  } finally {
    loading.value = false
  }
}

const eventColor = (type) => {
  const map = { inbound: '#67C23A', sale: '#F56C6C', return: '#E6A23C', modify_sn: '#409EFF', transfer: '#9B59B6', transfer_out: '#9B59B6', transfer_out_confirm: '#8E44AD', transfer_in_confirm: '#3498DB' }
  return map[type] || '#909399'
}

const timelineType = (type) => {
  const map = { inbound: 'success', sale: 'danger', return: 'warning', modify_sn: 'primary', transfer: '', transfer_out: '', transfer_out_confirm: '', transfer_in_confirm: '' }
  return map[type] || ''
}

const tagType = (type) => {
  const map = { inbound: 'success', sale: 'danger', return: 'warning', modify_sn: '', transfer: '', transfer_out: '', transfer_out_confirm: '', transfer_in_confirm: '' }
  return map[type] || 'info'
}

const formatDateTime = (time) => {
  if (!time) return '-'
  const d = new Date(time)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  return `${y}-${m}-${day} ${h}:${min}:${s}`
}

const canOpenReference = (event) => ['purchase_request', 'sales_order', 'transfer_order', 'inbound', 'return_stock'].includes(event?.ref_type)

const referenceButtonLabel = (event) => ({
  purchase_request: '查看采购单',
  sales_order: '查看销售单',
  transfer_order: '查看调拨单',
  inbound: '查看入库单',
  return_stock: '查看退库单'
}[event?.ref_type] || '查看原始单据')

const referenceButtonType = (event) => event?.ref_type === 'inbound' ? 'success' : 'primary'

const goToReference = (event) => {
  if (!event?.ref_id || !canOpenReference(event)) return
  let target
  if (event.ref_type === 'sales_order') {
    target = router.resolve({ name: 'Sales', query: { orderId: String(event.ref_id), trace: '1' } })
  } else if (event.ref_type === 'purchase_request') {
    target = router.resolve({ name: 'Purchase', query: { requestId: String(event.ref_id), trace: '1' } })
  } else if (event.ref_type === 'transfer_order') {
    target = router.resolve({ name: 'Inventory', query: { transferId: String(event.ref_id), trace: '1' } })
  } else if (event.ref_type === 'inbound') {
    target = router.resolve({ name: 'Inventory', query: { inboundId: String(event.ref_id) } })
  } else {
    target = router.resolve({ name: 'Inventory', query: { returnId: String(event.ref_id), trace: '1' } })
  }
  window.open(target.href, '_blank')
}
</script>

<style scoped>
.sn-trace-page {
  padding: 10px 0;
}

.search-box {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 24px;
}

.result-area {
  max-width: 900px;
  margin: 0 auto;
}

.event-card {
  border-radius: 8px;
}

.event-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.event-desc {
  color: #606266;
  font-size: 14px;
}

.event-extra {
  margin: 6px 0;
  font-size: 13px;
}

.event-footer {
  display: flex;
  align-items: center;
  font-size: 12px;
  color: #c0c4cc;
  margin-top: 8px;
}

.event-user {
  color: #909399;
}

.event-time {
  margin-left: 16px;
}

.empty-state,
.hint-state {
  margin-top: 60px;
}
</style>
