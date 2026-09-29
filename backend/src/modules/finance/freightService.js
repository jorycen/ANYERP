const { Op } = require('sequelize');
const {
  FreightPlatform,
  FreightRecord,
  FreightRecordItem,
  Order,
  OrderItem,
  Store,
  sequelize
} = require('../../models');
const { generateUUID } = require('../../utils');

function toMoney(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0;
}

function normalizePlatformId(value) {
  return String(value || '').trim();
}

async function resolvePlatform(platformId, platformName, transaction) {
  const id = normalizePlatformId(platformId);
  const name = String(platformName || '').trim();
  if (!id && !name) return null;
  const platform = await FreightPlatform.findOne({
    where: id ? { platform_id: id, status: 1 } : { platform_name: name, status: 1 },
    transaction
  });
  if (!platform) {
    const error = new Error('配送平台不存在或已停用');
    error.status = 400;
    throw error;
  }
  return platform;
}

async function getStoreName(storeId, transaction) {
  if (!storeId) return '';
  const store = await Store.findByPk(storeId, { attributes: ['store_id', 'name'], transaction, raw: true });
  return store?.name || '';
}

function allocateAmount(totalAmount, items) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return [];
  const weights = rows.map(row => Math.max(0, Number(row.quantity || 0)));
  const weightTotal = weights.reduce((sum, value) => sum + value, 0) || rows.length;
  let allocated = 0;
  return rows.map((row, index) => {
    const quantity = Math.max(1, Number(row.quantity || 1));
    const amount = index === rows.length - 1
      ? toMoney(totalAmount - allocated)
      : toMoney(totalAmount * (weights[index] || 1) / weightTotal);
    allocated = toMoney(allocated + amount);
    return {
      ...row,
      quantity,
      allocatedAmount: amount,
      unitAmount: toMoney(amount / quantity)
    };
  });
}

async function syncFreightRecord({
  sourceType,
  sourceId,
  sourceNo,
  platformId,
  platformName,
  amount,
  storeId,
  fromStoreId,
  toStoreId,
  items = [],
  status = 'active',
  user,
  transaction = null
}) {
  const numericAmount = toMoney(amount);
  const platform = await resolvePlatform(platformId, platformName, transaction);
  if (numericAmount > 0 && !platform) {
    const error = new Error('填写运费金额后请选择配送平台');
    error.status = 400;
    throw error;
  }
  const [storeName, fromStoreName, toStoreName] = await Promise.all([
    getStoreName(storeId, transaction),
    getStoreName(fromStoreId, transaction),
    getStoreName(toStoreId, transaction)
  ]);
  const existing = await FreightRecord.findOne({ where: { source_type: sourceType, source_id: sourceId }, transaction });
  const payload = {
    source_type: sourceType,
    source_id: sourceId,
    source_no: sourceNo || '',
    platform_id: platform?.platform_id || null,
    platform_name: platform?.platform_name || String(platformName || '').trim() || null,
    amount: numericAmount,
    store_id: storeId || toStoreId || null,
    store_name: storeName || toStoreName || '',
    from_store_id: fromStoreId || null,
    from_store_name: fromStoreName,
    to_store_id: toStoreId || null,
    to_store_name: toStoreName,
    status: numericAmount > 0 ? status : 'cancelled',
    update_user: user?.name || user?.phone || 'system',
    update_time: new Date()
  };
  const record = existing
    ? await existing.update(payload, { transaction })
    : await FreightRecord.create({
        freight_id: generateUUID(),
        create_user: user?.name || user?.phone || 'system',
        create_time: new Date(),
        ...payload
      }, { transaction });

  await FreightRecordItem.destroy({ where: { freight_id: record.freight_id }, transaction });
  const allocatedRows = allocateAmount(numericAmount, items);
  if (allocatedRows.length && numericAmount > 0) {
    await FreightRecordItem.bulkCreate(allocatedRows.map(row => ({
      freight_id: record.freight_id,
      product_id: row.productId || row.product_id || null,
      sn_id: row.snId || row.sn_id || null,
      sn_code: row.snCode || row.sn_code || null,
      quantity: row.quantity,
      allocated_amount: row.allocatedAmount,
      unit_amount: row.unitAmount,
      create_time: new Date()
    })), { transaction });
  }
  return record;
}

async function setFreightRecordStatus(sourceType, sourceId, status, user, transaction = null) {
  const record = await FreightRecord.findOne({ where: { source_type: sourceType, source_id: sourceId }, transaction });
  if (!record) return null;
  await record.update({
    status,
    update_user: user?.name || user?.phone || 'system',
    update_time: new Date()
  }, { transaction });
  return record;
}

function buildFreightWhere({ startDate, endDate, storeId, platformId, sourceType } = {}) {
  const where = {};
  if (sourceType) where.source_type = sourceType;
  if (platformId) where.platform_id = platformId;
  if (storeId) {
    where[Op.or] = [
      { store_id: storeId },
      { from_store_id: storeId },
      { to_store_id: storeId }
    ];
  }
  if (startDate || endDate) {
    where.create_time = {};
    if (startDate) where.create_time[Op.gte] = new Date(`${startDate}T00:00:00`);
    if (endDate) where.create_time[Op.lte] = new Date(`${endDate}T23:59:59`);
  }
  return where;
}

