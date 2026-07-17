/**
 * 采购管理控制器
 */
const { sequelize, PurchaseRequest, PurchaseRequestItem, PurchaseAdjustment, PurchaseAdjustmentItem, Supplier, SupplierPaymentAccount, Store, Location, Product, Inbound, InboundItem, Payable, Expense, SupplierRebate, ResourceCategory, GoodsType } = require('../../models');
const { Op } = require('sequelize');
const { generateRequestNo, generateUUID, generateId, generateInboundNo, paginate, formatPaginatedResult, buildPendingFirstOrder } = require('../../utils');
const { recordRebateDeduction, recordSupplierRebateAccountTransaction, _getRebateBalance } = require('../finance/rebateController');
const { createPurchaseReimbursement } = require('../finance/expenseService');

function toMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.round(amount * 100) / 100;
}

function toSignedMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100) / 100;
}

function normalizeGrossProfitUpliftAmount(value, fallback = 0) {
  const raw = value === undefined || value === null || value === '' ? fallback : value;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount * 100) / 100;
}

function assertStoreVisible(ctx, storeId) {
  const allowed = ctx.state.user.accessibleStoreIds || [];
  if (!allowed.includes('*') && !allowed.map(String).includes(String(storeId || ''))) {
    ctx.throw(403, '无权访问该门店采购数据');
  }
}

function allocateRebateByItems(items, amount) {
  const totalCents = Math.round(toMoney(amount) * 100);
  const allocations = new Array(items.length).fill(0);
  if (totalCents <= 0 || items.length === 0) return allocations;

  const candidates = items
    .map((item, index) => ({
      index,
      cap: Math.max(0, Math.round(Number(item.price || 0) * Number(item.quantity || 0) * 100))
    }))
    .filter(item => item.cap > 0);

  if (candidates.length === 0) return allocations;

  const cappedTotal = Math.min(totalCents, candidates.reduce((sum, item) => sum + item.cap, 0));
  const base = Math.floor(cappedTotal / candidates.length);
  let extra = cappedTotal % candidates.length;

  for (const item of candidates) {
    const share = base + (extra > 0 ? 1 : 0);
    allocations[item.index] = Math.min(share, item.cap);
    if (extra > 0) extra -= 1;
  }

  let remaining = cappedTotal - allocations.reduce((sum, value) => sum + value, 0);
  for (const item of candidates) {
    if (remaining <= 0) break;
    const capacity = item.cap - allocations[item.index];
    if (capacity <= 0) continue;
    const add = Math.min(capacity, remaining);
    allocations[item.index] += add;
    remaining -= add;
  }

  return allocations.map(value => value / 100);
}

function normalizeSelectedResourceTypes(value) {
  if (Array.isArray(value)) return [...new Set(value.filter(Boolean).map(String))];
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? [...new Set(parsed.filter(Boolean).map(String))] : [];
  } catch (_) {
    return [];
  }
}

function parsePurchaseAllocationArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function getLocationAllocations(allocation) {
  const nested = allocation?.locationAllocations || allocation?.location_allocations;
  if (Array.isArray(nested)) return nested;
  if (allocation?.locationId || allocation?.location_id) {
    return [{
      locationId: allocation.locationId || allocation.location_id,
      locationName: allocation.locationName || allocation.location_name || '',
      quantity: allocation.quantity
    }];
  }
  return [];
}

function flattenPurchaseAllocations(item, fallbackStoreId) {
  const allocations = parsePurchaseAllocationArray(item.storeAllocations || item.store_allocations);
  if (allocations.length === 0) {
    return [{ storeId: fallbackStoreId, locationId: null, quantity: Number(item.quantity || 0) }];
  }

  const flattened = [];
  for (const allocation of allocations) {
    const storeId = allocation.storeId || allocation.store_id || fallbackStoreId;
    const locationAllocations = getLocationAllocations(allocation);
    if (locationAllocations.length === 0) {
      flattened.push({
        storeId,
        locationId: allocation.locationId || allocation.location_id || null,
        quantity: Number(allocation.quantity || 0)
      });
      continue;
    }
    for (const location of locationAllocations) {
      flattened.push({
        storeId,
        locationId: location.locationId || location.location_id || null,
        quantity: Number(location.quantity || 0)
      });
    }
  }
  return flattened.filter(item => item.quantity > 0);
}

async function validatePurchaseAllocations(items, fallbackStoreId, transaction = null) {
  for (const item of items || []) {
    const allocations = parsePurchaseAllocationArray(item.storeAllocations || item.store_allocations);
    if (allocations.length === 0) {
      throw new Error(`商品 ${item.productName || item.product_name || item.productId || item.product_id} 必须分配门店和库位`);
    }

    let totalQuantity = 0;
    for (const allocation of allocations) {
      const storeId = allocation.storeId || allocation.store_id || fallbackStoreId;
      const storeQuantity = Number(allocation.quantity || 0);
      const locationAllocations = getLocationAllocations(allocation);
      if (!storeId || storeQuantity <= 0 || locationAllocations.length === 0) {
        throw new Error(`商品 ${item.productName || item.product_name || item.productId || item.product_id} 必须分配到有效库位`);
      }

      let locationQuantity = 0;
      for (const location of locationAllocations) {
        const locationId = location.locationId || location.location_id;
        const quantity = Number(location.quantity || 0);
        if (!locationId || quantity <= 0) throw new Error('库位分配数量必须大于0');
        const target = await Location.findOne({
          where: { location_id: locationId, store_id: storeId, status: 1 },
          transaction
        });
        if (!target) throw new Error(`库位 ${locationId} 不存在、已停用或不属于对应门店`);
        locationQuantity += quantity;
      }
      if (locationQuantity !== storeQuantity) throw new Error('门店分配数量必须等于该门店的库位分配数量');
      totalQuantity += storeQuantity;
    }
    if (totalQuantity !== Number(item.quantity || 0)) throw new Error('门店分配总数必须等于采购数量');
  }
}

async function refreshPendingInboundSummary(inbound, transaction) {
  const items = await InboundItem.findAll({
    where: { inbound_id: inbound.inbound_id },
    transaction
  });
  const totalQuantity = items.reduce((sum, item) => sum + Math.max(0, Number(item.quantity || 0)), 0);
  const totalAmount = items.reduce((sum, item) => (
    sum + Math.max(0, Number(item.quantity || 0)) * Number(item.unit_price || 0)
  ), 0);
  await inbound.update({
    total_quantity: totalQuantity,
    total_amount: toSignedMoney(totalAmount),
    status: totalQuantity > 0 ? 'pending' : 'cancelled',
    update_time: new Date()
  }, { transaction });
}

