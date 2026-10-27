<template>
  <div class="document-remark-editor">
    <el-input v-model="draft" type="textarea" :rows="3" :maxlength="kind === 'purchase' ? 1000 : 512" show-word-limit :disabled="saving" placeholder="填写单据备注" />
    <el-button type="primary" :loading="saving" :disabled="!documentId || draft === String(value ?? '')" @click="save">保存</el-button>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'

const props = defineProps({
  kind: { type: String, required: true },
  documentId: { type: [String, Number], required: true },
  value: { type: String, default: '' }
})
const emit = defineEmits(['saved'])
const draft = ref('')
const saving = ref(false)
watch(() => [props.documentId, props.value], () => { draft.value = String(props.value ?? '') }, { immediate: true })
async function save() {
  if (saving.value || !props.documentId || !['purchase', 'settlement'].includes(props.kind)) return
  const id = props.documentId
  const kind = props.kind
  saving.value = true
  try {
    const update = kind === 'purchase' ? api.updatePurchaseRequestRemark : api.updateSettlementRemark
    const result = await update(id, { remark: draft.value })
    if (result.code !== 0) throw new Error(result.message || '备注保存失败')
    if (id !== props.documentId || kind !== props.kind) return
    draft.value = String(result.data?.remark ?? '')
    emit('saved', draft.value)
    ElMessage.success(result.message || '备注已保存')
  } catch (error) { ElMessage.error(error.response?.data?.message || error.message || '备注保存失败') }
  finally { saving.value = false }
}
</script>

<style scoped>
.document-remark-editor { display: flex; align-items: flex-start; gap: 12px; width: 100%; }
.document-remark-editor .el-textarea { flex: 1; min-width: 0; }
</style>
