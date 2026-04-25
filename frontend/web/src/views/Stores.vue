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
          <el-option v-for="r in regions" :key="r" :label="r" :value="r" />
        </el-select>
        <el-button type="primary" @click="loadData">搜索</el-button>
      </div>

      <el-table :data="tableData" stripe border>
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
        <el-table-column label="操作" width="120">
          <template #default="{ row }">
            <el-button link type="primary" @click="handleEdit(row)">编辑</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 新建/编辑门店对话框 -->
    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="500px" @close="handleDialogClose">
      <el-form :model="storeForm" label-width="100px">
        <el-form-item label="门店名称" required>
          <el-input v-model="storeForm.name" placeholder="请输入门店名称" />
        </el-form-item>
        <el-form-item label="区域" required>
          <el-select v-model="storeForm.regionName" placeholder="请选择区域" style="width: 100%">
            <el-option label="成都" value="成都" />
            <el-option label="重庆" value="重庆" />
            <el-option label="其他" value="其他" />
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
        <el-button type="primary" @click="handleSubmit" :loading="submitLoading">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'

const tableData = ref([])
const regions = ref([])
const dialogVisible = ref(false)
const dialogTitle = ref('新增门店')
const submitLoading = ref(false)

const queryParams = reactive({
  keyword: '',
  regionName: ''
})

const storeForm = reactive({
  storeId: null,
  name: '',
  regionName: '',
  phone: '',
  address: '',
  status: 1
})

onMounted(async () => {
  await loadData()
})

const loadData = async () => {
  try {
    const res = await api.getStoreList(queryParams)
    if (res.code === 0) {
      tableData.value = res.data || []
      if (tableData.value.length > 0) {
        const uniqueRegions = [...new Set(tableData.value.map(s => s.region_name).filter(Boolean))]
        regions.value = uniqueRegions
      }
    }
  } catch (err) {
    ElMessage.error('加载数据失败')
  }
}

const handleCreate = () => {
  dialogTitle.value = '新增门店'
  resetForm()
  dialogVisible.value = true
}

const handleEdit = (row) => {
  dialogTitle.value = '编辑门店'
  storeForm.storeId = row.store_id
  storeForm.name = row.name
  storeForm.regionName = row.region_name
  storeForm.phone = row.phone || ''
  storeForm.address = row.address || ''
  storeForm.status = row.status
  dialogVisible.value = true
}

const handleSubmit = async () => {
  if (!storeForm.name) {
    ElMessage.warning('请输入门店名称')
    return
  }
  if (!storeForm.regionName) {
    ElMessage.warning('请选择区域')
    return
  }

  submitLoading.value = true
  try {
    const data = {
      name: storeForm.name,
      regionName: storeForm.regionName,
      phone: storeForm.phone,
      address: storeForm.address,
      status: storeForm.status
    }

    let res
    if (storeForm.storeId) {
      res = await api.updateStore(storeForm.storeId, data)
    } else {
      res = await api.createStore(data)
    }

    if (res.code === 0) {
      ElMessage.success(storeForm.storeId ? '更新成功' : '创建成功')
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
  storeForm.storeId = null
  storeForm.name = ''
  storeForm.regionName = ''
  storeForm.phone = ''
  storeForm.address = ''
  storeForm.status = 1
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
