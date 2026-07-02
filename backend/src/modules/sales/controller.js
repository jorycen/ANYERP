/**
 * 销售管理控制器
 */
const {
  Order,
  OrderItem,
  OrderPayment,
  OrderAttachment,
  DepositOrder,
  DepositRefund,
  DepositRedemption,
  Store,
  Staff,
  StaffStorePermission,
  Product,
  ProductPn,
  ProductSn,
  ProductPrice,
  Inventory,
  PaymentMethod,
  ManufacturerPriceHistory,
  ManufacturerRebatePolicy,
  RebateEstimate,
  ResourceSettlement,
  InventoryResourceRight,
  SalesSettlementCostAdjustment,
  sequelize
} = require('../../models');
const { Op } = require('sequelize');
const { generateOrderNo, generateUUID, paginate, formatPaginatedResult } = require('../../utils');
const { summariesForSns, lockSaleRights, finishSaleRights, releaseSaleRights, createPendingSettlement, triggerSaleResourceBenefits } = require('../inventory/resourceRights');
const { getUserRoles } = require('../../middleware/permission');

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
async function auxiliaryStaff(ctx) {
  const user = ctx.state.user || {};
  const distributorId = user.distributorId;
  if (!distributorId) ctx.throw(403, '当前账号未绑定经销商');

  // 历史人员可能仍保留 DEFAULT 经销商，但其主门店/授权门店已经属于当前经销商。
  // 辅助销售人应按实际门店归属纳入，不能只依赖 T_STAFF.distributor_id。
  const distributorStores = await Store.findAll({
    where: {
      distributor_id: distributorId,
      is_deleted: 0,
      status: 1
    },
    attributes: ['store_id'],
    raw: true
  });
  const distributorStoreIds = distributorStores.map(store => String(store.store_id));
  const assignedStaffRows = distributorStoreIds.length
    ? await StaffStorePermission.findAll({
      where: { store_id: { [Op.in]: distributorStoreIds } },
      attributes: ['staff_id'],
      raw: true
    })
    : [];
  const assignedStaffIds = [...new Set(assignedStaffRows.map(row => row.staff_id).filter(Boolean))];
  const ownershipConditions = [{ distributor_id: distributorId }];
  if (distributorStoreIds.length) {
    ownershipConditions.push({ store_id: { [Op.in]: distributorStoreIds } });
  }
  if (assignedStaffIds.length) {
    ownershipConditions.push({ staff_id: { [Op.in]: assignedStaffIds } });
  }

  const rows = await Staff.findAll({
    where: {
      [Op.or]: ownershipConditions,
      is_deleted: 0,
      status: 1
    },
    attributes: ['staff_id', 'name', 'phone', 'role_code', 'store_id', 'region_id', 'distributor_id'],
    include: [
      { model: Store, as: 'Store', attributes: ['store_id', 'name', 'region_id', 'distributor_id'], required: false },
      {
        model: Store,
        as: 'AssignedStores',
        attributes: ['store_id', 'name', 'region_id', 'distributor_id'],
        through: { attributes: [] },
        required: false,
        where: { is_deleted: 0, status: 1 }
      }
    ],
    order: [['store_id', 'ASC'], ['name', 'ASC']]
  });

  const list = rows.map(row => {
    const data = row.toJSON();
    const assignedStores = data.AssignedStores || [];
    const allStores = [data.Store].concat(assignedStores).filter(Boolean);
    const primaryStore = allStores.find(store => (
      String(store.distributor_id || '') === String(distributorId) ||
      distributorStoreIds.includes(String(store.store_id || ''))
    )) || data.Store || assignedStores[0] || null;
    const storeNames = assignedStores.map(store => store.name).filter(Boolean);
    if (primaryStore && primaryStore.name && !storeNames.includes(primaryStore.name)) {
      storeNames.unshift(primaryStore.name);
    }

    return {
      staffId: data.staff_id,
      name: data.name,
      phone: data.phone,
      roleCode: data.role_code || 'staff',
      distributorId: data.distributor_id,
      storeId: primaryStore ? primaryStore.store_id : (data.store_id || ''),
      storeName: storeNames.join('、') || '',
      regionId: data.region_id || (primaryStore ? primaryStore.region_id : '') || ''
    };
  });

  ctx.body = { code: 0, data: list };
}

async function list(ctx) {
  const {
    storeId, startDate, endDate, customerPhone, orderNo,
    status, createUser, pnCode, snCode,
    page = 1, pageSize = 20
  } = ctx.query;
  const user = ctx.state.user;

  const where = { is_deleted: 0 };
  const accessibleStoreIds = Array.isArray(user.accessibleStoreIds) ? user.accessibleStoreIds.filter(Boolean) : [];

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
  } else if (!accessibleStoreIds.includes('*')) {
    if (accessibleStoreIds.length === 0) {
      ctx.body = formatPaginatedResult([], { page, pageSize, count: 0 });
      return;
    }
    where.store_id = accessibleStoreIds;
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
  const normalizedItems = (items || []).map(item => applyOrderItemDefaults(normalizeOrderItemInput(item)));
  const productIds = [...new Set(normalizedItems.map(i => i.product_id).filter(Boolean))];
  if (productIds.length === 0) return [];

  const productPrices = await ProductPrice.findAll({
    where: { product_id: { [Op.in]: productIds } }
  });
  const priceMap = new Map();
  productPrices.forEach(p => priceMap.set(p.product_id, p));

  const belowPriceItems = [];
  for (const item of normalizedItems) {
    const price = priceMap.get(item.product_id);
    if (!price || !price.min_sale_price || parseFloat(price.min_sale_price) <= 0) continue;
    const minPrice = parseFloat(price.min_sale_price);
    if (parseFloat(item.sale_price) < minPrice) {
      belowPriceItems.push({
        productId: item.product_id,
        productName: item.product_name,
        salePrice: item.sale_price,
        standardPrice: price.standard_price,
        minSalePrice: price.min_sale_price
      });
    }
  }
  return belowPriceItems;
}

function firstNonEmpty(source, keys, defaultValue = '') {
  for (const key of keys) {
    const value = source && source[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return typeof value === 'string' ? value.trim() : value;
    }
  }
  return defaultValue;
}

