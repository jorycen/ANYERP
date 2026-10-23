<template>
  <el-dialog v-model="visible" title="返利政策、毛利分配与抵扣记录" width="1100px" :close-on-click-modal="false" destroy-on-close>
    <div v-loading="loading" v-if="data">
      <el-descriptions border :column="3">
        <el-descriptions-item label="待下账单">{{ data.settlement.settlement_no }}</el-descriptions-item>
        <el-descriptions-item label="销售订单">{{ data.order?.orderNo || '未关联销售' }}</el-descriptions-item>
        <el-descriptions-item label="SN">{{ data.settlement.sn_code || '—' }}</el-descriptions-item>
        <el-descriptions-item label="政策全额">{{ amount(data.allocation.policyAmount) }}</el-descriptions-item>
        <el-descriptions-item label="返利池金额">{{ amount(data.settlement.amount) }}</el-descriptions-item>
        <el-descriptions-item label="已核销全额">{{ amount(data.settlement.matched_amount) }}</el-descriptions-item>
        <el-descriptions-item label="个人考核毛利">{{ amount(data.allocation.employeeAmount) }}</el-descriptions-item>
        <el-descriptions-item label="产品分配额">{{ amount(data.allocation.productAmount) }}</el-descriptions-item>
        <el-descriptions-item label="产品已确认净额">{{ amount(data.recognizedProductAmount) }}</el-descriptions-item>
        <el-descriptions-item label="本商品基础提货差">{{ amount(data.baseProductMargin) }}</el-descriptions-item>
        <el-descriptions-item label="本项政策兑现后测算">{{ amount(data.policyExpectedMargin) }}</el-descriptions-item>
        <el-descriptions-item label="产品待实现额">{{ amount(data.expectedProductAmount) }}</el-descriptions-item>
      </el-descriptions>
      <el-alert :title="data.allocation.note" type="info" :closable="false" style="margin:14px 0" />
      <el-tabs>
        <el-tab-pane label="前折依据与收益确认">
          <p>{{ data.pricingEvidenceNote }}。兑现后测算仅含本商品基础提货差与本项政策分配，不作为全订单已实现毛利；取消或退货记录仅供追溯。</p>
          <el-table v-if="data.pricingEvidence.length" :data="data.pricingEvidence" border>
            <el-table-column prop="policy_name" label="政策" min-width="130" />
            <el-table-column prop="original_pickup_price" label="原提货价/件" />
            <el-table-column prop="current_pickup_price_at_sale" label="销售时提货价/件" />
            <el-table-column prop="cost_adjustment_amount" label="原记录调整额" />
            <el-table-column prop="final_sales_settlement_cost" label="调整后计价成本" />
            <el-table-column prop="remark" label="原依据" min-width="180" />
          </el-table>
          <p>核销确认及撤销记录</p>
          <el-table :data="data.income" border>
            <el-table-column prop="business_date" label="发生时间" min-width="170" />
            <el-table-column label="产品端金额"><template #default="{ row }">{{ amount(row.amount) }}</template></el-table-column>
            <el-table-column label="动作"><template #default="{ row }">{{ row.reverses_entry_id ? '撤销确认' : '整笔核销确认' }}</template></el-table-column>
            <el-table-column prop="create_user" label="操作人" />
          </el-table>
          <p>返利上账关联记录（含已撤销）</p>
          <el-table :data="data.allocations" border>
            <el-table-column label="返利上账单"><template #default="{ row }">{{ row.PostingOrder?.posting_no || row.posting_id }}</template></el-table-column>
            <el-table-column prop="amount" label="核销金额" />
            <el-table-column prop="status" label="状态" />
            <el-table-column prop="create_time" label="关联时间" />
          </el-table>
        </el-tab-pane>
        <el-tab-pane label="供应商额度及采购抵扣" name="credit">
          <p>供应商：{{ credit?.supplierName || data.settlement.counterparty_name }}；当前可用额度：{{ amount(credit?.availableBalance) }}</p>
          <el-alert :title="credit?.note || '正在加载额度记录'" type="info" :closable="false" />
          <el-table :data="credit?.purchases || []" border style="margin-top:14px">
            <el-table-column prop="request_no" label="采购单号" min-width="180" />
            <el-table-column prop="total_amount" label="原采购金额" />
            <el-table-column prop="rebate_deduction" label="原额度抵用" />
            <el-table-column prop="actual_total" label="原现金/应付金额" />
            <el-table-column label="状态"><template #default="{ row }">{{ ({ draft: '草稿', pending: '审批中/额度占用', approved: '已审批/采购抵用', rejected: '已驳回', cancelled: '已取消', replaced: '已替换' })[row.status] || row.status }}</template></el-table-column>
          </el-table>
          <p>最近200笔额度流水，退回/恢复及冲销以流水为准</p>
          <el-table :data="credit?.ledger || []" border max-height="260">
            <el-table-column prop="related_no" label="关联单号" min-width="180" />
            <el-table-column label="类型"><template #default="{ row }">{{ row.type === 'credit' ? '增加/恢复额度' : '抵扣/减少额度' }}</template></el-table-column>
            <el-table-column prop="amount" label="金额" />
            <el-table-column prop="remark" label="依据" min-width="230" />
          </el-table>
        </el-tab-pane>
        <el-tab-pane label="开票及税务处理依据">
          <el-alert title="20%为经营分配比例。这里记录财务核实的开票和税务依据，金额独立保存，供后续财务对账使用。" type="info" :closable="false" />
          <el-form label-width="130px" style="margin-top:14px">
            <el-form-item label="开票方式"><el-select v-model="tax.invoiceMode"><el-option v-for="(label, value) in invoiceModes" :key="value" :label="label" :value="value" /></el-select></el-form-item>
            <el-form-item label="处理状态"><el-select v-model="tax.status"><el-option label="待核实" value="pending" /><el-option label="已确认" value="confirmed" /><el-option label="不适用" value="not_applicable" /></el-select></el-form-item>
            <el-form-item label="税务影响金额" v-if="tax.status === 'confirmed'"><el-input-number v-model="tax.impactAmount" :precision="2" :min="0" :max="999999999.99" /></el-form-item>
            <el-form-item label="关联发票编号"><el-input v-model="tax.invoiceNo" maxlength="512" /></el-form-item>
            <el-form-item label="凭据/判断依据"><el-input v-model="tax.evidence" type="textarea" maxlength="2000" show-word-limit /></el-form-item>
            <el-form-item label="本次修改原因"><el-input v-model="reason" maxlength="512" /></el-form-item>
            <el-form-item><el-button type="primary" :loading="saving" @click="saveTax">保存处理依据</el-button></el-form-item>
          </el-form>
          <el-table :data="data.taxHistory" border>
            <el-table-column prop="create_time" label="时间" />
            <el-table-column prop="actor_name" label="操作人" />
            <el-table-column prop="comment" label="修改原因" />
            <el-table-column label="税务影响"><template #default="{ row }">{{ amount(row.detail?.after?.impactAmount) }}</template></el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </div>
  </el-dialog>
