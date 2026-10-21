<template>
  <el-form-item v-if="paymentMethod === 'PERSONAL_ADVANCE'" label="收款信息"><el-tag>支付至员工账户</el-tag></el-form-item>
  <template v-else>
    <el-form-item v-if="accounts.length > 1" label="收款账户"><el-select :model-value="recipient.accountId" @change="chooseAccount"><el-option v-for="row in accounts" :key="row.account_id" :value="row.account_id" :label="accountText(row)" /></el-select></el-form-item>
    <el-form-item label="付款账号" required><el-input :model-value="paymentText" type="textarea" :rows="4" maxlength="2000" placeholder="填写收款账户名称、开户银行、账号等付款信息" @update:model-value="manualAccount" /></el-form-item>
  </template>
  <el-dialog v-model="searchVisible" title="查询供应商" width="600px" append-to-body>
    <el-input v-model="keyword" placeholder="输入供应商名称查询" clearable />
    <el-table :data="matches" max-height="350" @row-dblclick="chooseSupplier($event.supplier_id)">
      <el-table-column prop="name" label="供应商名称" /><el-table-column label="操作" width="80"><template #default="{ row }"><el-button link type="primary" @click="chooseSupplier(row.supplier_id)">选择</el-button></template></el-table-column>
      <template #empty>未找到供应商，请手工填写付款账号</template>
    </el-table>
  </el-dialog>
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
const emit = defineEmits(['update:recipient', 'update:attachments', 'supplier-selected'])
const suppliers = ref([]), uploading = ref(false)
const searchVisible = ref(false), keyword = ref('')
const matches = computed(() => suppliers.value.filter(row => row.name.toLowerCase().includes(keyword.value.trim().toLowerCase())))
const accounts = computed(() => suppliers.value.find(row => row.supplier_id === props.recipient.supplierId)?.accounts || [])
const set = patch => emit('update:recipient', { ...props.recipient, ...patch })
const accountText = row => [row.company_name, row.bank_name, row.account_number].filter(Boolean).join('\n')
const paymentText = computed(() => props.recipient.paymentText || [props.recipient.payeeName, props.recipient.bankName, props.recipient.accountNumber].filter(Boolean).join('\n'))
function chooseSupplier(id) {
  const supplier = suppliers.value.find(row => row.supplier_id === id)
  if (!supplier) return
  const row = supplier.accounts?.[0]
  emit('update:recipient', { source: 'SUPPLIER', supplierId: id, accountId: row?.account_id || '', payeeName: row?.company_name || supplier.name, bankName: row?.bank_name || '', accountNumber: row?.account_number || '', paymentText: row ? accountText(row) : '' })
  emit('supplier-selected', supplier.name)
  searchVisible.value = false
  if (!row) ElMessage.info('该供应商暂无收款账户，请手工填写付款账号')
}
function chooseAccount(id) { const row = accounts.value.find(row => row.account_id === id); if (row) set({ accountId: id, payeeName: row.company_name || '', bankName: row.bank_name, accountNumber: row.account_number, paymentText: accountText(row) }) }
function manualAccount(value) { set({ accountId: '', payeeName: '', bankName: '', accountNumber: '', paymentText: value }) }
defineExpose({ search(value) { keyword.value = value || ''; searchVisible.value = true } })
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