function buildAdjustmentRows(request, inbounds, stores) {
  const storeMap = new Map(stores.map(store => [String(store.store_id), store.name]));
  const rows = [];

  for (const requestItem of request.items || []) {
    const inboundItems = [];
    for (const inbound of inbounds) {
      for (const inboundItem of inbound.items || []) {
        if (String(inboundItem.purchase_request_item_id || '') === String(requestItem.item_id)) {
          inboundItems.push({ inbound, inboundItem });
        }
      }
    }

    const receivedQuantity = inboundItems
      .filter(({ inbound }) => inbound.status === 'completed')
      .reduce((sum, { inboundItem }) => sum + Math.max(0, Number(inboundItem.quantity || 0)), 0);
    const pendingQuantityTotal = inboundItems
      .filter(({ inbound }) => inbound.status === 'pending')
      .reduce((sum, { inboundItem }) => sum + Math.max(0, Number(inboundItem.quantity || 0)), 0);
    const unitPrice = Number(requestItem.unit_price || 0);
    const rebatePerUnit = Number(requestItem.quantity || 0) > 0
      ? Number(requestItem.rebate_deduction || 0) / Number(requestItem.quantity)
      : 0;

    const editableRows = inboundItems.filter(({ inbound }) => inbound.status === 'pending');
    if (editableRows.length > 0) {
      for (const { inbound, inboundItem } of editableRows) {
        const effectiveUnitPrice = unitPrice || Number(inboundItem.unit_price || 0);
        rows.push({
          request_item_id: requestItem.item_id,
          inbound_id: inbound.inbound_id,
          inbound_no: inbound.inbound_no,
          inbound_item_id: inboundItem.item_id,
          store_id: inbound.store_id,
          store_name: storeMap.get(String(inbound.store_id)) || inbound.store_id || '',
          product_id: requestItem.product_id,
          product_name: requestItem.product_name || inboundItem.product_name || requestItem.product_id,
          unit_price: effectiveUnitPrice,
          actual_unit_price: toSignedMoney(effectiveUnitPrice - rebatePerUnit),
          original_quantity: Number(requestItem.quantity || 0),
          received_quantity: receivedQuantity,
          pending_quantity: Math.max(0, Number(inboundItem.quantity || 0)),
          pending_quantity_total: pendingQuantityTotal,
          effective_quantity: receivedQuantity + pendingQuantityTotal,
          target_quantity: Math.max(0, Number(inboundItem.quantity || 0)),
          editable: true
        });
      }
      continue;
    }

    const completed = inboundItems.find(({ inbound }) => inbound.status === 'completed');
    rows.push({
      request_item_id: requestItem.item_id,
      inbound_id: completed?.inbound?.inbound_id || '',
      inbound_no: completed?.inbound?.inbound_no || '',
      inbound_item_id: completed?.inboundItem?.item_id || '',
      store_id: completed?.inbound?.store_id || request.store_id,
      store_name: storeMap.get(String(completed?.inbound?.store_id || request.store_id)) || request.store_id || '',
      product_id: requestItem.product_id,
      product_name: requestItem.product_name || requestItem.product_id,
      unit_price: unitPrice,
      actual_unit_price: toSignedMoney(unitPrice - rebatePerUnit),
      original_quantity: Number(requestItem.quantity || 0),
      received_quantity: receivedQuantity,
      pending_quantity: 0,
      pending_quantity_total: pendingQuantityTotal,
      effective_quantity: receivedQuantity + pendingQuantityTotal,
      target_quantity: 0,
      editable: false
    });
  }

  return rows;
}

/**
 * 采购申请列表
 */
async function getRequestList(ctx) {
  const { status, operatorStaffId, submitter, keyword, supplierId, page = 1, pageSize = 20 } = ctx.query;
  const user = ctx.state.user;

  const where = {};
  const whereStore = {};

  // 区域权限过滤
  if (!(user.accessibleStoreIds || []).includes('*')) {
    whereStore.store_id = user.accessibleStoreIds || [];
  }

  const stores = await Store.findAll({ where: whereStore });
  const storeIds = stores.map(s => s.store_id);
  where.store_id = storeIds;

  if (status) where.status = status;
  if (operatorStaffId) where.operator_staff_id = operatorStaffId;
  if (submitter) where.apply_user = { [Op.like]: `%${String(submitter).trim()}%` };
  if (supplierId) where.supplier_id = supplierId;

  if (keyword && String(keyword).trim()) {
    const text = String(keyword).trim();
    const productRows = await Product.findAll({
      attributes: ['product_id'],
      where: {
        [Op.or]: [
          { name: { [Op.like]: `%${text}%` } },
          { product_code: { [Op.like]: `%${text}%` } },
          { manufacturer_code: { [Op.like]: `%${text}%` } }
        ]
      }
    });
    const productIds = productRows.map(row => row.product_id);
    const itemWhere = {
      [Op.or]: [
        { product_name: { [Op.like]: `%${text}%` } },
        { pn_code: { [Op.like]: `%${text}%` } },
        { product_id: { [Op.like]: `%${text}%` } },
        ...(productIds.length ? [{ product_id: { [Op.in]: productIds } }] : [])
      ]
    };
    const itemRows = await PurchaseRequestItem.findAll({ attributes: ['request_id'], where: itemWhere });
    const requestIds = [...new Set(itemRows.map(row => row.request_id))];
    where.request_id = requestIds.length ? { [Op.in]: requestIds } : '__NO_MATCH__';
  }

  const { count, rows } = await PurchaseRequest.findAndCountAll({
    where,
    include: [
      { model: Store },
      { model: Supplier },
      { model: PurchaseRequestItem, as: 'items' }
    ],
    order: buildPendingFirstOrder(sequelize, {
      statusColumn: 'PurchaseRequest.status',
      pendingStatuses: ['draft', 'pending'],
      dateColumns: ['PurchaseRequest.create_time'],
      idColumn: 'PurchaseRequest.request_id'
    }),
    ...paginate({}, { page, pageSize })
  });

  const formattedRows = rows.map(row => {
    const result = row.toJSON();
    result.store_name = result.Store?.name || '';
    result.supplier_name = result.Supplier?.name || '';
    result.submitter_name = result.submitter_name || result.apply_user || result.create_user || result.operator_name || '';
    
    // 汇总商品名称和数量用于前端展示
    if (result.items && result.items.length > 0) {
      result.items_summary = result.items.map(item => 
        `${item.product_name || item.product_id} x ${item.quantity}`
      ).join('; ');
    } else {
      result.items_summary = '';
    }
    
    return result;
  });

  ctx.body = formatPaginatedResult(formattedRows, { page, pageSize, count });
}

/**
 * 获取采购申请详情
 */
