// Keep the existing persisted pending/completed states compatible with all consumers.
// The API exposes the more precise progress state without changing financial workflows.
function summarize(items, status = 'pending') {
  const expectedQuantity = items.reduce((sum, item) => sum + Number(item.original_quantity ?? item.quantity ?? 0), 0);
  const receivedQuantity = items.reduce((sum, item) => sum + Number(item.received_quantity || 0), 0);
  const remainingQuantity = Math.max(0, expectedQuantity - receivedQuantity);
  const progressStatus = ['pending', 'completed'].includes(status)
    ? remainingQuantity > 0 ? receivedQuantity > 0 ? 'partially_received' : 'pending' : 'completed'
    : status;
  return { expectedQuantity, receivedQuantity, remainingQuantity, progressStatus,
    statusLabel: ({pending:'待入库',partially_received:'部分入库',completed:'已完成',cancelled:'已取消',returned:'已退库'})[progressStatus] || progressStatus };
}
function attach(result) {
  const purchase = String(result.source_type || '').toLowerCase() === 'purchase' || result.purchase_request_id;
  if (purchase) {
    Object.assign(result, summarize(result.items || [], result.status));
    result.canReceive = result.status === 'pending' && result.remainingQuantity > 0;
    if (result.status === 'completed' && result.remainingQuantity > 0) result.statusLabel = '数量异常待核对';
  }
  return result;
}
module.exports = { summarize, attach };
