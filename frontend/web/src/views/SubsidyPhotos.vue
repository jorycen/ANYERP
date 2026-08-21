<template>
  <div class="subsidy-photos-page">
    <el-card shadow="never" class="filter-card">
      <el-form :inline="true" @submit.prevent="loadData">
        <el-form-item label="订单日期">
          <el-date-picker
            v-model="dateRange"
            type="daterange"
            value-format="YYYY-MM-DD"
            range-separator="至"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            clearable
          />
        </el-form-item>
        <el-form-item label="门店">
          <el-select v-model="filters.storeId" clearable filterable placeholder="全部门店" :loading="storesLoading" style="width: 180px">
            <el-option v-for="store in stores" :key="store.store_id" :label="store.name" :value="store.store_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="补贴人姓名">
          <el-input v-model="filters.subsidyPerson" clearable placeholder="请输入补贴人姓名" @keyup.enter="loadData" />
        </el-form-item>
        <el-form-item label="补贴人手机号">
          <el-input v-model="filters.subsidyPhone" clearable placeholder="请输入手机号" @keyup.enter="loadData" />
        </el-form-item>
        <el-form-item label="云闪付订单号">
          <el-input v-model="filters.unionpayOrderNo" clearable placeholder="开票信息中的云闪付订单号" @keyup.enter="loadData" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="loading" @click="handleSearch">查询</el-button>
          <el-button @click="resetFilters">重置</el-button>
          <el-button type="primary" plain :loading="batchDownloading" @click="downloadAllPhotos">批量下载查询结果</el-button>
        </el-form-item>
      </el-form>
      <el-progress v-if="batchDownloading" :percentage="downloadProgress ?? 0" :indeterminate="downloadProgress === null" :status="downloadProgress === 100 ? 'success' : undefined" :format="formatDownloadProgress" class="download-progress" />
      <div v-if="batchDownloading" class="download-status">{{ downloadStatus }}</div>
    </el-card>

    <el-card shadow="never" class="result-card">
      <template #header>
        <div class="card-header">
          <span>国补照片</span>
          <span class="result-count">共 {{ total }} 个订单</span>
        </div>
      </template>
      <el-table v-loading="loading" :data="rows" border stripe>
        <el-table-column prop="orderNo" label="订单号" min-width="155" />
        <el-table-column prop="storeName" label="门店" min-width="120" />
        <el-table-column label="订单时间" width="170">
          <template #default="{ row }">{{ formatDate(row.createTime) }}</template>
        </el-table-column>
        <el-table-column prop="subsidyPerson" label="补贴人姓名" width="120" />
        <el-table-column prop="subsidyPhone" label="补贴人手机号" width="140" />
        <el-table-column prop="unionpayOrderNo" label="云闪付订单号" min-width="180" show-overflow-tooltip />
        <el-table-column label="国补照片" min-width="330">
          <template #default="{ row }">
            <div class="photo-list">
              <div v-for="photo in row.photos" :key="photo.id" class="photo-item">
                <el-image
                  v-if="photo.loadState === 'ready' && photo.src"
                  :src="photo.src"
                  :preview-src-list="row.photos.map(item => item.src).filter(Boolean)"
                  fit="contain"
                  class="photo-thumb"
                  @error="handlePhotoError(photo)"
                />
                <button v-else class="photo-state" type="button" @click="retryPhoto(row, photo)">
                  {{ photo.loadState === 'error' ? '加载失败，点击重试' : '加载中' }}
                </button>
                <el-button link type="primary" size="small" @click="downloadPhoto(row, photo)">下载</el-button>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link @click="openReplaceDialog(row)">重新上传</el-button>
          </template>
        </el-table-column>
        <template #empty><el-empty description="暂无国补照片" /></template>
      </el-table>

      <el-pagination
        v-model:current-page="pagination.page"
        v-model:page-size="pagination.pageSize"
        :total="total"
        :page-sizes="[10, 20, 50, 100]"
        layout="total, sizes, prev, pager, next"
        class="pagination"
        @size-change="loadData"
        @current-change="loadData"
      />
    </el-card>

    <el-dialog v-model="replaceDialogVisible" title="重新上传国补照片" width="560px">
      <el-alert
        title="重新上传会替换该订单当前全部国补照片，请确认后再提交。"
        type="warning"
        :closable="false"
        show-icon
        class="replace-alert"
      />
      <div class="replace-order-info">
        订单号：{{ replaceOrder?.orderNo || '-' }}
      </div>
      <el-upload
        v-model:file-list="uploadFiles"
        multiple
        :auto-upload="false"
        accept="image/jpeg,image/png,image/webp"
        list-type="picture"
        :on-change="handleFileChange"
        :on-remove="handleFileChange"
      >
        <el-button type="primary">选择照片</el-button>
        <template #tip>
          <div class="el-upload__tip">支持 JPG、PNG、WEBP，单张不超过 10MB，最多 20 张。</div>
        </template>
      </el-upload>
      <template #footer>
        <el-button @click="replaceDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="replaceLoading" @click="submitReplace">确认替换</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'