async function getRequestDetail(ctx) {
  const { requestId } = ctx.params;

  const request = await PurchaseRequest.findOne({
    where: { request_id: requestId },
    include: [
      { model: Store },
      { model: Supplier },
      { model: PurchaseRequestItem, as: 'items' },
      { model: Inbound, include: [{ model: InboundItem, as: 'items' }] },
      { model: PurchaseAdjustment, as: 'adjustments', include: [{ model: PurchaseAdjustmentItem, as: 'items' }] }
    ]
  });

  if (!request) {
    ctx.throw(404, '采购申请不存在');
  }
  assertStoreVisible(ctx, request.store_id);

  const result = request.toJSON();
  result.store_name = result.Store?.name || '';
  result.supplier_name = result.Supplier?.name || '';

  // 解析门店分配，并关联门店名称
  if (result.items && result.items.length > 0) {
    // 获取所有门店
    const stores = await Store.findAll();
    const storeMap = new Map();
    stores.forEach(s => storeMap.set(s.store_id, s.name));

    result.items = result.items.map(item => {
      const itemJson = item;
      let storeAllocations = [];
      if (itemJson.store_allocations) {
        try {
          storeAllocations = JSON.parse(itemJson.store_allocations);
        } catch (e) {
          // ignore
        }
      }
      // 添加门店名称
      itemJson.store_allocations_parsed = storeAllocations.map(alloc => ({
        ...alloc,
        storeName: storeMap.get(alloc.storeId) || alloc.storeId
      }));
      return itemJson;
    });
  }

  ctx.body = { code: 0, data: result };
}

/**
 * 创建采购申请
 */
async function createRequest(ctx) {
  const user = ctx.state.user;
  const { supplierId, remark, items, storeId, invoiceType, paymentMethod, goodsTypeId, productType, rebateDeduction, saveDraft = false } = ctx.request.body;
  const isDraft = Boolean(saveDraft);

  if (!items || items.length === 0) {
    ctx.throw(400, '请添加商品明细');
  }

  if (!supplierId && !isDraft) {
    ctx.throw(400, '请选择供应商');
  }
  const normalizedPaymentMethod = paymentMethod || 'COMPANY_CREDIT';
  if (!['COMPANY_CREDIT', 'PERSONAL_ADVANCE'].includes(normalizedPaymentMethod)) {
    ctx.throw(400, '付款方式无效');
  }

  const firstTypedItem = items.find(item => item.goodsTypeId || item.goods_type_id || item.productType || item.product_type) || {};
  const requestedGoodsTypeId = goodsTypeId || firstTypedItem.goodsTypeId || firstTypedItem.goods_type_id || '';
  const requestedProductType = productType || firstTypedItem.productType || firstTypedItem.product_type || '';
  const goodsType = requestedGoodsTypeId
    ? await GoodsType.findOne({ where: { goods_type_id: requestedGoodsTypeId, status: 1 } })
    : await GoodsType.findOne({ where: { name: requestedProductType, status: 1 } });
  if (!goodsType && !isDraft) {
    ctx.throw(400, '请选择有效且已启用的货型');
  }
  const canonicalGoodsTypeId = goodsType?.goods_type_id || requestedGoodsTypeId || null;
  const canonicalProductType = goodsType?.name || requestedProductType || '';

  for (const item of items) {
    const itemType = item.productType || item.product_type || canonicalProductType;
    const itemTypeId = item.goodsTypeId || item.goods_type_id || canonicalGoodsTypeId;
    if (!isDraft && (String(itemType) !== String(canonicalProductType) || String(itemTypeId) !== String(canonicalGoodsTypeId))) {
      ctx.throw(400, '同一采购申请中的商品货型必须保持一致');
    }
  }

  const selectedTypeSet = new Set();
  for (const item of items) {
    normalizeSelectedResourceTypes(item.selectedResourceTypes || item.selected_resource_types).forEach(type => selectedTypeSet.add(type));
  }
  if (selectedTypeSet.size > 0) {
    const validCategories = await ResourceCategory.findAll({
      where: { category_code: { [Op.in]: [...selectedTypeSet] }, status: 1, supports_purchase_select: 1 }
    });
    const validSet = new Set(validCategories.map(row => row.category_code));
    for (const type of selectedTypeSet) {
      if (!validSet.has(type)) ctx.throw(400, `资源权益 ${type} 不存在、已停用或不允许采购勾选`);
    }
  }

  const requestNo = generateRequestNo();
  const requestId = generateUUID();

  const totalAmount = toMoney(items.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0));
  const rawItemDeductions = items.map(item => toMoney(item.rebateDeduction || 0));
  const itemDeductionTotal = toMoney(rawItemDeductions.reduce((sum, amount) => sum + amount, 0));
  const itemRebateAllocations = itemDeductionTotal > 0
    ? rawItemDeductions.map((amount, index) => Math.min(amount, toMoney(Number(items[index].price || 0) * Number(items[index].quantity || 0))))
    : allocateRebateByItems(items, Math.min(toMoney(rebateDeduction || 0), totalAmount));
  const deduction = itemDeductionTotal > 0
    ? Math.min(toMoney(itemRebateAllocations.reduce((sum, amount) => sum + amount, 0)), totalAmount)
    : Math.min(toMoney(rebateDeduction || 0), totalAmount);
  const actualTotal = totalAmount - deduction;

  // 如果有返利抵扣，验证并记录
  if (deduction > 0 && !isDraft) {
    const currentBalance = await _getRebateBalance(supplierId);
    
    if (deduction > currentBalance) {
      ctx.throw(400, `返利余额不足，当前余额 ¥${currentBalance.toFixed(2)}`);
    }
    
    await recordRebateDeduction(
      supplierId,
      '',
      deduction,
      requestNo,
      `采购申请 ${requestNo} 返利抵扣`,
      user.name || user.phone
    );
  }

  // 如果用户没有 storeId，尝试从门店分配中获取第一个，或者使用默认值
  const targetStoreId = storeId || user.storeId;
  
  // 查找第一个有效的门店
  let finalStoreId = targetStoreId;
  if (!finalStoreId) {
    for (const item of items) {
      if (item.storeAllocations && item.storeAllocations.length > 0) {
        finalStoreId = item.storeAllocations[0].storeId;
        break;
      }
    }
  }
  
  // 如果还是没有，尝试从用户的区域权限查找一个门店
  if (!finalStoreId) {
    const whereStore = {};
    if (!(user.accessibleStoreIds || []).includes('*')) {
      whereStore.store_id = user.accessibleStoreIds || [];
    }
    const stores = await Store.findAll({ where: whereStore, limit: 1 });
    if (stores.length > 0) {
      finalStoreId = stores[0].store_id;
    } else {
      finalStoreId = 'DEFAULT_STORE';
    }
  }

  try {
    await validatePurchaseAllocations(items, finalStoreId);
  } catch (error) {
    ctx.throw(400, error.message);
  }

  const now = new Date();
  const submitterName = user.name || user.phone || String(user.staffId || '');
  const createdRequest = await PurchaseRequest.create({
    request_id: requestId,
    request_no: requestNo,
    store_id: finalStoreId,
    supplier_id: supplierId || null,
    goods_type_id: canonicalGoodsTypeId,
    product_type: canonicalProductType,
    invoice_type: invoiceType || '',
    payment_method: normalizedPaymentMethod,
    reason: remark || '',
    total_amount: totalAmount,
    rebate_deduction: deduction,
    actual_total: actualTotal,
    status: isDraft ? 'draft' : 'pending',
    apply_user: submitterName,
    create_time: now,
    update_time: now
  });

  // 创建明细
  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex];
    const productId = item.productId || '';
    const quantity = item.quantity || 0;
    const unitPrice = item.price || 0;
    const subtotal = unitPrice * quantity;

    await PurchaseRequestItem.create({
      request_id: requestId,
      product_id: productId,
      product_name: item.productName || '',
      pn_code: item.pnCode || '',
      quantity: quantity,
      unit_price: unitPrice,
      subtotal: subtotal,
      rebate_deduction: itemRebateAllocations[itemIndex] || 0,
      goods_type_id: canonicalGoodsTypeId,
      product_type: canonicalProductType,
      store_allocations: item.storeAllocations ? JSON.stringify(item.storeAllocations) : null,
      selected_resource_types: JSON.stringify(normalizeSelectedResourceTypes(item.selectedResourceTypes || item.selected_resource_types))
    });
  }

  if (normalizedPaymentMethod === 'PERSONAL_ADVANCE' && !isDraft) {
    createdRequest.Supplier = await Supplier.findByPk(supplierId);
    await createPurchaseReimbursement(createdRequest, user);
  }

  ctx.body = {
    code: 0,
    message: isDraft ? '采购申请草稿已保存' : '采购申请提交成功',
    requestId,
    requestNo,
    status: isDraft ? 'draft' : 'pending'
  };
}

