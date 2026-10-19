const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../models');
const { resolveAllReadableStoreIds } = require('../../utils/storePermissions');

// 从已经改变库存的业务单据还原流水，历史单据也能直接查询。
const flowSql = `
  SELECT CONCAT('inbound:', i.ITEM_ID) AS flow_id, b.STORE_ID AS store_id,
    i.PRODUCT_ID AS product_id, i.PRODUCT_NAME AS product_name, i.PN_CODE AS pn_code,
    i.SN_CODE AS sn_code, 'in' AS direction,
    CASE WHEN LOWER(b.SOURCE_TYPE) = 'transfer' THEN '调拨入库'
      WHEN LOWER(b.SOURCE_TYPE) = 'sales_return' THEN '销售退货入库' ELSE '采购/其他入库' END AS business_type,
    i.RECEIVED_QUANTITY AS quantity, b.INBOUND_NO AS document_no,
    COALESCE(i.RECEIVE_TIME, b.RECEIVE_TIME, b.UPDATE_TIME) AS event_time,
    COALESCE(i.RECEIVE_USER, b.RECEIVE_USER, b.CREATE_USER) AS operator_name
  FROM T_INBOUND_ITEM i JOIN T_INBOUND b ON b.INBOUND_ID = i.INBOUND_ID
  WHERE b.STATUS IN ('completed', 'returned') AND i.RECEIVED_QUANTITY > 0
  UNION ALL
  SELECT CONCAT('sale:', i.ITEM_ID), o.STORE_ID, i.PRODUCT_ID, i.PRODUCT_NAME, i.PN_CODE,
    i.SN_CODE, 'out', '销售出库', i.QUANTITY, o.ORDER_NO,
    COALESCE(o.ARCHIVE_TIME, o.UPDATE_TIME), COALESCE(o.APPROVE_USER, o.SUBMIT_USER, o.CREATE_USER)
  FROM T_ORDER_ITEM i JOIN T_ORDER o ON o.ORDER_ID = i.ORDER_ID
  WHERE o.ORDER_STATUS IN ('已归档', 'completed', 'archived', 'return_pending', 'return_rejected', 'returned')
    AND o.IS_DELETED = 0 AND i.PRODUCT_ID IS NOT NULL AND i.QUANTITY > 0
  UNION ALL
  SELECT CONCAT('return:', i.ITEM_ID), r.STORE_ID, i.PRODUCT_ID, i.PRODUCT_NAME, i.PN_CODE,
    i.SN_CODE, 'out', '采购退库', i.QUANTITY, r.RETURN_NO,
    COALESCE(r.EXECUTE_TIME, r.CREATE_TIME), COALESCE(r.EXECUTE_USER, r.CREATE_USER)
  FROM T_RETURN_STOCK_ITEM i JOIN T_RETURN_STOCK r ON r.RETURN_ID = i.RETURN_ID
  WHERE r.STATUS = 'completed' AND i.QUANTITY > 0
  UNION ALL
  SELECT CONCAT('transfer:', i.ITEM_ID), t.FROM_STORE_ID, i.PRODUCT_ID, p.NAME, i.PN_CODE,
    i.SN_CODE, 'out', '调拨出库', i.QUANTITY, t.TRANSFER_NO,
    COALESCE(t.SHIPPING_TIME, t.CREATE_TIME), COALESCE(t.SHIPPING_USER, t.CONFIRM_USER, t.APPLY_USER)
  FROM T_TRANSFER_ITEM i JOIN T_TRANSFER t ON t.TRANSFER_ID = i.TRANSFER_ID
  LEFT JOIN T_PRODUCT p ON p.PRODUCT_ID = i.PRODUCT_ID
  WHERE t.STATUS IN ('out_confirmed', 'completed', 'returned') AND i.QUANTITY > 0
  UNION ALL
  SELECT CONCAT('transfer-return:', l.LOG_ID, ':', i.ITEM_ID), t.FROM_STORE_ID,
    i.PRODUCT_ID, p.NAME, i.PN_CODE, i.SN_CODE, 'in', '调拨退回入库',
    i.QUANTITY, t.TRANSFER_NO, l.CREATE_TIME, l.ACTOR_NAME
  FROM T_TRANSFER_ITEM i JOIN T_TRANSFER t ON t.TRANSFER_ID = i.TRANSFER_ID
  JOIN T_BUSINESS_ACTION_LOG l ON l.BUSINESS_TYPE = 'inventory_transfer'
    AND l.BUSINESS_ID = t.TRANSFER_ID AND l.ACTION = 'returned'
  LEFT JOIN T_PRODUCT p ON p.PRODUCT_ID = i.PRODUCT_ID
  WHERE t.STATUS = 'returned' AND i.QUANTITY > 0
  UNION ALL
  SELECT CONCAT('conversion:', i.ITEM_ID), c.STORE_ID, i.PRODUCT_ID, i.PRODUCT_NAME,
    i.PN_CODE, i.SN_CODE, CASE WHEN i.LINE_ROLE = 'source' THEN 'out' ELSE 'in' END,
    CASE WHEN i.LINE_ROLE = 'source' THEN '拆装耗用' ELSE '拆装产出' END,
    i.QUANTITY, c.CONVERSION_NO, c.CREATE_TIME, c.CREATE_USER
  FROM T_INVENTORY_CONVERSION_ITEM i JOIN T_INVENTORY_CONVERSION c ON c.CONVERSION_ID = i.CONVERSION_ID
  WHERE c.STATUS IN ('completed', 'voided') AND i.LINE_ROLE IN ('source', 'target') AND i.QUANTITY > 0
  UNION ALL
  SELECT CONCAT('conversion-void:', i.ITEM_ID), c.STORE_ID, i.PRODUCT_ID, i.PRODUCT_NAME,
    i.PN_CODE, i.SN_CODE, CASE WHEN i.LINE_ROLE = 'source' THEN 'in' ELSE 'out' END,
    '拆装撤销', i.QUANTITY, c.CONVERSION_NO, c.VOID_TIME, c.VOID_USER
  FROM T_INVENTORY_CONVERSION_ITEM i JOIN T_INVENTORY_CONVERSION c ON c.CONVERSION_ID = i.CONVERSION_ID
  WHERE c.STATUS = 'voided' AND i.LINE_ROLE IN ('source', 'target') AND i.QUANTITY > 0
`;

