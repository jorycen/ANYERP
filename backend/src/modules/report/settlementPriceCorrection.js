const crypto = require('node:crypto');
const { Op, QueryTypes } = require('sequelize');
const M = require('../../models');
const GP = require('../sales/grossProfit');
const { summarizeProductSettlementItems } = require('./productSettlement')._test;
const { recordBusinessAction } = require('../../utils/businessActionLog');
const { isDealerAccount } = require('../../middleware/permission');

const TYPE = 'price_correction';
const INVOICE_TYPE = 'invoice_amount';
const isCorrection = type => [TYPE, INVOICE_TYPE].includes(type);
const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const plain = row => row?.toJSON ? row.toJSON() : { ...row };
function fail(message, status = 409) { throw Object.assign(new Error(message), { status }); }
function json(value, fallback = {}) {
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}
function validate(body) {
  if (body.adjustmentType && !isCorrection(body.adjustmentType)) fail('不支持的业务纠错类型', 400);
  if (body.adjustmentType === INVOICE_TYPE) {
    if (!['number', 'string'].includes(typeof body.invoiceAmount) || !/^\d{1,9}(\.\d{1,2})?$/.test(String(body.invoiceAmount ?? ''))) fail('开票金额须为非负金额，最多两位小数', 400);
    if (Number(body.invoiceAmount) === 0 && body.confirmZero !== true && body.confirmZero !== 'true') fail('零元开票金额须明确确认', 400);
    return { type: INVOICE_TYPE, invoiceAmount: money(body.invoiceAmount) };
  }
  const itemId = String(body.itemId || '').trim();
  if (!itemId || !/^\d{1,9}(\.\d{1,2})?$/.test(String(body.unitPrice ?? '')) || typeof body.unitPrice === 'boolean') fail('请选择商品，结算定价须为非负金额，最多两位小数', 400);
  if (Number(body.unitPrice) === 0 && body.confirmZero !== true && body.confirmZero !== 'true') fail('零元结算定价须明确确认', 400);
  return { itemId, unitPrice: money(body.unitPrice) };
}
function snapshotPatch(snapshot, itemId, unitPrice, adjustmentId = null, invoiceInput = null) {
  const amountKeys = ['receivable_amount', 'product_pricing_amount', 'payment_fee_amount', 'invoice_amount',
    'vat_taxable_amount', 'vat_amount', 'supplement_amount', 'freight_cost_amount', 'gross_profit_amount'];
  if (amountKeys.some(key => snapshot[key] === null || snapshot[key] === undefined || typeof snapshot[key] === 'boolean' || String(snapshot[key]).trim() === '' || !Number.isFinite(Number(snapshot[key])))
    || !Array.isArray(json(snapshot.payment_fee_details, null)) || !Array.isArray(json(snapshot.supplement_details, null))) fail('原归档金额或计算明细不完整，请先核实，不能以零值替代');
  const lines = json(snapshot.product_pricing_details, []);
  if (!Array.isArray(lines) || lines.some(line => !Number.isFinite(Number(line.quantity)) || Number(line.quantity) <= 0
    || GP.validPrice(line.unitPricing) === null || GP.validPrice(line.pricingAmount) === null
    || money(Number(line.unitPricing) * Number(line.quantity)) !== money(line.pricingAmount))) fail('原归档商品定价明细不完整或数量金额不一致，请先核实');
  const line = lines.find(item => String(item.itemId) === String(itemId));
  if (!invoiceInput && (!line || line.isCompanyPriced !== true || String(line.source || '').startsWith('missing_'))) fail('仅支持有完整归档依据的公司结算定价商品；采购价口径请走成本纠错');
  if (!invoiceInput && Number(line.unitPricing) === unitPrice) fail('申请定价与当前生效定价相同', 400);
  const next = invoiceInput ? lines : lines.map(item => String(item.itemId) === String(itemId) ? {
    ...item, unitPricing: unitPrice, pricingAmount: money(unitPrice * Number(item.quantity)),
    source: 'approved_settlement_price_correction', correctionId: adjustmentId
  } : item);
  const calculate = (productPricingDetails, invoiceAmount = snapshot.invoice_amount) => {
    const supplements = json(snapshot.supplement_details, []);
    return GP.calculateGrossProfitValues({ receivableAmount: snapshot.receivable_amount,
      paymentDetails: json(snapshot.payment_fee_details, []), productPricingDetails,
      supplementDetails: supplements.filter(item => item.source !== 'freight_cost'),
      freightCostDetails: supplements.filter(item => item.source === 'freight_cost'),
      invoiceAmount, ...(invoiceInput ? { invoiceStatus: invoiceInput.invoiceStatus } : {}) });
  };
  if (snapshot.formula_version !== GP.FORMULA_VERSION || snapshot.snapshot_status !== 'final' || !GP.pricingCompleteness(lines).pricingComplete) fail('原订单须有完整的现行归档毛利快照，请先核实历史口径');
  const original = calculate(lines);
  // A correction cannot silently upgrade formulas, tax rates or other archived inputs.
  const comparisons = { gross_profit_amount: 'grossProfitAmount', payment_fee_amount: 'paymentFeeAmount',
    product_pricing_amount: 'productPricingAmount', vat_amount: 'vatAmount', vat_taxable_amount: 'vatTaxableAmount',
    supplement_amount: 'supplementAmount', freight_cost_amount: 'freightCostAmount' };
  if (Object.entries(comparisons).some(([stored, computed]) => money(original[computed]) !== money(snapshot[stored]))) fail('归档计算依据与现行公式不一致，请先核实原单，不能借业务纠错改写其他口径');
  const values = calculate(next, invoiceInput ? invoiceInput.invoiceAmount : snapshot.invoice_amount);
  if (invoiceInput) return { invoice_amount: values.invoiceAmount, vat_taxable_amount: values.vatTaxableAmount,
    vat_amount: values.vatAmount, gross_profit_amount: values.grossProfitAmount };
  return { product_pricing_details: values.productPricingDetails, product_pricing_amount: values.productPricingAmount,
    vat_taxable_amount: values.vatTaxableAmount, vat_amount: values.vatAmount, gross_profit_amount: values.grossProfitAmount };
}
function productPatch(items, itemId, unitPrice) {
  const after = items.map(item => String(item.source_order_item_id) === String(itemId) ? {
    ...item, product_unit_price: unitPrice, product_price_source: 'approved_settlement_price_correction',
    gross_profit_amount: money((unitPrice - Number(item.purchase_unit_cost)) * Number(item.quantity))
  } : item);
  const summary = summarizeProductSettlementItems(after);
  return { items: after, summary: { product_pricing_amount: summary.productPricingAmount,
    purchase_cost_amount: summary.purchaseCostAmount, gross_profit_amount: summary.grossProfitAmount,
    cost_pending_amount: summary.costPendingAmount, status: summary.status } };
}

