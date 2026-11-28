<template>
  <div class="page-container financial-profit-page">
    <el-card shadow="never">
      <template #header><div class="header"><div><strong>公司利润分析</strong><p>销售、退货、政策调整与费用按发生期间核对；月结后保留快照</p></div><div><el-button v-if="canClose" @click="openClose">月结预览</el-button><el-button type="success" :loading="exporting" @click="exportReport">导出全部页签</el-button></div></div></template>
      <el-alert :title="reportNote" type="info" :closable="false" show-icon />
      <div class="filters">
        <el-date-picker v-model="dateRange" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" />
        <el-select v-model="params.storeId" clearable filterable placeholder="门店" style="width:170px"><el-option v-for="store in stores" :key="store.store_id || store.storeId" :label="store.name || store.storeName" :value="store.store_id || store.storeId" /></el-select>
        <el-input v-model="params.orderNo" clearable placeholder="原销售单号" style="width:190px" @keyup.enter="search" />
        <el-select v-model="params.status" clearable placeholder="核算状态" style="width:150px"><el-option v-for="(label,value) in statuses" :key="value" :label="label" :value="value" /></el-select>
        <el-button type="primary" @click="search">查询</el-button><el-button @click="resetFilters">重置</el-button>
      </div>
      <div v-if="periods.length" class="periods"><el-tag v-for="period in periods" :key="period.month" type="success">{{ period.month }} 已月结 · {{ period.closedBy }}</el-tag></div>
      <el-tabs v-model="tab">
        <el-tab-pane label="公司利润汇总" name="summary">
          <div class="summary-grid">
            <div class="metric"><span>全部不含税销售净额（含暂估）</span><strong>{{ money(summary.netRevenue) }}</strong></div>
            <div class="metric"><span>成本完整范围销售净额</span><strong>{{ money(summary.completeRevenue) }}</strong></div>
            <div class="metric"><span>成本完整范围存货成本</span><strong>{{ money(summary.completeBookCost) }}</strong></div>
            <div class="metric"><span>成本完整范围商品毛利</span><strong>{{ money(summary.grossProfit) }}</strong></div>
            <div class="metric"><span>成本完整范围毛利率</span><strong>{{ percent(summary.grossMargin) }}</strong></div>
            <div class="metric"><span>整体商品毛利率</span><strong>{{ percent(summary.overallGrossMargin) }}</strong></div>
            <div class="metric"><span>本期政策调整净额</span><strong>{{ money(summary.policyAdjustment) }}</strong></div>
            <div class="metric"><span>成本费用合计</span><strong>{{ money(summary.operatingExpense) }}</strong></div>
            <div class="metric"><span>依据核实后的经营收益</span><strong>{{ money(summary.operatingProfit) }}</strong></div>
          </div>
          <el-alert :title="`成本完整率 ${percent(summary.costCompleteness)}，待补成本/依据变化 ${summary.pendingOrderCount || 0} 笔，待核算销售净额 ${money(summary.pendingRevenue)}。税务待核实 ${summary.taxPendingCount || 0} 笔，政策待分类 ${summary.policyPendingCount || 0} 笔，费用待核实 ${summary.expenseTaxPendingCount || 0} 笔；另有 ${summary.unperiodizedExpenseCount || 0} 笔费用未设置期间。`" type="warning" :closable="false" />
          <p>已知商品毛利＋政策调整－期间费用：{{ money(summary.estimatedOperatingProfit) }}（未完整核算时仅作参考）。{{ summary.expenseScopeNote }}</p>
          <p>政策冲减已售成本：{{ money(summary.costPolicyAdjustment) }}；其他收入调整：{{ money(summary.otherIncomeAdjustment) }}。</p>
          <p>门店费用：{{ money(summary.storeExpense) }}；产品端费用：{{ money(summary.productExpense) }}；公司未分摊费用：{{ money(summary.companyExpense) }}。</p>
          <p>暂估销项税：{{ money(summary.outputVat) }}；其中已核实：{{ money(summary.confirmedOutputVat) }}。暂估成本分摊进项税：{{ money(summary.deductibleInputVat) }}；其中已核实：{{ money(summary.confirmedInputVat) }}。分摊税额不代表实际申报抵扣金额。</p>
          <el-descriptions title="经营与财务口径对照" :column="3" border><el-descriptions-item label="销售经营毛利（含考核调整）">{{ money(summary.managementSalesGross) }}</el-descriptions-item><el-descriptions-item label="产品端经营毛利">{{ money(summary.managementProductGross) }}</el-descriptions-item><el-descriptions-item label="经营合计">{{ money(summary.managementCombinedGross) }}</el-descriptions-item><el-descriptions-item label="财务商品及政策收益">{{ money(summary.financialComparableGross) }}</el-descriptions-item><el-descriptions-item label="口径差额">{{ money(summary.managementDifference) }}</el-descriptions-item><el-descriptions-item label="对账状态">{{ summary.managementIncomplete ? '存在待核算项目，差额仅供核对' : '可逐项核对差异' }}</el-descriptions-item></el-descriptions>
          <p>对照使用本期间销售/退货对应的冻结经营快照、产品端提货差及外调转移，另计本期间个人考核调整和产品政策分配。差额需核对税额、手续费/运费、政策确认时点及跨期调整；个人考核奖励不自动作为财务费用。内部转移不增加公司收益。</p>
          <p>本表未完整列示财务费用、所得税等全部损益；内部前折、内部外调费及80%/20%考核分配不再叠加到公司收益。费用优先按归属月份（月初）统计，未设置归属月时按费用日期。</p>
          <el-table :data="expenseEntries" border stripe>
            <el-table-column prop="businessDate" label="归属日期" width="115" /><el-table-column prop="expenseType" label="费用类型" min-width="140" />
            <el-table-column label="归属" width="100"><template #default="{row}">{{ ({store:'门店',product:'产品端',company:'公司'})[row.category] }}</template></el-table-column>
            <el-table-column label="原含税金额"><template #default="{row}">{{ money(row.grossCost) }}</template></el-table-column>
            <el-table-column label="成本费用"><template #default="{row}">{{ money(row.bookCost) }}</template></el-table-column>
            <el-table-column label="状态"><template #default="{row}">{{ stateText(row) }}</template></el-table-column>
            <el-table-column label="操作" width="220"><template #default="{row}"><el-button link @click="showReview(row)">{{ row.closed ? '查看月结依据' : '核实依据' }}</el-button><el-button v-if="canReview && row.closed" link @click="openAdjustment(row)">跨期调整</el-button></template></el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane :label="`销售及退货明细（${total}）`" name="sales">
          <el-table :data="rows" border stripe v-loading="loading">
            <el-table-column type="expand"><template #default="{row}"><div class="expanded"><p>事件：{{ row.eventKey }}；{{ row.closed ? '已关账快照' : stateText(row) }}。{{ row.pendingCostReason }}</p><p v-if="row.review">凭据：{{ row.review.invoiceNo || '见核实说明' }}；{{ row.review.evidence }}</p>
              <el-table :data="row.detailItems || []" border size="small"><el-table-column prop="productName" label="商品" /><el-table-column prop="quantity" label="数量" /><el-table-column prop="unitCost" label="冻结采购单价" /><el-table-column prop="costSource" label="成本来源" min-width="170" /><el-table-column prop="grossRevenue" label="含税收入" /><el-table-column prop="bookCost" label="原行暂估存货成本" /></el-table>
              <p>商品行保留原始暂估计算，单据合计采用财务核实值；进项及销项税额以单据核实依据为准。</p></div></template></el-table-column>
            <el-table-column prop="businessDate" label="日期" width="115" /><el-table-column label="类型" width="100"><template #default="{row}">{{ typeText(row.entryType) }}</template></el-table-column>
            <el-table-column prop="entryNo" label="单据" min-width="180" /><el-table-column prop="orderNo" label="原销售单" min-width="180" /><el-table-column prop="storeName" label="门店" min-width="115" />
            <el-table-column label="含税收入" width="130"><template #default="{row}">{{ money(row.grossRevenue) }}</template></el-table-column><el-table-column label="不含税收入" width="130"><template #default="{row}">{{ money(row.netRevenue) }}</template></el-table-column>
            <el-table-column label="存货成本" width="125"><template #default="{row}">{{ money(row.bookCost) }}</template></el-table-column><el-table-column label="商品毛利" width="125"><template #default="{row}">{{ money(row.grossProfit) }}</template></el-table-column>
            <el-table-column label="状态" width="130"><template #default="{row}"><el-tag>{{ stateText(row) }}</el-tag></template></el-table-column>
            <el-table-column label="操作" width="230" fixed="right"><template #default="{row}"><el-button link type="primary" @click="showReview(row)">{{ row.closed ? '月结依据' : '核实/历史' }}</el-button><el-button v-if="canReview && row.closed" link @click="openAdjustment(row)">跨期调整</el-button></template></el-table-column>
          </el-table>
          <el-pagination v-model:current-page="params.page" v-model:page-size="params.pageSize" :total="total" :page-sizes="[20,50,100]" layout="total,sizes,prev,pager,next" @current-change="loadData" @size-change="loadData" />
        </el-tab-pane>
        <el-tab-pane :label="`政策收益调整（${policies.length}）`" name="policies">
          <el-alert title="公司按政策全额核对。已核销后仍需判断冲减已售成本、其他收入、待分摊库存或不计入本期；经营分配金额只作对照，不重复相加。" :closable="false" />
          <el-table :data="policies" border stripe>
            <el-table-column prop="businessDate" label="日期" width="110" /><el-table-column prop="entryNo" label="返利单" min-width="175" /><el-table-column prop="orderNo" label="销售单" min-width="175" />
            <el-table-column label="政策全额"><template #default="{row}">{{ money(row.policyAmount) }}</template></el-table-column><el-table-column label="产品经营分配"><template #default="{row}">{{ money(row.productAllocation) }}</template></el-table-column>
            <el-table-column label="财务分类" min-width="150"><template #default="{row}">{{ treatments[row.review?.treatment] || '待核实' }}</template></el-table-column><el-table-column label="本期政策净损益"><template #default="{row}">{{ money(row.policyImpact) }}</template></el-table-column>
            <el-table-column label="状态" min-width="125"><template #default="{row}">{{ stateText(row) }}</template></el-table-column>
            <el-table-column label="操作" min-width="220"><template #default="{row}"><el-button v-if="row.entryType !== 'policy_pending'" link @click="showReview(row)">{{ row.closed ? '月结依据' : '财务分类' }}</el-button><el-button v-if="row.settlementId" link @click="policyDetail.open(row.settlementId)">政策详情</el-button><el-button v-if="canReview && row.closed" link @click="openAdjustment(row)">跨期调整</el-button></template></el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane label="待核算与差异" name="issues">
          <p>待核算清单（包含当前筛选范围内全部页的待处理项目）</p>
          <el-table :data="issues" border><el-table-column prop="businessDate" label="日期" width="115" /><el-table-column prop="entryNo" label="单号" min-width="175" /><el-table-column label="状态"><template #default="{row}">{{ stateText(row) }}</template></el-table-column><el-table-column prop="pendingCostReason" label="原因/核对方向" min-width="260" /><el-table-column label="操作"><template #default="{row}"><el-button link :disabled="!row.businessDate" @click="showReview(row)">{{ row.businessDate ? "查看/核实" : "先补原费用归属" }}</el-button></template></el-table-column></el-table>
          <p>关账后差异（继续采用原月结值）</p>
          <el-table :data="discrepancies" border><el-table-column prop="businessDate" label="原日期" width="115" /><el-table-column prop="entryNo" label="原单据" min-width="170" /><el-table-column prop="reason" label="差异" min-width="260" /><el-table-column label="处理"><template #default="{row}">{{ row.resolved ? "已登记跨期调整" : "待核实调整" }}</template></el-table-column><el-table-column label="操作"><template #default="{row}"><el-button v-if="canReview && (row.before?.eventKey || row.after?.eventKey)" link @click="openAdjustment(row.after || row.before, row.after?.sourceHash || 'deleted')">在开放月份调整</el-button></template></el-table-column></el-table>
        </el-tab-pane>
      </el-tabs>
    </el-card>
    <RebatePolicyDetail ref="policyDetail" />
    <el-dialog v-model="reviewVisible" :title="`核实依据 · ${selected?.entryNo || ''}`" width="760px" :close-on-click-modal="false">
      <p>原单据日期：{{ selected?.businessDate }}；状态：{{ selected ? stateText(selected) : '' }}</p><p v-if="selected?.pendingCostReason">{{ selected.pendingCostReason }}</p>
      <el-form label-width="155px" :disabled="selected?.sourceEventKey || selected?.closed || !canReview || selected?.entryType === 'adjustment' || selected?.entryType === 'policy_adjustment'">
        <template v-if="selected?.entryType === 'policy'">
          <el-form-item label="财务分类"><el-select v-model="reviewForm.treatment"><el-option v-for="(label,value) in treatments" :key="value" :label="label" :value="value" /></el-select></el-form-item>
          <el-form-item label="本期损益政策金额"><el-input-number v-model="reviewForm.eligibleAmount" :precision="2" :min="0" :max="Math.abs(selected?.policyAmount || 0)" /></el-form-item>
          <el-form-item label="其中税务影响"><el-input-number v-model="reviewForm.taxImpact" :precision="2" :min="0" /></el-form-item><p>其余金额记为待分摊/排除，不在本期重复确认；负向冲回单据填写正数金额，系统沿用原单方向。</p>
        </template>
        <template v-else>
          <el-form-item v-if="selected?.entryType !== 'expense'" label="销项税额（绝对值）"><el-input-number v-model="reviewForm.outputVat" :precision="2" :min="0" /></el-form-item>
          <el-form-item label="进项抵扣判断"><el-select v-model="reviewForm.inputTaxMode" placeholder="请根据凭据选择"><el-option label="可抵扣，按凭据分摊" value="deductible" /><el-option label="不可抵扣，计入成本费用" value="non_deductible" /></el-select></el-form-item>
          <el-form-item label="分摊进项税（绝对值）"><el-input-number v-model="reviewForm.inputVat" :precision="2" :min="0" /></el-form-item><p>显示值来自暂估或上次核实，请根据原凭据核对后保存；本操作不等同于税务申报或发票认证。</p>
        </template>
        <el-table v-if="reviewForm.itemTaxes?.length > 1" :data="reviewForm.itemTaxes" border style="margin-bottom:14px"><el-table-column prop="productName" label="商品行" /><el-table-column label="销项税（绝对值）"><template #default="{row}"><el-input-number v-model="row.outputVat" :precision="2" :min="0" :controls="false" @change="sumLineTaxes" /></template></el-table-column><el-table-column label="进项税（绝对值）"><template #default="{row}"><el-input-number v-model="row.inputVat" :precision="2" :min="0" :controls="false" @change="sumLineTaxes" /></template></el-table-column></el-table>
        <el-form-item label="发票/凭据编号（可抵扣时须为系统已登记号码）"><el-input v-model="reviewForm.invoiceNo" maxlength="512" /></el-form-item><el-form-item label="核实依据"><el-input v-model="reviewForm.evidence" type="textarea" maxlength="2000" show-word-limit /></el-form-item><el-form-item label="本次操作原因"><el-input v-model="reviewForm.reason" maxlength="512" /></el-form-item>
      </el-form>
      <el-table :data="history" border max-height="200"><el-table-column prop="create_time" label="时间" /><el-table-column prop="actor_name" label="核实人" /><el-table-column prop="comment" label="原因" /></el-table>
      <template #footer><el-button @click="reviewVisible=false">关闭</el-button><el-button v-if="canReview && !selected?.sourceEventKey && !selected?.closed && !['adjustment','policy_adjustment','policy_pending'].includes(selected?.entryType)" type="primary" :loading="saving" @click="saveReview">保存核实依据</el-button></template>
    </el-dialog>
    <el-dialog v-model="closeVisible" title="全公司月结" width="800px" :close-on-click-modal="false">
      <el-alert title="月结覆盖全部门店及公司费用。核实完成后保存快照，之后通过开放月份的调整记录反映变化。" :closable="false" />
      <el-date-picker v-model="closeMonth" type="month" value-format="YYYY-MM" placeholder="已结束月份" @change="closePreview=null" style="margin:14px 0" /><el-button :loading="saving" @click="previewClose">预览检查</el-button>
      <p v-if="closePreview">待处理项目：{{ closePreview.blockers.length }}；商品毛利：{{ money(closePreview.summary.grossProfit) }}；政策调整：{{ money(closePreview.summary.policyAdjustment) }}；费用：{{ money(closePreview.summary.operatingExpense) }}</p>
      <el-table v-if="closePreview?.blockers.length" :data="closePreview.blockers" border max-height="260"><el-table-column prop="entryNo" label="单据" /><el-table-column prop="status" label="状态" /><el-table-column prop="reason" label="待处理原因" min-width="250" /></el-table>
      <el-input v-model="closeEvidence" type="textarea" placeholder="月结核对依据" style="margin:14px 0" /><el-input v-model="closeReason" placeholder="月结说明" />
      <template #footer><el-button @click="closeVisible=false">关闭</el-button><el-button type="primary" :loading="saving" :disabled="!closePreview || closePreview.blockers.length > 0" @click="confirmClose">确认保存月结快照</el-button></template>
    </el-dialog>
    <el-dialog v-model="adjustVisible" title="开放月份跨期调整" width="730px" :close-on-click-modal="false">
      <p>原事件：{{ selected?.eventKey }}；原期间：{{ selected?.businessDate }}。正数增加该项目，负数减少；冲回通过另一条调整记录留痕。</p>
      <el-form label-width="145px"><el-form-item label="调整日期"><el-date-picker v-model="adjustForm.businessDate" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item v-if="selected?.entryType?.startsWith('policy')" label="政策净损益调整"><el-input-number v-model="adjustForm.policyImpact" :precision="2" /></el-form-item>
        <template v-else><el-form-item v-for="item in adjustmentFields" :key="item.key" :label="item.label"><el-input-number v-model="adjustForm[item.key]" :precision="2" /></el-form-item></template>
        <el-form-item label="原凭据编号"><el-input v-model="adjustForm.invoiceNo" maxlength="512" /></el-form-item><el-form-item label="调整依据"><el-input v-model="adjustForm.evidence" type="textarea" maxlength="2000" /></el-form-item><el-form-item label="调整原因"><el-input v-model="adjustForm.reason" maxlength="512" /></el-form-item></el-form>
      <template #footer><el-button @click="adjustVisible=false">关闭</el-button><el-button type="primary" :loading="saving" @click="saveAdjustment">保存独立调整记录</el-button></template>
    </el-dialog>
  </div>
