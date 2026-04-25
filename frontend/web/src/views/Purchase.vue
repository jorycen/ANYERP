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
          <div class="filter-bar">
            <el-button type="primary" @click="handleAddSupplier">新增供应商</el-button>
          </div>
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
            <el-table-column label="操作" width="100">
              <template #default="{ row }">
                <el-button link type="primary" @click="handleEditSupplier(row)">编辑</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- 新建采购申请对话框 -->
    <el-dialog v-model="requestDialogVisible" title="新建采购申请" width="700px" @close="handleDialogClose">
      <el-form :model="requestForm" label-width="100px">
        <el-form-item label="供应商" required>
          <el-select v-model="requestForm.supplierId" placeholder="请选择供应商" style="width: 100%">
            <el-option v-for="s in supplierData" :key="s.supplier_id" :label="s.name" :value="s.supplier_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="requestForm.remark" type="textarea" rows="2" placeholder="采购备注" />
        </el-form-item>

        <el-form-item label="商品明细">
          <div class="items-table">
            <el-table :data="requestForm.items" border size="small">
              <el-table-column label="商品" width="200">
                <template #default="{ row, $index }">
                  <el-select v-model="row.productId" placeholder="选择商品" filterable @change="onProductChange($index)">
                    <el-option v-for="p in products" :key="p.product_id" :label="p.name" :value="p.product_id" />
                  </el-select>
                </template>
              </el-table-column>
              <el-table-column label="单价" width="120">
                <template #default="{ row }">
                  <el-input-number v-model="row.price" :min="0" :precision="2" size="small" style="width: 100px" />
                </template>
              </el-table-column>
              <el-table-column label="数量" width="100">
                <template #default="{ row }">
                  <el-input-number v-model="row.quantity" :min="1" size="small" style="width: 80px" />
                </template>
              </el-table-column>
              <el-table-column label="小计" width="100">
                <template #default="{ row }">¥{{ (row.price * row.quantity || 0).toFixed(2) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="60">
                <template #default="{ $index }">
                  <el-button link type="danger" @click="removeRequestItem($index)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
            <el-button type="primary" size="small" @click="addRequestItem" class="mt-10">添加商品</el-button>
          </div>
        </el-form-item>

        <div class="order-summary">
          <div class="summary-item total">申请金额: <span>¥{{ totalAmount.toFixed(2) }}</span></div>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="requestDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleSubmit" :loading="submitLoading">提交申请</el-button>
      </template>
    </el-dialog>

    <!-- 查看采购申请对话框 -->
    <el-dialog v-model="viewDialogVisible" title="采购申请详情" width="700px">
      <div v-if="currentRequest">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="申请单号">{{ currentRequest.request_no }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="getStatusType(currentRequest.status)">{{ currentRequest.status }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="供应商">{{ currentRequest.supplier_name }}</el-descriptions-item>
          <el-descriptions-item label="申请门店">{{ currentRequest.store_name }}</el-descriptions-item>
          <el-descriptions-item label="申请金额">¥{{ currentRequest.total_amount }}</el-descriptions-item>
          <el-descriptions-item label="申请时间">{{ currentRequest.create_time }}</el-descriptions-item>
          <el-descriptions-item label="备注" :span="2">{{ currentRequest.remark || '-' }}</el-descriptions-item>
        </el-descriptions>

        <h4 class="mt-20">商品明细</h4>
        <el-table :data="currentRequest.items" border size="small">
          <el-table-column prop="product_name" label="商品名称" />
          <el-table-column prop="price" label="单价" width="100">
            <template #default="{ row }">¥{{ row.price }}</template>
          </el-table-column>
          <el-table-column prop="quantity" label="数量" width="80" />
          <el-table-column prop="subtotal" label="小计" width="100">
            <template #default="{ row }">¥{{ row.subtotal }}</template>
          </el-table-column>
        </el-table>
      </div>
    </el-dialog>

    <!-- 审批对话框 -->
    <el-dialog v-model="approveDialogVisible" title="审批采购申请" width="500px">
      <el-form :model="approveForm" label-width="100px">
        <el-form-item label="审批结果">
          <el-radio-group v-model="approveForm.action">
            <el-radio label="approve">通过</el-radio>
            <el-radio label="reject">拒绝</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="审批备注">
          <el-input v-model="approveForm.comment" type="textarea" rows="3" placeholder="审批备注" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="approveDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleApproveSubmit" :loading="approveLoading">确定</el-button>
      </template>
    </el-dialog>

    <!-- 供应商对话框 -->
    <el-dialog v-model="supplierDialogVisible" :title="supplierDialogTitle" width="500px" @close="handleSupplierDialogClose">
      <el-form :model="supplierForm" label-width="100px">
        <el-form-item label="供应商名称" required>
          <el-input v-model="supplierForm.name" placeholder="请输入供应商名称" />
        </el-form-item>
        <el-form-item label="联系人">
          <el-input v-model="supplierForm.contact" placeholder="请输入联系人" />
        </el-form-item>
        <el-form-item label="联系电话">
          <el-input v-model="supplierForm.phone" placeholder="请输入联系电话" />
        </el-form-item>
        <el-form-item label="地址">
          <el-input v-model="supplierForm.address" placeholder="请输入地址" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="supplierForm.remark" type="textarea" rows="2" placeholder="备注" />
        </el-form-item>
        <el-form-item label="状态">
          <el-switch v-model="supplierForm.status" :active-value="1" :inactive-value="0" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="supplierDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleSupplierSubmit" :loading="supplierLoading">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'

const activeTab = ref('request')
const tableData = ref([])
const supplierData = ref([])
const products = ref([])
const total = ref(0)

const requestDialogVisible = ref(false)
const viewDialogVisible = ref(false)
const approveDialogVisible = ref(false)
const supplierDialogVisible = ref(false)
const submitLoading = ref(false)
const approveLoading = ref(false)
const supplierLoading = ref(false)
const currentRequest = ref(null)
const supplierDialogTitle = ref('新增供应商')
const currentSupplier = ref(null)

const queryParams = reactive({
  page: 1,
  pageSize: 20,
  status: ''
})

const requestForm = reactive({
  supplierId: '',
  remark: '',
  items: []
})

const approveForm = reactive({
  action: 'approve',
  comment: ''
})

const supplierForm = reactive({
  supplierId: null,
  name: '',
  contact: '',
  phone: '',
  address: '',
  remark: '',
  status: 1
})

const totalAmount = computed(() => {
  return requestForm.items.reduce((sum, item) => {
    return sum + (item.price * item.quantity || 0)
  }, 0)
})

onMounted(() => {
  loadData()
  loadSuppliers()
  loadProducts()
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

const handleCreate = () => {
  resetForm()
  requestDialogVisible.value = true
}

const handleView = (row) => {
  currentRequest.value = row
  viewDialogVisible.value = true
}

const handleApprove = (row) => {
  currentRequest.value = row
  approveForm.action = 'approve'
  approveForm.comment = ''
  approveDialogVisible.value = true
}

const handleApproveSubmit = async () => {
  approveLoading.value = true
  try {
    const res = await api.approvePurchaseRequest(currentRequest.value.request_id, {
      action: approveForm.action,
      comment: approveForm.comment
    })
    if (res.code === 0) {
      ElMessage.success('审批成功')
      approveDialogVisible.value = false
      loadData()
    } else {
      ElMessage.error(res.message || '审批失败')
    }
  } catch (err) {
    ElMessage.error('审批失败')
  } finally {
    approveLoading.value = false
  }
}

const handleAddSupplier = () => {
  supplierDialogTitle.value = '新增供应商'
  resetSupplierForm()
  supplierDialogVisible.value = true
}

const handleEditSupplier = (row) => {
  supplierDialogTitle.value = '编辑供应商'
  currentSupplier.value = row
  supplierForm.supplierId = row.supplier_id
  supplierForm.name = row.name
  supplierForm.contact = row.contact || ''
  supplierForm.phone = row.phone || ''
  supplierForm.address = row.address || ''
  supplierForm.remark = row.remark || ''
  supplierForm.status = row.status
  supplierDialogVisible.value = true
}

const handleSupplierSubmit = async () => {
  if (!supplierForm.name) {
    ElMessage.warning('请输入供应商名称')
    return
  }

  supplierLoading.value = true
  try {
    const data = {
      name: supplierForm.name,
      contact: supplierForm.contact,
      phone: supplierForm.phone,
      address: supplierForm.address,
      remark: supplierForm.remark,
      status: supplierForm.status
    }

    let res
    if (supplierForm.supplierId) {
      res = await api.updateSupplier(supplierForm.supplierId, data)
    } else {
      res = await api.createSupplier(data)
    }

    if (res.code === 0) {
      ElMessage.success(supplierForm.supplierId ? '更新成功' : '创建成功')
      supplierDialogVisible.value = false
      loadSuppliers()
    } else {
      ElMessage.error(res.message || '操作失败')
    }
  } catch (err) {
    ElMessage.error('操作失败')
  } finally {
    supplierLoading.value = false
  }
}

const handleSupplierDialogClose = () => {
  resetSupplierForm()
}

const resetSupplierForm = () => {
  supplierForm.supplierId = null
  supplierForm.name = ''
  supplierForm.contact = ''
  supplierForm.phone = ''
  supplierForm.address = ''
  supplierForm.remark = ''
  supplierForm.status = 1
}

const onProductChange = (index) => {
  const product = products.value.find(p => p.product_id === requestForm.items[index].productId)
  if (product) {
    requestForm.items[index].price = product.cost_price || 0
  }
}

const addRequestItem = () => {
  requestForm.items.push({ productId: '', productName: '', price: 0, quantity: 1 })
}

const removeRequestItem = (index) => {
  requestForm.items.splice(index, 1)
}

const handleSubmit = async () => {
  if (!requestForm.supplierId) {
    ElMessage.warning('请选择供应商')
    return
  }
  if (requestForm.items.length === 0) {
    ElMessage.warning('请添加商品')
    return
  }

  submitLoading.value = true
  try {
    const data = {
      supplierId: requestForm.supplierId,
      remark: requestForm.remark,
      items: requestForm.items.map(item => ({
        productId: item.productId,
        price: item.price,
        quantity: item.quantity
      }))
    }
    const res = await api.createPurchaseRequest(data)
    if (res.code === 0) {
      ElMessage.success('提交成功')
      requestDialogVisible.value = false
      loadData()
    } else {
      ElMessage.error(res.message || '提交失败')
    }
  } catch (err) {
    ElMessage.error('提交失败')
  } finally {
    submitLoading.value = false
  }
}

const handleDialogClose = () => {
  resetForm()
}

const resetForm = () => {
  requestForm.supplierId = ''
  requestForm.remark = ''
  requestForm.items = []
}

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
.items-table {
  border: 1px solid #ebeef5;
  padding: 10px;
  border-radius: 4px;
}
.mt-10 {
  margin-top: 10px;
}
.mt-20 {
  margin-top: 20px;
}
.order-summary {
  background: #f5f7fa;
  padding: 15px;
  border-radius: 4px;
  margin-top: 20px;
}
.summary-item {
  display: flex;
  justify-content: space-between;
  padding: 5px 0;
}
.summary-item.total {
  font-weight: bold;
  font-size: 16px;
}
.summary-item span {
  color: #f56c6c;
}
</style>