async function saveRequestDraft(ctx) {
  ctx.request.body = { ...(ctx.request.body || {}), saveDraft: true };
  return createRequest(ctx);
}

function canSubmitDraft(user, request) {
  const roles = Array.isArray(user?.roles) ? user.roles : [user?.roleCode].filter(Boolean);
  const privileged = roles.some(role => ['boss', 'admin', 'manager', 'store_manager'].includes(role));
  const operatorNames = [user?.name, user?.phone].filter(Boolean).map(String);
  return privileged || operatorNames.includes(String(request.apply_user || ''));
}

async function validateDraftSubmission(request, ctx) {
  if (!request.supplier_id) ctx.throw(400, '提交采购申请前请选择供应商');
  if (!request.items || request.items.length === 0) ctx.throw(400, '请添加商品明细');
  try {
    await validatePurchaseAllocations(request.items, request.store_id);
  } catch (error) {
    ctx.throw(400, error.message);
  }

  const goodsType = request.goods_type_id
    ? await GoodsType.findOne({ where: { goods_type_id: request.goods_type_id, status: 1 } })
    : await GoodsType.findOne({ where: { name: request.product_type, status: 1 } });
  if (!goodsType) ctx.throw(400, '请选择有效且已启用的货型');

  const selectedTypeSet = new Set();
  for (const item of request.items) {
    if (!item.product_id || Number(item.quantity) <= 0) ctx.throw(400, '商品名称、价格和数量不能为空');
    const itemType = item.product_type || request.product_type;
    const itemTypeId = item.goods_type_id || request.goods_type_id;
    if (String(itemType) !== String(goodsType.name) || String(itemTypeId) !== String(goodsType.goods_type_id)) {
      ctx.throw(400, '同一采购申请中的商品货型必须保持一致');
    }
    normalizeSelectedResourceTypes(item.selected_resource_types).forEach(type => selectedTypeSet.add(type));
  }
  if (selectedTypeSet.size > 0) {
    const validCategories = await ResourceCategory.findAll({
      where: { category_code: { [Op.in]: [...selectedTypeSet] }, status: 1, supports_purchase_select: 1 }
    });
    const validSet = new Set(validCategories.map(row => row.category_code));
    for (const type of selectedTypeSet) {
      if (!validSet.has(type)) ctx.throw(400, `资源权益 ${type} 不存在、已停用或不允许采购勾选`);
    }
  }
  return goodsType;
}

async function submitRequestDraft(ctx) {
  const { requestId } = ctx.params;
  const user = ctx.state.user;
  const request = await PurchaseRequest.findByPk(requestId, {
    include: [{ model: PurchaseRequestItem, as: 'items' }]
  });
  if (!request) ctx.throw(404, '采购申请不存在');
  assertStoreVisible(ctx, request.store_id);
  if (request.status !== 'draft') ctx.throw(400, '只有草稿状态的采购申请可以提交');
  if (!canSubmitDraft(user, request)) ctx.throw(403, '只有草稿创建人、店长或管理员可以提交');

  const goodsType = await validateDraftSubmission(request, ctx);
  const deduction = Math.min(toMoney(request.rebate_deduction || 0), toMoney(request.total_amount || 0));
  if (deduction > 0) {
    const currentBalance = await _getRebateBalance(request.supplier_id);
    if (deduction > currentBalance) ctx.throw(400, `返利余额不足，当前余额：￥${currentBalance.toFixed(2)}`);
    await recordRebateDeduction(
      request.supplier_id,
      '',
      deduction,
      request.request_no,
      `采购申请 ${request.request_no} 返利抵扣`,
      user.name || user.phone
    );
  }

  request.goods_type_id = goodsType.goods_type_id;
  request.product_type = goodsType.name;
  request.status = 'pending';
  request.update_time = new Date();
  await request.save();

  if (request.payment_method === 'PERSONAL_ADVANCE') {
    request.Supplier = await Supplier.findByPk(request.supplier_id);
    await createPurchaseReimbursement(request, user);
  }

  ctx.body = { code: 0, message: '采购申请提交成功', requestId, requestNo: request.request_no, status: 'pending' };
}

