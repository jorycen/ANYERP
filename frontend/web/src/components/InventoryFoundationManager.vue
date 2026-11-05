<template>
  <el-dialog :model-value="modelValue" title="库存基础资料（含已售记录）" width="95%" @update:model-value="$emit('update:modelValue',$event)" @open="search">
    <div class="toolbar"><el-input v-model="query.keyword" placeholder="商品、SN或批次" clearable style="width:260px" @keyup.enter="search" />
      <el-select v-model="query.status" clearable placeholder="全部核实状态" style="width:150px"><el-option label="已确认" value="confirmed" /><el-option label="待确认" value="pending" /><el-option label="资料冲突" value="conflict" /></el-select><el-button @click="search">查询</el-button></div>
    <el-table :data="rows" border v-loading="loading" max-height="500">
      <el-table-column prop="productName" label="商品" min-width="190" show-overflow-tooltip />
      <el-table-column prop="snCode" label="SN" width="170" /><el-table-column prop="batchNo" label="库存周期／导入批次" min-width="150" show-overflow-tooltip />
      <el-table-column label="采购含税属性" width="130"><template #default="{row}">{{ tax(row.invoiceType) }}</template></el-table-column>
      <el-table-column label="实际采购成本" width="125"><template #default="{row}">{{ money(row.purchaseCost) }}</template></el-table-column>
      <el-table-column label="毛利计价方式" width="125"><template #default="{row}">{{ mode(row.costMode) }}</template></el-table-column>
      <el-table-column label="公司定价" width="115"><template #default="{row}">{{ money(row.companyPrice) }}</template></el-table-column>
      <el-table-column label="关联记录" min-width="170"><template #default="{row}"><div v-for="ref in row.references" :key="ref.referenceKey">{{ ref.label }}</div></template></el-table-column>
      <el-table-column label="核实状态" min-width="160"><template #default="{row}">{{ status(row.status) }}<div class="muted">{{ row.reason }}</div></template></el-table-column>
      <el-table-column label="操作" width="180" fixed="right"><template #default="{row}"><el-button link type="primary" @click="edit(row)">修改</el-button><el-button link @click="history(row)">历史</el-button><el-button v-if="row.entityType !== 'sn_cycle'" link @click="openLink(row)">关联批次</el-button></template></el-table-column>
    </el-table>
    <el-pagination v-model:current-page="query.page" :page-size="query.pageSize" :total="total" layout="total, prev, pager, next" @current-change="load" />
    <el-dialog v-model="editing" append-to-body title="修改库存基础资料" width="560px">
      <p>{{ selected?.productName }} {{ selected?.snCode }}</p>
      <el-form label-width="130px"><el-form-item label="采购含税属性"><el-select v-model="form.invoiceType" clearable><el-option label="含税（专票13%）" value="专票13%" /><el-option label="未税（收据）" value="收据" /></el-select></el-form-item>
        <el-form-item label="实际采购成本"><el-input-number v-model="form.purchaseCost" :min="0" :precision="2" /></el-form-item>
        <el-form-item v-if="form.purchaseCost === 0" label="零成本确认"><el-checkbox v-model="form.confirmZero">确认真实采购成本为零</el-checkbox></el-form-item>
        <el-form-item label="毛利计价方式"><el-select v-model="form.costMode" clearable><el-option label="公司定价" value="COMPANY_PRICE" /><el-option label="实际采购价" value="PURCHASE_PRICE" /></el-select></el-form-item>
        <el-form-item label="公司定价"><el-input-number v-model="form.companyPrice" :min="0" :precision="2" /></el-form-item>
        <el-form-item v-if="form.costMode === 'COMPANY_PRICE' && form.companyPrice != null && form.purchaseCost != null && form.companyPrice < form.purchaseCost" label="低于成本确认"><el-checkbox v-model="form.confirmBelowCost">确认公司定价低于采购成本</el-checkbox></el-form-item>
        <el-form-item label="修改依据" required><el-input v-model="form.reason" type="textarea" maxlength="1000" /></el-form-item></el-form>
      <p class="muted">所有关联记录共用本档案。已归档金额保留，历史重算范围需单独核实。</p>
      <template #footer><el-button @click="editing=false">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存</el-button></template>
    </el-dialog>
    <el-dialog v-model="linking" append-to-body title="关联明确的导入批次" width="650px">
      <p>仅在确认属于同一商品、同一实际导入批次后关联。</p>
      <el-form label-width="120px"><el-form-item label="待关联记录"><el-select v-model="link.referenceKey"><el-option v-for="r in selected?.references || []" :key="r.referenceKey" :label="r.label" :value="r.referenceKey" /></el-select></el-form-item>
        <el-form-item label="目标批次"><el-select v-model="link.targetBasisId" filterable style="width:100%"><el-option v-for="r in targets" :key="r.basisId" :value="r.basisId" :label="`${r.batchNo || r.snCode || r.productName} / ${tax(r.invoiceType)} / ${money(r.purchaseCost)}`" /></el-select></el-form-item>
        <el-form-item label="批次确认依据"><el-input v-model="link.reason" type="textarea" maxlength="1000" /></el-form-item></el-form>
      <template #footer><el-button @click="linking=false">取消</el-button><el-button type="primary" :loading="saving" @click="saveLink">确认关联</el-button></template>
    </el-dialog>
    <el-dialog v-model="historyVisible" append-to-body title="基础资料来源与修改记录" width="850px">
      <el-table :data="evidence" border><el-table-column prop="reference" label="来源记录" min-width="170" /><el-table-column label="来源类型" width="120"><template #default="{row}">{{ ({current_sn:'SN库存',import_inventory:'导入库存',sales_snapshot:'历史销售'})[row.source] || row.source }}</template></el-table-column><el-table-column label="含税属性" width="120"><template #default="{row}">{{ tax(row.invoice_type) }}</template></el-table-column><el-table-column label="采购成本" width="120"><template #default="{row}">{{ money(row.purchase_cost) }}</template></el-table-column><el-table-column label="计价方式" width="120"><template #default="{row}">{{ mode(row.cost_mode) }}</template></el-table-column><el-table-column label="公司定价" width="120"><template #default="{row}">{{ money(row.company_price) }}</template></el-table-column></el-table>
      <el-timeline style="margin-top:20px"><el-timeline-item v-for="r in logs" :key="r.log_id" :timestamp="r.create_time">{{ r.actor_name }} {{ r.comment }}</el-timeline-item></el-timeline>
    </el-dialog>
  </el-dialog>
