<template>
  <div class="freight-page">
    <el-card>
      <template #header><span>运费管理</span></template>
      <el-tabs v-model="activeTab">
        <el-tab-pane label="运费记录" name="records">
          <div class="filter-row">
            <el-date-picker v-model="filters.dates" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" />
            <el-select v-model="filters.storeId" clearable filterable placeholder="全部门店" style="width: 180px"><el-option v-for="store in stores" :key="store.store_id" :label="store.name" :value="store.store_id" /></el-select>
            <el-select v-model="filters.platformId" clearable placeholder="全部平台" style="width: 160px"><el-option v-for="platform in platforms" :key="platform.platform_id" :label="platform.platform_name" :value="platform.platform_id" /></el-select>
            <el-button type="primary" @click="loadRecords">查询</el-button>
            <el-button @click="resetFilters">重置</el-button>
            <el-button type="success" @click="exportRecords">导出全部记录</el-button>
          </div>
          <el-table :data="records" v-loading="loading" border>
            <el-table-column prop="source_no" label="来源单号" min-width="170" />
            <el-table-column label="来源类型" width="110"><template #default="{ row }">{{ row.source_type === 'purchase' ? '采购申请' : '调拨申请' }}</template></el-table-column>
            <el-table-column prop="platform_name" label="配送平台" width="120" />
            <el-table-column prop="amount" label="运费金额" width="120"><template #default="{ row }">¥{{ money(row.amount) }}</template></el-table-column>
            <el-table-column label="门店" min-width="180"><template #default="{ row }">{{ row.source_type === 'transfer' ? `${row.from_store_name || '-'} → ${row.to_store_name || '-'}` : row.store_name }}</template></el-table-column>
            <el-table-column prop="status" label="状态" width="90"><template #default="{ row }">{{ row.status === 'cancelled' ? '已取消' : row.status === 'draft' ? '草稿' : '生效' }}</template></el-table-column>
            <el-table-column prop="create_user" label="创建人" width="110" />
            <el-table-column prop="create_time" label="创建时间" min-width="170" />
          </el-table>
          <div class="pager"><el-pagination v-model:current-page="page" v-model:page-size="pageSize" :total="total" :page-sizes="[20, 50, 100]" layout="total, sizes, prev, pager, next" @current-change="loadRecords" @size-change="loadRecords" /></div>
        </el-tab-pane>
        <el-tab-pane label="配送平台配置" name="platforms">
          <div class="platform-toolbar"><el-button type="primary" @click="openPlatform()">新增平台</el-button></div>
          <el-table :data="platformsAll" border>
            <el-table-column prop="platform_name" label="平台名称" />
            <el-table-column prop="sort_order" label="排序" width="100" />
            <el-table-column label="状态" width="100"><template #default="{ row }">{{ row.status ? '启用' : '停用' }}</template></el-table-column>
            <el-table-column label="操作" width="180"><template #default="{ row }"><el-button link type="primary" @click="openPlatform(row)">编辑</el-button><el-button v-if="row.status" link type="danger" @click="disablePlatform(row)">停用</el-button></template></el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </el-card>
    <el-dialog v-model="dialogVisible" :title="platformForm.id ? '编辑配送平台' : '新增配送平台'" width="420px">
      <el-form label-width="90px"><el-form-item label="平台名称"><el-input v-model="platformForm.name" maxlength="64" /></el-form-item><el-form-item label="排序"><el-input-number v-model="platformForm.sortOrder" :min="0" :max="999" /></el-form-item><el-form-item label="状态"><el-switch v-model="platformForm.status" /></el-form-item></el-form>
      <template #footer><el-button @click="dialogVisible = false">取消</el-button><el-button type="primary" @click="savePlatform">保存</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'

const activeTab = ref('records')
const loading = ref(false)
const records = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const stores = ref([])
const platforms = ref([])
const platformsAll = ref([])
const filters = reactive({ dates: [], storeId: '', platformId: '' })
const dialogVisible = ref(false)
const platformForm = reactive({ id: '', name: '', sortOrder: 0, status: true })

const money = value => Number(value || 0).toFixed(2)
const queryParams = () => ({ startDate: filters.dates?.[0], endDate: filters.dates?.[1], storeId: filters.storeId || undefined, platformId: filters.platformId || undefined, page: page.value, pageSize: pageSize.value })

async function loadRecords () {
  loading.value = true
  try { const res = await api.getFreightRecords(queryParams()); records.value = res.data?.list || []; total.value = res.data?.total || 0 } finally { loading.value = false }
}
async function loadPlatforms () {
  const [active, all, storeRes] = await Promise.all([api.getFreightPlatforms(), api.getFreightPlatforms({ includeDisabled: 1 }), api.getStoreList({ page: 1, pageSize: 500 })])
  platforms.value = active.data || []; platformsAll.value = all.data || []; stores.value = storeRes.data?.list || []
}
function resetFilters () { filters.dates = []; filters.storeId = ''; filters.platformId = ''; page.value = 1; loadRecords() }
function openPlatform (row = null) { Object.assign(platformForm, { id: row?.platform_id || '', name: row?.platform_name || '', sortOrder: row?.sort_order || 0, status: row ? !!row.status : true }); dialogVisible.value = true }
async function savePlatform () { if (!platformForm.name.trim()) return ElMessage.warning('请输入平台名称'); const data = { platformName: platformForm.name.trim(), sortOrder: platformForm.sortOrder, status: platformForm.status ? 1 : 0 }; platformForm.id ? await api.updateFreightPlatform(platformForm.id, data) : await api.createFreightPlatform(data); ElMessage.success('保存成功'); dialogVisible.value = false; await loadPlatforms(); await loadRecords() }
async function disablePlatform (row) { await ElMessageBox.confirm(`确定停用“${row.platform_name}”？`, '提示', { type: 'warning' }); await api.deleteFreightPlatform(row.platform_id); ElMessage.success('已停用'); await loadPlatforms() }
async function exportRecords () { await api.exportFreightRecords(queryParams()); ElMessage.success('导出成功') }

onMounted(async () => { await loadPlatforms(); await loadRecords() })
</script>

<style scoped>
.filter-row,.platform-toolbar{display:flex;gap:12px;align-items:center;margin-bottom:16px;flex-wrap:wrap}.pager{display:flex;justify-content:flex-end;margin-top:16px}.freight-page{padding:4px}
</style>
