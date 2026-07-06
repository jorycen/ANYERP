<template>
  <div class="resource-rights">
    <el-tabs v-model="tab" @tab-change="loadActive">
      <el-tab-pane v-if="!financeOnly" label="SN权益" name="rights">
        <div class="filter-bar">
          <el-input v-model="rightsQuery.snCode" placeholder="SN码" clearable style="width:220px" />
          <el-select v-model="rightsQuery.resourceType" placeholder="权益类型" clearable style="width:150px">
            <el-option v-for="item in resourceOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-select v-model="rightsQuery.status" placeholder="状态" clearable style="width:130px">
            <el-option v-for="item in statusOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-button type="primary" @click="loadRights">查询</el-button>
          <el-button @click="openBySn">初始化/维护SN权益</el-button>
          <el-button @click="openBatchAdjust">批量调整权益</el-button>
        </div>
        <el-table :data="rights" border stripe v-loading="loading">
          <el-table-column prop="sn_code" label="SN" min-width="170" />
          <el-table-column label="商品" min-width="180"><template #default="{row}">{{ row.Product?.name || row.product_id }}</template></el-table-column>
          <el-table-column label="权益" width="120"><template #default="{row}">{{ resourceText(row.resource_type) }}</template></el-table-column>
          <el-table-column label="状态" width="110"><template #default="{row}"><el-tag :type="statusType(row.current_status)">{{ statusText(row.current_status) }}</el-tag></template></el-table-column>
          <el-table-column prop="amount" label="确认金额" width="110"><template #default="{row}">¥{{ money(row.amount) }}</template></el-table-column>
          <el-table-column prop="update_time" label="更新时间" width="170" />
          <el-table-column label="操作" width="160" fixed="right"><template #default="{row}">
            <el-button link type="primary" @click="editSn(row.sn_id)">详情/维护</el-button>
            <el-button v-if="row.current_status === 'AVAILABLE'" link type="warning" @click="openClaim(row)">申请套回</el-button>
          </template></el-table-column>
        </el-table>
        <el-pagination v-model:current-page="rightsQuery.page" v-model:page-size="rightsQuery.pageSize" :total="rightsTotal" layout="total, prev, pager, next" @current-change="loadRights" />
      </el-tab-pane>

      <el-tab-pane :label="financeOnly ? '资源套回审批' : '权益变更记录'" name="changes">
        <div class="filter-bar">
          <el-input v-model="changeQuery.snCode" placeholder="SN码" clearable style="width:210px" />
          <el-select v-model="changeQuery.resourceType" placeholder="权益类型" clearable style="width:150px">
            <el-option v-for="item in resourceOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-select v-model="changeQuery.approvalStatus" placeholder="审批状态" clearable style="width:140px">
            <el-option label="待财务审批" value="pending_finance" /><el-option label="已通过" value="approved" /><el-option label="已拒绝" value="rejected" />
          </el-select>
          <el-button type="primary" @click="loadChanges">查询</el-button>
        </div>
        <el-table :data="changes" border stripe v-loading="loading">
          <el-table-column prop="change_order_no" label="变更单号" min-width="190" />
          <el-table-column prop="sn_code" label="SN" min-width="160" />
          <el-table-column label="权益" width="110"><template #default="{row}">{{ resourceText(row.resource_type) }}</template></el-table-column>
          <el-table-column label="状态变化" width="170"><template #default="{row}">{{ statusText(row.before_status) }} → {{ statusText(row.after_status) }}</template></el-table-column>
          <el-table-column prop="change_amount" label="金额" width="100"><template #default="{row}">¥{{ money(row.change_amount) }}</template></el-table-column>
          <el-table-column label="原因" width="130"><template #default="{row}">{{ reasonText(row.change_reason) }}</template></el-table-column>
          <el-table-column label="审批" width="110"><template #default="{row}"><el-tag>{{ approvalText(row.approval_status) }}</el-tag></template></el-table-column>
          <el-table-column prop="applicant_name" label="申请人" width="100" />
          <el-table-column prop="reviewer_name" label="审批人" width="100" />
          <el-table-column prop="create_time" label="时间" width="170" />
          <el-table-column v-if="financeOnly" label="操作" width="130" fixed="right"><template #default="{row}">
            <template v-if="row.approval_status === 'pending_finance'">
              <el-button link type="success" @click="review(row, 'approve')">通过</el-button>
              <el-button link type="danger" @click="review(row, 'reject')">拒绝</el-button>
            </template>
          </template></el-table-column>
        </el-table>
        <el-pagination v-model:current-page="changeQuery.page" v-model:page-size="changeQuery.pageSize" :total="changeTotal" layout="total, prev, pager, next" @current-change="loadChanges" />
      </el-tab-pane>

      <el-tab-pane label="商品资源成本定义" name="costs">
        <div class="filter-bar">
          <el-select v-model="costForm.productId" filterable remote reserve-keyword placeholder="搜索商品" :remote-method="searchProducts" :loading="productLoading" style="width:300px">
            <el-option v-for="item in products" :key="item.product_id" :label="`${item.name} (${item.pn || ''})`" :value="item.product_id" />
          </el-select>
          <el-select v-model="costForm.resourceType" placeholder="权益类型" style="width:150px">
            <el-option v-for="item in resourceOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-select v-model="costForm.supplierId" filterable clearable placeholder="适用供应商" style="width:180px" @change="onCostSupplierChange">
            <el-option v-for="item in suppliers" :key="item.supplier_id" :label="item.name" :value="item.supplier_id" />
          </el-select>
          <el-select v-model="costForm.calculationType" style="width:170px">
            <el-option label="固定金额" value="fixed_amount" />
            <el-option label="按库存成本比例" value="percentage_inventory_cost" />
            <el-option label="按销售金额比例" value="percentage_sale_amount" />
          </el-select>
          <el-input-number v-model="costForm.costAmount" :min="0" :precision="2" />
          <el-date-picker v-model="costForm.effectiveRange" type="daterange" value-format="YYYY-MM-DD" start-placeholder="生效日期" end-placeholder="失效日期" style="width:250px" />
          <el-select v-model="costForm.triggerCondition" style="width:180px">
            <el-option label="销售归档即触发" value="sale_archived" />
            <el-option label="入库后限时售出" value="sold_within_days" />
          </el-select>
          <el-input-number v-if="costForm.triggerCondition === 'sold_within_days'" v-model="costForm.saleWithinDays" :min="1" :precision="0" />
          <el-checkbox v-model="costForm.affectsPerformanceProfit">计入销售者毛利</el-checkbox>
          <el-input-number v-model="costForm.performanceProfitRatio" :min="0" :max="100" :precision="2" />
          <el-input v-model="costForm.remark" placeholder="备注" style="width:220px" />
          <el-button type="primary" @click="saveCost">保存定义</el-button>
          <el-button @click="loadCosts">刷新</el-button>
          <el-button @click="batchRefresh">按规则刷新未售SN</el-button>
        </div>
        <el-alert title="该配置用于采购入库生成SN权益、PO奖励、销售个人Care可用金和可选销售者毛利调整；已归档销售单不会被批量刷新改写。" type="info" :closable="false" style="margin-bottom:12px" />
        <el-table :data="costs" border stripe>
          <el-table-column label="商品" min-width="220"><template #default="{row}">{{ row.Product?.name || row.product_id }}</template></el-table-column>
          <el-table-column label="权益类型" width="140"><template #default="{row}">{{ resourceText(row.resource_type) }}</template></el-table-column>
          <el-table-column prop="supplier_name" label="供应商" min-width="140" />
          <el-table-column label="算法" width="140"><template #default="{row}">{{ calcTypeText(row.calculation_type) }}</template></el-table-column>
          <el-table-column label="定义金额" width="130"><template #default="{row}">¥{{ money(row.cost_amount) }}</template></el-table-column>
          <el-table-column label="有效期" min-width="180"><template #default="{row}">{{ rulePeriodText(row) }}</template></el-table-column>
          <el-table-column label="触发条件" min-width="150"><template #default="{row}">{{ triggerText(row) }}</template></el-table-column>
          <el-table-column label="计入毛利" width="120"><template #default="{row}">{{ row.affects_performance_profit ? `${row.performance_profit_ratio || 100}%` : '否' }}</template></el-table-column>
          <el-table-column prop="remark" label="备注" min-width="180" />
          <el-table-column prop="update_user" label="更新人" width="100" />
          <el-table-column prop="update_time" label="更新时间" width="170" />
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="产品资源成本流水" name="cost-ledger">
        <div class="filter-bar">
          <el-input v-model="ledgerQuery.snCode" placeholder="SN码" clearable style="width:220px" />
          <el-select v-model="ledgerQuery.resourceType" placeholder="权益类型" clearable style="width:150px">
            <el-option v-for="item in resourceOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-button type="primary" @click="loadLedger">查询</el-button>
        </div>
        <el-table :data="ledger" border stripe>
          <el-table-column prop="sn_code" label="SN" min-width="170" />
          <el-table-column label="权益类型" width="140"><template #default="{row}">{{ resourceText(row.resource_type) }}</template></el-table-column>
          <el-table-column label="调整金额" width="120"><template #default="{row}">¥{{ money(row.adjustment_amount) }}</template></el-table-column>
          <el-table-column label="调整前成本" width="130"><template #default="{row}">¥{{ money(row.before_product_cost) }}</template></el-table-column>
          <el-table-column label="调整后成本" width="130"><template #default="{row}">¥{{ money(row.after_product_cost) }}</template></el-table-column>
          <el-table-column label="影响销售成本" width="120"><template #default>否</template></el-table-column>
          <el-table-column prop="source_id" label="来源单ID" min-width="180" />
          <el-table-column prop="operator_name" label="确认人" width="100" />
          <el-table-column prop="create_time" label="确认时间" width="170" />
        </el-table>
        <el-pagination v-model:current-page="ledgerQuery.page" :total="ledgerTotal" layout="total, prev, pager, next" @current-change="loadLedger" />
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="snDialog" title="SN资源权益" width="720px">
      <template v-if="snDetail">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="SN">{{ snDetail.sn?.sn_code }}</el-descriptions-item>
          <el-descriptions-item label="货品销售标签"><el-tag>{{ snDetail.sales_resource_label }}</el-tag></el-descriptions-item>
          <el-descriptions-item label="可用资源">{{ snDetail.available_resource_summary }}</el-descriptions-item>
          <el-descriptions-item label="不可用资源">{{ snDetail.unavailable_resource_summary }}</el-descriptions-item>
        </el-descriptions>
        <el-form label-width="110px" style="margin-top:16px">
          <el-form-item label="税务属性"><el-radio-group v-model="snForm.taxType"><el-radio value="TAX_INCLUDED">含税</el-radio><el-radio value="UNTAXED">未税</el-radio><el-radio value="UNKNOWN">未知</el-radio></el-radio-group></el-form-item>
          <el-form-item label="货源性质"><el-select v-model="snForm.sourceType"><el-option label="正规含税货" value="REGULAR_TAX" /><el-option label="未税货" value="UNTAXED" /><el-option label="渠道资源货" value="CHANNEL_RESOURCE" /><el-option label="活动资源货" value="PROMOTION_RESOURCE" /><el-option label="特价货" value="SPECIAL_PRICE" /><el-option label="其他" value="OTHER" /></el-select></el-form-item>
        </el-form>
        <el-table :data="snForm.rights" border>
          <el-table-column label="权益"><template #default="{row}">{{ resourceText(row.resourceType) }}</template></el-table-column>
          <el-table-column label="状态"><template #default="{row}"><el-select v-model="row.status"><el-option v-for="item in statusOptions.filter(s => s.value !== 'LOCKED')" :key="item.value" :label="item.label" :value="item.value" /></el-select></template></el-table-column>
          <el-table-column label="金额"><template #default="{row}"><el-input-number v-model="row.amount" :min="0" :precision="2" /></template></el-table-column>
          <el-table-column label="备注"><template #default="{row}"><el-input v-model="row.remark" /></template></el-table-column>
        </el-table>
      </template>
      <template #footer><el-button @click="snDialog=false">取消</el-button><el-button type="primary" @click="saveSn">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="claimDialog" title="资源套回申请" width="520px">
      <el-form label-width="110px">
        <el-form-item label="SN">{{ claimForm.snCode }}</el-form-item>
        <el-form-item label="套回资源">{{ resourceText(claimForm.resourceType) }}</el-form-item>
        <el-form-item label="套回金额"><el-input-number v-model="claimForm.amount" :min="0.01" :precision="2" /></el-form-item>
        <el-form-item label="凭证地址"><el-input v-model="claimForm.attachmentUrl" placeholder="附件或凭证地址" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="claimForm.remark" type="textarea" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="claimDialog=false">取消</el-button><el-button type="primary" @click="submitClaim">提交财务审批</el-button></template>
    </el-dialog>

    <el-dialog v-model="batchDialog" title="批量调整SN权益" width="640px">
      <el-alert title="仅调整未销售在库SN的权益状态，已归档销售单不受影响。SN码可用换行、逗号或空格分隔。" type="warning" :closable="false" style="margin-bottom:12px" />
      <el-form label-width="110px">
        <el-form-item label="指定SN">
          <el-input v-model="batchForm.snCodesText" type="textarea" :rows="4" placeholder="留空时按商品筛选全部在库SN" />
        </el-form-item>
        <el-form-item label="商品">
          <el-select v-model="batchForm.productId" filterable remote clearable reserve-keyword placeholder="搜索商品，可选" :remote-method="searchProducts" :loading="productLoading" style="width:100%">
            <el-option v-for="item in products" :key="item.product_id" :label="`${item.name} (${item.product_code || ''})`" :value="item.product_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="权益">
          <el-select v-model="batchForm.resourceTypes" multiple placeholder="选择要调整的权益" style="width:100%">
            <el-option v-for="item in resourceOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="调整为">
          <el-select v-model="batchForm.status" style="width:180px">
            <el-option label="可用" value="AVAILABLE" />
            <el-option label="不适用" value="NOT_APPLICABLE" />
            <el-option label="异常" value="EXCEPTION" />
          </el-select>
        </el-form-item>
        <el-form-item label="金额">
          <el-input-number v-model="batchForm.amount" :min="0" :precision="2" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="batchForm.remark" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="batchDialog=false">取消</el-button>
        <el-button type="primary" @click="submitBatchAdjust">确认调整</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'

