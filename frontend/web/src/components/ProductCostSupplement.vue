<template>
  <el-dialog v-model="visible" title="已售商品采购成本补录" width="1000px" :close-on-click-modal="false" destroy-on-close>
    <p>销售单：{{ settlement?.sourceOrderNo }}　产品端单号：{{ settlement?.entryNo }}</p>
    <el-alert title="按原采购凭据填写每件实际采购成本。保存会更新本单产品端结算及对应退货成本；销售业绩、商品档案和库存成本保持原记录。零成本需明确确认。" type="info" :closable="false" />
    <el-table :data="lines" border style="margin-top:16px">
      <el-table-column label="补录" width="70"><template #default="{ row }"><el-checkbox v-model="row.selected" @change="clearPreview" /></template></el-table-column>
      <el-table-column prop="product_name" label="商品" min-width="150" />
      <el-table-column prop="sn_code" label="SN" min-width="130" />
      <el-table-column prop="quantity" label="数量" width="60" />
      <el-table-column prop="product_unit_price" label="原结算单价" width="110" />
      <el-table-column label="实际采购单价" width="180"><template #default="{ row }"><el-input-number v-model="row.unitCost" :min="0" :max="999999999.99" :precision="2" :controls="false" @change="clearPreview" /></template></el-table-column>
      <el-table-column label="零成本确认" width="130"><template #default="{ row }"><el-checkbox v-if="row.unitCost === 0" v-model="row.confirmZero" @change="clearPreview">确认是零元</el-checkbox></template></el-table-column>
    </el-table>
    <el-input v-model="reason" type="textarea" :rows="2" maxlength="512" show-word-limit placeholder="填写原采购单、凭据编号或补录依据（必填）" style="margin-top:16px" />
    <div v-if="previewData" style="margin-top:16px">
      <p>本单提货差：¥{{ money(previewData.before.gross_profit_amount) }} → <strong>{{ previewData.after.status === 'posted' ? `¥${money(previewData.after.gross_profit_amount)}` : '仍有待补项目，整单暂不确认' }}</strong></p>
      <p v-for="item in previewData.items.filter(item => item.warning)" :key="item.itemId" style="color:#b45309">{{ item.productName }}：{{ item.warning }}</p>
      <el-table v-if="previewData.returns.length" :data="previewData.returns" border>
        <el-table-column prop="adjustmentNo" label="同步影响的产品端退货单" />
        <el-table-column label="原毛利"><template #default="{ row }">¥{{ money(row.before.gross_profit_amount) }}</template></el-table-column>
        <el-table-column label="补录后毛利"><template #default="{ row }">{{ row.after.status === 'posted' ? `¥${money(row.after.gross_profit_amount)}` : '待补' }}</template></el-table-column>
      </el-table>
    </div>
    <el-collapse style="margin-top:16px"><el-collapse-item title="本单补录记录" name="history">
      <el-empty v-if="!history.length" description="暂无补录记录" :image-size="50" />
      <div v-for="log in history" :key="log.log_id">
        <p>{{ log.create_time }} · {{ log.actor_name }} · {{ log.comment }}</p>
        <p v-for="item in log.detail?.items || []" :key="item.itemId">{{ item.productName }} / {{ item.snCode || '无SN' }}：采购单价 ¥{{ money(item.before.purchase_unit_cost) }} → ¥{{ money(item.after.purchase_unit_cost) }}</p>
      </div>
    </el-collapse-item></el-collapse>
    <template #footer>
      <el-button @click="visible=false">关闭</el-button>
      <el-button :loading="busy" :disabled="!lines.some(line => line.selected)" @click="preview">预览影响</el-button>
      <el-button type="primary" :loading="busy" :disabled="!previewData || reason.trim().length < 2" @click="save">确认保存补录</el-button>
    </template>
  </el-dialog>
</template>
<script setup>
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
const emit = defineEmits(['saved'])
const visible = ref(false), busy = ref(false), settlement = ref(null), lines = ref([]), reason = ref(''), previewData = ref(null), history = ref([])
const money = value => Number(value || 0).toFixed(2)
const clearPreview = () => { previewData.value = null }
const payload = () => ({ items: lines.value.filter(line => line.selected).map(line => ({ itemId: line.settlement_item_id, unitCost: line.unitCost, confirmZero: line.confirmZero })) })
async function open(row) {
  settlement.value = row
  lines.value = (row.items || []).filter(line => line.canSupplementCost).map(line => ({ ...line, unitCost: undefined, confirmZero: false, selected: true }))
  reason.value = ''; previewData.value = null; history.value = []; visible.value = true
  try { const res = await api.productCostHistory(row.settlementId); history.value = res.data || [] } catch (error) { ElMessage.error(error.response?.data?.message || '加载补录记录失败') }
}
async function preview() {
  const input = payload()
  if (input.items.some(item => item.unitCost === undefined || item.unitCost === null)) return ElMessage.warning('请填写所选商品的实际采购单价')
  if (input.items.some(item => item.unitCost === 0 && !item.confirmZero)) return ElMessage.warning('请明确确认零元采购成本')
  busy.value = true; previewData.value = null
  try { const res = await api.previewProductCost(settlement.value.settlementId, input); previewData.value = res.data } catch (error) { ElMessage.error(error.response?.data?.message || '预览失败') } finally { busy.value = false }
}
async function save() {
  if (!previewData.value) return
  busy.value = true
  try { await api.supplementProductCost(settlement.value.settlementId, { ...payload(), reason: reason.value, previewHash: previewData.value.previewHash }); ElMessage.success('采购成本及对应产品端退货已同步'); visible.value = false; emit('saved') }
  catch (error) { previewData.value = null; ElMessage.error(error.response?.data?.message || '补录失败，请重新预览') }
  finally { busy.value = false }
}
defineExpose({ open })
</script>
