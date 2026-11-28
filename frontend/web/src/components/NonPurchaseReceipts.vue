<template>
  <el-alert title="获赠不生成采购或付款单。拆机回收从小程序订单可用资源发起，审批确认成本后验收入库。无SN商品须设为按公司定价核算。" :closable="false" />
  <p><el-button type="primary" @click="openGift">新增获赠入库</el-button><el-button @click="load">刷新</el-button></p>
  <el-table :data="rows" v-loading="loading" border>
    <el-table-column prop="receipt_no" label="申请单号" min-width="210" />
    <el-table-column label="来源" width="110"><template #default="{row}">{{row.source_type==='GIFT'?'获赠':'拆机回收'}}</template></el-table-column>
    <el-table-column prop="order_no" label="原销售单" min-width="180" />
    <el-table-column label="明细" min-width="260"><template #default="{row}"><div v-for="(item,index) in row.items" :key="index">{{item.productName}} × {{item.quantity}} · SN {{item.snCode||'-'}} · 确认单价 {{item.recoveryUnitCost===null?'待审批':item.recoveryUnitCost}}</div></template></el-table-column>
    <el-table-column prop="statusText" label="状态" width="120" />
    <el-table-column label="操作" width="180"><template #default="{row}"><el-button v-if="row.status==='approved'" link type="primary" :disabled="busy" @click="receive(row)">验收入库</el-button><el-button v-if="['pending','approved'].includes(row.status)" link type="danger" :disabled="busy" @click="cancel(row)">取消</el-button></template></el-table-column>
  </el-table>
  <el-pagination v-model:current-page="page" :total="total" :page-size="20" layout="prev,pager,next,total" @current-change="load" />
  <el-dialog v-model="visible" title="获赠入库申请" width="650px" :close-on-click-modal="false">
    <el-form label-width="110px">
      <el-form-item label="入库门店"><el-select v-model="form.storeId"><el-option v-for="store in stores" :key="store.store_id" :label="store.name" :value="store.store_id" /></el-select></el-form-item>
      <el-form-item label="赠送方及依据"><el-input v-model="form.reason" type="textarea" /></el-form-item>
      <div v-for="(item,index) in form.items" :key="index" style="padding:12px;border:1px solid #eee;margin-bottom:12px">
        <el-form-item label="入库商品"><el-select v-model="item.productId" filterable remote :remote-method="search" placeholder="搜索商品" style="width:100%"><el-option v-for="product in products" :key="product.product_id" :label="product.name" :value="product.product_id" /></el-select></el-form-item>
        <el-form-item label="数量"><el-input-number v-model="item.quantity" :min="1" :max="10000" :precision="0" /></el-form-item>
        <el-form-item label="SN/追溯码"><el-input v-model="item.snCode" placeholder="SN商品逐件填写，数量为1" /></el-form-item>
        <el-button v-if="form.items.length>1" link type="danger" @click="form.items.splice(index,1)">移除此行</el-button>
      </div><el-button @click="form.items.push({productId:'',quantity:1,snCode:''})">增加商品</el-button>
    </el-form>
    <template #footer><el-button :disabled="busy" @click="visible=false">取消</el-button><el-button type="primary" :loading="busy" @click="submit">提交审批</el-button></template>
  </el-dialog>
</template>
<script setup>
import {ref,reactive,onMounted} from 'vue'
import {ElMessage,ElMessageBox} from 'element-plus'
import api from '../api'
const rows=ref([]),total=ref(0),page=ref(1),loading=ref(false),busy=ref(false),visible=ref(false),stores=ref([]),products=ref([])
const form=reactive({storeId:'',reason:'',requestKey:'',items:[]})
const errorMessage=error=>ElMessage.error(error.response?.data?.message||error.message||'操作失败')
async function load(){loading.value=true;try{const res=await api.listNonPurchaseReceipts({page:page.value,pageSize:20});rows.value=res.data.list;total.value=res.data.total}catch(error){errorMessage(error)}finally{loading.value=false}}
async function search(keyword){try{const res=await api.getProductList({keyword,pageSize:30,activeOnly:1});products.value=res.data?.list||res.list||[]}catch(error){errorMessage(error)}}
async function openGift(){try{const res=await api.getStoreList();stores.value=res.data?.list||res.data||res.list||[];Object.assign(form,{storeId:'',reason:'',requestKey:'npr-'+Date.now()+'-'+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2),items:[{productId:'',quantity:1,snCode:''}]});visible.value=true}catch(error){errorMessage(error)}}
async function submit(){busy.value=true;try{await api.createNonPurchaseReceipt({...form,sourceType:'GIFT'});visible.value=false;ElMessage.success('已提交审批');await load()}catch(error){errorMessage(error)}finally{busy.value=false}}
async function receive(row){if(!await ElMessageBox.confirm('请确认实物、数量及SN均已核验，拆机回收入库同时增加原销售经营毛利。','验收入库',{type:'warning'}).then(()=>true).catch(()=>false))return;busy.value=true;try{await api.receiveNonPurchaseReceipt(row.receipt_id,{});ElMessage.success('验收入库完成');await load()}catch(error){errorMessage(error)}finally{busy.value=false}}
async function cancel(row){if(!await ElMessageBox.confirm('确认取消该申请？','取消申请').then(()=>true).catch(()=>false))return;busy.value=true;try{await api.cancelNonPurchaseReceipt(row.receipt_id);await load()}catch(error){errorMessage(error)}finally{busy.value=false}}
onMounted(load)
</script>