const props = defineProps({ financeOnly: { type: Boolean, default: false } })
const tab = ref(props.financeOnly ? 'changes' : 'rights')
const loading = ref(false)
const resourceOptions = ref([])
const statusOptions = [{label:'可用',value:'AVAILABLE'},{label:'已锁定',value:'LOCKED'},{label:'已核销',value:'USED'},{label:'已套回',value:'CLAIMED_BACK'},{label:'不适用',value:'NOT_APPLICABLE'},{label:'异常',value:'EXCEPTION'}]
const rights = ref([]); const rightsTotal = ref(0)
const rightsQuery = reactive({ snCode:'', resourceType:'', status:'', page:1, pageSize:20 })
const changes = ref([]); const changeTotal = ref(0)
const changeQuery = reactive({ snCode:'', resourceType:'', approvalStatus: props.financeOnly ? 'pending_finance' : '', page:1, pageSize:20 })
const costs = ref([]); const products = ref([]); const productLoading = ref(false)
const suppliers = ref([])
const ledger = ref([]); const ledgerTotal = ref(0); const ledgerQuery = reactive({ snCode:'', resourceType:'', page:1, pageSize:20 })
const costForm = reactive({
  productId:'', resourceType:'GOV_SUBSIDY', supplierId:'', supplierName:'',
  costAmount:0, calculationType:'fixed_amount', affectsPerformanceProfit:false,
  performanceProfitRatio:100, effectiveRange:[], triggerCondition:'sale_archived',
  saleWithinDays:30, remark:''
})
const snDialog = ref(false); const snDetail = ref(null); const currentSnId = ref('')
const snForm = reactive({ taxType:'UNKNOWN', sourceType:'OTHER', rights:[] })
const claimDialog = ref(false); const claimForm = reactive({ snId:'', snCode:'', resourceType:'', amount:0, attachmentUrl:'', remark:'' })
const batchDialog = ref(false)
const batchForm = reactive({ snCodesText:'', productId:'', resourceTypes:[], status:'AVAILABLE', amount:0, remark:'' })

