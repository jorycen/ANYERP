<template>
  <div class="inventory-page">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>库存查询</span>
          <div>
            <el-button type="primary" @click="handleInbound">入库</el-button>
            <el-button type="success" @click="handleOutbound">出库</el-button>
            <el-button type="warning" @click="handleTransfer">调拨</el-button>
          </div>
        </div>
      </template>

      <el-tabs v-model="activeTab">
        <el-tab-pane label="库存列表" name="list">
          <div class="filter-bar">
            <el-input v-model="queryParams.keyword" placeholder="商品名称/PN码/SN码" clearable style="width: 200px" />
            <el-select v-model="queryParams.storeId" placeholder="选择门店" clearable style="width: 150px">
              <el-option label="全部门店" :value="''" />
              <el-option v-for="store in stores" :key="store.store_id" :label="store.name" :value="store.store_id" />
            </el-select>
            <el-button type="primary" @click="loadData">搜索</el-button>
          </div>

          <el-table :data="tableData" stripe border>
            <el-table-column prop="product_name" label="商品名称" min-width="150" />
            <el-table-column prop="pn_code" label="PN码" width="120" />
            <el-table-column prop="sn_code" label="SN码" width="150" />
            <el-table-column prop="store_name" label="门店" width="120" />
            <el-table-column prop="location_name" label="库位" width="100" />
            <el-table-column prop="status" label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="getStatusType(row.status)">{{ row.status }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="100">
              <template #default="{ row }">
                <el-button link type="primary" @click="handleViewSn(row)">详情</el-button>
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
        </el-tab-pane>

        <el-tab-pane label="SN列表" name="sn">
          <div class="filter-bar">
            <el-input v-model="snQuery.snCode" placeholder="SN码" clearable style="width: 200px" />
            <el-select v-model="snQuery.status" placeholder="状态" clearable style="width: 120px">
              <el-option label="全部" value="" />
              <el-option label="在库" value="in_stock" />
              <el-option label="已售" value="sold" />
            </el-select>
            <el-button type="primary" @click="loadSnData">搜索</el-button>
          </div>

          <el-table :data="snTableData" stripe border>
            <el-table-column prop="sn_code" label="SN码" width="180" />
            <el-table-column prop="product_name" label="商品" min-width="150" />
            <el-table-column prop="pn_code" label="PN码" width="120" />
            <el-table-column prop="store_name" label="门店" width="120" />
            <el-table-column prop="status" label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="getStatusType(row.status)">{{ row.status }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="inbound_time" label="入库时间" width="160" />
          </el-table>

          <el-pagination
            v-model:current-page="snQuery.page"
            v-model:page-size="snQuery.pageSize"
            :total="snTotal"
            :page-sizes="[10, 20, 50]"
            layout="total, sizes, prev, pager, next"
            @size-change="loadSnData"
            @current-change="loadSnData"
          />
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'

const activeTab = ref('list')
const stores = ref([])
const tableData = ref([])
const total = ref(0)
const snTableData = ref([])
const snTotal = ref(0)

const queryParams = reactive({
  page: 1,
  pageSize: 20,
  keyword: '',
  storeId: ''
})

const snQuery = reactive({
  page: 1,
  pageSize: 20,
  snCode: '',
  status: ''
})

onMounted(() => {
  loadData()
  loadStores()
})

const loadData = async () => {
  try {
    const res = await api.getInventoryList(queryParams)
    if (res.code === 0) {
      tableData.value = res.data?.list || []
      total.value = res.data?.total || 0
    }
  } catch (err) {
    ElMessage.error('加载数据失败')
  }
}

const loadSnData = async () => {
  try {
    const res = await api.getSnList(snQuery)
    if (res.code === 0) {
      snTableData.value = res.data?.list || []
      snTotal.value = res.data?.total || 0
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

const handleInbound = () => ElMessage.info('入库功能开发中')
const handleOutbound = () => ElMessage.info('出库功能开发中')
const handleTransfer = () => ElMessage.info('调拨功能开发中')
const handleViewSn = (row) => ElMessage.info('查看SN: ' + row.sn_code)

const getStatusType = (status) => {
  const types = { in_stock: 'success', sold: 'warning', damaged: 'danger' }
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
