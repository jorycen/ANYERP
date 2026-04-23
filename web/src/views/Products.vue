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
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'

const categories = ref([])
const tableData = ref([])
const total = ref(0)

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

const handleCreate = () => ElMessage.info('新增商品功能开发中')
const handleEdit = (row) => ElMessage.info('编辑商品: ' + row.name)
const handlePnManage = (row) => ElMessage.info('PN管理: ' + row.name)
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
