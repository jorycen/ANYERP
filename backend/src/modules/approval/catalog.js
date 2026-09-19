const crypto = require('crypto');
const { Op } = require('sequelize');
const { ApprovalFlowDefinition, Staff } = require('../../models');

const FIXED_APPROVERS = [
  { name: '\u6bb5\u8d85', phone: '15308182113' },
  { name: '\u5f20\u6b22', phone: '17711068535' },
  { name: '\u9093\u7ea2\u6885', phone: '14780834570' },
  { name: '\u8d56\u66e6', phone: '18980060806' },
  { name: '\u674e\u71d5', phone: '18010607277' }
];

function serial(name, approvers) { return { name, signMode: 'serial', approvers }; }
function or(name, approvers) { return { name, signMode: 'or', approvers }; }
function role(roleCode, scope = 'subject_distributor') { return { type: 'role', roleCode, scope }; }

function defaultCatalog(fixed = new Map()) {
  const fixedRule = name => ({ type: 'fixed_user', staffId: Number(fixed.get(name) || 0) });
  return [
    { flowCode: 'sn_change', name: '\u0053\u004e\u4fee\u6539\u5ba1\u6279', businessType: 'sn_change', nodes: [or('\u7ecf\u9500\u5546\u603b\u8d26\u53f7\u5ba1\u6279', [role('admin'), role('boss')])] },
    { flowCode: 'expense_attribution', name: '\u62a5\u9500\u5ba1\u6279\u6d41\u7a0b', businessType: 'expense', nodes: [serial('\u5e97\u957f\u5ba1\u6279', [{ type: 'store_manager', scope: 'subject_store' }]), ...FIXED_APPROVERS.map(item => serial(`${item.name}\u5ba1\u6279`, [fixedRule(item.name)]))] },
    { flowCode: 'payable_settlement', name: '\u5e94\u4ed8\u7ed3\u7b97\u5ba1\u6279', businessType: 'payable_settlement', nodes: [serial('\u63d0\u4ea4\u4eba\u76f4\u5c5e\u4e0a\u7ea7\u5ba1\u6279', [role('manager', 'subject_store')]), serial('\u6bb5\u8d85\u5ba1\u6279', [fixedRule('\u6bb5\u8d85')]), serial('\u8d56\u66e6\u5ba1\u6279', [fixedRule('\u8d56\u66e6')])] },
    { flowCode: 'purchase_request', name: '\u91c7\u8d2d\u7533\u8bf7\u5ba1\u6279', businessType: 'purchase_request', nodes: [or('\u91c7\u8d2d\u5ba1\u6279\u90e8\u95e8', [role('purchaser'), role('admin'), role('boss')])] },
    { flowCode: 'product_application', name: '\u65b0\u5efa\u5546\u54c1\u5ba1\u6279', businessType: 'product_application', nodes: [or('\u5546\u54c1\u5ba1\u6279\u90e8\u95e8', [role('purchaser'), role('finance'), role('admin'), role('boss')])] },
    { flowCode: 'inventory_transfer', name: '\u5e93\u5b58\u8c03\u62e8\u5ba1\u6279', businessType: 'inventory_transfer', nodes: [serial('\u8c03\u51fa\u95e8\u5e97\u5ba1\u6279', [{ type: 'store_manager', scope: 'subject_store' }]), or('\u8c03\u62e8\u7ba1\u7406\u90e8\u95e8\u5ba1\u6279', [role('admin'), role('boss')])] },
    { flowCode: 'sales_order_negative_gross_profit', name: '\u9500\u552e\u8d1f\u6bdb\u5229\u5ba1\u6279', businessType: 'sales_order_negative_gross_profit', nodes: [serial('\u5e97\u957f\u5ba1\u6279', [{ type: 'store_manager', scope: 'subject_store' }]), or('\u7ecf\u9500\u5546\u603b\u8d26\u53f7\u5ba1\u6279', [role('admin'), role('boss')])] },
    { flowCode: 'sales_return', name: '\u9500\u552e\u9000\u5355\u5ba1\u6279', businessType: 'sales_return', nodes: [serial('\u5e97\u957f\u5ba1\u6279', [{ type: 'store_manager', scope: 'subject_store' }]), serial('\u6bb5\u8d85\u5ba1\u6279', [fixedRule('\u6bb5\u8d85')]), serial('\u9093\u7ea2\u6885\u5ba1\u6279', [fixedRule('\u9093\u7ea2\u6885')]), serial('\u674e\u71d5\u5ba1\u6279', [fixedRule('\u674e\u71d5')])] },
    { flowCode: 'deposit_refund', name: '\u5b9a\u91d1\u9000\u6b3e\u5ba1\u6279', businessType: 'deposit_refund', nodes: [serial('\u5e97\u957f\u5ba1\u6279', [{ type: 'store_manager', scope: 'subject_store' }]), serial('\u9093\u7ea2\u6885\u5ba1\u6279', [fixedRule('\u9093\u7ea2\u6885')]), serial('\u674e\u71d5\u5ba1\u6279', [fixedRule('\u674e\u71d5')])] },
    { flowCode: 'return_stock', name: '\u9000\u5e93\u5ba1\u6279', businessType: 'return_stock', nodes: [or('\u91c7\u8d2d\u5e93\u5b58\u5ba1\u6279\u90e8\u95e8', [role('purchaser'), role('admin'), role('boss')])] },
    { flowCode: 'resource_claim', name: '\u8d44\u6e90\u6743\u76ca\u5957\u56de\u5ba1\u6279', businessType: 'resource_claim', nodes: [or('\u8d22\u52a1\u5ba1\u6279\u90e8\u95e8', [role('finance'), role('admin'), role('boss')])] },
    { flowCode: 'profit_adjustment', name: '\u6bdb\u5229\u8c03\u6574\u5ba1\u6279', businessType: 'profit_adjustment', nodes: [or('\u8d22\u52a1\u5ba1\u6279\u90e8\u95e8', [role('finance'), role('admin'), role('boss')])] },
    { flowCode: 'subsidy_receivable_adjustment', name: '\u56fd\u8865\u5dee\u989d\u5ba1\u6279', businessType: 'subsidy_receivable_adjustment', nodes: [or('\u8d22\u52a1\u5ba1\u6279\u90e8\u95e8', [role('finance'), role('admin'), role('boss')])] },
    { flowCode: 'expense_performance_allocation', name: '\u8d39\u7528\u7ee9\u6548\u5206\u914d\u5ba1\u6279', businessType: 'expense_performance_allocation', nodes: [or('\u8d22\u52a1\u5ba1\u6279\u90e8\u95e8', [role('finance'), role('admin'), role('boss')])] }
  ].map(item => ({ ...item, config: { nodes: item.nodes } }));
}