const rows = ref([])
const total = ref(0)
const loading = ref(false)
const dateRange = ref([])
const stores = ref([])
const storesLoading = ref(false)
const filters = reactive({ storeId: '', subsidyPerson: '', subsidyPhone: '', unionpayOrderNo: '' })
const pagination = reactive({ page: 1, pageSize: 20 })
const replaceDialogVisible = ref(false)
const replaceLoading = ref(false)
const replaceOrder = ref(null)
const uploadFiles = ref([])
const batchDownloading = ref(false)
const downloadProgress = ref(0)
const downloadStatus = ref('正在准备下载…')
const objectUrls = new Set()

function formatDownloadProgress(percentage) {
  return downloadProgress.value === null ? '正在下载' : `${percentage}%`
}

function formatDate(value) {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false })
}

function normalizeDateValue(value) {
  if (!value) return ''
  if (typeof value === 'string') return value.slice(0, 10)
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function getQueryParams(withPagination = false) {
  const params = {
    storeId: filters.storeId || undefined,
    subsidyPerson: filters.subsidyPerson.trim() || undefined,
    subsidyPhone: filters.subsidyPhone.trim() || undefined,
    unionpayOrderNo: filters.unionpayOrderNo.trim() || undefined,
    startDate: normalizeDateValue(dateRange.value?.[0]) || undefined,
    endDate: normalizeDateValue(dateRange.value?.[1]) || undefined
  }
  if (withPagination) {
    params.page = pagination.page
    params.pageSize = pagination.pageSize
  }
  return params
}

function handleSearch() {
  pagination.page = 1
  loadData()
}

function selectedDateRangeDays() {
  const startDate = normalizeDateValue(dateRange.value?.[0])
  const endDate = normalizeDateValue(dateRange.value?.[1])
  if (!startDate || !endDate) return 0
  const start = new Date(`${startDate}T00:00:00`)
  const end = new Date(`${endDate}T00:00:00`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0
  return Math.floor((end.getTime() - start.getTime()) / 86400000) + 1
}

function revokeObjectUrls() {
  objectUrls.forEach(url => URL.revokeObjectURL(url))
  objectUrls.clear()
}

function getPhotoUrl(photo) {
  const rawUrl = String(photo.url || '').trim()
  return photo.resolvedUrl || photo.accessUrl || (/^cloud:\/\//i.test(rawUrl) ? photo.displayUrl || '' : rawUrl || photo.displayUrl || '')
}

async function loadLocalPhoto(row, photo) {
  photo.loadState = 'loading'
  if (!photo.isLocal) {
    photo.src = getPhotoUrl(photo)
    photo.loadState = photo.src ? 'ready' : 'error'
    return
  }
  try {
    const response = await api.getSubsidyPhotoFile(row.orderId, photo.id)
    const url = URL.createObjectURL(response.data)
    objectUrls.add(url)
    photo.src = url
    photo.loadState = 'ready'
  } catch (_) {
    photo.src = ''
    photo.loadState = 'error'
  }
}

async function resolveCloudPhotoUrls(sourceRows) {
  const photos = sourceRows.flatMap(row => row.photos || [])
  const cloudPhotos = photos.filter(photo => /^cloud:\/\//i.test(String(photo.url || '').trim()))
  if (!cloudPhotos.length) return
  try {
    const response = await api.resolveCloudFileUrls([...new Set(cloudPhotos.map(photo => photo.url))])
    const resolved = new Map((response.data?.items || []).map(item => [item.fileId, item]))
    cloudPhotos.forEach(photo => {
      const item = resolved.get(photo.url)
      photo.resolvedUrl = item?.url || photo.displayUrl || ''
      if (item?.error) photo.loadError = item.error
    })
  } catch (_) {
    cloudPhotos.forEach(photo => { photo.resolvedUrl = photo.displayUrl || '' })
  }
}

async function loadData() {
  loading.value = true
  revokeObjectUrls()
  try {
    const response = await api.getSubsidyPhotos(getQueryParams(true))
    rows.value = (response.data?.list || []).map(row => ({
      ...row,
      photos: (row.photos || []).map(photo => ({ ...photo, src: '', loadState: 'loading' }))
    }))
    total.value = response.data?.pagination?.total || response.data?.total || 0
    await resolveCloudPhotoUrls(rows.value)
    await Promise.all(rows.value.flatMap(row => (row.photos || []).map(photo => loadLocalPhoto(row, photo))))
  } catch (error) {
    ElMessage.error(`加载国补照片失败：${error.message || ''}`)
  } finally {
    loading.value = false
  }
}

async function loadStores() {
  storesLoading.value = true
  try {
    const response = await api.getAllStores()
    stores.value = response.code === 0 && Array.isArray(response.data) ? response.data : []
  } catch (error) {
    stores.value = []
    ElMessage.error(`加载门店列表失败：${error.message || ''}`)
  } finally {
    storesLoading.value = false
  }
}

function resetFilters() {
  dateRange.value = []
  filters.storeId = ''
  filters.subsidyPerson = ''
  filters.subsidyPhone = ''
  filters.unionpayOrderNo = ''
  pagination.page = 1
  loadData()
}

function subsidyPhotoDownloadName(row, photo) {
  if (photo.downloadName) return photo.downloadName
  const safePart = (value, fallback) => String(value || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || fallback
  const originalName = String(photo.name || '国补照片').split(/[\\/]/).pop()
  return `${safePart(row.orderNo || row.orderId, '无订单号')}_${safePart(row.subsidyPerson, '未命名')}_${originalName}`
}

async function downloadPhoto(row, photo) {
  const fileName = subsidyPhotoDownloadName(row, photo)
  try {
    if (!photo.isLocal && getPhotoUrl(photo)) {
      const link = document.createElement('a')
      link.href = getPhotoUrl(photo)
      link.download = fileName
      link.target = '_blank'
      link.rel = 'noopener'
      link.click()
      return
    }
    const response = await api.getSubsidyPhotoFile(row.orderId, photo.id)
    const url = URL.createObjectURL(response.data)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    link.click()
    URL.revokeObjectURL(url)
  } catch (error) {
    ElMessage.error(`下载失败：${error.message || ''}`)
  }
}

function retryPhoto(row, photo) {
  if (/^cloud:\/\//i.test(String(photo.url || '').trim())) {
    api.resolveCloudFileUrls([photo.url])
      .then(response => {
        photo.resolvedUrl = response.data?.items?.[0]?.url || photo.displayUrl || ''
        return loadLocalPhoto(row, photo)
      })
      .catch(() => {
        photo.src = ''
        photo.resolvedUrl = photo.displayUrl || ''
        photo.loadState = photo.resolvedUrl ? 'ready' : 'error'
      })
    return
  }
  loadLocalPhoto(row, photo)
}

function handlePhotoError(photo) {
  photo.src = ''
  photo.loadState = 'error'
}

function hasActiveFilter() {
  return Boolean(
    dateRange.value?.length
    || Object.values(filters).some(value => String(value || '').trim())
  )
}

function subsidyPhotoArchiveFileName() {
  const startDate = normalizeDateValue(dateRange.value?.[0])
  const endDate = normalizeDateValue(dateRange.value?.[1])
  let dateRangeName = '不限时间'
  if (startDate && endDate) dateRangeName = startDate === endDate ? startDate : `${startDate}至${endDate}`
  else if (startDate || endDate) dateRangeName = `${startDate || '不限开始日期'}至${endDate || '不限结束日期'}`
  return `查询结果-国补照片-${dateRangeName}.zip`
}

async function getDownloadErrorMessage(error) {
  const isTimeout = error?.code === 'ECONNABORTED'
    || error?.code === 'ETIMEDOUT'
    || /timeout/i.test(String(error?.message || ''))
  if (isTimeout) return '下载超时，请缩小查询范围，建议将时间范围控制在一周以内后重试'

  const responseData = error?.response?.data
  if (responseData instanceof Blob) {
    try {
      const payload = JSON.parse(await responseData.text())
      if (payload?.message) return payload.message
    } catch (_) {
      // 非 JSON 响应继续使用通用提示。
    }
  }
  return error?.response?.data?.message || error?.message || '下载失败，请缩小查询范围后重试'
}

async function downloadAllPhotos() {
  if (batchDownloading.value) return
  if (!hasActiveFilter()) {
    ElMessage.warning('不支持全量下载，请选择查询条件')
    return
  }
  if (!total.value) {
    ElMessage.info('当前查询没有可下载的国补照片')
    return
  }
  if (selectedDateRangeDays() > 7) {
    ElMessage.warning('当前时间范围超过一周，批量下载可能超时，建议缩小到一周以内')
  }
  batchDownloading.value = true
  downloadProgress.value = 0
  downloadStatus.value = '正在准备下载…'
  try {
    const ticketResponse = await api.createSubsidyPhotosDownloadTicket(getQueryParams())
    const ticket = ticketResponse.data?.ticket
    if (!ticket) throw new Error('下载凭证生成失败，请重试')
    downloadStatus.value = '正在生成压缩文件…'
    downloadProgress.value = null
    const response = await api.downloadSubsidyPhotosArchiveWithProgress(ticket, getQueryParams(), progress => {
      downloadProgress.value = progress
      if (progress !== null) downloadStatus.value = `正在下载压缩文件… ${progress}%`
    })
    const url = URL.createObjectURL(response.data)
    const link = document.createElement('a')
    link.href = url
    link.download = subsidyPhotoArchiveFileName()
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    downloadProgress.value = 100
    downloadStatus.value = '下载完成，文件已保存'
    ElMessage.success('下载完成，文件已保存')
  } catch (error) {
    ElMessage.error(`批量下载失败：${await getDownloadErrorMessage(error)}`)
  } finally {
    batchDownloading.value = false
    setTimeout(() => {
      downloadProgress.value = 0
      downloadStatus.value = ''
    }, 1500)
  }
}

function openReplaceDialog(row) {
  replaceOrder.value = row
  uploadFiles.value = []
  replaceDialogVisible.value = true
}

function handleFileChange(_, files) {
  uploadFiles.value = files.filter(item => item.raw)
}

async function submitReplace() {
  const files = uploadFiles.value.map(item => item.raw).filter(Boolean)
  if (!files.length) {
    ElMessage.warning('请至少选择一张照片')
    return
  }
  const formData = new FormData()
  files.forEach(file => formData.append('files', file))
  replaceLoading.value = true
  try {
    await api.replaceSubsidyPhotos(replaceOrder.value.orderId, formData)
    ElMessage.success('国补照片已更新')
    replaceDialogVisible.value = false
    await loadData()
  } catch (error) {
    ElMessage.error(`更新失败：${error.message || ''}`)
  } finally {
    replaceLoading.value = false
  }
}

onMounted(() => {
  loadData()
  loadStores()
})
onBeforeUnmount(revokeObjectUrls)
</script>

<style scoped>
.subsidy-photos-page { display: flex; flex-direction: column; gap: 16px; }
.filter-card :deep(.el-form-item) { margin-bottom: 0; }
.result-card { min-width: 0; }
.card-header { display: flex; justify-content: space-between; align-items: center; }
.result-count { color: #909399; font-size: 13px; }
.photo-list { display: flex; flex-wrap: wrap; gap: 10px; }
.photo-item { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.photo-thumb { width: 76px; height: 76px; border: 1px solid #ebeef5; border-radius: 4px; background: #f8f9fb; }
.photo-state { display: inline-flex; width: 76px; height: 76px; align-items: center; justify-content: center; padding: 8px; border: 0; color: #909399; background: #f8f9fb; cursor: pointer; text-align: center; }
.photo-state:hover { color: #409eff; }
.pagination { margin-top: 16px; justify-content: flex-end; }
.replace-alert { margin-bottom: 16px; }
.replace-order-info { margin-bottom: 12px; color: #606266; }
.download-progress { margin-top: 12px; max-width: 520px; }
.download-status { margin-top: 6px; color: #606266; font-size: 13px; }
</style>
