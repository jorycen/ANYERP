const M = require('../../models');
const { generateUUID } = require('../../utils');
const money = value => Math.round(Number(value || 0) * 100) / 100;
function json(value) { if (value && typeof value === 'object') return value; try { return JSON.parse(value || '{}'); } catch (_) { return {}; } }
function isProductPolicy(record) {
  return record.resource_type === 'MANUFACTURER_REBATE' || record.source_type === 'MANUFACTURER_REBATE'
    || record.source_type === 'EDU_PRODUCT_REBATE'
    || (record.resource_type === 'EDU_SUBSIDY' && record.source_type === 'SALE_USE');
}
async function context(record, transaction) {
  let orderId = null;
  let amount = money(record.amount);
  let entryType = 'manufacturer';
  let task;
  if (record.resource_type === 'EDU_SUBSIDY') {
    task = await M.ResourceRightChangeOrder.findByPk(record.source_id, { transaction });
    const snapshot = json(task?.reward_snapshot_json);
    // Legacy unversioned education cannot be inferred as the new 20% allocation.
    if (!task || task.approval_status !== 'completed' || snapshot.accountingVersion !== 2) return null;
    const returned = await M.ResourceRightChangeOrder.findOne({ where: { related_sale_order_id: task.related_sale_order_id, sn_id: task.sn_id, resource_type: 'EDU_SUBSIDY', change_reason: 'EDU_REWARD_RETURN' }, transaction });
    if (returned) throw Object.assign(new Error('该教育优惠已随销售退货冲回，请先核对返利下账记录'), { status: 409 });
    const expected = money(snapshot.productAmount);
    if (!(expected > 0)) return null;
    if (record.source_type === 'EDU_PRODUCT_REBATE' && amount !== money(snapshot.amount)) throw new Error('教育优惠待下账全额与审批快照不一致');
    amount = expected;
    entryType = 'education';
    orderId = task.related_sale_order_id;
  } else {
    const estimate = await M.RebateEstimate.findByPk(record.source_id, { transaction });
    orderId = estimate?.sales_order_id;
    if (!orderId) {
      const id = String(record.source_id || '').replace(/^PRICE_CLAIM_/, '');
      task = await M.ResourceRightChangeOrder.findByPk(id, { transaction });
      orderId = task?.related_sale_order_id || task?.related_order_id;
    }
  }
  const order = orderId ? await M.Order.findByPk(orderId, { transaction }) : null;
  // Company price-protection claims without a sale retain their inventory store scope.
  const sn = !order?.store_id && record.sn_id ? await M.ProductSn.findByPk(record.sn_id, { transaction }) : null;
  const storeId = order?.store_id || sn?.store_id;
  if (!storeId) throw Object.assign(new Error('返利缺少可追溯门店，不能确认产品端毛利'), { status: 409 });
  return { amount, entryType, orderId: order?.order_id || null, orderNo: order?.order_no || '', storeId, orderItemId: json(task?.reward_snapshot_json).orderItemId, productId: task?.product_id };
}
// Caller locks ResourceSettlement first. A full recognition and its reversal are
// append-only and happen in the same transaction as reconciliation.
async function syncPolicyIncome(record, transaction, user = {}, reverse = false) {
  if (!isProductPolicy(record)) return;
  const entries = await M.ProductProfitIncome.findAll({ where: { settlement_id: record.settlement_id }, transaction, order: [['entry_key', 'ASC']] });
  const reversed = new Set(entries.map(entry => entry.reverses_entry_id).filter(Boolean));
  const active = entries.find(entry => !entry.reverses_entry_id && !reversed.has(entry.entry_id));
  if (reverse) {
    if (!active) return;
    await M.ProductProfitIncome.create({ entry_id: generateUUID(), entry_key: `reverse:${active.entry_id}`,
      entry_type: active.entry_type, settlement_id: record.settlement_id, source_order_id: active.source_order_id,
      source_order_no: active.source_order_no, store_id: active.store_id, amount: -money(active.amount),
      business_date: new Date(), reverses_entry_id: active.entry_id, create_user: user.name || user.phone || 'system',
      detail_json: { ...json(active.detail_json), settlementNo: record.settlement_no, action: 'reverse', reason: record.correction_reason || '撤销核销或销售退回' }
    }, { transaction });
    return;
  }
  if (active || record.status !== 'SETTLED' || money(record.matched_amount) < money(record.amount) || !(money(record.amount) > 0)) return;
  const info = await context(record, transaction);
  if (!info) return;
  await M.ProductProfitIncome.create({ entry_id: generateUUID(), entry_key: `settle:${record.settlement_id}:${entries.length}`,
    entry_type: info.entryType, settlement_id: record.settlement_id, source_order_id: info.orderId,
    source_order_no: info.orderNo, store_id: info.storeId, amount: info.amount,
    business_date: record.settled_at || new Date(), create_user: user.name || user.phone || 'system',
    detail_json: { settlementNo: record.settlement_no, sourceType: record.source_type, orderItemId: info.orderItemId, productId: info.productId, action: 'recognize', matchedAmount: money(record.matched_amount) }
  }, { transaction });
}
module.exports = { isProductPolicy, syncPolicyIncome, context };