function freightMatchesOrderItem(record, freightItem, order, orderItem) {
  if (!record || record.status !== 'active' || !order || !orderItem) return false;
  const orderStoreId = String(order.store_id || '').trim();
  const recordStoreId = String(record.store_id || '').trim();
  const destinationStoreId = String(record.to_store_id || '').trim();
  const applicableStoreId = String(record.source_type || '').toLowerCase() === 'transfer'
    ? (destinationStoreId || recordStoreId)
    : recordStoreId;
  if (!orderStoreId || applicableStoreId !== orderStoreId) return false;

  const sourceTime = new Date(record.update_time || record.create_time).getTime();
  const orderTime = new Date(order.create_time).getTime();
  if (Number.isFinite(sourceTime) && Number.isFinite(orderTime) && sourceTime > orderTime) return false;

  const productId = String(orderItem.product_id || '').trim();
  const snId = String(orderItem.sn_id || '').trim();
  const snCode = String(orderItem.sn_code || '').trim();
  return (productId && productId === String(freightItem.product_id || '').trim())
    || (snId && snId === String(freightItem.sn_id || '').trim())
    || (snCode && snCode === String(freightItem.sn_code || '').trim());
}

async function attachRelatedSalesOrders(rows) {
  if (!rows.length) return rows;
  const freightRows = rows.map(row => row.toJSON ? row.toJSON() : row);
  const identifiers = [...new Set(freightRows.flatMap(row => (row.items || []).flatMap(item => [
    item.product_id, item.sn_id, item.sn_code
  ])).map(value => String(value || '').trim()).filter(Boolean))];
  if (!identifiers.length) return rows;

  const orderItems = await OrderItem.findAll({
    where: {
      [Op.or]: identifiers.flatMap(value => [
        { product_id: value }, { sn_id: value }, { sn_code: value }
      ])
    },
    include: [{ model: Order, attributes: ['order_id', 'order_no', 'store_id', 'create_time'], where: { is_deleted: 0 }, required: true }],
    attributes: ['item_id', 'order_id', 'product_id', 'sn_id', 'sn_code'],
    raw: true,
    nest: true
  });

  const candidatesByOrderItem = new Map();
  for (const item of orderItems) {
    const order = item.Order || item.OrderItem?.Order;
    if (!order) continue;
    const key = String(item.item_id);
    const candidates = [];
    for (const record of freightRows) {
      for (const freightItem of record.items || []) {
        if (freightMatchesOrderItem(record, freightItem, order, item)) {
          candidates.push({ record, time: new Date(record.update_time || record.create_time).getTime() || 0 });
        }
      }
    }
    candidates.sort((a, b) => b.time - a.time);
    if (candidates[0]) candidatesByOrderItem.set(key, candidates[0].record.freight_id);
  }

  const orderNosByFreight = new Map();
  for (const item of orderItems) {
    const freightId = candidatesByOrderItem.get(String(item.item_id));
    const order = item.Order || item.OrderItem?.Order;
    if (!freightId || !order?.order_no) continue;
    if (!orderNosByFreight.has(freightId)) orderNosByFreight.set(freightId, new Set());
    orderNosByFreight.get(freightId).add(String(order.order_no));
  }
  rows.forEach(row => {
    const freightId = row.freight_id;
    const orderNos = [...(orderNosByFreight.get(freightId) || [])];
    if (row.setDataValue) row.setDataValue('related_order_nos', orderNos);
    else row.related_order_nos = orderNos;
  });
  return rows;
}

async function listFreightRecords({ filters = {}, user, page = 1, pageSize = 20 } = {}) {
  const where = buildFreightWhere(filters);
  const accessibleStoreIds = user?.accessibleStoreIds || [];
  if (!accessibleStoreIds.includes('*') && accessibleStoreIds.length) {
    const scope = { [Op.or]: accessibleStoreIds.flatMap(id => [
      { store_id: id }, { from_store_id: id }, { to_store_id: id }
    ]) };
    where[Op.and] = [...(where[Op.and] || []), scope];
  }
  const limit = Math.min(Math.max(Number(pageSize) || 20, 1), 200);
  const currentPage = Math.max(Number(page) || 1, 1);
  const result = await FreightRecord.findAndCountAll({
    where,
    include: [{ model: FreightRecordItem, as: 'items', attributes: ['item_id', 'product_id', 'sn_id', 'sn_code', 'quantity', 'allocated_amount', 'unit_amount'] }],
    order: [['create_time', 'DESC'], ['freight_id', 'DESC']],
    offset: (currentPage - 1) * limit,
    limit,
    distinct: true
  });
  await attachRelatedSalesOrders(result.rows);
  return result;
}

async function getFreightExportRows({ filters = {}, user } = {}) {
  const where = buildFreightWhere(filters);
  const accessibleStoreIds = user?.accessibleStoreIds || [];
  if (!accessibleStoreIds.includes('*') && accessibleStoreIds.length) {
    where[Op.and] = [...(where[Op.and] || []), {
      [Op.or]: accessibleStoreIds.flatMap(id => [
        { store_id: id }, { from_store_id: id }, { to_store_id: id }
      ])
    }];
  }
  const rows = await FreightRecord.findAll({
    where,
    include: [{ model: FreightRecordItem, as: 'items', attributes: ['product_id', 'sn_code', 'quantity', 'allocated_amount', 'unit_amount'] }],
    order: [['create_time', 'DESC'], ['freight_id', 'DESC']]
  });
  await attachRelatedSalesOrders(rows);
  return rows;
}

module.exports = {
  toMoney,
  syncFreightRecord,
  setFreightRecordStatus,
  buildFreightWhere,
  listFreightRecords,
  getFreightExportRows
};
