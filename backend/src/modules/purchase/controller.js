/**
 * 采购管理控制器
 */
const { sequelize, PurchaseRequest, PurchaseRequestItem, PurchaseAdjustment, PurchaseAdjustmentItem, Supplier, SupplierPaymentAccount, Store, Staff, Distributor, Location, Product, ProductSn, Inbound, InboundItem, ReturnStock, ReturnStockItem, Payable, Expense, Settlement, SupplierRebate, ResourceCategory, GoodsType, SnLog } = require('../../models');
const { Op } = require('sequelize');
const { generateRequestNo, generateUUID, generateId, generateInboundNo, paginate, formatPaginatedResult, buildPendingFirstOrder } = require('../../utils');
const { sendExcel } = require('../../utils/excelExport');
const { recordRebateDeduction, recordSupplierRebateAccountTransaction, _getRebateBalance } = require('../finance/rebateController');
const { createPurchaseReimbursement, createSettlementReversal, cancelExpenseRecord } = require('../finance/expenseService');
const { recordBusinessAction, listBusinessActions } = require('../../utils/businessActionLog');
const { canViewSnTraceReference } = require('../../utils/snTracePermission');
const { isUsablePnCode } = require('../../utils/productPn');
const { assertPnAvailableForNewProduct } = require('../../utils/productPnMaster');
const { getUserRoles } = require('../../middleware/permission');
const { isStoreScopedAccount } = require('../../utils/storePermissions');
const { syncFreightRecord, setFreightRecordStatus } = require('../finance/freightService');
const { createProductRecord } = require('../product/controller');
const { executeInbound, updateInventory, getAvailableQty } = require('../inventory/controller');
const { getAllocationSummary, getPayableRemaining, refreshPayableState } = require('../finance/settlementAllocation');
const { assertActiveProducts } = require('../../utils/activeProduct');

function normalizeFileList(...values) {
  const result = [];
  const add = value => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(add);
      return;
    }
    if (typeof value === 'object') {
      add(value.fileID || value.fileId || value.file_id || value.url || value.fileUrl || value.file_url || value.cloudPath || value.cloud_path);
      return;
    }
    const text = String(value).trim();
    if (!text) return;
    try {
      const parsed = JSON.parse(text);
      if (parsed !== value) {
        add(parsed);
        return;
      }
    } catch (_) {
      // 普通字符串按文件 ID 或 URL 处理。
    }
    if (!result.includes(text)) result.push(text);
  };
  values.forEach(add);
  return result;
}

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

function assertPurchaseAllocationStoresVisible(ctx, items, fallbackStoreId) {
  if (fallbackStoreId) assertStoreVisible(ctx, fallbackStoreId);
  for (const item of items || []) {
    const allocations = parsePurchaseAllocationArray(item.storeAllocations || item.store_allocations);
    for (const allocation of allocations) {
      assertStoreVisible(ctx, allocation.storeId || allocation.store_id || fallbackStoreId);
    }
  }
}

async function loadPurchaseProductSnapshots(items, transaction = null) {
  const productIds = [...new Set((items || [])
    .map(item => item.productId || item.product_id)
    .filter(Boolean)
    .map(String))];
  if (productIds.length === 0) return new Map();

  const products = await Product.findAll({
    where: { product_id: { [Op.in]: productIds } },
    attributes: ['product_id', 'product_code', 'manufacturer_code'],
    ...(transaction ? { transaction } : {})
  });
  return new Map(products.map(product => [String(product.product_id), product]));
}

async function assertActivePurchaseProducts(items, transaction = null) {
  const productIds = [...new Set((items || [])
    .filter(item => Number(item?.isUsedProduct ?? item?.is_used_product ?? 0) !== 1)
    .map(item => item.productId || item.product_id)
    .filter(productId => productId && String(productId) !== '__USED_PRODUCT__')
    .map(String))];
  return assertActiveProducts(Product, productIds, transaction ? { transaction } : {});
}

