<template>
  <div class="stores-page">
    <el-card>
      <template #header>
        <span>门店管理</span>
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
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'

const tableData = ref([])

onMounted(async () => {
  try {
    const res = await api.getStoreList()
    if (res.code === 0) {
      tableData.value = res.data || []
    }
  } catch (err) {
    ElMessage.error('加载数据失败')
  }
})
</script>

<style scoped>
</style>
