<template>
  <div class="purchase-page">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>采购管理</span>
          <el-button type="primary" @click="handleCreate">新建采购申请</el-button>
        </div>
      </template>

      <el-tabs v-model="activeTab">
        <el-tab-pane label="采购申请" name="request">
          <el-table :data="tableData" stripe border>
            <el-table-column prop="request_no" label="申请单号" width="180" />
            <el-table-column prop="create_time" label="申请时间" width="160" />
            <el-table-column prop="store_name" label="申请门店" width="120" />
            <el-table-column prop="supplier_name" label="供应商" width="150" />
            <el-table-column prop="total_amount" label="申请金额" width="120">
              <template #default="{ row }">¥{{ row.total_amount }}</template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="getStatusType(row.status)">{{ row.status }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="150">
              <template #default="{ row }">
                <el-button link type="primary" @click="handleApprove(row)" v-if="row.status === 'pending'">审批</el-button>
                <el-button link type="primary" @click="handleView(row)">查看</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-pagination
            v-model:current-page="queryParams.page"
            v-model:page-size="queryParams.pageSize"
            :total="total"
            layout="total, sizes, prev, pager, next"
            @size-change="loadData"
            @current-change="loadData"
          />
        </el-tab-pane>

        <el-tab-pane label="供应商管理" name="supplier">
          <el-table :data="supplierData" stripe border>
            <el-table-column prop="name" label="供应商名称" min-width="150" />
            <el-table-column prop="contact" label="联系人" width="100" />
            <el-table-column prop="phone" label="联系电话" width="130" />
            <el-table-column prop="address" label="地址" min-width="200" />
            <el-table-column prop="status" label="状态" width="80">
              <template #default="{ row }">
                <el-tag :type="row.status === 1 ? 'success' : 'danger'">{{ row.status === 1 ? '正常' : '停用' }}</el-tag>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'

const activeTab = ref('request')
const tableData = ref([])
const supplierData = ref([])
const total = ref(0)

const queryParams = reactive({
  page: 1,
  pageSize: 20,
  status: ''
})

onMounted(() => {
  loadData()
  loadSuppliers()
})

const loadData = async () => {
  try {
    const res = await api.getPurchaseRequestList(queryParams)
    if (res.code === 0) {
      tableData.value = res.data?.list || []
      total.value = res.data?.total || 0
    }
  } catch (err) {
    ElMessage.error('加载数据失败')
  }
}

const loadSuppliers = async () => {
  try {
    const res = await api.getSupplierList()
    if (res.code === 0) {
      supplierData.value = res.data || []
    }
  } catch (err) {
    console.error('Failed to load suppliers')
  }
}

const handleCreate = () => ElMessage.info('新建采购申请功能开发中')
const handleApprove = (row) => ElMessage.info('审批: ' + row.request_no)
const handleView = (row) => ElMessage.info('查看: ' + row.request_no)

const getStatusType = (status) => {
  const types = { pending: 'warning', approved: 'success', rejected: 'danger', purchased: 'info' }
  return types[status] || 'info'
}
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.el-pagination {
  margin-top: 16px;
  justify-content: flex-end;
}
</style>