async function assertNewPurchasePnsAvailable(items, transaction = null) {
  for (const item of items || []) {
    const isUsedProduct = Number(item?.isUsedProduct ?? item?.is_used_product ?? 0) === 1;
    const productId = item?.productId || item?.product_id || '';
    if (!isUsedProduct || productId) continue;
    await assertPnAvailableForNewProduct({
      pnCode: item?.pnCode || item?.pn_code || '',
      transaction
    });
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

function assertUsedProductDirectInbound(ctx, item) {
  const isUsedProduct = Boolean(item?.isUsedProduct || item?.is_used_product);
  const directInbound = Boolean(item?.directInbound || item?.direct_inbound);
  if (!isUsedProduct || !directInbound) return;

  const quantity = Number(item?.quantity || 0);
  const snCode = String(item?.directInboundSnCode || item?.direct_inbound_sn_code || '').trim();
  const pnCode = String(item?.pnCode || item?.pn_code || '').trim();
  if (quantity !== 1 || !snCode) {
    ctx.throw(400, '二手商品勾选审批完成及入库时，数量必须为1且必须填写SN号');
  }
  if (!isUsablePnCode(pnCode)) {
    ctx.throw(400, '二手商品勾选审批完成及入库时必须填写PN码');
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

async function findDefaultPurchaseLocation(storeId, transaction = null) {
  const query = { where: { store_id: storeId, status: 1, type: 'normal_qty' } };
  if (transaction) query.transaction = transaction;
  const salesLocation = await Location.findOne(query);
  if (salesLocation) return salesLocation;

  const fallbackQuery = { where: { store_id: storeId, status: 1, is_sellable: 1 } };
  if (transaction) fallbackQuery.transaction = transaction;
  return Location.findOne(fallbackQuery);
}

function parseInboundSnCodes(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(item => String(item || '').trim()).filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

function persistPurchaseAllocations(item, allocations) {
  if (item.storeAllocations !== undefined) item.storeAllocations = allocations;
  if (item.store_allocations !== undefined) {
    item.store_allocations = JSON.stringify(allocations);
    if (typeof item.changed === 'function') item.changed('store_allocations', true);
  }
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
  const defaultLocationByStore = new Map();
  const allocationDistributorIds = new Set();
  const getDefaultLocation = async storeId => {
    const key = String(storeId || '');
    if (!defaultLocationByStore.has(key)) {
      defaultLocationByStore.set(key, findDefaultPurchaseLocation(storeId, transaction));
    }
    return defaultLocationByStore.get(key);
  };

  for (const item of items || []) {
    const allocations = parsePurchaseAllocationArray(item.storeAllocations || item.store_allocations);
    if (allocations.length === 0) {
      throw new Error(`商品 ${item.productName || item.product_name || item.productId || item.product_id} 必须分配门店和库位`);
    }

    let totalQuantity = 0;
    for (const allocation of allocations) {
      const storeId = allocation.storeId || allocation.store_id || fallbackStoreId;
      const storeQuantity = Number(allocation.quantity || 0);
      let locationAllocations = getLocationAllocations(allocation);
      if (locationAllocations.length === 0 && storeId && storeQuantity > 0) {
        const defaultLocation = await getDefaultLocation(storeId);
        if (defaultLocation) {
          const defaultAllocation = {
            locationId: defaultLocation.location_id,
            locationName: defaultLocation.name || '',
            quantity: storeQuantity
          };
          allocation.locationId = defaultAllocation.locationId;
          allocation.locationName = defaultAllocation.locationName;
          allocation.locationAllocations = [defaultAllocation];
          locationAllocations = [defaultAllocation];
        }
      }
      if (!storeId || storeQuantity <= 0 || locationAllocations.length === 0) {
        throw new Error(`商品 ${item.productName || item.product_name || item.productId || item.product_id} 必须分配到有效库位`);
      }

      const allocationStore = await Store.findOne({
        where: { store_id: storeId, is_deleted: 0, status: 1 },
        attributes: ['store_id', 'distributor_id'],
        transaction
      });
      if (!allocationStore) throw new Error(`门店 ${storeId} 不存在、已停用或未绑定经销商`);
      if (allocationStore.distributor_id) allocationDistributorIds.add(String(allocationStore.distributor_id));
      if (allocationDistributorIds.size > 1) throw new Error('同一采购申请不能跨经销商分配门店，请拆分采购申请');

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
      persistPurchaseAllocations(item, allocations);
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

function getPurchaseAdjustmentTotals(adjustments = []) {
  let grossDelta = 0;
  let actualDelta = 0;
  let rebateDelta = 0;
  for (const adjustment of adjustments || []) {
    actualDelta += Number(adjustment.total_amount_delta || 0);
    for (const item of adjustment.items || []) {
      const quantityDelta = Number(item.quantity_delta || 0);
      const unitPrice = Number(item.unit_price || 0);
      const grossItemDelta = quantityDelta * unitPrice;
      grossDelta += grossItemDelta;
      rebateDelta += grossItemDelta - Number(item.amount_delta || 0);
    }
  }
  return {
    grossDelta: toSignedMoney(grossDelta),
    actualDelta: toSignedMoney(actualDelta),
    rebateDelta: toSignedMoney(rebateDelta)
  };
}

function getPurchaseAdjustmentItemDeltas(adjustments = []) {
  const result = new Map();
  for (const adjustment of adjustments || []) {
    for (const item of adjustment.items || []) {
      const key = String(item.request_item_id || '');
      if (!key) continue;
      const current = result.get(key) || { quantityDelta: 0, grossDelta: 0, actualDelta: 0, rebateDelta: 0 };
      const quantityDelta = Number(item.quantity_delta || 0);
      const unitPrice = Number(item.unit_price || 0);
      const grossDelta = quantityDelta * unitPrice;
      const actualDelta = Number(item.amount_delta || 0);
      current.quantityDelta += quantityDelta;
      current.grossDelta += grossDelta;
      current.actualDelta += actualDelta;
      current.rebateDelta += grossDelta - actualDelta;
      result.set(key, current);
    }
  }
  return result;
}

function buildNegativePurchaseOrders(adjustments = []) {
  return (adjustments || [])
    .filter(adjustment => Number(adjustment.total_quantity_delta || 0) < 0)
    .map(adjustment => {
      const row = typeof adjustment.toJSON === 'function' ? adjustment.toJSON() : { ...adjustment };
      return {
        order_id: row.adjustment_id,
        order_no: row.adjustment_no,
        order_type: 'purchase_return',
        order_type_name: '采购退货负订单',
        request_id: row.request_id,
        request_no: row.request_no,
        total_quantity: Number(row.total_quantity_delta || 0),
        total_amount: toSignedMoney(row.total_amount_delta || 0),
        reason: row.reason || '',
        status: row.status || 'completed',
        create_user: row.create_user || '',
        create_time: row.create_time || null,
        items: (row.items || []).map(item => ({
          request_item_id: item.request_item_id,
          inbound_id: item.inbound_id,
          inbound_item_id: item.inbound_item_id,
          product_id: item.product_id,
          product_name: item.product_name || '',
          quantity: Number(item.quantity_delta || 0),
          unit_price: Number(item.unit_price || 0),
          amount: toSignedMoney(item.amount_delta || 0),
          remark: item.remark || ''
        }))
      };
    });
}

function attachCurrentPurchaseItemAmounts(items = [], adjustments = []) {
  const deltas = getPurchaseAdjustmentItemDeltas(adjustments);
  return (items || []).map(item => {
    const key = String(item.item_id || '');
    const delta = deltas.get(key) || { quantityDelta: 0, grossDelta: 0, actualDelta: 0, rebateDelta: 0 };
    const quantity = Number(item.quantity || 0);
    const unitPrice = Number(item.unit_price || 0);
    const originalSubtotal = Number(item.subtotal || quantity * unitPrice);
    const originalRebate = Number(item.rebate_deduction || 0);
    const originalActual = item.actual_amount === null || item.actual_amount === undefined
      ? originalSubtotal - originalRebate
      : Number(item.actual_amount || 0);
    item.current_quantity = Math.max(0, quantity + delta.quantityDelta);
    item.current_subtotal = toSignedMoney(Math.max(0, originalSubtotal + delta.grossDelta));
    item.current_rebate_deduction = toSignedMoney(Math.max(0, originalRebate + delta.rebateDelta));
    item.current_actual_amount = toSignedMoney(Math.max(0, originalActual + delta.actualDelta));
    return item;
  });
}

function attachCurrentPurchaseAmounts(target, adjustments = []) {
  const totals = getPurchaseAdjustmentTotals(adjustments);
  const originalTotal = Number(target.total_amount || 0);
  const originalRebate = Number(target.rebate_deduction || 0);
  const rawActual = Number(target.actual_total || 0);
  const originalActual = target.actual_total === null || target.actual_total === undefined || (rawActual === 0 && originalTotal > 0)
    ? originalTotal - originalRebate
    : rawActual;
  target.original_total_amount = toSignedMoney(originalTotal);
  target.original_rebate_deduction = toSignedMoney(originalRebate);
  target.original_actual_total = toSignedMoney(originalActual);
  target.current_total_amount = toSignedMoney(Math.max(0, originalTotal + totals.grossDelta));
  target.current_rebate_deduction = toSignedMoney(Math.max(0, originalRebate + totals.rebateDelta));
  target.current_actual_total = toSignedMoney(Math.max(0, originalActual + totals.actualDelta));
  return target;
}

async function getPaidPurchaseRequestIds() {
  const [paidPayables, paidReimbursements] = await Promise.all([
    Payable.findAll({
      where: { source_type: 'purchase', status: 'paid', request_id: { [Op.ne]: null } },
      attributes: ['request_id']
    }),
    Expense.findAll({
      where: { source_type: 'purchase', status: 'paid', is_deleted: 0 },
      attributes: ['source_id']
    })
  ]);
  return new Set([
    ...paidPayables.map(row => row.request_id),
    ...paidReimbursements.map(row => row.source_id)
  ].filter(Boolean).map(String));
}

function appendRequestIdCondition(where, condition) {
  const existingConditions = Array.isArray(where[Op.and])
    ? [...where[Op.and]]
    : (where[Op.and] ? [where[Op.and]] : []);
  if (Object.prototype.hasOwnProperty.call(where, 'request_id')) {
    existingConditions.push({ request_id: where.request_id });
    delete where.request_id;
  }
  existingConditions.push({ request_id: condition });
  where[Op.and] = existingConditions;
}

function attachPurchasePaymentStatus(target, paidRequestIds = new Set()) {
  const isApproved = target.status === 'approved';
  const isPaid = isApproved && paidRequestIds.has(String(target.request_id));
  target.payment_status = isApproved ? (isPaid ? 'paid' : 'pending_payment') : '';
  target.display_status = isApproved ? target.payment_status : target.status;
  return target;
}

function appendPurchaseWhereCondition(where, condition) {
  const existingConditions = Array.isArray(where[Op.and])
    ? [...where[Op.and]]
    : (where[Op.and] ? [where[Op.and]] : []);
  existingConditions.push(condition);
  where[Op.and] = existingConditions;
}

function buildPurchaseSubmitterCondition(value, staffIds = []) {
  const text = String(value || '').trim();
  const like = `%${text}%`;
  return {
    [Op.or]: [
      { apply_user: { [Op.like]: like } },
      { submit_user: { [Op.like]: like } },
      { create_user: { [Op.like]: like } },
      ...(staffIds.length ? [{ applicant_staff_id: { [Op.in]: staffIds } }] : [])
    ]
  };
}

function buildPurchaseOperatorCondition(operatorStaffId, operatorName = '') {
  const conditions = [
    { operator_staff_id: operatorStaffId },
    // 历史采购单可能只保存经手人姓名，没有保存员工ID。
    ...(operatorName ? [{ operator_name: operatorName }] : []),
    // 旧数据未写入经手人字段时，用申请人/制单人作为兼容回退。
    { applicant_staff_id: operatorStaffId },
    { create_staff_id: operatorStaffId }
  ];
  return { [Op.or]: conditions };
}

function getPurchaseLifecycleStatus(requestStatus, inboundRows = []) {
  if (requestStatus === 'revoked') return 'revoked';

  const rows = Array.isArray(inboundRows) ? inboundRows.filter(Boolean) : [];
  if (rows.some(item => item.status === 'pending')) return 'pending_inbound';

  const hasReturned = rows.some(item => item.status === 'returned');
  const allInboundClosed = rows.length > 0
    && rows.every(item => ['returned', 'cancelled'].includes(item.status));
  if (hasReturned && allInboundClosed) return 'returned';
  if (hasReturned) return 'partial_return';

  return requestStatus;
}

async function findPurchaseRequestIdsByLifecycleStatus(status) {
  const inboundRows = await Inbound.findAll({
    where: { purchase_request_id: { [Op.ne]: null } },
    attributes: ['purchase_request_id', 'status'],
    raw: true
  });
  const rowsByRequestId = new Map();
  inboundRows.forEach(row => {
    const requestId = String(row.purchase_request_id || '');
    if (!requestId) return;
    if (!rowsByRequestId.has(requestId)) rowsByRequestId.set(requestId, []);
    rowsByRequestId.get(requestId).push(row);
  });

  return [...rowsByRequestId.entries()]
    .filter(([, rows]) => getPurchaseLifecycleStatus('approved', rows) === status)
    .map(([requestId]) => requestId);
}

function buildAdjustmentRows(request, inbounds, stores) {
  const storeMap = new Map(stores.map(store => [String(store.store_id), store.name]));
  const rows = [];
  const receivedQuantityOf = (inbound, inboundItem) => {
    const total = Math.max(Number(inboundItem.quantity || 0), 0);
    const received = Math.max(Number(inboundItem.received_quantity || 0), 0);
    return inbound.status === 'completed' ? Math.max(total, received) : Math.min(total, received);
  };
  const pendingQuantityOf = (inbound, inboundItem) => Math.max(
    Number(inboundItem.quantity || 0) - receivedQuantityOf(inbound, inboundItem),
    0
  );

  for (const requestItem of request.items || []) {
    const inboundItems = [];
    for (const inbound of inbounds) {
      for (const inboundItem of inbound.items || []) {
        if (String(inboundItem.purchase_request_item_id || '') === String(requestItem.item_id)) {
          inboundItems.push({ inbound, inboundItem });
        }
      }
    }

    const unitPrice = Number(requestItem.unit_price || 0);
    const rebatePerUnit = Number(requestItem.quantity || 0) > 0
      ? Number(requestItem.rebate_deduction || 0) / Number(requestItem.quantity)
      : 0;

    for (const { inbound, inboundItem } of inboundItems) {
      const pendingQuantity = pendingQuantityOf(inbound, inboundItem);
      const receivedQuantity = receivedQuantityOf(inbound, inboundItem);
      const editable = (inbound.status === 'pending' && pendingQuantity > 0)
        || (inbound.status === 'completed' && receivedQuantity > 0);
      if (editable) {
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
          pending_quantity: pendingQuantity,
          return_quantity: 0,
          max_return_quantity: inbound.status === 'pending' ? pendingQuantity : receivedQuantity,
          operation_type: inbound.status === 'pending' ? 'pending_cancel' : 'stock_return',
          need_sn: 0,
          sn_options: [],
          editable: true
        });
      }
    }
  }

  return rows;
}

/**
 * 采购申请列表
 */
async function queryRequestList(ctx, { exportMode = false } = {}) {
  const { status, scope, operatorStaffId, submitter, requestNo, keyword, supplierId, page = 1, pageSize = 20 } = ctx.query;
  const user = ctx.state.user;
  const paidRequestIds = await getPaidPurchaseRequestIds();

  const where = { status: { [Op.ne]: 'deleted' } };
  const whereStore = {};

  if (scope === 'review' && !getUserRoles(user).some(role => ['purchaser', 'admin', 'boss'].includes(role))) {
    where.request_id = '__NO_PURCHASE_APPROVAL_ACCESS__';
  }

  // 区域权限过滤
  if (!(user.accessibleStoreIds || []).includes('*')) {
    whereStore.store_id = user.accessibleStoreIds || [];
  }

  const stores = await Store.findAll({ where: whereStore });
  const storeIds = stores.map(s => s.store_id);
  where.store_id = storeIds;

  if (status === 'pending_inbound' || status === 'returned') {
    const lifecycleRequestIds = await findPurchaseRequestIdsByLifecycleStatus(status);
    appendRequestIdCondition(
      where,
      lifecycleRequestIds.length ? { [Op.in]: lifecycleRequestIds } : '__NO_MATCH__'
    );
    if (status === 'pending_inbound') where.status = 'approved';
  } else if (status === 'pending_payment' || status === 'paid') {
    where.status = 'approved';
    if (status === 'paid') {
      appendRequestIdCondition(where, paidRequestIds.size ? { [Op.in]: [...paidRequestIds] } : '__NO_MATCH__');
    } else if (paidRequestIds.size) {
      appendRequestIdCondition(where, { [Op.notIn]: [...paidRequestIds] });
    }
  } else if (status) {
    where.status = status;
  }
  if (scope === 'my') {
    const staffId = user.staffId || user.id;
    const identities = [user.name, user.phone, staffId && String(staffId)].filter(Boolean);
    if (staffId) {
      where[Op.and] = [{
        [Op.or]: [
          { applicant_staff_id: staffId },
          ...(identities.length ? [{ applicant_staff_id: null, apply_user: { [Op.in]: identities } }] : [])
        ]
      }];
    } else if (identities.length) {
      where.apply_user = { [Op.in]: identities };
    }
  }
  if (operatorStaffId) {
    const operator = await Staff.findOne({
      where: { staff_id: operatorStaffId, is_deleted: 0 },
      attributes: ['staff_id', 'name'],
      raw: true
    });
    appendPurchaseWhereCondition(
      where,
      buildPurchaseOperatorCondition(operatorStaffId, operator?.name || '')
    );
  }
  if (submitter && String(submitter).trim()) {
    const submitterText = String(submitter).trim();
    const submitterStaffRows = await Staff.findAll({
      where: {
        [Op.or]: [
          { name: { [Op.like]: `%${submitterText}%` } },
          { phone: { [Op.like]: `%${submitterText}%` } }
        ],
        is_deleted: 0
      },
      attributes: ['staff_id'],
      raw: true
    });
    appendPurchaseWhereCondition(
      where,
      buildPurchaseSubmitterCondition(
        submitterText,
        submitterStaffRows.map(row => row.staff_id).filter(Boolean)
      )
    );
  }
  if (requestNo && String(requestNo).trim()) where.request_no = { [Op.like]: `%${String(requestNo).trim()}%` };
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
    appendRequestIdCondition(where, requestIds.length ? { [Op.in]: requestIds } : '__NO_MATCH__');
  }

  const requestQuery = {
    where,
    include: [
      { model: Store },
      {
        model: Staff,
        as: 'Applicant',
        attributes: ['staff_id', 'name', 'role_code', 'store_id', 'distributor_id'],
        required: false,
        include: [
          { model: Store, as: 'Store', attributes: ['store_id', 'name'], required: false },
          { model: Distributor, attributes: ['distributor_id', 'name'], required: false }
        ]
      },
      { model: Supplier },
      { model: PurchaseRequestItem, as: 'items' },
      {
        model: Inbound,
        attributes: ['inbound_id', 'inbound_no', 'store_id', 'source_no', 'status'],
        separate: true,
        include: [{ model: Store, attributes: ['store_id', 'name'], required: false }]
      }
    ],
    order: buildPendingFirstOrder(sequelize, {
      statusColumn: 'PurchaseRequest.status',
      pendingStatuses: ['draft', 'pending'],
      dateColumns: ['PurchaseRequest.create_time'],
      idColumn: 'PurchaseRequest.request_id'
    })
  };
  const result = exportMode
    ? { count: 0, rows: await PurchaseRequest.findAll(requestQuery) }
    : await PurchaseRequest.findAndCountAll({ ...requestQuery, ...paginate({}, { page, pageSize }) });
  const { count, rows } = result;

  const requestIds = rows.map(row => row.request_id).filter(Boolean);
  const adjustmentRows = requestIds.length
    ? await PurchaseAdjustment.findAll({
      where: { request_id: { [Op.in]: requestIds }, status: 'completed' },
      attributes: [
        'adjustment_id', 'adjustment_no', 'request_id', 'request_no',
        'total_quantity_delta', 'total_amount_delta', 'reason', 'status',
        'create_user', 'create_time'
      ],
      include: [{
        model: PurchaseAdjustmentItem,
        as: 'items',
        attributes: [
          'request_item_id', 'inbound_id', 'inbound_item_id', 'product_id',
          'product_name', 'quantity_delta', 'unit_price', 'amount_delta', 'remark'
        ]
      }]
    })
    : [];
  const adjustmentsByRequest = new Map();
  adjustmentRows.forEach(adjustment => {
    const key = String(adjustment.request_id);
    if (!adjustmentsByRequest.has(key)) adjustmentsByRequest.set(key, []);
    adjustmentsByRequest.get(key).push(adjustment);
  });

  const formattedRows = rows.map(row => {
    const result = row.toJSON();
    const requestAdjustments = adjustmentsByRequest.get(String(result.request_id)) || [];
    attachCurrentPurchaseAmounts(result, requestAdjustments);
    result.negative_purchase_orders = buildNegativePurchaseOrders(requestAdjustments);
    attachPurchasePaymentStatus(result, paidRequestIds);
    result.store_name = result.Store?.name || '';
    result.applicant_store_id = result.Applicant?.store_id || '';
    result.applicant_store_name = result.Applicant?.Store?.name || '';
    result.applicant_distributor_id = result.Applicant?.distributor_id || '';
    result.applicant_distributor_name = result.Applicant?.Distributor?.name || '';
    result.applicant_role_code = result.Applicant?.role_code || '';
    result.supplier_name = result.Supplier?.name || '';
    result.submitter_name = result.submitter_name || result.submit_user || result.apply_user || result.create_user || result.operator_name || '';
    
    // 汇总商品名称和数量用于前端展示
    if (result.items && result.items.length > 0) {
      result.items = attachCurrentPurchaseItemAmounts(result.items, adjustmentsByRequest.get(String(result.request_id)) || []);
      result.items_summary = result.items.map(item => 
        `${item.product_name || item.product_id} x ${item.current_quantity ?? item.quantity}`
      ).join('; ');
    } else {
      result.items_summary = '';
    }
    const inboundRows = result.Inbounds || [];
    result.inbound_status = inboundRows.some(item => item.status === 'completed')
      ? 'completed'
      : (inboundRows[0]?.status || '');
    result.lifecycle_status = getPurchaseLifecycleStatus(result.status, inboundRows);
    if (['pending_inbound', 'revoked', 'partial_return', 'returned'].includes(result.lifecycle_status)) {
      result.display_status = result.lifecycle_status;
    }
    result.pending_inbounds = inboundRows
      .filter(item => item.status === 'pending')
      .map(item => ({
        inbound_id: item.inbound_id,
        inbound_no: item.inbound_no || '',
        store_id: item.store_id || '',
        store_name: item.Store?.name || ''
      }));
    result.has_completed_inbound = inboundRows.some(item => item.status === 'completed');
    result.can_revoke = ['pending', 'approved', 'purchased'].includes(result.status) && !result.has_completed_inbound;
    
    return result;
  });

  return { rows: formattedRows, count };
}

async function getRequestList(ctx) {
  const { page = 1, pageSize = 20 } = ctx.query;
  const { rows, count } = await queryRequestList(ctx);
  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

async function exportRequestList(ctx) {
  const { rows } = await queryRequestList(ctx, { exportMode: true });
  const data = rows.map(row => ({
    申请单号: row.request_no || '',
    申请时间: row.create_time || '',
    申请门店: row.store_name || '',
    供应商: row.supplier_name || '',
    付款方式: row.payment_method || '',
    发票类型: row.invoice_type || '',
    货型: row.product_type || '',
    商品摘要: row.items_summary || '',
    采购原价: Number(row.total_amount || 0),
    抵扣金额: Number(row.rebate_deduction || 0),
    申请金额: Number(row.current_actual_total ?? row.actual_total ?? row.total_amount ?? 0),
    状态: row.display_status || row.status || '',
    备注: row.remark || row.reason || ''
  }));
  sendExcel(ctx, data, [
    '申请单号', '申请时间', '申请门店', '供应商', '付款方式', '发票类型',
    '货型', '商品摘要', '采购原价', '抵扣金额', '申请金额', '状态', '备注'
  ], `采购申请_${new Date().toISOString().slice(0, 10)}.xlsx`, '采购申请');
}

/**
 * 获取采购申请详情
 */
async function getRequestDetail(ctx) {
  const { requestId } = ctx.params;

  const request = await PurchaseRequest.findOne({
    where: { request_id: requestId, status: { [Op.ne]: 'deleted' } },
    include: [
      { model: Store },
      {
        model: Staff,
        as: 'Applicant',
        attributes: ['staff_id', 'name', 'role_code', 'store_id', 'distributor_id'],
        required: false,
        include: [
          { model: Store, as: 'Store', attributes: ['store_id', 'name'], required: false },
          { model: Distributor, attributes: ['distributor_id', 'name'], required: false }
        ]
      },
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
  if (String(ctx.query.trace || '') === '1') {
    const requestData = request.toJSON();
    if (!canViewSnTraceReference(ctx.state.user, {
      store_id: request.store_id,
      distributor_id: requestData.Store?.distributor_id,
      creator_names: [request.apply_user]
    })) {
      ctx.throw(403, '无权查看该采购原始订单');
    }
  }

  const result = request.toJSON();
  attachCurrentPurchaseAmounts(result, result.adjustments || []);
  result.negative_purchase_orders = buildNegativePurchaseOrders(result.adjustments || []);
  attachPurchasePaymentStatus(result, await getPaidPurchaseRequestIds());
  result.store_name = result.Store?.name || '';
  result.applicant_store_id = result.Applicant?.store_id || '';
  result.applicant_store_name = result.Applicant?.Store?.name || '';
  result.applicant_distributor_id = result.Applicant?.distributor_id || '';
  result.applicant_distributor_name = result.Applicant?.Distributor?.name || '';
  result.applicant_role_code = result.Applicant?.role_code || '';
  result.supplier_name = result.Supplier?.name || '';

  // 解析门店分配，并关联门店名称
  if (result.items && result.items.length > 0) {
    const productSnapshots = await loadPurchaseProductSnapshots(result.items);
    // 获取所有门店
    const stores = await Store.findAll();
    const storeMap = new Map();
    stores.forEach(s => storeMap.set(s.store_id, s.name));

    result.items = attachCurrentPurchaseItemAmounts(result.items, result.adjustments || []).map(item => {
      const itemJson = item;
      const productSnapshot = productSnapshots.get(String(itemJson.product_id || ''));
      if (!itemJson.product_code && productSnapshot) itemJson.product_code = productSnapshot.product_code || '';
      if (!itemJson.manufacturer_code && productSnapshot) itemJson.manufacturer_code = productSnapshot.manufacturer_code || '';
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

  result.action_logs = await listBusinessActions('purchase_request', request.request_id);

  ctx.body = { code: 0, data: result };
}

/**
 * 创建采购申请
 */
async function createRequest(ctx) {
  const user = ctx.state.user;
  const {
    supplierId,
    remark,
    items,
    storeId,
    invoiceType,
    paymentMethod,
    goodsTypeId,
    productType,
    rebateDeduction,
    supplierChatScreenshotIds,
    supplierChatScreenshotUrls,
    supplierChatScreenshotUrl,
    supplier_chat_screenshot_ids,
    supplier_chat_screenshot_urls,
    supplier_chat_screenshot_url,
    freightPlatformId,
    freightPlatformName,
    freightAmount,
    freight_platform_id,
    freight_platform_name,
    freight_amount,
    saveDraft = false
  } = ctx.request.body;
  const isDraft = Boolean(saveDraft);

  const screenshotIds = normalizeFileList(supplierChatScreenshotIds, supplier_chat_screenshot_ids);
  const screenshotUrls = normalizeFileList(
    supplierChatScreenshotUrls,
    supplierChatScreenshotUrl,
    supplier_chat_screenshot_urls,
    supplier_chat_screenshot_url
  );
  const screenshotDisplayValues = screenshotUrls.length ? screenshotUrls : screenshotIds;

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
    const isUsedProduct = Boolean(item.isUsedProduct || item.is_used_product);
    assertUsedProductDirectInbound(ctx, item);
    if (isUsedProduct && (!String(item.productName || item.product_name || '').trim() || Number(item.quantity || 0) <= 0 || Number(item.price || 0) < 0)) {
      ctx.throw(400, '二手商品名称、价格和数量不能为空');
    }
    if (!isUsedProduct && !item.productId && !item.product_id) ctx.throw(400, '请选择采购商品');
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
  const normalizedFreightPlatformId = freightPlatformId || freight_platform_id || '';
  const normalizedFreightPlatformName = freightPlatformName || freight_platform_name || '';
  const normalizedFreightAmount = toMoney(freightAmount === undefined ? freight_amount : freightAmount);

  // 经销商级账号不再有当前门店；门店必须由表单明确选择，或由门店分配明细提供。
  const targetStoreId = storeId || (isStoreScopedAccount(getUserRoles(user)) ? user.storeId : '');
  
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
  
  if (!finalStoreId) ctx.throw(400, '请选择门店或完善门店分配');
  assertPurchaseAllocationStoresVisible(ctx, items, finalStoreId);

  const purchaseStore = await Store.findOne({
    where: { store_id: finalStoreId, is_deleted: 0, status: 1 },
    attributes: ['store_id', 'distributor_id', 'region_id']
  });
  if (!purchaseStore?.distributor_id) ctx.throw(400, '采购门店未绑定经销商');

  try {
    await validatePurchaseAllocations(items, finalStoreId);
  } catch (error) {
    ctx.throw(400, error.message);
  }

  const now = new Date();
  const submitterName = user.name || user.phone || String(user.staffId || '');
  const currentStaffId = user.staffId || user.id || null;
  let createdRequest;

  await sequelize.transaction(async transaction => {
    if (!isDraft) await assertNewPurchasePnsAvailable(items, transaction);
    await assertActivePurchaseProducts(items, transaction);
    const productSnapshots = await loadPurchaseProductSnapshots(items, transaction);
    // 表头、明细、返利、运费和审计记录必须原子提交，避免明细写入失败后留下可审批的空采购单。
    if (deduction > 0 && !isDraft) {
      const currentBalance = await _getRebateBalance(supplierId, transaction);
      if (deduction > currentBalance) {
        ctx.throw(400, `返利余额不足，当前余额 ¥${currentBalance.toFixed(2)}`);
      }
      await recordRebateDeduction(
        supplierId,
        '',
        deduction,
        requestNo,
        `采购申请 ${requestNo} 返利抵扣`,
        user.name || user.phone,
        transaction
      );
    }

    createdRequest = await PurchaseRequest.create({
      request_id: requestId,
      request_no: requestNo,
      store_id: finalStoreId,
      distributor_id: purchaseStore.distributor_id,
      supplier_id: supplierId || null,
      goods_type_id: canonicalGoodsTypeId,
      product_type: canonicalProductType,
      invoice_type: invoiceType || '',
      payment_method: normalizedPaymentMethod,
      supplier_chat_screenshot_ids: screenshotIds.length ? JSON.stringify(screenshotIds) : null,
      supplier_chat_screenshot_urls: screenshotDisplayValues.length ? JSON.stringify(screenshotDisplayValues) : null,
      reason: remark || '',
      total_amount: totalAmount,
      rebate_deduction: deduction,
      actual_total: actualTotal,
      freight_platform_id: normalizedFreightPlatformId || null,
      freight_platform_name: normalizedFreightPlatformName || null,
      freight_amount: normalizedFreightAmount,
      status: isDraft ? 'draft' : 'pending',
      apply_user: submitterName,
      applicant_staff_id: currentStaffId,
      operator_staff_id: currentStaffId,
      operator_name: submitterName,
      create_staff_id: currentStaffId,
      create_user: submitterName,
      submit_user: isDraft ? null : submitterName,
      submit_time: isDraft ? null : now,
      create_time: now,
      update_time: now
    }, { transaction });

    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      const item = items[itemIndex];
      const productId = item.productId || '';
      const productSnapshot = productSnapshots.get(String(productId));
      const isUsedProduct = Boolean(item.isUsedProduct || item.is_used_product);
      const quantity = item.quantity || 0;
      const unitPrice = item.price || 0;
      const subtotal = unitPrice * quantity;

      await PurchaseRequestItem.create({
        request_id: requestId,
        product_id: productId || null,
        product_name: item.productName || '',
        product_code: isUsedProduct ? (item.productCode || '') : (productSnapshot?.product_code || item.productCode || ''),
        manufacturer_code: isUsedProduct ? (item.manufacturerCode || '') : (productSnapshot?.manufacturer_code || item.manufacturerCode || ''),
        pn_code: item.pnCode || '',
        is_used_product: Boolean(item.isUsedProduct || item.is_used_product) ? 1 : 0,
        direct_inbound: Boolean(item.directInbound || item.direct_inbound) ? 1 : 0,
        direct_inbound_sn_code: String(item.directInboundSnCode || item.direct_inbound_sn_code || '').trim() || null,
        quantity: quantity,
        unit_price: unitPrice,
        subtotal: subtotal,
        rebate_deduction: itemRebateAllocations[itemIndex] || 0,
        goods_type_id: canonicalGoodsTypeId,
        product_type: canonicalProductType,
        store_allocations: item.storeAllocations ? JSON.stringify(item.storeAllocations) : null,
        selected_resource_types: JSON.stringify(normalizeSelectedResourceTypes(item.selectedResourceTypes || item.selected_resource_types))
      }, { transaction });
    }

    await syncFreightRecord({
      sourceType: 'purchase',
      sourceId: requestId,
      sourceNo: requestNo,
      platformId: normalizedFreightPlatformId,
      platformName: normalizedFreightPlatformName,
      amount: normalizedFreightAmount,
      storeId: finalStoreId,
      items,
      status: isDraft ? 'draft' : 'pending',
      user,
      transaction
    });

    await recordBusinessAction({
      businessType: 'purchase_request',
      businessId: requestId,
      businessNo: requestNo,
      action: isDraft ? 'draft_created' : 'submitted',
      toStatus: isDraft ? 'draft' : 'pending',
      user,
      transaction
    });

    if (normalizedPaymentMethod === 'PERSONAL_ADVANCE' && !isDraft) {
      createdRequest.Supplier = await Supplier.findByPk(supplierId, { transaction });
      await createPurchaseReimbursement(createdRequest, user, transaction);
    }
  });

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
  assertPurchaseAllocationStoresVisible(ctx, request.items, request.store_id);
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
    if ((!item.product_id && !Number(item.is_used_product)) || (Number(item.is_used_product) && !String(item.product_name || '').trim()) || Number(item.quantity) <= 0) ctx.throw(400, '商品名称、价格和数量不能为空');
    assertUsedProductDirectInbound(ctx, item);
    if (!item.product_id && !Number(item.is_used_product)) ctx.throw(400, '商品名称、价格和数量不能为空');
    if (Number(item.quantity) <= 0) ctx.throw(400, '商品名称、价格和数量不能为空');
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

  const usedDraftItems = (request.items || []).filter(item => Number(item.is_used_product) === 1 && !item.product_id);
  usedDraftItems.forEach(item => { item.product_id = '__USED_PRODUCT__'; });
  const goodsType = await validateDraftSubmission(request, ctx);
  usedDraftItems.forEach(item => { item.product_id = null; });
  await assertNewPurchasePnsAvailable(request.items);
  await assertActivePurchaseProducts(request.items);
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
  request.operator_staff_id = request.operator_staff_id || user.staffId || user.id || null;
  request.operator_name = request.operator_name || user.name || user.phone || String(user.staffId || user.id || '');
  request.submit_user = user.name || user.phone || String(user.staffId || '');
  request.submit_time = new Date();
  request.update_time = new Date();
  await request.save();
  await syncFreightRecord({
    sourceType: 'purchase',
    sourceId: request.request_id,
    sourceNo: request.request_no,
    platformId: request.freight_platform_id,
    platformName: request.freight_platform_name,
    amount: request.freight_amount,
    storeId: request.store_id,
    items: request.items,
    status: 'pending',
    user
  });
  await recordBusinessAction({
    businessType: 'purchase_request',
    businessId: request.request_id,
    businessNo: request.request_no,
    action: 'submitted',
    fromStatus: 'draft',
    toStatus: 'pending',
    user
  });

  if (request.payment_method === 'PERSONAL_ADVANCE') {
    request.Supplier = await Supplier.findByPk(request.supplier_id);
    await createPurchaseReimbursement(request, user);
  }

  ctx.body = { code: 0, message: '采购申请提交成功', requestId, requestNo: request.request_no, status: 'pending' };
}

async function deleteRequestDraft(ctx) {
  const { requestId } = ctx.params;
  const user = ctx.state.user;
  const request = await PurchaseRequest.findByPk(requestId);
  if (!request) ctx.throw(404, '采购申请不存在');
  assertStoreVisible(ctx, request.store_id);
  if (request.status !== 'draft' || request.submit_time) ctx.throw(400, '只有从未提交过的采购申请草稿可以删除');
  if (!canSubmitDraft(user, request)) ctx.throw(403, '只有草稿创建人、店长或管理员可以删除');

  await request.update({ status: 'deleted', update_time: new Date() });
  await recordBusinessAction({
    businessType: 'purchase_request',
    businessId: request.request_id,
    businessNo: request.request_no,
    action: 'deleted',
    fromStatus: 'draft',
    toStatus: 'deleted',
    user
  });
  ctx.body = { code: 0, message: '采购申请草稿已删除', requestId };
}

async function updateRequestDraft(ctx) {
  const { requestId } = ctx.params;
  const user = ctx.state.user;
  const { supplierId, remark, items, invoiceType, paymentMethod, goodsTypeId, productType, rebateDeduction,
    freightPlatformId, freightPlatformName, freightAmount, freight_platform_id, freight_platform_name, freight_amount } = ctx.request.body;
  const request = await PurchaseRequest.findByPk(requestId);
  const usedProductPlaceholder = '__USED_PRODUCT__';
  if (Array.isArray(items)) {
    items.forEach(item => {
      if ((item.isUsedProduct || item.is_used_product) && !item.productId) item.productId = usedProductPlaceholder;
    });
  }
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
  assertPurchaseAllocationStoresVisible(ctx, items, request.store_id);
  try {
    await validatePurchaseAllocations(items, request.store_id);
  } catch (error) {
    ctx.throw(400, error.message);
  }

  for (const item of items) {
    const isUsedProduct = Number(item.isUsedProduct || item.is_used_product) === 1;
    assertUsedProductDirectInbound(ctx, item);
    if ((!item.productId && !isUsedProduct) || (isUsedProduct && !String(item.productName || item.product_name || '').trim()) || Number(item.quantity) <= 0) ctx.throw(400, '商品名称、价格和数量不能为空');
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
  const normalizedFreightPlatformId = freightPlatformId || freight_platform_id || '';
  const normalizedFreightPlatformName = freightPlatformName || freight_platform_name || '';
  const normalizedFreightAmount = toMoney(freightAmount === undefined ? freight_amount : freightAmount);

  await sequelize.transaction(async transaction => {
    await assertActivePurchaseProducts(items, transaction);
    const productSnapshots = await loadPurchaseProductSnapshots(items, transaction);
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
      freight_platform_id: normalizedFreightPlatformId || null,
      freight_platform_name: normalizedFreightPlatformName || null,
      freight_amount: normalizedFreightAmount,
      update_time: new Date()
    }, { transaction });
    await PurchaseRequestItem.destroy({ where: { request_id: requestId }, transaction });
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const productId = item.productId || item.product_id || '';
      const isUsedProduct = Number(item.isUsedProduct || item.is_used_product) ? 1 : 0;
      const productSnapshot = productSnapshots.get(String(productId));
      await PurchaseRequestItem.create({
        request_id: requestId,
        product_id: isUsedProduct ? null : (productId || null),
        product_name: item.productName || '',
        product_code: isUsedProduct ? (item.productCode || item.product_code || '') : (productSnapshot?.product_code || item.productCode || item.product_code || ''),
        manufacturer_code: isUsedProduct ? (item.manufacturerCode || item.manufacturer_code || '') : (productSnapshot?.manufacturer_code || item.manufacturerCode || item.manufacturer_code || ''),
        pn_code: item.pnCode || '',
        is_used_product: isUsedProduct,
        direct_inbound: Number(item.directInbound || item.direct_inbound) ? 1 : 0,
        direct_inbound_sn_code: String(item.directInboundSnCode || item.direct_inbound_sn_code || '').trim() || null,
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
    await syncFreightRecord({
      sourceType: 'purchase',
      sourceId: requestId,
      sourceNo: request.request_no,
      platformId: normalizedFreightPlatformId,
      platformName: normalizedFreightPlatformName,
      amount: normalizedFreightAmount,
      storeId: request.store_id,
      items,
      status: 'draft',
      user,
      transaction
    });
  });

  await recordBusinessAction({
    businessType: 'purchase_request',
    businessId: request.request_id,
    businessNo: request.request_no,
    action: 'draft_saved',
    fromStatus: 'draft',
    toStatus: 'draft',
    user
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
  const store = request.store_id
    ? await Store.findByPk(request.store_id, { attributes: ['region_id', 'distributor_id'], transaction })
    : null;
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
    region_id: store?.region_id || null,
    distributor_id: request.distributor_id || store?.distributor_id || null,
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
  if (status === 'approved' && (!request.items || request.items.length === 0)) {
    ctx.throw(400, '采购申请缺少商品明细，无法审批通过，请重新创建采购申请');
  }

  const transaction = await sequelize.transaction();
  let transactionCommitted = false;
  const directInboundExecutions = [];
  const items = request.items.map(item => ({
    productId: item.product_id,
    productName: item.product_name,
    pnCode: item.pn_code,
    quantity: item.quantity,
    isUsedProduct: item.is_used_product,
    directInbound: item.direct_inbound,
    directInboundSnCode: item.direct_inbound_sn_code
  }));
  for (const item of items) {
    const isUsedProduct = Number(item.isUsedProduct || item.is_used_product) === 1;
    assertUsedProductDirectInbound(ctx, item);
    if ((!item.productId && !isUsedProduct) || (isUsedProduct && !String(item.productName || item.product_name || '').trim()) || Number(item.quantity) <= 0) ctx.throw(400, '商品名称、价格和数量不能为空');
  }
  try {
  const previousStatus = request.status;
  const approveTime = new Date();
  await request.update({
    status,
    approve_user: user.name,
    approve_time: approveTime,
    approve_comment: comment,
    update_time: approveTime
  }, { transaction });
  await setFreightRecordStatus('purchase', requestId, status === 'approved' ? 'active' : 'cancelled', user, transaction);
  await recordBusinessAction({
    businessType: 'purchase_request',
    businessId: request.request_id,
    businessNo: request.request_no,
    action: status === 'approved' ? 'approved' : 'rejected',
    fromStatus: previousStatus,
    toStatus: status,
    user,
    comment: comment || '',
    transaction
  });

  // 如果审批通过，自动生成入库单
  if (status === 'approved' && request.items && request.items.length > 0) {
    for (const item of request.items) {
      if (!Number(item.is_used_product) || item.product_id) continue;
      const directInbound = Number(item.direct_inbound) === 1;
      const snCode = String(item.direct_inbound_sn_code || '').trim();
      if (directInbound && (!snCode || Number(item.quantity || 0) !== 1)) {
        ctx.throw(400, '二手商品勾选审批完成及入库时，数量必须为1且必须填写SN号');
      }
      const created = await createProductRecord({
        name: item.product_name,
        manualName: item.product_name,
        pnCode: item.pn_code || '',
        barcodes: item.pn_code ? [{ type: 'manufacturer', code: item.pn_code }] : [],
        needSn: directInbound ? 1 : 0,
        unit: '台',
        remark: '采购申请审批生成的二手商品',
        isUsedProduct: true
      }, transaction);
      await item.update({ product_id: created.productId, product_name: created.productName, pn_code: item.pn_code || null }, { transaction });
    }
    await assertActiveProducts(Product, request.items.map(item => item.product_id).filter(Boolean), { transaction });
    await ensurePayableForApprovedRequest(request, user, transaction);
    await validatePurchaseAllocations(request.items, request.store_id, transaction);
    for (const item of request.items) {
      if (typeof item.changed === 'function' && item.changed('store_allocations')) {
        await item.save({ transaction, fields: ['store_allocations'] });
      }
    }

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
        create_user: request.apply_user || request.submit_user || request.create_user || user.name,
        create_time: new Date(),
        update_time: new Date()
      }, { transaction });

      // 创建入库明细
      for (const item of items) {
        const createdInboundItem = await InboundItem.create({
          inbound_id: inboundId,
          product_id: item.product_id,
          product_name: item.product_name,
          pn_code: item.pn_code,
          sn_code: Number(item.direct_inbound) === 1 ? item.direct_inbound_sn_code : null,
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
        if (Number(item.direct_inbound) === 1) item._inboundItemId = createdInboundItem.item_id;
      }
      const directItems = items.filter(item => Number(item.direct_inbound) === 1 && item.direct_inbound_sn_code);
      if (directItems.length) {
        directInboundExecutions.push({
          inboundId,
          items: directItems.map(item => ({
            productId: item.product_id,
            inboundItemId: item._inboundItemId,
            quantity: item.allocatedQuantity || item.quantity,
            locationId: item.locationId || null,
            pnCode: item.pn_code || '',
            snCode: item.direct_inbound_sn_code
          }))
        });
      }
    }
  }

  await transaction.commit();
  transactionCommitted = true;
  for (const execution of directInboundExecutions) {
    await executeInbound({
      request: { body: execution },
      state: { user },
      throw(statusCode, message) {
        const error = new Error(message);
        error.status = statusCode;
        throw error;
      }
    });
  }
  ctx.body = { code: 0, message: '审批完成' };
  } catch (error) {
    if (!transactionCommitted) await transaction.rollback();
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
  const inboundIds = inbounds.map(inbound => inbound.inbound_id).filter(Boolean);
  const historicalReturns = inboundIds.length
    ? await ReturnStockItem.findAll({ include: [{ model: ReturnStock, where: { status: 'completed', inbound_id: { [Op.in]: inboundIds } }, attributes: [] }] })
    : [];
  const returnedByInboundItem = new Map();
  historicalReturns.forEach(item => {
    if (!item.inbound_item_id) return;
    const key = String(item.inbound_item_id);
    returnedByInboundItem.set(key, (returnedByInboundItem.get(key) || 0) + Number(item.quantity || 0));
  });
  const productMap = new Map((await Product.findAll({
    where: { product_id: { [Op.in]: [...new Set(rows.map(row => row.product_id).filter(Boolean))] } }
  })).map(product => [String(product.product_id), product]));
  for (const row of rows) {
    const alreadyReturned = returnedByInboundItem.get(String(row.inbound_item_id)) || 0;
    row.already_returned_quantity = alreadyReturned;
    row.max_return_quantity = Math.max(0, Number(row.max_return_quantity || 0) - alreadyReturned);
    const product = productMap.get(String(row.product_id));
    row.need_sn = Number(product?.need_sn || 0);
    if (row.operation_type === 'stock_return' && row.need_sn === 1) {
      const inboundItem = await InboundItem.findByPk(row.inbound_item_id);
      const codes = [];
      try {
        const parsed = JSON.parse(inboundItem?.received_sn_codes || '[]');
        if (Array.isArray(parsed)) codes.push(...parsed.map(String));
      } catch (_) { /* ignore malformed historical JSON */ }
      if (inboundItem?.sn_code) codes.push(String(inboundItem.sn_code));
      const uniqueCodes = [...new Set(codes.filter(Boolean))];
      const sns = uniqueCodes.length
        ? await ProductSn.findAll({ where: { product_id: row.product_id, store_id: row.store_id, sn_code: { [Op.in]: uniqueCodes }, status: 'in_stock', is_deleted: 0 } })
        : [];
      row.sn_options = sns.map(sn => ({ sn_id: sn.sn_id, sn_code: sn.sn_code, location_id: sn.location_id || '', inventory_type: sn.inventory_type || 'normal_qty' }));
      row.max_return_quantity = Math.min(row.max_return_quantity, row.sn_options.length);
    }
  }
  if (!rows.some(row => row.editable && row.max_return_quantity > 0)) {
    ctx.throw(400, '该采购订单没有可退单或可退库商品');
  }

  ctx.body = {
    code: 0,
    data: {
      request_id: request.request_id,
      request_no: request.request_no,
      store_id: request.store_id,
      distributor_id: request.distributor_id || request.Store?.distributor_id || null,
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
    const historicalReturnItems = await ReturnStockItem.findAll({
      include: [{ model: ReturnStock, where: { status: 'completed', inbound_id: { [Op.in]: inbounds.map(item => item.inbound_id) } }, attributes: [] }],
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    const returnedByInboundItem = new Map();
    historicalReturnItems.forEach(item => {
      if (!item.inbound_item_id) return;
      const key = String(item.inbound_item_id);
      returnedByInboundItem.set(key, (returnedByInboundItem.get(key) || 0) + Number(item.quantity || 0));
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
      const returnQuantity = Number(row.returnQuantity ?? row.return_quantity ?? 0);
      if (!Number.isInteger(returnQuantity) || returnQuantity < 0) {
        ctx.throw(400, '退库数量必须是大于等于0的整数');
      }
      const snIds = [...new Set((row.snIds || row.sn_ids || []).map(String).filter(Boolean))];
      submitted.set(inboundItemId, { returnQuantity, snIds });
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

    const createdReturns = [];
    const currentReturnByInboundItem = new Map();
    for (const [inboundItemId, input] of submitted.entries()) {
      const matched = inboundItemMap.get(inboundItemId);
      if (!matched) ctx.throw(400, '待入库明细不存在或不属于该采购订单');
      const { inbound, inboundItem } = matched;

      const requestItem = requestItemMap.get(String(inboundItem.purchase_request_item_id || ''));
      if (!requestItem) ctx.throw(400, '采购明细不存在');
      const returnQuantity = input.returnQuantity;
      if (returnQuantity === 0) continue;

      const originalQuantity = Math.max(0, Number(requestItem.quantity || 0));
      const unitPrice = Number(requestItem.unit_price || inboundItem.unit_price || 0);
      const rebatePerUnit = originalQuantity > 0
        ? Number(requestItem.rebate_deduction || 0) / originalQuantity
        : 0;
      const amountDelta = toSignedMoney(-returnQuantity * (unitPrice - rebatePerUnit));
      const rebateDelta = toSignedMoney(-returnQuantity * rebatePerUnit);
      const receivedQuantity = receivedByRequestItem.get(String(requestItem.item_id)) || 0;
      let operationType = 'pending_cancel';
      let returnId = '';
      let returnNo = '';
      if (inbound.status === 'pending') {
        const pendingQuantity = Math.max(Number(inboundItem.quantity || 0) - Number(inboundItem.received_quantity || 0), 0);
        if (returnQuantity > pendingQuantity) ctx.throw(400, `商品 ${inboundItem.product_name || inboundItem.product_id} 可取消待入库数量不足`);
      await inboundItem.update({ quantity: Math.max(Number(inboundItem.quantity || 0) - returnQuantity, 0) }, { transaction });
      } else if (inbound.status === 'completed') {
        operationType = 'stock_return';
        const product = await Product.findByPk(requestItem.product_id, { transaction });
        const inventoryType = inboundItem.inventory_type || 'normal_qty';
        const locationId = inboundItem.location_id || '';
        const alreadyReturned = returnedByInboundItem.get(String(inboundItem.item_id)) || 0;
        const maxReturnQuantity = Math.max(0, Number(inboundItem.quantity || 0) - alreadyReturned);
        if (returnQuantity > maxReturnQuantity) ctx.throw(400, `商品 ${inboundItem.product_name || inboundItem.product_id} 可退库数量不足，最多可退 ${maxReturnQuantity}`);
        let returnItems = [];
        if (Number(product?.need_sn) === 1) {
          if (input.snIds.length !== returnQuantity) ctx.throw(400, `商品 ${inboundItem.product_name || inboundItem.product_id} 退库必须选择 ${returnQuantity} 个SN`);
          const sns = await ProductSn.findAll({ where: { sn_id: { [Op.in]: input.snIds }, product_id: requestItem.product_id, store_id: inbound.store_id, status: 'in_stock', is_deleted: 0 }, transaction, lock: transaction.LOCK.UPDATE });
          if (sns.length !== returnQuantity) ctx.throw(400, '选择的SN不存在、已退库或不属于当前门店');
          const sourceSnCodes = new Set([
            ...parseInboundSnCodes(inboundItem.received_sn_codes),
            ...(inboundItem.sn_code ? [String(inboundItem.sn_code).trim()] : [])
          ]);
          if (sns.some(sn => !sourceSnCodes.has(String(sn.sn_code || '').trim()))) {
            ctx.throw(400, '选择的SN不属于当前采购入库明细');
          }
          returnItems = sns.map(sn => ({ sn, quantity: 1, locationId: sn.location_id || locationId, inventoryType: sn.inventory_type || inventoryType }));
        } else {
          if (input.snIds.length) ctx.throw(400, '非SN商品不能选择SN');
          const available = await getAvailableQty(requestItem.product_id, inbound.store_id, inventoryType, locationId, transaction);
          if (available < returnQuantity) ctx.throw(400, `商品 ${inboundItem.product_name || inboundItem.product_id} 当前可退库存不足，最多可退 ${available}`);
          returnItems = [{ sn: null, quantity: returnQuantity, locationId, inventoryType }];
        }
        returnId = generateUUID();
        returnNo = generateId('RET');
        await ReturnStock.create({ return_id: returnId, return_no: returnNo, inbound_id: inbound.inbound_id, inbound_no: inbound.inbound_no, store_id: inbound.store_id, purchase_request_id: request.request_id, distributor_id: request.distributor_id || inbound.Store?.distributor_id || null, supplier_id: request.supplier_id, supplier_name: request.Supplier?.name || '', total_quantity: returnQuantity, total_amount: toSignedMoney(returnQuantity * unitPrice), reason: reason || '', status: 'completed', execute_user: user.name || user.phone, execute_time: new Date(), create_user: request.apply_user || request.submit_user || request.create_user || user.name || user.phone, create_time: new Date() }, { transaction });
        for (const returnItem of returnItems) {
          const sn = returnItem.sn;
          await ReturnStockItem.create({ return_id: returnId, inbound_item_id: inboundItem.item_id, product_id: requestItem.product_id, product_name: requestItem.product_name || inboundItem.product_name || '', pn_code: sn?.pn_code || inboundItem.pn_code || '', sn_code: sn?.sn_code || '', sn_id: sn?.sn_id || null, quantity: returnItem.quantity, unit_price: unitPrice, location_id: returnItem.locationId, inventory_type: returnItem.inventoryType, product_type: inboundItem.product_type || '', remark: reason || '' }, { transaction });
          if (sn) {
            await sn.update({ status: 'returned', remark: `${sn.remark || ''} [采购退库:${returnNo}]` }, { transaction });
            await SnLog.create({ log_id: generateUUID(), sn_id: sn.sn_id, sn_code: sn.sn_code, product_id: sn.product_id, product_name: requestItem.product_name || inboundItem.product_name || '', store_id: inbound.store_id, action: 'return', remark: `采购退库：${returnNo}`, create_user: request.apply_user || request.submit_user || request.create_user || user.name || user.phone, create_time: new Date() }, { transaction });
          }
          await updateInventory(requestItem.product_id, inbound.store_id, returnItem.inventoryType, -returnItem.quantity, transaction, returnItem.locationId);
          if (returnItem.inventoryType === 'normal_qty' && inboundItem.product_type) {
            const typeField = { '正规货': 'regular_qty', '国补货': 'subsidy_qty', '纯二批': 'second_qty', regular: 'regular_qty', subsidy: 'subsidy_qty', second: 'second_qty' }[String(inboundItem.product_type).toLowerCase()];
            if (typeField) await updateInventory(requestItem.product_id, inbound.store_id, typeField, -returnItem.quantity, transaction, returnItem.locationId);
          }
        }
      createdReturns.push({ returnId, returnNo });
        currentReturnByInboundItem.set(String(inboundItem.item_id), (currentReturnByInboundItem.get(String(inboundItem.item_id)) || 0) + returnQuantity);
      } else {
        ctx.throw(400, '当前入库单状态不允许退单');
      }
      await PurchaseAdjustmentItem.create({
        adjustment_id: adjustmentId,
        request_item_id: requestItem.item_id,
        inbound_id: inbound.inbound_id,
        inbound_item_id: inboundItem.item_id,
        store_id: inbound.store_id,
        product_id: requestItem.product_id,
        product_name: requestItem.product_name || inboundItem.product_name || '',
        unit_price: unitPrice,
        original_quantity: originalQuantity,
        received_quantity: receivedQuantity,
        pending_quantity_before: inbound.status === 'pending' ? Math.max(Number(inboundItem.quantity || 0) + returnQuantity, 0) : 0,
        target_quantity: inbound.status === 'pending' ? Math.max(Number(inboundItem.quantity || 0), 0) : 0,
        quantity_delta: -returnQuantity,
        amount_delta: amountDelta,
        remark: `${operationType}${returnNo ? `:${returnNo}` : ''}${reason ? `；${reason}` : ''}`
      }, { transaction });

      totalQuantityDelta -= returnQuantity;
      totalAmountDelta = toSignedMoney(totalAmountDelta + amountDelta);
      totalRebateDelta = toSignedMoney(totalRebateDelta + rebateDelta);
      changedItemCount += 1;
    }

    if (changedItemCount === 0) ctx.throw(400, '调整后数量未发生变化');

    for (const inbound of inbounds.filter(item => item.status === 'pending')) {
      await refreshPendingInboundSummary(inbound, transaction);
    }
    for (const inbound of inbounds.filter(item => item.status === 'completed')) {
      const allItemsReturned = (inbound.items || []).every(item => {
        const alreadyReturned = returnedByInboundItem.get(String(item.item_id)) || 0;
        const currentReturned = currentReturnByInboundItem.get(String(item.item_id)) || 0;
        return alreadyReturned + currentReturned >= Number(item.quantity || 0);
      });
      if (allItemsReturned && (inbound.items || []).length > 0) {
        await inbound.update({ status: 'returned', update_time: new Date() }, { transaction });
      }
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
        request_no: request.request_no,
        payee_type: 'supplier',
        payee_id: request.supplier_id,
        payee_name: request.Supplier?.name || '',
        source_type: 'purchase_adjustment',
        source_id: adjustmentId,
        source_no: adjustmentNo,
        region_id: request.store_id ? (await Store.findByPk(request.store_id, { attributes: ['region_id'], transaction }))?.region_id || null : null,
        distributor_id: request.distributor_id || request.Store?.distributor_id || null,
        total_amount: totalAmountDelta,
        offset_amount: 0,
        paid_amount: 0,
        status: totalAmountDelta < 0 ? 'credit' : 'unpaid',
        create_time: new Date()
      }, { transaction });
      if (totalAmountDelta < 0 && request.supplier_id) {
        const originalPayable = await Payable.findOne({
          where: { request_id: request.request_id, source_type: 'purchase', total_amount: { [Op.gt]: 0 } },
          transaction,
          lock: transaction.LOCK.UPDATE
        });
        if (originalPayable) {
          const allocation = (await getAllocationSummary([originalPayable.payable_id], transaction)).get(String(originalPayable.payable_id)) || { amount: 0 };
          // 只要已经生成过结算单，就必须保留原结算事实，负向调整留作供应商后续抵扣。
          if (Number(allocation.amount || 0) <= 0) {
            const remaining = Math.max(0, getPayableRemaining(originalPayable.total_amount, allocation.amount, originalPayable.offset_amount));
            const offsetAmount = Math.min(Math.abs(totalAmountDelta), remaining);
            if (offsetAmount > 0) {
              await originalPayable.update({ offset_amount: toSignedMoney(Number(originalPayable.offset_amount || 0) + offsetAmount) }, { transaction });
              await Payable.update({ offset_amount: offsetAmount, offset_payable_id: originalPayable.payable_id, status: Math.abs(totalAmountDelta) <= offsetAmount + 0.005 ? 'offset' : 'credit' }, { where: { payable_id: payableId }, transaction });
              await refreshPayableState(originalPayable.payable_id, transaction);
            }
          }
        }
      }
    }

    await transaction.commit();
    ctx.body = {
      code: 0,
      message: totalQuantityDelta < 0 ? '采购退单完成，已生成负向待付款调整' : '采购数量调整完成，已生成正向待付款调整',
      data: { adjustmentId, adjustmentNo, payableId, totalQuantityDelta, totalAmountDelta, returns: createdReturns }
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
  const { comment = '' } = ctx.request.body || {};
  const user = ctx.state.user;
  const operatorName = user.name || user.phone || String(user.staffId || user.id || '');

  const request = await PurchaseRequest.findOne({
    where: { request_id: requestId },
    include: [{ model: Inbound, include: [{ model: InboundItem, as: 'items' }] }]
  });
  if (!request) ctx.throw(404, '采购申请不存在');
  assertStoreVisible(ctx, request.store_id);

  const roles = getUserRoles(user);
  const isPrivileged = roles.some(role => ['purchaser', 'finance', 'admin', 'boss'].includes(role));
  const currentStaffId = user.staffId || user.id;
  const isApplicant = request.applicant_staff_id && currentStaffId
    ? Number(request.applicant_staff_id) === Number(currentStaffId)
    : [user.name, user.phone, String(currentStaffId || '')].filter(Boolean).includes(request.apply_user);
  if (!isApplicant && !isPrivileged) ctx.throw(403, '只有申请人可以撤销该采购申请');

  if (!['pending', 'approved', 'purchased'].includes(request.status)) {
    ctx.throw(400, '当前采购申请状态不允许撤销');
  }
  const inbounds = request.Inbounds || [];
  if (inbounds.some(inbound => inbound.status === 'completed')) {
    ctx.throw(400, '该采购申请已有商品入库，无法撤销，请先办理退库');
  }

  const transaction = await sequelize.transaction();
  let transactionCommitted = false;
  try {
    for (const inbound of inbounds) {
      await InboundItem.destroy({ where: { inbound_id: inbound.inbound_id }, transaction });
      await Inbound.destroy({ where: { inbound_id: inbound.inbound_id }, transaction });
    }

    const settlements = await Settlement.findAll({
      where: {
        source_type: 'purchase',
        source_id: requestId,
        is_deleted: 0,
        status: { [Op.ne]: 'voided' }
      },
      transaction
    });
    for (const settlement of settlements) {
      await createSettlementReversal(settlement, user, transaction, comment || '采购申请已撤销');
    }

    const purchaseExpenses = await Expense.findAll({
      where: { source_type: 'purchase', source_id: requestId, is_deleted: 0 },
      transaction
    });
    for (const expense of purchaseExpenses) {
      await cancelExpenseRecord(expense, user, transaction, comment || '采购申请已撤销');
    }

    await Payable.update(
      { status: 'cancelled' },
      { where: { request_id: requestId }, transaction }
    );

    if (request.rebate_deduction && parseFloat(request.rebate_deduction) > 0) {
      const currentBalance = await _getRebateBalance(request.supplier_id, transaction);
      const newBalance = currentBalance + parseFloat(request.rebate_deduction);
      const supplier = await Supplier.findByPk(request.supplier_id, { transaction });
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
        create_user: operatorName
      }, { transaction });
      await recordSupplierRebateAccountTransaction(
        request.supplier_id, 'income', request.rebate_deduction,
        '采购撤销退回返利抵扣', request.request_no, operatorName, transaction
      );
    }

    await request.update({
      status: 'revoked',
      revoke_user: operatorName,
      revoke_time: new Date(),
      revoke_comment: String(comment || '').trim(),
      update_time: new Date()
    }, { transaction });
    await setFreightRecordStatus('purchase', requestId, 'cancelled', user, transaction);
    await recordBusinessAction({
      businessType: 'purchase_request',
      businessId: request.request_id,
      businessNo: request.request_no,
      action: 'revoked',
      fromStatus: request.status,
      toStatus: 'revoked',
      user,
      comment: comment || '',
      transaction
    });

    await transaction.commit();
    ctx.body = { code: 0, message: '撤销成功' };
  } catch (error) {
    if (!transactionCommitted) await transaction.rollback();
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
      { contact: { [Op.like]: `%${keyword}%` } },
      { phone: { [Op.like]: `%${keyword}%` } }
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
  exportRequestList,
  getRequestDetail,
  createRequest,
  saveRequestDraft,
  updateRequestDraft,
  submitRequestDraft,
  deleteRequestDraft,
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
    flattenPurchaseAllocations,
    validatePurchaseAllocations,
    getPurchaseAdjustmentTotals,
    getPurchaseAdjustmentItemDeltas,
    buildNegativePurchaseOrders,
    attachCurrentPurchaseItemAmounts,
    attachCurrentPurchaseAmounts,
    attachPurchasePaymentStatus,
    getPurchaseLifecycleStatus,
    buildPurchaseSubmitterCondition,
    buildPurchaseOperatorCondition
  }
};