async function listProductFlow(ctx) {
  const readableStoreIds = await resolveAllReadableStoreIds(ctx.state.user || {});
  const page = Math.max(1, Number.parseInt(ctx.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(ctx.query.pageSize, 10) || 20));
  if (!readableStoreIds.length) {
    ctx.body = { code: 0, data: { list: [], total: 0, page, pageSize } };
    return;
  }
  const conditions = [];
  const replacements = { limit: pageSize, offset: (page - 1) * pageSize };
  if (!readableStoreIds.includes('*')) {
    conditions.push('flow.store_id IN (:readableStoreIds)');
    replacements.readableStoreIds = readableStoreIds;
  }
  const storeId = String(ctx.query.storeId || '').trim();
  if (storeId) {
    if (!readableStoreIds.includes('*') && !readableStoreIds.includes(storeId)) ctx.throw(403, '无权查看该门店流水');
    conditions.push('flow.store_id = :storeId');
    replacements.storeId = storeId;
  }
  const direction = String(ctx.query.direction || '').trim();
  if (direction) {
    if (!['in', 'out'].includes(direction)) ctx.throw(400, '出入库类型无效');
    conditions.push('flow.direction = :direction');
    replacements.direction = direction;
  }
  const keyword = String(ctx.query.keyword || '').trim();
  if (keyword) {
    conditions.push('(flow.product_name LIKE :keyword OR flow.pn_code LIKE :keyword OR flow.sn_code LIKE :keyword OR flow.document_no LIKE :keyword OR p.PRODUCT_CODE LIKE :keyword)');
    replacements.keyword = `%${keyword}%`;
  }
  if (ctx.query.startDate) {
    conditions.push('flow.event_time >= :startDate');
    replacements.startDate = `${String(ctx.query.startDate).slice(0, 10)} 00:00:00`;
  }
  if (ctx.query.endDate) {
    conditions.push('flow.event_time <= :endDate');
    replacements.endDate = `${String(ctx.query.endDate).slice(0, 10)} 23:59:59`;
  }
  const from = `FROM (${flowSql}) flow LEFT JOIN T_STORE s ON s.STORE_ID = flow.store_id LEFT JOIN T_PRODUCT p ON p.PRODUCT_ID = flow.product_id`;
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const [rows, counts] = await Promise.all([
    sequelize.query(`SELECT flow.*, s.NAME AS store_name, p.PRODUCT_CODE AS product_code ${from}${where} ORDER BY flow.event_time DESC, flow.flow_id DESC LIMIT :limit OFFSET :offset`, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(`SELECT COUNT(*) AS total ${from}${where}`, { replacements, type: QueryTypes.SELECT })
  ]);
  ctx.body = { code: 0, data: { list: rows, total: Number(counts[0]?.total || 0), page, pageSize } };
}

module.exports = { listProductFlow };