async function select(ctx, orderId, input = null, transaction = null, includeInvoiceOptions = false) {
  const invoiceOrOptions = input?.type === INVOICE_TYPE || (!input && includeInvoiceOptions);
  if (!orderId || typeof orderId !== 'string' || orderId.length > 32) fail('请选择有效订单', 400);
  const options = { transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) };
  // Shared with financial month close, so it cannot freeze an intermediate correction.
  const initial = await M.Order.findByPk(orderId, options);
  const ids = (ctx.state.user.accessibleStoreIds || []).map(String);
  if (!initial || Number(initial.is_deleted) === 1 || (!ids.includes('*') && !ids.includes(String(initial.store_id)))) fail('订单不存在或无权操作', 404);
  if (!await M.Store.findByPk(initial.store_id, options)) fail('订单门店不存在，请先核实原单');
  const order = await M.Order.findByPk(orderId, options);
  if (!['已归档', 'completed', 'archived'].includes(order.order_status)) fail('仅已归档且未退货的订单可以申请业务纠错');
  const month = new Date(new Date(order.create_time).getTime() + 8 * 3600000).toISOString().slice(0, 7);
  const financialMonth = new Date(new Date(order.archive_time || order.create_time).getTime() + 8 * 3600000).toISOString().slice(0, 7);
  const closed = await M.sequelize.query('SELECT MONTH_KEY FROM T_FINANCIAL_PROFIT_PERIOD WHERE MONTH_KEY IN (:months)' + (transaction ? ' FOR UPDATE' : ''), { replacements: { months: [...new Set([month, financialMonth])] }, type: QueryTypes.SELECT, transaction });
  if (closed.length) fail('原订单所属月份已锁定，请由财务通过期间调整流程处理');
  const returns = await M.SalesReturnRequest.findAll({ where: { order_id: orderId, status: { [Op.notIn]: ['rejected', 'cancelled', 'canceled', 'voided'] } }, ...options });
  if (returns.length) fail('订单存在退货或退货处理中记录，本期暂不支持，请先联系财务核对关联退货');
  const snapshot = await M.OrderGrossProfit.findOne({ where: { order_id: orderId }, ...options });
  const settlement = await M.ProductSettlementOrder.findOne({ where: { source_order_id: orderId }, ...options });
  if (!snapshot || (!settlement && !invoiceOrOptions)) fail('缺少原归档毛利或产品端结算记录，请先核实原单');
  if (!invoiceOrOptions && settlement.status !== 'posted') fail('产品端成本未完整确认，暂不能纠正结算定价');
  const settlementMonth = settlement ? new Date(new Date(settlement.business_date).getTime() + 8 * 3600000).toISOString().slice(0, 7) : null;
  if (settlementMonth && settlementMonth !== month && !invoiceOrOptions) {
    const closedSettlement = await M.sequelize.query('SELECT MONTH_KEY FROM T_FINANCIAL_PROFIT_PERIOD WHERE MONTH_KEY = :month' + (transaction ? ' FOR UPDATE' : ''), { replacements: { month: settlementMonth }, type: QueryTypes.SELECT, transaction });
    if (closedSettlement.length) fail('产品端结算所属月份已锁定，请先联系财务核对');
  }
  const items = settlement ? await M.ProductSettlementItem.findAll({ where: { settlement_id: settlement.settlement_id }, order: [['settlement_item_id', 'ASC']], ...options }) : [];
  if (!invoiceOrOptions && (!items.length || items.some(item => item.cost_status !== 'ready' || GP.validPrice(item.purchase_unit_cost) === null
    || GP.validPrice(item.product_unit_price) === null || GP.validPrice(item.purchase_cost_amount) === null))) fail('产品端明细成本未完整确认，请先核对');
  const originalSummary = summarizeProductSettlementItems(items.map(plain));
  if (!invoiceOrOptions && (items.some(item => Number(item.quantity) <= 0
    || money(Number(item.purchase_unit_cost) * Number(item.quantity)) !== money(item.purchase_cost_amount)
    || money(Number(item.product_unit_price) * Number(item.quantity) - Number(item.purchase_cost_amount)) !== money(item.gross_profit_amount))
    || money(settlement.product_pricing_amount) !== originalSummary.productPricingAmount
    || money(settlement.purchase_cost_amount) !== originalSummary.purchaseCostAmount
    || money(settlement.gross_profit_amount) !== originalSummary.grossProfitAmount)) fail('原产品结算明细与汇总金额不一致，请先核实，不能借定价纠错修正其他金额');
  const orderItems = await M.OrderItem.findAll({ where: { order_id: orderId }, order: [['item_id', 'ASC']], ...options });
  const lines = json(snapshot.product_pricing_details, []);
  const optionsList = lines.filter(line => line.isCompanyPriced === true && !String(line.source || '').startsWith('missing_')).map(line => ({
    itemId: String(line.itemId), productName: line.productName, snCode: line.snCode || '', quantity: line.quantity,
    unitPrice: line.unitPricing, label: `${line.productName || line.itemId}${line.snCode ? ' / ' + line.snCode : ''} / 当前结算定价 ¥${Number(line.unitPricing).toFixed(2)}`
  }));
  if (!input) return { options: optionsList, invoiceAmount: snapshot.invoice_amount === null || snapshot.invoice_amount === undefined ? null : Number(snapshot.invoice_amount), invoiceStatus: order.invoice_status };
  if (input.type === INVOICE_TYPE) {
    if (GP.validPrice(input.invoiceAmount) === null) fail('开票金额必须为非负有限金额', 400);
    if (GP.validPrice(order.invoice_amount) === null || money(order.invoice_amount) !== money(snapshot.invoice_amount)) fail('订单开票金额与归档快照不一致，请先核实原单');
    if (!String(order.invoice_status || '').trim() || String(order.invoice_status).trim() === '不开票') fail('当前订单为不开票或开票类型缺失，不能仅修改金额，请先核实开票类型');
    if (money(input.invoiceAmount) === money(snapshot.invoice_amount)) fail('申请开票金额与当前生效金额相同', 400);
    const patch = snapshotPatch(plain(snapshot), null, null, null, { invoiceAmount: input.invoiceAmount, invoiceStatus: order.invoice_status });
    if (Object.values(patch).some(value => !Number.isFinite(value) || Math.abs(value) > 9999999999.99)) fail('本次纠错结果超出系统金额范围', 400);
    const productProfit = settlement?.status === 'posted' && settlement.gross_profit_amount !== null && Number.isFinite(Number(settlement.gross_profit_amount)) ? Number(settlement.gross_profit_amount) : null;
    const before = { snapshot: plain(snapshot), settlement: settlement ? plain(settlement) : null, items: items.map(plain), orderItems: orderItems.map(plain),
      order: { invoice_amount: order.invoice_amount, invoice_status: order.invoice_status } };
    const result = { correctionType: INVOICE_TYPE, beforeInvoiceAmount: Number(snapshot.invoice_amount), afterInvoiceAmount: patch.invoice_amount,
      vatBefore: Number(snapshot.vat_amount), vatAfter: patch.vat_amount,
      salesBefore: Number(snapshot.gross_profit_amount), salesAfter: patch.gross_profit_amount,
      salesDelta: money(patch.gross_profit_amount - Number(snapshot.gross_profit_amount)),
      productBefore: productProfit, productAfter: productProfit, productDelta: 0,
      before, after: { snapshot: patch, order: { invoice_amount: patch.invoice_amount } } };
    const previewHash = crypto.createHash('sha256').update(JSON.stringify({ input, before, order: plain(order) })).digest('hex');
    return { order, snapshot, settlement, items, result, previewHash };
  }
  const chosen = items.filter(item => String(item.source_order_item_id) === input.itemId);
  const originalItem = orderItems.find(item => String(item.item_id) === input.itemId);
  const line = lines.find(item => String(item.itemId) === input.itemId);
  if (!line || !Number.isFinite(Number(line.quantity)) || Number(line.quantity) <= 0) fail('商品归档数量无效，请先核实原单');
  if (chosen.length !== 1 || !originalItem || !line || Number(chosen[0].quantity) !== Number(line.quantity) || Number(originalItem.quantity) !== Number(line.quantity) || Number(chosen[0].product_unit_price) !== Number(line.unitPricing)) fail('商品行、毛利快照与产品结算数据不一致，请先核实');
  const afterSnapshot = snapshotPatch(plain(snapshot), input.itemId, input.unitPrice);
  const product = productPatch(items.map(plain), input.itemId, input.unitPrice);
  if ([afterSnapshot.product_pricing_amount, afterSnapshot.vat_taxable_amount, afterSnapshot.vat_amount, afterSnapshot.gross_profit_amount,
    product.summary.product_pricing_amount, product.summary.gross_profit_amount].some(value => !Number.isFinite(value) || Math.abs(value) > 9999999999.99)) fail('本次纠错结果超出系统金额范围', 400);
  const before = { snapshot: plain(snapshot), settlement: plain(settlement), items: items.map(plain), orderItems: orderItems.map(plain) };
  const result = { itemId: input.itemId, productName: originalItem.product_name, snCode: originalItem.sn_code || '', quantity: line.quantity,
    beforeUnitPrice: Number(line.unitPricing), afterUnitPrice: input.unitPrice,
    salesBefore: Number(snapshot.gross_profit_amount), salesAfter: afterSnapshot.gross_profit_amount,
    productBefore: Number(settlement.gross_profit_amount), productAfter: product.summary.gross_profit_amount,
    salesDelta: money(afterSnapshot.gross_profit_amount - Number(snapshot.gross_profit_amount)),
    productDelta: money(product.summary.gross_profit_amount - Number(settlement.gross_profit_amount)),
    before, after: { snapshot: afterSnapshot, settlement: product.summary, items: product.items } };
  // These management measures include sales tax/uplift rules; do not label their sum company accounting profit.
  const previewHash = crypto.createHash('sha256').update(JSON.stringify({ input, before, order: plain(order) })).digest('hex');
  return { snapshot, settlement, items, originalItem, result, previewHash };
}
async function apply(ctx, adjustment, transaction) {
  if (!transaction) fail('纠错必须与最终审批使用同一事务');
  const saved = json(adjustment.correction_data);
  if (!saved.input || !saved.previewHash) fail('纠错申请缺少原始依据，请重新提交');
  const selected = await select(ctx, adjustment.order_id, saved.input, transaction);
  if (selected.previewHash !== saved.previewHash) fail('订单、毛利或结算数据已变化，请拒绝本申请并重新预览提交');
  if (adjustment.adjustment_type === INVOICE_TYPE) {
    if (saved.input.type !== INVOICE_TYPE) fail('开票金额纠错类型与申请依据不一致');
    const patch = selected.result.after.snapshot;
    await selected.order.update({ invoice_amount: patch.invoice_amount }, { transaction });
    await selected.snapshot.update({ ...patch, calculated_by: ctx.state.user.name, calculated_at: new Date(), update_time: new Date() }, { transaction });
    await adjustment.update({ correction_data: { ...saved, appliedAt: new Date().toISOString(), result: selected.result } }, { transaction });
    await recordBusinessAction({ businessType: 'invoice_amount_correction', businessId: adjustment.order_id,
      businessNo: adjustment.adjustment_no, action: 'correct_invoice_amount', user: ctx.state.user,
      comment: adjustment.reason, detail: { adjustmentId: adjustment.adjustment_id, evidence: saved.evidence, ...selected.result }, transaction });
    return;
  }
  if (saved.input.type === INVOICE_TYPE) fail('纠错类型与申请依据不一致');
  const patch = snapshotPatch(selected.result.before.snapshot, saved.input.itemId, saved.input.unitPrice, adjustment.adjustment_id);
  await selected.snapshot.update({ ...patch, calculated_by: ctx.state.user.name, calculated_at: new Date(), update_time: new Date() }, { transaction });
  await selected.settlement.update({ ...selected.result.after.settlement, update_time: new Date() }, { transaction });
  const changed = selected.items.find(item => String(item.source_order_item_id) === saved.input.itemId);
  const afterItem = selected.result.after.items.find(item => String(item.source_order_item_id) === saved.input.itemId);
  await changed.update({ product_unit_price: afterItem.product_unit_price, product_price_source: afterItem.product_price_source, gross_profit_amount: afterItem.gross_profit_amount }, { transaction });
  await selected.originalItem.update({ sales_settlement_cost: saved.input.unitPrice,
    sales_gross_profit: money(Number(selected.originalItem.subtotal) - saved.input.unitPrice * Number(selected.originalItem.quantity)) }, { transaction });
  await adjustment.update({ correction_data: { ...saved, appliedAt: new Date().toISOString(), result: { ...selected.result, after: { ...selected.result.after, snapshot: patch } } } }, { transaction });
  await recordBusinessAction({ businessType: 'settlement_price_correction', businessId: adjustment.order_id,
    businessNo: adjustment.adjustment_no, action: 'correct_settlement_price', user: ctx.state.user,
    comment: adjustment.reason, detail: { adjustmentId: adjustment.adjustment_id, evidence: saved.evidence, ...selected.result }, transaction });
}
function previewResponse(result, user) {
  const { before, after, ...impact } = result;
  const productProfitVisible = isDealerAccount(user);
  return { ...impact, productProfitVisible,
    ...(!productProfitVisible ? { productBefore: null, productAfter: null, productDelta: null } : {}) };
}
function display(row, user) {
  const saved = json(row.correction_data);
  // Original snapshots include purchase costs and must not leak through a report/approval response.
  const output = { ...row };
  delete output.correction_data;
  if (!isCorrection(row.adjustment_type)) return output;
  const r = saved.result;
  if (r) Object.assign(output, { correction_type_name: '结算定价错误', correction_evidence: saved.evidence,
    correction_product: `${r.productName || r.itemId}${r.snCode ? ' / ' + r.snCode : ''}`,
    correction_before_price: r.beforeUnitPrice, correction_after_price: r.afterUnitPrice,
    correction_sales_before: r.salesBefore, correction_sales_after: r.salesAfter,
    correction_sales_delta: r.salesDelta, correction_product_before: r.productBefore,
    correction_product_after: r.productAfter, correction_product_delta: r.productDelta });
  if (r && row.adjustment_type === INVOICE_TYPE) {
    output.correction_type_name = '开票金额错误';
    delete output.correction_product;
    delete output.correction_before_price;
    delete output.correction_after_price;
    Object.assign(output, { correction_before_invoice_amount: r.beforeInvoiceAmount, correction_after_invoice_amount: r.afterInvoiceAmount,
      correction_vat_before: r.vatBefore, correction_vat_after: r.vatAfter,
      correction_product_note: '本次不调整产品端提货差毛利，原核算状态保持' });
  }
  const storeIds = (user?.accessibleStoreIds || []).map(String);
  output.correction_product_profit_visible = isDealerAccount(user) && (storeIds.includes('*') || storeIds.includes(String(row.store_id)));
  if (!output.correction_product_profit_visible) Object.assign(output, { correction_product_before: null,
    correction_product_after: null, correction_product_delta: null });
  return output;
}
module.exports = { TYPE, INVOICE_TYPE, isCorrection, validate, select, apply, display, previewResponse, snapshotPatch, productPatch, json };
