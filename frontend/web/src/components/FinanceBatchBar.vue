<template>
  <div style="display:flex;gap:12px;align-items:center;margin:12px 0;flex-wrap:wrap">
    <el-button type="primary" :disabled="!rows.length || rows.length > 100" :loading="submitting" @click="submit">批量提交</el-button>
    <el-button :disabled="!rows.length || rows.length > 100" @click="exportSelected">导出勾选单据</el-button>
    <span>已勾选 {{ rows.length }} 单，合计 {{ loading ? '统计中…' : summary == null ? '不可用' : `¥${Number(summary.totalAmount).toFixed(2)}` }}</span>
    <span v-if="rows.length > 100">每批最多100单</span>
  </div>
  <el-dialog v-model="resultVisible" title="批量提交结果" width="680px">
    <el-alert :title="`成功 ${result.successCount} 单，失败 ${result.failedCount} 单`" :closable="false" />
    <el-table :data="result.results || []" border>
      <el-table-column prop="number" label="单号" min-width="180" />
      <el-table-column label="结果" width="80"><template #default="{row}">{{ row.success ? '成功' : '失败' }}</template></el-table-column>
      <el-table-column prop="message" label="说明" min-width="240" />
    </el-table>
  </el-dialog>
</template>
<script setup>
import {ref,watch} from 'vue'
import {ElMessage,ElMessageBox} from 'element-plus'
import api from '../api'
const props=defineProps({kind:String,rows:{type:Array,default:()=>[]},query:{type:Object,default:()=>({})}})
const emit=defineEmits(['submitted'])
const summary=ref({totalAmount:0}),loading=ref(false),submitting=ref(false),resultVisible=ref(false),result=ref({})
let sequence=0
const id=row=>props.kind==='expense'?row.expense_id:row.settlement_id
watch(()=>props.rows,async rows=>{
  const token=++sequence;summary.value=null
  if(!rows.length){summary.value={totalAmount:0};loading.value=false;return}
  loading.value=true
  try{const response=await api.financeSelectionSummary(props.kind,rows.map(id));if(token!==sequence)return;if(response.code!==0)throw Error(response.message);summary.value=response.data}
  catch(error){if(token===sequence)ElMessage.error(error.response?.data?.message||'统计失败，请重新勾选')}
  finally{if(token===sequence)loading.value=false}
})
async function submit(){
  if(submitting.value)return
  try { await ElMessageBox.confirm(`确认提交勾选的 ${props.rows.length} 张单据？将逐单按原流程提交，失败单会显示原因。`,'批量提交',{type:'warning'}) } catch { return }
  submitting.value=true
  const numbers=new Map(props.rows.map(row=>[String(id(row)),row.expense_no||row.settlement_no]))
  try{
    const response=await api.financeBatchSubmit(props.kind,props.rows.map(id))
    if(response.code!==0)throw Error(response.message)
    result.value={...response.data,results:response.data.results.map(row=>({...row,number:numbers.get(row.id)||row.id}))}
    resultVisible.value=true;emit('submitted')
  }catch(error){ElMessage.error(error.response?.data?.message||error.message||'批量提交失败')}
  finally{submitting.value=false}
}
async function exportSelected(){
  try{await (props.kind==='expense'?api.exportExpenseList:api.exportSettlementList)({ids:props.rows.map(id).join(',')})}
  catch(error){ElMessage.error(error.response?.data?.message||'导出失败')}
}
</script>
