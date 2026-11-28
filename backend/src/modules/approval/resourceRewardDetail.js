const M = require('../../models');
const { Op, QueryTypes } = require('sequelize');

// Read-only enrichment after the approval instance's existing access check.
// Match the actual serial item; never infer purchase origin from a store/PN alone.
async function resourceRewardDetail(businessId) {
  const change = await M.ResourceRightChangeOrder.findByPk(businessId);
  if (!change) return null;
  const sn = change.sn_id ? await M.ProductSn.findByPk(change.sn_id) : null;
  const order = change.related_sale_order_id ? await M.Order.findByPk(change.related_sale_order_id) : null;
  const serial = [...(change.sn_id ? [{ sn_id: change.sn_id }] : []), ...(change.sn_code ? [{ sn_code: change.sn_code }] : [])];
  const items = order && serial.length ? await M.OrderItem.findAll({ where: { order_id: order.order_id,
    product_id: change.product_id, [Op.or]: serial }, raw: true }) : [];
  const item = items.length === 1 ? items[0] : null;
  const product = change.product_id ? await M.Product.findByPk(change.product_id, { attributes: ['name'] }) : null;
  const purchases = change.sn_id ? await M.sequelize.query(`SELECT i.INBOUND_NO inboundNo,
      pr.REQUEST_NO requestNo,s.NAME supplierName
    FROM T_INBOUND i JOIN T_INBOUND_ITEM ii ON ii.INBOUND_ID=i.INBOUND_ID
    LEFT JOIN T_INBOUND_ITEM_SN link ON link.INBOUND_ITEM_ID=ii.ITEM_ID AND link.SN_ID=:snId
    LEFT JOIN T_PURCHASE_REQUEST pr ON pr.REQUEST_ID=i.PURCHASE_REQUEST_ID
      OR (i.PURCHASE_REQUEST_ID IS NULL AND pr.REQUEST_NO=i.SOURCE_NO)
    LEFT JOIN T_SUPPLIER s ON s.SUPPLIER_ID=pr.SUPPLIER_ID
    WHERE i.STATUS='completed' AND i.SOURCE_TYPE='purchase' AND ii.PRODUCT_ID=:productId
      AND (link.SN_ID=:snId OR ii.SN_ID=:snId)
      AND COALESCE(i.RECEIVE_TIME,i.CREATE_TIME)<=:cutoff
    ORDER BY COALESCE(i.RECEIVE_TIME,i.CREATE_TIME),i.INBOUND_NO LIMIT 1`, {
    replacements: { snId: change.sn_id, productId: change.product_id,
      cutoff: order?.archive_time || order?.create_time || change.create_time || new Date() }, type: QueryTypes.SELECT
  }) : [];
  const origin = purchases[0];
  return { product_name: item?.product_name || product?.name || '', pn_code: item?.pn_code || sn?.pn_code || '',
    sn_code: item?.sn_code || change.sn_code || sn?.sn_code || '', order_no: order?.order_no || '',
    original_supplier_name: origin?.supplierName || item?.supplier_name || sn?.supplier_name || '',
    original_purchase_no: origin?.requestNo || '', original_inbound_no: origin?.inboundNo || '' };
}
module.exports = { resourceRewardDetail };
