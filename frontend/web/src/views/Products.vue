<template>
  <div class="products-page">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>商品管理</span>
          <el-button type="primary" @click="handleCreate">新增商品</el-button>
        </div>
      </template>

      <div class="filter-bar">
        <el-input v-model="queryParams.keyword" placeholder="商品名称/编码" clearable style="width: 200px" />
        <el-select v-model="queryParams.category" placeholder="商品分类" clearable style="width: 150px">
          <el-option v-for="cat in categories" :key="cat" :label="cat" :value="cat" />
        </el-select>
        <el-button type="primary" @click="loadData">搜索</el-button>
      </div>

      <el-table :data="tableData" stripe border>
        <el-table-column prop="product_code" label="商品编码" width="120" />
        <el-table-column prop="name" label="商品名称" min-width="150" />
        <el-table-column prop="category" label="分类" width="100" />
        <el-table-column prop="unit" label="单位" width="60" />
        <el-table-column prop="standard_price" label="标准售价" width="100">
          <template #default="{ row }">¥{{ row.standard_price }}</template>
        </el-table-column>
        <el-table-column prop="cost_price" label="成本价" width="100">
          <template #default="{ row }">¥{{ row.cost_price }}</template>
        </el-table-column>
        <el-table-column prop="need_sn" label="需要SN" width="80">
          <template #default="{ row }">
            <el-tag :type="row.need_sn ? 'warning' : 'success'" size="small">
              {{ row.need_sn ? '是' : '否' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="80">
          <template #default="{ row }">
            <el-tag :type="row.status === 1 ? 'success' : 'danger'">{{ row.status === 1 ? '启用' : '停用' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150">
          <template #default="{ row }">
            <el-button link type="primary" @click="handleEdit(row)">编辑</el-button>
            <el-button link type="primary" @click="handlePnManage(row)">PN管理</el-button>
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

    <!-- 新建/编辑商品对话框 -->
    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="600px" @close="handleDialogClose">
      <el-form :model="productForm" label-width="100px">
        <el-form-item label="商品名称" required>
          <el-input v-model="productForm.name" placeholder="请输入商品名称" />
        </el-form-item>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="商品编码">
              <el-input v-model="productForm.productCode" placeholder="商品编码" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="商品分类">
              <el-select v-model="productForm.category" placeholder="请选择" style="width: 100%">
                <el-option v-for="cat in categories" :key="cat" :label="cat" :value="cat" />
                <el-option label="其他" value="其他" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="单位">
              <el-input v-model="productForm.unit" placeholder="如: 台, 件, 个" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="需要SN码">
              <el-switch v-model="productForm.needSn" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="标准售价">
              <el-input-number v-model="productForm.standardPrice" :min="0" :precision="2" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="成本价">
              <el-input-number v-model="productForm.costPrice" :min="0" :precision="2" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="商品描述">
          <el-input v-model="productForm.description" type="textarea" rows="3" placeholder="商品描述" />
        </el-form-item>
        <el-form-item label="状态">
          <el-switch v-model="productForm.status" :active-value="1" :inactive-value="0" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleSubmit" :loading="submitLoading">确定</el-button>
      </template>
    </el-dialog>

    <!-- PN管理对话框 -->
    <el-dialog v-model="pnDialogVisible" :title="`PN管理 - ${currentProduct?.name}`" width="700px">
      <div class="filter-bar">
        <el-input v-model="pnQueryParams.keyword" placeholder="PN码/SN码" clearable style="width: 200px" />
        <el-select v-model="pnQueryParams.status" placeholder="状态" clearable style="width: 120px">
          <el-option label="可用" value="available" />
          <el-option label="已使用" value="used" />
          <el-option label="报废" value="scrapped" />
        </el-select>
        <el-button type="primary" @click="loadPnData">搜索</el-button>
      </div>

      <el-table :data="pnTableData" stripe border size="small">
        <el-table-column prop="pn_code" label="PN码" width="150" />
        <el-table-column prop="sn_code" label="SN码" width="180" />
        <el-table-column prop="status" label="状态" width="80">
          <template #default="{ row }">
            <el-tag :type="getPnStatusType(row.status)" size="small">{{ getPnStatusText(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="store_name" label="所在门店" width="120" />
        <el-table-column prop="order_no" label="关联订单" width="150" />
        <el-table-column prop="updated_at" label="更新时间" width="160" />
      </el-table>

      <div class="add-pn-bar">
        <el-button type="primary" size="small" @click="showAddPnForm = !showAddPnForm">添加PN</el-button>
        <div v-if="showAddPnForm" class="add-pn-form">
          <el-input v-model="newPnCode" placeholder="PN码" style="width: 150px; margin-right: 10px" />
          <el-input v-model="newSnCode" placeholder="SN码" style="width: 150px; margin-right: 10px" />
          <el-button type="primary" size="small" @click="handleAddPn">确认添加</el-button>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'

const categories = ref([])
const tableData = ref([])
const total = ref(0)

const dialogVisible = ref(false)
const dialogTitle = ref('新建商品')
const submitLoading = ref(false)
const currentProduct = ref(null)

const productForm = reactive({
  productId: null,
  name: '',
  productCode: '',
  category: '',
  unit: '',
  needSn: false,
  standardPrice: 0,
  costPrice: 0,
  description: '',
  status: 1
})

// PN管理相关
const pnDialogVisible = ref(false)
const pnTableData = ref([])
const showAddPnForm = ref(false)
const newPnCode = ref('')
const newSnCode = ref('')

const pnQueryParams = reactive({
  keyword: '',
  status: '',
  productId: ''
})

const queryParams = reactive({
  page: 1,
  pageSize: 20,
  keyword: '',
  category: ''
})

onMounted(() => {
  loadData()
  loadCategories()
})

const loadData = async () => {
  try {
    const res = await api.getProductList(queryParams)
    if (res.code === 0) {
      tableData.value = res.data?.list || []
      total.value = res.data?.total || 0
    }
  } catch (err) {
    ElMessage.error('加载数据失败')
  }
}

const loadCategories = async () => {
  try {
    const res = await api.getCategory()
    if (res.code === 0) {
      categories.value = res.data || []
    }
  } catch (err) {
    console.error('Failed to load categories')
  }
}

const handleCreate = () => {
  dialogTitle.value = '新建商品'
  resetForm()
  dialogVisible.value = true
}

const handleEdit = (row) => {
  dialogTitle.value = '编辑商品'
  currentProduct.value = row
  productForm.productId = row.product_id
  productForm.name = row.name
  productForm.productCode = row.product_code || ''
  productForm.category = row.category || ''
  productForm.unit = row.unit || ''
  productForm.needSn = !!row.need_sn
  productForm.standardPrice = row.standard_price || 0
  productForm.costPrice = row.cost_price || 0
  productForm.description = row.description || ''
  productForm.status = row.status || 1
  dialogVisible.value = true
}

const handlePnManage = async (row) => {
  currentProduct.value = row
  pnQueryParams.productId = row.product_id
  pnQueryParams.keyword = ''
  pnQueryParams.status = ''
  await loadPnData()
  pnDialogVisible.value = true
}

const loadPnData = async () => {
  try {
    const res = await api.getPnList(pnQueryParams)
    if (res.code === 0) {
      pnTableData.value = res.data?.list || []
    }
  } catch (err) {
    ElMessage.error('加载PN数据失败')
  }
}

const handleAddPn = async () => {
  if (!newPnCode.value) {
    ElMessage.warning('请输入PN码')
    return
  }
  try {
    const res = await api.addPn({
      productId: currentProduct.value.product_id,
      pnCode: newPnCode.value,
      snCode: newSnCode.value
    })
    if (res.code === 0) {
      ElMessage.success('添加成功')
      newPnCode.value = ''
      newSnCode.value = ''
      showAddPnForm.value = false
      loadPnData()
    } else {
      ElMessage.error(res.message || '添加失败')
    }
  } catch (err) {
    ElMessage.error('添加失败')
  }
}

const getPnStatusType = (status) => {
  const types = { available: 'success', used: 'warning', scrapped: 'danger' }
  return types[status] || 'info'
}

const getPnStatusText = (status) => {
  const texts = { available: '可用', used: '已使用', scrapped: '报废' }
  return texts[status] || status
}

const handleDialogClose = () => {
  resetForm()
}

const resetForm = () => {
  productForm.productId = null
  productForm.name = ''
  productForm.productCode = ''
  productForm.category = ''
  productForm.unit = ''
  productForm.needSn = false
  productForm.standardPrice = 0
  productForm.costPrice = 0
  productForm.description = ''
  productForm.status = 1
}

const handleSubmit = async () => {
  if (!productForm.name) {
    ElMessage.warning('请输入商品名称')
    return
  }

  submitLoading.value = true
  try {
    const data = {
      name: productForm.name,
      productCode: productForm.productCode,
      category: productForm.category,
      unit: productForm.unit,
      needSn: productForm.needSn ? 1 : 0,
      standardPrice: productForm.standardPrice,
      costPrice: productForm.costPrice,
      description: productForm.description,
      status: productForm.status
    }

    let res
    if (productForm.productId) {
      res = await api.updateProduct(productForm.productId, data)
    } else {
      res = await api.createProduct(data)
    }

    if (res.code === 0) {
      ElMessage.success(productForm.productId ? '更新成功' : '创建成功')
      dialogVisible.value = false
      loadData()
    } else {
      ElMessage.error(res.message || '操作失败')
    }
  } catch (err) {
    ElMessage.error('操作失败')
  } finally {
    submitLoading.value = false
  }
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
.add-pn-bar {
  margin-top: 16px;
  display: flex;
  align-items: center;
  gap: 12px;
}
.add-pn-form {
  display: flex;
  align-items: center;
}
</style>
