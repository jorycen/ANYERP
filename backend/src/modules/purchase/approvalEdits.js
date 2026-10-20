const models = require('../../models');
const { recordBusinessAction } = require('../../utils/businessActionLog');

async function applyPurchaseApprovalEdits(ctx, request, transaction, dependencies = models, audit = recordBusinessAction) {
  const edit = ctx.request.body.purchaseEdits;
  if (edit === undefined) return;
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) ctx.throw(400, '采购审批修改格式无效');
  if (Object.keys(edit).some(key => !['invoiceType', 'paymentMethod', 'items'].includes(key))) ctx.throw(400, '包含不可修改的采购字段');
  const patch = {};
  if (edit.invoiceType !== undefined) {
    if (!['专票13%', '收据'].includes(edit.invoiceType)) ctx.throw(400, '发票类型仅允许专票13%或收据');
    patch.invoice_type = edit.invoiceType;
  }
  if (edit.paymentMethod !== undefined) {
    if (!['COMPANY_CREDIT', 'PERSONAL_ADVANCE'].includes(edit.paymentMethod)) ctx.throw(400, '付款方式无效');
    patch.payment_method = edit.paymentMethod;
  }
  if (edit.items !== undefined && !Array.isArray(edit.items)) ctx.throw(400, '商品计价明细格式无效');
  const byId = new Map((request.items || []).map(item => [String(item.item_id), item]));
  const supplier = await dependencies.Supplier.findByPk(request.supplier_id, { transaction });
  const allowed = String(supplier?.purchase_cost_mode_allowed || 'COMPANY_PRICE,PURCHASE_PRICE').split(',').map(mode => mode.trim());
  const seen = new Set(), itemChanges = [];
  for (const incoming of edit.items || []) {
    const id = String(incoming?.itemId || ''), item = byId.get(id);
    if (!item || seen.has(id)) ctx.throw(400, '商品明细不属于当前申请或重复');
    seen.add(id);
    const mode = incoming.grossProfitCostMode;
    if (!['COMPANY_PRICE', 'PURCHASE_PRICE'].includes(mode)) ctx.throw(400, '商品毛利计价方式无效');
    if (Number(item.is_used_product) === 1) {
      if (mode !== 'PURCHASE_PRICE') ctx.throw(400, '二手商品仅允许按采购价');
    } else {
      if (!allowed.includes(mode)) ctx.throw(400, '毛利计价方式不在供应商允许范围内');
      if (mode === 'COMPANY_PRICE') {
        const price = await dependencies.ProductPrice.findOne({ where: { product_id: item.product_id, status: 1 }, transaction });
        if (!(Number(price?.standard_price) > 0)) ctx.throw(400, `商品“${item.product_name}”未维护有效公司定价`);
      }
    }
    if (item.gross_profit_cost_mode !== mode) itemChanges.push({ item, before: item.gross_profit_cost_mode, after: mode });
  }
  const headerChanges = Object.fromEntries(Object.entries(patch).filter(([key, value]) => request[key] !== value)
    .map(([key, after]) => [key, { before: request[key], after }]));
  if (Object.keys(headerChanges).length) await request.update(patch, { transaction });
  for (const change of itemChanges) await change.item.update({ gross_profit_cost_mode: change.after }, { transaction });
  if (Object.keys(headerChanges).length || itemChanges.length) await audit({ businessType: 'purchase_request', businessId: request.request_id,
    businessNo: request.request_no, action: 'approval_fields_updated', user: ctx.state.user,
    comment: '审批人修改采购付款方式、发票类型或商品毛利计价方式',
    detail: { fields: headerChanges, items: itemChanges.map(change => ({ itemId: change.item.item_id,
      productName: change.item.product_name, before: change.before, after: change.after })) }, transaction });
}
module.exports = { applyPurchaseApprovalEdits };
