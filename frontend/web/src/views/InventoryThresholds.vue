<template>
  <div class="threshold-page" v-loading="loading">
    <div class="page-heading"><div><div class="breadcrumb">ERP / 库存管理</div><h1>库存经营阈值</h1></div><el-tag type="info">具体阈值数值待确认</el-tag></div>
    <el-alert title="阈值仅用于库存经营分析和看板状态，不改变库存数量、成本或出入库流程。空值表示未配置。" type="info" show-icon :closable="false" />
    <el-card class="threshold-card" shadow="never">
      <template #header><div class="card-header"><span>阈值配置</span><el-button type="primary" :loading="saving" @click="saveAll">保存全部</el-button></div></template>
      <el-table :data="rows" border stripe empty-text="暂无配置，新增一条作用域配置开始管理">
        <el-table-column label="作用域" min-width="150"><template #default="{row}"><el-select v-model="row.scopeType" @change="scopeChanged(row)"><el-option label="全局" value="global" /><el-option label="产品线" value="productLine" /><el-option label="产品" value="product" /><el-option label="门店" value="store" /></el-select></template></el-table-column>
        <el-table-column label="作用域值" min-width="150"><template #default="{row}"><el-input v-model="row.scopeId" :disabled="row.scopeType === 'global'" placeholder="全局自动使用GLOBAL" /></template></el-table-column>
        <el-table-column v-for="field in fields" :key="field.key" :label="field.label" min-width="145"><template #default="{row}"><el-input-number v-model="row[field.key]" :min="0" :max="999999" :precision="4" :controls="false" placeholder="待配置" /></template></el-table-column>
        <el-table-column label="操作" width="90"><template #default="{row}"><el-button link type="danger" @click="removeRow(row)">删除</el-button></template></el-table-column>
      </el-table>
      <el-button class="add-button" plain @click="addRow">新增作用域</el-button>
    </el-card>
  </div>
</template>
<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
const loading = ref(false), saving = ref(false), rows = ref([])
const fields = [
  { key: 'turnoverDays', label: '周转天数预警' },
  { key: 'coverageDays', label: '覆盖天数预警' },
  { key: 'staleAgeDays', label: '库龄预警天数' },
  { key: 'slowMovingQuantity', label: '低动销量上限' },
  { key: 'slowMovingRate', label: '低动销率（%）' }
]
function blank() { return { scopeType: 'global', scopeId: 'GLOBAL', ...Object.fromEntries(fields.map(item => [item.key, null])) } }
function addRow() { rows.value.push(blank()) }
function removeRow(row) { rows.value = rows.value.filter(item => item !== row) }
function scopeChanged(row) { if (row.scopeType === 'global') row.scopeId = 'GLOBAL'; else if (row.scopeId === 'GLOBAL') row.scopeId = '' }
async function load() { loading.value = true; try { const result = await api.getInventoryThresholdConfig(); rows.value = (result.data?.rows || []).map(row => ({ ...row })); } catch (error) { ElMessage.error(error.response?.data?.message || '加载库存阈值失败') } finally { loading.value = false } }
async function saveAll() { saving.value = true; try { for (const row of rows.value) { if (row.scopeType !== 'global' && !String(row.scopeId || '').trim()) throw new Error('非全局配置必须填写作用域值'); await api.saveInventoryThresholdConfig(row) } ElMessage.success('库存阈值已保存'); await load() } catch (error) { ElMessage.error(error.response?.data?.message || error.message || '保存库存阈值失败') } finally { saving.value = false } }
onMounted(load)
</script>
<style scoped>
.threshold-page { padding: 18px; color: #172033; }
.page-heading,.card-header { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.breadcrumb { color:#758298; font-size:13px; margin-bottom:8px; }
h1 { margin:0 0 16px; font-size:24px; }
.threshold-card { margin-top:16px; }
.add-button { margin-top:16px; }
</style>
