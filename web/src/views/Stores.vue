<template>
  <div class="stores-page">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>门店管理</span>
          <el-button type="primary" @click="handleCreate">添加门店</el-button>
        </div>
      </template>

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

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="500px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="80px">
        <el-form-item label="门店名称" prop="name">
          <el-input v-model="form.name" placeholder="请输入门店名称" />
        </el-form-item>
        <el-form-item label="区域" prop="regionName">
          <el-select v-model="form.regionName" placeholder="请选择区域" clearable style="width: 100%">
            <el-option v-for="region in regions" :key="region.region_id" :label="region.name" :value="region.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="联系电话" prop="phone">
          <el-input v-model="form.phone" placeholder="请输入联系电话" />
        </el-form-item>
        <el-form-item label="地址" prop="address">
          <el-input v-model="form.address" placeholder="请输入地址" />
        </el-form-item>
        <el-form-item label="状态" prop="status">
          <el-radio-group v-model="form.status">
            <el-radio :label="1">正常</el-radio>
            <el-radio :label="0">停用</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleSubmit" :loading="submitting">确定</el-button>
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
const dialogTitle = ref('添加门店')
const submitting = ref(false)
const formRef = ref(null)
const isEdit = ref(false)
const editId = ref('')

const form = reactive({
  name: '',
  regionName: '',
  phone: '',
  address: '',
  status: 1
})

const rules = {
  name: [{ required: true, message: '请输入门店名称', trigger: 'blur' }]
}

onMounted(async () => {
  await Promise.all([loadData(), loadRegions()])
})

const loadData = async () => {
  try {
    const res = await api.getStoreList()
    if (res.code === 0) {
      tableData.value = res.data || []
    }
  } catch (err) {
    ElMessage.error('加载数据失败')
  }
}

const loadRegions = async () => {
  try {
    const res = await api.getUserRegions ? await api.getUserRegions() : Promise.resolve({ code: 0, data: [] })
    if (res.code === 0) {
      regions.value = res.data || []
    }
  } catch (err) {
    regions.value = []
  }
}

const handleCreate = () => {
  isEdit.value = false
  dialogTitle.value = '添加门店'
  form.name = ''
  form.regionName = ''
  form.phone = ''
  form.address = ''
  form.status = 1
  dialogVisible.value = true
}

const handleEdit = (row) => {
  isEdit.value = true
  editId.value = row.store_id
  dialogTitle.value = '编辑门店'
  form.name = row.name
  form.regionName = row.region_name || ''
  form.phone = row.phone || ''
  form.address = row.address || ''
  form.status = row.status
  dialogVisible.value = true
}

const handleSubmit = async () => {
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  try {
    const res = isEdit.value
      ? await api.updateStore(editId.value, form)
      : await api.createStore(form)

    if (res.code === 0) {
      ElMessage.success(isEdit.value ? '更新成功' : '添加成功')
      dialogVisible.value = false
      loadData()
    } else {
      ElMessage.error(res.message || '操作失败')
    }
  } catch (err) {
    ElMessage.error('操作失败')
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
</style>
