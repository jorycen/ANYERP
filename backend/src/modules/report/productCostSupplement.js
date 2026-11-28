const crypto = require('node:crypto');
const { Op } = require('sequelize');
const M = require('../../models');
const { getUserRoles } = require('../../middleware/permission');
const { canAccessDistributor } = require('../../utils/distributorScope');
const { recordBusinessAction, listBusinessActions } = require('../../utils/businessActionLog');
const { _test: { summarizeProductSettlementItems, normalizePricingDetails } } = require('./productSettlement');
const money = value => Math.round(Number(value || 0) * 100) / 100;
function plain(row) { return row?.toJSON ? row.toJSON() : { ...row }; }
function assertPermission(ctx) {
  if (!getUserRoles(ctx.state.user).some(role => ['boss', 'admin', 'finance'].includes(role))) ctx.throw(403, '仅财务或管理员可补录已售商品采购成本');
}
async function accessibleSettlement(ctx, transaction) {
  const settlement = await M.ProductSettlementOrder.findByPk(ctx.params.settlementId, { transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
  if (!settlement) ctx.throw(404, '产品端销售结算单不存在');
  const user = ctx.state.user, ids = (user.accessibleStoreIds || []).map(String);
  const store = await M.Store.findByPk(settlement.store_id, { transaction });
  if (!store || (!ids.includes('*') && !ids.includes(String(settlement.store_id))) || !canAccessDistributor(user, store.distributor_id)) ctx.throw(403, '无权补录此门店的产品成本');
  const order = await M.Order.findByPk(settlement.source_order_id, { transaction });
  if (!order || Number(order.is_deleted) === 1 || !['已归档','completed','archived','returned','已退单','return_pending'].includes(order.order_status)) ctx.throw(409, '仅可补录有效已归档销售的产品成本');
  return settlement;
}
function validateInput(body) {
  const items = body.items;
  if (!Array.isArray(items) || !items.length || items.length > 200) throw Object.assign(new Error('每次请选择1至200项待补成本商品'), { status: 400 });
  const seen = new Set();
  return items.map(item => {
    const id = String(item.itemId || '');
    if (!id || seen.has(id)) throw Object.assign(new Error('商品明细重复或缺少编号'), { status: 400 });
    seen.add(id);
    if (typeof item.unitCost === 'boolean' || item.unitCost === null || item.unitCost === undefined || !/^\d{1,9}(\.\d{1,2})?$/.test(String(item.unitCost))) throw Object.assign(new Error('采购单价须为非负金额，最多两位小数'), { status: 400 });
    if (Number(item.unitCost) === 0 && item.confirmZero !== true) throw Object.assign(new Error('零元采购成本须明确勾选确认'), { status: 400 });
    return { itemId: id, unitCost: money(item.unitCost), confirmZero: item.confirmZero === true };
  });
}
function updatedItem(item, input, pricingDetail) {
  const cost = input.unitCost;
  const rawPricing = pricingDetail?.unitPricing ?? pricingDetail?.unit_pricing;
  const frozenPricingKnown = rawPricing !== null && rawPricing !== undefined && String(rawPricing).trim() !== '' && Number.isFinite(Number(rawPricing)) && Number(rawPricing) >= 0 && !String(pricingDetail?.source || '').startsWith('missing_');
  // Only an existing frozen price can resolve a default-zero pricing ambiguity.
  const priceKnown = Number(item.product_unit_price) > 0 || frozenPricingKnown;
  const price = frozenPricingKnown ? money(rawPricing) : money(item.product_unit_price);
  return { ...item, purchase_unit_cost: cost, purchase_cost_amount: money(cost * Number(item.quantity)),
    product_unit_price: price, cost_status: priceKnown ? 'ready' : 'pending', cost_method: 'manual_sold_cost',
    cost_source: 'manual_sold_cost', gross_profit_amount: priceKnown ? money((price - cost) * Number(item.quantity)) : 0 };
}
function summaryPatch(items) {
  const summary = summarizeProductSettlementItems(items);
  return { product_pricing_amount: summary.productPricingAmount, purchase_cost_amount: summary.purchaseCostAmount,
    gross_profit_amount: summary.grossProfitAmount, cost_pending_amount: Math.abs(summary.costPendingAmount), status: summary.status };
}
async function selection(ctx, transaction) {
  const input = validateInput(ctx.request.body || {});
  const settlement = await accessibleSettlement(ctx, transaction);
  const options = { transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) };
  const items = await M.ProductSettlementItem.findAll({ where: { settlement_id: settlement.settlement_id }, order: [['settlement_item_id', 'ASC']], ...options });
  const snapshot = await M.OrderGrossProfit.findOne({ where: { order_id: settlement.source_order_id }, transaction });
  const pricing = normalizePricingDetails(snapshot);
  const byId = new Map(items.map(item => [String(item.settlement_item_id), item]));
  const changes = input.map(incoming => {
    const item = byId.get(incoming.itemId);
    if (!item) ctx.throw(400, '补录商品不属于当前结算单');
    if (item.cost_status === 'ready' || Number(item.purchase_unit_cost) > 0 || item.cost_source === 'manual_sold_cost') ctx.throw(409, '该商品已有采购成本或已补录，请刷新，不能覆盖已确认成本');
    return { item, before: plain(item), after: updatedItem(plain(item), incoming, pricing.get(String(item.source_order_item_id))) };
  });
  const afterItems = items.map(item => changes.find(change => change.item === item)?.after || plain(item));
  const adjustments = await M.ProductSettlementAdjustment.findAll({ where: { source_order_id: settlement.source_order_id }, order: [['adjustment_id', 'ASC']], ...options });
  const returnItems = adjustments.length ? await M.ProductSettlementAdjustmentItem.findAll({ where: { adjustment_id: { [Op.in]: adjustments.map(row => row.adjustment_id) } }, order: [['adjustment_item_id', 'ASC']], ...options }) : [];
  const returnChanges = returnItems.map(item => {
    const sale = changes.find(change => String(change.before.source_order_item_id) === String(item.source_order_item_id));
    if (!sale) return { item, before: plain(item), after: plain(item) };
    const quantity = Number(item.quantity);
    return { item, before: plain(item), after: { ...plain(item), purchase_unit_cost: sale.after.purchase_unit_cost,
      purchase_cost_amount: money(sale.after.purchase_unit_cost * quantity), product_unit_price: sale.after.product_unit_price,
      product_pricing_amount: money(sale.after.product_unit_price * quantity), cost_status: sale.after.cost_status,
      cost_method: 'manual_sold_cost', gross_profit_amount: sale.after.cost_status === 'ready' ? money((sale.after.product_unit_price - sale.after.purchase_unit_cost) * quantity) : 0 } };
  });
  const result = { settlementId: settlement.settlement_id, sourceOrderNo: settlement.source_order_no,
    before: plain(settlement), after: { ...plain(settlement), ...summaryPatch(afterItems) },
    items: changes.map(change => ({ itemId: change.before.settlement_item_id, productName: change.before.product_name,
      snCode: change.before.sn_code, quantity: change.before.quantity, before: change.before, after: change.after,
      warning: change.after.cost_status !== 'ready' ? '原单缺少可确认的结算定价，采购成本可保存，但该商品仍待核对定价' : '' })),
    returns: adjustments.map(row => ({ adjustmentId: row.adjustment_id, adjustmentNo: row.adjustment_no,
      before: plain(row), after: { ...plain(row), ...summaryPatch(returnChanges.filter(change => change.before.adjustment_id === row.adjustment_id).map(change => change.after)) } })) };
  const previewHash = crypto.createHash('sha256').update(JSON.stringify({ input, result })).digest('hex');
  return { settlement, changes, returnChanges, adjustments, result, previewHash };
}
async function preview(ctx) {
  assertPermission(ctx);
  const { result, previewHash } = await selection(ctx);
  ctx.body = { code: 0, data: { ...result, previewHash } };
}
async function apply(ctx) {
  assertPermission(ctx);
  const body = ctx.request.body || {}, reason = String(body.reason || '').trim();
  if (reason.length < 2 || reason.length > 512) ctx.throw(400, '请填写2至512字的原采购凭据或补录依据');
  let result;
  await M.sequelize.transaction(async transaction => {
    const selected = await selection(ctx, transaction);
    if (!body.previewHash || selected.previewHash !== body.previewHash) ctx.throw(409, '单据或退货记录已变化，请重新预览后保存');
    const fields = ['purchase_unit_cost','purchase_cost_amount','product_unit_price','cost_status','cost_method','cost_source','gross_profit_amount'];
    for (const change of selected.changes) await change.item.update(Object.fromEntries(fields.map(key => [key, change.after[key]])), { transaction });
    await selected.settlement.update({ ...summaryPatch(selected.result.items.length ? (await M.ProductSettlementItem.findAll({ where: { settlement_id: selected.settlement.settlement_id }, transaction, raw: true })) : []), update_time: new Date() }, { transaction });
    for (const change of selected.returnChanges) {
      if (JSON.stringify(change.before) === JSON.stringify(change.after)) continue;
      const returnFields = fields.filter(key => key !== 'cost_source').concat('product_pricing_amount');
      await change.item.update(Object.fromEntries(returnFields.map(key => [key, change.after[key]])), { transaction });
    }
    for (const adjustment of selected.adjustments) {
      const row = selected.result.returns.find(row => row.adjustmentId === adjustment.adjustment_id);
      await adjustment.update(Object.fromEntries(['product_pricing_amount','purchase_cost_amount','gross_profit_amount','cost_pending_amount','status'].map(key => [key, row.after[key]])), { transaction });
    }
    await recordBusinessAction({ businessType: 'product_cost_supplement', businessId: selected.settlement.settlement_id,
      businessNo: selected.settlement.settlement_no, action: 'supplement_sold_purchase_cost', user: ctx.state.user,
      comment: reason, detail: selected.result, transaction });
    result = selected.result;
  });
  ctx.body = { code: 0, data: result, message: '采购成本已补录，产品端结算及对应退货已同步，补录记录已保存' };
}
async function history(ctx) {
  assertPermission(ctx);
  const settlement = await accessibleSettlement(ctx);
  ctx.body = { code: 0, data: await listBusinessActions('product_cost_supplement', settlement.settlement_id) };
}
module.exports = { preview, apply, history, validateInput, updatedItem, summaryPatch, assertPermission };
