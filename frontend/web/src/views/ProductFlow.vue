<template>
  <div class="product-flow-page">
    <el-card>
      <template #header><span>商品流水记录</span></template>
      <div class="filters">
        <el-input v-model="query.keyword" clearable placeholder="商品名称 / 编码 / PN / SN / 单号" @keyup.enter="search" />
        <el-select v-model="query.storeId" clearable placeholder="全部门店">
          <el-option v-for="store in stores" :key="store.store_id" :label="store.name" :value="store.store_id" />
        </el-select>
        <el-select v-model="query.direction" clearable placeholder="全部方向">
          <el-option label="入库" value="in" />
          <el-option label="出库" value="out" />
        </el-select>
        <el-date-picker v-model="dates" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" />
        <el-button type="primary" @click="search">查询</el-button>
        <el-button @click="reset">重置</el-button>
      </div>
      <el-table :data="rows" border stripe v-loading="loading" empty-text="暂无商品出入库流水">
        <el-table-column prop="event_time" label="发生时间" min-width="170" />
        <el-table-column prop="store_name" label="门店" min-width="130" />
        <el-table-column prop="business_type" label="业务类型" min-width="130" />
        <el-table-column label="方向" width="80"><template #default="{ row }"><el-tag :type="row.direction === 'in' ? 'success' : 'warning'">{{ row.direction === 'in' ? '入库' : '出库' }}</el-tag></template></el-table-column>
        <el-table-column prop="product_name" label="商品名称" min-width="200" show-overflow-tooltip />
        <el-table-column prop="product_code" label="商品编码" min-width="130" />
        <el-table-column prop="pn_code" label="PN" min-width="140" />
        <el-table-column prop="sn_code" label="SN" min-width="150" />
        <el-table-column label="变动数量" width="100"><template #default="{ row }">{{ row.direction === 'in' ? '+' : '-' }}{{ row.quantity }}</template></el-table-column>
        <el-table-column prop="document_no" label="业务单号" min-width="180" />
        <el-table-column prop="operator_name" label="操作人" min-width="110" />
      </el-table>
      <div class="pagination"><el-pagination v-model:current-page="page" v-model:page-size="pageSize" :page-sizes="[20, 50, 100]" :total="total" layout="total, sizes, prev, pager, next" @current-change="load" @size-change="search" /></div>
    </el-card>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'

const query = reactive({ keyword: '', storeId: '', direction: '' })
const dates = ref([])
const stores = ref([])
const rows = ref([])
const loading = ref(false)
const page = ref(1)
const pageSize = ref(20)
const total = ref(0)

async function load() {
  loading.value = true
  try {
    const response = await api.getProductFlow({ ...query, startDate: dates.value?.[0] || '', endDate: dates.value?.[1] || '', page: page.value, pageSize: pageSize.value })
    const data = response.data || {}
    rows.value = data.list || []
    total.value = Number(data.total || 0)
  } catch (error) {
    ElMessage.error(error.response?.data?.message || '加载商品流水失败')
  } finally {
    loading.value = false
  }
}
function search() { page.value = 1; load() }
function reset() { Object.assign(query, { keyword: '', storeId: '', direction: '' }); dates.value = []; search() }

onMounted(async () => {
  try {
    const response = await api.getInventoryReadableStoreList()
    stores.value = Array.isArray(response.data) ? response.data : []
  } catch (error) {
    stores.value = []
  }
  load()
})
</script>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; align-items: center; }
.filters .el-input { width: 260px; }
.filters .el-select { width: 160px; }
.pagination { display: flex; justify-content: flex-end; margin-top: 16px; }
</style>
