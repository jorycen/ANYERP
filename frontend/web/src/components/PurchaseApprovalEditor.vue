<template>
  <div v-if="modelValue" class="purchase-approval-editor">
    <el-descriptions :column="2" border style="margin-bottom:12px">
      <el-descriptions-item label="供应商">{{ modelValue.supplierName || '-' }}</el-descriptions-item>
      <el-descriptions-item label="申请门店">{{ modelValue.storeName || '-' }}</el-descriptions-item>
      <el-descriptions-item label="采购金额">¥{{ modelValue.purchaseAmount }}</el-descriptions-item>
      <el-descriptions-item label="货型">{{ modelValue.productType }}</el-descriptions-item>
      <el-descriptions-item label="采购运费">¥{{ modelValue.freightAmount }}</el-descriptions-item>
      <el-descriptions-item label="配送平台">{{ modelValue.freightPlatformName }}</el-descriptions-item>
      <el-descriptions-item label="毛利计算方式" :span="2">按下方各商品的计价方式计算</el-descriptions-item>
    </el-descriptions>
    <el-descriptions v-if="readOnly" :column="2" border style="margin-bottom:12px">
      <el-descriptions-item label="付款方式">{{ ({ COMPANY_CREDIT: '公司账期', PERSONAL_ADVANCE: '个人垫付', COMPANY_DIRECT: '公司直接付款' })[modelValue.paymentMethod] || modelValue.paymentMethod || '未设置' }}</el-descriptions-item>
      <el-descriptions-item label="发票类型">{{ modelValue.invoiceType || '未设置' }}</el-descriptions-item>
    </el-descriptions>
    <el-alert v-if="!readOnly && !disabled" title="修改随本次审批通过保存；拒绝审批不保存修改。" type="info" :closable="false" />
    <el-form v-if="!readOnly" :disabled="disabled" label-width="110px" style="margin-top:14px">
      <el-form-item label="付款方式" required><el-select :model-value="modelValue.paymentMethod" @update:model-value="value => change('paymentMethod', value)"><el-option label="公司账期" value="COMPANY_CREDIT" /><el-option label="个人垫付" value="PERSONAL_ADVANCE" /></el-select></el-form-item>
      <el-form-item label="发票类型" required><el-select :model-value="modelValue.invoiceType" @update:model-value="value => change('invoiceType', value)"><el-option label="专票13%" value="专票13%" /><el-option label="收据" value="收据" /></el-select></el-form-item>
    </el-form>
    <el-table :data="modelValue.items" border size="small">
      <el-table-column prop="productName" label="商品" min-width="200" />
      <el-table-column prop="pnCode" label="PN" min-width="140" />
      <el-table-column prop="quantity" label="数量" width="70" />
      <el-table-column prop="unitPrice" label="采购单价" width="100" />
      <el-table-column prop="subtotal" label="小计" width="100" />
      <el-table-column label="毛利计价方式" min-width="180"><template #default="{ row, $index }">
        <span v-if="readOnly">{{ row.grossProfitCostMode === 'COMPANY_PRICE' ? '按公司定价' : row.grossProfitCostMode === 'PURCHASE_PRICE' ? '按采购价' : '未设置' }}</span>
        <el-select v-else :model-value="row.grossProfitCostMode" :disabled="disabled || row.isUsedProduct" @update:model-value="value => changeItem($index, value)"><el-option label="按公司定价" value="COMPANY_PRICE" /><el-option label="按采购价" value="PURCHASE_PRICE" /></el-select>
      </template></el-table-column>
    </el-table>
  </div>
</template>
<script setup>
const props = defineProps({ modelValue: Object, disabled: Boolean, readOnly: Boolean })
const emit = defineEmits(['update:modelValue'])
const change = (key, value) => emit('update:modelValue', { ...props.modelValue, [key]: value })
const changeItem = (index, mode) => emit('update:modelValue', { ...props.modelValue,
  items: props.modelValue.items.map((item, i) => i === index ? { ...item, grossProfitCostMode: mode } : item) })
</script>
