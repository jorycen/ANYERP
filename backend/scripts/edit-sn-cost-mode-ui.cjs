const fs=require('fs'),cp=require('child_process');
const p='frontend/web/src/views/Inventory.vue';let s=fs.readFileSync(p,'utf8');
s=s.replaceAll('<el-option label="数量调整" value="ADJUST" />','<el-option label="数量调整" value="ADJUST" />\n                <el-option label="SN计价方式调整" value="COST_MODE" />');
s=s.replace('<el-form-item label="导入类型" required>','<el-form-item v-if="batchForm.operationType !== \'COST_MODE\'" label="导入类型" required>');
s=s.replace('<el-form-item label="统一仓位" required>','<el-form-item v-if="batchForm.operationType !== \'COST_MODE\'" label="统一仓位" required>');
s=s.replace("ADJUST: '数量调整'","ADJUST: '数量调整', COST_MODE: 'SN计价方式调整'");
s=s.replace('const downloadBatchTemplate = () => {',`const downloadBatchTemplate = () => {
  if (batchForm.operationType === 'COST_MODE') {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ SN: '', 计价方式: '按公司定价', 调整原因: '' }]), 'SN计价方式调整')
    XLSX.writeFile(wb, 'SN计价方式调整模板.xlsx')
    return
  }`);
s=s.replace("if (!batchForm.importMode) return", "if (batchForm.operationType !== 'COST_MODE' && !batchForm.importMode) return");
s=s.replace("if (!batchForm.inventoryType) return", "if (batchForm.operationType !== 'COST_MODE' && !batchForm.inventoryType) return");
s=s.replace('importMode: batchForm.importMode,',"importMode: batchForm.operationType === 'COST_MODE' ? 'SN' : batchForm.importMode,");
s=s.replace('inventoryType: batchForm.inventoryType,',"inventoryType: batchForm.operationType === 'COST_MODE' ? '' : batchForm.inventoryType,");
s=s.replace('<h4 class="mt-20">明细</h4>',`<h4 class="mt-20">明细</h4>
        <el-alert v-if="currentBatchApplication.operation_type === 'COST_MODE'" title="仅审批通过后调整在库SN计价方式，不修改采购成本及已归档订单。" type="info" :closable="false" />`);
s=s.replace('<el-table-column prop="sn_code" label="SN" width="150" show-overflow-tooltip />',`<el-table-column prop="sn_code" label="SN" width="150" show-overflow-tooltip />
          <el-table-column v-if="currentBatchApplication.operation_type === 'COST_MODE'" label="计价方式调整" min-width="180">
            <template #default="{ row }">{{ batchCostModeText(row) }}</template>
          </el-table-column>`);
s=s.replace('const batchOperationText =',`const batchCostModeText = row => {
  try { const data = typeof row.raw_json === 'string' ? JSON.parse(row.raw_json) : row.raw_json
    const label = mode => ({ COMPANY_PRICE: '按公司定价', PURCHASE_PRICE: '按采购价' }[mode] || '未设置')
    return label(data?._costMode?.before) + ' → ' + label(data?._costMode?.target)
  } catch { return '数据不可用' }
}
const batchOperationText =`);
fs.writeFileSync(p,s);
const f='backend/src/modules/inventory/foundation.js';let current=fs.readFileSync(f,'utf8');current=current.replace('costMode:row.cost_mode || null,','costMode:json(row.source_data||{}).pricingModeOverride ? row.cost_mode : row.cost_mode || null,');fs.writeFileSync(f,current);
// Stage only the override reader, preserving unrelated local foundation work.
let head=cp.execFileSync('git',['show','HEAD:'+f],{encoding:'utf8'});head=head.replace('costMode:productMap.get(row.product_id)?.gross_profit_cost_mode || null,','costMode:json(row.source_data||{}).pricingModeOverride ? row.cost_mode : productMap.get(row.product_id)?.gross_profit_cost_mode || null,');
const hash=cp.execFileSync('git',['hash-object','-w','--stdin'],{input:head.replace(/\r\n/g,'\n'),encoding:'utf8'}).trim();cp.execFileSync('git',['update-index','--cacheinfo','100644',hash,f]);
