const M = require('../../models');
const { recordBusinessAction } = require('../../utils/businessActionLog');
const NOTICE = '注意：此单含0成本采购商品，请核实为真实零成本采购后提交；审批人请重点核实零成本原因，注意审批。';
function zeroCostNotice(items = []) {
  const zeroCostItems = (Array.isArray(items) ? items : []).filter(item => {
    if (!item || typeof item !== 'object') return false;
    const price = item.unit_price ?? item.unitPrice ?? item.price;
    return price !== null && price !== undefined && String(price).trim() !== '' && typeof price !== 'boolean'
      && Number(price) === 0 && Number(item.quantity) > 0;
  }).map(item => ({ itemId: item.item_id ?? item.itemId ?? null, productId: item.product_id ?? item.productId,
    productName: item.product_name ?? item.productName ?? '', unitPrice: 0, quantity: Number(item.quantity) }));
  return { hasZeroCost: zeroCostItems.length > 0, zeroCostItems, message: zeroCostItems.length ? NOTICE : '' };
}
async function recordApproval(request, items, user, transaction) {
  const notice = zeroCostNotice(items);
  if (!notice.hasZeroCost) return;
  await recordBusinessAction({ businessType: 'purchase_request', businessId: request.request_id,
    businessNo: request.request_no, action: 'zero_cost_purchase_approved', user,
    comment: NOTICE, detail: { version: 1, items: notice.zeroCostItems }, transaction });
}
async function recordReceipt(inbound, item, sn, user, transaction) {
  if (!inbound.purchase_request_id || Number(item.unit_price) !== 0 || !item.purchase_request_item_id) return;
  const logs = await M.BusinessActionLog.findAll({ where: { business_type: 'purchase_request',
    business_id: inbound.purchase_request_id, action: 'zero_cost_purchase_approved' }, transaction });
  const confirmed = logs.some(log => {
    let detail; try { detail = typeof log.detail_json === 'string' ? JSON.parse(log.detail_json) : log.detail_json; } catch (_) { return false; }
    return detail?.version === 1 && detail.items?.some(row => String(row.itemId) === String(item.purchase_request_item_id)
      && String(row.productId) === String(item.product_id) && row.unitPrice === 0);
  });
  if (!confirmed) return;
  await recordBusinessAction({ businessType: sn ? 'sn' : 'inbound_item', businessId: String(sn?.sn_id || item.item_id),
    businessNo: inbound.inbound_no, action: 'zero_cost_purchase_received', user,
    comment: '原采购审批已确认零成本，本次入库继承该依据',
    detail: { requestId: inbound.purchase_request_id, requestItemId: item.purchase_request_item_id,
      inboundId: inbound.inbound_id, inboundItemId: item.item_id, productId: item.product_id, after: { inbound_price: 0 } }, transaction });
}
module.exports = { zeroCostNotice, recordApproval, recordReceipt };
