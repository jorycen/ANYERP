/**
 * 销售管理控制器
 */
const { Order, OrderItem, OrderPayment, OrderAttachment, Store, Staff, Product, ProductPn, ProductSn, ProductPrice, Inventory, PaymentMethod, sequelize } = require('../../models');
const { Op } = require('sequelize');
const { generateOrderNo, generateUUID, paginate, formatPaginatedResult } = require('../../utils');

function chinaDateBoundary(dateText, endOfDay = false) {
  if (!dateText) return null;
  const value = String(dateText).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+08:00`);
  }
  return new Date(value);
}

function buildChinaDateRange(startDate, endDate) {
  const range = {};
  if (startDate) {
    const start = chinaDateBoundary(startDate, false);
    if (!isNaN(start.getTime())) range[Op.gte] = start;
  }
  if (endDate) {
    const end = chinaDateBoundary(endDate, true);
    if (!isNaN(end.getTime())) range[Op.lte] = end;
  }
  return Object.keys(range).length ? range : null;
}

/**
 * 销售订单列表
 */
async function list(ctx) {
  const {
    storeId, startDate, endDate, customerPhone, orderNo,
    status, createUser, pnCode, snCode,
    page = 1, pageSize = 20
  } = ctx.query;
  const user = ctx.state.user;

  const where = { is_deleted: 0 };
  const regionCodes = Array.isArray(user.regionCodes) ? user.regionCodes.filter(Boolean) : [];

  const dateRange = buildChinaDateRange(startDate, endDate);
  if (dateRange) {
    where.create_time = dateRange;
  }
  if (customerPhone) {
    where.customer_phone = { [Op.like]: `%${customerPhone}%` };
  }
  if (orderNo) {
    where.order_no = { [Op.like]: `%${orderNo}%` };
  }
  if (status) {
    where.order_status = status;
  }
  if (createUser) {
    where.create_user = { [Op.like]: `%${createUser}%` };
  }

  if (storeId) {
    where.store_id = storeId;
  } else if (user.storeId && !['boss', 'admin'].includes(user.roleCode)) {
    where.store_id = user.storeId;
  } else if (regionCodes.length > 0 && !regionCodes.includes('*')) {
    const stores = await Store.findAll({ where: { region_id: regionCodes } });
    const storeIds = stores.map(s => s.store_id);
    if (storeIds.length === 0) {
      ctx.body = formatPaginatedResult([], { page, pageSize, count: 0 });
      return;
    }
    where.store_id = storeIds;
  }

  const itemWhere = {};
  if (pnCode) itemWhere.pn_code = { [Op.like]: `%${pnCode}%` };
  if (snCode) itemWhere.sn_code = { [Op.like]: `%${snCode}%` };
  const itemInclude = { model: OrderItem };
  if (Object.keys(itemWhere).length > 0) {
    itemInclude.where = itemWhere;
    itemInclude.required = true;
  }

  const { count, rows } = await Order.findAndCountAll({
    where,
    include: [
      { model: Store },
      itemInclude,
      { model: OrderPayment }
    ],
    distinct: true,
    order: [['create_time', 'DESC']],
    ...paginate({}, { page, pageSize })
  });

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

/**
 * 检查销售价格是否需要审批（价格从ProductPrice表读取）
 */
async function checkPriceApproval(items) {
  const productIds = [...new Set(items.map(i => i.productId).filter(Boolean))];
  if (productIds.length === 0) return [];

  const productPrices = await ProductPrice.findAll({
    where: { product_id: { [Op.in]: productIds } }
  });
  const priceMap = new Map();
  productPrices.forEach(p => priceMap.set(p.product_id, p));

  const belowPriceItems = [];
  for (const item of items) {
    const price = priceMap.get(item.productId);
    if (!price || !price.min_sale_price || parseFloat(price.min_sale_price) <= 0) continue;
    const minPrice = parseFloat(price.min_sale_price);
    if (parseFloat(item.salePrice) < minPrice) {
      belowPriceItems.push({
        productId: item.productId,
        productName: item.productName,
        salePrice: item.salePrice,
        standardPrice: price.standard_price,
        minSalePrice: price.min_sale_price
      });
    }
  }
  return belowPriceItems;
}

/**
 * 创建销售订单
 */
function firstNonEmpty(source, keys, defaultValue = '') {
  for (const key of keys) {
    const value = source && source[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return typeof value === 'string' ? value.trim() : value;
    }
  }
  return defaultValue;
}

function pickOrderItemsPayload(data = {}) {
  const candidates = [
    data.items,
    data.goods,
    data.OrderItems,
    data.orderItems,
    data.order_items,
    data.productItems,
    data.saleItems,
    data.salesItems,
    data.itemList,
    data.goodsList,
    data.products
  ];
  return candidates.find(Array.isArray) || [];
}

function normalizeOrderItemInput(item = {}) {
  const rawSalePrice = firstNonEmpty(item, ['salePrice', 'sale_price', 'SALE_PRICE', 'unitPrice', 'unit_price', 'price'], null);
  const rawQuantity = firstNonEmpty(item, ['quantity', 'QUANTITY'], null);
  const rawSubtotal = firstNonEmpty(item, ['subtotal', 'SUBTOTAL'], null);
  const salePrice = rawSalePrice === null ? undefined : Number(rawSalePrice);
  const quantity = rawQuantity === null ? undefined : (Number(rawQuantity) || 1);
  const subtotal = rawSubtotal === null
    ? (salePrice !== undefined && quantity !== undefined ? salePrice * quantity : undefined)
    : Number(rawSubtotal);

  return {
    item_id: firstNonEmpty(item, ['itemId', 'item_id', 'ITEM_ID', 'orderItemId', 'order_item_id', '_id', 'id']),
    product_id: firstNonEmpty(item, ['productId', 'product_id', 'PRODUCT_ID']),
    product_name: firstNonEmpty(item, ['productName', 'product_name', 'PRODUCT_NAME', 'name']),
    pn_code: firstNonEmpty(item, ['pnCode', 'pn_code', 'PN_CODE', 'pn', 'PN']),
    mtm_code: firstNonEmpty(item, ['mtmCode', 'mtm_code', 'MTM_CODE']),
    sn_id: firstNonEmpty(item, ['snId', 'sn_id', 'SN_ID', 'inventoryId', 'inventory_id', 'INVENTORY_ID', 'inventorySnId', 'inventory_sn_id']),
    sn_code: firstNonEmpty(item, ['snCode', 'sn_code', 'SN_CODE', 'sn', 'SN', 'serialNo', 'serial_no', 'productSn', 'product_sn']),
    imei1: firstNonEmpty(item, ['imei1', 'imei_1', 'IMEI1']),
    imei2: firstNonEmpty(item, ['imei2', 'imei_2', 'IMEI2']),
    sale_price: salePrice,
    quantity,
    subtotal
  };
}

function compactUpdatePayload(payload) {
  const result = {};
  Object.keys(payload).forEach(key => {
    const value = payload[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      result[key] = value;
    }
  });
  return result;
}

function findMatchingOrderItem(existingItems, existingById, normalized, index) {
  if (normalized.item_id && existingById.has(String(normalized.item_id))) {
    return existingById.get(String(normalized.item_id));
  }
  const byProductPn = existingItems.find(item =>
    normalized.product_id &&
    String(item.product_id || '') === String(normalized.product_id) &&
    (!normalized.pn_code || String(item.pn_code || '') === String(normalized.pn_code))
  );
  return byProductPn || existingItems[index];
}

async function syncOrderItemsFromPayload(order, data = {}) {
  const rawItems = pickOrderItemsPayload(data);
  if (!Array.isArray(rawItems) || rawItems.length === 0) return [];

  const existingItems = await OrderItem.findAll({
    where: { order_id: order.order_id },
    order: [['item_id', 'ASC']]
  });
  const existingById = new Map(existingItems.map(item => [String(item.item_id), item]));
  const results = [];

  for (let index = 0; index < rawItems.length; index++) {
    const normalized = normalizeOrderItemInput(rawItems[index]);
    const existing = findMatchingOrderItem(existingItems, existingById, normalized, index);
    if (!existing) continue;

    const updatePayload = compactUpdatePayload({
      product_id: normalized.product_id,
      product_name: normalized.product_name,
      pn_code: normalized.pn_code,
      mtm_code: normalized.mtm_code,
      sn_id: normalized.sn_id,
      sn_code: normalized.sn_code,
      imei1: normalized.imei1,
      imei2: normalized.imei2,
      sale_price: normalized.sale_price,
      quantity: normalized.quantity,
      subtotal: normalized.subtotal
    });

    if (Object.keys(updatePayload).length === 0) continue;
    await existing.update(updatePayload);
    Object.assign(existing, updatePayload);
    results.push({ item_id: existing.item_id, updated: updatePayload });
  }

  console.log('[Sales] synced order items from payload:', JSON.stringify({
    orderId: order.order_id,
    orderNo: order.order_no,
    payloadCount: rawItems.length,
    results
  }));
  return results;
}

async function create(ctx) {
  const user = ctx.state.user;
  const {
    customerName, customerPhone, customerSource,
    items, payments, discountAmount = 0,
    nationalSubsidy = 0, educationSubsidy = 0,
    invoiceStatus = '不开票', remark, storeId, status, orderStatus
  } = ctx.request.body;

  const orderNo = generateOrderNo();
  const orderId = generateUUID();
  const actualStoreId = storeId || user.storeId || '';

  const totalAmount = items.reduce((sum, item) => sum + Number(item.subtotal || 0), 0);
  const actualPayment = totalAmount - Number(discountAmount) - Number(nationalSubsidy) - Number(educationSubsidy);

  const belowPriceItems = await checkPriceApproval(items);
  const needsApproval = belowPriceItems.length > 0;

  const productIds = [...new Set(items.map(i => i.productId).filter(Boolean))];
  const products = await Product.findAll({
    where: { product_id: { [Op.in]: productIds } }
  });
  const productMap = new Map();
  products.forEach(p => productMap.set(p.product_id, p));

  for (const item of items) {
    const product = productMap.get(item.productId);
    if (!product) {
      ctx.throw(400, `商品 ${item.productId} 不存在`);
    }

  }

  const finalOrderStatus = status || orderStatus || (needsApproval ? 'pending_approval' : '未归档');

  const order = await Order.create({
    order_id: orderId,
    order_no: orderNo,
    store_id: actualStoreId,
    create_user: user.name,
    customer_name: customerName,
    customer_phone: customerPhone,
    customer_source: customerSource,
    total_amount: totalAmount,
    discount_amount: discountAmount,
    national_subsidy: nationalSubsidy,
    education_subsidy: educationSubsidy,
    actual_payment: actualPayment,
    invoice_status: invoiceStatus,
    order_status: finalOrderStatus,
    remark: remark || (needsApproval ? '售价低于定价, 待审批' : '')
  });

  for (const item of items) {
    await OrderItem.create({
      order_id: orderId,
      product_id: item.productId,
      product_name: item.productName,
      pn_code: item.pnCode,
      sn_id: item.snId,
      sn_code: item.snCode,
      imei1: item.imei1,
      imei2: item.imei2,
      sale_price: item.salePrice,
      quantity: item.quantity || 1,
      subtotal: item.subtotal
    });
  }

  for (const payment of payments) {
    await OrderPayment.create({
      order_id: orderId,
      payment_method: payment.method,
      amount: payment.amount
    });
  }

  ctx.body = {
    orderId, orderNo,
    needsApproval,
    belowPriceItems,
    message: needsApproval ? '订单已创建，售价低于定价需要审批' : '订单创建成功'
  };
}

/**
 * 订单详情
 */
async function detail(ctx) {
  const { orderId } = ctx.params;

  const order = await Order.findByPk(orderId, {
    include: [
      { model: Store },
      { model: OrderItem },
      { model: OrderPayment },
      { model: OrderAttachment }
    ]
  });

  if (!order) {
    ctx.throw(404, '订单不存在');
  }

  const result = order.toJSON();
  const items = result.OrderItems || [];
  const snCodes = items.map(item => item.sn_code).filter(Boolean);
  if (snCodes.length > 0) {
    const snRows = await ProductSn.findAll({
      where: { sn_code: { [Op.in]: snCodes } },
      attributes: ['sn_code', 'pn_code', 'inventory_type'],
      raw: true
    });
    const snMap = new Map(snRows.map(sn => [`${sn.pn_code || ''}|${sn.sn_code}`, sn]));
    result.OrderItems = items.map(item => {
      const sn = snMap.get(`${item.pn_code || ''}|${item.sn_code}`) || snRows.find(row => row.sn_code === item.sn_code);
      return {
        ...item,
        pn_code: item.pn_code || sn?.pn_code || '',
        sn_code: item.sn_code || '',
        inventory_type: item.inventory_type || sn?.inventory_type || ''
      };
    });
  }

  ctx.body = result;
}

/**
 * 审批通过
 */
async function approve(ctx) {
  const { orderId } = ctx.params;
  const user = ctx.state.user;

  const allowedRoles = ['boss', 'admin', 'manager'];
  if (!allowedRoles.includes(user.roleCode)) {
    ctx.throw(403, '仅店长或经销商总账号可以审批');
  }

  const order = await Order.findByPk(orderId);
  if (!order) ctx.throw(404, '订单不存在');
  if (order.order_status !== 'pending_approval') {
    ctx.throw(400, '该订单无需审批');
  }

  await order.update({
    order_status: '未归档',
    remark: (order.remark || '') + '\n已审批通过',
    update_time: new Date()
  });

  ctx.body = { code: 0, message: '审批通过，订单待归档' };
}

/**
 * 审批拒绝
 */
async function reject(ctx) {
  const { orderId } = ctx.params;
  const user = ctx.state.user;

  const allowedRoles = ['boss', 'admin', 'manager'];
  if (!allowedRoles.includes(user.roleCode)) {
    ctx.throw(403, '仅店长或经销商总账号可以审批');
  }

  const order = await Order.findByPk(orderId);
  if (!order) ctx.throw(404, '订单不存在');
  if (order.order_status !== 'pending_approval') {
    ctx.throw(400, '该订单无需审批');
  }

  const { reason } = ctx.request.body;

  await order.update({
    order_status: 'cancelled',
    remark: (order.remark || '') + '\n审批拒绝: ' + (reason || '无'),
    update_time: new Date()
  });

  ctx.body = { code: 0, message: '已拒绝' };
}

/**
 * 更新订单
 */
async function update(ctx) {
  const { orderId } = ctx.params;
  const data = ctx.request.body;

  const order = await Order.findByPk(orderId);
  if (!order) {
    ctx.throw(404, '订单不存在');
  }

  const nextStatus = data.order_status || data.status;
  if (isArchiveStatus(nextStatus) && !isArchiveStatus(order.order_status)) {
    await syncOrderItemsFromPayload(order, data);
    await validateAndDeductInventoryForArchive(order, data);
    data.order_status = '已归档';
    data.status = '已归档';
    syncToDailyStatement(orderId, order.store_id).catch(err => console.error('[DailySync] archive error:', err.message));
  }

  await order.update(data);
  ctx.body = { message: '订单更新成功' };
}

/**
 * 销售统计
 */
async function updateOrderItems(ctx) {
  const data = ctx.request.body || {};
  const orderNo = firstNonEmpty(data, ['orderNo', 'order_no', 'ORDER_NO']);
  const orderId = firstNonEmpty(data, ['orderId', 'order_id', 'ORDER_ID']);

  if (!orderId && !orderNo) {
    ctx.throw(400, 'Order number is required');
  }

  const order = await Order.findOne({ where: orderId ? { order_id: orderId } : { order_no: orderNo } });
  if (!order) {
    ctx.throw(404, 'Order not found');
  }

  const results = await syncOrderItemsFromPayload(order, data);
  ctx.body = {
    code: 0,
    message: 'Order items updated',
    data: {
      orderId: order.order_id,
      orderNo: order.order_no,
      results
    }
  };
}

async function stats(ctx) {
  const { storeId, startDate, endDate } = ctx.query;
  const user = ctx.state.user;

  const whereStore = {};
  if (!user.regionCodes.includes('*')) {
    whereStore.region_id = user.regionCodes;
  }
  if (storeId) whereStore.store_id = storeId;

  const stores = await Store.findAll({ where: whereStore });
  const storeIds = stores.map(s => s.store_id);

  const where = {
    is_deleted: 0,
    store_id: storeIds
  };

  if (startDate && endDate) {
    where.create_time = {
      [Op.gte]: new Date(startDate),
      [Op.lte]: new Date(endDate + ' 23:59:59')
    };
  }

  const statsByStore = await Order.findAll({
    where,
    attributes: [
      'store_id',
      [sequelize.fn('COUNT', sequelize.col('order_id')), 'orderCount'],
      [sequelize.fn('SUM', sequelize.col('total_amount')), 'totalAmount'],
      [sequelize.fn('SUM', sequelize.col('actual_payment')), 'actualPayment']
    ],
    include: [{ model: Store, attributes: ['name'] }],
    group: ['store_id'],
    raw: true
  });

  ctx.body = { statsByStore };
}

/**
 * 获取支付方式列表
 */
async function paymentMethods(ctx) {
  const methods = await PaymentMethod.findAll({
    where: { status: 1 },
    order: [['sort_order', 'ASC']]
  });
  ctx.body = { code: 0, data: methods, message: 'success' };
}

async function getProductPns(ctx) {
  const { storeId, productId } = ctx.params;
  const product = await Product.findByPk(productId);
  if (!product) {
    ctx.throw(404, '商品不存在');
  }

  if (product.need_sn === 1) {
    const snRecords = await ProductSn.findAll({
      where: {
        product_id: productId,
        store_id: storeId,
        status: 'in_stock',
        is_deleted: 0
      },
      attributes: ['pn_code'],
      group: ['pn_code'],
      raw: true
    });
    ctx.body = { code: 0, data: snRecords.map(s => s.pn_code).filter(Boolean) };
    return;
  }

  const inv = storeId ? await Inventory.findOne({ where: { product_id: productId, store_id: storeId } }) : null;
  const normalStock = inv ? Math.max(
    Number(inv.normal_qty || 0),
    Number(inv.regular_qty || 0) + Number(inv.subsidy_qty || 0) + Number(inv.second_qty || 0)
  ) : 0;
  const totalStock = inv ? normalStock + Number(inv.display_qty || 0) : 0;
  if (totalStock <= 0) {
    ctx.body = { code: 0, data: [] };
    return;
  }

  const pnRecords = await ProductPn.findAll({
    where: { product_id: productId, is_deleted: 0 },
    attributes: ['pn_code'],
    order: [['pn_code', 'ASC']],
    raw: true
  });
  const allPnCodes = new Set((product.manufacturer_code || '').split(/[,\s，、]+/).filter(Boolean));
  for (const pn of pnRecords) {
    if (pn.pn_code) allPnCodes.add(pn.pn_code);
  }

  ctx.body = { code: 0, data: [...allPnCodes] };
}

async function getProductSns(ctx) {
  const { storeId, productId } = ctx.params;
  const { pnCode } = ctx.query;

  const where = {
    product_id: productId,
    store_id: storeId,
    status: 'in_stock',
    is_deleted: 0
  };
  if (pnCode) {
    where.pn_code = pnCode;
  }

  const snRecords = await ProductSn.findAll({
    where,
    attributes: ['sn_id', 'sn_code', 'pn_code', 'inventory_type'],
    order: [['sn_code', 'ASC']]
  });

  ctx.body = {
    code: 0,
    data: snRecords.map(s => ({
      sn_id: s.sn_id,
      sn_code: s.sn_code,
      pn_code: s.pn_code,
      inventory_type: s.inventory_type
    }))
  };
}

function isArchiveStatus(status) {
  return ['已归档', 'completed', 'archived'].includes(String(status || ''));
}

function archiveError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

async function validateAndDeductInventoryForArchive(order, payload = {}) {
  await syncOrderItemsFromPayload(order, payload);
  const items = await OrderItem.findAll({ where: { order_id: order.order_id }, order: [['item_id', 'ASC']] });
  if (!items.length) {
    throw archiveError('订单中没有商品，无法归档');
  }

  const productIds = [...new Set(items.map(i => i.product_id).filter(Boolean))];
  const products = await Product.findAll({ where: { product_id: { [Op.in]: productIds } } });
  const productMap = new Map(products.map(product => [product.product_id, product]));
  const operations = [];

  for (const item of items) {
    const product = productMap.get(item.product_id);
    if (!product) {
      throw archiveError(`商品 ${item.product_id || item.product_name || ''} 不存在`);
    }

    const quantity = Number(item.quantity || 1);
    if (product.need_sn === 1) {
      const snCode = String(item.sn_code || '').trim();
      if (!snCode) {
        throw archiveError(`商品 ${item.product_name || product.name} 需要SN管理，请先补充SN码后再归档`);
      }

      const snWhere = {
        sn_code: snCode,
        product_id: item.product_id,
        store_id: order.store_id,
        status: 'in_stock',
        is_deleted: 0
      };
      if (item.pn_code) snWhere.pn_code = item.pn_code;

      const snRecord = await ProductSn.findOne({ where: snWhere });
      if (!snRecord) {
        throw archiveError(`SN码 [${snCode}] 在当前门店没有可用库存，不能归档`);
      }

      operations.push({
        item,
        product,
        quantity,
        snRecord,
        inventoryType: snRecord.inventory_type || 'normal_qty'
      });
    } else {
      const inv = await Inventory.findOne({
        where: { product_id: item.product_id, store_id: order.store_id }
      });
      const normalStock = inv ? Math.max(
        Number(inv.normal_qty || 0),
        Number(inv.regular_qty || 0) + Number(inv.subsidy_qty || 0) + Number(inv.second_qty || 0)
      ) : 0;
      const totalStock = inv ? normalStock + Number(inv.display_qty || 0) : 0;
      if (totalStock < quantity) {
        throw archiveError(`商品 ${item.product_name || product.name} 库存不足(可用:${totalStock}, 需要:${quantity})，不能归档`);
      }

      operations.push({
        item,
        product,
        quantity,
        inventoryType: 'normal_qty'
      });
    }
  }

  for (const op of operations) {
    if (op.snRecord) {
      await op.snRecord.update({ status: 'sold' });
      if (!op.item.sn_id) {
        await op.item.update({ sn_id: op.snRecord.sn_id });
      }
    }

    await _deductInventory(op.item.product_id, order.store_id, op.inventoryType, op.quantity);
  }
}

module.exports = { list, create, detail, update, updateOrderItems, stats, approve, reject, paymentMethods, getProductPns, getProductSns };

const INVENTORY_COLUMN_MAP = {
  normal_qty: 'normal_qty',
  display_qty: 'display_qty',
  demo_qty: 'demo_qty',
  unsellable_qty: 'unsellable_qty',
  pending_qty: 'pending_qty'
};

async function _deductInventory(productId, storeId, inventoryType, quantity) {
  const column = INVENTORY_COLUMN_MAP[inventoryType] || 'normal_qty';
  const inv = await Inventory.findOne({
    where: { product_id: productId, store_id: storeId }
  });
  if (inv) {
    const qty = Number(quantity) || 0;
    const detailColumns = ['regular_qty', 'subsidy_qty', 'second_qty'];
    const detailTotal = detailColumns.reduce((sum, key) => sum + Number(inv[key] || 0), 0);
    const currentVal = column === 'normal_qty'
      ? Math.max(Number(inv.normal_qty || 0), detailTotal)
      : Number(inv[column] || 0);
    const deductFromColumn = Math.min(currentVal, qty);
    let remaining = qty - deductFromColumn;
    const payload = { [column]: currentVal - deductFromColumn };

    if (column === 'normal_qty') {
      let detailRemaining = deductFromColumn;
      for (const detailColumn of detailColumns) {
        if (detailRemaining <= 0) break;
        const currentDetail = Number(inv[detailColumn] || 0);
        const deduct = Math.min(currentDetail, detailRemaining);
        payload[detailColumn] = currentDetail - deduct;
        detailRemaining -= deduct;
      }

      if (remaining > 0) {
        const displayQty = Number(inv.display_qty || 0);
        const displayDeduct = Math.min(displayQty, remaining);
        payload.display_qty = displayQty - displayDeduct;
      }
    }

    await inv.update(payload);
  }
}

/**
 * 同步已完成订单到日结单
 */
async function syncToDailyStatement(orderId, storeId) {
  try {
    const { DailyStatement, DailyStatementDetail, PaymentMethodStore, SettlementAccount, PaymentMethod } = require('../../models');
    const order = await Order.findByPk(orderId, {
      include: [{ model: OrderPayment }, { model: OrderItem }]
    });
    if (!order) return;

    const dateStr = new Date().toISOString().slice(0, 10);

    // 加载所有支付方式字典
    const paymentMethods = await PaymentMethod.findAll({ where: { status: 1 } });
    const paymentMethodMap = {};
    for (const pm of paymentMethods) {
      paymentMethodMap[pm.code] = pm.name;
    }

    const [statement] = await DailyStatement.findOrCreate({
      where: { store_id: storeId, statement_date: dateStr },
      defaults: {
        statement_id: generateUUID(),
        store_id: storeId,
        statement_date: dateStr,
        total_revenue: 0,
        total_order_count: 0,
        total_settled: 0,
        status: 'pending'
      }
    });

    for (const payment of order.OrderPayments || []) {
      const settleAccountId = await resolveSettlementAccount(storeId, payment.payment_method);
      const paymentMethodName = paymentMethodMap[payment.payment_method] || payment.payment_method;

      const existing = await DailyStatementDetail.findOne({
      where: { statement_id: statement.statement_id, order_id: orderId, payment_code: paymentMethodName }
    });
    if (existing) {
      await existing.update({
        amount: payment.amount,
        settlement_account_id: settleAccountId,
        payment_method: paymentMethodName,
        payment_code: paymentMethodName,
          customer_name: order.customer_name,
          order_no: order.order_no
        });
      } else {
        await DailyStatementDetail.create({
          detail_id: generateUUID(),
          statement_id: statement.statement_id,
          order_id: orderId,
          order_no: order.order_no,
          customer_name: order.customer_name || '',
          payment_method: paymentMethodName,
          payment_code: paymentMethodName,
          amount: payment.amount,
          settlement_account_id: settleAccountId,
          settled: 0
        });
      }
    }

    const details = await DailyStatementDetail.findAll({
      where: { statement_id: statement.statement_id },
      attributes: ['order_id', 'amount']
    });
    const orderIds = [...new Set(details.map(d => d.order_id))];
    const totalRevenue = details.reduce((s, d) => s + parseFloat(d.amount || 0), 0);

    await statement.update({
      total_revenue: totalRevenue,
      total_order_count: orderIds.length
    });
  } catch (err) {
    console.error('[DailySync] Error:', err.message);
  }
}

async function resolveSettlementAccount(storeId, paymentMethodName) {
  try {
    const { PaymentMethod, PaymentMethodStore } = require('../../models');
    const pm = await PaymentMethod.findOne({ where: { name: paymentMethodName, status: 1 } });
    if (!pm) return null;

    if (pm.is_global === 1) return pm.settlement_account_id || null;

    const storeCfg = await PaymentMethodStore.findOne({
      where: { method_id: pm.method_id, store_id: storeId }
    });
    return storeCfg?.settlement_account_id || null;
  } catch (err) {
    console.error('[resolveSettlementAccount] Error:', err.message);
    return null;
  }
}
