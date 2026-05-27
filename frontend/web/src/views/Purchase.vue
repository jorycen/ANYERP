<template>
  <div class="purchase-page">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>采购管理</span>
        </div>
      </template>

      <el-tabs v-model="activeTab">
        <el-tab-pane label="采购申请" name="request">
          <div class="filter-bar">
            <el-select v-model="queryParams.status" placeholder="状态" clearable style="width: 150px">
              <el-option label="全部" value="" />
              <el-option label="待审批" value="pending" />
              <el-option label="已通过" value="approved" />
              <el-option label="已拒绝" value="rejected" />
            </el-select>
            <el-button type="primary" @click="handleCreate">新建采购申请</el-button>
          </div>
          <el-table :data="tableData" stripe border>
            <el-table-column prop="request_no" label="申请单号" width="180" />
            <el-table-column prop="create_time" label="申请时间" width="160">
              <template #default="{ row }">
                {{ row.create_time ? formatDate(row.create_time) : '-' }}
              </template>
            </el-table-column>
            <el-table-column prop="store_name" label="申请门店" width="120" />
            <el-table-column prop="supplier_name" label="供应商" width="150" />
            <el-table-column prop="invoice_type" label="发票类型" width="100" />
            <el-table-column prop="items_summary" label="商品摘要" min-width="200" show-overflow-tooltip />
            <el-table-column prop="total_amount" label="申请金额" width="120">
              <template #default="{ row }">¥{{ row.total_amount }}</template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="getStatusType(row.status)">{{ getStatusText(row.status) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="250">
              <template #default="{ row }">
                <el-button link type="primary" @click="handleApprove(row)" v-if="row.status === 'pending'">审批</el-button>
                <el-button link type="warning" @click="handleRevoke(row)" v-if="row.status === 'approved'">撤销</el-button>
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
            <el-input v-model="supplierQuery.keyword" placeholder="搜索供应商名称/联系人" clearable style="width: 250px" />
            <el-button type="primary" @click="loadSuppliers">搜索</el-button>
            <el-button type="primary" @click="handleAddSupplier">新增供应商</el-button>
          </div>
          <el-table :data="supplierData" stripe border>
            <el-table-column prop="supplier_id" label="供应商编号" width="150" />
            <el-table-column prop="name" label="供应商名称" min-width="150" />
            <el-table-column prop="contact" label="联系人" width="100" />
            <el-table-column prop="phone" label="联系电话" width="130" />
            <el-table-column prop="address" label="地址" min-width="200" />
            <el-table-column prop="status" label="状态" width="80">
              <template #default="{ row }">
                <el-tag :type="row.status === 1 ? 'success' : 'danger'">{{ row.status === 1 ? '正常' : '停用' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="180">
              <template #default="{ row }">
                <el-button link type="primary" @click="handleEditSupplier(row)">编辑</el-button>
                <el-button link type="danger" @click="handleDeleteSupplier(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-pagination
            v-model:current-page="supplierQuery.page"
            v-model:page-size="supplierQuery.pageSize"
            :total="supplierTotal"
            layout="total, sizes, prev, pager, next"
            @size-change="loadSuppliers"
            @current-change="loadSuppliers"
          />
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- 新建采购申请对话框 -->
    <el-dialog v-model="requestDialogVisible" title="新建采购申请" width="700px" @close="handleDialogClose">
      <el-form :model="requestForm" label-width="100px">
        <el-form-item label="供应商" required>
          <el-select v-model="requestForm.supplierId" placeholder="请选择供应商" style="width: 100%" @change="onSupplierChange">
            <el-option v-for="s in allSuppliers" :key="s.supplier_id" :label="s.name" :value="s.supplier_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="发票类型">
          <el-select v-model="requestForm.invoiceType" placeholder="请选择发票类型" style="width: 100%">
            <el-option label="收据" value="收据" />
            <el-option label="专票6%" value="专票6%" />
            <el-option label="专票13%" value="专票13%" />
          </el-select>
        </el-form-item>
        <el-form-item label="货型" required>
          <el-select v-model="requestForm.productType" placeholder="请选择货型" style="width: 100%">
            <el-option label="正规货" value="正规货" />
            <el-option label="国补货" value="国补货" />
            <el-option label="纯二批" value="纯二批" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="requestForm.remark" type="textarea" rows="2" placeholder="采购备注" />
        </el-form-item>

        <el-form-item label="返利抵扣" v-if="requestForm.supplierId && rebateBalance > 0">
          <div style="width: 100%">
            <div style="margin-bottom: 6px; font-size: 13px; color: #909399;">
              供应商返利余额：¥{{ rebateBalance.toFixed(2) }}
            </div>
            <el-input v-model="requestForm.rebateDeduction" placeholder="0" style="width: 240px" />
          </div>
        </el-form-item>

        <el-form-item label="商品明细">
          <div class="items-table" style="width: 100%; max-width: 600px; overflow: hidden;">
            <div v-for="(item, idx) in requestForm.items" :key="idx" class="item-row" style="border: 1px solid #ebeef5; padding: 10px; margin-bottom: 10px; border-radius: 4px; width: 100%; box-sizing: border-box; max-width: 600px;">
              <div class="item-top" style="display: flex; gap: 8px; align-items: center; margin-bottom: 10px; width: 100%; box-sizing: border-box;">
                <div style="flex: 1; min-width: 140px; max-width: 300px;">
                  <el-select v-model="item.productId" placeholder="搜索商品" filterable remote :remote-method="searchProducts" @change="onProductChange(idx)" style="width: 100%;" size="small">
                    <el-option v-for="p in products" :key="p.product_id" :label="`${p.name} (${p.product_code})`" :value="p.product_id">
                      <div style="display: flex; flex-direction: column; font-size: 12px;">
                        <span>{{ p.name }}</span>
                        <span style="color: #909399; font-size: 11px;">编码: {{ p.product_code }} | 厂商: {{ p.manufacturer_code || '-' }}</span>
                      </div>
                    </el-option>
                  </el-select>
                </div>
                <div style="width: 110px;">
                  <el-input v-model="item.price" type="number" placeholder="采购单价" size="small" style="width: 100%;" class="no-spinner" />
                </div>
                <div style="width: 75px;">
                  <el-input v-model="item.quantity" size="small" placeholder="数量" style="width: 100%;" class="no-spinner" />
                </div>
                <div style="width: 70px; font-size: 13px; flex-shrink: 0;">
                  <span style="color: #f56c6c; font-weight: 500;">¥{{ (item.price * item.quantity || 0).toFixed(2) }}</span>
                </div>
                <div style="width: 60px; flex-shrink: 0;">
                  <el-button link type="danger" size="small" @click="removeRequestItem(idx)">删除</el-button>
                </div>
              </div>
              <div class="item-bottom" style="display: flex; gap: 8px; align-items: center; padding: 6px 10px; background: #f5f7fa; border-radius: 4px; width: 100%; box-sizing: border-box; overflow: hidden;">
                <span style="font-size: 12px; color: #606266; min-width: 60px; white-space: nowrap; flex-shrink: 0;">门店分配:</span>
                <div style="flex: 1; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; overflow: hidden;">
                  <div v-if="item.storeAllocations && item.storeAllocations.length > 0" style="display: flex; flex-wrap: wrap; gap: 6px;">
                    <div v-for="(alloc, allocIdx) in item.storeAllocations" :key="allocIdx" style="background: #fff; padding: 3px 6px; border-radius: 4px; border: 1px solid #e4e7ed; font-size: 11px; white-space: nowrap; max-width: 180px; text-overflow: ellipsis; overflow: hidden;">
                      <span>{{ alloc.storeName || alloc.storeId }}</span>
                      <span style="color: #909399; margin-left: 3px;">× {{ alloc.quantity }}</span>
                    </div>
                  </div>
                  <span v-else style="color: #f56c6c; font-size: 12px;">未分配</span>
                </div>
                <el-button type="primary" size="small" @click="handleAllocateStore(item, idx)" style="flex-shrink: 0;">分配</el-button>
              </div>
            </div>
            <el-button type="primary" size="small" @click="addRequestItem">添加商品</el-button>
          </div>
        </el-form-item>

        <div class="order-summary">
          <div class="summary-item total">申请金额: <span>¥{{ totalAmount.toFixed(2) }}</span></div>
          <div v-if="requestForm.rebateDeduction > 0" class="summary-item deduction" style="color: #67c23a;">
            返利抵扣: <span>-¥{{ requestForm.rebateDeduction }}</span>
          </div>
          <div v-if="requestForm.rebateDeduction > 0" class="summary-item actual">
            实际应付: <span style="color: #f56c6c; font-weight: 700;">¥{{ actualTotal.toFixed(2) }}</span>
          </div>
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
            <el-tag :type="getStatusType(currentRequest.status)">{{ getStatusText(currentRequest.status) }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="供应商">{{ currentRequest.supplier_name }}</el-descriptions-item>
          <el-descriptions-item label="发票类型">{{ currentRequest.invoice_type || '-' }}</el-descriptions-item>
          <el-descriptions-item label="申请门店">{{ currentRequest.store_name }}</el-descriptions-item>
          <el-descriptions-item label="申请金额">¥{{ currentRequest.total_amount }}</el-descriptions-item>
          <el-descriptions-item label="申请时间">{{ formatDate(currentRequest.create_time) }}</el-descriptions-item>
          <el-descriptions-item label="备注" :span="2">{{ currentRequest.remark || '-' }}</el-descriptions-item>
        </el-descriptions>

        <h4 class="mt-20">商品明细</h4>
        <el-table :data="currentRequest.items || []" border size="small">
          <el-table-column prop="product_name" label="商品名称" min-width="150" />
          <el-table-column prop="unit_price" label="单价" width="100">
            <template #default="{ row }">¥{{ row.unit_price }}</template>
          </el-table-column>
          <el-table-column prop="quantity" label="数量" width="80" />
          <el-table-column label="小计" width="100">
            <template #default="{ row }">¥{{ (row.unit_price * row.quantity).toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="门店分配" min-width="200">
            <template #default="{ row }">
              <div v-if="row.store_allocations_parsed && row.store_allocations_parsed.length > 0">
                <div v-for="(alloc, idx) in row.store_allocations_parsed" :key="idx" style="font-size: 12px;">
                  <span>{{ alloc.storeName }}: {{ alloc.quantity }}</span>
                </div>
              </div>
              <span v-else style="color: #909399; font-size: 12px;">未分配</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </el-dialog>

    <!-- 撤销对话框 -->
    <el-dialog v-model="revokeDialogVisible" title="撤销采购申请" width="500px">
      <el-form :model="revokeForm" label-width="100px">
        <el-form-item label="撤销备注">
          <el-input v-model="revokeForm.comment" type="textarea" rows="3" placeholder="请输入撤销备注" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="revokeDialogVisible = false">取消</el-button>
        <el-button type="warning" @click="handleRevokeSubmit" :loading="revokeLoading">确定撤销</el-button>
      </template>
    </el-dialog>

    <!-- 审批对话框 -->
    <el-dialog v-model="approveDialogVisible" title="审批采购申请" width="500px">
      <el-form :model="approveForm" label-width="100px">
        <el-form-item label="审批结果">
          <el-radio-group v-model="approveForm.action">
            <el-radio value="approved">通过</el-radio>
            <el-radio value="rejected">拒绝</el-radio>
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

    <!-- 门店分配对话框 -->
    <el-dialog v-model="allocateDialogVisible" title="分配门店" width="700px" @close="handleAllocateDialogClose">
      <div style="margin-bottom: 16px;">
        <span style="font-weight: bold;">商品：{{ currentAllocateProduct?.productName || '-' }}</span>
        <span style="margin-left: 24px; font-weight: bold;">总数量：{{ currentAllocateProduct?.quantity || 0 }}</span>
        <span style="margin-left: 24px; color: #409EFF; font-weight: bold;">已分配：{{ allocatedTotalQuantity }}</span>
        <span style="margin-left: 24px; color: #F56C6C; font-weight: bold;">待分配：{{ remainingAllocateQuantity }}</span>
      </div>
      <el-table :data="storeAllocationList" stripe border max-height="400">
        <el-table-column prop="storeName" label="门店名称" min-width="150" />
        <el-table-column label="分配数量" width="180">
          <template #default="{ row }">
            <el-input 
              v-model="row.quantity" 
              size="small" 
              style="width: 100%;"
              @change="validateAllocation" 
            />
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="allocateDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleSaveAllocation">确定</el-button>
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
          <span class="ml-10">{{ supplierForm.status === 1 ? '正常' : '停用' }}</span>
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
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'

const activeTab = ref('request')
const tableData = ref([])
const supplierData = ref([])
const allSuppliers = ref([])
const allStores = ref([])
const allStoresLoaded = ref(false)
const products = ref([])
const productSearchKeyword = ref('')
const total = ref(0)
const supplierTotal = ref(0)

const requestDialogVisible = ref(false)
const viewDialogVisible = ref(false)
const approveDialogVisible = ref(false)
const revokeDialogVisible = ref(false)
const supplierDialogVisible = ref(false)
const allocateDialogVisible = ref(false)
const submitLoading = ref(false)
const approveLoading = ref(false)
const revokeLoading = ref(false)
const supplierLoading = ref(false)
const currentRequest = ref(null)
const supplierDialogTitle = ref('新增供应商')
const currentSupplier = ref(null)
const currentAllocateProduct = ref(null)
const currentAllocateIndex = ref(-1)
const storeAllocationList = ref([])

const queryParams = reactive({
  page: 1,
  pageSize: 20,
  status: ''
})

const supplierQuery = reactive({
  page: 1,
  pageSize: 20,
  keyword: ''
})

const requestForm = reactive({
  supplierId: '',
  invoiceType: '',
  productType: '正规货',
  remark: '',
  rebateDeduction: 0,
  items: []
})

const rebateBalance = ref(0)

const approveForm = reactive({
  action: 'approved',
  comment: ''
})

const revokeForm = reactive({
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

const toNumber = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

const totalAmount = computed(() => {
  return requestForm.items.reduce((sum, item) => {
    return sum + (toNumber(item.price) * toNumber(item.quantity))
  }, 0)
})

const actualTotal = computed(() => {
  const deduction = Math.min(parseFloat(requestForm.rebateDeduction || 0), totalAmount.value)
  return totalAmount.value - deduction
})

const allocatedTotalQuantity = computed(() => {
  return storeAllocationList.value.reduce((sum, item) => {
    return sum + toNumber(item.quantity)
  }, 0)
})

const remainingAllocateQuantity = computed(() => {
  return toNumber(currentAllocateProduct.value?.quantity) - allocatedTotalQuantity.value
})

onMounted(() => {
  loadData()
  loadSuppliers()
  loadAllSuppliers()
  loadAllStores()
  loadProducts()
})

const loadAllStores = async () => {
  if (allStoresLoaded.value) return
  try {
    const res = await api.getAllStores()
    if (res && res.code === 0 && Array.isArray(res.data)) {
      allStores.value = res.data
      allStoresLoaded.value = true
    } else {
      allStores.value = []
    }
  } catch (err) {
    allStores.value = []
  }
}

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
    const res = await api.getSupplierList(supplierQuery)
    if (res.code === 0) {
      supplierData.value = res.data?.list || []
      supplierTotal.value = res.data?.total || 0
    }
  } catch (err) {
    console.error('Failed to load suppliers')
  }
}

const loadAllSuppliers = async () => {
  try {
    const res = await api.getAllSuppliers()
    if (res.code === 0) {
      allSuppliers.value = res.data || []
    }
  } catch (err) {
    console.error('Failed to load all suppliers')
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

const handleView = async (row) => {
  try {
    const res = await api.getPurchaseRequestDetail(row.request_id)
    if (res.code === 0) {
      currentRequest.value = res.data
      viewDialogVisible.value = true
    } else {
      ElMessage.error(res.message || '获取详情失败')
    }
  } catch (err) {
    ElMessage.error('获取详情失败')
  }
}

const formatDate = (dateStr) => {
  if (!dateStr) return '-'
  const date = new Date(dateStr)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  const second = String(date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`
}

const handleApprove = (row) => {
  currentRequest.value = row
  approveForm.action = 'approved'
  approveForm.comment = ''
  approveDialogVisible.value = true
}

const handleApproveSubmit = async () => {
  approveLoading.value = true
  try {
    const res = await api.approvePurchaseRequest(currentRequest.value.request_id, {
      status: approveForm.action,
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

const handleRevoke = (row) => {
  currentRequest.value = row
  revokeForm.comment = ''
  revokeDialogVisible.value = true
}

const handleRevokeSubmit = async () => {
  revokeLoading.value = true
  try {
    const res = await api.revokePurchaseRequest(currentRequest.value.request_id, {
      comment: revokeForm.comment
    })
    if (res.code === 0) {
      ElMessage.success('撤销成功')
      revokeDialogVisible.value = false
      loadData()
    } else {
      ElMessage.error(res.message || '撤销失败')
    }
  } catch (err) {
    if (err.response?.data?.message) {
      ElMessage.error(err.response.data.message)
    } else {
      ElMessage.error('撤销失败')
    }
  } finally {
    revokeLoading.value = false
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

const handleDeleteSupplier = async (row) => {
  try {
    await ElMessageBox.confirm(
      `确定要删除供应商「${row.name}」吗？删除后不可恢复！`,
      '删除确认',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    const res = await api.deleteSupplier(row.supplier_id)
    if (res.code === 0) {
      ElMessage.success('删除成功')
      loadSuppliers()
      loadAllSuppliers()
    } else {
      ElMessage.error(res.message || '删除失败')
    }
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('删除失败')
    }
  }
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
      loadAllSuppliers()
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

const searchProducts = async (keyword) => {
  productSearchKeyword.value = keyword
  try {
    const res = await api.getProductList({ keyword, page: 1, pageSize: 50 })
    if (res.code === 0) {
      products.value = res.data?.list || []
    }
  } catch (err) {
    console.error('Failed to search products')
  }
}

const onSupplierChange = async (supplierId) => {
  const supplier = allSuppliers.value.find(s => s.supplier_id === supplierId)
  if (supplier && supplier.invoice_type) {
    requestForm.invoiceType = supplier.invoice_type
  }
  requestForm.rebateDeduction = 0
  if (supplierId) {
    try {
      const res = await api.getRebateBalance({ supplierId })
      if (res.code === 0) {
        rebateBalance.value = parseFloat(res.data?.balance || 0)
      }
    } catch (err) {
      rebateBalance.value = 0
    }
  } else {
    rebateBalance.value = 0
  }
}

const onProductChange = (index) => {
  const product = products.value.find(p => p.product_id === requestForm.items[index].productId)
  if (product) {
    requestForm.items[index].productName = product.name
    requestForm.items[index].price = product.min_sale_price || 0
  }
}

const addRequestItem = () => {
  requestForm.items.push({ productId: '', productName: '', price: 0, quantity: 1, storeAllocations: [] })
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

  // 校验每个商品都已分配门店
  for (let i = 0; i < requestForm.items.length; i++) {
    const item = requestForm.items[i]
    const productName = item.productName || '第' + (i + 1) + '个商品'
    
    if (!item.storeAllocations || item.storeAllocations.length === 0) {
      ElMessage.warning(`请先为「${productName}」分配门店`)
      return
    }

    // 校验分配数量总和等于商品数量
    const allocatedQty = item.storeAllocations.reduce((sum, alloc) => sum + toNumber(alloc.quantity), 0)
    if (allocatedQty !== toNumber(item.quantity)) {
      ElMessage.warning(`「${productName}」分配数量(${allocatedQty})必须等于采购数量(${item.quantity})`)
      return
    }
  }

  submitLoading.value = true
  try {
    const data = {
      supplierId: requestForm.supplierId,
      invoiceType: requestForm.invoiceType,
      remark: requestForm.remark,
      rebateDeduction: requestForm.rebateDeduction,
      items: requestForm.items.map(item => ({
        productId: item.productId,
        productName: item.productName,
        price: item.price,
        quantity: item.quantity,
        productType: requestForm.productType || '正规货',
        storeAllocations: item.storeAllocations
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
  requestForm.invoiceType = ''
  requestForm.productType = '正规货'
  requestForm.remark = ''
  requestForm.rebateDeduction = 0
  requestForm.items = []
}

const getStatusType = (status) => {
  const types = { pending: 'warning', approved: 'success', rejected: 'danger', purchased: 'info', revoked: 'info' }
  return types[status] || 'info'
}

const getStatusText = (status) => {
  const texts = { pending: '待审批', approved: '已通过', rejected: '已拒绝', purchased: '已采购', revoked: '已撤销' }
  return texts[status] || status
}

const handleAllocateStore = (row, index) => {
  if (toNumber(row.quantity) <= 0) {
    ElMessage.warning('请先输入商品数量')
    return
  }
  
  const product = products.value.find(p => p.product_id === row.productId)
  currentAllocateProduct.value = {
    ...row,
    productName: product?.name || ''
  }
  currentAllocateIndex.value = index
  
  storeAllocationList.value = allStores.value.map(store => {
    const existing = row.storeAllocations?.find(a => a.storeId === store.store_id)
    return {
      storeId: store.store_id,
      storeName: store.name,
      quantity: toNumber(existing?.quantity)
    }
  })
  
  allocateDialogVisible.value = true
}

const validateAllocation = () => {
  if (allocatedTotalQuantity.value > toNumber(currentAllocateProduct.value?.quantity)) {
    ElMessage.warning('分配数量不能超过总数量')
  }
}

const handleSaveAllocation = () => {
  const totalAllocated = allocatedTotalQuantity.value
  const totalQuantity = toNumber(currentAllocateProduct.value?.quantity)
  
  if (totalAllocated > totalQuantity) {
    ElMessage.warning('分配数量不能超过总数量')
    return
  }
  
  const validAllocations = storeAllocationList.value
    .map(a => ({ ...a, quantity: toNumber(a.quantity) }))
    .filter(a => a.quantity > 0)
  
  if (currentAllocateIndex.value >= 0) {
    requestForm.items[currentAllocateIndex.value].storeAllocations = validAllocations
  }
  
  ElMessage.success('分配成功')
  allocateDialogVisible.value = false
}

const handleAllocateDialogClose = () => {
  currentAllocateProduct.value = null
  currentAllocateIndex.value = -1
  storeAllocationList.value = []
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
.ml-10 {
  margin-left: 10px;
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
.no-spinner :deep(input[type='number'])::-webkit-inner-spin-button,
.no-spinner :deep(input[type='number'])::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.no-spinner :deep(input[type='number']) {
  -moz-appearance: textfield;
}
</style>