</template>
<script setup>
import {ref,reactive} from 'vue'
import {ElMessage} from 'element-plus'
import api from '../api'
defineProps({modelValue:Boolean});defineEmits(['update:modelValue'])
const query=reactive({page:1,pageSize:30,keyword:'',status:''}),rows=ref([]),total=ref(0),loading=ref(false),saving=ref(false),selected=ref(null),editing=ref(false),historyVisible=ref(false),logs=ref([]),linking=ref(false),targets=ref([])
const form=reactive({}),link=reactive({referenceKey:'',targetBasisId:'',reason:''}),evidence=ref([])
const money=x=>x===null||x===undefined?'待确认':`¥${Number(x).toFixed(2)}`
const tax=x=>x==='专票13%'?'含税（专票13%）':x==='收据'?'未税（收据）':'待确认'
const mode=x=>x==='COMPANY_PRICE'?'公司定价':x==='PURCHASE_PRICE'?'采购价':'待确认'
const status=x=>({confirmed:'已确认',conflict:'资料冲突',pending:'待确认'})[x]||'待确认'
const error=e=>ElMessage.error(e?.response?.data?.message||e.message||'操作失败')
async function load(){loading.value=true;try{const r=await api.getInventoryFoundation(query);rows.value=r.data.list;total.value=r.data.total}catch(e){error(e)}finally{loading.value=false}}
function search(){query.page=1;load()}
function edit(row){selected.value=row;Object.assign(form,{invoiceType:row.invoiceType,costMode:row.costMode,purchaseCost:row.purchaseCost,companyPrice:row.companyPrice,revision:row.revision,confirmZero:false,confirmBelowCost:false,reason:''});editing.value=true}
async function save(){saving.value=true;try{await api.updateInventoryFoundation(selected.value.basisId,{...form,invoiceType:form.invoiceType||null,costMode:form.costMode||null,purchaseCost:form.purchaseCost??null,companyPrice:form.companyPrice??null});editing.value=false;await load();ElMessage.success('基础资料已保存')}catch(e){error(e)}finally{saving.value=false}}
async function history(row){try{evidence.value=row.source?.observations||[];const r=await api.getInventoryFoundationHistory(row.basisId);logs.value=r.data;historyVisible.value=true}catch(e){error(e)}}
async function openLink(row){selected.value=row;Object.assign(link,{referenceKey:row.references[0]?.referenceKey||'',targetBasisId:'',reason:''});try{const r=await api.getInventoryFoundation({productId:row.productId,page:1,pageSize:100});targets.value=r.data.list.filter(x=>x.basisId!==row.basisId&&x.entityType!=='sn_cycle');linking.value=true}catch(e){error(e)}}
async function saveLink(){const target=targets.value.find(x=>x.basisId===link.targetBasisId);if(!target||!link.reason.trim())return ElMessage.warning('请选择目标批次并填写依据');saving.value=true;try{await api.linkInventoryFoundation({...link,sourceBasisId:selected.value.basisId,sourceRevision:selected.value.revision,targetRevision:target.revision});linking.value=false;await load();ElMessage.success('批次已关联')}catch(e){error(e)}finally{saving.value=false}}
</script>
<style scoped>.toolbar{display:flex;gap:10px;margin-bottom:16px}.muted{color:#909399;font-size:12px}.el-pagination{margin-top:16px}</style>