const payloadList = res => res.data?.list || res.data || []
const payloadTotal = res => res.data?.pagination?.total || res.data?.total || 0
const money = value => Number(value || 0).toFixed(2)
const resourceText = value => resourceOptions.value.find(item => item.value === value)?.label || value
const statusText = value => statusOptions.find(item => item.value === value)?.label || value
const statusType = value => ({AVAILABLE:'success',LOCKED:'warning',USED:'info',CLAIMED_BACK:'danger',EXCEPTION:'danger'}[value] || '')
const approvalText = value => ({pending_finance:'待财务审批',approved:'已通过',rejected:'已拒绝'}[value] || value)
const reasonText = value => ({SALE_USED:'销售使用',COMPANY_CLAIMED_BACK:'公司套回',ORDER_LOCKED:'订单锁定',ORDER_CANCEL_RELEASE:'订单取消释放',MANUAL_ADJUST:'人工调整',PURCHASE_INBOUND:'采购入库',BATCH_ADJUST:'批量调整',SALE_TRIGGER:'销售触发',SALE_TRIGGER_NOT_ELIGIBLE:'销售未达成条件'}[value] || value)
const calcTypeText = value => ({fixed_amount:'固定金额',percentage_inventory_cost:'库存成本比例',percentage_sale_amount:'销售金额比例'}[value] || value)
const rulePeriodText = row => row.effective_start || row.effective_end ? `${String(row.effective_start || '不限').slice(0,10)} 至 ${String(row.effective_end || '不限').slice(0,10)}` : '长期有效'
const triggerText = row => {
  if(row.trigger_condition !== 'sold_within_days')return '销售归档'
  try{return `入库后 ${JSON.parse(row.rule_config_json || '{}').saleWithinDays || '-'} 天内`}
  catch(e){return '入库后限时售出'}
}

