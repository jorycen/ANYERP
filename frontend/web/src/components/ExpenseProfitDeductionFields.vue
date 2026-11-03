<template>
  <el-alert title="费用审批全部通过后扣减指定月份个人毛利，不产生待付款；已关账月份不可抵扣。" type="info" :closable="false" />
  <el-alert v-if="error" :title="error" type="warning" :closable="false" style="margin-top:10px" />
  <el-form-item label="抵扣月份" required><el-date-picker :model-value="modelValue.performanceMonth" type="month" value-format="YYYY-MM" @update:model-value="patch({performanceMonth:$event})" /></el-form-item>
  <el-form-item label="分摊方式"><el-radio-group :model-value="modelValue.method || 'MANUAL'" @update:model-value="patch({method:$event})"><el-radio value="MANUAL">按金额</el-radio><el-radio value="AVERAGE">平均分摊</el-radio></el-radio-group></el-form-item>
  <el-form-item label="抵扣人员" required>
    <div style="width:100%" v-loading="loading">
      <div v-for="(row,index) in rows" :key="index" style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">
        <el-select v-model="row.staffId" filterable placeholder="选择人员" style="width:180px" @change="patch({allocations:rows})"><el-option v-for="staff in employees" :key="staff.staffId" :value="staff.staffId" :label="staff.name" /></el-select>
        <el-input-number v-if="modelValue.method !== 'AVERAGE'" v-model="row.amount" :min="0.01" :precision="2" style="width:140px" @change="patch({allocations:rows})" />
        <span v-else>{{ preview?.allocations?.find(item=>item.staffId===row.staffId)?.amount ?? '待测算' }}</span>
        <el-button link type="danger" @click="patch({allocations:rows.filter((_,i)=>i!==index)})">移除</el-button>
      </div>
      <el-button link type="primary" @click="patch({allocations:[...rows,{staffId:'',amount:null}]})">增加人员</el-button>
      <el-button link :disabled="!employees.length" @click="patch({allocations:employees.map(s=>({staffId:s.staffId,amount:null})),method:'AVERAGE'})">选择全部并平均分摊</el-button>
      <div v-if="preview">已分摊 ¥{{preview.totalAmount}}；费用总额 ¥{{preview.expenseAmount}}；剩余 ¥{{preview.remainingAmount}}</div>
    </div>
  </el-form-item>
</template>
<script setup>
import {computed,ref,watch,onBeforeUnmount} from 'vue'
import api from '../api'
const props=defineProps({modelValue:{type:Object,default:()=>({})},storeId:String,amount:[Number,String]})
const emit=defineEmits(['update:modelValue'])
const employees=ref([]),loading=ref(false),error=ref(''),preview=ref(null)
const rows=computed(()=>props.modelValue.allocations || [])
const patch=value=>emit('update:modelValue',{...props.modelValue,...value})
let optionsSequence=0,previewSequence=0,timer
watch(()=>props.storeId,async(storeId,previous)=>{
 const sequence=++optionsSequence;employees.value=[];preview.value=null
 if(previous && previous!==storeId)patch({allocations:[]})
 if(!storeId){loading.value=false;error.value='请先选择费用门店';return}
 loading.value=true
 try{const res=await api.getExpenseDeductionOptions(storeId);if(sequence!==optionsSequence)return;employees.value=res.data.employees;error.value='';if(!props.modelValue.performanceMonth)patch({performanceMonth:res.data.currentMonth})}
 catch(e){if(sequence===optionsSequence)error.value=e.response?.data?.message || e.message}
 finally{if(sequence===optionsSequence)loading.value=false}
},{immediate:true})
watch(()=>[props.storeId,props.amount,props.modelValue],()=>{
 clearTimeout(timer);const sequence=++previewSequence;preview.value=null
 if(!props.storeId||!rows.value.length||rows.value.some(r=>!r.staffId)||!(Number(props.amount)>0))return
 timer=setTimeout(async()=>{try{const res=await api.previewExpenseDeduction({storeId:props.storeId,amount:props.amount,profitDeduction:props.modelValue});if(sequence===previewSequence){preview.value=res.data;error.value=''}}catch(e){if(sequence===previewSequence)error.value=e.response?.data?.message || e.message}},250)
},{deep:true,immediate:true})
onBeforeUnmount(()=>{clearTimeout(timer);optionsSequence++;previewSequence++})
</script>
