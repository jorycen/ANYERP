<template>
  <div v-if="isResource" style="margin-bottom:16px">
    <el-alert :closable="false" type="info" title="店长 → 张欢 → 邓红梅；全部通过后才入账" />
    <p>{{ data.resource_type === 'EDU_SUBSIDY' ? '教育补贴' : '销量报号' }} · SN：{{ data.sn_code }} · 配置金额：¥{{ amount }}</p>
    <p v-if="data.resource_type === 'EDU_SUBSIDY'">员工业绩毛利：¥{{ snapshot.employeeAmount }}；产品端毛利：¥{{ snapshot.productAmount }}；公司确认全额：¥{{ amount }}</p>
    <el-image v-for="url in urls" :key="url" :src="url" :preview-src-list="urls" fit="contain" style="width:160px;height:160px;margin-right:8px" />
    <p v-if="error">{{ error }}</p>
  </div>
</template>
<script setup>
import { computed, ref, watch } from 'vue'
import api from '../api'
const props = defineProps({ data: { type: Object, default: () => ({}) } })
const isResource = computed(() => ['EDU_SUBSIDY','SALES_REPORT'].includes(props.data?.resource_type))
const snapshot = computed(() => { try { return JSON.parse(props.data?.reward_snapshot_json || '{}') } catch (_) { return {} } })
const amount = computed(() => snapshot.value.amount ?? props.data?.change_amount ?? 0)
const urls = ref([]), error = ref('')
let serial = 0
watch(() => props.data?.attachment_url, async value => {
  const current = ++serial
  urls.value = []; error.value = ''
  let ids = []
  try { ids = JSON.parse(value || '[]') } catch (_) { ids = value ? [value] : [] }
  if (!Array.isArray(ids)) ids = []
  try {
    const cloud = ids.filter(url => String(url).startsWith('cloud://'))
    const resolved = cloud.length ? await api.resolveCloudFileUrls(cloud) : null
    const map = new Map((resolved?.data?.items || []).map(item => [item.fileId, item.url]))
    if (serial === current) urls.value = ids.map(id => map.get(id) || id).filter(url => /^https?:\/\//.test(url))
  } catch (_) { if (serial === current) error.value = '截图加载失败，请重新打开详情重试' }
}, { immediate: true })
</script>