</template>
<script setup>
import { reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
const visible = ref(false), loading = ref(false), saving = ref(false), data = ref(null), credit = ref(null), id = ref(''), reason = ref('')
const tax = reactive({ invoiceMode: 'unknown', status: 'pending', impactAmount: undefined, invoiceNo: '', evidence: '' })
const invoiceModes = { unknown: '待核实', no_invoice: '无发票抵扣额度', normal: '正常开票', red_invoice: '红字发票调整' }
const amount = value => value === null || value === undefined ? '未确认/无可验证记录' : `¥${Number(value).toFixed(2)}`
async function load(targetId = id.value) {
  const res = await api.getRebatePolicyDetail(targetId)
  if (targetId !== id.value) return
  data.value = res.data
  Object.assign(tax, { invoiceMode: 'unknown', status: 'pending', impactAmount: undefined, invoiceNo: '', evidence: '' }, data.value.tax || {})
}
async function open(settlementId) {
  id.value = settlementId; visible.value = true; loading.value = true; data.value = null; credit.value = null; reason.value = ''
  const targetId = settlementId
  try { await load(targetId); const res = await api.getRebateCreditUsage(targetId); if (targetId === id.value) credit.value = res.data }
  catch (error) { ElMessage.error(error.response?.data?.message || '加载政策明细失败') }
  finally { loading.value = false }
}
async function saveTax() {
  if (!data.value || reason.value.trim().length < 2) return ElMessage.warning('请填写本次修改原因')
  saving.value = true
  try { await api.saveRebateTaxEvidence(id.value, { ...tax, reason: reason.value }); await load(); reason.value = ''; ElMessage.success('处理依据已保存') }
  catch (error) { ElMessage.error(error.response?.data?.message || '保存失败') }
  finally { saving.value = false }
}
defineExpose({ open })
</script>
