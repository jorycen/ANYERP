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

    <!-- 入库对话框 -->
    <el-dialog v-model="inboundDialogVisible" title="商品入库" width="600px" @close="handleDialogClose">
      <el-form :model="inboundForm" label-width="100px">
        <el-form-item label="入库门店" required>
          <el-select v-model="inboundForm.storeId" placeholder="请选择门店" style="width: 100%">
            <el-option v-for="s in stores" :key="s.store_id" :label="s.name" :value="s.store_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="商品">
          <el-select v-model="inboundForm.productId" placeholder="选择商品" filterable style="width: 100%" @change="onProductChange">
            <el-option v-for="p in products" :key="p.product_id" :label="p.name" :value="p.product_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="PN码">
          <el-input v-model="inboundForm.pnCode" placeholder="PN码" />
        </el-form-item>
        <el-form-item label="SN码">
          <el-input v-model="inboundForm.snCode" placeholder="SN码（多个用逗号分隔）" type="textarea" rows="2" />
        </el-form-item>
        <el-form-item label="入库数量">
          <el-input-number v-model="inboundForm.quantity" :min="1" style="width: 100%" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="inboundForm.remark" type="textarea" rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="inboundDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleInboundSubmit" :loading="submitLoading">确认入库</el-button>
      </template>
    </el-dialog>

    <!-- 出库对话框 -->
    <el-dialog v-model="outboundDialogVisible" title="商品出库" width="600px" @close="handleDialogClose">
      <el-form :model="outboundForm" label-width="100px">
        <el-form-item label="出库门店" required>
          <el-select v-model="outboundForm.storeId" placeholder="请选择门店" style="width: 100%">
            <el-option v-for="s in stores" :key="s.store_id" :label="s.name" :value="s.store_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="商品">
          <el-select v-model="outboundForm.productId" placeholder="选择商品" filterable style="width: 100%" @change="onOutProductChange">
            <el-option v-for="p in products" :key="p.product_id" :label="p.name" :value="p.product_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="SN码">
          <el-select v-model="outboundForm.snCode" placeholder="选择SN码" clearable style="width: 100%">
            <el-option v-for="sn in availableSns" :key="sn.sn_code" :label="sn.sn_code" :value="sn.sn_code" />
          </el-select>
        </el-form-item>
        <el-form-item label="出库数量">
          <el-input-number v-model="outboundForm.quantity" :min="1" :max="maxOutQuantity" style="width: 100%" />
        </el-form-item>
        <el-form-item label="出库原因">
          <el-select v-model="outboundForm.reason" placeholder="请选择" style="width: 100%">
            <el-option label="销售出库" value="sale" />
            <el-option label="报废" value="scrapped" />
            <el-option label="其他" value="other" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="outboundForm.remark" type="textarea" rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="outboundDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleOutboundSubmit" :loading="submitLoading">确认出库</el-button>
      </template>
    </el-dialog>

    <!-- 调拨对话框 -->
    <el-dialog v-model="transferDialogVisible" title="库存调拨" width="600px" @close="handleDialogClose">
      <el-form :model="transferForm" label-width="100px">
        <el-form-item label="调出门店" required>
          <el-select v-model="transferForm.fromStoreId" placeholder="请选择门店" style="width: 100%">
            <el-option v-for="s in stores" :key="s.store_id" :label="s.name" :value="s.store_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="调入门店" required>
          <el-select v-model="transferForm.toStoreId" placeholder="请选择门店" style="width: 100%">
            <el-option v-for="s in stores" :key="s.store_id" :label="s.name" :value="s.store_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="商品">
          <el-select v-model="transferForm.productId" placeholder="选择商品" filterable style="width: 100%">
            <el-option v-for="p in products" :key="p.product_id" :label="p.name" :value="p.product_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="调拨数量">
          <el-input-number v-model="transferForm.quantity" :min="1" style="width: 100%" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="transferForm.remark" type="textarea" rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="transferDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleTransferSubmit" :loading="submitLoading">确认调拨</el-button>
      </template>
    </el-dialog>

    <!-- SN详情对话框 -->
    <el-dialog v-model="snDetailVisible" title="SN详情" width="600px">
      <div v-if="currentSn">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="SN码">{{ currentSn.sn_code }}</el-descriptions-item>
          <el-descriptions-item label="PN码">{{ currentSn.pn_code }}</el-descriptions-item>
          <el-descriptions-item label="商品名称">{{ currentSn.product_name }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="getStatusType(currentSn.status)">{{ currentSn.status }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="所在门店">{{ currentSn.store_name }}</el-descriptions-item>
          <el-descriptions-item label="库位">{{ currentSn.location_name || '-' }}</el-descriptions-item>
          <el-descriptions-item label="入库时间">{{ currentSn.inbound_time }}</el-descriptions-item>
          <el-descriptions-item label="关联订单">{{ currentSn.order_no || '-' }}</el-descriptions-item>
        </el-descriptions>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'

const activeTab = ref('list')
const stores = ref([])
const products = ref([])
const tableData = ref([])
const total = ref(0)
const snTableData = ref([])
const snTotal = ref(0)
const availableSns = ref([])

const inboundDialogVisible = ref(false)
const outboundDialogVisible = ref(false)
const transferDialogVisible = ref(false)
const snDetailVisible = ref(false)
const submitLoading = ref(false)
const currentSn = ref(null)

const maxOutQuantity = computed(() => {
  if (!outboundForm.productId || !outboundForm.storeId) return 1
  const item = snTableData.value.find(s =>
    s.product_id === outboundForm.productId &&
    s.store_name === stores.value.find(st => st.store_id === outboundForm.storeId)?.name
  )
  return item?.quantity || 1
})

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

const inboundForm = reactive({
  storeId: '',
  productId: '',
  pnCode: '',
  snCode: '',
  quantity: 1,
  remark: ''
})

const outboundForm = reactive({
  storeId: '',
  productId: '',
  snCode: '',
  quantity: 1,
  reason: 'sale',
  remark: ''
})

const transferForm = reactive({
  fromStoreId: '',
  toStoreId: '',
  productId: '',
  quantity: 1,
  remark: ''
})

onMounted(() => {
  loadData()
  loadStores()
  loadProducts()
  loadSnData()
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

const loadProducts = async () => {
  try {
    const res = await api.getProductList({ page: 1, pageSize: 1000 })
    if (res.code === 0) {
      products.value = res.data?.list || []
    }
  } catch (err) {
    console.error('Failed to load products')
  }
}

const handleInbound = () => {
  resetForms()
  inboundDialogVisible.value = true
}

const handleOutbound = () => {
  resetForms()
  outboundDialogVisible.value = true
}

const handleTransfer = () => {
  resetForms()
  transferDialogVisible.value = true
}

const handleViewSn = (row) => {
  currentSn.value = row
  snDetailVisible.value = true
}

const onProductChange = () => {
  inboundForm.quantity = 1
}

const onOutProductChange = () => {
  outboundForm.snCode = ''
  outboundForm.quantity = 1
}

const handleInboundSubmit = async () => {
  if (!inboundForm.storeId) {
    ElMessage.warning('请选择入库门店')
    return
  }
  if (!inboundForm.productId) {
    ElMessage.warning('请选择商品')
    return
  }

  submitLoading.value = true
  try {
    const data = {
      storeId: inboundForm.storeId,
      productId: inboundForm.productId,
      pnCode: inboundForm.pnCode,
      snCode: inboundForm.snCode,
      quantity: inboundForm.quantity,
      remark: inboundForm.remark
    }
    const res = await api.inbound(data)
    if (res.code === 0) {
      ElMessage.success('入库成功')
      inboundDialogVisible.value = false
      loadData()
      loadSnData()
    } else {
      ElMessage.error(res.message || '入库失败')
    }
  } catch (err) {
    ElMessage.error('入库失败')
  } finally {
    submitLoading.value = false
  }
}

const handleOutboundSubmit = async () => {
  if (!outboundForm.storeId) {
    ElMessage.warning('请选择出库门店')
    return
  }
  if (!outboundForm.productId) {
    ElMessage.warning('请选择商品')
    return
  }

  submitLoading.value = true
  try {
    const data = {
      storeId: outboundForm.storeId,
      productId: outboundForm.productId,
      snCode: outboundForm.snCode,
      quantity: outboundForm.quantity,
      reason: outboundForm.reason,
      remark: outboundForm.remark
    }
    const res = await api.outbound(data)
    if (res.code === 0) {
      ElMessage.success('出库成功')
      outboundDialogVisible.value = false
      loadData()
      loadSnData()
    } else {
      ElMessage.error(res.message || '出库失败')
    }
  } catch (err) {
    ElMessage.error('出库失败')
  } finally {
    submitLoading.value = false
  }
}

const handleTransferSubmit = async () => {
  if (!transferForm.fromStoreId) {
    ElMessage.warning('请选择调出门店')
    return
  }
  if (!transferForm.toStoreId) {
    ElMessage.warning('请选择调入门店')
    return
  }
  if (transferForm.fromStoreId === transferForm.toStoreId) {
    ElMessage.warning('调出门店和调入门店不能相同')
    return
  }
  if (!transferForm.productId) {
    ElMessage.warning('请选择商品')
    return
  }

  submitLoading.value = true
  try {
    const data = {
      fromStoreId: transferForm.fromStoreId,
      toStoreId: transferForm.toStoreId,
      productId: transferForm.productId,
      quantity: transferForm.quantity,
      remark: transferForm.remark
    }
    const res = await api.transfer(data)
    if (res.code === 0) {
      ElMessage.success('调拨成功')
      transferDialogVisible.value = false
      loadData()
      loadSnData()
    } else {
      ElMessage.error(res.message || '调拨失败')
    }
  } catch (err) {
    ElMessage.error('调拨失败')
  } finally {
    submitLoading.value = false
  }
}

const handleDialogClose = () => {
  resetForms()
}

const resetForms = () => {
  inboundForm.storeId = ''
  inboundForm.productId = ''
  inboundForm.pnCode = ''
  inboundForm.snCode = ''
  inboundForm.quantity = 1
  inboundForm.remark = ''

  outboundForm.storeId = ''
  outboundForm.productId = ''
  outboundForm.snCode = ''
  outboundForm.quantity = 1
  outboundForm.reason = 'sale'
  outboundForm.remark = ''

  transferForm.fromStoreId = ''
  transferForm.toStoreId = ''
  transferForm.productId = ''
  transferForm.quantity = 1
  transferForm.remark = ''
}

const getStatusType = (status) => {
  const types = { in_stock: 'success', sold: 'warning', damaged: 'danger', available: 'success', used: 'warning', scrapped: 'danger' }
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
