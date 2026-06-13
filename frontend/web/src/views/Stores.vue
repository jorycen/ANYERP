<template>
  <div class="stores-page">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>门店管理</span>
          <el-button type="primary" @click="handleCreate">新增门店</el-button>
        </div>
      </template>

      <div class="filter-bar">
        <el-input v-model="queryParams.keyword" placeholder="门店名称" clearable style="width: 200px" />
        <el-select v-model="queryParams.regionName" placeholder="区域" clearable style="width: 150px">
          <el-option v-for="r in regions" :key="r.region_code" :label="r.name" :value="r.name" />
        </el-select>
        <el-button type="primary" @click="loadData">搜索</el-button>
      </div>

      <el-table :data="tableData" stripe border v-loading="loading">
        <el-table-column prop="store_id" label="门店ID" width="100" />
        <el-table-column prop="name" label="门店名称" min-width="150" />
        <el-table-column prop="region_name" label="区域" width="100" />
        <el-table-column prop="phone" label="联系电话" width="130" />
        <el-table-column prop="address" label="地址" min-width="200" />
        <el-table-column prop="status" label="状态" width="80">
          <template #default="{ row }">
            <el-tag :type="row.status === 1 ? 'success' : 'danger'">{{ row.status === 1 ? '正常' : '停用' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200">
          <template #default="{ row }">
            <el-button link type="primary" @click="handleEdit(row)">编辑</el-button>
            <el-button link type="danger" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 新建/编辑门店对话框 -->
    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="500px" @close="handleDialogClose">
      <el-form :model="storeForm" label-width="100px">
        <el-form-item label="门店ID" required>
          <el-input v-model="storeForm.storeId" :disabled="!!editStoreId" placeholder="请输入门店ID" />
        </el-form-item>
        <el-form-item label="门店名称" required>
          <el-input v-model="storeForm.name" placeholder="请输入门店名称" />
        </el-form-item>
        <el-form-item label="区域" required>
          <el-select v-model="storeForm.regionCode" placeholder="请选择区域" style="width: 100%">
            <el-option v-for="r in regions" :key="r.region_code" :label="r.name" :value="r.region_code" />
          </el-select>
        </el-form-item>
        <el-form-item label="联系电话">
          <el-input v-model="storeForm.phone" placeholder="请输入联系电话" />
        </el-form-item>
        <el-form-item label="地址">
          <el-input v-model="storeForm.address" placeholder="请输入地址" />
        </el-form-item>
        <el-form-item label="状态">
          <el-switch v-model="storeForm.status" :active-value="1" :inactive-value="0" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button v-if="!editStoreId" type="info" @click="saveStoreDraft">保存草稿</el-button>
        <el-button type="primary" @click="handleSubmit" :loading="submitLoading">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'
import { saveDraft, loadDraft, clearDraft, cloneDraft } from '../utils/draft'

const tableData = ref([])
const STORE_DRAFT_KEY = 'store-create'
const loading = ref(false)
const regions = ref([])
const dialogVisible = ref(false)
const dialogTitle = ref('新增门店')
const submitLoading = ref(false)
const editStoreId = ref(null)

const queryParams = reactive({
  keyword: '',
  regionName: ''
})

const storeForm = reactive({
  storeId: null,
  name: '',
  regionCode: '',
  phone: '',
  address: '',
  status: 1
})

onMounted(async () => {
  await loadRegions()
  await loadData()
})

const loadRegions = async () => {
  try {
    const res = await api.getRegionList()
    if (res.code === 0) {
      regions.value = res.data || []
    }
  } catch (err) {
    ElMessage.error('加载区域列表失败')
  }
}

const loadData = async () => {
  loading.value = true
  try {
    const params = { keyword: queryParams.keyword || '', regionName: queryParams.regionName || '', page: 1, pageSize: 100 }
    const res = await api.getStoreList(params)
    if (res && res.code === 0) {
      const list = res.data?.list
      tableData.value = Array.isArray(list) ? list : []
    } else {
      tableData.value = []
    }
  } catch (err) {
    ElMessage.error('加载数据失败')
    tableData.value = []
  } finally {
    loading.value = false
  }
}

const handleCreate = () => {
  dialogTitle.value = '新增门店'
  resetForm()
  restoreStoreDraft()
  dialogVisible.value = true
}

const handleEdit = (row) => {
  dialogTitle.value = '编辑门店'
  editStoreId.value = row.store_id
  storeForm.storeId = row.store_id
  storeForm.name = row.name
  const selectedRegion = regions.value.find(r => r.name === row.region_name)
  storeForm.regionCode = selectedRegion ? selectedRegion.region_code : ''
  storeForm.phone = row.phone || ''
  storeForm.address = row.address || ''
  storeForm.status = row.status
  dialogVisible.value = true
}

const handleDelete = async (row) => {
  try {
    await ElMessageBox.confirm(
      `确定要删除门店「${row.name}」吗？`,
      '删除确认',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    const res = await api.deleteStore(row.store_id)
    if (res.code === 0) {
      ElMessage.success('删除成功')
      loadData()
    } else {
      ElMessage.error(res.message || '删除失败')
    }
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('删除失败')
    }
  }
}

const handleSubmit = async () => {
  if (!storeForm.storeId) {
    ElMessage.warning('请输入门店ID')
    return
  }
  if (!storeForm.name) {
    ElMessage.warning('请输入门店名称')
    return
  }
  if (!storeForm.regionCode) {
    ElMessage.warning('请选择区域')
    return
  }

  submitLoading.value = true
  try {
    const data = {
      storeId: storeForm.storeId,
      name: storeForm.name,
      regionCode: storeForm.regionCode,
      phone: storeForm.phone,
      address: storeForm.address,
      status: storeForm.status
    }

    let res
    if (editStoreId.value) {
      res = await api.updateStore(editStoreId.value, data)
    } else {
      res = await api.createStore(data)
    }

    if (res.code === 0) {
      ElMessage.success(editStoreId.value ? '更新成功' : '创建成功')
      if (!editStoreId.value) {
        clearDraft(STORE_DRAFT_KEY)
      }
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

const handleDialogClose = () => {
  resetForm()
}

const resetForm = () => {
  editStoreId.value = null
  storeForm.storeId = null
  storeForm.name = ''
  storeForm.regionCode = ''
  storeForm.phone = ''
  storeForm.address = ''
  storeForm.status = 1
}

const saveStoreDraft = () => {
  saveDraft(STORE_DRAFT_KEY, cloneDraft(storeForm))
  ElMessage.success('草稿已保存')
}

const restoreStoreDraft = () => {
  const draft = loadDraft(STORE_DRAFT_KEY)
  if (!draft) return
  Object.assign(storeForm, draft)
  ElMessage.success('已恢复上次草稿')
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
</style>