async function updateRequestDraft(ctx) {
  const { requestId } = ctx.params;
  const user = ctx.state.user;
  const { supplierId, remark, items, invoiceType, paymentMethod, goodsTypeId, productType, rebateDeduction } = ctx.request.body;
  const request = await PurchaseRequest.findByPk(requestId);
  if (!request) ctx.throw(404, '采购申请不存在');
  assertStoreVisible(ctx, request.store_id);
  if (request.status !== 'draft') ctx.throw(400, '只有草稿状态的采购申请可以编辑');
  if (!canSubmitDraft(user, request)) ctx.throw(403, '只有草稿创建人、店长或管理员可以编辑');
  if (!Array.isArray(items) || items.length === 0) ctx.throw(400, '请添加商品明细');
  if (!['COMPANY_CREDIT', 'PERSONAL_ADVANCE'].includes(paymentMethod || 'COMPANY_CREDIT')) {
    ctx.throw(400, '付款方式无效');
  }
  for (const item of items) {
    if (!item.productId || Number(item.quantity) <= 0) ctx.throw(400, '商品名称、价格和数量不能为空');
  }
  try {
    await validatePurchaseAllocations(items, request.store_id);
  } catch (error) {
    ctx.throw(400, error.message);
  }

  const goodsType = goodsTypeId
    ? await GoodsType.findOne({ where: { goods_type_id: goodsTypeId, status: 1 } })
    : await GoodsType.findOne({ where: { name: productType, status: 1 } });
  const canonicalGoodsTypeId = goodsType?.goods_type_id || goodsTypeId || null;
  const canonicalProductType = goodsType?.name || productType || '';
  const totalAmount = toMoney(items.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0));
  const rawItemDeductions = items.map(item => toMoney(item.rebateDeduction || 0));
  const itemDeductionTotal = toMoney(rawItemDeductions.reduce((sum, amount) => sum + amount, 0));
  const itemRebateAllocations = itemDeductionTotal > 0
    ? rawItemDeductions.map((amount, index) => Math.min(amount, toMoney(Number(items[index].price || 0) * Number(items[index].quantity || 0))))
    : allocateRebateByItems(items, Math.min(toMoney(rebateDeduction || 0), totalAmount));
  const deduction = itemDeductionTotal > 0
    ? Math.min(toMoney(itemRebateAllocations.reduce((sum, amount) => sum + amount, 0)), totalAmount)
    : Math.min(toMoney(rebateDeduction || 0), totalAmount);

  await sequelize.transaction(async transaction => {
    await request.update({
      supplier_id: supplierId || null,
      invoice_type: invoiceType || '',
      payment_method: paymentMethod || 'COMPANY_CREDIT',
      goods_type_id: canonicalGoodsTypeId,
      product_type: canonicalProductType,
      reason: remark || '',
      total_amount: totalAmount,
      rebate_deduction: deduction,
      actual_total: totalAmount - deduction,
      update_time: new Date()
    }, { transaction });
    await PurchaseRequestItem.destroy({ where: { request_id: requestId }, transaction });
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      await PurchaseRequestItem.create({
        request_id: requestId,
        product_id: item.productId,
        product_name: item.productName || '',
        pn_code: item.pnCode || '',
        quantity: Number(item.quantity),
        unit_price: Number(item.price || 0),
        subtotal: Number(item.price || 0) * Number(item.quantity || 0),
        rebate_deduction: itemRebateAllocations[index] || 0,
        goods_type_id: canonicalGoodsTypeId,
        product_type: canonicalProductType,
        store_allocations: item.storeAllocations ? JSON.stringify(item.storeAllocations) : null,
        selected_resource_types: JSON.stringify(normalizeSelectedResourceTypes(item.selectedResourceTypes || item.selected_resource_types))
      }, { transaction });
    }
  });

  ctx.body = { code: 0, message: '采购申请草稿已保存', requestId, requestNo: request.request_no, status: 'draft' };
}

async function ensurePayableForApprovedRequest(request, user, transaction = null) {
  if (request.payment_method === 'PERSONAL_ADVANCE') return;
  if (!request.supplier_id) return;

  const amount = parseFloat(
    request.actual_total !== null && request.actual_total !== undefined
      ? request.actual_total
      : request.total_amount
  ) || 0;
  if (amount <= 0) return;

  const existingPayable = await Payable.findOne({
    where: { request_id: request.request_id },
    transaction
  });

  if (existingPayable) {
    if (existingPayable.status !== 'paid') {
      await existingPayable.update({
        supplier_id: request.supplier_id,
        request_no: request.request_no,
        total_amount: amount,
        paid_amount: existingPayable.status === 'unpaid' ? 0 : existingPayable.paid_amount
      }, { transaction });
    }
    return;
  }

  const supplier = await Supplier.findByPk(request.supplier_id, { transaction });
  await Payable.create({
    payable_id: generateUUID(),
    supplier_id: request.supplier_id,
    supplier_name: supplier ? supplier.name : '',
    request_id: request.request_id,
    request_no: request.request_no,
    payee_type: 'supplier',
    payee_id: request.supplier_id,
    payee_name: supplier ? supplier.name : '',
    source_type: 'purchase',
    source_id: request.request_id,
    source_no: request.request_no,
    total_amount: amount,
    paid_amount: 0,
    status: 'unpaid',
    create_time: new Date()
  }, { transaction });
}

/**
 * 审批采购申请
 */
