<template>
  <div class="indicator-report">
    <div class="filter-bar">
      <el-date-picker v-model="monthKey" type="month" value-format="YYYY-MM" />
      <el-select v-model="source" clearable placeholder="全部来源" style="width: 140px">
        <el-option label="公司下发" value="company" /><el-option label="门店自建" value="store" />
      </el-select>
      <el-button type="primary" :loading="loading" @click="load">查询</el-button>
      <el-button type="success" :loading="exporting" @click="exportReport">导出 Excel</el-button>
    </div>
    <el-table v-for="group in groups" :key="group.title" :data="group.rows" stripe border v-loading="loading" style="margin-top: 14px">
      <el-table-column :label="group.title">
        <el-table-column prop="name" label="指标" min-width="150" />
        <el-table-column prop="store" label="门店" />
        <el-table-column label="人员"><template #default="{ row }">{{ row.employee || '全店' }}</template></el-table-column>
        <el-table-column label="来源"><template #default="{ row }">{{ row.source === 'company' ? '公司下发' : '门店自建' }}</template></el-table-column>
        <el-table-column label="类型"><template #default="{ row }">{{ labels[row.metric] }}</template></el-table-column>
        <el-table-column label="目标"><template #default="{ row }">{{ row.target ?? '—' }}</template></el-table-column>
        <el-table-column label="已分解"><template #default="{ row }">{{ row.allocated ?? '—' }}</template></el-table-column>
        <el-table-column label="实际"><template #default="{ row }">{{ row.actualStatus === 'pending' ? '待核算' : (row.actual ?? '—') }}</template></el-table-column>
        <el-table-column label="达成率"><template #default="{ row }">{{ row.rate == null ? '—' : row.rate + '%' }}</template></el-table-column>
        <el-table-column v-if="group.title === '管理类指标'" label="待审"><template #default="{ row }">{{ row.pendingCount }}</template></el-table-column>
      </el-table-column>
    </el-table>
  </div>
</template>
<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
const monthKey = ref(new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7))
const labels = { sales: '销售额', profit: '销售毛利', quantity: '销售数量', management: '完成次数' }
const source = ref(''), rows = ref([]), loading = ref(false), exporting = ref(false)
const groups = computed(() => {
  const visible = rows.value
  return [{ title: '经营类指标', rows: visible.filter(row => row.metric !== 'management') },
    { title: '管理类指标', rows: visible.filter(row => row.metric === 'management') }]
})
async function load() {
  loading.value = true
  try { rows.value = (await api.getMonthlyIndicatorAchievement({ monthKey: monthKey.value, source: source.value })).data.rows }
  catch (error) { ElMessage.error(error.response?.data?.message || '加载指标失败') }
  finally { loading.value = false }
}
onMounted(load)
async function exportReport() {
  exporting.value = true
  try {
    const response = await api.exportMonthlyIndicatorAchievement({ monthKey: monthKey.value, source: source.value })
    const url = URL.createObjectURL(response.data)
    const link = document.createElement('a')
    link.href = url
    link.download = `月度指标达成_${monthKey.value}.xlsx`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch { ElMessage.error('导出指标失败') }
  finally { exporting.value = false }
}
</script>
<style scoped>
.filter-bar { display: flex; gap: 12px; align-items: center; }
</style>
