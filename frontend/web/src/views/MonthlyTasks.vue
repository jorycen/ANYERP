<template>
  <el-card>
    <template #header>
      <div class="page-header"><span>月度任务</span><el-button text @click="showLegacy = !showLegacy">{{ showLegacy ? '返回下发总览' : '查看旧版任务' }}</el-button></div>
    </template>
    <MonthlyIndicatorConfig v-if="!showLegacy" v-model:month-key="monthKey" />
    <template v-else>
      <div class="legacy-toolbar">
        <el-date-picker v-model="monthKey" type="month" value-format="YYYY-MM" :clearable="false" @change="loadLegacy" />
        <el-button @click="loadLegacy">查询</el-button>
      </div>
      <el-alert title="旧版任务保留查询，新任务在下发总览创建。" :closable="false" type="info" />
      <el-table :data="legacyRows" stripe border v-loading="loading" style="margin-top: 12px">
        <el-table-column prop="targetName" label="任务对象" />
        <el-table-column prop="storeName" label="所属门店" />
        <el-table-column prop="salesTarget" label="销售额目标" />
        <el-table-column prop="grossProfitTarget" label="毛利目标" />
        <el-table-column prop="allocationTotal" label="毛利已分摊" />
        <el-table-column label="商品批次">
          <template #default="{ row }">
            <div v-for="(batch, index) in row.productBatches" :key="batch.batchId || index">
              {{ batch.batchName }}
              <span v-for="product in batch.products" :key="product.productId"> · {{ product.productName || product.productId }} × {{ product.targetQuantity }}</span>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </template>
  </el-card>
</template>

<script setup>
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
import MonthlyIndicatorConfig from '../components/MonthlyIndicatorConfig.vue'

const monthKey = ref(new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7))
const showLegacy = ref(false), legacyRows = ref([]), loading = ref(false)
let request = 0
async function loadLegacy() {
  const id = ++request
  loading.value = true
  try {
    const response = await api.getMonthlyTasks({ monthKey: monthKey.value })
    if (id === request) legacyRows.value = response.data?.list || []
  } catch (error) {
    if (id === request) ElMessage.error(error.response?.data?.message || '旧版任务加载失败')
  } finally { if (id === request) loading.value = false }
}
watch(showLegacy, visible => { if (visible) loadLegacy() })
</script>

<style scoped>
.page-header, .legacy-toolbar { display: flex; align-items: center; gap: 12px; }
.page-header { justify-content: space-between; }
.legacy-toolbar { margin-bottom: 12px; }
</style>