async function approveRequest(ctx) {
  const { requestId } = ctx.params;
  const { status, comment } = ctx.request.body;
  const user = ctx.state.user;

  const request = await PurchaseRequest.findByPk(requestId, {
    include: [{ model: PurchaseRequestItem, as: 'items' }]
  });
  if (!request) {
    ctx.throw(404, '采购申请不存在');
  }
  assertStoreVisible(ctx, request.store_id);

  const transaction = await sequelize.transaction();
  try {
  await request.update({
    status,
    approve_user: user.name,
    approve_comment: comment,
    update_time: new Date()
  }, { transaction });

  // 如果审批通过，自动生成入库单
  if (status === 'approved' && request.items && request.items.length > 0) {
    await ensurePayableForApprovedRequest(request, user, transaction);

    // 获取所有商品信息备用
    const productIds = request.items.map(item => item.product_id);
    const products = await Product.findAll({
      where: { product_id: { [Op.in]: productIds } },
      transaction
    });
    const productMap = new Map();
    products.forEach(p => productMap.set(p.product_id, p));

    // 按照门店分配创建入库单
    const storeItemsMap = new Map();

    // 解析门店分配并按门店分组
    for (const item of request.items) {
      const allocations = flattenPurchaseAllocations(item, request.store_id);

      // 确保商品名称存在
      let productName = item.product_name;
      if (!productName || productName.trim() === '') {
        const product = productMap.get(item.product_id);
        if (product) {
          productName = product.name;
        }
      }

      for (const alloc of allocations) {
        const storeId = alloc.storeId || request.store_id;
        if (!storeItemsMap.has(storeId)) {
          storeItemsMap.set(storeId, []);
        }
        storeItemsMap.get(storeId).push({
          ...item.toJSON(),
          product_name: productName,
          allocatedQuantity: alloc.quantity || item.quantity,
          locationId: alloc.locationId || null,
          selected_resource_types: item.selected_resource_types || '[]',
          purchase_request_item_id: item.item_id
        });
      }
    }

    // 为每个门店创建入库单
    for (const [storeId, items] of storeItemsMap.entries()) {
      const inboundNo = generateInboundNo();
      const inboundId = generateUUID();

      const totalQuantity = items.reduce((sum, item) => sum + (item.allocatedQuantity || item.quantity), 0);
      const totalAmount = items.reduce((sum, item) => 
        sum + (item.unit_price || 0) * (item.allocatedQuantity || item.quantity), 0);

      // 创建入库单
      await Inbound.create({
        inbound_id: inboundId,
        inbound_no: inboundNo,
        store_id: storeId,
        source_type: 'purchase',
        source_no: request.request_no,
        purchase_request_id: request.request_id,
        total_amount: totalAmount,
        total_quantity: totalQuantity,
        status: 'pending',
        create_user: user.name,
        create_time: new Date(),
        update_time: new Date()
      }, { transaction });

      // 创建入库明细
      for (const item of items) {
        await InboundItem.create({
          inbound_id: inboundId,
          product_id: item.product_id,
          product_name: item.product_name,
          pn_code: item.pn_code,
          unit_price: item.unit_price,
          quantity: item.allocatedQuantity || item.quantity,
          product_type: item.product_type || '',
          location_id: item.locationId || null,
          selected_resource_types: item.selected_resource_types || '[]',
          purchase_request_item_id: item.purchase_request_item_id || item.item_id,
          store_allocations: JSON.stringify([{
            storeId: storeId,
            locationId: item.locationId || null,
            quantity: item.allocatedQuantity || item.quantity
          }])
        }, { transaction });
      }
    }
  }

  await transaction.commit();
  ctx.body = { code: 0, message: '审批完成' };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

/**
 * 获取采购退单/采购数量调整预览
 */
async function getAdjustmentPreview(ctx) {
  const { requestId } = ctx.params;
  const request = await PurchaseRequest.findByPk(requestId, {
    include: [
      { model: Supplier },
      { model: PurchaseRequestItem, as: 'items' },
      { model: Inbound, include: [{ model: InboundItem, as: 'items' }] }
    ]
  });

  if (!request) ctx.throw(404, '采购申请不存在');
  assertStoreVisible(ctx, request.store_id);
  if (request.status !== 'approved') ctx.throw(400, '只有已通过的采购订单才能办理退单/数量调整');

  const inbounds = request.Inbounds || [];
  const rows = buildAdjustmentRows(request, inbounds, await Store.findAll());
  if (!rows.some(row => row.editable && row.pending_quantity > 0)) {
    ctx.throw(400, '该采购订单没有未入库商品可调整');
  }

  ctx.body = {
    code: 0,
    data: {
      request_id: request.request_id,
      request_no: request.request_no,
      store_id: request.store_id,
      supplier_id: request.supplier_id,
      supplier_name: request.Supplier?.name || '',
      payment_method: request.payment_method,
      rows
    }
  };
}

async function recordPurchaseAdjustmentRebate({ request, adjustmentNo, rebateDelta, user, transaction }) {
  const amount = Math.abs(toSignedMoney(rebateDelta));
  if (amount <= 0 || !request.supplier_id) return;

  const currentBalance = await _getRebateBalance(request.supplier_id, transaction);
  if (rebateDelta > 0 && amount > currentBalance) {
    const error = new Error(`返利余额不足，当前余额 ¥${currentBalance.toFixed(2)}`);
    error.status = 400;
    throw error;
  }

  const supplier = await Supplier.findByPk(request.supplier_id, { transaction });
  const newBalance = toSignedMoney(currentBalance + (rebateDelta > 0 ? -amount : amount));
  await SupplierRebate.create({
    rebate_id: generateUUID(),
    supplier_id: request.supplier_id,
    supplier_name: supplier?.name || '',
    type: rebateDelta > 0 ? 'debit' : 'credit',
    amount,
    balance: newBalance,
    related_no: adjustmentNo,
    remark: rebateDelta > 0 ? `采购调整 ${adjustmentNo} 增加数量，追加返利抵扣` : `采购调整 ${adjustmentNo} 减少数量，退回返利抵扣`,
    status: 'active',
    source_type: 'purchase_adjustment',
    create_user: user.name || user.phone
  }, { transaction });
  await recordSupplierRebateAccountTransaction(
    request.supplier_id,
    rebateDelta > 0 ? 'expense' : 'income',
    amount,
    rebateDelta > 0 ? '采购调整追加返利抵扣' : '采购调整退回返利抵扣',
    adjustmentNo,
    user.name || user.phone,
    transaction
  );
}

/**
 * 创建采购退单/采购数量调整单。
 * 只调整待入库明细；已完成入库的明细仅用于校验和追溯。
 */
async function createPurchaseAdjustment(ctx) {
  const { requestId, reason = '', items = [] } = ctx.request.body || {};
  const user = ctx.state.user;

  if (!requestId) ctx.throw(400, '缺少采购订单ID');
  if (!Array.isArray(items) || items.length === 0) ctx.throw(400, '请填写需要调整的商品数量');

  const transaction = await sequelize.transaction();
  try {
    const request = await PurchaseRequest.findByPk(requestId, {
      include: [
        { model: Supplier },
        { model: PurchaseRequestItem, as: 'items' },
        { model: Inbound, include: [{ model: InboundItem, as: 'items' }] }
      ],
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!request) ctx.throw(404, '采购申请不存在');
    assertStoreVisible(ctx, request.store_id);
    if (request.status !== 'approved') ctx.throw(400, '只有已通过的采购订单才能办理退单/数量调整');

    const inbounds = await Inbound.findAll({
      where: { purchase_request_id: requestId },
      include: [{ model: InboundItem, as: 'items' }],
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    const requestItemMap = new Map((request.items || []).map(item => [String(item.item_id), item]));
    const inboundItemMap = new Map();
    for (const inbound of inbounds) {
      for (const inboundItem of inbound.items || []) {
        inboundItemMap.set(String(inboundItem.item_id), { inbound, inboundItem });
      }
    }

    const submitted = new Map();
    for (const row of items) {
      const inboundItemId = String(row.inboundItemId || row.inbound_item_id || '');
      if (!inboundItemId) continue;
      if (submitted.has(inboundItemId)) ctx.throw(400, '退单明细重复');
      const targetQuantity = Number(row.targetQuantity ?? row.target_quantity);
      if (!Number.isInteger(targetQuantity) || targetQuantity < 0) {
        ctx.throw(400, '调整后数量必须是大于等于0的整数');
      }
      submitted.set(inboundItemId, targetQuantity);
    }
    if (submitted.size === 0) ctx.throw(400, '没有有效的退单明细');

    const receivedByRequestItem = new Map();
    for (const inbound of inbounds) {
      if (inbound.status !== 'completed') continue;
      for (const inboundItem of inbound.items || []) {
        const key = String(inboundItem.purchase_request_item_id || '');
        receivedByRequestItem.set(key, (receivedByRequestItem.get(key) || 0) + Math.max(0, Number(inboundItem.quantity || 0)));
      }
    }

    const adjustmentId = generateUUID();
    const adjustmentNo = generateId('PRA');
    let totalQuantityDelta = 0;
    let totalAmountDelta = 0;
    let totalRebateDelta = 0;
    let changedItemCount = 0;

    for (const [inboundItemId, targetQuantity] of submitted.entries()) {
      const matched = inboundItemMap.get(inboundItemId);
      if (!matched) ctx.throw(400, '待入库明细不存在或不属于该采购订单');
      const { inbound, inboundItem } = matched;
      if (inbound.status !== 'pending') ctx.throw(400, `商品 ${inboundItem.product_name || inboundItem.product_id} 已入库，不能通过退单调整`);

      const requestItem = requestItemMap.get(String(inboundItem.purchase_request_item_id || ''));
      if (!requestItem) ctx.throw(400, '采购明细不存在');
      const currentQuantity = Math.max(0, Number(inboundItem.quantity || 0));
      const quantityDelta = targetQuantity - currentQuantity;
      if (quantityDelta === 0) continue;

      const originalQuantity = Math.max(0, Number(requestItem.quantity || 0));
      const unitPrice = Number(requestItem.unit_price || inboundItem.unit_price || 0);
      const rebatePerUnit = originalQuantity > 0
        ? Number(requestItem.rebate_deduction || 0) / originalQuantity
        : 0;
      const amountDelta = toSignedMoney(quantityDelta * (unitPrice - rebatePerUnit));
      const rebateDelta = toSignedMoney(quantityDelta * rebatePerUnit);
      const receivedQuantity = receivedByRequestItem.get(String(requestItem.item_id)) || 0;

      await inboundItem.update({ quantity: targetQuantity }, { transaction });
      await PurchaseAdjustmentItem.create({
        adjustment_id: adjustmentId,
        request_item_id: requestItem.item_id,
        inbound_id: inbound.inbound_id,
        inbound_item_id: inboundItem.item_id,
        store_id: inbound.store_id,
        product_id: requestItem.product_id,
        product_name: requestItem.product_name || inboundItem.product_name || '',
        unit_price,
        original_quantity: originalQuantity,
        received_quantity: receivedQuantity,
        pending_quantity_before: currentQuantity,
        target_quantity: targetQuantity,
        quantity_delta: quantityDelta,
        amount_delta: amountDelta,
        remark: reason || ''
      }, { transaction });

      totalQuantityDelta += quantityDelta;
      totalAmountDelta = toSignedMoney(totalAmountDelta + amountDelta);
      totalRebateDelta = toSignedMoney(totalRebateDelta + rebateDelta);
      changedItemCount += 1;
    }

    if (changedItemCount === 0) ctx.throw(400, '调整后数量未发生变化');

    for (const inbound of inbounds.filter(item => item.status === 'pending')) {
      await refreshPendingInboundSummary(inbound, transaction);
    }

    await PurchaseAdjustment.create({
      adjustment_id: adjustmentId,
      adjustment_no: adjustmentNo,
      request_id: request.request_id,
      request_no: request.request_no,
      store_id: request.store_id,
      supplier_id: request.supplier_id,
      supplier_name: request.Supplier?.name || '',
      total_quantity_delta: totalQuantityDelta,
      total_amount_delta: totalAmountDelta,
      reason: reason || '',
      status: 'completed',
      create_user: user.name || user.phone,
      create_time: new Date()
    }, { transaction });

    await recordPurchaseAdjustmentRebate({
      request,
      adjustmentNo,
      rebateDelta: totalRebateDelta,
      user,
      transaction
    });

    let payableId = '';
    if (request.payment_method === 'PERSONAL_ADVANCE') {
      const expense = await Expense.findOne({
        where: { source_type: 'purchase', source_id: request.request_id },
        transaction,
        lock: transaction.LOCK.UPDATE
      });
      if (expense && expense.status === 'paid') ctx.throw(400, '个人垫付采购已完成付款，不能再调整');
      if (expense) {
        const nextAmount = toSignedMoney(Number(expense.amount || 0) + totalAmountDelta);
        await expense.update({
          amount: Math.max(0, nextAmount),
          status: nextAmount <= 0 ? 'cancelled' : expense.status,
          review_comment: `${expense.review_comment || ''}${expense.review_comment ? '；' : ''}采购调整 ${adjustmentNo}`,
          update_time: new Date()
        }, { transaction });
      }
    } else if (Math.abs(totalAmountDelta) > 0) {
      payableId = generateUUID();
      await Payable.create({
        payable_id: payableId,
        supplier_id: request.supplier_id,
        supplier_name: request.Supplier?.name || '',
        request_id: request.request_id,
        request_no: adjustmentNo,
        payee_type: 'supplier',
        payee_id: request.supplier_id,
        payee_name: request.Supplier?.name || '',
        source_type: 'purchase_adjustment',
        source_id: adjustmentId,
        source_no: adjustmentNo,
        total_amount: totalAmountDelta,
        paid_amount: 0,
        status: 'unpaid',
        create_time: new Date()
      }, { transaction });
    }

    await transaction.commit();
    ctx.body = {
      code: 0,
      message: totalQuantityDelta < 0 ? '采购退单完成，已生成负向待付款调整' : '采购数量调整完成，已生成正向待付款调整',
      data: { adjustmentId, adjustmentNo, payableId, totalQuantityDelta, totalAmountDelta }
    };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

/**
 * 撤销采购申请
 */
async function revokeRequest(ctx) {
  const { requestId } = ctx.params;
  const { comment } = ctx.request.body;
  const user = ctx.state.user;

  const request = await PurchaseRequest.findOne({
    where: { request_id: requestId },
    include: [{ model: Inbound, include: [{ model: InboundItem, as: 'items' }] }]
  });

  if (!request) {
    ctx.throw(404, '采购申请不存在');
  }
  assertStoreVisible(ctx, request.store_id);

  if (request.status !== 'approved') {
    ctx.throw(400, '只有已通过的采购申请才能撤销');
  }

  if (request.Inbounds && request.Inbounds.length > 0) {
    const completedInbounds = request.Inbounds.filter(i => i.status === 'completed');
    if (completedInbounds.length > 0) {
      ctx.throw(400, '该采购申请已有商品入库，无法撤销，请先办理退库');
    }
  }

  const transaction = await sequelize.transaction();
  try {
    if (request.Inbounds && request.Inbounds.length > 0) {
      for (const inbound of request.Inbounds) {
        await InboundItem.destroy({
          where: { inbound_id: inbound.inbound_id },
          transaction
        });
        await Inbound.destroy({
          where: { inbound_id: inbound.inbound_id },
          transaction
        });
      }
    }

    await Payable.destroy({
      where: { request_id: requestId },
      transaction
    });
    await Expense.update({
      status: 'cancelled',
      review_comment: comment || '采购申请已撤销',
      update_time: new Date()
    }, {
      where: { source_type: 'purchase', source_id: requestId },
      transaction
    });

    if (request.rebate_deduction && parseFloat(request.rebate_deduction) > 0) {
      const currentBalance = await _getRebateBalance(request.supplier_id, transaction);
      const newBalance = currentBalance + parseFloat(request.rebate_deduction);
      const supplier = await Supplier.findByPk(request.supplier_id);
      await SupplierRebate.create({
        rebate_id: generateUUID(),
        supplier_id: request.supplier_id,
        supplier_name: (supplier && supplier.name) || '',
        type: 'credit',
        amount: parseFloat(request.rebate_deduction),
        balance: newBalance,
        related_no: request.request_no,
        remark: `采购申请 ${request.request_no} 撤销，退回返利抵扣`,
        status: 'active',
        source_type: 'purchase_reversal',
        create_user: user.name || user.phone
      }, { transaction });
      await recordSupplierRebateAccountTransaction(
        request.supplier_id, 'income', request.rebate_deduction,
        '采购撤销退回返利抵扣', request.request_no, user.name || user.phone, transaction
      );
    }

    await request.update({
      status: 'revoked',
      approve_user: request.approve_user,
      approve_comment: request.approve_comment,
      revoke_user: user.name,
      revoke_comment: comment,
      update_time: new Date()
    }, { transaction });

    await transaction.commit();

    ctx.body = { code: 0, message: '撤销成功' };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

/**
 * 供应商列表
 */
async function getSupplierList(ctx) {
  const { keyword, status, page = 1, pageSize = 20 } = ctx.query;

  const where = { is_deleted: 0 };
  if (status !== undefined && status !== '') {
    where.status = Number(status);
  }
  if (keyword) {
    where[Op.or] = [
      { name: { [Op.like]: `%${keyword}%` } },
      { contact: { [Op.like]: `%${keyword}%` } }
    ];
  }

  const { count, rows } = await Supplier.findAndCountAll({
    where,
    include: [{ model: SupplierPaymentAccount, as: 'paymentAccounts', where: { is_deleted: 0 }, required: false }],
    order: [['sort_order', 'ASC'], ['create_time', 'DESC']],
    distinct: true,
    ...paginate({}, { page, pageSize })
  });

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

/**
 * 获取所有供应商（不分页，用于下拉选择）
 */
async function getAllSuppliers(ctx) {
  const where = { is_deleted: 0, status: 1 };

  const rows = await Supplier.findAll({
    where,
    include: [{ model: SupplierPaymentAccount, as: 'paymentAccounts', where: { is_deleted: 0 }, required: false }],
    order: [['sort_order', 'ASC'], ['create_time', 'DESC']]
  });

  ctx.body = { code: 0, data: rows };
}

/**
 * 创建供应商
 */
async function createSupplier(ctx) {
  const {
    name, contact, phone, address, invoiceType, remark, status = 1, paymentAccounts = [],
    isServiceProvider = true, grossProfitUpliftAmount = 0
  } = ctx.request.body;

  if (!name) {
    ctx.throw(400, '供应商名称不能为空');
  }
  const normalizedUplift = normalizeGrossProfitUpliftAmount(grossProfitUpliftAmount);
  if (normalizedUplift === null) ctx.throw(400, '毛利上浮额度必须是大于或等于0的金额');

  const supplierId = generateId('SP');

  await sequelize.transaction(async (transaction) => {
    await Supplier.create({
      supplier_id: supplierId,
      name,
      contact: contact || '',
      phone: phone || '',
      address: address || '',
      invoice_type: invoiceType || '',
      is_service_provider: isServiceProvider ? 1 : 0,
      gross_profit_uplift_amount: normalizedUplift,
      remark: remark || '',
      sort_order: await Supplier.count({ where: { is_deleted: 0 }, transaction }),
      status,
      create_time: new Date(),
      update_time: new Date()
    }, { transaction });

    await saveSupplierPaymentAccounts(supplierId, paymentAccounts, transaction);
  });

  ctx.body = { code: 0, message: '创建成功' };
}

/**
 * 更新供应商
 */
async function updateSupplier(ctx) {
  const { id } = ctx.params;
  const {
    name, contact, phone, address, invoiceType, remark, sortOrder, status, paymentAccounts,
    isServiceProvider, grossProfitUpliftAmount
  } = ctx.request.body;

  const supplier = await Supplier.findOne({
    where: { supplier_id: id, is_deleted: 0 }
  });

  if (!supplier) {
    ctx.throw(404, '供应商不存在');
  }
  const normalizedUplift = normalizeGrossProfitUpliftAmount(
    grossProfitUpliftAmount,
    supplier.gross_profit_uplift_amount
  );
  if (normalizedUplift === null) ctx.throw(400, '毛利上浮额度必须是大于或等于0的金额');

  await sequelize.transaction(async (transaction) => {
    await supplier.update({
      name: name || supplier.name,
      contact: contact !== undefined ? contact : supplier.contact,
      phone: phone !== undefined ? phone : supplier.phone,
      address: address !== undefined ? address : supplier.address,
      invoice_type: invoiceType !== undefined ? invoiceType : supplier.invoice_type,
      is_service_provider: isServiceProvider !== undefined
        ? (isServiceProvider ? 1 : 0)
        : supplier.is_service_provider,
      gross_profit_uplift_amount: normalizedUplift,
      remark: remark !== undefined ? remark : supplier.remark,
      sort_order: sortOrder !== undefined ? sortOrder : supplier.sort_order,
      status: status !== undefined ? status : supplier.status,
      update_time: new Date()
    }, { transaction });

    if (Array.isArray(paymentAccounts)) {
      await saveSupplierPaymentAccounts(id, paymentAccounts, transaction);
    }
  });

  ctx.body = { code: 0, message: '更新成功' };
}

async function saveSupplierPaymentAccounts(supplierId, paymentAccounts, transaction) {
  await SupplierPaymentAccount.update(
    { is_deleted: 1, status: 0, update_time: new Date() },
    { where: { supplier_id: supplierId }, transaction }
  );

  const validAccounts = (paymentAccounts || []).filter(acc =>
    acc.companyName || acc.company_name || acc.taxNo || acc.tax_no || acc.bankName || acc.bank_name || acc.accountNumber || acc.account_number || acc.remark
  );

  for (const [index, acc] of validAccounts.entries()) {
    await SupplierPaymentAccount.create({
      account_id: generateUUID(),
      supplier_id: supplierId,
      company_name: acc.companyName || acc.company_name || '',
      tax_no: acc.taxNo || acc.tax_no || '',
      bank_name: acc.bankName || acc.bank_name || '',
      account_number: acc.accountNumber || acc.account_number || '',
      remark: acc.remark || '',
      sort_order: index,
      status: 1,
      is_deleted: 0,
      create_time: new Date(),
      update_time: new Date()
    }, { transaction });
  }
}

/**
 * 删除供应商
 */
async function deleteSupplier(ctx) {
  const { id } = ctx.params;

  const supplier = await Supplier.findOne({
    where: { supplier_id: id, is_deleted: 0 }
  });

  if (!supplier) {
    ctx.throw(404, '供应商不存在');
  }

  await supplier.update({ is_deleted: 1 });
  ctx.body = { code: 0, message: '删除成功' };
}

async function sortSuppliers(ctx) {
  const { items } = ctx.request.body;
  if (!Array.isArray(items)) {
    ctx.throw(400, '排序数据格式无效');
  }

  await sequelize.transaction(async (transaction) => {
    for (const item of items) {
      if (!item.id) continue;
      await Supplier.update(
        { sort_order: item.sortOrder, update_time: new Date() },
        { where: { supplier_id: item.id, is_deleted: 0 }, transaction }
      );
    }
  });

  ctx.body = { code: 0, message: '排序更新成功' };
}

module.exports = {
  getRequestList,
  getRequestDetail,
  createRequest,
  saveRequestDraft,
  updateRequestDraft,
  submitRequestDraft,
  approveRequest,
  revokeRequest,
  getAdjustmentPreview,
  createPurchaseAdjustment,
  getSupplierList,
  getAllSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  sortSuppliers,
  _test: {
    flattenPurchaseAllocations
  }
};