</template>
<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
import RebatePolicyDetail from '../components/RebatePolicyDetail.vue'
const now = new Date(), localDate = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0,10), monthStart = `${localDate.slice(0,7)}-01`
const issueItems = ref([])
const dateRange = ref([monthStart, localDate]), rows = ref([]), policies = ref([]), expenseEntries = ref([]), discrepancies = ref([]), periods = ref([]), stores = ref([]), total = ref(0), tab = ref('summary')
const loading = ref(false), exporting = ref(false), saving = ref(false), canReview = ref(false), canClose = ref(false), reportNote = ref('加载财务分析口径…'), summary = reactive({}), params = reactive({ storeId:'', orderNo:'', status:'', page:1, pageSize:20 }), policyDetail = ref(null)
const statuses = { period_pending:'待补费用归属', estimated:'税务暂估', cost_pending:'待补成本', source_changed:'依据已变化', confirmed:'已核实', policy_unreviewed:'政策待分类', policy_pending:'政策待核销' }
const treatments = { reduce_cost:'冲减已售商品成本', other_income:'其他收入调整', defer_inventory:'待分摊库存/以后期间', excluded:'不计入本期损益' }
const stateText = row => row.closed ? '已月结' : statuses[row.status] || row.status
const typeText = value => ({sale:'销售',return:'退货',adjustment:'跨期调整',expense:'费用'})[value] || value
const money = value => value === null || value === undefined ? '待核实/不适用' : `¥${Number(value).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}`
const percent = value => value === null || value === undefined ? '未完整' : `${Number(value).toFixed(2)}%`
const issues = computed(() => issueItems.value)
const requestParams = (withPage=true) => ({startDate:dateRange.value?.[0],endDate:dateRange.value?.[1],storeId:params.storeId,orderNo:params.orderNo,status:params.status,...(withPage?{page:params.page,pageSize:params.pageSize}:{})})
async function loadData() { loading.value=true; try { const res=await api.getFinancialProfitOrders(requestParams()); const data=res.data||{}; rows.value=data.items||[]; issueItems.value=data.issueItems||[]; policies.value=data.policyItems||[]; expenseEntries.value=data.expenseEntries||[]; discrepancies.value=data.discrepancies||[]; periods.value=data.periods||[]; total.value=data.total||0; Object.keys(summary).forEach(key=>delete summary[key]); Object.assign(summary,data.summary||{}); canReview.value=data.canReview; canClose.value=data.canClose; reportNote.value=data.note } catch(error){ ElMessage.error(error.response?.data?.message||'加载失败') } finally {loading.value=false} }
function search(){params.page=1;loadData()}
function resetFilters(){dateRange.value=[monthStart,localDate];Object.assign(params,{storeId:'',orderNo:'',status:'',page:1});loadData()}
async function exportReport(){exporting.value=true;try{await api.exportFinancialProfitOrders(requestParams(false));ElMessage.success('已导出全部页签')}catch(error){ElMessage.error(error.response?.data?.message||'导出失败')}finally{exporting.value=false}}
const reviewVisible=ref(false), selected=ref(null), history=ref([]), reviewForm=reactive({})
async function showReview(row){ selected.value=row; history.value=[]; Object.assign(reviewForm,{treatment:row.review?.treatment||'',eligibleAmount:Math.abs(row.policyAmount||0),taxImpact:row.review?.taxImpact??0,outputVat:Math.abs(row.outputVat||0),inputVat:Math.abs(row.deductibleInputVat||0),itemTaxes:(row.detailItems||[]).map(item=>{const saved=row.review?.itemTaxes?.find(value=>String(value.itemId)===String(item.itemId));return{itemId:item.itemId,productName:item.productName,outputVat:saved?.outputVat??Math.abs(item.outputVat||0),inputVat:saved?.inputVat??Math.abs(item.estimatedInputVat||0)}}),inputTaxMode:row.review?.inputTaxMode||'',invoiceNo:row.review?.invoiceNo||'',evidence:row.review?.evidence||'',reason:''});reviewVisible.value=true;try{const res=await api.getFinancialProfitHistory({eventKey:row.eventKey,businessDate:row.businessDate});history.value=res.data||[]}catch(error){ElMessage.error(error.response?.data?.message||'读取历史失败')} }
function sumLineTaxes(){reviewForm.outputVat=Number(reviewForm.itemTaxes.reduce((n,row)=>n+Number(row.outputVat||0),0).toFixed(2));reviewForm.inputVat=Number(reviewForm.itemTaxes.reduce((n,row)=>n+Number(row.inputVat||0),0).toFixed(2))}
async function saveReview(){if(!selected.value)return;saving.value=true;try{await api.confirmFinancialProfit({...reviewForm,eventKey:selected.value.eventKey,businessDate:selected.value.businessDate,storeId:selected.value.storeId||selected.value.scopeStoreIds?.[0],sourceHash:selected.value.sourceHash,expectedRevision:selected.value.reviewRevision||0});reviewVisible.value=false;await loadData();ElMessage.success('核实依据已保存')}catch(error){ElMessage.error(error.response?.data?.message||'保存失败')}finally{saving.value=false}}
const closeVisible=ref(false), closeMonth=ref(''), closePreview=ref(null), closeReason=ref(''), closeEvidence=ref('')
function openClose(){const last=new Date(now.getFullYear(),now.getMonth()-1,1);closeMonth.value=`${last.getFullYear()}-${String(last.getMonth()+1).padStart(2,'0')}`;closePreview.value=null;closeReason.value='';closeEvidence.value='';closeVisible.value=true}
async function previewClose(){saving.value=true;closePreview.value=null;try{const res=await api.previewFinancialProfitClose({month:closeMonth.value});closePreview.value=res.data}catch(error){ElMessage.error(error.response?.data?.message||'月结检查失败')}finally{saving.value=false}}
async function confirmClose(){saving.value=true;try{await api.closeFinancialProfit({month:closeMonth.value,previewHash:closePreview.value.previewHash,reason:closeReason.value,evidence:closeEvidence.value});closeVisible.value=false;await loadData();ElMessage.success('月结快照已保存')}catch(error){closePreview.value=null;ElMessage.error(error.response?.data?.message||'月结失败，请重新预览')}finally{saving.value=false}}
const adjustVisible=ref(false), adjustForm=reactive({})
const adjustmentFields=computed(()=>[{key:'grossRevenue',label:'含税收入调整'},{key:'outputVat',label:'销项税调整'},{key:'grossCost',label:'含税成本/费用调整'},{key:'inputVat',label:'分摊进项税调整'}].filter(row=>selected.value?.entryType!=='expense'||['grossCost','inputVat'].includes(row.key)))
function openAdjustment(row,observedHash=null){selected.value=row;Object.assign(adjustForm,{businessDate:localDate,grossRevenue:0,grossCost:0,outputVat:0,inputVat:0,policyImpact:0,invoiceNo:'',evidence:'',reason:'',observedHash,requestKey:crypto.randomUUID()});adjustVisible.value=true}
async function saveAdjustment(){saving.value=true;try{await api.createFinancialProfitAdjustment({...adjustForm,sourceEventKey:selected.value.eventKey,sourceDate:selected.value.businessDate,storeId:selected.value.storeId||selected.value.scopeStoreIds?.[0]});adjustVisible.value=false;await loadData();ElMessage.success('跨期调整已保存')}catch(error){ElMessage.error(error.response?.data?.message||'调整失败')}finally{saving.value=false}}
onMounted(async()=>{try{const res=await api.getReadableStoreList();stores.value=res.data?.list||res.data||[]}catch(_){}await loadData()})
</script>
<style scoped>
.page-container{padding:20px}.header{display:flex;align-items:center;justify-content:space-between}.header strong{font-size:20px}.header p{font-size:13px;color:#777}.filters{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}.summary-grid{display:grid;grid-template-columns:repeat(3,minmax(180px,1fr));gap:12px;margin:16px 0}.metric{padding:16px;border:1px solid #ebeef5;border-radius:6px}.metric span{display:block;color:#777;font-size:13px;margin-bottom:8px}.metric strong{font-size:21px}.expanded{padding:12px 24px}.periods{display:flex;gap:8px;margin-bottom:12px}.el-pagination{margin-top:16px}p{line-height:1.65;font-size:13px}@media(max-width:900px){.summary-grid{grid-template-columns:repeat(2,minmax(140px,1fr))}}
</style>