async function seedApprovalFlowCatalog(transaction = null) {
  const staffRows = await Staff.findAll({ where: { phone: { [Op.in]: FIXED_APPROVERS.map(item => item.phone) }, status: 1, is_deleted: 0 }, attributes: ['staff_id', 'phone'], transaction });
  const staffByPhone = new Map(staffRows.map(row => [String(row.phone), Number(row.staff_id)]));
  const fixed = new Map(FIXED_APPROVERS.map(item => [item.name, staffByPhone.get(item.phone)]));
  for (const item of defaultCatalog(fixed)) {
    if (JSON.stringify(item.config).includes('\"staffId\":0')) continue;
    const existing = await ApprovalFlowDefinition.findOne({ where: { flow_code: item.flowCode }, order: [['version', 'DESC']], transaction });
    if (existing) {
      let existingConfig = null;
      try { existingConfig = JSON.parse(existing.config_json || '{}'); } catch (_) { existingConfig = null; }
      const oldSalesReturn = item.flowCode === 'sales_return' && Array.isArray(existingConfig?.nodes) && existingConfig.nodes.length === 2;
      const oldDepositRefund = item.flowCode === 'deposit_refund' && Array.isArray(existingConfig?.nodes) && existingConfig.nodes.length === 3
        && existingConfig.nodes[1]?.approvers?.some(approver => approver?.type === 'role' && approver.roleCode === 'finance');
      if (existing.status === 'published' && (oldSalesReturn || oldDepositRefund)) {
        await existing.update({ status: 'disabled', update_time: new Date() }, { transaction });
        await ApprovalFlowDefinition.create({ definition_id: crypto.randomUUID().replace(/-/g, '').slice(0, 32), flow_code: item.flowCode, name: item.name, business_type: item.businessType, subject_type: 'staff', version: Number(existing.version || 1) + 1, status: 'published', config_json: JSON.stringify(item.config), create_time: new Date(), update_time: new Date() }, { transaction });
      }
      continue;
    }
    await ApprovalFlowDefinition.create({ definition_id: crypto.randomUUID().replace(/-/g, '').slice(0, 32), flow_code: item.flowCode, name: item.name, business_type: item.businessType, subject_type: 'staff', version: 1, status: 'published', config_json: JSON.stringify(item.config), create_time: new Date(), update_time: new Date() }, { transaction });
  }
}

module.exports = { FIXED_APPROVERS, defaultCatalog, seedApprovalFlowCatalog };
