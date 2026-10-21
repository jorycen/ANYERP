<template>
  <el-form-item v-if="paymentMethod === 'PERSONAL_ADVANCE'" label="收款信息"><el-tag>支付至员工账户</el-tag></el-form-item>
  <template v-else>
    <el-form-item label="收款方来源"><el-select :model-value="recipient.source || 'TEMPORARY'" @change="set({ source: $event, supplierId: '', accountId: '' })"><el-option label="已有供应商" value="SUPPLIER" /><el-option label="费用收款方" value="COUNTERPARTY" /><el-option label="临时收款方" value="TEMPORARY" /></el-select></el-form-item>
    <el-form-item v-if="recipient.source === 'SUPPLIER'" label="供应商"><el-select :model-value="recipient.supplierId" filterable clearable @change="chooseSupplier"><el-option v-for="row in suppliers" :key="row.supplier_id" :value="row.supplier_id" :label="row.name" /></el-select></el-form-item>
    <el-form-item v-if="accounts.length" label="已有收款账户"><el-select :model-value="recipient.accountId" @change="chooseAccount"><el-option v-for="row in accounts" :key="row.account_id" :value="row.account_id" :label="`${row.company_name || ''} ${row.bank_name || ''} ${row.account_number || ''}`" /></el-select></el-form-item>
    <el-form-item label="收款人／账户名称" required><el-input :model-value="recipient.payeeName" @update:model-value="set({ payeeName: $event })" /></el-form-item>
    <el-form-item label="开户银行" required><el-input :model-value="recipient.bankName" @update:model-value="set({ bankName: $event })" /></el-form-item>
    <el-form-item label="银行账号" required><el-input :model-value="recipient.accountNumber" @update:model-value="set({ accountNumber: $event })" /></el-form-item>
    <div class="form-help">可临时修改本单收款信息，不改动供应商档案；手工收款方不自动建档。</div>
  </template>
  <el-form-item label="附件凭证" required>
    <el-upload :auto-upload="false" :show-file-list="false" accept="image/*,.pdf,.xls,.xlsx" :on-change="upload"><el-button :loading="uploading">上传图片、PDF或Excel</el-button></el-upload>
    <div v-for="(file, index) in attachments" :key="index"><el-button link @click="open(file)">{{ file.name || '费用凭证' }}</el-button><el-button link type="danger" @click="$emit('update:attachments', attachments.filter((_, i) => i !== index))">移除</el-button></div>
    <div>至少一份，单个文件不超过10MB</div>
  </el-form-item>
</template>
<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
const props = defineProps({ recipient: { type: Object, default: () => ({}) }, paymentMethod: String, attachments: { type: Array, default: () => [] } })
const emit = defineEmits(['update:recipient', 'update:attachments'])
const suppliers = ref([]), uploading = ref(false)
const accounts = computed(() => suppliers.value.find(row => row.supplier_id === props.recipient.supplierId)?.accounts || [])
const set = patch => emit('update:recipient', { ...props.recipient, ...patch })
function chooseSupplier(id) { set({ supplierId: id, accountId: '', payeeName: suppliers.value.find(row => row.supplier_id === id)?.name || '' }) }
function chooseAccount(id) { const row = accounts.value.find(row => row.account_id === id); if (row) set({ accountId: id, payeeName: row.company_name || props.recipient.payeeName, bankName: row.bank_name, accountNumber: row.account_number }) }
async function upload(file) {
  if (uploading.value) return
  if (file.size > 10 * 1024 * 1024) return ElMessage.warning('单个附件不能超过10MB')
  uploading.value = true
  try { const result = await api.uploadFile(file.raw, 'expense'); const data = result.data || result; emit('update:attachments', [...props.attachments, { url: data.fileId || data.url, name: file.name, size: file.size }]) }
  catch (error) { ElMessage.error(error.response?.data?.message || '上传失败') }
  finally { uploading.value = false }
}
async function open(file) {
  let url = typeof file === 'string' ? file : file.url
  if (url?.startsWith('cloud://')) { const result = await api.resolveCloudFileUrls([url]); url = result.data?.items?.[0]?.url }
  if (url) window.open(url, '_blank', 'noopener')
}
onMounted(async () => { try { const result = await api.getExpenseFormOptions(); suppliers.value = result.data?.suppliers || [] } catch (error) { ElMessage.error('收款方账户加载失败，可手工填写本单收款信息') } })
</script>
