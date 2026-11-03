<template>
  <div style="width:100%">
    <el-alert :closable="false" type="info" title="可新增多个方案，自定义金额和比例。已使用的方案请停用，不要删除或改名。" />
    <div v-for="(plan,index) in modelValue" :key="plan.id || index" style="border:1px solid #dcdfe6;padding:12px;margin-top:12px;border-radius:4px">
      <div style="display:flex;gap:12px;margin-bottom:12px"><el-input v-model="plan.name" placeholder="方案名称，例如59抵100" maxlength="30" /><el-switch v-model="plan.status" :active-value="1" :inactive-value="0" /><el-button type="danger" plain @click="remove(index)">删除方案</el-button></div>
      <el-form-item label="券面额"><el-input-number v-model="plan.rule.faceAmount" :min="0" :precision="2" /><span v-if="kind==='mall'">0表示按实际抵扣</span></el-form-item>
      <el-form-item v-if="kind==='douyin'" label="顾客购券金额"><el-input-number v-model="plan.rule.purchaseAmount" :min="0.01" :precision="2" /></el-form-item>
      <el-form-item label="商场承担比例"><el-input-number v-model="plan.rule.mallRate" :min="0" :max="100" :precision="2" />%（门店承担剩余优惠差额）</el-form-item>
      <el-form-item v-if="kind==='douyin'" label="购券款手续费"><el-input-number v-model="plan.rule.platformRate" :min="0" :max="100" :precision="2" />%</el-form-item>
      <el-form-item label="商场返款账户"><el-select v-model="plan.rule.mallAccountId" clearable filterable><el-option v-for="account in accounts" :key="account.account_id" :value="account.account_id" :label="account.account_name" /></el-select></el-form-item>
      <el-form-item v-if="kind==='douyin'" label="购券返款账户"><el-select v-model="plan.rule.platformAccountId" clearable filterable><el-option v-for="account in accounts" :key="account.account_id" :value="account.account_id" :label="account.account_name" /></el-select></el-form-item>
      <el-form-item label="有效期"><el-date-picker v-model="plan.rule.validFrom" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" /><el-date-picker v-model="plan.rule.validTo" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" /></el-form-item>
    </div>
    <el-button type="primary" plain style="margin-top:12px" @click="add">新增券方案</el-button>
  </div>
</template>
<script setup>
import { ElMessageBox } from 'element-plus'
const props=defineProps({modelValue:{type:Array,default:()=>[]},kind:String,accounts:{type:Array,default:()=>[]}})
const emit=defineEmits(['update:modelValue'])
function add(){emit('update:modelValue',[...props.modelValue,{id:crypto.randomUUID().replaceAll('-',''),name:'',status:1,rule:{faceAmount:0,purchaseAmount:0,mallRate:null,platformRate:0,mallAccountId:'',platformAccountId:'',validFrom:'',validTo:''}}])}
async function remove(index){try{await ElMessageBox.confirm('确认移除此方案？保存时后台会检查是否已被订单使用。','移除方案');emit('update:modelValue',props.modelValue.filter((_,i)=>i!==index))}catch{}}
</script>