function toBoolean(value) {
  return value === true || value === 1 || String(value).toLowerCase() === 'true' || String(value) === '1';
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

function selectedResourcesFromJson(value) {
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
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
  const snId = firstNonEmpty(item, ['snId', 'sn_id', 'SN_ID', 'inventoryId', 'inventory_id', 'INVENTORY_ID', 'inventorySnId', 'inventory_sn_id']);
  const snCode = firstNonEmpty(item, ['snCode', 'sn_code', 'SN_CODE', 'sn', 'SN', 'serialNo', 'serial_no', 'productSn', 'product_sn']);
  const rawResourceTypes = firstNonEmpty(item, ['selectedResourceTypes', 'selected_resource_types'], []);
  let selectedResourceTypes = selectedResourcesFromJson(rawResourceTypes);
  selectedResourceTypes = [...new Set(selectedResourceTypes.map(value => String(value || '').trim()).filter(Boolean))];

  return {
    item_id: firstNonEmpty(item, ['itemId', 'item_id', 'ITEM_ID', 'orderItemId', 'order_item_id', '_id', 'id']),
    product_id: firstNonEmpty(item, ['productId', 'product_id', 'PRODUCT_ID']),
    product_name: firstNonEmpty(item, ['productName', 'product_name', 'PRODUCT_NAME', 'name']),
    pn_code: firstNonEmpty(item, ['pnCode', 'pn_code', 'PN_CODE', 'pn', 'PN']),
    mtm_code: firstNonEmpty(item, ['mtmCode', 'mtm_code', 'MTM_CODE']),
    sn_id: snId,
    sn_code: snCode,
    imei1: firstNonEmpty(item, ['imei1', 'imei_1', 'IMEI1']),
    imei2: firstNonEmpty(item, ['imei2', 'imei_2', 'IMEI2']),
    use_gov_subsidy: selectedResourceTypes.includes('GOV_SUBSIDY') || toBoolean(firstNonEmpty(item, ['useGovSubsidy', 'use_gov_subsidy'], false)),
    use_edu_subsidy: selectedResourceTypes.includes('EDU_SUBSIDY') || toBoolean(firstNonEmpty(item, ['useEduSubsidy', 'use_edu_subsidy'], false)),
    use_sales_report: selectedResourceTypes.includes('SALES_REPORT') || toBoolean(firstNonEmpty(item, ['useSalesReport', 'use_sales_report'], false)),
    selected_resource_types: selectedResourceTypes,
    sale_price: salePrice,
    quantity,
    subtotal
  };
}

function applyOrderItemDefaults(item) {
  const salePrice = Number(item.sale_price || 0);
  const quantity = Number(item.quantity || 1) || 1;
  const subtotal = item.subtotal === undefined || item.subtotal === null
    ? salePrice * quantity
    : Number(item.subtotal || 0);
  return Object.assign({}, item, {
    sale_price: salePrice,
    quantity,
    subtotal
  });
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

async function syncOrderItemsFromPayload(order, data = {}, transaction = null) {
  const rawItems = pickOrderItemsPayload(data);
  if (!Array.isArray(rawItems) || rawItems.length === 0) return [];

  const existingItems = await OrderItem.findAll({
    where: { order_id: order.order_id },
    order: [['item_id', 'ASC']],
    transaction
  });
  const existingById = new Map(existingItems.map(item => [String(item.item_id), item]));
  const results = [];
  let hasLockedResource = null;

  for (let index = 0; index < rawItems.length; index++) {
    const normalized = normalizeOrderItemInput(rawItems[index]);
    const existing = normalized.item_id
      ? existingById.get(String(normalized.item_id))
      : existingItems[index];
    if (!existing) continue;
    const snChanged = (normalized.sn_id && normalized.sn_id !== existing.sn_id) ||
      (normalized.sn_code && normalized.sn_code !== existing.sn_code);
    if (snChanged) {
      if (hasLockedResource === null) {
        hasLockedResource = await InventoryResourceRight.count({
          where: {
            current_status: 'LOCKED',
            locked_source_type: 'SALE_ORDER',
            locked_source_id: order.order_id
          },
          transaction
        }) > 0;
      }
      if (hasLockedResource) {
        throw Object.assign(new Error('该订单存在已锁定的SN资源权益，不能更换SN；请先取消订单后重新开单'), { status: 409 });
      }
    }

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
    await existing.update(updatePayload, { transaction });
    results.push({
      item_id: existing.item_id,
      updated: updatePayload
    });
  }

  return results;
}

/**
 * 创建销售订单
 */
async function create(ctx) {
  const user = ctx.state.user;
  const requestBody = ctx.request.body || {};
  const {
    customerName, customerPhone, customerSource,
    items, payments = [], discountAmount = 0,
    nationalSubsidy = 0, educationSubsidy = 0,
    invoiceStatus = '不开票', remark, storeId, status, orderStatus, untaxedInvoiceConfirmed = false
  } = requestBody;

  if (!Array.isArray(items) || items.length === 0) {
    ctx.throw(400, '订单中没有商品');
  }
  if (!Array.isArray(payments)) {
    ctx.throw(400, '收款方式格式不正确');
  }

  const orderNo = generateOrderNo();
  const orderId = generateUUID();
  const actualStoreId = storeId || user.storeId || '';

  const normalizedItems = items.map(item => applyOrderItemDefaults(normalizeOrderItemInput(item)));
  const totalAmount = normalizedItems.reduce((sum, item) => sum + Number(item.subtotal || 0), 0);
  const payableBeforeDeposit = Math.max(0, money(totalAmount - Number(discountAmount) - Number(nationalSubsidy) - Number(educationSubsidy)));
  const depositDeductions = normalizeDepositDeductions(requestBody);
  if (depositDeductions.length > 1) {
    ctx.throw(400, '一张正式订单只能绑定一张定金单');
  }
  const depositDeductionTotal = money(depositDeductions.reduce((sum, item) => sum + Number(item.amount || 0), 0));
  const declaredDepositTotal = firstNonEmpty(requestBody, ['depositDeductionTotal', 'deposit_deduction_total'], null);
  if (declaredDepositTotal !== null && Math.abs(money(declaredDepositTotal) - depositDeductionTotal) > 0.01) {
    ctx.throw(400, '定金抵扣汇总与明细金额不一致');
  }
  if (depositDeductionTotal - payableBeforeDeposit > 0.01) {
    ctx.throw(400, '定金抵扣金额不能超过订单应付金额');
  }

  const actualPayment = Math.max(0, money(payableBeforeDeposit - depositDeductionTotal));
  const orderPayments = payments.filter(payment => !isDepositPayment(payment));
  const collectedPayments = orderPayments.filter(payment => !isPolicySubsidyReceivable(payment));
  if (actualPayment > 0 && collectedPayments.length === 0) {
    ctx.throw(400, '请填写收款方式');
  }
  const paymentTotal = money(collectedPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0));
  if (Math.abs(paymentTotal - actualPayment) > 0.01) {
    ctx.throw(400, '收款金额与订单实付金额不一致');
  }

  const belowPriceItems = await checkPriceApproval(items);
  const needsApproval = belowPriceItems.length > 0;

  const productIds = [...new Set(normalizedItems.map(i => i.product_id).filter(Boolean))];
  const products = await Product.findAll({
    where: { product_id: { [Op.in]: productIds } }
  });
  const productMap = new Map();
  products.forEach(p => productMap.set(p.product_id, p));

  // 未归档订单允许先记录尚未进入商品主数据的 PN/SN。
  // 无效的商品/库存关联不写入外键，归档时再按 PN/SN 解析并校验。
  for (const item of normalizedItems) {
    if (!productMap.has(item.product_id)) item.product_id = null;
    item.sn_id = null;
  }

  const snItems = normalizedItems.filter(item => item.sn_id || item.sn_code);
  if (Number(nationalSubsidy) > 0 && !normalizedItems.some(item => item.use_gov_subsidy)) {
    // 创建阶段不因 SN 缺失或尚不存在而阻断；仅在唯一明确的 SN 行上预标记权益。
    if (snItems.length === 1) {
      snItems[0].use_gov_subsidy = true;
      snItems[0].selected_resource_types = [...new Set([...(snItems[0].selected_resource_types || []), 'GOV_SUBSIDY'])];
    }
  }
  if (Number(educationSubsidy) > 0 && !normalizedItems.some(item => item.use_edu_subsidy)) {
    if (snItems.length === 1) {
      snItems[0].use_edu_subsidy = true;
      snItems[0].selected_resource_types = [...new Set([...(snItems[0].selected_resource_types || []), 'EDU_SUBSIDY'])];
    }
  }
  if (invoiceStatus && invoiceStatus !== '不开票' && snItems.length) {
    const snWhere = snItems.map(item => item.sn_id ? { sn_id: item.sn_id } : { sn_code: item.sn_code, product_id: item.product_id });
    const selectedSns = await ProductSn.findAll({ where: { [Op.or]: snWhere, is_deleted: 0 } });
    if (selectedSns.some(sn => sn.tax_type === 'UNTAXED') && !untaxedInvoiceConfirmed) {
      ctx.throw(409, '该机器为未税库存，请确认是否允许开票销售');
    }
  }

  const finalOrderStatus = status || orderStatus || (needsApproval ? 'pending_approval' : '未归档');

  await sequelize.transaction(async (transaction) => {
  let redeemedDeposit = null;
  if (depositDeductions.length === 1) {
    redeemedDeposit = await validateDepositRedemption({
      payment: depositDeductions[0],
      user,
      customerPhone,
      payableBeforeDeposit,
      transaction
    });
  }

  await Order.create({
    order_id: orderId,
    order_no: orderNo,
    store_id: actualStoreId,
    create_staff_id: user.staffId,
    create_user: user.name,
    customer_name: customerName,
    customer_phone: customerPhone,
    customer_source: customerSource,
    total_amount: totalAmount,
    discount_amount: discountAmount,
    national_subsidy: nationalSubsidy,
    education_subsidy: educationSubsidy,
    deposit_deduction_total: depositDeductionTotal,
    deposit_items: depositDeductions,
    actual_payment: actualPayment,
    invoice_status: invoiceStatus,
    order_status: finalOrderStatus,
    inventory_reserved: 0,
    remark: remark || (needsApproval ? '售价低于定价, 待审批' : '')
  }, { transaction });

  for (const item of normalizedItems) {
    await OrderItem.create({
      order_id: orderId,
      product_id: item.product_id || null,
      product_name: item.product_name,
      pn_code: item.pn_code,
      sn_id: null,
      sn_code: item.sn_code,
      imei1: item.imei1,
      imei2: item.imei2,
      sale_price: item.sale_price,
      quantity: item.quantity || 1,
      subtotal: item.subtotal,
      use_gov_subsidy: item.use_gov_subsidy ? 1 : 0,
      use_edu_subsidy: item.use_edu_subsidy ? 1 : 0,
      use_sales_report: item.use_sales_report ? 1 : 0,
      selected_resource_types: JSON.stringify(item.selected_resource_types || [])
    }, { transaction });
  }

  for (const payment of orderPayments) {
    await OrderPayment.create({
      order_id: orderId,
      payment_method: payment.method,
      deposit_id: null,
      amount: payment.amount
    }, { transaction });
  }

  if (redeemedDeposit) {
    await redeemDepositForOrder({
      deposit: redeemedDeposit.deposit,
      orderId,
      orderNo,
      amount: redeemedDeposit.amount,
      user,
      transaction
    });
  }

  });

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
      { model: OrderPayment, include: [{ model: DepositOrder }] },
      { model: DepositRedemption, as: 'depositRedemptions' },
      { model: OrderAttachment }
    ]
  });

  if (!order) {
    ctx.throw(404, '订单不存在');
  }

  assertStoreVisible(order.store_id, ctx.state.user);

  const result = order.toJSON();
  const items = result.OrderItems || [];
  const snCodes = items.map(item => item.sn_code).filter(Boolean);
  if (snCodes.length > 0) {
    const snRows = await ProductSn.findAll({
      where: { sn_code: { [Op.in]: snCodes } },
      attributes: ['sn_id', 'sn_code', 'pn_code', 'inventory_type', 'tax_type'],
      raw: true
    });
    const snMap = new Map(snRows.map(sn => [`${sn.pn_code || ''}|${sn.sn_code}`, sn]));
    const summaryMap = await summariesForSns(snRows);
    result.OrderItems = items.map(item => {
      const sn = snMap.get(`${item.pn_code || ''}|${item.sn_code}`) || snRows.find(row => row.sn_code === item.sn_code);
      return {
        ...item,
        pn_code: item.pn_code || sn?.pn_code || '',
        sn_code: item.sn_code || '',
        inventory_type: item.inventory_type || sn?.inventory_type || '',
        resource_summary: sn ? summaryMap.get(sn.sn_id) : null
      };
    });
  }
  if (!canSeeCost(ctx.state.user)) {
    result.OrderItems = (result.OrderItems || items).map(item => {
      const sanitized = { ...item };
      delete sanitized.original_inventory_cost;
      delete sanitized.original_pickup_price;
      delete sanitized.current_pickup_price_at_sale;
      return sanitized;
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
  if (!getUserRoles(user).some(role => allowedRoles.includes(role))) {
    ctx.throw(403, '仅店长或经销商总账号可以审批');
  }

  const order = await Order.findByPk(orderId);
  if (!order) ctx.throw(404, '订单不存在');
  assertStoreVisible(order.store_id, user);
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
  if (!getUserRoles(user).some(role => allowedRoles.includes(role))) {
    ctx.throw(403, '仅店长或经销商总账号可以审批');
  }

  const order = await Order.findByPk(orderId);
  if (!order) ctx.throw(404, '订单不存在');
  assertStoreVisible(order.store_id, user);
  if (order.order_status !== 'pending_approval') {
    ctx.throw(400, '该订单无需审批');
  }

  const { reason } = ctx.request.body;

  await sequelize.transaction(async (transaction) => {
    if (order.inventory_reserved) {
      await releaseReservedInventoryForOrder(order, transaction);
    }
    const items = await OrderItem.findAll({ where: { order_id: order.order_id }, transaction });
    await releaseSaleRights(order, items, transaction);
    await releaseDepositRedemptionForOrder(order, transaction, '订单审批拒绝');
    await order.update({
      order_status: 'cancelled',
      inventory_reserved: 0,
      remark: (order.remark || '') + '\n审批拒绝: ' + (reason || '无'),
      update_time: new Date()
    }, { transaction });
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

  assertStoreVisible(order.store_id, ctx.state.user);

  const nextStatus = data.order_status || data.status;
  await sequelize.transaction(async (transaction) => {
    await syncOrderItemsFromPayload(order, data, transaction);

    if (isArchiveStatus(nextStatus) && !isArchiveStatus(order.order_status)) {
      await validateAndDeductInventoryForArchive(order, transaction);
      const items = await OrderItem.findAll({ where: { order_id: order.order_id }, transaction });
      await lockSaleRights(order, items, transaction);
      await finishSaleRights(order, items, transaction);
      await calculateSalesSettlementCosts(order, transaction);
      const refreshedItems = await OrderItem.findAll({ where: { order_id: order.order_id }, transaction });
      await triggerSaleResourceBenefits(order, refreshedItems, transaction);
      data.order_status = '已归档';
      data.status = '已归档';
      data.inventory_reserved = 0;
      syncToDailyStatement(orderId, order.store_id).catch(err => console.error('[DailySync] archive error:', err.message));
    } else if (isCancelStatus(nextStatus) && !isCancelStatus(order.order_status) && !isArchiveStatus(order.order_status)) {
      if (order.inventory_reserved) {
        await releaseReservedInventoryForOrder(order, transaction);
      }
      const items = await OrderItem.findAll({ where: { order_id: order.order_id }, transaction });
      await releaseSaleRights(order, items, transaction);
      await releaseDepositRedemptionForOrder(order, transaction, '订单取消');
      data.inventory_reserved = 0;
    }

    await order.update(data, { transaction });
  });
  ctx.body = { message: '订单更新成功' };
}

async function updateOrderItems(ctx) {
  const data = ctx.request.body || {};
  const orderNo = firstNonEmpty(data, ['orderNo', 'order_no', 'ORDER_NO']);
  const orderId = firstNonEmpty(data, ['orderId', 'order_id', 'ORDER_ID']);

  const where = orderId ? { order_id: orderId } : { order_no: orderNo };
  if (!orderId && !orderNo) {
    ctx.throw(400, '订单编号不能为空');
  }

  const order = await Order.findOne({ where });
  if (!order) {
    ctx.throw(404, '订单不存在');
  }

  assertStoreVisible(order.store_id, ctx.state.user);

  let results = [];
  await sequelize.transaction(async (transaction) => {
    results = await syncOrderItemsFromPayload(order, data, transaction);
  });

  ctx.body = {
    code: 0,
    message: '订单明细更新成功',
    data: {
      orderId: order.order_id,
      orderNo: order.order_no,
      results
    }
  };
}

/**
 * 销售统计
 */
async function stats(ctx) {
  const { storeId, startDate, endDate } = ctx.query;
  const user = ctx.state.user;

  const whereStore = {};
  if (!user.accessibleStoreIds.includes('*')) {
    whereStore.store_id = user.accessibleStoreIds;
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

async function listDeposits(ctx) {
  const { storeId, status, customerPhone, page = 1, pageSize = 20 } = ctx.query;
  const user = ctx.state.user;
  const where = { is_deleted: 0 };

  if (status) where.status = status;
  if (customerPhone) where.customer_phone = { [Op.like]: `%${customerPhone}%` };
  if (storeId) {
    where.store_id = storeId;
  } else if (!user.accessibleStoreIds.includes('*')) {
    where.store_id = user.accessibleStoreIds;
  }

  const { count, rows } = await DepositOrder.findAndCountAll({
    where,
    include: [{ model: Store }],
    distinct: true,
    order: [['create_time', 'DESC']],
    ...paginate({}, { page, pageSize })
  });

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

async function createDeposit(ctx) {
  const user = ctx.state.user;
  const {
    storeId, store_id,
    customerName, customerPhone, customerSource,
    amount, remark
  } = ctx.request.body;
  const actualStoreId = storeId || store_id || user.storeId || '';
  const depositAmount = money(amount);

  if (!actualStoreId) ctx.throw(400, '请选择门店');
  if (!customerName || !customerPhone) ctx.throw(400, '请填写客户信息');
  if (depositAmount <= 0) ctx.throw(400, '定金金额必须大于0');

  const depositId = generateUUID();
  const depositNo = generateBusinessNo('DEP');

  await DepositOrder.create({
    deposit_id: depositId,
    deposit_no: depositNo,
    store_id: actualStoreId,
    customer_name: customerName,
    customer_phone: customerPhone,
    customer_source: customerSource || '',
    amount: depositAmount,
    redeemed_amount: 0,
    refunded_amount: 0,
    status: 'available',
    remark: remark || '',
    create_staff_id: user.staffId,
    create_user: user.name
  });

  ctx.body = { depositId, depositNo, status: 'available', message: '定金已存入客户定金库' };
}

async function archiveDeposit(ctx) {
  const { depositId } = ctx.params;
  const user = ctx.state.user;

  if (!depositId) ctx.throw(400, '缺少定金单ID');
  const deposit = await DepositOrder.findOne({ where: { deposit_id: depositId, is_deleted: 0 } });
  if (!deposit) ctx.throw(404, '定金单不存在');
  assertDepositStoreVisible(deposit, user);
  if (deposit.status !== 'submitted') {
    ctx.throw(400, '只有已提交的定金单可以归档');
  }

  await deposit.update({
    status: 'archived',
    archive_user: user.name,
    archive_time: new Date(),
    update_time: new Date()
  });

  ctx.body = { message: '定金单已归档' };
}

async function refundDeposit(ctx) {
  const { depositId } = ctx.params;
  const user = ctx.state.user;
  const { amount, reason } = ctx.request.body || {};

  if (!depositId) ctx.throw(400, '缺少定金单ID');
  await sequelize.transaction(async (transaction) => {
    const deposit = await DepositOrder.findOne({
      where: { deposit_id: depositId, is_deleted: 0 },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!deposit) ctx.throw(404, '定金单不存在');
    assertDepositStoreVisible(deposit, user);
    assertDepositCreator(deposit, user, '只能退款自己收的定金单');
    if (!['submitted', 'available', 'archived'].includes(deposit.status)) {
      ctx.throw(400, '只有未核销的定金单可以退款');
    }

    const availableAmount = getDepositAvailableAmount(deposit);
    const refundAmount = amount === undefined || amount === null || amount === ''
      ? availableAmount
      : money(amount);
    if (refundAmount <= 0) ctx.throw(400, '退款金额必须大于0');
    if (Math.abs(refundAmount - availableAmount) > 0.01) {
      ctx.throw(400, '定金当前只支持全额退款记录');
    }

    await DepositRefund.create({
      refund_id: generateUUID(),
      refund_no: generateBusinessNo('DRF'),
      deposit_id: deposit.deposit_id,
      amount: refundAmount,
      reason: reason || '',
      create_staff_id: user.staffId,
      create_user: user.name
    }, { transaction });

    await deposit.update({
      refunded_amount: refundAmount,
      status: 'refunded',
      update_time: new Date()
    }, { transaction });
  });

  ctx.body = { message: '定金退款记录已生成' };
}

async function availableDeposits(ctx) {
  const user = ctx.state.user;
  const { customerPhone, storeId } = ctx.query;
  const where = {
    is_deleted: 0,
    status: { [Op.in]: ['submitted', 'available', 'archived'] },
    create_staff_id: user.staffId
  };
  if (customerPhone) where.customer_phone = customerPhone;
  if (storeId) where.store_id = storeId;
  else if (!user.accessibleStoreIds.includes('*')) where.store_id = user.accessibleStoreIds;

  const rows = await DepositOrder.findAll({
    where,
    order: [['create_time', 'DESC']]
  });

  const availableRows = rows
    .filter(row => getDepositAvailableAmount(row) > 0)
    .map(row => ({
      ...row.toJSON(),
      available_amount: getDepositAvailableAmount(row)
    }));

  ctx.body = { code: 0, data: availableRows, message: 'success' };
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
    attributes: ['sn_id', 'sn_code', 'pn_code', 'inventory_type', 'tax_type'],
    order: [['sn_code', 'ASC']]
  });

  const summaryMap = await summariesForSns(snRecords);
  ctx.body = {
    code: 0,
    data: snRecords.map(s => ({
      sn_id: s.sn_id,
      sn_code: s.sn_code,
      pn_code: s.pn_code,
      inventory_type: s.inventory_type,
      ...summaryMap.get(s.sn_id)
    }))
  };
}

async function recalculateSettlementCost(ctx) {
  const { orderId } = ctx.params;
  const user = ctx.state.user;
  const roles = getUserRoles(user);
  if (!roles.some(role => ['boss', 'admin', 'finance'].includes(role))) {
    ctx.throw(403, '无权重算销售结算成本');
  }

  const order = await Order.findByPk(orderId);
  if (!order) ctx.throw(404, '订单不存在');
  if (!isArchiveStatus(order.order_status)) {
    ctx.throw(400, '只有已归档订单可以重算销售结算成本');
  }

  await sequelize.transaction(async (transaction) => {
    await calculateSalesSettlementCosts(order, transaction, { force: true });
    await order.update({ update_time: new Date() }, { transaction });
  });

  ctx.body = { code: 0, message: '销售结算成本已重算' };
}

function isArchiveStatus(status) {
  return ['已归档', 'completed', 'archived'].includes(String(status || ''));
}

function archiveError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function money(value) {
  const number = Number(value || 0);
  return Math.round(number * 100) / 100;
}

function generateBusinessNo(prefix) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const random = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  return `${prefix}${yyyy}${mm}${dd}${hh}${mi}${ss}${random}`;
}

function isDepositPayment(payment) {
  const method = String(payment?.method || payment?.payment_method || '').trim().toLowerCase();
  return method === '定金' || method === '定金抵扣' || method === 'deposit';
}

function isPolicySubsidyReceivable(payment) {
  const method = String(payment?.method || payment?.payment_method || '').trim();
  return method.includes('政策补贴应收');
}

function normalizeDepositDeductions(data = {}) {
  const explicitItems = [
    data.depositItems,
    data.deposit_items,
    data.deposits
  ].find(Array.isArray);
  const source = explicitItems && explicitItems.length
    ? explicitItems
    : (Array.isArray(data.payments) ? data.payments.filter(isDepositPayment) : []);

  return source.map(item => ({
    depositId: firstNonEmpty(item, ['depositId', 'deposit_id', '_id']),
    depositNo: firstNonEmpty(item, ['depositNo', 'deposit_no']),
    customerName: firstNonEmpty(item, ['customerName', 'customer_name']),
    customerPhone: firstNonEmpty(item, ['customerPhone', 'customer_phone']),
    amount: money(firstNonEmpty(item, ['amount', 'deductionAmount', 'deduction_amount'], 0))
  }));
}

function getDepositAvailableAmount(deposit) {
  return money(Number(deposit.amount || 0) - Number(deposit.redeemed_amount || 0) - Number(deposit.refunded_amount || 0));
}

function assertDepositCreator(deposit, user, message = '只能核销自己收的定金单') {
  if (String(deposit.create_staff_id || '') !== String(user.staffId || '')) {
    const error = new Error(message);
    error.status = 403;
    throw error;
  }
}

function assertDepositStoreVisible(deposit, user) {
  assertStoreVisible(deposit.store_id, user, '无权访问该门店定金单');
}

function assertStoreVisible(storeId, user, message = '无权访问该门店数据') {
  if (user.accessibleStoreIds?.includes('*')) return;
  if (!(user.accessibleStoreIds || []).map(String).includes(String(storeId || ''))) {
    const error = new Error(message);
    error.status = 403;
    throw error;
  }
}

async function validateDepositRedemption({ payment, user, customerPhone, payableBeforeDeposit, transaction }) {
  const depositId = payment.depositId || payment.deposit_id;
  if (!depositId) {
    throw archiveError('请选择需要核销的定金单');
  }
  const deposit = await DepositOrder.findOne({
    where: { deposit_id: depositId, is_deleted: 0 },
    transaction,
    lock: transaction.LOCK.UPDATE
  });
  if (!deposit) {
    throw archiveError('定金单不存在');
  }
  assertDepositCreator(deposit, user);
  if (!['submitted', 'available', 'archived'].includes(deposit.status)) {
    throw archiveError('该定金单当前不可用于抵扣订单');
  }
  if (customerPhone && deposit.customer_phone && String(customerPhone).trim() !== String(deposit.customer_phone).trim()) {
    throw archiveError('定金单客户电话与当前订单客户电话不一致');
  }

  const availableAmount = getDepositAvailableAmount(deposit);
  if (availableAmount <= 0) {
    throw archiveError('定金单没有可核销余额');
  }
  const requestedAmount = money(payment.amount);
  if (requestedAmount <= 0) {
    throw archiveError('定金抵扣金额必须大于0');
  }
  if (requestedAmount - availableAmount > 0.01) {
    throw archiveError('定金抵扣金额不能超过可用余额');
  }
  if (requestedAmount - payableBeforeDeposit > 0.01) {
    throw archiveError('定金抵扣金额不能超过订单应付金额');
  }

  return { deposit, amount: requestedAmount };
}

async function redeemDepositForOrder({ deposit, orderId, orderNo, amount, user, transaction }) {
  await DepositRedemption.create({
    redemption_id: generateUUID(),
    deposit_id: deposit.deposit_id,
    order_id: orderId,
    order_no: orderNo,
    amount,
    status: 'active',
    create_staff_id: user.staffId,
    create_user: user.name
  }, { transaction });

  const redeemedAmount = money(Number(deposit.redeemed_amount || 0) + Number(amount || 0));
  const remainingAmount = money(Number(deposit.amount || 0) - redeemedAmount - Number(deposit.refunded_amount || 0));
  await deposit.update({
    redeemed_amount: redeemedAmount,
    status: remainingAmount > 0 ? 'available' : 'redeemed',
    related_order_id: orderId,
    related_order_no: orderNo,
    update_time: new Date()
  }, { transaction });
}

async function releaseDepositRedemptionForOrder(order, transaction = null, reason = '订单取消') {
  const redemptions = await DepositRedemption.findAll({
    where: { order_id: order.order_id, status: 'active' },
    transaction
  });
  for (const redemption of redemptions) {
    const deposit = await DepositOrder.findByPk(redemption.deposit_id, {
      transaction,
      lock: transaction?.LOCK?.UPDATE
    });
    if (deposit) {
      const restoredRedeemedAmount = Math.max(0, money(Number(deposit.redeemed_amount || 0) - Number(redemption.amount || 0)));
      await deposit.update({
        redeemed_amount: restoredRedeemedAmount,
        status: 'available',
        related_order_id: deposit.related_order_id === order.order_id ? null : deposit.related_order_id,
        related_order_no: deposit.related_order_no === order.order_no ? null : deposit.related_order_no,
        update_time: new Date()
      }, { transaction });
    }
    await redemption.update({
      status: 'voided',
      void_reason: reason,
      void_time: new Date()
    }, { transaction });
  }
}

function canSeeCost(user) {
  return getUserRoles(user).some(role => ['boss', 'admin', 'finance', 'manager'].includes(role));
}

async function findCurrentManufacturerPrice({ productId, pn, saleDate, transaction = null }) {
  if (!pn) return null;
  const date = saleDate || new Date();
  return ManufacturerPriceHistory.findOne({
    where: {
      pn,
      [Op.and]: [
        { effective_date: { [Op.lte]: date } },
        {
          [Op.or]: [
            { expire_date: null },
            { expire_date: { [Op.gte]: date } }
          ]
        },
        {
          [Op.or]: [
            { product_id: productId },
            { product_id: null },
            { product_id: '' }
          ]
        }
      ]
    },
    order: [['effective_date', 'DESC'], ['created_at', 'DESC']],
    transaction
  });
}

async function findActiveManufacturerPolicies({ supplierId, productId, pn, saleDate, transaction = null }) {
  if (!supplierId) return [];
  const date = saleDate || new Date();
  return ManufacturerRebatePolicy.findAll({
    where: {
      supplier_id: supplierId,
      status: 1,
      [Op.and]: [
        {
          [Op.or]: [
            { start_date: null },
            { start_date: { [Op.lte]: date } }
          ]
        },
        {
          [Op.or]: [
            { end_date: null },
            { end_date: { [Op.gte]: date } }
          ]
        },
        {
          [Op.or]: [
            { product_id: productId },
            { product_id: null },
            { product_id: '' }
          ]
        },
        {
          [Op.or]: [
            { pn },
            { pn: null },
            { pn: '' }
          ]
        }
      ]
    },
    order: [['create_time', 'DESC']],
    transaction
  });
}

function calculatePolicyRebate(policy, baseAmount) {
  if (policy.rebate_calculation_type === 'percentage') {
    return money(baseAmount * Number(policy.rebate_rate || 0) / 100);
  }
  return money(policy.rebate_amount || 0);
}

function calculateCostAdjustment(policy, rebateAmount) {
  if (!policy.affect_sales_settlement_cost) return 0;
  let amount = 0;
  if (policy.cost_adjustment_type === 'fixed_amount') {
    amount = Number(policy.cost_adjustment_value || 0);
  } else if (policy.cost_adjustment_type === 'percentage') {
    amount = rebateAmount * Number(policy.cost_adjustment_value || 0) / 100;
  } else {
    amount = 0;
  }
  const max = Number(policy.max_cost_adjustment_amount || 0);
  if (max > 0) amount = Math.min(amount, max);
  return money(amount);
}

async function createEstimateAndAdjustment({
  order,
  item,
  priceHistory,
  policy,
  policyName,
  policyType,
  rebateAmount,
  affectCost,
  costAdjustmentAmount,
  originalInventoryCost,
  originalPickupPrice,
  currentPickupPrice,
  finalSalesSettlementCost,
  remark,
  transaction
}) {
  const estimateId = generateUUID();
  await RebateEstimate.create({
    estimate_id: estimateId,
    sales_order_id: order.order_id,
    sales_order_no: order.order_no,
    sales_order_item_id: item.item_id,
    supplier_id: priceHistory?.supplier_id || policy?.supplier_id || '',
    supplier_name: priceHistory?.supplier_name || policy?.supplier_name || '',
    product_id: item.product_id,
    product_name: item.product_name,
    pn: item.pn_code,
    sn: item.sn_code,
    policy_id: policy?.policy_id || null,
    policy_name: policyName,
    policy_type: policyType,
    rebate_estimate_amount: rebateAmount,
    status: 'estimated',
    remark
  }, { transaction });

  await createPendingSettlement({
    sourceType: 'MANUFACTURER_REBATE', sourceId: estimateId,
    sn: { sn_id: item.sn_id || `NO_SN_${item.item_id}`, sn_code: item.sn_code || '', product_id: item.product_id },
    resourceType: 'MANUFACTURER_REBATE', amount: rebateAmount,
    counterpartyId: priceHistory?.supplier_id || policy?.supplier_id || null,
    counterpartyName: priceHistory?.supplier_name || policy?.supplier_name || '',
    remark: `销售订单 ${order.order_no} 厂商返利预估到账确认`, transaction
  });

  await SalesSettlementCostAdjustment.create({
    id: generateUUID(),
    sales_order_id: order.order_id,
    sales_order_no: order.order_no,
    sales_order_item_id: item.item_id,
    supplier_id: priceHistory?.supplier_id || policy?.supplier_id || '',
    supplier_name: priceHistory?.supplier_name || policy?.supplier_name || '',
    product_id: item.product_id,
    product_name: item.product_name,
    pn: item.pn_code,
    sn: item.sn_code,
    original_inventory_cost: originalInventoryCost,
    original_pickup_price: originalPickupPrice,
    current_pickup_price_at_sale: currentPickupPrice,
    policy_id: policy?.policy_id || null,
    policy_name: policyName,
    policy_type: policyType,
    rebate_estimate_id: estimateId,
    rebate_estimate_amount: rebateAmount,
    affect_sales_settlement_cost: affectCost ? 1 : 0,
    cost_adjustment_amount: costAdjustmentAmount,
    final_sales_settlement_cost: finalSalesSettlementCost,
    remark
  }, { transaction });
}

async function calculateSalesSettlementCosts(order, transaction = null, options = {}) {
  const existing = await SalesSettlementCostAdjustment.count({
    where: { sales_order_id: order.order_id },
    transaction
  });
  if (existing > 0 && !options.force) return;

  if (options.force) {
    const estimates = await RebateEstimate.findAll({ where: { sales_order_id: order.order_id }, attributes: ['estimate_id'], transaction });
    const estimateIds = estimates.map(item => item.estimate_id);
    if (estimateIds.length > 0) {
      const settledCount = await ResourceSettlement.count({ where: { source_type: 'MANUFACTURER_REBATE', source_id: { [Op.in]: estimateIds }, status: 'SETTLED' }, transaction });
      if (settledCount > 0) throw Object.assign(new Error('该订单的厂商返利已下账，不能重算'), { status: 409 });
      await ResourceSettlement.destroy({ where: { source_type: 'MANUFACTURER_REBATE', source_id: { [Op.in]: estimateIds }, status: 'PENDING' }, transaction });
    }
    await SalesSettlementCostAdjustment.destroy({ where: { sales_order_id: order.order_id }, transaction });
    await RebateEstimate.destroy({ where: { sales_order_id: order.order_id }, transaction });
  }

  const items = await OrderItem.findAll({ where: { order_id: order.order_id }, transaction });
  const productIds = [...new Set(items.map(item => item.product_id).filter(Boolean))];
  const productPrices = await ProductPrice.findAll({ where: { product_id: { [Op.in]: productIds } }, transaction });
  const priceMap = new Map(productPrices.map(price => [price.product_id, price]));
  const saleDate = order.create_time || new Date();

  for (const item of items) {
    const snRecord = item.sn_code
      ? await ProductSn.findOne({ where: { sn_code: item.sn_code, product_id: item.product_id }, transaction })
      : null;
    const productPrice = priceMap.get(item.product_id);
    const originalInventoryCost = money(snRecord?.inbound_price || productPrice?.cost_price || 0);
    const originalPickupPrice = money(snRecord?.original_pickup_price || snRecord?.inbound_price || item.original_pickup_price || 0);
    const priceHistory = await findCurrentManufacturerPrice({
      productId: item.product_id,
      pn: item.pn_code,
      saleDate,
      transaction
    });
    const currentPickupPrice = money(priceHistory?.pickup_price || 0);
    const p0DifferenceAmount = originalPickupPrice > currentPickupPrice && currentPickupPrice > 0
      ? money(originalPickupPrice - currentPickupPrice)
      : 0;

    let totalCostAdjustment = 0;
    const pendingRows = [];

    if (p0DifferenceAmount > 0) {
      totalCostAdjustment += p0DifferenceAmount;
      pendingRows.push({
        policy: null,
        policyName: 'P差',
        policyType: 'p0_difference',
        rebateAmount: p0DifferenceAmount,
        affectCost: true,
        costAdjustmentAmount: p0DifferenceAmount,
        remark: 'P差 = 原始提货价 - 销售时厂家当前提货价'
      });
    }

    const policies = await findActiveManufacturerPolicies({
      supplierId: priceHistory?.supplier_id,
      productId: item.product_id,
      pn: item.pn_code,
      saleDate,
      transaction
    });

    for (const policy of policies) {
      if (policy.policy_type === 'p0_difference') continue;
      const rebateAmount = calculatePolicyRebate(policy, originalInventoryCost);
      if (rebateAmount <= 0) continue;
      const costAdjustmentAmount = calculateCostAdjustment(policy, rebateAmount);
      totalCostAdjustment += costAdjustmentAmount;
      pendingRows.push({
        policy,
        policyName: policy.policy_name,
        policyType: policy.policy_type,
        rebateAmount,
        affectCost: !!policy.affect_sales_settlement_cost,
        costAdjustmentAmount,
        remark: policy.cost_adjustment_remark || policy.remark || ''
      });
    }

    totalCostAdjustment = money(totalCostAdjustment);
    const finalSalesSettlementCost = money(Math.max(0, originalInventoryCost - totalCostAdjustment));
    const salesGrossProfit = money(Number(item.subtotal || 0) - finalSalesSettlementCost * Number(item.quantity || 1));

    for (const row of pendingRows) {
      await createEstimateAndAdjustment({
        order,
        item,
        priceHistory,
        policy: row.policy,
        policyName: row.policyName,
        policyType: row.policyType,
        rebateAmount: row.rebateAmount,
        affectCost: row.affectCost,
        costAdjustmentAmount: row.costAdjustmentAmount,
        originalInventoryCost,
        originalPickupPrice,
        currentPickupPrice,
        finalSalesSettlementCost,
        remark: row.remark,
        transaction
      });
    }

    await item.update({
      original_inventory_cost: originalInventoryCost,
      original_pickup_price: originalPickupPrice,
      current_pickup_price_at_sale: currentPickupPrice,
      p0_difference_amount: p0DifferenceAmount,
      cost_adjustment_amount: totalCostAdjustment,
      sales_settlement_cost: finalSalesSettlementCost,
      sales_gross_profit: salesGrossProfit
    }, { transaction });
  }
}

function isCancelStatus(status) {
  return ['cancelled', 'canceled', '已取消', '作废'].includes(String(status || ''));
}

async function reserveInventoryForOrder(order, transaction = null) {
  const items = await OrderItem.findAll({ where: { order_id: order.order_id }, transaction });
  if (!items.length) {
    throw archiveError('订单中没有商品，无法占用库存');
  }

  const productIds = [...new Set(items.map(i => i.product_id).filter(Boolean))];
  const products = await Product.findAll({ where: { product_id: { [Op.in]: productIds } }, transaction });
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
        throw archiveError(`商品 ${item.product_name || product.name} 需要SN管理，请先填写SN码`);
      }

      const snWhere = {
        sn_code: snCode,
        product_id: item.product_id,
        store_id: order.store_id,
        status: 'in_stock',
        is_deleted: 0
      };
      if (item.pn_code) snWhere.pn_code = item.pn_code;

      const snRecord = await ProductSn.findOne({ where: snWhere, transaction });
      if (!snRecord) {
        throw archiveError(`SN码 [${snCode}] 在当前门店没有可用库存，不能提交订单`);
      }

      operations.push({ item, quantity, snRecord, inventoryType: snRecord.inventory_type || 'normal_qty' });
    } else {
      await assertAvailableInventory(item, product, order.store_id, quantity, '提交订单', transaction);
      operations.push({ item, quantity, inventoryType: 'normal_qty' });
    }
  }

  for (const op of operations) {
    if (op.snRecord) {
      await op.snRecord.update({ status: 'reserved' }, { transaction });
      if (!op.item.sn_id) {
        await op.item.update({ sn_id: op.snRecord.sn_id }, { transaction });
      }
    }
    await _moveInventoryToPending(op.item.product_id, order.store_id, op.inventoryType, op.quantity, transaction);
  }
}

async function releaseReservedInventoryForOrder(order, transaction = null) {
  const items = await OrderItem.findAll({ where: { order_id: order.order_id }, transaction });
  for (const item of items) {
    const quantity = Number(item.quantity || 1);
    let inventoryType = 'normal_qty';

    if (item.sn_code) {
      const snWhere = {
        sn_code: String(item.sn_code).trim(),
        product_id: item.product_id,
        store_id: order.store_id,
        status: 'reserved',
        is_deleted: 0
      };
      if (item.pn_code) snWhere.pn_code = item.pn_code;
      const snRecord = await ProductSn.findOne({ where: snWhere, transaction });
      if (snRecord) {
        inventoryType = snRecord.inventory_type || 'normal_qty';
        await snRecord.update({ status: 'in_stock' }, { transaction });
      }
    }

    await _releasePendingInventory(item.product_id, order.store_id, inventoryType, quantity, transaction);
  }
}

async function assertAvailableInventory(item, product, storeId, quantity, actionText, transaction = null) {
  const inv = await Inventory.findOne({
    where: { product_id: item.product_id, store_id: storeId },
    transaction
  });
  const normalStock = inv ? Math.max(
    Number(inv.normal_qty || 0),
    Number(inv.regular_qty || 0) + Number(inv.subsidy_qty || 0) + Number(inv.second_qty || 0)
  ) : 0;
  const totalStock = inv ? normalStock + Number(inv.display_qty || 0) : 0;
  if (totalStock < quantity) {
    throw archiveError(`商品 ${item.product_name || product.name} 库存不足(可用:${totalStock}, 需要:${quantity})，不能${actionText}`);
  }
  return inv;
}

async function validateAndDeductInventoryForArchive(order, transaction = null) {
  const items = await OrderItem.findAll({ where: { order_id: order.order_id }, transaction });
  if (!items.length) {
    throw archiveError('订单中没有商品，无法归档');
  }

  const pnCodes = [...new Set(items.map(item => String(item.pn_code || '').trim()).filter(Boolean))];
  const pnRows = pnCodes.length
    ? await ProductPn.findAll({
      where: {
        pn_code: { [Op.in]: pnCodes },
        status: 1,
        is_deleted: 0
      },
      transaction
    })
    : [];
  const pnMap = new Map(pnRows.map(row => [String(row.pn_code || '').trim().toLowerCase(), row]));

  for (const item of items) {
    const pnCode = String(item.pn_code || '').trim();
    if (!pnCode) {
      throw archiveError(`商品 ${item.product_name || item.item_id} 缺少PN码，不能归档`);
    }
    const pnRecord = pnMap.get(pnCode.toLowerCase());
    if (pnRecord) {
      if (item.product_id && String(item.product_id) !== String(pnRecord.product_id)) {
        throw archiveError(`PN码 [${pnCode}] 与订单商品不匹配，不能归档`);
      }
      if (!item.product_id) {
        await item.update({ product_id: pnRecord.product_id }, { transaction });
        item.product_id = pnRecord.product_id;
      }
    }
  }

  const productIds = [...new Set(items.map(i => i.product_id).filter(Boolean))];
  const products = await Product.findAll({ where: { product_id: { [Op.in]: productIds } }, transaction });
  const productMap = new Map(products.map(product => [product.product_id, product]));
  const operations = [];

  for (const item of items) {
    const product = productMap.get(item.product_id);
    if (!product) {
      throw archiveError(`PN码 [${item.pn_code || ''}] 对应的商品不存在，不能归档`);
    }

    const pnCode = String(item.pn_code || '').trim();
    const pnRecord = pnMap.get(pnCode.toLowerCase());
    const manufacturerPns = String(product.manufacturer_code || '')
      .split(/[,\s，、]+/)
      .map(value => value.trim().toLowerCase())
      .filter(Boolean);
    if ((!pnRecord || String(pnRecord.product_id) !== String(product.product_id)) &&
        !manufacturerPns.includes(pnCode.toLowerCase())) {
      throw archiveError(`PN码 [${pnCode}] 不存在，不能归档`);
    }

    const quantity = Number(item.quantity || 1);
    const snCode = String(item.sn_code || '').trim();
    if (product.need_sn === 1) {
      if (!snCode) {
        throw archiveError(`商品 ${item.product_name || product.name} 需要SN管理，请先补充SN码后再归档`);
      }

      const snWhere = {
        sn_code: snCode,
        product_id: item.product_id,
        store_id: order.store_id,
        status: { [Op.in]: ['reserved', 'in_stock'] },
        is_deleted: 0
      };
      if (item.pn_code) snWhere.pn_code = item.pn_code;

      const snRecord = await ProductSn.findOne({ where: snWhere, transaction });
      if (!snRecord) {
        throw archiveError(`SN码 [${snCode}] 在当前门店没有可用库存，不能归档`);
      }

      operations.push({
        item,
        product,
        quantity,
        snRecord,
        inventoryType: snRecord.inventory_type || 'normal_qty',
        fromPending: snRecord.status === 'reserved'
      });
    } else {
      if (snCode) {
        const optionalSn = await ProductSn.findOne({
          where: {
            sn_code: snCode,
            product_id: item.product_id,
            pn_code: pnCode,
            store_id: order.store_id,
            status: { [Op.in]: ['reserved', 'in_stock'] },
            is_deleted: 0
          },
          transaction
        });
        if (!optionalSn) {
          throw archiveError(`SN码 [${snCode}] 不存在或与PN码不匹配，不能归档`);
        }
        if (!item.sn_id) {
          await item.update({ sn_id: optionalSn.sn_id }, { transaction });
        }
      }
      const inv = await Inventory.findOne({
        where: { product_id: item.product_id, store_id: order.store_id },
        transaction
      });
      const pendingStock = inv ? Number(inv.pending_qty || 0) : 0;
      const normalStock = inv ? Math.max(
        Number(inv.normal_qty || 0),
        Number(inv.regular_qty || 0) + Number(inv.subsidy_qty || 0) + Number(inv.second_qty || 0)
      ) : 0;
      const totalStock = inv ? normalStock + Number(inv.display_qty || 0) + pendingStock : 0;
      if (totalStock < quantity) {
        throw archiveError(`商品 ${item.product_name || product.name} 库存不足(可用:${totalStock}, 需要:${quantity})，不能归档`);
      }

      operations.push({
        item,
        product,
        quantity,
        inventoryType: 'normal_qty',
        fromPending: pendingStock >= quantity
      });
    }
  }

  for (const op of operations) {
    if (op.snRecord) {
      await op.snRecord.update({ status: 'sold' }, { transaction });
      if (!op.item.sn_id) {
        await op.item.update({ sn_id: op.snRecord.sn_id }, { transaction });
      }
    }

    if (op.fromPending) {
      await _finalizePendingInventory(op.item.product_id, order.store_id, op.quantity, transaction);
    } else {
      await _deductInventory(op.item.product_id, order.store_id, op.inventoryType, op.quantity, transaction);
    }
  }
}

module.exports = {
  list,
  create,
  detail,
  update,
  updateOrderItems,
  stats,
  approve,
  reject,
  auxiliaryStaff,
  paymentMethods,
  listDeposits,
  createDeposit,
  archiveDeposit,
  refundDeposit,
  availableDeposits,
  getProductPns,
  getProductSns,
  recalculateSettlementCost
};

const INVENTORY_COLUMN_MAP = {
  normal_qty: 'normal_qty',
  display_qty: 'display_qty',
  demo_qty: 'demo_qty',
  unsellable_qty: 'unsellable_qty',
  pending_qty: 'pending_qty'
};

async function _deductInventory(productId, storeId, inventoryType, quantity, transaction = null) {
  const column = INVENTORY_COLUMN_MAP[inventoryType] || 'normal_qty';
  const inv = await Inventory.findOne({
    where: { product_id: productId, store_id: storeId },
    transaction
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

    await inv.update(payload, { transaction });
  }
}

async function _moveInventoryToPending(productId, storeId, inventoryType, quantity, transaction = null) {
  const column = INVENTORY_COLUMN_MAP[inventoryType] || 'normal_qty';
  const inv = await Inventory.findOne({
    where: { product_id: productId, store_id: storeId },
    transaction
  });
  if (!inv) {
    throw archiveError(`商品 ${productId} 库存不存在，不能占用`);
  }

  const qty = Number(quantity) || 0;
  const detailColumns = ['regular_qty', 'subsidy_qty', 'second_qty'];
  const detailTotal = detailColumns.reduce((sum, key) => sum + Number(inv[key] || 0), 0);
  const currentVal = column === 'normal_qty'
    ? Math.max(Number(inv.normal_qty || 0), detailTotal)
    : Number(inv[column] || 0);
  const deductFromColumn = Math.min(currentVal, qty);
  let remaining = qty - deductFromColumn;
  const payload = {
    [column]: currentVal - deductFromColumn,
    pending_qty: Number(inv.pending_qty || 0) + qty
  };

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

  await inv.update(payload, { transaction });
}

async function _finalizePendingInventory(productId, storeId, quantity, transaction = null) {
  const inv = await Inventory.findOne({
    where: { product_id: productId, store_id: storeId },
    transaction
  });
  if (!inv) return;
  const qty = Number(quantity) || 0;
  await inv.update({
    pending_qty: Math.max(0, Number(inv.pending_qty || 0) - qty)
  }, { transaction });
}

async function _releasePendingInventory(productId, storeId, inventoryType, quantity, transaction = null) {
  const column = INVENTORY_COLUMN_MAP[inventoryType] || 'normal_qty';
  const inv = await Inventory.findOne({
    where: { product_id: productId, store_id: storeId },
    transaction
  });
  if (!inv) return;
  const qty = Number(quantity) || 0;
  const releaseQty = Math.min(Number(inv.pending_qty || 0), qty);
  await inv.update({
    pending_qty: Math.max(0, Number(inv.pending_qty || 0) - releaseQty),
    [column]: Number(inv[column] || 0) + releaseQty
  }, { transaction });
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
    const defaultPolicyReceivableAccountId = 'ACC_POLICY_SUBSIDY_RECEIVABLE';
    const methodName = String(paymentMethodName || '');
    const isPolicyReceivable = methodName.endsWith('-政策补贴应收');
    const baseMethodName = methodName
      .replace(/-客户实收$/, '')
      .replace(/-政策补贴应收$/, '');
    const pm = await PaymentMethod.findOne({ where: { name: baseMethodName, status: 1 } });
    if (!pm) return null;

    if (pm.is_global === 1) {
      return isPolicyReceivable
        ? pm.receivable_settlement_account_id || defaultPolicyReceivableAccountId
        : pm.settlement_account_id || null;
    }

    const storeCfg = await PaymentMethodStore.findOne({
      where: { method_id: pm.method_id, store_id: storeId }
    });
    return isPolicyReceivable
      ? storeCfg?.receivable_settlement_account_id || pm.receivable_settlement_account_id || defaultPolicyReceivableAccountId
      : storeCfg?.settlement_account_id || null;
  } catch (err) {
    console.error('[resolveSettlementAccount] Error:', err.message);
    return null;
  }
}
