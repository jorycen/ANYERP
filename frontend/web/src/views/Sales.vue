<template>
  <div class="sales-page">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>销售订单</span>
          <el-button type="primary" @click="handleCreate">新建订单</el-button>
        </div>
      </template>

      <div class="filter-bar">
        <el-select v-model="queryParams.storeId" placeholder="选择门店" clearable>
          <el-option label="全部门店" :value="''" />
          <el-option v-for="store in stores" :key="store.store_id" :label="store.name" :value="store.store_id" />
        </el-select>
        <el-date-picker v-model="queryParams.date" type="date" placeholder="选择日期" />
        <el-button type="primary" @click="loadData">搜索</el-button>
      </div>

      <el-table :data="tableData" stripe border>
        <el-table-column prop="order_no" label="订单号" width="180" />
        <el-table-column prop="create_time" label="创建时间" width="160" />
        <el-table-column prop="customer_name" label="客户姓名" width="120" />
        <el-table-column prop="customer_phone" label="联系电话" width="130" />
        <el-table-column prop="total_amount" label="订单金额" width="120">
          <template #default="{ row }">¥{{ row.total_amount }}</template>
        </el-table-column>
        <el-table-column prop="actual_payment" label="实付金额" width="120">
          <template #default="{ row }">¥{{ row.actual_payment }}</template>
        </el-table-column>
        <el-table-column prop="order_status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="getStatusType(row.order_status)">{{ row.order_status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="handleView(row)">查看</el-button>
            <el-button link type="primary" @click="handleEdit(row)">编辑</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        v-model:current-page="queryParams.page"
        v-model:page-size="queryParams.pageSize"
        :total="total"
        :page-sizes="[10, 20, 50]"
        layout="total, sizes, prev, pager, next"
        @size-change="loadData"
        @current-change="loadData"
      />
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'

const stores = ref([])
const tableData = ref([])
const total = ref(0)

const queryParams = reactive({
  page: 1,
  pageSize: 20,
  storeId: '',
  date: ''
})

onMounted(() => {
  loadData()
  loadStores()
})

const loadData = async () => {
  try {
    const res = await api.getSalesList(queryParams)
    if (res.code === 0) {
      tableData.value = res.data?.list || []
      total.value = res.data?.total || 0
    }
  } catch (err) {
    ElMessage.error('加载数据失败')
  }
}

const loadStores = async () => {
  try {
    const res = await api.getStoreList()
    if (res.code === 0) {
      stores.value = res.data || []
    }
  } catch (err) {
    console.error('Failed to load stores')
  }
}

const handleCreate = () => {
  ElMessage.info('新建订单功能开发中')
}

const handleView = (row) => {
  ElMessage.info('查看订单: ' + row.order_no)
}

const handleEdit = (row) => {
  ElMessage.info('编辑订单: ' + row.order_no)
}

const getStatusType = (status) => {
  const types = { completed: 'success', pending: 'warning', cancelled: 'danger' }
  return types[status] || 'info'
}
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.filter-bar {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}

.el-pagination {
  margin-top: 16px;
  justify-content: flex-end;
}
</style>