async function loadRights(){ loading.value=true; try{ const res=await api.getResourceRights(rightsQuery); rights.value=payloadList(res); rightsTotal.value=payloadTotal(res) }catch(e){ ElMessage.error(e.response?.data?.message||'加载权益失败') }finally{ loading.value=false } }
async function loadChanges(){ loading.value=true; try{ const res=await api.getResourceRightChanges(changeQuery); changes.value=payloadList(res); changeTotal.value=payloadTotal(res) }catch(e){ ElMessage.error(e.response?.data?.message||'加载变更记录失败') }finally{ loading.value=false } }
async function loadCosts(){ try{ const res=await api.getProductResourceCostConfigs({}); costs.value=res.data || [] }catch(e){ ElMessage.error('加载成本定义失败') } }
async function loadLedger(){ try{const res=await api.getResourceCostAdjustments(ledgerQuery);ledger.value=payloadList(res);ledgerTotal.value=payloadTotal(res)}catch(e){ElMessage.error('加载成本流水失败')} }
function loadActive(name){ if(name==='rights')loadRights(); else if(name==='changes')loadChanges(); else if(name==='cost-ledger')loadLedger(); else loadCosts() }
async function loadCategories(){
  const res=await api.getResourceCategories({activeOnly:1})
  resourceOptions.value=(res.data||[]).map(row=>({label:row.name,value:row.category_code}))
  if(!resourceOptions.value.some(item=>item.value===costForm.resourceType)){
    costForm.resourceType=resourceOptions.value[0]?.value||''
  }
}
async function loadSuppliers(){ try{const res=await api.getSupplierList({page:1,pageSize:500}); suppliers.value=res.data?.list || res.data || []}catch(e){} }
async function openBySn(){
  const { value } = await ElMessageBox.prompt('请输入完整SN码', '初始化/维护SN权益', { inputPattern:/\S+/, inputErrorMessage:'请输入SN码' }).catch(()=>({}))
  if(!value)return
  const res=await api.getSnList({ snCode:value, page:1, pageSize:20 })
  const row=payloadList(res).find(item=>item.sn_code===value) || payloadList(res)[0]
  if(!row)return ElMessage.warning('未找到SN')
  editSn(row.sn_id)
}
async function editSn(snId){
  try{
    const res=await api.getSnResourceRights(snId); const data=res.data; currentSnId.value=snId; snDetail.value=data
    snForm.taxType=data.sn?.tax_type||'UNKNOWN'; snForm.sourceType=data.sn?.source_type||'OTHER'
    snForm.rights=(data.rights||[]).map(row=>({resourceType:row.resource_type,status:row.current_status,amount:Number(row.amount||0),remark:row.remark||''}))
    snDialog.value=true
  }catch(e){ElMessage.error(e.response?.data?.message||'加载SN权益失败')}
}
async function saveSn(){ try{ await api.saveSnResourceRights(currentSnId.value, snForm); ElMessage.success('已保存'); snDialog.value=false; loadRights() }catch(e){ElMessage.error(e.response?.data?.message||'保存失败')} }
function openClaim(row){ Object.assign(claimForm,{snId:row.sn_id,snCode:row.sn_code,resourceType:row.resource_type,amount:Number(row.amount||0),attachmentUrl:'',remark:''}); claimDialog.value=true }
async function submitClaim(){ try{ await api.submitResourceClaim(claimForm); ElMessage.success('已提交财务审批'); claimDialog.value=false; loadRights() }catch(e){ElMessage.error(e.response?.data?.message||'提交失败')} }
async function review(row, action){
  const { value }=await ElMessageBox.prompt(action==='approve'?'确认通过该套回申请？':'请输入拒绝原因', action==='approve'?'审批通过':'审批拒绝', {inputPlaceholder:'审批意见'}).catch(()=>({}))
  if(action==='reject' && !value)return
  try{await api.reviewResourceClaim(row.change_id,{action,comment:value||''});ElMessage.success('审批完成');loadChanges()}catch(e){ElMessage.error(e.response?.data?.message||'审批失败')}
}
async function searchProducts(keyword){ if(!keyword)return; productLoading.value=true; try{const res=await api.searchProduct({keyword,page:1,pageSize:30});products.value=payloadList(res)}finally{productLoading.value=false} }
function onCostSupplierChange(value){ const supplier=suppliers.value.find(item=>item.supplier_id===value); costForm.supplierName=supplier?.name||'' }
async function saveCost(){
  if(!costForm.productId)return ElMessage.warning('请选择商品')
  try{
    await api.saveProductResourceCostConfig({
      productId:costForm.productId, resourceType:costForm.resourceType, supplierId:costForm.supplierId,
      supplierName:costForm.supplierName, costAmount:costForm.costAmount,
      calculationType:costForm.calculationType, calculationValue:costForm.costAmount,
      effectiveStart:costForm.effectiveRange?.[0]||null, effectiveEnd:costForm.effectiveRange?.[1]||null,
      triggerCondition:costForm.triggerCondition,
      ruleConfigJson:costForm.triggerCondition==='sold_within_days'?{saleWithinDays:costForm.saleWithinDays}:null,
      affectsPerformanceProfit:costForm.affectsPerformanceProfit,
      performanceProfitRatio:costForm.performanceProfitRatio, remark:costForm.remark
    })
    ElMessage.success('已保存');loadCosts()
  }catch(e){ElMessage.error(e.response?.data?.message||'保存失败')}
}
async function batchRefresh(){
  if(!costForm.productId)return ElMessage.warning('请选择商品')
  try{
    const res=await api.batchRefreshResourceRights({productId:costForm.productId,resourceTypes:[costForm.resourceType]})
    ElMessage.success(res.message || `已刷新 ${res.affected || 0} 条SN权益`)
    loadRights()
  }catch(e){ElMessage.error(e.response?.data?.message||'刷新失败')}
}
function openBatchAdjust(){
  Object.assign(batchForm,{snCodesText:'',productId:costForm.productId||'',resourceTypes:costForm.resourceType?[costForm.resourceType]:[],status:'AVAILABLE',amount:0,remark:''})
  batchDialog.value=true
}
async function submitBatchAdjust(){
  const snCodes=batchForm.snCodesText.split(/[\s,，;；]+/).map(item=>item.trim()).filter(Boolean)
  if(!snCodes.length && !batchForm.productId)return ElMessage.warning('请填写SN码或选择商品')
  if(!batchForm.resourceTypes.length)return ElMessage.warning('请选择权益')
  try{
    const res=await api.batchAdjustResourceRights({
      snCodes, productId:batchForm.productId, resourceTypes:batchForm.resourceTypes,
      status:batchForm.status, amount:batchForm.amount, remark:batchForm.remark
    })
    ElMessage.success(res.message || `已调整 ${res.affected || 0} 条SN权益`)
    batchDialog.value=false
    loadRights()
  }catch(e){ElMessage.error(e.response?.data?.message||'批量调整失败')}
}

onMounted(async () => { await loadCategories(); loadSuppliers(); loadActive(tab.value) })
</script>

<style scoped>
.filter-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px}.el-pagination{margin-top:14px;justify-content:flex-end}
</style>
