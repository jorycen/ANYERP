/**
 * 库房管理控制器
 * 优化版：非SN商品直接操作聚合库存，SN商品同时维护SN记录和聚合库存
 */
const fs = require('fs');
const path = require('path');
const {
  sequelize, Region, ProductSn, Product, ProductPn, ProductPrice, ProductPriceChangeLog,
  SnDistributorPrice, SnDistributorPriceChangeLog, ResourceCategory,
  ProductBarcode, Store, Location, InventoryWarning, Inbound, InboundItem,
  ReturnStock, ReturnStockItem, PurchaseRequest, PurchaseRequestItem, PurchaseAdjustment, Payable, Supplier, Inventory,
  SalesReturnRequest, SalesReturnRequestItem,
  SnLog, Order, OrderItem, Transfer, TransferItem, InventoryConversion,
  InventoryConversionItem
} = require('../../models');
const { Op, Sequelize } = require('sequelize');
const { generateInboundNo, generateOutboundNo, generateTransferNo, generateUUID, generateBatchNo, paginate, formatPaginatedResult, buildPendingFirstOrder } = require('../../utils');
const { getUserRoles } = require('../../middleware/permission');
const { initializeSnResourceRightsFromInbound, summariesForSns } = require('./resourceRights');
const { ensureStandardLocationsForStores } = require('../../utils/standardLocations');
const { sendExcel } = require('../../utils/excelExport');
const { recordBusinessAction, listBusinessActions } = require('../../utils/businessActionLog');
const { assertTransferStoreScope, isTransferScope, transferRegionKeys } = require('../../utils/transferScope');
const { canViewSnTraceReference, isDealerTraceAccount } = require('../../utils/snTracePermission');
const { resolveAllReadableStoreIds } = require('../../utils/storePermissions');
const { accessibleDistributorIds, canAccessDistributor } = require('../../utils/distributorScope');
const { assertSingleSnProductPn } = require('../../utils/productPn');
const { ensureProductPnMaster } = require('../../utils/productPnMaster');
const { syncFreightRecord, setFreightRecordStatus } = require('../finance/freightService');
const { createSalesReturnGrossProfitLedger } = require('../sales/grossProfit');
const { createProductSettlementReturnAdjustment } = require('../report/productSettlement');
const { createSalesReturnSettlement } = require('../sales/salesReturnSettlement');
const { releaseDepositRedemptionForOrder } = require('../sales/controller');
const { assertActiveProducts } = require('../../utils/activeProduct');
const { syncSerializedInventoryBalance } = require('./serializedInventoryBalance');
const { ensurePurchaseReturnAccounting } = require('../purchase/purchaseReturnAccounting');

const REUSABLE_INBOUND_SN_STATUSES = new Set(['out_stock', 'sold']);
const TRANSFER_SHIPPING_PHOTO_DIR = path.resolve(__dirname, '../../../uploads/transfer-shipping-photos');
const TRANSFER_SHIPPING_PHOTO_ROUTE = '/api/v1/inventory/transfer/shipping-photos';
const TRANSFER_PHOTO_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp'
};

function parseArrayBodyValue(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

async function persistTransferShippingPhotos(ctx, transferId) {
  const references = parseArrayBodyValue(ctx.request.body?.shippingPhotos)
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .slice(0, 9);
  const files = Array.isArray(ctx.files) ? ctx.files : [];
  if (references.length + files.length > 9) {
    ctx.throw(400, '最多上传9张出库凭证照片');
  }

  const storedPaths = [];
  const photos = [...references];
  try {
    if (files.length) await fs.promises.mkdir(TRANSFER_SHIPPING_PHOTO_DIR, { recursive: true });
    for (const file of files) {
      const extension = TRANSFER_PHOTO_EXTENSIONS[String(file.mimetype || '').toLowerCase()];
      if (!extension) ctx.throw(400, '出库凭证仅支持 JPG、PNG、WEBP 图片');
      if (!file.buffer?.length) ctx.throw(400, '出库凭证照片内容为空');

      const photoId = generateUUID();
      const filePath = path.join(TRANSFER_SHIPPING_PHOTO_DIR, `${photoId}${extension}`);
      await fs.promises.writeFile(filePath, file.buffer);
      storedPaths.push(filePath);
      photos.push(`${TRANSFER_SHIPPING_PHOTO_ROUTE}/${encodeURIComponent(transferId)}/${photoId}`);
    }
    return { photos: photos.slice(0, 9), storedPaths };
  } catch (error) {
    await Promise.all(storedPaths.map(filePath => fs.promises.unlink(filePath).catch(() => {})));
    throw error;
  }
}

async function getTransferShippingPhoto(ctx) {
  const { transferId, photoId } = ctx.params;
  const transfer = await Transfer.findByPk(transferId, {
    attributes: ['transfer_id', 'from_store_id', 'to_store_id', 'shipping_photos']
  });
  if (!transfer) ctx.throw(404, '调拨单不存在');

  const accessibleStoreIds = ctx.state.user?.accessibleStoreIds || [];
  const canView = accessibleStoreIds.includes('*')
    || [transfer.from_store_id, transfer.to_store_id].some(storeId => accessibleStoreIds.map(String).includes(String(storeId || '')));
  if (!canView) ctx.throw(403, '无权查看该调拨凭证');

  const photos = parseArrayBodyValue(transfer.shipping_photos);
  const photoUrl = photos.find(photo => String(photo || '').endsWith(`/${photoId}`));
  if (!photoUrl || !/^[a-zA-Z0-9-]+$/.test(String(photoId || ''))) ctx.throw(404, '出库凭证不存在');

  const names = await fs.promises.readdir(TRANSFER_SHIPPING_PHOTO_DIR).catch(() => []);
  const fileName = names.find(name => name.startsWith(`${photoId}.`));
  if (!fileName) ctx.throw(404, '出库凭证文件不存在');
  const filePath = path.join(TRANSFER_SHIPPING_PHOTO_DIR, fileName);
  ctx.type = path.extname(fileName);
  ctx.body = fs.createReadStream(filePath);
}

function isTransferInboundRecord(inbound) {
  return String(inbound?.source_type || '').trim().toUpperCase() === 'TRANSFER';
}

async function restoreDepositForCompletedSalesReturn(order, fullyReturned, transaction, release = releaseDepositRedemptionForOrder) {
  if (!fullyReturned) return false;
  await release(order, transaction, '销售退单整单退货，恢复定金');
  return true;
}

function buildNonTransferInboundCondition() {
  return {
    [Op.or]: [
      { source_type: null },
      Sequelize.where(Sequelize.fn('UPPER', Sequelize.col('source_type')), { [Op.ne]: 'TRANSFER' })
    ]
  };
}

function splitCodes(value) {
  return String(value || '')
    .split(/[,，\s]+/)
    .map(code => code.trim())
    .filter(Boolean);
}

function assertStoreVisible(ctx, storeId) {
  const allowed = ctx.state.user.accessibleStoreIds || [];
  if (!allowed.includes('*') && !allowed.map(String).includes(String(storeId || ''))) {
    ctx.throw(403, '无权访问该门店库存数据');
  }
}

async function assertTransferOperationStore(ctx, storeId) {
  const user = ctx.state.user || {};
  if (getUserRoles(user).includes('boss')) return;
  if (isDistributorAccount(user)) {
    return assertTransferStoreScope(ctx, storeId, { ignoreRegion: true });
  }
  assertStoreVisible(ctx, storeId);
  return null;
}

const CLERK_TRANSFER_ROLE_CODES = new Set(['clerk', 'staff']);
const MANAGER_TRANSFER_ROLE_CODES = new Set(['manager', 'store_manager']);
const STORE_ONLY_ROLE_CODES = new Set([
  ...CLERK_TRANSFER_ROLE_CODES,
  ...MANAGER_TRANSFER_ROLE_CODES,
  'store_admin'
]);
const TRANSFER_REQUEST_STATUSES = new Set(['pending', 'requested', 'applied', 'shipping']);

function getSnStatusLabel(status) {
  const labels = {
    in_stock: '在库',
    reserved: '已占用',
    occupied: '已占用',
    sold: '已销售',
    out_stock: '已出库',
    transferring: '调拨中',
    return_pending: '退货待入库',
    voided: '已作废'
  };
  return labels[String(status || '').trim()] || String(status || '未知');
}

const TRANSFER_PARTICIPANT_FIELDS = [
  'apply_user',
  'confirm_user',
  'inbound_confirm_user',
  'shipping_user',
  'receiving_user'
];

function getTransferVisibilityLevel(user) {
  const roles = getUserRoles(user);
  if (roles.includes('boss')) return 'all';
  if (roles.some(role => !CLERK_TRANSFER_ROLE_CODES.has(role) && !MANAGER_TRANSFER_ROLE_CODES.has(role))) return 'distributor';
  if (roles.some(role => MANAGER_TRANSFER_ROLE_CODES.has(role))) return 'store';
  return 'participant';
}

function isDistributorAccount(user) {
  const roles = getUserRoles(user);
  return roles.some(role => !STORE_ONLY_ROLE_CODES.has(role));
}

function buildTransferVisibilityWhere(user, distributorStoreIds = [], distributorId = '') {
  const level = getTransferVisibilityLevel(user);
  if (level === 'all') return [];

  const storeIds = (distributorStoreIds || []).map(String).filter(Boolean);
  const storeScope = storeIds.length > 0
    ? [
        { from_store_id: { [Op.in]: storeIds } },
        { to_store_id: { [Op.in]: storeIds } }
      ]
    : [];
  const participantName = String(user?.name || '').trim();
  const participantScope = participantName
    ? TRANSFER_PARTICIPANT_FIELDS.map(field => ({ [field]: participantName }))
    : [{ transfer_id: { [Op.in]: ['__NO_TRANSFER_PARTICIPANT__'] } }];
  const visibleScope = level === 'participant'
    ? (storeScope.length > 0 ? [...participantScope, ...storeScope] : participantScope)
    : storeScope;
  const conditions = [{
    [Op.or]: visibleScope.length > 0
      ? visibleScope
      : [{ transfer_id: { [Op.in]: ['__NO_TRANSFER_SCOPE__'] } }]
  }];

  return conditions;
}

async function assertTransferScope(ctx, fromStoreId, toStoreId) {
  const stores = await Store.findAll({
    where: { store_id: { [Op.in]: [fromStoreId, toStoreId] }, is_deleted: 0, status: 1 },
    attributes: ['store_id', 'distributor_id', 'region_id'],
    include: [{ model: Region, attributes: ['region_id', 'region_code', 'name'] }]
  });
  const fromStore = stores.find(store => String(store.store_id) === String(fromStoreId));
  const toStore = stores.find(store => String(store.store_id) === String(toStoreId));
  if (!fromStore || !toStore) ctx.throw(400, '调拨门店不存在或已停用');
  if (!fromStore.distributor_id || String(fromStore.distributor_id) !== String(toStore.distributor_id)) {
    ctx.throw(400, '只能在同一经销商内发起调拨');
  }
  const fromRegionKeys = [fromStore.region_id, fromStore.Region?.region_id, fromStore.Region?.region_code, fromStore.Region?.name]
    .filter(Boolean).map(String);
  const toRegionKeys = [toStore.region_id, toStore.Region?.region_id, toStore.Region?.region_code, toStore.Region?.name]
    .filter(Boolean).map(String);
  if (!fromRegionKeys.length || !toRegionKeys.some(key => fromRegionKeys.includes(key))) {
    ctx.throw(400, '商品不能跨区域调拨，请走出库及采购流程');
  }

  // 调拨申请不要求申请人拥有调出门店的普通库存权限，但申请人仍必须属于
  // 调拨门店所属经销商，避免仅凭区域权限跨经销商发起申请。
  const user = ctx.state.user || {};
  const roles = getUserRoles(user);
  let userDistributorId = '';
  let currentStore = null;
  if (Array.isArray(user.accessibleStoreIds) && !user.accessibleStoreIds.includes('*')) {
    const assignedStore = await Store.findOne({
      where: { store_id: { [Op.in]: user.accessibleStoreIds }, is_deleted: 0, status: 1 },
      attributes: ['distributor_id', 'region_id'],
      include: [{ model: Region, attributes: ['region_id', 'region_code', 'name'] }]
    });
    currentStore = currentStore || assignedStore;
    userDistributorId = String(assignedStore?.distributor_id || '');
  }
  if (!userDistributorId) {
    userDistributorId = String(user.distributorId || '');
  }
  if (!roles.includes('boss') && !canAccessDistributor(user, fromStore.distributor_id)) {
    ctx.throw(403, '无权操作该经销商的调拨');
  }
  const userRegionKeys = [...new Set(
    (Array.isArray(user.regionCodes) ? user.regionCodes : [])
      .concat(transferRegionKeys(currentStore))
      .map(String)
      .filter(Boolean)
  )];
  if (!roles.includes('boss') && !userRegionKeys.includes('*') && userRegionKeys.length && !fromRegionKeys.some(key => userRegionKeys.includes(key))) {
    ctx.throw(403, '无权操作该区域的调拨');
  }
  return { distributorId: fromStore.distributor_id, regionId: fromStore.region_id };
}

function assertTransferRequestOpen(ctx, transfer) {
  if (!TRANSFER_REQUEST_STATUSES.has(String(transfer.status || '').toLowerCase())) {
    ctx.throw(400, '当前调拨申请状态不允许此操作');
  }
}

function isTransferApplicant(user, transfer) {
  const applicant = String(transfer.apply_user || '').trim();
  const identities = [user.name, user.userName, user.staffId, user.staff_id, user.userId, user.user_id, user.phone]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  return Boolean(applicant && identities.includes(applicant));
}

function assertTransferApplicant(ctx, transfer) {
  if (!isTransferApplicant(ctx.state.user || {}, transfer)) {
    ctx.throw(403, '只有调拨申请发起人可以撤销申请');
  }
}

async function changeTransferRequestStatus(ctx, targetStatus, action, actorCheck) {
  const t = await sequelize.transaction();
  try {
    const user = ctx.state.user || {};
    const transferId = ctx.request.body?.transferId || ctx.request.body?.transfer_id;
    if (!transferId) ctx.throw(400, '调拨单ID不能为空');
    const transfer = await Transfer.findByPk(transferId, {
      transaction: t,
      lock: t.LOCK.UPDATE
    });
    if (!transfer) ctx.throw(404, '调拨单不存在');

    await actorCheck(ctx, transfer);
    assertTransferRequestOpen(ctx, transfer);

    const reason = String(ctx.request.body?.reason || ctx.request.body?.comment || '').trim().slice(0, 1000);
    const fromStatus = transfer.status;
    await transfer.update({ status: targetStatus }, { transaction: t });
    await setFreightRecordStatus('transfer', transfer.transfer_id, 'cancelled', user, t);
    await recordBusinessAction({
      businessType: 'inventory_transfer',
      businessId: transfer.transfer_id,
      businessNo: transfer.transfer_no,
      action,
      fromStatus,
      toStatus: targetStatus,
      user,
      comment: reason,
      transaction: t
    });

    await t.commit();
    ctx.body = { code: 0, data: { transferId: transfer.transfer_id, status: targetStatus }, message: action === 'revoked' ? '调拨申请已撤销' : '调拨申请已拒绝' };
  } catch (err) {
    await t.rollback();
    if (err.status) ctx.throw(err.status, err.message);
    console.error(`${action} transfer error:`, err);
    ctx.throw(500, action === 'revoked' ? '撤销调拨申请失败' : '拒绝调拨申请失败');
  }
}

async function revokeTransfer(ctx) {
  return changeTransferRequestStatus(ctx, 'revoked', 'revoked', assertTransferApplicant);
}

async function rejectTransfer(ctx) {
  return changeTransferRequestStatus(ctx, 'rejected', 'rejected', (requestCtx, transfer) => {
    return assertTransferOperationStore(requestCtx, transfer.from_store_id);
  });
}

function isTransferAwaitingReceipt(status) {
  return ['out_confirmed', 'shipping_out', 'in_transit'].includes(String(status || '').toLowerCase());
}

/**
 * 退回运输中的调拨。
 *
 * 出库确认时，非 SN 商品已经从调出门店扣减 normal_qty，SN 商品已经标记为
 * transferring；退回必须在同一事务中把这两类库存恢复，并取消关联的待入库单。
 */
async function returnTransfer(ctx) {
  const t = await sequelize.transaction();
  try {
    const user = ctx.state.user || {};
    const transferId = ctx.request.body?.transferId || ctx.request.body?.transfer_id;
    const reason = String(ctx.request.body?.reason || ctx.request.body?.comment || '').trim().slice(0, 1000);

    if (!transferId) ctx.throw(400, '调拨单ID不能为空');

    const transfer = await Transfer.findByPk(transferId, {
      include: [{ model: TransferItem }],
      transaction: t,
      lock: t.LOCK.UPDATE
    });
    if (!transfer) ctx.throw(404, '调拨单不存在');

    // 退回权限与收货一致，由调入门店或经销商账号操作。
    await assertTransferOperationStore(ctx, transfer.to_store_id);
    if (!isTransferAwaitingReceipt(transfer.status)) {
      ctx.throw(400, '只有运输中、待收货的调拨单可以退回');
    }

    const transferInbound = await Inbound.findOne({
      where: { source_type: 'TRANSFER', source_no: transfer.transfer_no },
      transaction: t,
      lock: t.LOCK.UPDATE
    });
    if (transferInbound && transferInbound.status !== 'pending') {
      ctx.throw(409, '该调拨已完成入库，无法退回');
    }

    let restoredQuantity = 0;
    let restoredSnQuantity = 0;
    const restoredItems = [];
    const items = visibleTransferItems(transfer.TransferItems || []);

    for (const item of items) {
      const quantity = Math.max(Number(item.quantity || 0), 0);
      if (!quantity) continue;

      if (item.sn_id || item.sn_code) {
        const snWhere = item.sn_id
          ? { sn_id: item.sn_id, product_id: item.product_id, is_deleted: 0 }
          : { sn_code: item.sn_code, product_id: item.product_id, is_deleted: 0 };
        const sn = await ProductSn.findOne({
          where: snWhere,
          transaction: t,
          lock: t.LOCK.UPDATE
        });
        if (!sn) ctx.throw(409, `SN ${item.sn_code || item.sn_id} 不存在，无法恢复库存`);
        if (String(sn.store_id || '') !== String(transfer.from_store_id)) {
          ctx.throw(409, `SN ${sn.sn_code || item.sn_code || item.sn_id} 已不在原调出门店，无法退回`);
        }
        if (sn.status !== 'transferring') {
          ctx.throw(409, `SN ${sn.sn_code || item.sn_code || item.sn_id} 当前不是运输中状态，无法退回`);
        }

        await sn.update({ status: 'in_stock' }, { transaction: t });
        await SnLog.create({
          log_id: generateUUID(),
          sn_id: sn.sn_id,
          sn_code: sn.sn_code,
          product_id: item.product_id,
          store_id: transfer.from_store_id,
          action: 'transfer_return',
          remark: reason || `调拨退回：${transfer.from_store_id} → ${transfer.to_store_id}，单号：${transfer.transfer_no}`,
          create_user: transfer.apply_user || user.name || user.staffId
        }, { transaction: t });
        restoredSnQuantity += 1;
        restoredQuantity += 1;
        restoredItems.push({ productId: item.product_id, snId: sn.sn_id, quantity: 1 });
        continue;
      }

      await updateInventory(item.product_id, transfer.from_store_id, 'normal_qty', quantity, t);
      restoredQuantity += quantity;
      restoredItems.push({ productId: item.product_id, quantity });
    }

    if (transferInbound) {
      await transferInbound.update({ status: 'cancelled', update_time: new Date() }, { transaction: t });
    }

    const fromStatus = transfer.status;
    await transfer.update({
      status: 'returned',
      remaining_status: 'returned'
    }, { transaction: t });
    await recordBusinessAction({
      businessType: 'inventory_transfer',
      businessId: transfer.transfer_id,
      businessNo: transfer.transfer_no,
      action: 'returned',
      fromStatus,
      toStatus: 'returned',
      user,
      comment: reason,
      detail: {
        restoredQuantity,
        restoredSnQuantity,
        inboundId: transferInbound?.inbound_id || '',
        items: restoredItems
      },
      transaction: t
    });

    await t.commit();
    ctx.body = {
      code: 0,
      data: { transferId: transfer.transfer_id, status: 'returned', restoredQuantity },
      message: '调拨已退回，库存已恢复'
    };
  } catch (err) {
    await t.rollback();
    if (err.status) ctx.throw(err.status, err.message);
    console.error('return transfer error:', err);
    ctx.throw(500, '调拨退回失败');
  }
}

const RESOURCE_STATUS_LABELS = {
  AVAILABLE: '可用',
  LOCKED: '已锁定',
  USED: '已核销',
  CLAIMED_BACK: '已套回',
  NOT_APPLICABLE: '不适用',
  EXCEPTION: '异常'
};

function calculateStockAgeDays(inboundTime, now = new Date()) {
  if (!inboundTime) return null;
  const start = new Date(inboundTime);
  if (Number.isNaN(start.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)));
}

function resolveOriginalInboundTime(originalInboundTime, inboundTime) {
  return originalInboundTime || inboundTime || null;
}

function resolveEffectiveSalePrice(unifiedSalePrice, specialPrice) {
  const special = Number(specialPrice || 0);
  return special > 0 ? special : Number(unifiedSalePrice || 0);
}

function canManageDistributorPrice(user, distributorId) {
  const roles = getUserRoles(user);
  if (roles.includes('boss')) return true;
  return roles.includes('admin') && canAccessDistributor(user, distributorId);
}

async function resolveSnPriceScope(ctx, snId, { requireInStock = false } = {}) {
  const sn = await ProductSn.findOne({
    where: { sn_id: snId, is_deleted: 0 },
    attributes: ['sn_id', 'sn_code', 'product_id', 'store_id', 'status', 'remark']
  });
  if (!sn) ctx.throw(404, 'SN不存在');
  if (requireInStock && sn.status !== 'in_stock') ctx.throw(409, '只有当前在库SN可以设置特价');
  if (!sn.store_id) ctx.throw(400, 'SN未绑定当前门店，无法确定经销商价格范围');

  assertStoreVisible(ctx, sn.store_id);
  const store = await Store.findOne({
    where: { store_id: sn.store_id, is_deleted: 0 },
    attributes: ['store_id', 'name', 'distributor_id']
  });
  if (!store) ctx.throw(404, 'SN所在门店不存在');
  if (!store.distributor_id) ctx.throw(400, 'SN所在门店未绑定经销商');
  if (!canManageDistributorPrice(ctx.state.user, store.distributor_id)) {
    ctx.throw(403, '只能维护当前账号所属经销商的SN特价');
  }
  return { sn, store, distributorId: store.distributor_id };
}

/**
 * SN库存清单 - 默认只显示当前在库SN，按授权门店在数据库层筛选与分页。
 */
async function getSnInventoryList(ctx) {
  const {
    keyword = '', storeId = '', locationId = '', resourceType = '', resourceStatus = '',
    specialOnly = '', minAgeDays = '', maxAgeDays = '', page = 1, pageSize = 20
  } = ctx.query;
  const user = ctx.state.user || {};
  const exportMode = Boolean(ctx.state.inventoryExportMode);
  const allowedStoreIds = await resolveAllReadableStoreIds(user);

  if (storeId && !allowedStoreIds.includes('*') && !allowedStoreIds.map(String).includes(String(storeId))) {
    ctx.throw(403, '无权访问该门店库存数据');
  }
  if (!storeId && !allowedStoreIds.includes('*') && allowedStoreIds.length === 0) {
    ctx.body = formatPaginatedResult([], { page, pageSize, count: 0 });
    return;
  }

  const where = [
    "sn.STATUS IN ('in_stock', 'reserved', 'occupied', 'sold')",
    'sn.IS_DELETED = 0',
    'p.IS_DELETED = 0',
    'p.STATUS = 1',
    'st.IS_DELETED = 0'
  ];
  const replacements = {};

  if (storeId) {
    where.push('sn.STORE_ID = :storeId');
    replacements.storeId = storeId;
  } else if (!allowedStoreIds.includes('*')) {
    where.push('sn.STORE_ID IN (:allowedStoreIds)');
    replacements.allowedStoreIds = allowedStoreIds;
  }
  if (locationId) {
    where.push('sn.LOCATION_ID = :locationId');
    replacements.locationId = locationId;
  }
  if (keyword) {
    where.push('(sn.SN_CODE LIKE :keyword OR sn.PN_CODE LIKE :keyword OR p.NAME LIKE :keyword OR p.PRODUCT_CODE LIKE :keyword)');
    replacements.keyword = `%${String(keyword).trim()}%`;
  }
  if (resourceType) {
    const statusSql = resourceStatus ? ' AND rr.CURRENT_STATUS = :resourceStatus' : '';
    where.push(`EXISTS (
      SELECT 1 FROM T_INVENTORY_RESOURCE_RIGHT rr
      WHERE rr.SN_ID = sn.SN_ID AND rr.RESOURCE_TYPE = :resourceType${statusSql}
    )`);
    replacements.resourceType = resourceType;
    if (resourceStatus) replacements.resourceStatus = resourceStatus;
  } else if (resourceStatus) {
    where.push(`EXISTS (
      SELECT 1 FROM T_INVENTORY_RESOURCE_RIGHT rr
      WHERE rr.SN_ID = sn.SN_ID AND rr.CURRENT_STATUS = :resourceStatus
    )`);
    replacements.resourceStatus = resourceStatus;
  }
  if (String(specialOnly) === '1') where.push('sp.PRICE_ID IS NOT NULL');

  const minAge = Number(minAgeDays);
  if (minAgeDays !== '' && Number.isFinite(minAge) && minAge >= 0) {
    where.push('COALESCE(sn.ORIGINAL_INBOUND_TIME, sn.INBOUND_TIME) IS NOT NULL AND TIMESTAMPDIFF(DAY, COALESCE(sn.ORIGINAL_INBOUND_TIME, sn.INBOUND_TIME), NOW()) >= :minAgeDays');
    replacements.minAgeDays = Math.floor(minAge);
  }
  const maxAge = Number(maxAgeDays);
  if (maxAgeDays !== '' && Number.isFinite(maxAge) && maxAge >= 0) {
    where.push('COALESCE(sn.ORIGINAL_INBOUND_TIME, sn.INBOUND_TIME) IS NOT NULL AND TIMESTAMPDIFF(DAY, COALESCE(sn.ORIGINAL_INBOUND_TIME, sn.INBOUND_TIME), NOW()) <= :maxAgeDays');
    replacements.maxAgeDays = Math.floor(maxAge);
  }

  const joins = `
    FROM T_PRODUCT_SN sn
    INNER JOIN T_PRODUCT p ON p.PRODUCT_ID = sn.PRODUCT_ID
    INNER JOIN T_STORE st ON st.STORE_ID = sn.STORE_ID
    LEFT JOIN T_LOCATION loc ON loc.LOCATION_ID = sn.LOCATION_ID
    LEFT JOIN T_PRODUCT_PRICE pp ON pp.PRODUCT_ID = sn.PRODUCT_ID AND pp.STATUS = 1
    LEFT JOIN T_SN_DISTRIBUTOR_PRICE sp
      ON sp.SN_ID = sn.SN_ID
     AND sp.DISTRIBUTOR_ID = st.DISTRIBUTOR_ID
     AND sp.STATUS = 1`;
  const whereSql = ` WHERE ${where.join(' AND ')}`;
  const countRows = await sequelize.query(
    `SELECT COUNT(*) AS total ${joins}${whereSql}`,
    { replacements, type: Sequelize.QueryTypes.SELECT }
  );
  const count = Number(countRows[0]?.total || 0);
  const currentPage = Math.max(Number(page) || 1, 1);
  const currentPageSize = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const offset = (currentPage - 1) * currentPageSize;

  const paginationSql = exportMode ? '' : ' LIMIT :limit OFFSET :offset';
  const rows = await sequelize.query(
    `SELECT
       sn.SN_ID AS sn_id,
       sn.SN_CODE AS sn_code,
       sn.PN_CODE AS pn_code,
       sn.PRODUCT_ID AS product_id,
       sn.STORE_ID AS store_id,
       sn.LOCATION_ID AS location_id,
       sn.STATUS AS status,
       sn.UPDATE_TIME AS status_change_time,
       COALESCE(sn.ORIGINAL_INBOUND_TIME, sn.INBOUND_TIME) AS original_inbound_time,
       sn.INBOUND_TIME AS inbound_time,
       sn.TAX_TYPE AS tax_type,
       sn.SOURCE_TYPE AS source_type,
       sn.REMARK AS remark,
       p.NAME AS product_name,
       p.PRODUCT_CODE AS product_code,
       st.NAME AS store_name,
       st.DISTRIBUTOR_ID AS distributor_id,
       COALESCE(loc.NAME, '未指定库位') AS location_name,
       COALESCE(pp.STANDARD_PRICE, 0) AS unified_sale_price,
       COALESCE(pp.RETAIL_PRICE, 0) AS retail_price,
       COALESCE(pp.MIN_SALE_PRICE, 0) AS min_sale_price,
       sp.PRICE_ID AS special_price_id,
       sp.SPECIAL_PRICE AS special_price,
       sp.REMARK AS special_price_remark,
       sp.UPDATE_USER AS special_price_update_user,
       sp.UPDATE_TIME AS special_price_update_time
     ${joins}${whereSql}
      ORDER BY (COALESCE(sn.ORIGINAL_INBOUND_TIME, sn.INBOUND_TIME) IS NULL) ASC,
               TIMESTAMPDIFF(SECOND, COALESCE(sn.ORIGINAL_INBOUND_TIME, sn.INBOUND_TIME), NOW()) DESC,
               COALESCE(sn.ORIGINAL_INBOUND_TIME, sn.INBOUND_TIME) ASC,
               sn.SN_ID DESC${paginationSql}`,
    {
      replacements: exportMode ? replacements : { ...replacements, limit: currentPageSize, offset },
      type: Sequelize.QueryTypes.SELECT
    }
  );

  const summaryMap = await summariesForSns(rows);
  const categories = await ResourceCategory.findAll({
    where: { status: 1 },
    attributes: ['category_code', 'name', 'short_name'],
    raw: true
  });
  const categoryNames = new Map(categories.map(row => [row.category_code, row.short_name || row.name]));
  const list = rows.map(row => {
    const summary = summaryMap.get(row.sn_id) || { rights: [] };
    const resourceStatuses = (summary.rights || [])
      .map(right => right.toJSON ? right.toJSON() : right)
      .filter(right => right.current_status && right.current_status !== 'NOT_APPLICABLE')
      .map(right => ({
        resource_type: right.resource_type,
        resource_name: categoryNames.get(right.resource_type) || right.resource_type,
        current_status: right.current_status,
        status_name: RESOURCE_STATUS_LABELS[right.current_status] || right.current_status,
        amount: Number(right.amount || 0)
      }));
    const unifiedSalePrice = Number(row.unified_sale_price || 0);
    const specialPrice = row.special_price_id ? Number(row.special_price || 0) : null;
    return {
      ...row,
      status_label: getSnStatusLabel(row.status),
      statusText: getSnStatusLabel(row.status),
      unified_sale_price: unifiedSalePrice,
      min_sale_price: Number(row.min_sale_price || 0),
      retail_price: Number(row.retail_price || 0),
      special_price: specialPrice,
      is_special_price: Boolean(row.special_price_id),
      effective_sale_price: resolveEffectiveSalePrice(unifiedSalePrice, specialPrice),
       stock_age_days: calculateStockAgeDays(row.original_inbound_time),
       status_duration_days: calculateStockAgeDays(row.status_change_time),
      resource_statuses: resourceStatuses
    };
  });

  if (exportMode) {
    const data = list.map(row => ({
      SN: row.sn_code || '',
      PN: row.pn_code || '',
      商品名称: row.product_name || '',
      所在门店: row.store_name || '',
      库位: row.location_name || '',
      状态: row.status_label || '',
      状态变更时间: row.status_change_time || '',
      资源情况: (row.resource_statuses || []).map(resource => `${resource.resource_name}: ${resource.status_name}`).join('\n'),
      统一售价: Number(row.unified_sale_price || 0),
      SN特价: row.is_special_price ? Number(row.special_price || 0) : '',
      当前适用售价: Number(row.effective_sale_price || 0),
      库龄: row.stock_age_days == null ? '' : row.stock_age_days,
       入库时间: row.original_inbound_time || row.inbound_time || '',
      备注: row.remark || ''
    }));
    sendExcel(ctx, data, [
      'SN', 'PN', '商品名称', '所在门店', '库位', '状态', '状态变更时间', '资源情况',
      '统一售价', 'SN特价', '当前适用售价', '库龄', '入库时间', '备注'
    ], `SN库存清单_${new Date().toISOString().slice(0, 10)}.xlsx`, 'SN库存清单');
    return;
  }

  ctx.body = formatPaginatedResult(list, {
    page: currentPage,
    pageSize: currentPageSize,
    count
  });
}

async function setSnSpecialPrice(ctx) {
  const { snId } = ctx.params;
  const specialPrice = Number(ctx.request.body?.specialPrice);
  const remark = String(ctx.request.body?.remark || '').trim();
  if (!Number.isFinite(specialPrice) || specialPrice <= 0 || specialPrice > 9999999999.99) {
    ctx.throw(400, 'SN特价必须是大于0的有效金额');
  }
  const { sn, distributorId } = await resolveSnPriceScope(ctx, snId, { requireInStock: true });
  const user = ctx.state.user || {};
  let priceId = '';
  let action = 'SET';

  await sequelize.transaction(async transaction => {
    let record = await SnDistributorPrice.findOne({
      where: { sn_id: sn.sn_id, distributor_id: distributorId },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    const oldPrice = record?.status === 1 ? Number(record.special_price || 0) : null;
    action = record ? (record.status === 1 ? 'UPDATE' : 'SET') : 'SET';
    if (!record) {
      record = await SnDistributorPrice.create({
        price_id: generateUUID(),
        sn_id: sn.sn_id,
        sn_code: sn.sn_code,
        distributor_id: distributorId,
        special_price: specialPrice,
        status: 1,
        remark,
        create_staff_id: user.staffId,
        create_user: user.name,
        update_staff_id: user.staffId,
        update_user: user.name
      }, { transaction });
    } else {
      await record.update({
        sn_code: sn.sn_code,
        special_price: specialPrice,
        status: 1,
        remark,
        update_staff_id: user.staffId,
        update_user: user.name,
        update_time: new Date()
      }, { transaction });
    }
    priceId = record.price_id;
    await SnDistributorPriceChangeLog.create({
      change_id: generateUUID(),
      price_id: record.price_id,
      sn_id: sn.sn_id,
      sn_code: sn.sn_code,
      distributor_id: distributorId,
      action,
      old_price: oldPrice,
      new_price: specialPrice,
      remark,
      operator_staff_id: user.staffId,
      operator_name: user.name
    }, { transaction });
  });

  const productPrice = await ProductPrice.findOne({
    where: { product_id: sn.product_id },
    attributes: ['standard_price', 'retail_price', 'min_sale_price'],
    raw: true
  });
  ctx.body = {
    priceId,
    specialPrice,
    action,
    requiresPriceApproval: Number(productPrice?.min_sale_price || 0) > 0 &&
      specialPrice < Number(productPrice.min_sale_price)
  };
}

async function cancelSnSpecialPrice(ctx) {
  const { snId } = ctx.params;
  const remark = String(ctx.request.body?.remark || '').trim();
  const { sn, distributorId } = await resolveSnPriceScope(ctx, snId);
  const user = ctx.state.user || {};
  let cancelled = false;

  await sequelize.transaction(async transaction => {
    const record = await SnDistributorPrice.findOne({
      where: { sn_id: sn.sn_id, distributor_id: distributorId },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!record || record.status !== 1) return;
    const oldPrice = Number(record.special_price || 0);
    await record.update({
      status: 0,
      remark: remark || record.remark,
      update_staff_id: user.staffId,
      update_user: user.name,
      update_time: new Date()
    }, { transaction });
    await SnDistributorPriceChangeLog.create({
      change_id: generateUUID(),
      price_id: record.price_id,
      sn_id: sn.sn_id,
      sn_code: sn.sn_code,
      distributor_id: distributorId,
      action: 'CANCEL',
      old_price: oldPrice,
      new_price: null,
      remark,
      operator_staff_id: user.staffId,
      operator_name: user.name
    }, { transaction });
    cancelled = true;
  });

  ctx.body = { cancelled };
}

async function getSnSpecialPriceHistory(ctx) {
  const { sn, distributorId } = await resolveSnPriceScope(ctx, ctx.params.snId);
  const rows = await SnDistributorPriceChangeLog.findAll({
    where: { sn_id: sn.sn_id, distributor_id: distributorId },
    order: [['create_time', 'DESC'], ['change_id', 'DESC']],
    raw: true
  });
  ctx.body = rows;
}

function normalizePnCode(value) {
  const code = String(value || '').trim();
  return code.length > 64 ? code.slice(0, 64) : code;
}

function normalizeSnIdentityValue(value) {
  return String(value || '').trim().replace(/\s+/g, '').toLowerCase();
}

function samePnCode(left, right) {
  return normalizeSnIdentityValue(left) === normalizeSnIdentityValue(right);
}

async function findInboundSnByIdentity({ pnCode, snCode, transaction }) {
  const exact = await ProductSn.findOne({
    where: { pn_code: pnCode, sn_code: snCode },
    transaction,
    lock: transaction?.LOCK?.UPDATE
  });
  if (exact) return exact;

  // 兼容历史 PN 中存在大小写或内部空格差异的记录，避免漏查后再次 INSERT。
  const candidates = await ProductSn.findAll({
    where: { sn_code: snCode },
    transaction,
    lock: transaction?.LOCK?.UPDATE
  });
  const pnKey = normalizeSnIdentityValue(pnCode);
  return candidates.find(item => normalizeSnIdentityValue(item.pn_code) === pnKey) || null;
}

async function ensureDefaultProductPricing(product, purchasePrice, user, transaction) {
  const pricing = money(purchasePrice);
  if (!product?.product_id || pricing <= 0) return;

  let price = await ProductPrice.findOne({
    where: { product_id: product.product_id },
    transaction,
    lock: transaction?.LOCK?.UPDATE || true
  });
  if (price && Number(price.standard_price || 0) > 0) return;

  const now = new Date();
  const operator = user?.name || user?.staffId || 'system';
  if (price) {
    await price.update({
      standard_price: pricing,
      effective_time: now,
      create_user: operator
    }, { transaction });
  } else {
    price = await ProductPrice.create({
      price_id: generateUUID(),
      product_id: product.product_id,
      cost_price: pricing,
      standard_price: pricing,
      min_sale_price: 0,
      effective_time: now,
      create_user: operator,
      status: 1
    }, { transaction });
  }

  await ProductPriceChangeLog.create({
    change_id: generateUUID(),
    product_id: product.product_id,
    product_code: product.product_code || '',
    product_name: product.name || '',
    manufacturer_code: product.manufacturer_code || '',
    price_field: 'standard_price',
    old_price: 0,
    new_price: pricing,
    effective_time: now,
    source: 'purchase_default',
    change_reason: '产品定价首次默认采用采购价',
    status: 'effective',
    create_user: operator,
    create_time: now,
    applied_time: now
  }, { transaction });
}

function getSalesInventoryQty(inv) {
  return Math.max(
    Number(inv.normal_qty || 0),
    Number(inv.regular_qty || 0) + Number(inv.subsidy_qty || 0) + Number(inv.second_qty || 0)
  );
}

const INVENTORY_QUANTITY_FIELDS = ['normal_qty', 'display_qty', 'demo_qty', 'unsellable_qty', 'pending_qty', 'rental_demo_qty'];

function isSalesWarehouseLocation(locationType) {
  return String(locationType || '').trim() === 'normal_qty';
}

function isInStockSalesWarehouseSn(sn, location) {
  return String(sn?.status || '').trim() === 'in_stock'
    && isSalesWarehouseLocation(location?.type);
}

function getSalesWarehouseInventoryQty(inv, locationType) {
  if (!isSalesWarehouseLocation(locationType)) return 0;
  return getSalesInventoryQty(getInventoryQuantitySnapshot(inv, locationType));
}

function normalizeInventoryQuantityField(value) {
  return INVENTORY_QUANTITY_FIELDS.includes(String(value || '').trim())
    ? String(value).trim()
    : 'normal_qty';
}

function buildInventoryProductKeywordConditions(keyword, historicalSnProductIds = []) {
  const pattern = `%${String(keyword || '').trim()}%`;
  const conditions = [
    { name: { [Op.like]: pattern } },
    { product_code: { [Op.like]: pattern } },
    { config: { [Op.like]: pattern } },
    { manufacturer_code: { [Op.like]: pattern } },
    { remark: { [Op.like]: pattern } }
  ];
  if (historicalSnProductIds.length > 0) {
    conditions.push({ product_id: { [Op.in]: historicalSnProductIds } });
  }
  return conditions;
}

function getSnInventoryMoveFields(locationType, snInventoryType) {
  const primaryField = normalizeInventoryQuantityField(locationType || snInventoryType);
  const fields = [primaryField];
  if (primaryField !== 'normal_qty') {
    fields.push('normal_qty', 'regular_qty', 'subsidy_qty', 'second_qty');
  } else {
    fields.push('regular_qty', 'subsidy_qty', 'second_qty');
  }
  return [...new Set(fields)];
}

async function moveSnInventoryAggregate({ sn, storeId, oldLocationId, oldLocation, targetLocation, transaction }) {
  const targetLocationId = String(targetLocation?.location_id || '');
  const targetField = normalizeInventoryQuantityField(targetLocation?.type);
  const oldFieldCandidates = getSnInventoryMoveFields(oldLocation?.type, sn?.inventory_type);

  if (oldLocationId && oldLocationId !== targetLocationId) {
    const oldInventory = await Inventory.findOne({
      where: { product_id: sn.product_id, store_id: storeId, location_id: oldLocationId },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (oldInventory) {
      let remaining = 1;
      for (const field of oldFieldCandidates) {
        if (remaining <= 0) break;
        const current = Number(oldInventory[field] || 0);
        if (current <= 0) continue;
        const moved = Math.min(current, remaining);
        await oldInventory.update({ [field]: current - moved }, { transaction });
        remaining -= moved;
      }
    }
  }

  await updateInventory(sn.product_id, storeId, targetField, 1, transaction, targetLocationId);
  return targetField;
}

/**
 * 仓位类型是库存数量的实际归属维度。
 * 历史数据中存在库存记录已经绑定到不可售仓，但数量仍写在 normal_qty 的情况，
 * 这里按仓位类型归类，并兼容将 normal_qty 写错到非销售仓的旧记录。
 */
function getInventoryQuantitySnapshot(inv, locationType = '') {
  const normalQty = Number(inv.normal_qty || 0);
  const regularQty = Number(inv.regular_qty || 0);
  const subsidyQty = Number(inv.subsidy_qty || 0);
  const secondQty = Number(inv.second_qty || 0);
  const effectiveNormal = normalQty > 0 ? normalQty : regularQty + subsidyQty + secondQty;
  const snapshot = {
    normal_qty: effectiveNormal,
    regular_qty: regularQty,
    subsidy_qty: subsidyQty,
    second_qty: secondQty,
    display_qty: Number(inv.display_qty || 0),
    demo_qty: Number(inv.demo_qty || 0),
    unsellable_qty: Number(inv.unsellable_qty || 0),
    pending_qty: Number(inv.pending_qty || 0),
    rental_demo_qty: Number(inv.rental_demo_qty || 0)
  };

  const normalizedLocationType = String(locationType || '').trim();
  if (INVENTORY_QUANTITY_FIELDS.includes(normalizedLocationType) && normalizedLocationType !== 'normal_qty') {
    snapshot[normalizedLocationType] = Math.max(snapshot[normalizedLocationType], effectiveNormal);
    for (const field of INVENTORY_QUANTITY_FIELDS) {
      if (field !== normalizedLocationType) snapshot[field] = 0;
    }
    snapshot.regular_qty = 0;
    snapshot.subsidy_qty = 0;
    snapshot.second_qty = 0;
  }

  return snapshot;
}

/**
 * 将销售仓库存拆分为页面需要的三类资源数量。
 * 旧数据可能只有 normal_qty，没有资源明细，此时按全资源货兼容展示，确保分项之和不小于销售仓总量。
 */
function getSalesResourceQuantitySnapshot(inv, locationType = '') {
  const snapshot = getInventoryQuantitySnapshot(inv, locationType);
  const normalQty = Number(snapshot.normal_qty || 0);
  const regularQty = Number(snapshot.regular_qty || 0);
  const subsidyQty = Number(snapshot.subsidy_qty || 0);
  const secondQty = Number(snapshot.second_qty || 0);
  const detailTotal = regularQty + subsidyQty + secondQty;
  const totalQty = Math.max(normalQty, detailTotal);

  return {
    full_resource_qty: Math.max(regularQty, totalQty - subsidyQty - secondQty),
    subsidy_only_qty: subsidyQty,
    no_subsidy_qty: secondQty
  };
}

function getSnSalesResourceQuantitySnapshot(sn, summary) {
  const label = String(summary?.sales_resource_label || '');
  const available = String(summary?.available_resource_summary || '');
  const taxType = String(sn?.tax_type || '').toUpperCase();

  if (label === '全资源货') return { full_resource_qty: 1, subsidy_only_qty: 0, no_subsidy_qty: 0 };
  if (available.includes('国补')) return { full_resource_qty: 0, subsidy_only_qty: 1, no_subsidy_qty: 0 };
  if (taxType === 'UNTAXED' || label === '未税货') return { full_resource_qty: 0, subsidy_only_qty: 0, no_subsidy_qty: 1 };

  // 没有资源权益明细的历史 SN 默认按全资源货展示，保持与旧 normal_qty 统计一致。
  return { full_resource_qty: 1, subsidy_only_qty: 0, no_subsidy_qty: 0 };
}

async function buildSalesStockMap(productIds, storeId = '', scopedStoreIds = []) {
  const uniqueProductIds = [...new Set((productIds || []).filter(Boolean))];
  const stockMap = {};
  if (uniqueProductIds.length === 0) return stockMap;

  const inventoryWhere = { product_id: { [Op.in]: uniqueProductIds } };
  const visibleStoreIds = [...new Set((scopedStoreIds || []).map(String).filter(Boolean))];
  if (visibleStoreIds.length > 0) inventoryWhere.store_id = { [Op.in]: visibleStoreIds };
  const inventories = await Inventory.findAll({
    where: inventoryWhere,
    raw: true
  });
  const locationIds = [...new Set(inventories.map(inv => inv.location_id).filter(Boolean))];
  const locations = locationIds.length
    ? await Location.findAll({
        where: { location_id: { [Op.in]: locationIds } },
        attributes: ['location_id', 'type'],
        raw: true
      })
    : [];
  const locationTypeMap = new Map(locations.map(location => [location.location_id, location.type]));
  const storeIds = [...new Set(inventories.map(inv => inv.store_id).filter(Boolean))];
  const stores = storeIds.length
    ? await Store.findAll({ where: { store_id: { [Op.in]: storeIds } }, attributes: ['store_id', 'name'], raw: true })
    : [];
  const storeNameMap = new Map(stores.map(store => [store.store_id, store.name]));

  for (const inv of inventories) {
    const productId = inv.product_id;
    if (!stockMap[productId]) {
      stockMap[productId] = { current: 0, other: 0, total: 0, stores: [], currentStore: null, otherStores: [] };
    }

    const qty = getSalesWarehouseInventoryQty(inv, locationTypeMap.get(inv.location_id));
    if (qty <= 0) continue;

    const storeRow = {
      store_id: inv.store_id || '',
      store_name: storeNameMap.get(inv.store_id) || inv.store_id || '未知门店',
      normal_qty: qty,
      is_current: Boolean(storeId && inv.store_id === storeId)
    };

    stockMap[productId].stores.push(storeRow);
    stockMap[productId].total += qty;
    if (storeId && inv.store_id === storeId) {
      stockMap[productId].current += qty;
      stockMap[productId].currentStore = storeRow;
    } else {
      stockMap[productId].other += qty;
      stockMap[productId].otherStores.push(storeRow);
    }
  }

  return stockMap;
}

async function buildSalesCountMap(productIds, storeId = '', scopedStoreIds = []) {
  const uniqueProductIds = [...new Set((productIds || []).filter(Boolean))];
  const salesMap = {};
  if (uniqueProductIds.length === 0) return salesMap;

  const now = new Date();
  const date7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const date30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const salesStoreIds = storeId ? [storeId] : [...new Set((scopedStoreIds || []).filter(Boolean))];
  const storeCondition = salesStoreIds.length ? 'AND o.STORE_ID IN (:salesStoreIds)' : '';
  // Keep the sales quantity metrics at product-line level. A product can appear
  // in an order with several other products, so joining all order items here
  // would multiply the target product quantity by the number of order lines.
  const rows = await sequelize.query(
    `SELECT oi.PRODUCT_ID AS product_id,
            SUM(CASE WHEN o.CREATE_TIME >= :date7 THEN oi.QUANTITY ELSE 0 END) AS sales_7_qty,
            SUM(CASE WHEN o.CREATE_TIME >= :date30 THEN oi.QUANTITY ELSE 0 END) AS sales_30_qty,
            SUM(CASE WHEN o.CREATE_TIME >= :date7 THEN oi.SUBTOTAL ELSE 0 END) AS sales_7_amount,
            SUM(CASE WHEN o.CREATE_TIME >= :date7
                     THEN COALESCE(oi.SALES_GROSS_PROFIT, oi.SUBTOTAL - oi.SALES_SETTLEMENT_COST * oi.QUANTITY)
                     ELSE 0 END) AS gross_profit_7
       FROM T_ORDER_ITEM oi
       INNER JOIN T_ORDER o ON oi.ORDER_ID = o.ORDER_ID
      WHERE oi.PRODUCT_ID IN (:productIds)
        AND (o.ORDER_STATUS IS NULL OR o.ORDER_STATUS NOT IN ('cancelled', 'rejected'))
        ${storeCondition}
      GROUP BY oi.PRODUCT_ID`,
    {
      replacements: { productIds: uniqueProductIds, date7, date30, ...(salesStoreIds.length ? { salesStoreIds } : {}) },
      type: Sequelize.QueryTypes.SELECT
    }
  );

  // For high-margin ranking, associate each target product with its distinct
  // orders, then sum every product line in those orders. This makes the rank
  // reflect the total gross profit generated by the orders containing the
  // product, rather than only the product's own line profit.
  const orderGrossProfitRows = await sequelize.query(
    `SELECT order_totals.product_id,
            SUM(order_totals.order_sales_7_amount) AS order_sales_7_amount,
            SUM(order_totals.order_gross_profit_7) AS order_gross_profit_7,
            AVG(order_totals.order_gross_profit_7) AS avg_gross_profit_7,
            MAX(order_totals.order_gross_profit_7) AS max_gross_profit_7,
            COUNT(*) AS order_count_7
       FROM (
         SELECT target.PRODUCT_ID AS product_id,
                target.ORDER_ID AS order_id,
                SUM(all_items.SUBTOTAL) AS order_sales_7_amount,
                SUM(COALESCE(all_items.SALES_GROSS_PROFIT, all_items.SUBTOTAL - all_items.SALES_SETTLEMENT_COST * all_items.QUANTITY)) AS order_gross_profit_7
           FROM (
             SELECT DISTINCT oi.ORDER_ID, oi.PRODUCT_ID
               FROM T_ORDER_ITEM oi
              WHERE oi.PRODUCT_ID IN (:productIds)
           ) target
           INNER JOIN T_ORDER o ON target.ORDER_ID = o.ORDER_ID
           INNER JOIN T_ORDER_ITEM all_items ON all_items.ORDER_ID = o.ORDER_ID
          WHERE o.CREATE_TIME >= :date7
            AND (o.ORDER_STATUS IS NULL OR o.ORDER_STATUS NOT IN ('cancelled', 'rejected'))
            ${storeCondition}
          GROUP BY target.PRODUCT_ID, target.ORDER_ID
       ) order_totals
      GROUP BY order_totals.product_id`,
    {
      replacements: { productIds: uniqueProductIds, date7, ...(salesStoreIds.length ? { salesStoreIds } : {}) },
      type: Sequelize.QueryTypes.SELECT
    }
  );

  const orderGrossProfitMap = {};
  orderGrossProfitRows.forEach(row => {
    orderGrossProfitMap[row.product_id] = {
      sales_7_amount: Number(row.order_sales_7_amount || 0),
      gross_profit_7: Number(row.order_gross_profit_7 || 0),
      avg_gross_profit_7: Number(row.avg_gross_profit_7 || 0),
      max_gross_profit_7: Number(row.max_gross_profit_7 || 0),
      order_count_7: Number(row.order_count_7 || 0)
    };
  });

  rows.forEach(row => {
    const orderGrossProfit = orderGrossProfitMap[row.product_id];
    const sales7Amount = orderGrossProfit
      ? orderGrossProfit.sales_7_amount
      : Number(row.sales_7_amount || 0);
    const grossProfit7 = orderGrossProfit
      ? orderGrossProfit.gross_profit_7
      : Number(row.gross_profit_7 || 0);
    const orderCount7 = orderGrossProfit ? orderGrossProfit.order_count_7 : 0;
    salesMap[row.product_id] = {
      sales_7_qty: Number(row.sales_7_qty || 0),
      sales_30_qty: Number(row.sales_30_qty || 0),
      sales_7_amount: sales7Amount,
      gross_profit_7: grossProfit7,
      avg_gross_profit_7: orderGrossProfit
        ? orderGrossProfit.avg_gross_profit_7
        : (orderCount7 > 0 ? grossProfit7 / orderCount7 : 0),
      max_gross_profit_7: orderGrossProfit ? orderGrossProfit.max_gross_profit_7 : 0,
      gross_margin_7: sales7Amount > 0
        ? grossProfit7 / sales7Amount
        : 0
    };
  });
  return salesMap;
}

async function buildSpecialProductMap(productIds, distributorId, storeId = '', scopedStoreIds = []) {
  const uniqueProductIds = [...new Set((productIds || []).filter(Boolean))];
  const specialMap = {};
  const normalizedDistributorId = String(distributorId || '').trim();
  if (uniqueProductIds.length === 0 || !normalizedDistributorId) return specialMap;

  const specialStoreIds = storeId
    ? [storeId]
    : [...new Set((scopedStoreIds || []).map(String).filter(Boolean))];
  const storeCondition = specialStoreIds.length
    ? 'AND sn.STORE_ID IN (:specialStoreIds)'
    : '';
  const rows = await sequelize.query(
    `SELECT sn.PRODUCT_ID AS product_id,
            COUNT(DISTINCT sn.SN_ID) AS special_sn_count
       FROM T_PRODUCT_SN sn
       INNER JOIN T_SN_DISTRIBUTOR_PRICE sp ON sp.SN_ID = sn.SN_ID
                                            AND sp.DISTRIBUTOR_ID = :distributorId
                                            AND sp.STATUS = 1
                                            AND sp.SPECIAL_PRICE > 0
      WHERE sn.PRODUCT_ID IN (:productIds)
        AND sn.STATUS = 'in_stock'
        AND sn.IS_DELETED = 0
        ${storeCondition}
      GROUP BY sn.PRODUCT_ID`,
    {
      replacements: {
        productIds: uniqueProductIds,
        distributorId: normalizedDistributorId,
        ...(specialStoreIds.length ? { specialStoreIds } : {})
      },
      type: Sequelize.QueryTypes.SELECT
    }
  );

  rows.forEach(row => {
    specialMap[row.product_id] = Number(row.special_sn_count || 0);
  });
  return specialMap;
}

const INVENTORY_CATEGORY_KEYWORDS = {
  computer: ['电脑', '笔记本', '台式机', '一体机', '主机'],
  tablet: ['平板', 'pad', 'ipad'],
  phone: ['手机', 'iphone'],
  accessory: ['配件', '鼠标', '键盘', '手柄', '支架', '摄像头', '保护夹', '保护壳', '贴膜', '充电器', '耳机', '数据线', 'u盘', '杯', '包', '硬盘', '打印机', '内存', '膜']
};

function includesAny(text, keywords) {
  return keywords.some(keyword => text.includes(keyword));
}

function getInventoryCategoryRank(category, accessoryType, name, config) {
  const categoryText = String(category || '').toLowerCase();
  if (includesAny(categoryText, INVENTORY_CATEGORY_KEYWORDS.computer)) return 0;
  if (includesAny(categoryText, INVENTORY_CATEGORY_KEYWORDS.tablet)) return 1;
  if (includesAny(categoryText, INVENTORY_CATEGORY_KEYWORDS.phone)) return 2;
  if (includesAny(categoryText, INVENTORY_CATEGORY_KEYWORDS.accessory)) return 3;

  const accessoryText = String(accessoryType || '').toLowerCase();
  if (accessoryText) return 3;

  const text = [name, config].map(value => String(value || '')).join(' ').toLowerCase();
  if (includesAny(text, INVENTORY_CATEGORY_KEYWORDS.accessory)) return 3;
  if (includesAny(text, INVENTORY_CATEGORY_KEYWORDS.computer)) return 0;
  if (includesAny(text, INVENTORY_CATEGORY_KEYWORDS.tablet)) return 1;
  if (includesAny(text, INVENTORY_CATEGORY_KEYWORDS.phone)) return 2;
  return 4;
}

function getInventoryProductType(category, accessoryType, name, config) {
  const rank = getInventoryCategoryRank(category, accessoryType, name, config);
  if (rank === 0) return 'computer';
  if (rank === 1) return 'tablet';
  if (rank === 2) return 'phone';
  return '';
}

const INVENTORY_SUMMARY_CATEGORY_KEYWORDS = [
  ['笔记本', ['笔记本', 'laptop']],
  ['平板', ['平板', 'pad', 'ipad', 'tablet']],
  ['手机', ['手机', 'iphone', 'phone']],
  ['台机', ['台机', '台式机', '台式电脑', '一体机', '主机', 'desktop']],
  ['配件', ['配件']]
];

function getInventorySummaryCategoryRank(category) {
  const categoryText = String(category || '').toLowerCase();
  const matched = INVENTORY_SUMMARY_CATEGORY_KEYWORDS.find(([, keywords]) =>
    includesAny(categoryText, keywords)
  );
  return matched ? INVENTORY_SUMMARY_CATEGORY_KEYWORDS.indexOf(matched) : null;
}

function isSpecialPriceProduct(product) {
  const price = product?.ProductPrice || {};
  const standardPrice = Number(price.standard_price || 0);
  const retailPrice = Number(price.retail_price || 0);
  return standardPrice > 0 && retailPrice > 0 && retailPrice < standardPrice;
}

function matchesInventoryModelFilter(product, sales, modelFilter) {
  if (modelFilter === 'focus') return Number(product.is_focus_product || 0) === 1;
  if (modelFilter === 'special') return Number(sales.special_sn_count || 0) > 0;
  if (modelFilter === 'hot7') return Number(sales.sales_7_qty || 0) > 0;
  if (modelFilter === 'highMargin7') return Number(sales.avg_gross_profit_7 || 0) > 0;
  return true;
}

function compareInventoryModelRows(a, b, modelFilter) {
  if (modelFilter === 'hot7') {
    return Number(b.sales_7_qty || 0) - Number(a.sales_7_qty || 0);
  }
  if (modelFilter === 'highMargin7') {
    return Number(b.avg_gross_profit_7 || 0) - Number(a.avg_gross_profit_7 || 0)
      || Number(b.gross_profit_7 || 0) - Number(a.gross_profit_7 || 0);
  }
  if (modelFilter === 'special') {
    return Number(b.special_sn_count || 0) - Number(a.special_sn_count || 0);
  }
  if (modelFilter === 'focus') {
    return Number(b.sales_7_qty || 0) - Number(a.sales_7_qty || 0);
  }
  return 0;
}

function getSummaryNormalQty(product, inventory, stock) {
  return Number(product?.need_sn) === 1
    ? Number(stock?.total || 0)
    : Number(inventory?.normal_qty || 0);
}

const STORE_EXPORT_QUANTITY_FIELDS = [
  'normal_qty', 'display_qty', 'demo_qty', 'unsellable_qty', 'pending_qty', 'rental_demo_qty'
];

function buildStoreInventoryExportRows(productRows) {
  const rows = [];
  productRows.forEach((productRow, productIndex) => {
    const storeMap = new Map();
    (productRow.store_stock_info || []).forEach(item => {
      const storeId = String(item.store_id || item.store_name || '');
      if (!storeId) return;
      if (!storeMap.has(storeId)) {
        storeMap.set(storeId, {
          store_id: item.store_id || '',
          store_name: item.store_name || item.store_id || '',
          normal_qty: 0,
          regular_qty: 0,
          subsidy_qty: 0,
          second_qty: 0,
          display_qty: 0,
          demo_qty: 0,
          unsellable_qty: 0,
          pending_qty: 0,
          rental_demo_qty: 0
        });
      }
      const target = storeMap.get(storeId);
      target.normal_qty += Number(item.normal_qty || 0);
      target.regular_qty += Number(item.regular_qty ?? item.full_resource_qty ?? 0);
      target.subsidy_qty += Number(item.subsidy_qty ?? item.subsidy_only_qty ?? 0);
      target.second_qty += Number(item.second_qty ?? item.no_subsidy_qty ?? 0);
      STORE_EXPORT_QUANTITY_FIELDS.slice(1).forEach(field => {
        target[field] += Number(item[field] || 0);
      });
    });

    const storeRows = [...storeMap.values()];
    if (storeRows.length === 0) return;
    storeRows.forEach(store => {
      const totalStock = Number(productRow.total_stock_qty || 0);
      rows.push({
        ...productRow,
        store_id: store.store_id,
        store_name: store.store_name,
        normal_qty: store.normal_qty,
        regular_qty: store.regular_qty,
        subsidy_qty: store.subsidy_qty,
        second_qty: store.second_qty,
        display_qty: store.display_qty,
        demo_qty: store.demo_qty,
        unsellable_qty: store.unsellable_qty,
        pending_qty: store.pending_qty,
        rental_demo_qty: store.rental_demo_qty,
        current_store_stock_qty: store.normal_qty,
        other_store_stock_qty: Math.max(totalStock - store.normal_qty, 0),
        total_stock_qty: totalStock,
        _store_product_index: productIndex
      });
    });
  });
  return rows.sort((a, b) => String(a.store_name || '').localeCompare(String(b.store_name || ''), 'zh-Hans-CN')
    || Number(a._store_product_index || 0) - Number(b._store_product_index || 0));
}

function buildInventorySummaryExportRows(productRows, primaryPnMap = new Map()) {
  return [...productRows]
    .map(row => ({ row, categoryRank: getInventorySummaryCategoryRank(row.category) }))
    .filter(({ row, categoryRank }) => categoryRank !== null && Number(row.normal_qty || 0) > 0)
    .sort((a, b) => {
      if (a.categoryRank !== b.categoryRank) return a.categoryRank - b.categoryRank;
      return String(a.row.product_name || '').localeCompare(String(b.row.product_name || ''), 'zh-Hans-CN')
        || String(a.row.product_id || '').localeCompare(String(b.row.product_id || ''));
    })
    .map(({ row }) => row)
    .map(row => ({
      产品名称: row.product_name || '',
      PN: primaryPnMap.get(row.product_id) || '',
      定价: Number(row.standard_price || 0),
      库存: Number(row.normal_qty || 0)
    }));
}

/**
 * 库存聚合列表 - 按商品汇总，显示5种库存数量
 */
async function getList(ctx) {
  try {
    const {
      storeId, regionId, category, keyword, productType = '', modelFilter = '', page = 1, pageSize = 20
    } = ctx.query;
    const user = ctx.state.user;
    const exportMode = Boolean(ctx.state.inventoryExportMode);
    const summaryExportMode = Boolean(ctx.state.inventorySummaryExportMode);

    const transferScope = isTransferScope(ctx);

    // 调拨查询由请求链路的 scope=transfer 标记放行，允许读取被调拨门店的库存。
    // 实际出库仍在 confirmTransferOutPartial 中校验调拨单和调出门店，不能据此绕过写入权限。
    const whereStore = {};
    const readableStoreIds = transferScope
      ? (Array.isArray(user.accessibleStoreIds) ? user.accessibleStoreIds : [])
      : await resolveAllReadableStoreIds(user);
    if (!readableStoreIds.includes('*')) {
      whereStore.store_id = readableStoreIds.length ? readableStoreIds : '__NO_STORE__';
    }
    if (transferScope && storeId) {
      await assertTransferStoreScope(ctx, storeId);
      whereStore.store_id = storeId;
    } else if (storeId) {
      const allowedStoreIds = readableStoreIds.map(String);
      if (!readableStoreIds.includes('*') && !allowedStoreIds.includes(String(storeId))) {
        whereStore.store_id = '__NO_STORE__';
      } else {
        whereStore.store_id = storeId;
      }
    }
    if (regionId) whereStore.region_id = regionId;

    const stores = await Store.findAll({ where: whereStore });
    const storeIds = stores.map(s => s.store_id);

    const productWhere = { is_deleted: 0, status: 1 };
    if (category) productWhere.category = category;
    if (keyword) {
      const historicalSnRows = storeIds.length > 0
        ? await ProductSn.findAll({
          where: {
            pn_code: { [Op.like]: `%${String(keyword).trim()}%` },
            status: 'in_stock',
            is_deleted: 0,
            store_id: { [Op.in]: storeIds }
          },
          attributes: ['product_id'],
          group: ['product_id'],
          raw: true
        })
        : [];
      const historicalSnProductIds = historicalSnRows.map(row => row.product_id).filter(Boolean);
      productWhere[Op.or] = buildInventoryProductKeywordConditions(keyword, historicalSnProductIds);
    }

    const allProducts = await Product.findAll({
      where: productWhere,
      include: [{ model: ProductPrice, attributes: ['standard_price', 'retail_price', 'min_sale_price', 'cost_price'] }],
      order: [['create_time', 'DESC']]
    });

    const allProductIds = allProducts.map(p => p.product_id);
    const salesMap = await buildSalesCountMap(allProductIds, storeId, storeIds);
    const specialProductMap = await buildSpecialProductMap(
      allProductIds,
      user.distributorId,
      storeId,
      storeIds
    );
    const products = allProducts.filter(product => {
      if (productType && getInventoryProductType(product.category, product.accessory_type, product.name, product.config) !== productType) {
        return false;
      }
      return matchesInventoryModelFilter(product, {
        ...(salesMap[product.product_id] || {}),
        special_sn_count: specialProductMap[product.product_id] || 0
      }, modelFilter);
    });
    const count = products.length;
    const productIds = products.map(p => p.product_id);
    const allStockMap = await buildSalesStockMap(productIds, storeId, storeIds);

    const inventoryWhere = { product_id: { [Op.in]: productIds } };
    inventoryWhere.store_id = { [Op.in]: storeIds };

    const inventories = await Inventory.findAll({
      where: inventoryWhere,
      include: [{ model: Store, attributes: ['store_id', 'name'] }]
    });

    const allStoreMap = new Map();
    stores.forEach(s => allStoreMap.set(s.store_id, s.name));

    const locations = await Location.findAll({
      where: { store_id: { [Op.in]: storeIds }, status: 1 },
      raw: true
    });
    const locationMap = new Map();
    locations.forEach(loc => locationMap.set(loc.location_id, loc));

    const invMap = {};
    const storeStockMap = {};
    for (const inv of inventories) {
      if (!invMap[inv.product_id]) {
        invMap[inv.product_id] = {
          normal_qty: 0,
          regular_qty: 0,
          subsidy_qty: 0,
          second_qty: 0,
          display_qty: 0,
          demo_qty: 0,
          unsellable_qty: 0,
          pending_qty: 0,
          rental_demo_qty: 0
        };
        storeStockMap[inv.product_id] = [];
      }
      const locationId = inv.location_id || '';
      const location = locationId ? locationMap.get(locationId) : null;
      const stockSnapshot = getInventoryQuantitySnapshot(inv, location?.type);
      invMap[inv.product_id].regular_qty += stockSnapshot.regular_qty;
      invMap[inv.product_id].subsidy_qty += stockSnapshot.subsidy_qty;
      invMap[inv.product_id].second_qty += stockSnapshot.second_qty;
      invMap[inv.product_id].normal_qty += stockSnapshot.normal_qty;
      invMap[inv.product_id].display_qty += stockSnapshot.display_qty;
      invMap[inv.product_id].demo_qty += stockSnapshot.demo_qty;
      invMap[inv.product_id].unsellable_qty += stockSnapshot.unsellable_qty;
      invMap[inv.product_id].pending_qty += stockSnapshot.pending_qty;
      invMap[inv.product_id].rental_demo_qty += stockSnapshot.rental_demo_qty;

      const storeQtyRow = {
        normal_qty: stockSnapshot.normal_qty,
        ...getSalesResourceQuantitySnapshot(inv, location?.type),
        display_qty: stockSnapshot.display_qty,
        demo_qty: stockSnapshot.demo_qty,
        unsellable_qty: stockSnapshot.unsellable_qty,
        pending_qty: stockSnapshot.pending_qty,
        rental_demo_qty: stockSnapshot.rental_demo_qty
      };
      const hasStoreQty = Object.values(storeQtyRow).some(value => Number(value || 0) > 0);
      if (hasStoreQty) {
        const storeName = inv.Store?.name || allStoreMap.get(inv.store_id) || inv.store_id;
        storeStockMap[inv.product_id].push({
          store_id: inv.store_id,
          store_name: storeName,
          location_id: locationId,
          location_name: location?.name || (locationId || '未指定库位'),
          ...storeQtyRow
        });
      }
    }

    const snSalesStockMap = {};
    if (productIds.length > 0) {
      const snRows = await ProductSn.findAll({
        where: {
          product_id: { [Op.in]: productIds },
          status: 'in_stock',
          is_deleted: 0,
          store_id: { [Op.in]: storeIds }
        },
        attributes: ['sn_id', 'product_id', 'store_id', 'location_id', 'status', 'tax_type'],
        raw: true
      });
      const snResourceSummaryMap = snRows.length ? await summariesForSns(snRows) : new Map();
      const snLocationMap = {};
      for (const sn of snRows) {
        const location = sn.location_id ? locationMap.get(sn.location_id) : null;
        if (!isInStockSalesWarehouseSn(sn, location)) continue;

        if (!snSalesStockMap[sn.product_id]) {
          snSalesStockMap[sn.product_id] = {
            current: 0,
            other: 0,
            total: 0,
            stores: [],
            currentStore: null,
            otherStores: []
          };
        }
        const snStock = snSalesStockMap[sn.product_id];
        const storeRowKey = `${sn.store_id || ''}`;
        let stockStore = snStock.stores.find(row => String(row.store_id || '') === storeRowKey);
        if (!stockStore) {
          stockStore = {
            store_id: sn.store_id || '',
            store_name: allStoreMap.get(sn.store_id) || sn.store_id || '未知门店',
            normal_qty: 0,
            is_current: Boolean(storeId && sn.store_id === storeId)
          };
          snStock.stores.push(stockStore);
        }
        stockStore.normal_qty += 1;
        snStock.total += 1;
        if (storeId && sn.store_id === storeId) {
          snStock.current += 1;
          snStock.currentStore = stockStore;
        } else {
          snStock.other += 1;
          if (!snStock.otherStores.includes(stockStore)) snStock.otherStores.push(stockStore);
        }

        const key = `${sn.store_id || ''}|${sn.location_id || ''}`;
        if (!snLocationMap[sn.product_id]) snLocationMap[sn.product_id] = {};
        if (!snLocationMap[sn.product_id][key]) {
          snLocationMap[sn.product_id][key] = {
            store_id: sn.store_id || '',
            store_name: allStoreMap.get(sn.store_id) || sn.store_id || '未知门店',
            location_id: sn.location_id || '',
            location_name: location?.name || (sn.location_id || '未指定库位'),
            normal_qty: 0,
            full_resource_qty: 0,
            subsidy_only_qty: 0,
            no_subsidy_qty: 0,
            display_qty: 0,
            demo_qty: 0,
            unsellable_qty: 0,
            pending_qty: 0,
            rental_demo_qty: 0
          };
        }
        snLocationMap[sn.product_id][key].normal_qty += 1;
        const resourceQuantity = getSnSalesResourceQuantitySnapshot(sn, snResourceSummaryMap.get(sn.sn_id));
        snLocationMap[sn.product_id][key].full_resource_qty += resourceQuantity.full_resource_qty;
        snLocationMap[sn.product_id][key].subsidy_only_qty += resourceQuantity.subsidy_only_qty;
        snLocationMap[sn.product_id][key].no_subsidy_qty += resourceQuantity.no_subsidy_qty;
      }

      for (const [productId, rowsByLocation] of Object.entries(snLocationMap)) {
        const rows = Object.values(rowsByLocation);
        if (rows.length > 0) {
          storeStockMap[productId] = rows;
        }
      }
    }

    const sortedRows = products.map(p => {
      const inv = invMap[p.product_id] || {
        normal_qty: 0, regular_qty: 0, subsidy_qty: 0, second_qty: 0, display_qty: 0, demo_qty: 0, unsellable_qty: 0, pending_qty: 0, rental_demo_qty: 0
      };
      const stock = Number(p.need_sn) === 1
        ? (snSalesStockMap[p.product_id] || { current: 0, other: 0, total: 0, stores: [], otherStores: [] })
        : (allStockMap[p.product_id] || { current: 0, other: 0, total: 0, stores: [], otherStores: [] });
      const sales = salesMap[p.product_id] || {
        sales_7_qty: 0, sales_30_qty: 0, sales_7_amount: 0, gross_profit_7: 0, avg_gross_profit_7: 0, max_gross_profit_7: 0, gross_margin_7: 0
      };
      return {
        product_id: p.product_id,
        category: p.category || '',
        product_name: p.name || '',
        spec: p.config || '',
        product_code: p.product_code || '',
        manufacturer_code: p.manufacturer_code || '',
        standard_price: p.ProductPrice ? p.ProductPrice.standard_price : 0,
        retail_price: p.ProductPrice ? p.ProductPrice.retail_price : 0,
        min_sale_price: p.ProductPrice ? p.ProductPrice.min_sale_price : 0,
        cost_price: p.ProductPrice ? p.ProductPrice.cost_price : 0,
        need_sn: p.need_sn || 0,
        normal_qty: getSummaryNormalQty(p, inv, stock),
        regular_qty: inv.regular_qty,
        subsidy_qty: inv.subsidy_qty,
        second_qty: inv.second_qty,
        display_qty: inv.display_qty,
        demo_qty: inv.demo_qty,
        unsellable_qty: inv.unsellable_qty,
        pending_qty: inv.pending_qty,
        rental_demo_qty: inv.rental_demo_qty,
        current_store_stock_qty: stock.current,
        other_store_stock_qty: stock.other,
        total_stock_qty: stock.total,
        current_store_name: stock.currentStore?.store_name || '',
        store_stock_info: storeStockMap[p.product_id]?.length ? storeStockMap[p.product_id] : (stock.stores || []),
        other_store_stock_info: stock.otherStores || [],
        sales_7_qty: sales.sales_7_qty,
        sales_30_qty: sales.sales_30_qty,
        sales_7_amount: sales.sales_7_amount,
        gross_profit_7: sales.gross_profit_7,
        avg_gross_profit_7: sales.avg_gross_profit_7,
        max_gross_profit_7: sales.max_gross_profit_7,
        gross_margin_7: sales.gross_margin_7,
        special_sn_count: specialProductMap[p.product_id] || 0,
        _category_rank: getInventoryCategoryRank(p.category, p.accessory_type, p.name, p.config),
        _create_time: p.create_time
      };
    }).sort((a, b) => {
      const modelCompare = compareInventoryModelRows(a, b, modelFilter);
      if (modelCompare !== 0) return modelCompare;
      const aHasStock = Number(a.normal_qty || 0) > 0 ? 0 : 1;
      const bHasStock = Number(b.normal_qty || 0) > 0 ? 0 : 1;
      if (aHasStock !== bHasStock) return aHasStock - bHasStock;
      if (a._category_rank !== b._category_rank) return a._category_rank - b._category_rank;
      return new Date(b._create_time || 0).getTime() - new Date(a._create_time || 0).getTime();
    });

    const exportRows = sortedRows.map(({ _category_rank, _create_time, ...row }) => row);

    if (summaryExportMode) {
      const primaryPnRows = exportRows.length > 0
        ? await ProductPn.findAll({
          where: {
            product_id: { [Op.in]: exportRows.map(row => row.product_id) },
            is_primary: 1,
            status: 1,
            is_deleted: 0
          },
          attributes: ['product_id', 'pn_code', 'pn_id'],
          order: [['pn_id', 'ASC']],
          raw: true
        })
        : [];
      const primaryPnMap = new Map();
      primaryPnRows.forEach(row => {
        if (!primaryPnMap.has(row.product_id)) primaryPnMap.set(row.product_id, row.pn_code || '');
      });
      const data = buildInventorySummaryExportRows(exportRows, primaryPnMap);
      sendExcel(ctx, data, ['产品名称', 'PN', '定价', '库存'],
        `库存简表_${new Date().toISOString().slice(0, 10)}.xlsx`, '库存简表');
      return;
    }

    if (exportMode) {
      const storeExportRows = buildStoreInventoryExportRows(exportRows);
      const data = storeExportRows.map(row => ({
        门店: row.store_name || '',
        类别: row.category || '',
        商品名称: row.product_name || '',
        产品配置: row.spec || '',
        商品编码: row.product_code || '',
        厂商编码: row.manufacturer_code || '',
        销售定价: Number(row.standard_price || 0),
        现有库存: Number(row.normal_qty || 0),
        正规货: Number(row.regular_qty || 0),
        国补货: Number(row.subsidy_qty || 0),
        纯二手货: Number(row.second_qty || 0),
        铺货仓库存: Number(row.display_qty || 0),
        样品仓库存: Number(row.demo_qty || 0),
        不可售库存: Number(row.unsellable_qty || 0),
        占用仓库存: Number(row.pending_qty || 0),
        租赁样机仓库存: Number(row.rental_demo_qty || 0),
        当前门店库存: Number(row.current_store_stock_qty || 0),
        其他门店库存: Number(row.other_store_stock_qty || 0),
        总库存: Number(row.total_stock_qty || 0),
        近7天销量: Number(row.sales_7_qty || 0),
        近30天销量: Number(row.sales_30_qty || 0)
      }));
      sendExcel(ctx, data, [
        '门店', '类别', '商品名称', '产品配置', '商品编码', '厂商编码', '销售定价',
        '现有库存', '正规货', '国补货', '纯二手货', '铺货仓库存', '样品仓库存',
        '不可售库存', '占用仓库存', '租赁样机仓库存', '当前门店库存', '其他门店库存', '总库存',
        '近7天销量', '近30天销量'
      ], `库存汇总_${new Date().toISOString().slice(0, 10)}.xlsx`, '库存汇总');
      return;
    }

    const currentPage = Math.max(Number(page) || 1, 1);
    const currentPageSize = Math.max(Number(pageSize) || 20, 1);
    const rows = exportRows.slice((currentPage - 1) * currentPageSize, currentPage * currentPageSize);

    ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
  } catch (error) {
    console.error('Error in getList:', error);
    throw error;
  }
}

async function exportList(ctx) {
  ctx.state.inventoryExportMode = true;
  return getList(ctx);
}

async function exportSummaryList(ctx) {
  ctx.state.inventorySummaryExportMode = true;
  return getList(ctx);
}

async function exportSnInventoryList(ctx) {
  ctx.state.inventoryExportMode = true;
  return getSnInventoryList(ctx);
}

/**
 * 查看序列号 - 仅用于需要SN管理的商品
 */
async function getSnList(ctx) {
  try {
    const { productId, storeId, currentStoreId, status, snCode, page = 1, pageSize = 20 } = ctx.query;
    const user = ctx.state.user;

    // 调拨出库需要读取调出门店的 SN，不应再次套用账号的普通门店查询权限。
    const where = { is_deleted: 0 };
    if (productId) where.product_id = productId;

    if (isTransferScope(ctx) && storeId) {
      await assertTransferStoreScope(ctx, storeId);
      where.store_id = storeId;
    } else if (storeId) {
      const readableStoreIds = await resolveAllReadableStoreIds(user);
      const allowedStoreIds = readableStoreIds.map(String);
      where.store_id = !readableStoreIds.includes('*') && !allowedStoreIds.includes(String(storeId))
        ? '__NO_STORE__'
        : storeId;
    } else {
      const readableStoreIds = await resolveAllReadableStoreIds(user);
      const whereStore = {};
      if (!readableStoreIds.includes('*')) whereStore.store_id = readableStoreIds;
      const stores = await Store.findAll({ where: whereStore });
      const storeIds = stores.map(s => s.store_id);
      where.store_id = { [Op.in]: storeIds };
    }

    if (status) where.status = status;
    if (snCode) where.sn_code = { [Op.like]: `%${snCode}%` };

    const { count, rows } = await ProductSn.findAndCountAll({
      where,
      order: [
        [sequelize.literal("CASE WHEN `ProductSn`.`status` = 'in_stock' THEN 0 ELSE 1 END"), 'ASC'],
        [sequelize.literal('CASE WHEN COALESCE(`ProductSn`.`original_inbound_time`, `ProductSn`.`inbound_time`) IS NULL THEN 1 ELSE 0 END'), 'ASC'],
        [sequelize.literal("CASE WHEN `ProductSn`.`status` = 'in_stock' THEN COALESCE(`ProductSn`.`original_inbound_time`, `ProductSn`.`inbound_time`) END"), 'ASC'],
        [sequelize.literal("CASE WHEN `ProductSn`.`status` <> 'in_stock' THEN COALESCE(`ProductSn`.`original_inbound_time`, `ProductSn`.`inbound_time`) END"), 'DESC'],
        [sequelize.literal('`ProductSn`.`sn_id`'), 'DESC']
      ],
      ...paginate({}, { page, pageSize })
    });

    const productIds = [...new Set(rows.map(row => row.product_id).filter(Boolean))];
    const storeIds = [...new Set(rows.map(row => row.store_id).filter(Boolean))];
    const locationIds = [...new Set(rows.map(row => row.location_id).filter(Boolean))];
    const [products, stores, locations] = await Promise.all([
      productIds.length
        ? Product.findAll({
          where: { product_id: { [Op.in]: productIds } },
          attributes: ['product_id', 'name', 'category', 'config', 'brand', 'series', 'model', 'need_sn'],
          include: [{ model: ProductPrice, attributes: ['standard_price', 'retail_price', 'min_sale_price'] }]
        })
        : [],
      storeIds.length
        ? Store.findAll({ where: { store_id: { [Op.in]: storeIds } }, attributes: ['store_id', 'name', 'region_id'] })
        : [],
      locationIds.length
        ? Location.findAll({ where: { location_id: { [Op.in]: locationIds } }, attributes: ['location_id', 'name'] })
        : []
    ]);
    const productMap = new Map(products.map(product => [String(product.product_id), product]));
    const storeMap = new Map(stores.map(store => [String(store.store_id), store]));
    const locationMap = new Map(locations.map(location => [String(location.location_id), location]));
    rows.forEach(sn => {
      sn.dataValues.Product = productMap.get(String(sn.product_id)) || null;
      sn.dataValues.Store = storeMap.get(String(sn.store_id)) || null;
      sn.dataValues.Location = locationMap.get(String(sn.location_id)) || null;
    });

    const stockMap = await buildSalesStockMap(productIds, currentStoreId || storeId || '');
    const salesMap = await buildSalesCountMap(productIds);

    const flatRows = rows.map(row => {
      const data = row.toJSON();
      const price = data.Product?.ProductPrice || {};
      const stock = stockMap[data.product_id] || { current: 0, other: 0, total: 0 };
      const sales = salesMap[data.product_id] || { sales_7_qty: 0, sales_30_qty: 0 };
      const originalInboundTime = resolveOriginalInboundTime(data.original_inbound_time, data.inbound_time);
      const statusChangeTime = data.update_time || data.inbound_time || null;
      return {
        ...data,
        original_inbound_time: originalInboundTime,
        inbound_time: originalInboundTime,
        status_change_time: statusChangeTime,
        status_duration_days: calculateStockAgeDays(statusChangeTime),
        stock_age_days: calculateStockAgeDays(originalInboundTime),
        status_label: getSnStatusLabel(data.status),
        statusText: getSnStatusLabel(data.status),
        product_name: data.Product?.name || '',
        name: data.Product?.name || '',
        category: data.Product?.category || '',
        config: data.Product?.config || '',
        spec: data.Product?.config || '',
        brand: data.Product?.brand || '',
        series: data.Product?.series || '',
        model: data.Product?.model || '',
        standard_price: price.standard_price || 0,
        retail_price: price.retail_price || 0,
        min_sale_price: price.min_sale_price || 0,
        settlement_price: price.retail_price || price.standard_price || 0,
        need_sn: data.Product?.need_sn || 0,
        current_store_stock_qty: stock.current,
        other_store_stock_qty: stock.other,
        total_stock_qty: stock.total,
        current_store_name: stock.currentStore?.store_name || '',
        store_stock_info: stock.stores || [],
        other_store_stock_info: stock.otherStores || [],
        sales_7_qty: sales.sales_7_qty,
        sales_30_qty: sales.sales_30_qty,
        stock_qty: currentStoreId || storeId ? stock.current : stock.total,
        stock_rank: stock.current > 0 ? 0 : (stock.total > 0 ? 1 : 2),
        store_name: data.Store?.name || '',
        location_name: data.Location?.name || '未指定库位'
      };
    });

    ctx.body = formatPaginatedResult(flatRows, { page, pageSize, count });
  } catch (error) {
    console.error('Error in getSnList:', error);
    throw error;
  }
}

async function updateSn(ctx) {
  ctx.throw(409, 'SN码不能直接修改，请先发起SN修改申请并等待admin或boss审批');
  /*
   * 保留旧实现仅用于兼容历史代码引用；正式入口已经迁移到
   * POST /inventory/sn-change-applications，不能绕过审批直接写入SN。
   */
  try {
    const { snId } = ctx.params;
    const { newSnCode } = ctx.request.body;
    const user = ctx.state?.staff || {};

    if (!newSnCode || newSnCode.trim() === '') {
      ctx.throw(400, '新SN码不能为空');
    }

    const sn = await ProductSn.findByPk(snId);
    if (!sn) {
      ctx.throw(404, 'SN记录不存在');
    }

    const exists = await ProductSn.findOne({
      where: {
        pn_code: sn.pn_code || '',
        sn_code: newSnCode.trim(),
        is_deleted: 0
      }
    });
    if (exists && exists.sn_id !== snId) {
      ctx.throw(400, `SN码 [${newSnCode}] 已被使用`);
    }

    const oldSnCode = sn.sn_code;

    await SnLog.create({
      log_id: generateUUID(),
      sn_id: snId,
      sn_code: newSnCode.trim(),
      old_sn_code: oldSnCode,
      product_id: sn.product_id,
      product_name: sn.product_name || '',
      store_id: sn.store_id,
      action: 'modify_sn',
      remark: `SN码由 ${oldSnCode} 修改为 ${newSnCode.trim()}`,
      create_user: user.name || user.phone || '-'
    });

    await sn.update({ sn_code: newSnCode.trim() });

    ctx.body = { code: 0, message: 'SN码修改成功' };
  } catch (err) {
    if (err.status) ctx.throw(err.status, err.message);
    console.error('updateSn error:', err);
    ctx.throw(500, '修改SN失败');
  }
}

function validateSnLocationAdjustment({ sn, storeId, locationId, targetLocation }) {
  if (!storeId) return { status: 400, message: '门店不能为空' };
  if (!locationId) return { status: 400, message: '目标库位不能为空' };
  if (!sn) return { status: 404, message: 'SN记录不存在' };
  if (String(sn.store_id || '') !== String(storeId)) {
    return { status: 403, message: '只能调整SN所在门店的库位' };
  }
  if (sn.status !== 'in_stock') {
    return { status: 409, message: '只有在库SN可以调整库位' };
  }
  if (!targetLocation) {
    return { status: 400, message: '目标库位不存在、已停用或不属于当前门店' };
  }
  return null;
}

/**
 * 同门店调整 SN 库位。
 * 只变更库位，不改变门店、库存数量或 SN 状态。
 */
async function adjustSnLocation(ctx) {
  const t = await sequelize.transaction();
  try {
    const { snId } = ctx.params;
    const body = ctx.request.body || {};
    const storeId = String(body.storeId || body.store_id || '').trim();
    const locationId = String(body.locationId || body.location_id || '').trim();
    const user = ctx.state.user || ctx.state.staff || {};

    if (!storeId) ctx.throw(400, '门店不能为空');
    if (!locationId) ctx.throw(400, '目标库位不能为空');
    assertStoreVisible(ctx, storeId);

    const sn = await ProductSn.findOne({
      where: { sn_id: snId, is_deleted: 0 },
      transaction: t,
      lock: t.LOCK.UPDATE
    });
    const targetLocation = await Location.findOne({
      where: { location_id: locationId, store_id: storeId, status: 1 },
      transaction: t
    });
    const validationError = validateSnLocationAdjustment({ sn, storeId, locationId, targetLocation });
    if (validationError) ctx.throw(validationError.status, validationError.message);

    const oldLocationId = String(sn.location_id || '');
    if (oldLocationId === locationId) {
      await t.commit();
      ctx.body = { code: 0, message: 'SN已在目标库位，无需调整' };
      return;
    }

    const oldLocation = oldLocationId
      ? await Location.findOne({
          where: { location_id: oldLocationId, store_id: storeId },
          transaction: t
        })
      : null;

    const targetInventoryType = await moveSnInventoryAggregate({
      sn,
      storeId,
      oldLocationId,
      oldLocation,
      targetLocation,
      transaction: t
    });
    await sn.update({ location_id: locationId, inventory_type: targetInventoryType }, { transaction: t });
    await SnLog.create({
      log_id: generateUUID(),
      sn_id: sn.sn_id,
      sn_code: sn.sn_code,
      product_id: sn.product_id,
      product_name: sn.product_name || '',
      store_id: storeId,
      action: 'location_adjust',
      remark: `同门店库位调整：${oldLocation?.name || '未指定库位'} → ${targetLocation.name}`,
      create_user: user.name || user.staffId || user.phone || '-'
    }, { transaction: t });

    await t.commit();
    ctx.body = {
      code: 0,
      data: {
        snId: sn.sn_id,
        storeId,
        locationId,
        locationName: targetLocation.name
      },
      message: '库位调整成功'
    };
  } catch (err) {
    await t.rollback();
    if (err.status) ctx.throw(err.status, err.message);
    console.error('adjustSnLocation error:', err);
    ctx.throw(500, '调整库位失败');
  }
}

/**
 * SN 生命周期追踪。
 * 以 T_PRODUCT_SN 为当前事实记录，再用 SN_ID 和当前/历史 SN_CODE 关联业务明细。
 * 这样可以兼容旧数据中入库明细未回写 SN_ID、以及 SN 修改后的历史单据。
 */
async function snTrace(ctx) {
  try {
    const requestedSnCode = String(ctx.params.snCode || '').trim();
    const requestedPnCode = String(ctx.query.pnCode || '').trim();
    if (!requestedSnCode) ctx.throw(400, 'SN码不能为空');

    const timeline = [];
    const timelineKeys = new Set();
    const initiatorByReference = new Map();
    const traceUser = ctx.state.user || {};
    const emptyFilterValue = '__sn_trace_empty__';
    const uniqueValues = values => [...new Set((values || [])
      .filter(value => value !== null && value !== undefined && String(value).trim() !== '')
      .map(value => String(value).trim()))];
    const toHex = value => Buffer.from(String(value), 'utf8').toString('hex').toUpperCase();
    const snMatch = (alias, snIdColumn, snCodeColumn) =>
      `(BINARY HEX(CAST(${alias}.${snIdColumn} AS BINARY)) IN (:snIdsHex) OR BINARY HEX(CAST(TRIM(${alias}.${snCodeColumn}) AS BINARY)) IN (:snCodesHex))`;
    const replacementsFor = (snIds, snCodes) => ({
      snIdsHex: (snIds.length ? snIds : [emptyFilterValue]).map(toHex),
      snCodesHex: (snCodes.length ? snCodes : [requestedSnCode]).map(toHex)
    });

    const appendReferenceEvent = (event, reference, options = {}) => {
      const canView = options.dealerOnly
        ? isDealerTraceAccount(traceUser) && canViewSnTraceReference(traceUser, reference)
        : canViewSnTraceReference(traceUser, reference);
      if (!canView) return;
      const key = `${event.type}:${reference.ref_id}`;
      if (timelineKeys.has(key)) return;
      timelineKeys.add(key);
      timeline.push({ ...event, ref_type: reference.ref_type, ref_no: reference.ref_no,
        ref_id: reference.ref_id, can_view_order: true });
    };

    const initialLogs = await sequelize.query(
      `SELECT sn_id, sn_code, old_sn_code
       FROM T_SN_LOG
       WHERE BINARY HEX(CAST(TRIM(sn_code) AS BINARY)) = BINARY :snCodeHex
          OR BINARY HEX(CAST(TRIM(old_sn_code) AS BINARY)) = BINARY :snCodeHex`,
      { replacements: { snCodeHex: toHex(requestedSnCode) }, type: sequelize.QueryTypes.SELECT }
    );
    const initialSnIds = uniqueValues(initialLogs.map(row => row.sn_id));
    const initialSnCodes = uniqueValues([
      requestedSnCode,
      ...initialLogs.flatMap(row => [row.sn_code, row.old_sn_code])
    ]);

    const snRows = await sequelize.query(
      `SELECT sn.SN_ID AS sn_id, sn.SN_CODE AS sn_code, sn.PN_CODE AS pn_code,
              sn.PRODUCT_ID AS product_id, sn.STATUS AS status, sn.STORE_ID AS store_id,
              sn.INBOUND_TIME AS inbound_time, p.NAME AS product_name, st.NAME AS store_name
       FROM T_PRODUCT_SN sn
       LEFT JOIN T_PRODUCT p ON p.PRODUCT_ID = sn.PRODUCT_ID
       LEFT JOIN T_STORE st ON st.STORE_ID = sn.STORE_ID
       WHERE sn.IS_DELETED = 0
         AND ${snMatch('sn', 'SN_ID', 'SN_CODE')}
         ${requestedPnCode ? 'AND TRIM(sn.PN_CODE) = :pnCode' : ''}
       ORDER BY (sn.STATUS = 'in_stock') DESC, sn.INBOUND_TIME DESC, sn.SN_ID DESC`,
      {
        replacements: {
          ...replacementsFor(initialSnIds, initialSnCodes),
          ...(requestedPnCode ? { pnCode: requestedPnCode } : {})
        },
        type: sequelize.QueryTypes.SELECT
      }
    );

    const snIds = uniqueValues([...initialSnIds, ...snRows.map(row => row.sn_id)]);
    const snCodes = uniqueValues([...initialSnCodes, ...snRows.map(row => row.sn_code)]);
    const replacements = replacementsFor(snIds, snCodes);

    const traces = await sequelize.query(
      `SELECT log_id, sn_id, sn_code, old_sn_code, action, remark, create_user, create_time
       FROM T_SN_LOG
       WHERE ${snMatch('T_SN_LOG', 'sn_id', 'sn_code')}
          OR BINARY HEX(CAST(TRIM(old_sn_code) AS BINARY)) IN (:snCodesHex)
       ORDER BY create_time ASC`,
      { replacements, type: sequelize.QueryTypes.SELECT }
    );
    for (const row of traces) {
      timeline.push({
        id: row.log_id,
        type: row.action,
        label: row.action === 'modify_sn' ? '\u5e8f\u5217\u53f7\u4fee\u6539' : row.action,
        description: row.remark || '',
        user: row.create_user || '-',
        time: row.create_time,
        oldSnCode: row.old_sn_code || null,
        _snLog: true
      });
    }

    const inboundItems = await sequelize.query(
      `SELECT ii.sn_id, ii.sn_code, ii.pn_code, i.inbound_no, i.inbound_id,
              i.store_id, i.purchase_request_id, i.source_type, i.source_no,
              s.distributor_id, i.create_time, i.create_user, i.receive_time
       FROM T_INBOUND_ITEM ii
        JOIN T_INBOUND i ON BINARY ii.inbound_id = BINARY i.inbound_id
        LEFT JOIN T_STORE s ON BINARY i.store_id = BINARY s.store_id
       WHERE ${snMatch('ii', 'sn_id', 'sn_code')}`,
      { replacements, type: sequelize.QueryTypes.SELECT }
    );

    const purchaseRequestIds = uniqueValues(inboundItems.map(row => row.purchase_request_id));
    const purchaseRequestNos = uniqueValues(inboundItems
      .filter(row => !row.purchase_request_id && row.source_type === 'purchase')
      .map(row => row.source_no));
    const purchaseRequests = purchaseRequestIds.length || purchaseRequestNos.length
      ? await sequelize.query(
          `SELECT pr.request_id, pr.request_no, pr.store_id, pr.apply_user,
                  s.distributor_id, pr.create_time
           FROM T_PURCHASE_REQUEST pr
           LEFT JOIN T_STORE s ON BINARY pr.store_id = BINARY s.store_id
           WHERE BINARY pr.request_id IN (:purchaseRequestIds)
              OR BINARY pr.request_no IN (:purchaseRequestNos)`,
          {
            replacements: {
              purchaseRequestIds: purchaseRequestIds.length ? purchaseRequestIds : [emptyFilterValue],
              purchaseRequestNos: purchaseRequestNos.length ? purchaseRequestNos : [emptyFilterValue]
            },
            type: sequelize.QueryTypes.SELECT
          }
        )
      : [];
    const purchaseRequestMap = new Map();
    purchaseRequests.forEach(row => {
      purchaseRequestMap.set(`id:${row.request_id}`, row);
      purchaseRequestMap.set(`no:${row.request_no}`, row);
    });

    const salesReturnNos = uniqueValues(inboundItems
      .filter(row => String(row.source_type || '').toLowerCase() === 'sales_return')
      .map(row => row.source_no));
    const salesReturnRequests = salesReturnNos.length
      ? await sequelize.query(
          `SELECT return_id, return_no, create_user, create_time
           FROM T_SALES_RETURN_REQUEST
           WHERE BINARY return_no IN (:salesReturnNos)`,
          { replacements: { salesReturnNos }, type: sequelize.QueryTypes.SELECT }
        )
      : [];
    const salesReturnMap = new Map(salesReturnRequests.map(row => [String(row.return_no), row]));

    for (const inbound of inboundItems) {
      const request = purchaseRequestMap.get(`id:${inbound.purchase_request_id}`)
        || purchaseRequestMap.get(`no:${inbound.source_no}`);
      const salesReturnRequest = salesReturnMap.get(String(inbound.source_no || ''));
      const initiator = resolveInboundInitiator(inbound, request, salesReturnRequest);
      if (inbound.inbound_no) initiatorByReference.set(String(inbound.inbound_no), initiator);
      if (inbound.source_no) initiatorByReference.set(String(inbound.source_no), initiator);
      appendReferenceEvent({
        id: `inbound-${inbound.inbound_id}`,
        type: 'inbound',
        label: '\u5165\u5e93',
        description: `\u5165\u5e93\u5355\u53f7: ${inbound.inbound_no}${inbound.pn_code ? `; PN: ${inbound.pn_code}` : ''}`,
        user: initiator,
        time: inbound.receive_time || inbound.create_time
      }, {
        ref_type: 'inbound', ref_no: inbound.inbound_no, ref_id: inbound.inbound_id,
        store_id: inbound.store_id, distributor_id: inbound.distributor_id,
        creator_names: [initiator]
      }, { dealerOnly: true });

      if (request) {
        const requestInitiator = purchaseInitiatorName(request) || initiator;
        initiatorByReference.set(String(request.request_no), requestInitiator);
        appendReferenceEvent({
          id: `purchase-${request.request_id}`,
          type: 'purchase',
          label: '\u91c7\u8d2d\u7533\u8bf7',
          description: `\u91c7\u8d2d\u7533\u8bf7\u5355\u53f7: ${request.request_no}`,
          user: requestInitiator,
          time: request.create_time || inbound.create_time
        }, {
          ref_type: 'purchase_request', ref_no: request.request_no, ref_id: request.request_id,
          store_id: request.store_id, distributor_id: request.distributor_id,
          creator_names: [requestInitiator]
        });
      }
    }

    const orderItems = await sequelize.query(
      `SELECT oi.order_id AS item_order_id, oi.sn_id, oi.sn_code, o.order_no, o.order_id,
              o.store_id, s.distributor_id, o.create_time, o.create_user
       FROM T_ORDER_ITEM oi
       JOIN T_ORDER o ON BINARY oi.order_id = BINARY o.order_id
       LEFT JOIN T_STORE s ON BINARY o.store_id = BINARY s.store_id
       WHERE ${snMatch('oi', 'sn_id', 'sn_code')}`,
      { replacements, type: sequelize.QueryTypes.SELECT }
    );
    for (const order of orderItems) {
      const initiator = String(order.create_user || '').trim() || '-';
      if (order.order_no) initiatorByReference.set(String(order.order_no), initiator);
      appendReferenceEvent({
        id: `sale-${order.order_id}`, type: 'sale', label: '\u5df2\u9500\u552e',
        description: `\u9500\u552e\u8ba2\u5355\u53f7: ${order.order_no}`,
        user: initiator, time: order.create_time
      }, {
        ref_type: 'sales_order', ref_no: order.order_no, ref_id: order.order_id,
        store_id: order.store_id, distributor_id: order.distributor_id,
        creator_names: [initiator]
      });
    }

    const returnItems = await sequelize.query(
      `SELECT ri.sn_id, ri.sn_code, rs.return_no, rs.return_id, rs.store_id,
              s.distributor_id, rs.create_time, rs.create_user
       FROM T_RETURN_STOCK_ITEM ri
       JOIN T_RETURN_STOCK rs ON BINARY ri.return_id = BINARY rs.return_id
       LEFT JOIN T_STORE s ON BINARY rs.store_id = BINARY s.store_id
       WHERE ${snMatch('ri', 'sn_id', 'sn_code')}`,
      { replacements, type: sequelize.QueryTypes.SELECT }
    );
    for (const row of returnItems) {
      const initiator = String(row.create_user || '').trim() || '-';
      if (row.return_no) initiatorByReference.set(String(row.return_no), initiator);
      appendReferenceEvent({
        id: `return-${row.return_id}`, type: 'return', label: '\u9000\u5e93',
        description: `\u9000\u5e93\u5355\u53f7: ${row.return_no}`,
        user: initiator, time: row.create_time
      }, {
        ref_type: 'return_stock', ref_no: row.return_no, ref_id: row.return_id,
        store_id: row.store_id, distributor_id: row.distributor_id,
        creator_names: [initiator]
      });
    }

    const transferItems = await sequelize.query(
      `SELECT ti.sn_id, ti.sn_code, t.transfer_no, t.transfer_id, t.from_store_id,
              t.to_store_id, fs.name AS from_store_name, ts.name AS to_store_name,
              COALESCE(t.distributor_id, fs.distributor_id, ts.distributor_id) AS distributor_id,
              t.apply_user, t.create_time, t.status AS transfer_status
       FROM T_TRANSFER_ITEM ti
       JOIN T_TRANSFER t ON BINARY ti.transfer_id = BINARY t.transfer_id
       LEFT JOIN T_STORE fs ON BINARY t.from_store_id = BINARY fs.store_id
       LEFT JOIN T_STORE ts ON BINARY t.to_store_id = BINARY ts.store_id
       WHERE ${snMatch('ti', 'sn_id', 'sn_code')}`,
      { replacements, type: sequelize.QueryTypes.SELECT }
    );
    for (const row of transferItems) {
      const initiator = String(row.apply_user || '').trim() || '-';
      if (row.transfer_no) initiatorByReference.set(String(row.transfer_no), initiator);
      appendReferenceEvent({
        id: `transfer-${row.transfer_id}`, type: 'transfer', label: '\u8c03\u62e8',
        description: `${row.from_store_name || row.from_store_id} -> ${row.to_store_name || row.to_store_id}; \u5355\u53f7: ${row.transfer_no}`,
        user: initiator, time: row.create_time
      }, {
        ref_type: 'transfer_order', ref_no: row.transfer_no, ref_id: row.transfer_id,
        from_store_id: row.from_store_id, to_store_id: row.to_store_id,
        distributor_id: row.distributor_id, creator_names: [initiator]
      });
    }

    timeline.forEach(event => {
      if (!event._snLog) return;
      event.user = resolveSnTraceLogUser(event, initiatorByReference);
      delete event._snLog;
    });

    const snData = snRows[0] || null;
    if (snData && !inboundItems.length && snData.inbound_time) {
      timeline.push({
        id: `sn-record-${snData.sn_id}`,
        type: 'stock_record',
        label: '\u5df2\u5f52\u6863',
        description: `PN: ${snData.pn_code || '-'}; \u8bb0\u5f55\u65f6\u95f4: ${snData.inbound_time}`,
        user: '-', time: snData.inbound_time
      });
    }
    timeline.sort((a, b) => new Date(b.time) - new Date(a.time));

    ctx.body = {
      code: 0,
      data: {
        snCode: requestedSnCode,
        currentStatus: snData ? snData.status : 'unknown',
        currentStatusLabel: snData ? getSnStatusLabel(snData.status) : '未知',
        productId: snData?.product_id || '',
        productName: snData?.product_name || '',
        pnCode: snData?.pn_code || '',
        storeId: snData?.store_id || '',
        storeName: snData?.store_name || '',
        timeline
      }
    };
  } catch (err) {
    if (err.status) ctx.throw(err.status, err.message);
    console.error('snTrace error:', err);
    ctx.throw(500, '查询SN追踪记录失败');
  }
}

async function snTraceLegacy(ctx) {
  try {
    const { snCode } = ctx.params;
    const { pnCode } = ctx.query;

    if (!snCode) {
      ctx.throw(400, 'SN码不能为空');
    }

    const timeline = [];
    const timelineKeys = new Set();
    const traceUser = ctx.state.user || {};

    const appendReferenceEvent = (event, reference, options = {}) => {
      const canView = options.dealerOnly
        ? isDealerTraceAccount(traceUser) && canViewSnTraceReference(traceUser, reference)
        : canViewSnTraceReference(traceUser, reference);
      if (!canView) return;

      const key = `${event.type}:${reference.ref_id}`;
      if (timelineKeys.has(key)) return;
      timelineKeys.add(key);
      timeline.push({
        ...event,
        ref_type: reference.ref_type,
        ref_no: reference.ref_no,
        ref_id: reference.ref_id,
        can_view_order: true
      });
    };

    const traces = await sequelize.query(
      `SELECT log_id, sn_code, old_sn_code, action, remark, create_user, create_time
       FROM T_SN_LOG
       WHERE sn_code = :snCode OR old_sn_code = :snCode2
       ORDER BY create_time ASC`,
      {
        replacements: { snCode, snCode2: snCode },
        type: sequelize.QueryTypes.SELECT
      }
    );

    for (const t of traces) {
      timeline.push({
        id: t.log_id,
        type: t.action,
        label: t.action === 'modify_sn' ? 'SN修改' :
               t.action === 'pn_updated' ? 'PN修改' :
               t.action === 'sale' ? '已销售' :
               t.action === 'inbound' ? '入库' :
               t.action === 'return' ? '退库' : t.action,
        description: t.remark || '',
        user: t.create_user || '-',
        time: t.create_time,
        oldSnCode: t.old_sn_code || null
      });
    }

    const inboundItems = await sequelize.query(
      `SELECT ii.sn_code, i.inbound_no, i.inbound_id, i.store_id, i.purchase_request_id,
              s.distributor_id, i.create_time, i.create_user
       FROM T_INBOUND_ITEM ii
       JOIN T_INBOUND i ON ii.inbound_id = i.inbound_id
       LEFT JOIN T_STORE s ON i.store_id = s.store_id
       WHERE ii.sn_code = :snCode`,
      { replacements: { snCode }, type: sequelize.QueryTypes.SELECT }
    );

    for (const ib of inboundItems) {
      appendReferenceEvent(
        {
          id: 'ib-' + ib.inbound_id,
          type: 'inbound',
          label: '入库',
          description: `入库单号: ${ib.inbound_no}`,
          user: ib.create_user || '-',
          time: ib.create_time
        },
        {
          ref_type: 'inbound',
          ref_no: ib.inbound_no,
          ref_id: ib.inbound_id,
          store_id: ib.store_id,
          distributor_id: ib.distributor_id,
          creator_names: [ib.create_user]
        },
        { dealerOnly: true }
      );

      if (ib.purchase_request_id) {
        const purchaseRequests = await sequelize.query(
          `SELECT pr.request_id, pr.request_no, pr.store_id, pr.apply_user,
                  s.distributor_id, pr.create_time
           FROM T_PURCHASE_REQUEST pr
           LEFT JOIN T_STORE s ON pr.store_id = s.store_id
           WHERE pr.request_id = :requestId`,
          {
            replacements: { requestId: ib.purchase_request_id },
            type: sequelize.QueryTypes.SELECT
          }
        );
        for (const request of purchaseRequests) {
          appendReferenceEvent(
            {
              id: 'pr-' + request.request_id,
              type: 'purchase',
              label: '采购订单',
              description: `采购订单号: ${request.request_no}`,
              user: request.apply_user || '-',
              time: request.create_time || ib.create_time
            },
            {
              ref_type: 'purchase_request',
              ref_no: request.request_no,
              ref_id: request.request_id,
              store_id: request.store_id,
              distributor_id: request.distributor_id,
              creator_names: [request.apply_user]
            }
          );
        }
      }
    }

    const orderItems = await sequelize.query(
      `SELECT oi.sn_code, o.order_no, o.order_id, o.store_id,
              s.distributor_id, o.create_time, o.create_user
       FROM T_ORDER_ITEM oi
       JOIN T_ORDER o ON oi.order_id = o.order_id
       LEFT JOIN T_STORE s ON o.store_id = s.store_id
       WHERE oi.sn_code = :snCode`,
      { replacements: { snCode }, type: sequelize.QueryTypes.SELECT }
    );

    for (const ord of orderItems) {
      appendReferenceEvent(
        {
          id: 'ord-' + ord.order_id,
          type: 'sale',
          label: '已销售',
          description: `销售订单号: ${ord.order_no}`,
          user: ord.create_user || '-',
          time: ord.create_time
        },
        {
          ref_type: 'sales_order',
          ref_no: ord.order_no,
          ref_id: ord.order_id,
          store_id: ord.store_id,
          distributor_id: ord.distributor_id,
          creator_names: [ord.create_user]
        }
      );
    }

    const returnItems = await sequelize.query(
      `SELECT ri.sn_code, rs.return_no, rs.return_id, rs.store_id,
              s.distributor_id, rs.create_time, rs.create_user
       FROM T_RETURN_STOCK_ITEM ri
       JOIN T_RETURN_STOCK rs ON ri.return_id = rs.return_id
       LEFT JOIN T_STORE s ON rs.store_id = s.store_id
       WHERE ri.sn_code = :snCode`,
      { replacements: { snCode }, type: sequelize.QueryTypes.SELECT }
    );

    for (const rt of returnItems) {
      appendReferenceEvent(
        {
          id: 'rt-' + rt.return_id,
          type: 'return',
          label: '退库',
          description: `退库单号: ${rt.return_no}`,
          user: rt.create_user || '-',
          time: rt.create_time
        },
        {
          ref_type: 'return_stock',
          ref_no: rt.return_no,
          ref_id: rt.return_id,
          store_id: rt.store_id,
          distributor_id: rt.distributor_id,
          creator_names: [rt.create_user]
        }
      );
    }

    const transferItems = await sequelize.query(
      `SELECT ti.sn_code, t.transfer_no, t.transfer_id, t.from_store_id, t.to_store_id,
              fs.name as from_store_name, ts.name as to_store_name,
              COALESCE(t.distributor_id, fs.distributor_id, ts.distributor_id) as distributor_id,
              t.apply_user, t.create_time, t.status as transfer_status
       FROM T_TRANSFER_ITEM ti
       JOIN T_TRANSFER t ON ti.transfer_id = t.transfer_id
       LEFT JOIN T_STORE fs ON t.from_store_id = fs.store_id
       LEFT JOIN T_STORE ts ON t.to_store_id = ts.store_id
       WHERE ti.sn_code = :snCode`,
      { replacements: { snCode }, type: sequelize.QueryTypes.SELECT }
    );

    for (const tr of transferItems) {
      appendReferenceEvent(
        {
          id: 'tr-' + tr.transfer_id,
          type: 'transfer',
          label: '调拨' + (tr.transfer_status === 'completed' ? '（已完成）' : '（进行中）'),
          description: `${tr.from_store_name || tr.from_store_id} → ${tr.to_store_name || tr.to_store_id}，单号：${tr.transfer_no}`,
          user: tr.apply_user || '-',
          time: tr.create_time
        },
        {
          ref_type: 'transfer_order',
          ref_no: tr.transfer_no,
          ref_id: tr.transfer_id,
          from_store_id: tr.from_store_id,
          to_store_id: tr.to_store_id,
          distributor_id: tr.distributor_id,
          creator_names: [tr.apply_user]
        }
      );
    }

    timeline.sort((a, b) => new Date(b.time) - new Date(a.time));

    const snWhere = { sn_code: snCode, is_deleted: 0 };
    if (pnCode) {
      snWhere.pn_code = pnCode;
    }

    const sn = await ProductSn.findOne({
      where: snWhere,
      include: [
        { model: Product, attributes: ['name'] },
        { model: Store, attributes: ['store_id', 'name'] }
      ]
    });
    const snData = sn ? sn.toJSON() : null;

    ctx.body = {
      code: 0,
      data: {
        snCode,
        currentStatus: snData ? snData.status : 'unknown',
        currentStatusLabel: snData ? getSnStatusLabel(snData.status) : '未知',
        productId: snData ? snData.product_id : '',
        productName: snData ? (snData.product_name || snData.Product?.name || '') : '',
        storeId: snData ? snData.store_id : '',
        storeName: snData ? (snData.Store?.name || '') : '',
        timeline
      }
    };
  } catch (err) {
    if (err.status) ctx.throw(err.status, err.message);
    console.error('snTrace error:', err);
    ctx.throw(500, '查询SN追踪失败');
  }
}

/**
 * 入库单列表
 */
function parseInboundSnCodes(value) {
  if (Array.isArray(value)) return value.map(code => String(code || '').trim()).filter(Boolean);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.map(code => String(code || '').trim()).filter(Boolean)
      : [];
  } catch (_) {
    return String(value).split(/[,\s]+/).map(code => code.trim()).filter(Boolean);
  }
}

function enrichInboundItemProgress(item, inboundStatus) {
  const data = item?.dataValues || item || {};
  const totalQuantity = Math.max(Number(data.quantity || 0), 0);
  const storedReceived = Math.max(Number(data.received_quantity || 0), 0);
  const receivedQuantity = inboundStatus === 'completed'
    ? Math.max(totalQuantity, storedReceived)
    : Math.min(totalQuantity, storedReceived);
  const snCodes = parseInboundSnCodes(data.received_sn_codes);
  if (snCodes.length === 0 && data.sn_code) snCodes.push(String(data.sn_code).trim());
  data.received_quantity = receivedQuantity;
  data.remaining_quantity = inboundStatus === 'pending'
    ? Math.max(totalQuantity - receivedQuantity, 0)
    : 0;
  data.sn_codes = snCodes;
  return data;
}

function inboundItemDisplayQuantity(item, inboundStatus) {
  return inboundStatus === 'pending'
    ? Math.max(Number(item.remaining_quantity ?? item.quantity ?? 0), 0)
    : Math.max(Number(item.quantity || 0), 0);
}

async function getInboundList(ctx) {
  try {
    const { storeId, status, inboundNo, page = 1, pageSize = 20 } = ctx.query;

    const where = { [Op.and]: [buildNonTransferInboundCondition()] };
    if (storeId) {
      const allowedStoreIds = (ctx.state.user.accessibleStoreIds || []).map(String);
      if (!allowedStoreIds.includes('*') && !allowedStoreIds.includes(String(storeId))) {
        ctx.throw(403, '无权访问该门店入库记录');
      }
      where.store_id = storeId;
    } else if (!ctx.state.user.accessibleStoreIds.includes('*')) where.store_id = ctx.state.user.accessibleStoreIds;
    if (status) where.status = status;
    if (inboundNo) where.inbound_no = { [Op.like]: `%${String(inboundNo).trim()}%` };

    const { count, rows } = await Inbound.findAndCountAll({
      where,
      order: buildPendingFirstOrder(sequelize, {
        statusColumn: 'Inbound.status',
        pendingStatuses: ['pending'],
        dateColumns: ['Inbound.create_time'],
        idColumn: 'Inbound.inbound_id'
      }),
      ...paginate({}, { page, pageSize })
    });

    for (const inbound of rows) {
      const items = await InboundItem.findAll({ where: { inbound_id: inbound.inbound_id } });
      const store = await Store.findByPk(inbound.store_id);
      items.forEach(item => enrichInboundItemProgress(item, inbound.status));
      inbound.dataValues.items = items;
      inbound.dataValues.Store = store;
    }

    await attachPurchaseInitiatorNames(rows);

    const allProductIds = [];
    rows.forEach(row => {
      if (row.dataValues.items && row.dataValues.items.length > 0) {
        row.dataValues.items.forEach(item => {
          if (item.product_id) allProductIds.push(item.product_id);
        });
      }
    });

    const products = await Product.findAll({
      where: { product_id: { [Op.in]: [...new Set(allProductIds)] } }
    });
    const productMap = new Map();
    products.forEach(p => productMap.set(p.product_id, p));

    const formattedRows = rows.map(row => {
      const result = row.toJSON();
      result.Store = row.dataValues.Store;
      result.items = row.dataValues.items.map(item => {
        const data = item.toJSON ? item.toJSON() : item;
        return {
          ...data,
          original_quantity: Number(data.quantity || 0),
          quantity: inboundItemDisplayQuantity(data, result.status)
        };
      });
      result.store_name = result.Store?.name || '';

      if (result.items && result.items.length > 0) {
        const itemsSummary = result.items.map(item => {
          let productName = item.product_name;
          if (!productName || productName.trim() === '') {
            const product = productMap.get(item.product_id);
            if (product) productName = product.name;
          }
          return `${productName || '未知商品'} x${item.quantity}`;
        });
        result.items_summary = itemsSummary.join('、');
      } else {
        result.items_summary = '';
      }
      return result;
    });

    ctx.body = formatPaginatedResult(formattedRows, { page, pageSize, count });
  } catch (error) {
    console.error('Error in getInboundList:', error);
    throw error;
  }
}

/**
 * 获取入库单详情
 */
async function assertDistributorInboundTraceAccess(ctx, inbound) {
  const user = ctx.state.user || {};
  if (!isDistributorAccount(user)) {
    ctx.throw(403, '仅经销商账号可以查看SN关联入库单');
  }
  if (getUserRoles(user).includes('boss')) return;
  if (!accessibleDistributorIds(user).length) {
    ctx.throw(403, '当前账号未绑定经销商');
  }
  const store = await Store.findOne({
    where: { store_id: inbound.store_id, is_deleted: 0 },
    attributes: ['store_id', 'distributor_id']
  });
  if (!store || !canAccessDistributor(user, store.distributor_id)) {
    ctx.throw(403, '无权查看该入库单');
  }
}

function purchaseInitiatorName(request) {
  return String(request?.apply_user || request?.submit_user || '').trim();
}

function salesReturnRequesterName(request) {
  return String(request?.create_user || request?.createUser || '').trim();
}

function resolveInboundInitiator(inbound, purchaseRequest, salesReturnRequest, transfer) {
  const sourceType = String(inbound?.source_type || '').toLowerCase();
  if (sourceType === 'sales_return') {
    return salesReturnRequesterName(salesReturnRequest || purchaseRequest) || String(inbound?.create_user || '').trim() || '-';
  }
  if (sourceType === 'purchase' || inbound?.purchase_request_id) {
    return purchaseInitiatorName(purchaseRequest) || String(inbound?.create_user || '').trim() || '-';
  }
  if (sourceType === 'transfer') {
    return String(transfer?.apply_user || inbound?.create_user || '').trim() || '-';
  }
  return String(inbound?.create_user || '').trim() || '-';
}

function resolveSnTraceLogUser(row, initiatorByReference) {
  const remark = String(row?.remark || '');
  for (const [referenceNo, initiator] of initiatorByReference.entries()) {
    if (referenceNo && initiator && remark.includes(referenceNo)) return initiator;
  }
  return String(row?.create_user || '').trim() || '-';
}

async function attachPurchaseInitiatorNames(inbounds) {
  const requestIds = [...new Set((inbounds || [])
    .map(inbound => inbound.purchase_request_id)
    .filter(Boolean)
    .map(String))];
  const requestNos = [...new Set((inbounds || [])
    .filter(inbound => String(inbound.source_type || '').toLowerCase() === 'purchase')
    .map(inbound => inbound.source_no)
    .filter(Boolean)
    .map(String))];
  const salesReturnNos = [...new Set((inbounds || [])
    .filter(inbound => String(inbound.source_type || '').toLowerCase() === 'sales_return')
    .map(inbound => inbound.source_no)
    .filter(Boolean)
    .map(String))];
  const conditions = [];
  if (requestIds.length) conditions.push({ request_id: { [Op.in]: requestIds } });
  if (requestNos.length) conditions.push({ request_no: { [Op.in]: requestNos } });
  const [requests, salesReturnRequests] = await Promise.all([
    conditions.length
      ? PurchaseRequest.findAll({
          where: { [Op.or]: conditions },
          attributes: ['request_id', 'request_no', 'apply_user', 'submit_user']
        })
      : Promise.resolve([]),
    salesReturnNos.length
      ? SalesReturnRequest.findAll({
          where: { return_no: { [Op.in]: salesReturnNos } },
          attributes: ['return_no', 'create_user']
        })
      : Promise.resolve([])
  ]);

  const requestMap = new Map();
  requests.forEach(request => {
    const data = request.toJSON ? request.toJSON() : request;
    if (data.request_id) requestMap.set(`id:${String(data.request_id)}`, data);
    if (data.request_no) requestMap.set(`no:${String(data.request_no)}`, data);
  });
  const salesReturnMap = new Map();
  salesReturnRequests.forEach(request => {
    const data = request.toJSON ? request.toJSON() : request;
    if (data.return_no) salesReturnMap.set(String(data.return_no), data);
  });

  (inbounds || []).forEach(inbound => {
    const sourceType = String(inbound.source_type || '').toLowerCase();
    if (sourceType === 'sales_return') {
      const returnRequest = salesReturnMap.get(String(inbound.source_no || ''));
      if (!returnRequest) return;
      const name = salesReturnRequesterName(returnRequest);
      inbound.dataValues.purchase_initiator_name = name;
      inbound.dataValues.purchase_applicant_name = name;
      return;
    }
    const request = (inbound.purchase_request_id && requestMap.get(`id:${String(inbound.purchase_request_id)}`)) ||
      (inbound.source_no && requestMap.get(`no:${String(inbound.source_no)}`));
    if (!request) return;
    const name = purchaseInitiatorName(request);
    inbound.dataValues.purchase_initiator_name = name;
    inbound.dataValues.purchase_applicant_name = name;
  });
  return inbounds;
}

async function getInboundDetailById(ctx, inboundId, { distributorTrace = false } = {}) {
  try {
    const inbound = await Inbound.findByPk(inboundId);
    if (!inbound) ctx.throw(404, '入库单不存在');
    if (distributorTrace) await assertDistributorInboundTraceAccess(ctx, inbound);
    else assertStoreVisible(ctx, inbound.store_id);

    const items = await InboundItem.findAll({ where: { inbound_id: inboundId } });
    const store = await Store.findByPk(inbound.store_id);
    items.forEach(item => enrichInboundItemProgress(item, inbound.status));
    const locationIds = items.map(item => item.location_id).filter(Boolean);
    const locations = locationIds.length
      ? await Location.findAll({ where: { location_id: { [Op.in]: locationIds } }, attributes: ['location_id', 'name'] })
      : [];
    const locationMap = new Map(locations.map(location => [location.location_id, location.name]));
    inbound.dataValues.items = items.map(i => i.toJSON());
    inbound.dataValues.Store = store ? store.toJSON() : null;

    const result = inbound.toJSON();
    result.store_name = result.Store?.name || '';
    result.receive_user = result.receive_user || (result.status === 'completed' ? result.create_user : '');
    result.receive_time = result.receive_time || (result.status === 'completed' ? result.update_time : null);

    const isSalesReturnInbound = String(inbound.source_type || '').toLowerCase() === 'sales_return';
    const purchaseWhere = !isSalesReturnInbound && inbound.purchase_request_id
      ? { request_id: inbound.purchase_request_id }
      : !isSalesReturnInbound && String(inbound.source_type || '').toLowerCase() === 'purchase' && inbound.source_no
        ? { request_no: inbound.source_no }
        : null;
    const purchaseRequest = purchaseWhere
      ? await PurchaseRequest.findOne({
          where: purchaseWhere,
          attributes: ['request_id', 'request_no', 'apply_user', 'submit_user', 'supplier_id'],
          include: distributorTrace ? [{ model: Supplier, attributes: ['supplier_id', 'name'] }] : []
        })
      : null;
    const salesReturnRequest = isSalesReturnInbound && inbound.source_no
      ? await SalesReturnRequest.findOne({
          where: { return_no: inbound.source_no },
          attributes: ['return_no', 'create_user']
        })
      : null;
    const purchaseRequestItems = purchaseRequest
      ? await PurchaseRequestItem.findAll({
          where: { request_id: purchaseRequest.request_id },
          attributes: ['item_id', 'product_id', 'pn_code', 'unit_price', 'rebate_deduction'],
          raw: true
        })
      : [];
    const purchaseItemMap = new Map(purchaseRequestItems.map(item => [String(item.item_id), item]));
    if (purchaseRequest || salesReturnRequest) {
      const initiator = salesReturnRequest
        ? salesReturnRequesterName(salesReturnRequest)
        : purchaseInitiatorName(purchaseRequest);
      result.purchase_initiator_name = initiator;
      result.purchase_applicant_name = initiator;
    }
    if (distributorTrace) {
      result.purchase_source = {
        request_id: purchaseRequest?.request_id || inbound.purchase_request_id || '',
        request_no: purchaseRequest?.request_no || (inbound.source_type === 'purchase' ? inbound.source_no : '') || '',
        supplier_id: purchaseRequest?.supplier_id || '',
        supplier_name: purchaseRequest?.Supplier?.name || '',
        source_type: inbound.source_type || '',
        source_no: inbound.source_no || ''
      };
    }

    if (result.items && result.items.length > 0) {
      const productIds = result.items.map(item => item.product_id).filter(id => id);
      const products = await Product.findAll({
        where: { product_id: { [Op.in]: productIds } }
      });
      const productMap = new Map();
      products.forEach(p => productMap.set(p.product_id, p));

      result.items = result.items.map(item => {
        if (!item.product_name || item.product_name.trim() === '') {
          const product = productMap.get(item.product_id);
          if (product) item.product_name = product.name;
        }
        const purchaseItem = purchaseItemMap.get(String(item.purchase_request_item_id || ''));
        const snCodes = Array.isArray(item.sn_codes)
          ? item.sn_codes
          : (item.sn_code ? [item.sn_code] : []);
        return {
          ...item,
          location_name: item.location_id ? (locationMap.get(item.location_id) || item.location_id) : '',
          need_sn: productMap.get(item.product_id)?.need_sn || 0,
          sn_codes: snCodes,
          received_quantity: Math.max(Number(item.received_quantity || 0), 0),
          receive_user: item.receive_user || '',
          receive_time: item.receive_time || null,
          purchase_unit_price: purchaseItem?.unit_price ?? item.unit_price
        };
      });

      const pnRecords = await ProductPn.findAll({
        where: { product_id: { [Op.in]: productIds }, is_deleted: 0 }
      });
      const barcodeRecords = await ProductBarcode.findAll({
        where: { product_id: { [Op.in]: productIds }, barcode_type: 'manufacturer', status: 1 },
        raw: true
      });
      const pnMap = {};
      for (const pn of pnRecords) {
        if (!pnMap[pn.product_id]) pnMap[pn.product_id] = [];
        pnMap[pn.product_id].push({
          pn_id: pn.pn_id,
          pn_code: pn.pn_code,
          product_name: pn.product_name || ''
        });
      }

      for (const bc of barcodeRecords) {
        if (!bc.barcode_code) continue;
        if (!pnMap[bc.product_id]) pnMap[bc.product_id] = [];
        if (!pnMap[bc.product_id].some(p => p.pn_code === bc.barcode_code)) {
          pnMap[bc.product_id].push({
            pn_id: '',
            pn_code: bc.barcode_code,
            product_name: ''
          });
        }
      }

      for (const product of products) {
        const manufacturerCodes = splitCodes(product.manufacturer_code);
        if (manufacturerCodes.length > 0) {
          if (!pnMap[product.product_id]) pnMap[product.product_id] = [];
          for (const code of manufacturerCodes) {
            if (!pnMap[product.product_id].some(p => p.pn_code === code)) {
              pnMap[product.product_id].push({
                pn_id: '',
                pn_code: code,
                product_name: product.name || ''
              });
            }
          }
        }
      }

      for (const item of items) {
        const itemData = item.toJSON ? item.toJSON() : item;
        const pnCode = itemData.pn_code;
        if (!pnCode) continue;
        if (!pnMap[itemData.product_id]) pnMap[itemData.product_id] = [];
        if (!pnMap[itemData.product_id].some(p => p.pn_code === pnCode)) {
          pnMap[itemData.product_id].push({
            pn_id: '',
            pn_code: pnCode,
            product_name: ''
          });
        }
      }

      result.product_pns = pnMap;
    }

    ctx.body = { code: 0, data: result };
  } catch (error) {
    console.error('Error in getInboundDetail:', error);
    throw error;
  }
}

async function getInboundDetail(ctx) {
  return getInboundDetailById(ctx, ctx.params.inboundId);
}

async function getSnTraceInboundDetail(ctx) {
  return getInboundDetailById(ctx, ctx.params.inboundId, { distributorTrace: true });
}

/**
 * 更新库存聚合（入库/退库）
 * @param {string} productId 商品ID
 * @param {string} storeId 门店ID
 * @param {string} field 字段名: normal_qty | display_qty | demo_qty | unsellable_qty | pending_qty
 * @param {number} delta 变化量（入库为正，退库为负）
 * @param {object} transaction Sequelize事务
 */
async function updateInventory(productId, storeId, field, delta, transaction, locationId = '') {
  const normalizedLocationId = locationId || '';

  if (delta < 0 && !normalizedLocationId) {
    let remaining = Math.abs(delta);
    const rows = await Inventory.findAll({
      where: { product_id: productId, store_id: storeId },
      order: [
        [sequelize.literal(`CASE WHEN LOCATION_ID = '' THEN 1 ELSE 0 END`), 'ASC'],
        [field, 'DESC']
      ],
      transaction
    });

    for (const row of rows) {
      if (remaining <= 0) break;
      const current = Number(row[field] || 0);
      if (current <= 0) continue;
      const deduct = Math.min(current, remaining);
      await row.update({ [field]: current - deduct }, { transaction });
      remaining -= deduct;
    }

    if (remaining <= 0) return;
    delta = -remaining;
  }

  let inv = await Inventory.findOne({
    where: { product_id: productId, store_id: storeId, location_id: normalizedLocationId },
    transaction
  });

  if (!inv) {
    inv = await Inventory.create({
      inventory_id: generateUUID(),
      product_id: productId,
      store_id: storeId,
      location_id: normalizedLocationId,
      normal_qty: 0,
      regular_qty: 0,
      subsidy_qty: 0,
      second_qty: 0,
      display_qty: 0,
      demo_qty: 0,
      unsellable_qty: 0,
      pending_qty: 0,
      rental_demo_qty: 0
    }, { transaction });
  }

  const newVal = Math.max(0, (inv[field] || 0) + delta);
  await inv.update({ [field]: newVal }, { transaction });
  await syncSerializedInventoryBalance({ productId, storeId, transaction });
}


function validateSalesReturnInboundSn({ sn, requestedSnCode = '' }) {
  if (!sn) return { status: 409, message: '销售退单SN不存在' };
  if (sn.status !== 'return_pending') return { status: 409, message: '销售退单SN当前不是待重新入库状态' };
  if (requestedSnCode && String(requestedSnCode) !== String(sn.sn_code || '')) {
    return { status: 400, message: `销售退单SN必须为 ${sn.sn_code}` };
  }
  return null;
}

function getTransferableInventoryQuantity(inventories = [], locationTypes = new Map()) {
  return (inventories || []).reduce((total, inventory) => {
    const locationId = String(inventory?.location_id || '');
    const locationType = locationTypes instanceof Map ? locationTypes.get(locationId) : '';
    // 与库存汇总保持同一口径：只把销售仓 normal_qty 计入调拨可用量，
    // 同时兼容历史数据将资源明细拆存在 regular/subsidy/second 字段的情况。
    return total + Number(getInventoryQuantitySnapshot(inventory, locationType).normal_qty || 0);
  }, 0);
}

function isPurchaseInboundItemProgressComplete(item, product, progress = {}) {
  const totalQuantity = Math.max(Number(item?.quantity || 0), 0);
  const receivedQuantity = Math.max(Number(item?.received_quantity || 0), 0) +
    Math.max(Number(progress?.quantity || 0), 0);
  if (receivedQuantity < totalQuantity) return false;
  if (Number(product?.need_sn) !== 1) return true;

  const snCodes = parseInboundSnCodes(item?.received_sn_codes);
  if (snCodes.length === 0 && item?.sn_code) snCodes.push(String(item.sn_code).trim());
  snCodes.push(...(progress?.snCodes || []));
  return snCodes.length >= totalQuantity;
}

async function getTransferableStock(product, productId, storeId, transaction) {
  const inventories = await Inventory.findAll({
    where: { product_id: productId, store_id: storeId },
    transaction
  });
  const locations = await Location.findAll({
    where: { store_id: storeId, status: 1 },
    attributes: ['location_id', 'type'],
    transaction
  });
  const locationTypes = new Map(locations.map(location => [String(location.location_id), location.type]));
  const inventoryQty = getTransferableInventoryQuantity(inventories, locationTypes);

  if (Number(product.need_sn) !== 1) {
    return inventoryQty;
  }

  const snQty = await ProductSn.count({
    where: {
      product_id: productId,
      store_id: storeId,
      status: 'in_stock',
      is_deleted: 0
    },
    transaction,
    include: [{
      model: Location,
      required: true,
      attributes: [],
      where: { type: 'normal_qty', status: 1 }
    }]
  });

  return snQty;
}

async function productHasPn(product, pnCode, transaction) {
  const code = String(pnCode || '').trim();
  if (!code) return false;
  if (Number(product.need_sn) === 1) {
    try {
      const productPns = await ProductPn.findAll({
        where: { product_id: product.product_id, status: 1, is_deleted: 0 },
        attributes: ['pn_code'],
        transaction
      });
      assertSingleSnProductPn({
        needSn: product.need_sn,
        productCode: product.product_code,
        configuredCodes: [productPns.map(item => item.pn_code), product.manufacturer_code],
        requestedCode: code
      });
      return true;
    } catch (_) {
      return false;
    }
  }
  const pn = await ProductPn.findOne({
    where: { product_id: product.product_id, pn_code: code, is_deleted: 0 },
    transaction
  });
  if (pn) return true;
  return splitCodes(product.manufacturer_code).some(item => String(item).trim() === code);
}

async function resolveSnProductPn(product, requestedCode, transaction) {
  const productPns = await ProductPn.findAll({
    where: { product_id: product.product_id, status: 1, is_deleted: 0 },
    attributes: ['pn_code'],
    transaction
  });
  return assertSingleSnProductPn({
    needSn: product.need_sn,
    productCode: product.product_code,
    configuredCodes: [productPns.map(item => item.pn_code), product.manufacturer_code],
    requestedCode
  });
}

function normalizeTransferItem(raw) {
  const productId = raw.productId || raw.product_id;
  const productCode = String(raw.productCode || raw.product_code || '').trim();
  const pnCode = String(raw.pnCode || raw.pn_code || '').trim();
  const snId = raw.snId || raw.sn_id || null;
  const snCode = raw.snCode || raw.sn_code || '';
  const quantity = Math.max(parseInt(raw.quantity || raw.qty || 1, 10), 1);

  return { productId, productCode, pnCode, snId, snCode, quantity };
}

/**
 * 调出确认成功后，为调入门店创建一张真正的待入库单。
 * 用 source_no 做幂等键，兼容历史数据和重复请求。
 */
function transferQuantitySummary(transfer, items = []) {
  const totalQuantity = Math.max(Number(transfer?.total_quantity || 0), 0);
  const status = String(transfer?.status || '').toLowerCase();
  const storedOutbound = Number(transfer?.outbound_quantity);
  const hasStoredOutbound = Number.isFinite(storedOutbound) && storedOutbound > 0;
  const actualItemQuantity = (items || []).reduce((sum, item) => sum + Math.max(Number(item.quantity || 0), 0), 0);
  const outboundQuantity = hasStoredOutbound || !['out_confirmed', 'completed'].includes(status)
    ? Math.max(storedOutbound || 0, 0)
    : actualItemQuantity;
  const remainingQuantity = Math.max(totalQuantity - outboundQuantity, 0);
  return {
    totalQuantity,
    outboundQuantity,
    remainingQuantity,
    remainingStatus: transfer?.remaining_status || (remainingQuantity > 0 ? 'pending' : 'fulfilled')
  };
}

function visibleTransferItems(items = []) {
  return (items || []).filter(item => Number(item.quantity || 0) > 0);
}

function getPendingTransferItems(items = []) {
  return visibleTransferItems(items);
}

function buildPreselectedTransferSelection(item) {
  if (!item || (!item.sn_id && !item.sn_code)) return null;
  return {
    itemId: item.item_id,
    productId: item.product_id,
    pnCode: item.pn_code || '',
    snId: item.sn_id || '',
    snCode: item.sn_code || '',
    quantity: Math.max(Number(item.quantity || 1), 1)
  };
}

async function ensureTransferInbound(transfer, items, transaction) {
  const existing = await Inbound.findOne({
    where: { source_type: 'TRANSFER', source_no: transfer.transfer_no },
    transaction,
    lock: transaction.LOCK.UPDATE
  });
  if (existing) return existing;

  const inboundId = generateUUID();
  const inboundNo = generateInboundNo();
  const normalizedItems = (items || []).map(item => ({
    inbound_id: inboundId,
    product_id: item.product_id || item.productId,
    product_name: item.product_name || item.productName || '',
    pn_code: item.pn_code || item.pnCode || '',
    sn_id: item.sn_id || item.snId || null,
    sn_code: item.sn_code || item.snCode || '',
    quantity: Math.max(Number(item.quantity || 1), 1),
    inventory_type: 'normal_qty'
  }));

  await Inbound.create({
    inbound_id: inboundId,
    inbound_no: inboundNo,
    store_id: transfer.to_store_id,
    source_type: 'TRANSFER',
    source_no: transfer.transfer_no,
    total_quantity: normalizedItems.reduce((sum, item) => sum + item.quantity, 0),
    status: 'pending',
    create_user: transfer.apply_user || 'system',
    create_time: new Date(),
    update_time: new Date()
  }, { transaction });

  if (normalizedItems.length) {
    await InboundItem.bulkCreate(normalizedItems, { transaction });
  }
  return Inbound.findByPk(inboundId, { transaction });
}

function resolveTransferInboundSnBinding(transferItem = {}, inboundItem = {}, requested = {}) {
  const transferSnId = transferItem.sn_id || '';
  const inboundSnId = inboundItem.sn_id || '';
  const transferSnCode = String(transferItem.sn_code || '').trim();
  const inboundSnCode = String(inboundItem.sn_code || '').trim();
  const requestedSnId = requested.snId || requested.sn_id || requested.inventoryId || requested.inventory_id || '';
  const requestedSnCode = String(requested.snCode || requested.sn_code || '').trim();

  return {
    snId: transferSnId || inboundSnId || requestedSnId,
    snCode: transferSnCode || inboundSnCode || requestedSnCode,
    sourceSnIdMismatch: Boolean(transferSnId && inboundSnId && String(transferSnId) !== String(inboundSnId)),
    sourceSnCodeMismatch: Boolean(transferSnCode && inboundSnCode && transferSnCode !== inboundSnCode),
    requestedSnIdMismatch: Boolean((transferSnId || inboundSnId) && requestedSnId && String(transferSnId || inboundSnId) !== String(requestedSnId)),
    requestedSnCodeMismatch: Boolean((transferSnCode || inboundSnCode) && requestedSnCode && (transferSnCode || inboundSnCode) !== requestedSnCode)
  };
}

/**
 * 执行入库
 */
async function executeInbound(ctx) {
  const VALID_INVENTORY_TYPES = ['normal_qty', 'display_qty', 'demo_qty', 'unsellable_qty', 'pending_qty', 'rental_demo_qty'];
  const PRODUCT_TYPE_TO_FIELD = {
    '服务商全资源': 'regular_qty',
    '含税仅国补': 'subsidy_qty',
    '含税无国补': 'regular_qty',
    '未税': 'second_qty',
    '正规货': 'regular_qty',
    '国补货': 'subsidy_qty',
    '纯二批': 'second_qty'
  };

  const t = await sequelize.transaction();
  try {
    const { inboundId, items = [] } = ctx.request.body;
    const user = ctx.state.user;
    if (!Array.isArray(items) || items.length === 0) ctx.throw(400, '请至少提交一条入库明细');

    const inbound = await Inbound.findByPk(inboundId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!inbound) ctx.throw(404, '入库单不存在');

    if (inbound.status !== 'pending') {
      ctx.throw(400, '该入库单已处理');
    }

    const isTransferInbound = isTransferInboundRecord(inbound);
    if (isTransferInbound) {
      ctx.throw(400, '调拨入库请在调拨管理中操作');
    }
    const isSalesReturnInbound = String(inbound.source_type || '').toUpperCase() === 'SALES_RETURN';
    const isPurchaseInbound = String(inbound.source_type || '').toLowerCase() === 'purchase' || Boolean(inbound.purchase_request_id);
    const inboundItems = await InboundItem.findAll({ where: { inbound_id: inboundId }, transaction: t });
    const purchaseRequest = inbound.purchase_request_id
      ? await PurchaseRequest.findByPk(inbound.purchase_request_id, { transaction: t })
      : null;
    const salesReturnRequest = isSalesReturnInbound && inbound.source_no
      ? await SalesReturnRequest.findOne({
          where: { return_no: inbound.source_no },
          attributes: ['return_no', 'create_user'],
          transaction: t
        })
      : null;
    const inboundInitiator = resolveInboundInitiator(inbound, purchaseRequest, salesReturnRequest);
    const defaultTransferLocation = isTransferInbound
      ? await Location.findOne({
          where: { store_id: inbound.store_id, status: 1, type: 'normal_qty' },
          attributes: ['location_id'],
          transaction: t
        })
      : null;
    const supplier = purchaseRequest?.supplier_id
      ? await Supplier.findByPk(purchaseRequest.supplier_id, { transaction: t })
      : null;
    const productIds = inboundItems.map(item => item.product_id);
    await assertActiveProducts(Product, productIds, { transaction: t });
    const products = await Product.findAll({ where: { product_id: { [Op.in]: productIds }, is_deleted: 0, status: 1 }, transaction: t });
    const productMap = new Map();
    products.forEach(p => productMap.set(p.product_id, p));
    const progressByItem = new Map();

    for (const item of items) {
      const product = productMap.get(item.productId);
      if (!product) {
        ctx.throw(400, `商品 ${item.productId} 不存在`);
      }

      const dbItems = inboundItems.filter(di => di.product_id === item.productId);
      const dbItem = item.inboundItemId || item.inbound_item_id
        ? dbItems.find(di => String(di.item_id) === String(item.inboundItemId || item.inbound_item_id))
        : dbItems.find(di => item.locationId && String(di.location_id || '') === String(item.locationId)) || dbItems[0];
      if (!dbItem) {
        ctx.throw(400, `入库单中未找到商品 ${item.productId || product.name} 的明细`);
      }

      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0) {
        ctx.throw(400, `商品 ${dbItem.product_name || product.name} 的入库数量必须为正整数`);
      }
      const itemKey = String(dbItem.item_id);
      const storedReceivedQuantity = Math.max(Number(dbItem.received_quantity || 0), 0);
      const currentProgress = progressByItem.get(itemKey) || { quantity: 0, snCodes: [] };
      const remainingQuantity = Math.max(Number(dbItem.quantity || 0) - storedReceivedQuantity - currentProgress.quantity, 0);
      if (quantity > remainingQuantity) {
        ctx.throw(400, `商品 ${dbItem.product_name || product.name} 本次最多还能入库 ${remainingQuantity} 件`);
      }
      currentProgress.quantity += quantity;
      progressByItem.set(itemKey, currentProgress);
      if (dbItem.location_id && item.locationId && String(dbItem.location_id) !== String(item.locationId)) {
        ctx.throw(400, `商品 ${dbItem.product_name || product.name} 的入库库位与入库明细不一致`);
      }
      const locationId = item.locationId || dbItem.location_id || defaultTransferLocation?.location_id || null;
      if (!locationId) {
        ctx.throw(400, `商品 ${dbItem.product_name || product.name} 请选择入库库位`);
      }
      const location = locationId
        ? await Location.findOne({
            where: { location_id: locationId, store_id: inbound.store_id, status: 1 },
            attributes: ['location_id', 'type'],
            transaction: t
          })
        : null;
      const inventoryType = VALID_INVENTORY_TYPES.includes(location?.type)
        ? location.type
        : 'normal_qty';
      const originalPickupPrice = Number(item.originalPickupPrice || item.original_pickup_price || dbItem.original_pickup_price || dbItem.unit_price || 0);

      if (Number(product.need_sn) === 1) {
        const submittedSnCode = String(item.snCode || item.sn_code || '').trim();
        const requestedSnCode = submittedSnCode || (isPurchaseInbound ? '' : String(dbItem.sn_code || '').trim());
        if (isPurchaseInbound && quantity !== 1) {
          ctx.throw(400, `商品 ${dbItem.product_name || product.name} 为 SN 商品，每次只能入库 1 件`);
        }
        if (isPurchaseInbound && !submittedSnCode) {
          ctx.throw(400, `商品 ${dbItem.product_name || product.name} 需要 SN 管理，本次入库必须填写 SN`);
        }
        if (isPurchaseInbound) {
          const existingSnCodes = parseInboundSnCodes(dbItem.received_sn_codes);
          const duplicateSn = existingSnCodes.concat(currentProgress.snCodes)
            .some(code => code.toLowerCase() === requestedSnCode.toLowerCase());
          if (duplicateSn) {
            ctx.throw(400, `商品 ${dbItem.product_name || product.name} 的 SN ${requestedSnCode} 已入库或在本次提交中重复`);
          }
          currentProgress.snCodes.push(requestedSnCode);
        }
        const requestedTransferSnId = item.snId || item.sn_id || item.inventoryId || item.inventory_id || dbItem.sn_id || '';
        const salesReturnSn = isSalesReturnInbound
          ? await ProductSn.findOne({
              where: dbItem.sn_id
                ? { sn_id: dbItem.sn_id, product_id: dbItem.product_id, store_id: inbound.store_id, is_deleted: 0 }
                : { product_id: dbItem.product_id, store_id: inbound.store_id, sn_code: dbItem.sn_code, is_deleted: 0 },
              transaction: t,
              lock: t.LOCK.UPDATE
            })
          : null;
        // 历史调拨明细可能没有保存 sn_id；允许使用本次入库请求的库存主键或 SN 反查并修复关联。
        const transferSn = isTransferInbound && (requestedTransferSnId || requestedSnCode)
          ? await ProductSn.findOne({
              where: requestedTransferSnId
                ? { sn_id: requestedTransferSnId, product_id: dbItem.product_id, is_deleted: 0 }
                : { sn_code: requestedSnCode, product_id: dbItem.product_id, is_deleted: 0 },
              transaction: t,
              lock: t.LOCK.UPDATE
            })
          : null;

        if (salesReturnSn) {
          const salesReturnValidation = validateSalesReturnInboundSn({ sn: salesReturnSn, requestedSnCode });
          if (salesReturnValidation) ctx.throw(salesReturnValidation.status, salesReturnValidation.message);

          const salesReturnPnCode = await resolveSnProductPn(
            product,
            item.pnCode || item.pn_code || dbItem.pn_code || salesReturnSn.pn_code || '',
            t
          );
          await salesReturnSn.update({
            product_name: dbItem.product_name || salesReturnSn.product_name || product.name,
            pn_code: salesReturnPnCode,
            status: 'in_stock',
            inventory_type: inventoryType,
            store_id: inbound.store_id,
            location_id: locationId,
            inbound_time: new Date(),
            remark: item.remark || salesReturnSn.remark || ''
          }, { transaction: t });
          await dbItem.update({
            sn_id: salesReturnSn.sn_id,
            sn_code: salesReturnSn.sn_code,
            pn_code: salesReturnPnCode,
            remark: item.remark,
            location_id: locationId,
            original_pickup_price: originalPickupPrice,
            inventory_type: inventoryType
          }, { transaction: t });
          await SnLog.create({
            log_id: generateUUID(),
            sn_id: salesReturnSn.sn_id,
            sn_code: salesReturnSn.sn_code,
            product_id: salesReturnSn.product_id,
            product_name: salesReturnSn.product_name || product.name,
            store_id: inbound.store_id,
            action: 'inbound',
            remark: `销售退库重新入库：${inbound.source_no || inbound.inbound_no}`,
            create_user: inboundInitiator,
            create_time: new Date()
          }, { transaction: t });
        } else if (transferSn) {
          if (!['transferring', 'in_stock'].includes(transferSn.status)) {
            ctx.throw(400, `调拨SN ${transferSn.sn_code} 在当前状态 ${transferSn.status} 下不能接收入库`);
          }
          if (transferSn.status === 'in_stock' && String(transferSn.store_id) !== String(inbound.store_id)) {
            ctx.throw(400, `调拨SN ${transferSn.sn_code} 已在其他门店库存中`);
          }

          const transferPnCode = await resolveSnProductPn(
            product,
            item.pnCode || item.pn_code || dbItem.pn_code || transferSn.pn_code || '',
            t
          );
          if (transferSn.pn_code && transferPnCode && !samePnCode(transferSn.pn_code, transferPnCode)) {
            ctx.throw(400, `调拨SN ${transferSn.sn_code} 与PN ${transferPnCode} 不匹配`);
          }

          await transferSn.update({
            product_name: dbItem.product_name || transferSn.product_name || product.name,
            pn_code: transferPnCode,
            sn_code: requestedSnCode || transferSn.sn_code,
            status: 'in_stock',
            inventory_type: inventoryType,
            store_id: inbound.store_id,
           location_id: locationId,
           // 调拨到店不改变公司首次采购入库时间，库龄继续从原始入库计算。
          }, { transaction: t });
          await dbItem.update({
            sn_id: transferSn.sn_id,
            sn_code: requestedSnCode || transferSn.sn_code,
            pn_code: transferPnCode,
            remark: item.remark,
            location_id: locationId,
            original_pickup_price: originalPickupPrice,
            inventory_type: inventoryType
          }, { transaction: t });
        } else {
          if (isSalesReturnInbound) {
            ctx.throw(409, `销售退单SN ${dbItem.sn_code || requestedSnCode} 不存在`);
          }
        if (!requestedSnCode) {
          ctx.throw(400, `商品 ${dbItem.product_name} 需要SN管理，SN码不能为空`);
        }

        const pnCode = await resolveSnProductPn(
          product,
          item.pnCode || item.pn_code || dbItem.pn_code || '',
          t
        );
        const snCode = requestedSnCode;

        const existingSn = await findInboundSnByIdentity({ pnCode, snCode, transaction: t });
        if (existingSn && String(existingSn.product_id || '') !== String(dbItem.product_id || '')) {
          ctx.throw(409, `PN码 [${pnCode || '-'}] 下的SN码 [${snCode}] 已关联其他商品，不能直接入库`);
        }
        if (existingSn && !REUSABLE_INBOUND_SN_STATUSES.has(String(existingSn.status || '').trim())) {
          ctx.throw(400, `PN码 [${pnCode || '-'}] 下的SN码 [${snCode}] 当前状态为${existingSn.status || '未知'}，不允许重复入库`);
        }

        const pnMaster = await ensureProductPnMaster({
          productId: dbItem.product_id,
          pnCode: pnCode,
          transaction: t
        });
        const snData = {
          product_id: dbItem.product_id,
          pn_id: pnMaster.pn_id,
          pn_code: pnCode,
          sn_code: snCode,
          status: 'in_stock',
          inventory_type: inventoryType,
          store_id: inbound.store_id,
           location_id: locationId,
           inbound_time: new Date(),
           original_inbound_time: new Date(),
           inbound_price: dbItem.unit_price,
          original_pickup_price: originalPickupPrice,
          supplier_id: supplier?.supplier_id || null,
          supplier_name: supplier?.name || null,
          remark: item.remark || '',
          is_deleted: 0
        };
        const snRecord = existingSn
          ? (await existingSn.update(snData, { transaction: t }))
          : await ProductSn.create({
              sn_id: generateUUID(),
              ...snData
            }, { transaction: t });

        await initializeSnResourceRightsFromInbound({
          sn: snRecord,
          inbound,
          inboundItem: dbItem,
          supplier,
          transaction: t
        });

        await dbItem.update({
          sn_id: snRecord.sn_id,
          sn_code: snCode,
          pn_code: pnCode,
          remark: item.remark,
          location_id: locationId,
          original_pickup_price: originalPickupPrice,
          inventory_type: inventoryType
        }, { transaction: t });
        }
      } else {
        const pnCode = normalizePnCode(item.pnCode || dbItem.pn_code || splitCodes(product.manufacturer_code)[0] || '');

        await dbItem.update({
          pn_code: pnCode,
          remark: item.remark,
          location_id: locationId,
          original_pickup_price: originalPickupPrice,
          inventory_type: inventoryType
        }, { transaction: t });
      }

      const savedPnCode = normalizePnCode(item.pnCode || dbItem.pn_code || splitCodes(product.manufacturer_code)[0] || '');
      if (savedPnCode) {
        await ensureProductPnMaster({ productId: item.productId, pnCode: savedPnCode, transaction: t });
      }

      await updateInventory(item.productId, inbound.store_id, inventoryType, quantity, t, locationId);
      await ensureDefaultProductPricing(product, dbItem.unit_price, user, t);

      if (inventoryType === 'normal_qty' && dbItem.product_type) {
        const typeField = PRODUCT_TYPE_TO_FIELD[dbItem.product_type];
        if (typeField) {
          await updateInventory(item.productId, inbound.store_id, typeField, quantity, t, locationId);
        }
      }
    }

    for (const [itemKey, progress] of progressByItem.entries()) {
      const dbItem = inboundItems.find(item => String(item.item_id) === itemKey);
      if (!dbItem) continue;
      const receivedQuantity = Math.min(
        Math.max(Number(dbItem.quantity || 0), 0),
        Math.max(Number(dbItem.received_quantity || 0), 0) + progress.quantity
      );
      const existingSnCodes = parseInboundSnCodes(dbItem.received_sn_codes);
      const receivedSnCodes = existingSnCodes.concat(progress.snCodes || []);
      await dbItem.update({
        received_quantity: receivedQuantity,
        received_sn_codes: receivedSnCodes.length ? JSON.stringify(receivedSnCodes) : dbItem.received_sn_codes,
        receive_user: user.name || user.staffId || user.phone || '',
        receive_time: new Date()
      }, { transaction: t });
    }

    const allPurchaseItemsReceived = inboundItems.every(item => {
      const progress = progressByItem.get(String(item.item_id));
      const receivedQuantity = Math.max(Number(item.received_quantity || 0), 0) + Number(progress?.quantity || 0);
      return receivedQuantity >= Math.max(Number(item.quantity || 0), 0);
    });
    if (isPurchaseInbound && allPurchaseItemsReceived) {
      const incompleteSnItem = inboundItems.find(item => (
        Number(productMap.get(item.product_id)?.need_sn) === 1 &&
        !isPurchaseInboundItemProgressComplete(
          item,
          productMap.get(item.product_id),
          progressByItem.get(String(item.item_id))
        )
      ));
      if (incompleteSnItem) {
        ctx.throw(409, `商品 ${incompleteSnItem.product_name || incompleteSnItem.product_id} 的入库数量已完成，但SN数量不足，不能完成入库`);
      }
    }
    const nextInboundStatus = isPurchaseInbound && !allPurchaseItemsReceived ? 'pending' : 'completed';
    const receiveTime = new Date();
    await inbound.update({
      status: nextInboundStatus,
      receive_user: user.name || user.staffId || user.phone || '',
      receive_time: receiveTime,
      update_time: receiveTime
    }, { transaction: t });

    if (isSalesReturnInbound) {
      const salesReturn = await SalesReturnRequest.findOne({
        where: { return_no: inbound.source_no },
        transaction: t,
        lock: t.LOCK.UPDATE
      });
      if (!salesReturn) ctx.throw(404, '销售退单申请不存在');
      if (salesReturn.status !== 'approved') {
        ctx.throw(409, '销售退单申请尚未审批通过');
      }
      await salesReturn.update({
        status: 'completed',
        approval_stage: 'completed',
        update_time: new Date()
      }, { transaction: t });
      const orderItemsForReturn = await OrderItem.findAll({
        where: { order_id: salesReturn.order_id },
        attributes: ['item_id', 'quantity'],
        transaction: t
      });
      const completedReturnItems = await SalesReturnRequest.findAll({
        where: { order_id: salesReturn.order_id, status: 'completed' },
        include: [{ model: SalesReturnRequestItem, as: 'items', attributes: ['order_item_id', 'quantity'] }],
        transaction: t
      });
      const returnedByItemId = new Map();
      completedReturnItems.forEach(completedReturn => {
        (completedReturn.items || []).forEach(item => {
          const key = String(item.order_item_id || '');
          returnedByItemId.set(key, (returnedByItemId.get(key) || 0) + Number(item.quantity || 0));
        });
      });
      const fullyReturned = orderItemsForReturn.length > 0 && orderItemsForReturn.every(item => (
        (returnedByItemId.get(String(item.item_id)) || 0) >= Number(item.quantity || 0)
      ));
      await Order.update(
        { order_status: fullyReturned ? 'returned' : '已归档', update_time: new Date() },
        { where: { order_id: salesReturn.order_id }, transaction: t }
      );
      await createSalesReturnGrossProfitLedger({
        returnRequest: salesReturn,
        transaction: t,
        createdBy: user.name || user.staffId || 'system'
      });
      await createProductSettlementReturnAdjustment({
        returnRequest: salesReturn,
        transaction: t,
        createdBy: user.name || user.staffId || 'system'
      });
      const settlementOrder = await Order.findByPk(salesReturn.order_id, {
        include: [{ model: OrderItem }],
        transaction: t,
        lock: t.LOCK.UPDATE
      });
      const settlementItems = await SalesReturnRequestItem.findAll({
        where: { return_id: salesReturn.return_id },
        transaction: t,
        lock: t.LOCK.UPDATE
      });
      await restoreDepositForCompletedSalesReturn(settlementOrder, fullyReturned, t);
      await createSalesReturnSettlement({
        returnRequest: salesReturn,
        order: settlementOrder,
        requestItems: settlementItems,
        user,
        transaction: t
      });
    }

    if (isTransferInbound) {
      const transfer = await Transfer.findOne({
        where: { transfer_no: inbound.source_no },
        transaction: t,
        lock: t.LOCK.UPDATE
      });
      if (!transfer) ctx.throw(404, '关联调拨单不存在');
      if (transfer.status === 'out_confirmed') {
        await transfer.update({
          status: 'completed',
          inbound_confirm_user: user.name || user.staffId,
          receiving_user: user.name || user.staffId,
          receiving_time: new Date()
        }, { transaction: t });
      } else if (transfer.status !== 'completed') {
        ctx.throw(400, '关联调拨单当前状态不允许入库');
      }
    }

    await t.commit();
    ctx.body = { code: 0, message: '入库完成' };
  } catch (error) {
    await t.rollback();
    console.error('Error in executeInbound:', error);
    throw error;
  }
}

/**
 * 入库操作 - 创建入库单
 */
async function inbound(ctx) {
  try {
    const user = ctx.state.user;
    const { storeId, sourceType, sourceNo, items } = ctx.request.body;
    if (!Array.isArray(items) || items.length === 0) ctx.throw(400, '请至少提交一条入库明细');
    await assertActiveProducts(Product, items.map(item => item.productId || item.product_id));

    const inboundNo = generateInboundNo();
    const inboundId = generateUUID();

    const totalQuantity = items.reduce((sum, item) => sum + (item.quantity || 0), 0);

    await Inbound.create({
      inbound_id: inboundId,
      inbound_no: inboundNo,
      store_id: storeId,
      source_type: sourceType,
      source_no: sourceNo,
      total_quantity: totalQuantity,
      status: 'pending',
      create_user: user.name,
      create_time: new Date(),
      update_time: new Date()
    });

    for (const item of items) {
      await InboundItem.create({
        inbound_id: inboundId,
        product_id: item.productId,
        product_name: item.productName,
        pn_code: item.pnCode,
        unit_price: item.unitPrice,
        quantity: item.quantity,
        remark: item.remark
      });
    }

    ctx.body = { inboundId, inboundNo, message: '入库单创建成功' };
  } catch (error) {
    console.error('Error in inbound:', error);
    throw error;
  }
}

/**
 * 出库操作
 */
async function outbound(ctx) {
  const user = ctx.state.user;
  const { storeId, outType, items } = ctx.request.body;

  const outboundNo = generateOutboundNo();
  const outboundId = generateUUID();

  ctx.body = { outboundId, outboundNo, message: '出库成功' };
}

/**
 * 调拨操作 - 创建调拨申请
 */
function normalizeTransferRemark(value) {
  return String(value || '').trim().slice(0, 2000);
}

async function transfer(ctx) {
  const t = await sequelize.transaction();
  try {
    const user = ctx.state.user;
    const { fromStoreId, toStoreId, deliveryPlatformId, deliveryPlatformName, freightAmount, remark,
      freight_platform_id, freight_platform_name, freight_amount } = ctx.request.body;
    const normalizedRemark = normalizeTransferRemark(remark);
    const normalizedFreightPlatformId = deliveryPlatformId || freight_platform_id || '';
    const normalizedFreightPlatformName = deliveryPlatformName || freight_platform_name || '';
    const rawFreightAmount = freightAmount === undefined ? freight_amount : freightAmount;
    const normalizedFreightAmount = Number.isFinite(Number(rawFreightAmount))
      ? Math.max(0, Number(Number(rawFreightAmount).toFixed(2)))
      : 0;
    const rawItems = Array.isArray(ctx.request.body.items) ? ctx.request.body.items : [];
    const items = rawItems.map(normalizeTransferItem);

    if (!fromStoreId || !toStoreId) {
      ctx.throw(400, '?????????????');
    }
    if (fromStoreId === toStoreId) {
      ctx.throw(400, '?????????????');
    }
    const transferScope = await assertTransferScope(ctx, fromStoreId, toStoreId);
    if (items.length === 0) {
      ctx.throw(400, '????????');
    }
    if (items.some(item => !item.productId)) {
      ctx.throw(400, '?????????');
    }

    const productIds = [...new Set(items.map(item => item.productId))];
    await assertActiveProducts(Product, productIds, { transaction: t });
    const products = await Product.findAll({
      where: { product_id: { [Op.in]: productIds }, is_deleted: 0 },
      transaction: t
    });
    const productMap = new Map(products.map(product => [product.product_id, product]));
    const normalizedItems = [];

    for (const item of items) {
      const product = productMap.get(item.productId);
      if (!product) {
        ctx.throw(400, `????????${item.productId || '-'}`);
      }

      if (item.productCode && String(product.product_code || '') !== item.productCode) {
        ctx.throw(400, `商品编码 ${item.productCode} 与商品记录不一致`);
      }

      if (item.pnCode && !(await productHasPn(product, item.pnCode, t))) {
        ctx.throw(400, `PN ${item.pnCode} 不属于商品编码 ${item.productId}`);
      }

      if (item.snId || item.snCode) {
        if (!item.snId || !item.snCode) {
          ctx.throw(400, `?? ${product.name} ?SN?????`);
        }
        const sn = await ProductSn.findOne({
          where: {
            sn_id: item.snId,
            sn_code: item.snCode,
            product_id: item.productId,
            store_id: fromStoreId,
            status: 'in_stock',
            is_deleted: 0
          },
          transaction: t
        });
        if (!sn) {
          ctx.throw(400, `SN?[${item.snCode}]???????????`);
        }
        normalizedItems.push({ ...item, quantity: 1, productName: product.name });
        continue;
      }

      const quantity = Math.max(parseInt(item.quantity || 1, 10), 1);
      // The request records the product demand only. Stock is checked and deducted when the source store confirms shipment.
      normalizedItems.push({
        productId: item.productId,
        snId: null,
        snCode: '',
        pnCode: item.pnCode || item.pn_code || '',
        quantity,
        productName: product.name
      });
    }

    const transferNo = generateTransferNo();
    const transferId = generateUUID();
    const totalQuantity = normalizedItems.reduce((sum, item) => sum + Number(item.quantity || 1), 0);

    await Transfer.create({
      transfer_id: transferId,
      transfer_no: transferNo,
      from_store_id: fromStoreId,
      to_store_id: toStoreId,
      freight_platform_id: normalizedFreightPlatformId || null,
      freight_platform_name: normalizedFreightPlatformName || null,
      freight_amount: normalizedFreightAmount,
      total_quantity: totalQuantity,
      outbound_quantity: 0,
      remaining_quantity: totalQuantity,
      remaining_status: 'pending',
      status: 'pending',
      apply_user: user.name || user.staffId,
      remark: normalizedRemark || null,
      distributor_id: transferScope.distributorId,
      region_id: transferScope.regionId
    }, { transaction: t });

    await recordBusinessAction({
      businessType: 'inventory_transfer',
      businessId: transferId,
      businessNo: transferNo,
      action: 'submitted',
      toStatus: 'pending',
      user,
      transaction: t
    });

    for (const item of normalizedItems) {
      await TransferItem.create({
        transfer_id: transferId,
        product_id: item.productId,
        pn_code: item.pnCode || item.pn_code || '',
        sn_id: item.snId || null,
        sn_code: item.snCode || '',
        quantity: item.quantity || 1
      }, { transaction: t });

      if (item.snId && item.snCode) {
        await SnLog.create({
          log_id: generateUUID(),
          sn_id: item.snId,
          sn_code: item.snCode,
          product_id: item.productId,
          store_id: fromStoreId,
          action: 'transfer_out',
          remark: `?????${fromStoreId} -> ${toStoreId}????${transferNo}`,
          create_user: transfer.apply_user || user.name || user.staffId
        }, { transaction: t });
      }
    }

    await syncFreightRecord({
      sourceType: 'transfer',
      sourceId: transferId,
      sourceNo: transferNo,
      platformId: normalizedFreightPlatformId,
      platformName: normalizedFreightPlatformName,
      amount: normalizedFreightAmount,
      fromStoreId,
      toStoreId,
      items: normalizedItems,
      status: 'active',
      user,
      transaction: t
    });

    await t.commit();
    ctx.body = { code: 0, data: { transferId, transferNo }, message: '???????' };
  } catch (err) {
    try {
      await t.rollback();
    } catch (rollbackError) {
      console.error('transfer rollback error:', rollbackError);
    }
    if (err.status) throw err;
    console.error('transfer error:', err);
    throw err;
  }
}

async function getTransferList(ctx) {
  try {
    const {
      status,
      fromStoreId,
      toStoreId,
      transferNo,
      startDate,
      endDate,
      history,
      page = 1,
      pageSize = 20
    } = ctx.query;
    const user = ctx.state.user || {};
    const visibilityLevel = getTransferVisibilityLevel(user);
    let distributorStoreIds = user.accessibleStoreIds || [];

    if (visibilityLevel === 'distributor') {
      const visibleDistributorIds = accessibleDistributorIds(user);
      if (visibleDistributorIds.includes('*') || visibleDistributorIds.length) {
        const stores = await Store.findAll({
          where: { distributor_id: visibleDistributorIds.includes('*') ? { [Op.ne]: null } : { [Op.in]: visibleDistributorIds }, is_deleted: 0, status: 1 },
          attributes: ['store_id']
        });
        distributorStoreIds = stores.map(store => store.store_id);
      } else if ((!Array.isArray(distributorStoreIds) || distributorStoreIds.length === 0) && !getUserRoles(user).includes('boss')) {
        ctx.body = formatPaginatedResult([], { page, pageSize, count: 0 });
        return;
      }
    }

    const where = { [Op.and]: buildTransferVisibilityWhere(user, distributorStoreIds, user.distributorId) };
    if (status) where[Op.and].push({ status });
    if (fromStoreId) where[Op.and].push({ from_store_id: fromStoreId });
    if (toStoreId) where[Op.and].push({ to_store_id: toStoreId });
    if (transferNo) where[Op.and].push({ transfer_no: { [Op.like]: `%${String(transferNo).trim()}%` } });
    if (startDate || endDate) {
      const createTime = {};
      if (startDate) createTime[Op.gte] = `${String(startDate).slice(0, 10)} 00:00:00`;
      if (endDate) createTime[Op.lte] = `${String(endDate).slice(0, 10)} 23:59:59`;
      where[Op.and].push({ create_time: createTime });
    }

    const { count, rows } = await Transfer.findAndCountAll({
      where,
      include: [
        { model: Store, as: 'FromStore', attributes: ['store_id', 'name'] },
        { model: Store, as: 'ToStore', attributes: ['store_id', 'name'] },
        { model: TransferItem, attributes: ['item_id', 'product_id', 'pn_code', 'sn_id', 'sn_code', 'quantity'] }
      ],
      order: String(history || '') === '1' || String(history || '').toLowerCase() === 'true'
        ? [['create_time', 'DESC'], ['transfer_id', 'DESC']]
        : buildPendingFirstOrder(sequelize, {
            statusColumn: 'Transfer.status',
            pendingStatuses: ['pending', 'out_confirmed'],
            dateColumns: ['Transfer.create_time'],
            idColumn: 'Transfer.transfer_id'
          }),
      ...paginate({}, { page, pageSize })
    });

    const productIds = [...new Set(rows.flatMap(row => (row.TransferItems || []).map(item => item.product_id)).filter(Boolean))];
    const products = productIds.length > 0
      ? await Product.findAll({ where: { product_id: { [Op.in]: productIds } }, attributes: ['product_id', 'product_code', 'name', 'need_sn'] })
      : [];
    const productMap = new Map(products.map(product => [product.product_id, product]));
    const transferNos = rows.map(row => row.transfer_no).filter(Boolean);
    const transferInbounds = transferNos.length
      ? await Inbound.findAll({
          where: { source_type: 'TRANSFER', source_no: { [Op.in]: transferNos } },
          attributes: ['inbound_id', 'inbound_no', 'source_no', 'store_id', 'status'],
          raw: true
        })
      : [];
    const inboundMap = new Map(transferInbounds.map(row => [row.source_no, row]));

    const list = rows.map(row => {
      const data = row.toJSON();
      const summary = transferQuantitySummary(data, data.TransferItems || []);
      data.total_quantity = summary.totalQuantity;
      data.outbound_quantity = summary.outboundQuantity;
      data.remaining_quantity = summary.remainingQuantity;
      data.remaining_status = summary.remainingStatus;
      data.TransferItems = visibleTransferItems(data.TransferItems || []).map(item => {
        const product = productMap.get(item.product_id);
        return {
          ...item,
          product_name: product?.name || '',
          product_code: product?.product_code || item.product_id || '',
          need_sn: product?.need_sn || 0
        };
      });
      const inbound = inboundMap.get(data.transfer_no);
      return {
        ...data,
        from_store_name: data.FromStore?.name || '',
        to_store_name: data.ToStore?.name || '',
        inbound_id: inbound?.inbound_id || '',
        inbound_no: inbound?.inbound_no || '',
        inbound_status: inbound?.status || ''
      };
    });

    ctx.body = formatPaginatedResult(list, { page, pageSize, count });
  } catch (err) {
    console.error('getTransferList error:', err);
    ctx.throw(500, '查询调拨列表失败');
  }
}

async function getTransferDetail(ctx) {
  const { transferId } = ctx.params;
  const transfer = await Transfer.findByPk(transferId, {
    include: [
      { model: Store, as: 'FromStore', attributes: ['store_id', 'name', 'distributor_id'] },
      { model: Store, as: 'ToStore', attributes: ['store_id', 'name', 'distributor_id'] },
      { model: TransferItem, attributes: ['item_id', 'product_id', 'pn_code', 'sn_id', 'sn_code', 'quantity'] }
    ]
  });
  if (!transfer) ctx.throw(404, '调拨单不存在');
  const user = ctx.state.user || {};
  let visibleStoreIds = user.accessibleStoreIds || [];
  if (getTransferVisibilityLevel(user) === 'distributor' && accessibleDistributorIds(user).length) {
    const visibleDistributorIds = accessibleDistributorIds(user);
    const stores = await Store.findAll({
      where: { distributor_id: visibleDistributorIds.includes('*') ? { [Op.ne]: null } : { [Op.in]: visibleDistributorIds }, is_deleted: 0, status: 1 },
      attributes: ['store_id']
    });
    visibleStoreIds = stores.map(store => store.store_id);
  }
  const visible = await Transfer.findOne({
    where: {
      transfer_id: transfer.transfer_id,
      [Op.and]: buildTransferVisibilityWhere(user, visibleStoreIds, user.distributorId)
    },
    attributes: ['transfer_id']
  });
  if (!visible) ctx.throw(403, '无权查看该调拨记录');
  if (String(ctx.query.trace || '') === '1' && !canViewSnTraceReference(user, {
    store_id: transfer.store_id,
    from_store_id: transfer.from_store_id,
    to_store_id: transfer.to_store_id,
    distributor_id: transfer.distributor_id || transfer.FromStore?.distributor_id || transfer.ToStore?.distributor_id,
    creator_names: [transfer.apply_user]
  })) {
    ctx.throw(403, '无权查看该调拨原始订单');
  }

  const data = transfer.toJSON();
  const summary = transferQuantitySummary(data, data.TransferItems || []);
  data.total_quantity = summary.totalQuantity;
  data.outbound_quantity = summary.outboundQuantity;
  data.remaining_quantity = summary.remainingQuantity;
  data.remaining_status = summary.remainingStatus;
  const productIds = [...new Set((data.TransferItems || []).map(item => item.product_id).filter(Boolean))];
  const products = productIds.length
    ? await Product.findAll({ where: { product_id: { [Op.in]: productIds } }, attributes: ['product_id', 'name', 'product_code', 'need_sn'], raw: true })
    : [];
  const productMap = new Map(products.map(product => [product.product_id, product]));
  data.TransferItems = visibleTransferItems(data.TransferItems || []).map(item => ({
    ...item,
    product_name: productMap.get(item.product_id)?.name || '',
    product_code: productMap.get(item.product_id)?.product_code || item.product_id || '',
    need_sn: productMap.get(item.product_id)?.need_sn || 0
  }));
  data.from_store_name = data.FromStore?.name || '';
  data.to_store_name = data.ToStore?.name || '';
  data.action_logs = await listBusinessActions('inventory_transfer', transfer.transfer_id);
  ctx.body = { code: 0, data };
}

/**
 * 确认调拨出库（原门店操作）
 */
async function confirmTransferOutPartial(ctx) {
  const t = await sequelize.transaction();
  const createdShippingPhotoPaths = [];
  try {
    const user = ctx.state.user || {};
    const body = ctx.request.body || {};
    const transferId = body.transferId || body.transfer_id;
    const selections = parseArrayBodyValue(body.items).filter(Boolean);
    let shippingPhotos = [];
    const remainingAction = String(body.remainingAction || 'reject').trim().toLowerCase();
    const byItem = new Map();
    const byProduct = new Map();
    selections.forEach(selection => {
      const itemId = selection.itemId || selection.item_id;
      const productId = selection.productId || selection.product_id;
      if (itemId) {
        const key = String(itemId);
        if (!byItem.has(key)) byItem.set(key, []);
        byItem.get(key).push(selection);
      }
      if (productId) {
        const key = String(productId);
        if (!byProduct.has(key)) byProduct.set(key, []);
        byProduct.get(key).push(selection);
      }
    });
    if (!transferId) ctx.throw(400, '调拨单ID不能为空');

    const transfer = await Transfer.findByPk(transferId, {
      include: [{ model: TransferItem }],
      transaction: t,
      lock: t.LOCK.UPDATE
    });
    if (!transfer) ctx.throw(404, '调拨单不存在');
    await assertTransferOperationStore(ctx, transfer.from_store_id);
    if (transfer.status !== 'pending') ctx.throw(400, '调拨单当前不是待出库确认状态');

    const persistedPhotos = await persistTransferShippingPhotos(ctx, transferId);
    shippingPhotos = persistedPhotos.photos;
    createdShippingPhotoPaths.push(...persistedPhotos.storedPaths);
    if (!shippingPhotos.length) ctx.throw(400, '请至少上传一张发货照片');

    const requestItems = getPendingTransferItems(transfer.TransferItems || []);
    if (!requestItems.length) ctx.throw(400, '调拨单没有待处理明细');
    const preselectedSnItems = requestItems.filter(item => buildPreselectedTransferSelection(item));
    if (!selections.length && !preselectedSnItems.length) {
      ctx.throw(400, '请至少选择一项出库商品');
    }
    const productIds = [...new Set(requestItems.map(item => item.product_id).filter(Boolean))];
    await assertActiveProducts(Product, productIds, { transaction: t });
    const products = await Product.findAll({
      where: { product_id: { [Op.in]: productIds }, is_deleted: 0 },
      transaction: t
    });
    const productMap = new Map(products.map(product => [String(product.product_id), product]));
    const selectedSnIds = new Set();
    let outboundQuantity = 0;

    for (const requestItem of requestItems) {
      const product = productMap.get(String(requestItem.product_id));
      if (!product) ctx.throw(400, `商品 ${requestItem.product_id} 不存在`);
      const preselected = buildPreselectedTransferSelection(requestItem);
      const selected = byItem.get(String(requestItem.item_id))
        || byProduct.get(String(requestItem.product_id))
        || (preselected ? [preselected] : []);
      if (!selected.length) ctx.throw(400, `请选择商品 ${product.name || requestItem.product_id} 的出库库存`);

      if (preselected) {
        if (Number(product.need_sn) !== 1) {
          ctx.throw(400, `商品 ${product.name} 的调拨明细不能绑定 SN`);
        }
        if (selected.length !== 1) {
          ctx.throw(400, `SN商品 ${product.name} 必须使用原SN`);
        }
        const selectedSnId = selected[0].snId || selected[0].sn_id || selected[0].inventoryId || selected[0].inventory_id || '';
        const selectedSnCode = String(selected[0].snCode || selected[0].sn_code || '').trim();
        if ((preselected.snId && String(selectedSnId) !== String(preselected.snId))
          || (preselected.snCode && selectedSnCode !== String(preselected.snCode).trim())) {
          ctx.throw(400, `SN ${preselected.snCode || preselected.snId} 不允许替换`);
        }
        if (!preselected.snId || !preselected.snCode) {
          ctx.throw(400, `SN商品 ${product.name} 必须填写具体SN`);
        }
        const sn = await ProductSn.findOne({
          where: {
            sn_id: preselected.snId,
            sn_code: preselected.snCode,
            product_id: requestItem.product_id,
            store_id: transfer.from_store_id,
            status: 'in_stock',
            is_deleted: 0
          },
          transaction: t,
          lock: t.LOCK.UPDATE
        });
        if (!sn) ctx.throw(400, `SN ${preselected.snCode} 不在调出门店可用库存中`);
        const pnCode = String(selected[0].pnCode || selected[0].pn_code || selected[0].pn || requestItem.pn_code || sn.pn_code || '').trim();
        if (!pnCode || !(await productHasPn(product, pnCode, t))) {
          ctx.throw(400, `请选择商品 ${product.name} 的有效PN`);
        }
        if (sn.pn_code && !samePnCode(sn.pn_code, pnCode)) {
          ctx.throw(400, `SN ${preselected.snCode} 与PN ${pnCode} 不匹配`);
        }
        if (selectedSnIds.has(String(sn.sn_id))) {
          ctx.throw(400, `SN ${sn.sn_code} 不能重复选择`);
        }
        selectedSnIds.add(String(sn.sn_id));
        await sn.update({ status: 'transferring' }, { transaction: t });
        await requestItem.update({ pn_code: pnCode, quantity: 1 }, { transaction: t });
        await SnLog.create({
          log_id: generateUUID(),
          sn_id: sn.sn_id,
          sn_code: sn.sn_code,
          product_id: requestItem.product_id,
          store_id: transfer.from_store_id,
          action: 'transfer_out_confirm',
          remark: `调拨出库确认：${transfer.from_store_id} → ${transfer.to_store_id}，单号：${transfer.transfer_no}`,
          create_user: transfer.apply_user || user.name || user.staffId
        }, { transaction: t });
        await updateInventory(requestItem.product_id, transfer.from_store_id, 'normal_qty', -1, t);
        outboundQuantity += 1;
        continue;
      }

      if (Number(product.need_sn) === 1) {
        if (selected.length > Number(requestItem.quantity || 0)) {
          ctx.throw(400, `商品 ${product.name} 选择的SN数量超过申请数量`);
        }
        const defaultPn = String(selected[0].pnCode || selected[0].pn_code || selected[0].pn || requestItem.pn_code || '').trim();
        if (!defaultPn || !(await productHasPn(product, defaultPn, t))) {
          ctx.throw(400, `请选择商品 ${product.name} 的有效PN`);
        }
        await requestItem.update({ quantity: 0, pn_code: defaultPn }, { transaction: t });
        for (const selection of selected) {
          const snId = selection.snId || selection.sn_id || selection.inventoryId || selection.inventory_id || '';
          const snCode = String(selection.snCode || selection.sn_code || '').trim();
          const pnCode = String(selection.pnCode || selection.pn_code || selection.pn || defaultPn).trim();
          if (!snId || !snCode) ctx.throw(400, `SN商品 ${product.name} 必须填写具体SN`);
          if (selectedSnIds.has(String(snId))) ctx.throw(400, `SN ${snCode} 不能重复选择`);
          selectedSnIds.add(String(snId));
          if (!(await productHasPn(product, pnCode, t))) ctx.throw(400, `PN ${pnCode} 不属于商品 ${product.name}`);
          const sn = await ProductSn.findOne({
            where: {
              sn_id: snId,
              sn_code: snCode,
              product_id: requestItem.product_id,
              store_id: transfer.from_store_id,
              status: 'in_stock',
              is_deleted: 0
            },
            transaction: t,
            lock: t.LOCK.UPDATE
          });
          if (!sn) ctx.throw(400, `SN ${snCode} 不在调出门店可用库存中`);
          if (sn.pn_code && !samePnCode(sn.pn_code, pnCode)) ctx.throw(400, `SN ${snCode} 与PN ${pnCode} 不匹配`);
          await sn.update({ status: 'transferring' }, { transaction: t });
          await TransferItem.create({
            transfer_id: transfer.transfer_id,
            product_id: requestItem.product_id,
            pn_code: pnCode,
            sn_id: sn.sn_id,
            sn_code: sn.sn_code,
            quantity: 1
          }, { transaction: t });
          await SnLog.create({
            log_id: generateUUID(),
            sn_id: sn.sn_id,
            sn_code: sn.sn_code,
            product_id: requestItem.product_id,
            store_id: transfer.from_store_id,
            action: 'transfer_out_confirm',
            remark: `调拨出库确认：${transfer.from_store_id} → ${transfer.to_store_id}，单号：${transfer.transfer_no}`,
            create_user: transfer.apply_user || user.name || user.staffId
          }, { transaction: t });
          outboundQuantity += 1;
        }
        await updateInventory(requestItem.product_id, transfer.from_store_id, 'normal_qty', -selected.length, t);
        continue;
      }

      const selectedQuantity = Math.max(selected.reduce((sum, row) => {
        const value = Number(row.quantity);
        return sum + (Number.isFinite(value) && value > 0 ? value : 1);
      }, 0), 1);
      if (selectedQuantity > Number(requestItem.quantity || 0)) {
        ctx.throw(400, `商品 ${product.name} 选择的数量超过申请数量`);
      }
      const selectedPn = String(selected[0].pnCode || selected[0].pn_code || selected[0].pn || requestItem.pn_code || '').trim();
      if (!selectedPn || !(await productHasPn(product, selectedPn, t))) {
        ctx.throw(400, `请选择商品 ${product.name} 的有效PN`);
      }
      const availableQty = await getTransferableStock(product, requestItem.product_id, transfer.from_store_id, t);
      if (availableQty < selectedQuantity) ctx.throw(400, `商品 ${product.name} 库存不足`);
      await requestItem.update({ quantity: selectedQuantity, pn_code: selectedPn }, { transaction: t });
      await updateInventory(requestItem.product_id, transfer.from_store_id, 'normal_qty', -selectedQuantity, t);
      outboundQuantity += selectedQuantity;
    }

    const totalQuantity = Math.max(Number(transfer.total_quantity || 0), 0);
    const remainingQuantity = Math.max(totalQuantity - outboundQuantity, 0);
    if (remainingQuantity > 0 && remainingAction !== 'reject') {
      ctx.throw(400, '部分出库必须确认拒收剩余数量');
    }
    const actualItems = visibleTransferItems(await TransferItem.findAll({
      where: { transfer_id: transfer.transfer_id },
      transaction: t
    }));
    const productMapForInbound = new Map(products.map(product => [String(product.product_id), product]));
    await transfer.update({
      status: 'out_confirmed',
      outbound_quantity: outboundQuantity,
      remaining_quantity: remainingQuantity,
      remaining_status: remainingQuantity > 0 ? 'rejected' : 'fulfilled',
      confirm_user: user.name || user.staffId,
      shipping_user: user.name || user.staffId,
      shipping_photos: shippingPhotos,
      shipping_time: new Date()
    }, { transaction: t });
    await recordBusinessAction({
      businessType: 'inventory_transfer',
      businessId: transfer.transfer_id,
      businessNo: transfer.transfer_no,
      action: remainingQuantity > 0 ? 'outbound_partially_confirmed' : 'outbound_confirmed',
      fromStatus: 'pending',
      toStatus: 'out_confirmed',
      user,
      detail: { shippingPhotos: shippingPhotos.length, outboundQuantity, remainingQuantity, remainingAction },
      transaction: t
    });
    await ensureTransferInbound(transfer, actualItems.map(item => ({
      product_id: item.product_id,
      product_name: productMapForInbound.get(String(item.product_id))?.name || '',
      pn_code: item.pn_code,
      sn_id: item.sn_id,
      sn_code: item.sn_code,
      quantity: item.quantity
    })), t);
    await t.commit();
    ctx.body = {
      code: 0,
      data: { transferId: transfer.transfer_id, outboundQuantity, remainingQuantity, remainingStatus: remainingQuantity > 0 ? 'rejected' : 'fulfilled' },
      message: remainingQuantity > 0 ? '部分出库已确认，剩余数量已拒收' : '出库已确认'
    };
  } catch (err) {
    await t.rollback();
    await Promise.all(createdShippingPhotoPaths.map(filePath => fs.promises.unlink(filePath).catch(() => {})));
    if (err.status) ctx.throw(err.status, err.message);
    console.error('confirmTransferOut partial error:', err);
    ctx.throw(500, '出库确认失败');
  }
}

async function confirmTransferOut(ctx) {
  const t = await sequelize.transaction();
  try {
    const user = ctx.state.user;
    const { transferId } = ctx.request.body;
    const requestedSelections = Array.isArray(ctx.request.body.items) ? ctx.request.body.items.filter(Boolean) : [];
    const selectedSnByItemId = new Map(
      requestedSelections
        .map(item => ({
          itemId: item && (item.itemId || item.item_id || item.transferItemId || item.transfer_item_id),
          snId: item && (item.snId || item.sn_id || item.inventoryId || item.inventory_id)
        }))
        .filter(item => item.itemId && item.snId)
        .map(item => [String(item.itemId), item.snId])
    );
    const selectedByProductId = new Map();
    requestedSelections.forEach(item => {
      const productId = item.productId || item.product_id;
      if (!productId) return;
      if (!selectedByProductId.has(String(productId))) selectedByProductId.set(String(productId), []);
      selectedByProductId.get(String(productId)).push(item);
    });
    const selectedSnIds = new Set();
    const shippingPhotos = Array.isArray(ctx.request.body.shippingPhotos) ? ctx.request.body.shippingPhotos.filter(Boolean).slice(0, 9) : [];

    const transfer = await Transfer.findByPk(transferId, {
      include: [{ model: TransferItem }],
      transaction: t
    });

    if (!transfer) {
      ctx.throw(404, '??????');
    }
    assertStoreVisible(ctx, transfer.from_store_id);
    const pendingTransferStatuses = new Set(['pending', 'requested', 'applied', 'shipping']);
    if (!pendingTransferStatuses.has(String(transfer.status || '').toLowerCase())) {
      ctx.throw(400, '???????????');
    }

    const items = transfer.TransferItems || [];
    if (!requestedSelections.length) {
      ctx.throw(400, '请先选择实际出库商品');
    }
    if (!shippingPhotos.length) {
      ctx.throw(400, '请上传至少一张出库凭证照片');
    }
    const productIds = [...new Set(items.map(item => item.product_id).filter(Boolean))];
    await assertActiveProducts(Product, productIds, { transaction: t });
    const products = productIds.length > 0
      ? await Product.findAll({ where: { product_id: { [Op.in]: productIds } }, transaction: t })
      : [];
    const productMap = new Map(products.map(product => [product.product_id, product]));

    for (const item of items) {
      const product = productMap.get(item.product_id);
      let snId = item.sn_id;
      let snCode = item.sn_code;
      const quantity = Number(item.quantity || 1);
      const productSelections = selectedByProductId.get(String(item.product_id)) || [];
      const selected = selectedSnByItemId.get(String(item.item_id))
        ? requestedSelections.find(selection => String(selection.itemId) === String(item.item_id))
        : productSelections[0];
      const selectedPnCode = String(selected?.pnCode || selected?.pn_code || selected?.pn || '').trim();
      if (!selectedPnCode) {
        ctx.throw(400, `商品 ${product?.name || item.product_id} 出库时必须选择 PN`);
      }
      if (selected && String(selected.productId || selected.product_id) !== String(item.product_id)) {
        ctx.throw(400, '出库商品与申请商品不一致');
      }

      if (!(await productHasPn(product, selectedPnCode, t))) {
        ctx.throw(400, `PN ${selectedPnCode} 不属于商品编码 ${item.product_id}`);
      }

      if (product && Number(product.need_sn) === 1) {
        const selectedSnId = selected?.snId || selected?.inventoryId || selected?.inventory_id || '';
        const selectedSnCode = String(selected?.snCode || selected?.sn_code || '').trim();
        if (!selectedSnId || !selectedSnCode) {
          ctx.throw(400, `商品 ${product.name} 为 SN 商品，必须选择 SN`);
        }
        const selectedSn = await ProductSn.findOne({
          where: {
            sn_id: selectedSnId,
            sn_code: selectedSnCode,
            product_id: item.product_id,
            store_id: transfer.from_store_id,
            status: 'in_stock',
            is_deleted: 0
          },
          transaction: t
        });
        if (!selectedSn) {
          ctx.throw(400, `SN ${selectedSnCode} 不属于调出门店的商品编码 ${item.product_id}`);
        }
        if (selectedSn.pn_code && !samePnCode(selectedSn.pn_code, selectedPnCode)) {
          ctx.throw(400, `SN ${selectedSnCode} 与选择的 PN 不匹配`);
        }
        snId = selectedSn.sn_id;
        snCode = selectedSn.sn_code;
      }

      if (!snId && product && Number(product.need_sn) === 1) {
        snId = selectedSnByItemId.get(String(item.item_id)) || selected?.snId || selected?.inventoryId || selected?.inventory_id || '';
        if (!snId) {
          ctx.throw(400, `商品 ${product.name} 需要选择SN后才能确认出库`);
        }
      }

      if (snId && !snCode) {
        if (selectedSnIds.has(snId)) {
          ctx.throw(400, '同一个SN不能重复选择');
        }
        selectedSnIds.add(snId);

        const sn = await ProductSn.findOne({
          where: {
            sn_id: snId,
            product_id: item.product_id,
            store_id: transfer.from_store_id,
            status: 'in_stock',
            is_deleted: 0
          },
          transaction: t
        });
        if (!sn) {
          ctx.throw(400, `商品 ${product?.name || item.product_id} 选择的SN不在当前门店可用库存中`);
        }
        snId = sn.sn_id;
        snCode = sn.sn_code;
      } else if (snId) {
        if (selectedSnIds.has(snId)) {
          ctx.throw(400, '同一个SN不能重复选择');
        }
        selectedSnIds.add(snId);
      }

      // 无论 SN 是通过下拉选择还是手工传入，都必须把 SN 关联持久化到调拨明细。
      // 否则确认入库时无法从 T_TRANSFER_ITEM 找到对应 ProductSn，SN 会一直停留在 transferring。
      if (snId && snCode) {
        await item.update({
          pn_code: selectedPnCode,
          sn_id: snId,
          sn_code: snCode,
          quantity: 1
        }, { transaction: t });
      }

      if (!item.pn_code || item.pn_code !== selectedPnCode) {
        await item.update({ pn_code: selectedPnCode }, { transaction: t });
      }

      if (selected && selected.productId && String(selected.productId) !== String(item.product_id)) {
        ctx.throw(400, '出库商品与申请商品不一致');
      }
      if (product && Number(product.need_sn) !== 1) {
        const availableQty = await getTransferableStock(product, item.product_id, transfer.from_store_id, t);
        if (availableQty < quantity) {
          ctx.throw(400, `商品 ${product.name} 当前库存不足，现有${availableQty}，需要${quantity}`);
        }
      }

      if (snId && snCode) {
        const [updated] = await ProductSn.update(
          { status: 'transferring' },
          {
            where: {
              sn_id: snId,
              product_id: item.product_id,
              store_id: transfer.from_store_id,
              status: 'in_stock',
              is_deleted: 0
            },
            transaction: t
          }
        );
        if (updated === 0) {
          ctx.throw(400, `SN?[${snCode}]???????????`);
        }

        await SnLog.create({
          log_id: generateUUID(),
          sn_id: snId,
          sn_code: snCode,
          product_id: item.product_id,
          store_id: transfer.from_store_id,
          action: 'transfer_out_confirm',
          remark: `???????${transfer.from_store_id} -> ${transfer.to_store_id}????${transfer.transfer_no}`,
          create_user: transfer.apply_user || user.name || user.staffId
        }, { transaction: t });
      }

      await updateInventory(item.product_id, transfer.from_store_id, 'normal_qty', -quantity, t);
    }

    await transfer.update({
      status: 'out_confirmed',
      confirm_user: user.name || user.staffId,
      shipping_user: user.name || user.staffId,
      shipping_photos: shippingPhotos,
      shipping_time: new Date()
    }, { transaction: t });
    await recordBusinessAction({
      businessType: 'inventory_transfer',
      businessId: transfer.transfer_id,
      businessNo: transfer.transfer_no,
      action: 'outbound_confirmed',
      fromStatus: 'pending',
      toStatus: 'out_confirmed',
      user,
      detail: { shippingPhotos: shippingPhotos.length },
      transaction: t
    });

    await ensureTransferInbound(transfer, items.map(item => ({
      product_id: item.product_id,
      product_name: productMap.get(item.product_id)?.name || '',
      pn_code: item.pn_code,
      sn_id: item.sn_id,
      sn_code: item.sn_code,
      quantity: item.quantity
    })), t);

    await t.commit();
    ctx.body = { code: 0, message: '????????' };
  } catch (err) {
    await t.rollback();
    if (err.status) ctx.throw(err.status, err.message);
    console.error('confirmTransferOut error:', err);
    ctx.throw(500, '????????');
  }
}

async function confirmTransferIn(ctx) {
  const t = await sequelize.transaction();
  try {
    const user = ctx.state.user;
    const { transferId } = ctx.request.body;
    const requestedItems = Array.isArray(ctx.request.body.items) ? ctx.request.body.items.filter(Boolean) : [];
    const receivingPhotos = Array.isArray(ctx.request.body.receivingPhotos) ? ctx.request.body.receivingPhotos.filter(Boolean).slice(0, 9) : [];

    const transfer = await Transfer.findByPk(transferId, {
      include: [{ model: TransferItem }],
      transaction: t,
      lock: t.LOCK.UPDATE
    });

    if (!transfer) {
      ctx.throw(404, '调拨单不存在');
    }
    await assertTransferOperationStore(ctx, transfer.to_store_id);

    const transferInbound = await Inbound.findOne({
      where: { source_type: 'TRANSFER', source_no: transfer.transfer_no, status: 'pending' },
      transaction: t,
      lock: t.LOCK.UPDATE
    });
    const isTransferInbound = Boolean(transferInbound);
    // 已完成的历史调拨如果仍有 transferring SN，允许带 inventoryId 重试一次做状态修复；
    // 普通重复确认仍直接返回，避免重复增加聚合库存。
    const hasRepairableSn = (transfer.TransferItems || []).some(item => item.sn_id) || requestedItems.some(item => (
      item.snId || item.sn_id || item.inventoryId || item.inventory_id
    ));
    if (transfer.status === 'completed' && !hasRepairableSn) {
      await t.commit();
      ctx.body = { code: 0, message: '调拨已完成' };
      return;
    }
    if (!['out_confirmed', 'completed'].includes(transfer.status)) {
      ctx.throw(400, '当前状态不允许确认入库');
    }

    const items = visibleTransferItems(transfer.TransferItems || []);
    const requestedByItemId = new Map(
      requestedItems
        .filter(item => item.itemId || item.item_id)
        .map(item => [String(item.itemId || item.item_id), item])
    );
    const productIds = [...new Set(items.map(item => item.product_id).filter(Boolean))];
    await assertActiveProducts(Product, productIds, { transaction: t });
    const products = productIds.length
      ? await Product.findAll({ where: { product_id: { [Op.in]: productIds } }, transaction: t })
      : [];
    const productMap = new Map(products.map(product => [String(product.product_id), product]));
    const transferInboundItems = transferInbound
      ? await InboundItem.findAll({
          where: { inbound_id: transferInbound.inbound_id },
          order: [['item_id', 'ASC']],
          transaction: t
        })
      : [];
    const defaultTransferLocation = transferInbound
      ? await Location.findOne({
          where: { store_id: transfer.to_store_id, status: 1, type: 'normal_qty' },
          attributes: ['location_id'],
          transaction: t
        })
      : null;

    const requestedLocationIds = [...new Set(
      requestedItems
        .map(item => item.locationId || item.location_id)
        .filter(Boolean)
        .map(String)
    )];
    if (requestedLocationIds.length) {
      const validLocations = await Location.findAll({
        where: {
          location_id: { [Op.in]: requestedLocationIds },
          store_id: transfer.to_store_id,
          status: 1
        },
        attributes: ['location_id'],
        transaction: t
      });
      const validLocationIds = new Set(validLocations.map(location => String(location.location_id)));
      const invalidLocationId = requestedLocationIds.find(locationId => !validLocationIds.has(locationId));
      if (invalidLocationId) {
        ctx.throw(400, '入库库位不存在、已停用或不属于调入门店');
      }
    }

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const requested = requestedByItemId.get(String(item.item_id)) || requestedItems[index] || {};
      const product = productMap.get(String(item.product_id));
      const inboundItem = transferInboundItems[index];
      const snBinding = resolveTransferInboundSnBinding(item, inboundItem, requested);
      if (isTransferInbound && product && Number(product.need_sn) === 1) {
        if (snBinding.sourceSnIdMismatch || snBinding.sourceSnCodeMismatch) {
          ctx.throw(409, '调拨明细与待入库明细的 SN 不一致');
        }
        if (snBinding.requestedSnIdMismatch || snBinding.requestedSnCodeMismatch) {
          ctx.throw(400, '调拨入库 SN 不允许替换');
        }
      }
      const snId = snBinding.snId;
      const expectedSnCode = snBinding.snCode;
      const locationId = requested.locationId || requested.location_id || defaultTransferLocation?.location_id || '';
      const quantity = Math.max(Number(item.quantity || requested.quantity || 1), 1);

      if (product && Number(product.need_sn) === 1 && !snId) {
        ctx.throw(400, `商品 ${product.name || item.product_id} 缺少关联SN，无法确认入库`);
      }

      let alreadyInDestination = false;
      if (snId) {
        const sn = await ProductSn.findOne({
          where: { sn_id: snId, product_id: item.product_id, is_deleted: 0 },
          transaction: t,
          lock: t.LOCK.UPDATE
        });
        if (!sn) {
          ctx.throw(400, `SN ${expectedSnCode || snId} 不存在或与商品不匹配`);
        }
        if (expectedSnCode && String(sn.sn_code) !== expectedSnCode) {
          ctx.throw(400, `SN ${expectedSnCode} 与库存记录不匹配`);
        }
        if (!['transferring', 'in_stock'].includes(sn.status)) {
          ctx.throw(400, `SN ${sn.sn_code} 当前状态为 ${sn.status}，不允许调拨入库`);
        }
        if (sn.status === 'in_stock') {
          if (String(sn.store_id) !== String(transfer.to_store_id)) {
            ctx.throw(400, `SN ${sn.sn_code} 已在其他门店库存中`);
          }
          alreadyInDestination = true;
        } else if (sn.store_id && String(sn.store_id) !== String(transfer.from_store_id)) {
          ctx.throw(400, `SN ${sn.sn_code} 不属于本次调拨的调出门店`);
        }

        const targetLocationId = locationId || (alreadyInDestination ? sn.location_id || '' : '');
        await sn.update({
          store_id: transfer.to_store_id,
          status: 'in_stock',
          location_id: targetLocationId || null
          // 调拨到店不改变公司首次采购入库时间，库龄继续从原始入库计算。
        }, { transaction: t });

        if (!alreadyInDestination) {
          await SnLog.create({
            log_id: generateUUID(),
            sn_id: sn.sn_id,
            sn_code: sn.sn_code,
            product_id: item.product_id,
            store_id: transfer.to_store_id,
            action: 'transfer_in_confirm',
            remark: `调拨入库确认：${transfer.from_store_id} → ${transfer.to_store_id}，单号：${transfer.transfer_no}`,
            create_user: transfer.apply_user || user.name || user.staffId
          }, { transaction: t });
        }

        const transferItemUpdate = {};
        if (String(item.sn_id || '') !== String(sn.sn_id)) transferItemUpdate.sn_id = sn.sn_id;
        if (String(item.sn_code || '') !== String(sn.sn_code)) transferItemUpdate.sn_code = sn.sn_code;
        if (Object.keys(transferItemUpdate).length) {
          await item.update(transferItemUpdate, { transaction: t });
        }

        if (inboundItem) {
          await inboundItem.update({
            sn_id: sn.sn_id,
            sn_code: sn.sn_code,
            location_id: targetLocationId || null
          }, { transaction: t });
        }
      }

      if (!alreadyInDestination) {
        await updateInventory(item.product_id, transfer.to_store_id, 'normal_qty', quantity, t, locationId);
      }
    }

    if (transferInbound) {
      await transferInbound.update({ status: 'completed', update_time: new Date() }, { transaction: t });
    }

    if (transfer.status === 'out_confirmed') {
      await transfer.update({
        status: 'completed',
        inbound_confirm_user: user.name || user.staffId,
        receiving_user: user.name || user.staffId,
        receiving_photos: receivingPhotos,
        receiving_time: new Date()
      }, { transaction: t });
      await recordBusinessAction({
        businessType: 'inventory_transfer',
        businessId: transfer.transfer_id,
        businessNo: transfer.transfer_no,
        action: 'inbound_confirmed',
        fromStatus: 'out_confirmed',
        toStatus: 'completed',
        user,
        detail: { receivingPhotos: receivingPhotos.length },
        transaction: t
      });
    }

    await t.commit();
    ctx.body = { code: 0, message: '调拨入库确认成功，调拨完成' };
  } catch (err) {
    await t.rollback();
    if (err.status) ctx.throw(err.status, err.message);
    console.error('confirmTransferIn error:', err);
    ctx.throw(500, '确认调拨入库失败');
  }
}

/**
 * 生成退库单号
 */
function generateReturnNo() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  const second = String(now.getSeconds()).padStart(2, '0');
  const random = Math.floor(Math.random() * 900) + 100;
  return `RTN${year}${month}${day}${hour}${minute}${second}${random}`;
}

function getProductTypeInventoryField(productType) {
  const map = {
    '服务商全资源': 'regular_qty',
    '含税仅国补': 'subsidy_qty',
    '含税无国补': 'regular_qty',
    '未税': 'second_qty',
    '正规货': 'regular_qty',
    '国补货': 'subsidy_qty',
    '纯二批': 'second_qty'
  };
  return map[productType] || null;
}

function generateConversionNo(type = 'split') {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  const second = String(now.getSeconds()).padStart(2, '0');
  const random = Math.floor(Math.random() * 900) + 100;
  return `${type === 'assemble' ? 'ASM' : 'SPL'}${year}${month}${day}${hour}${minute}${second}${random}`;
}

function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function normalizeConversionType(value) {
  return value === 'assemble' ? 'assemble' : 'split';
}

async function ensurePn(productId, pnCode, transaction) {
  const product = await Product.findOne({
    where: { product_id: productId, is_deleted: 0, status: 1 },
    attributes: ['product_id', 'product_code', 'need_sn', 'manufacturer_code'],
    transaction
  });
  if (!product) return null;
  const code = Number(product.need_sn) === 1
    ? await resolveSnProductPn(product, pnCode, transaction)
    : normalizePnCode(pnCode);
  if (!code) return null;
  return ensureProductPnMaster({ productId, pnCode: code, transaction });
  /*
  let pn = await ProductPn.findOne({ where: { pn_code: code, is_deleted: 0 }, transaction });
  if (pn && String(pn.product_id) !== String(productId)) {
    const err = new Error(`PN ${code} 已绑定其他商品，不能重复关联`);
    err.status = 400;
    throw err;
  }
  if (!pn) {
    pn = await ProductPn.create({
      pn_id: generateUUID(),
      product_id: productId,
      pn_code: code,
      barcode: '',
      is_primary: 0,
      status: 1,
      is_deleted: 0
    }, { transaction });
  }
  return pn;
  */
}

async function setProductCostPrice(productId, costPrice, user, transaction) {
  let price = await ProductPrice.findOne({ where: { product_id: productId }, transaction });
  const payload = {
    cost_price: money(costPrice),
    effective_time: new Date(),
    create_user: user.name || user.staffId || 'system'
  };
  if (price) {
    if (Number(price.standard_price || 0) <= 0 && money(costPrice) > 0) {
      payload.standard_price = money(costPrice);
    }
    await price.update(payload, { transaction });
  } else {
    await ProductPrice.create({
      price_id: generateUUID(),
      product_id: productId,
      standard_price: money(costPrice),
      min_sale_price: 0,
      status: 1,
      ...payload
    }, { transaction });
  }
}

async function getAvailableQty(productId, storeId, inventoryType, locationId, transaction) {
  const column = inventoryType || 'normal_qty';
  const where = { product_id: productId, store_id: storeId };
  if (locationId) where.location_id = locationId;
  const rows = await Inventory.findAll({ where, transaction });
  return rows.reduce((sum, inv) => {
    if (column === 'normal_qty') {
      const detailTotal = Number(inv.regular_qty || 0) + Number(inv.subsidy_qty || 0) + Number(inv.second_qty || 0);
      return sum + Math.max(Number(inv.normal_qty || 0), detailTotal);
    }
    return sum + Number(inv[column] || 0);
  }, 0);
}

async function buildConversionSourceRows(sourceItems, conversionType, storeId, transaction) {
  if (!Array.isArray(sourceItems) || sourceItems.length === 0) {
    const label = conversionType === 'assemble' ? '组装组件' : '被拆商品';
    const err = new Error(`请添加${label}`);
    err.status = 400;
    throw err;
  }

  const rows = [];
  for (const raw of sourceItems) {
    const productId = raw.productId || raw.product_id;
    const product = await Product.findOne({
      where: { product_id: productId, is_deleted: 0, status: 1 },
      transaction
    });
    if (!product) {
      const err = new Error(`来源商品不存在：${productId || ''}`);
      err.status = 400;
      throw err;
    }

    let snRecord = null;
    let inventoryType = raw.inventoryType || raw.inventory_type || 'normal_qty';
    let locationId = raw.locationId || raw.location_id || '';
    let quantity = Math.max(1, parseInt(raw.quantity, 10) || 1);
    let pnCode = normalizePnCode(raw.pnCode || raw.pn_code || '');
    let snCode = String(raw.snCode || raw.sn_code || '').trim();

    if (Number(product.need_sn) === 1) {
      pnCode = await resolveSnProductPn(product, pnCode, transaction);
      if (!raw.snId && !raw.sn_id && !snCode) {
        const err = new Error(`来源商品 ${product.name} 需要SN管理，请选择SN`);
        err.status = 400;
        throw err;
      }
      const snWhere = {
        product_id: product.product_id,
        store_id: storeId,
        status: 'in_stock',
        is_deleted: 0
      };
      if (raw.snId || raw.sn_id) snWhere.sn_id = raw.snId || raw.sn_id;
      if (snCode) snWhere.sn_code = snCode;
      if (pnCode) snWhere.pn_code = pnCode;
      snRecord = await ProductSn.findOne({ where: snWhere, transaction });
      if (!snRecord) {
        const err = new Error(`来源商品 ${product.name} 未找到可转换的在库SN`);
        err.status = 400;
        throw err;
      }
      quantity = 1;
      inventoryType = snRecord.inventory_type || inventoryType;
      locationId = snRecord.location_id || locationId || '';
      pnCode = snRecord.pn_code || pnCode;
      snCode = snRecord.sn_code || snCode;
    } else {
      const available = await getAvailableQty(product.product_id, storeId, inventoryType, locationId, transaction);
      if (available < quantity) {
        const err = new Error(`来源商品 ${product.name} 库存不足，可用 ${available}，需要 ${quantity}`);
        err.status = 400;
        throw err;
      }
    }

    let fallbackCost = 0;
    if (Number(product.need_sn) !== 1) {
      const price = await ProductPrice.findOne({ where: { product_id: product.product_id }, transaction });
      fallbackCost = Number(price?.cost_price || 0);
    }
    const unitCost = Number(product.need_sn) === 1
      ? money(snRecord?.inbound_price ?? raw.unitCost ?? raw.unit_cost ?? 0)
      : money(conversionType === 'split' && fallbackCost > 0 ? fallbackCost : (raw.unitCost ?? raw.unit_cost ?? fallbackCost));
    if (unitCost <= 0) {
      const err = new Error(`来源商品 ${product.name} 的单位成本必须大于0`);
      err.status = 400;
      throw err;
    }

    rows.push({
      line_role: 'source',
      product,
      product_id: product.product_id,
      product_name: product.name,
      pn_code: pnCode,
      sn_id: snRecord?.sn_id || raw.snId || raw.sn_id || null,
      sn_code: snCode,
      quantity,
      unit_cost: unitCost,
      total_cost: money(unitCost * quantity),
      inventory_type: inventoryType,
      location_id: locationId,
      snRecord,
      remark: raw.remark || ''
    });
  }
  return rows;
}

async function buildConversionTargetRows(targetItems, conversionType, storeId, sourceRows, transaction) {
  if (!Array.isArray(targetItems) || targetItems.length === 0) {
    const label = conversionType === 'assemble' ? '组装成品' : '拆出商品';
    const err = new Error(`请添加${label}`);
    err.status = 400;
    throw err;
  }

  const defaultSourceSn = sourceRows.length === 1 ? sourceRows[0] : null;
  const rows = [];
  for (const raw of targetItems) {
    const productId = raw.productId || raw.product_id;
    const product = await Product.findOne({
      where: { product_id: productId, is_deleted: 0, status: 1 },
      transaction
    });
    if (!product) {
      const err = new Error(`目标商品不存在：${productId || ''}`);
      err.status = 400;
      throw err;
    }

    const inventoryType = raw.inventoryType || raw.inventory_type || 'normal_qty';
    const locationId = raw.locationId || raw.location_id || '';
    const quantity = Number(product.need_sn) === 1 ? 1 : Math.max(1, parseInt(raw.quantity, 10) || 1);
    const unitCost = money(raw.unitCost ?? raw.unit_cost ?? 0);
    const totalCost = money(raw.totalCost ?? raw.total_cost ?? unitCost * quantity);
    const finalUnitCost = unitCost > 0 ? unitCost : money(totalCost / quantity);
    const pnCode = Number(product.need_sn) === 1
      ? await resolveSnProductPn(product, raw.pnCode || raw.pn_code || '', transaction)
      : normalizePnCode(raw.pnCode || raw.pn_code || splitCodes(product.manufacturer_code)[0] || '');
    const snCode = String(raw.snCode || raw.sn_code || '').trim();

    if (totalCost <= 0 || finalUnitCost <= 0) {
      const err = new Error(`目标商品 ${product.name} 的成本必须大于0`);
      err.status = 400;
      throw err;
    }

    if (Number(product.need_sn) === 1) {
      if (!snCode) {
        const err = new Error(`目标商品 ${product.name} 需要SN管理，请录入SN`);
        err.status = 400;
        throw err;
      }
      const existingSn = await ProductSn.findOne({
        where: { pn_code: pnCode, sn_code: snCode, is_deleted: 0 },
        transaction
      });
      if (existingSn) {
        const err = new Error(`PN码 [${pnCode || '-'}] 下的SN码 [${snCode}] 已存在`);
        err.status = 400;
        throw err;
      }
    }

    rows.push({
      line_role: 'target',
      product,
      product_id: product.product_id,
      product_name: product.name,
      pn_code: pnCode,
      sn_id: null,
      sn_code: snCode,
      source_sn_id: raw.sourceSnId || raw.source_sn_id || defaultSourceSn?.sn_id || null,
      source_sn_code: raw.sourceSnCode || raw.source_sn_code || defaultSourceSn?.sn_code || '',
      quantity,
      unit_cost: finalUnitCost,
      total_cost: totalCost,
      inventory_type: inventoryType,
      location_id: locationId,
      remark: raw.remark || ''
    });
  }
  return rows;
}

async function createConversionItem(conversionId, row, transaction) {
  return InventoryConversionItem.create({
    conversion_id: conversionId,
    line_role: row.line_role,
    product_id: row.product_id || null,
    product_name: row.product_name || '',
    pn_code: row.pn_code || '',
    sn_id: row.sn_id || null,
    sn_code: row.sn_code || '',
    source_sn_id: row.source_sn_id || null,
    source_sn_code: row.source_sn_code || '',
    quantity: row.quantity || 1,
    unit_cost: row.unit_cost || 0,
    total_cost: row.total_cost || 0,
    inventory_type: row.inventory_type || 'normal_qty',
    location_id: row.location_id || '',
    remark: row.remark || ''
  }, { transaction });
}

async function getConversionList(ctx) {
  const { conversionType, status, storeId, page = 1, pageSize = 20 } = ctx.query;
  const where = {};
  if (conversionType) where.conversion_type = conversionType;
  if (status) where.status = status;
  if (storeId) {
    const allowedStoreIds = (ctx.state.user.accessibleStoreIds || []).map(String);
    if (!allowedStoreIds.includes('*') && !allowedStoreIds.includes(String(storeId))) {
      ctx.throw(403, '无权访问该门店转换记录');
    }
    where.store_id = storeId;
  } else if (!ctx.state.user.accessibleStoreIds.includes('*')) where.store_id = ctx.state.user.accessibleStoreIds;

  const { count, rows } = await InventoryConversion.findAndCountAll({
    where,
    include: [
      { model: Store, attributes: ['store_id', 'name'] },
      { model: InventoryConversionItem, as: 'items' }
    ],
    order: [['create_time', 'DESC']],
    limit: parseInt(pageSize, 10),
    offset: (parseInt(page, 10) - 1) * parseInt(pageSize, 10),
    distinct: true
  });

  const list = rows.map(row => {
    const data = row.toJSON();
    const items = data.items || [];
    const sourceNames = items.filter(item => item.line_role === 'source').map(item => item.product_name || item.product_id);
    const targetNames = items.filter(item => item.line_role === 'target').map(item => item.product_name || item.product_id);
    return {
      ...data,
      store_name: data.Store?.name || data.store_id,
      source_summary: sourceNames.join('、'),
      target_summary: targetNames.join('、')
    };
  });

  ctx.body = formatPaginatedResult(list, { page, pageSize, count });
}

async function getConversionDetail(ctx) {
  const { conversionId } = ctx.params;
  const conversion = await InventoryConversion.findByPk(conversionId, {
    include: [
      { model: Store, attributes: ['store_id', 'name'] },
      { model: InventoryConversionItem, as: 'items' }
    ]
  });
  if (!conversion) ctx.throw(404, '库存转换单不存在');
  assertStoreVisible(ctx, conversion.store_id);

  const data = conversion.toJSON();
  ctx.body = {
    code: 0,
    data: {
      ...data,
      store_name: data.Store?.name || data.store_id
    }
  };
}

async function createConversion(ctx) {
  const t = await sequelize.transaction();
  try {
    const body = ctx.request.body || {};
    const user = ctx.state.user || {};
    const conversionType = normalizeConversionType(body.conversionType || body.conversion_type);
    const storeId = body.storeId || body.store_id;
    const serviceCost = conversionType === 'assemble' ? money(body.serviceCost ?? body.service_cost ?? 0) : 0;

    if (!storeId) ctx.throw(400, '请选择转换门店');
    if (serviceCost < 0) ctx.throw(400, '组装服务成本不能小于0');

    const store = await Store.findByPk(storeId, { transaction: t });
    if (!store) ctx.throw(400, '转换门店不存在');

    const sourceRows = await buildConversionSourceRows(body.sourceItems || body.source_items, conversionType, storeId, t);
    const targetRows = await buildConversionTargetRows(body.targetItems || body.target_items, conversionType, storeId, sourceRows, t);
    await assertActiveProducts(Product, [
      ...sourceRows.map(item => item.product_id),
      ...targetRows.map(item => item.product_id)
    ], { transaction: t });

    const totalSourceCost = money(sourceRows.reduce((sum, item) => sum + Number(item.total_cost || 0), 0));
    const totalTargetCost = money(targetRows.reduce((sum, item) => sum + Number(item.total_cost || 0), 0));
    const expectedTargetCost = money(totalSourceCost + serviceCost);
    if (conversionType === 'split') {
      if (sourceRows.length !== 1 || Number(sourceRows[0].quantity || 1) !== 1) {
        ctx.throw(400, '拆分单一次只能选择一个被拆商品，且数量必须为1');
      }
      if (totalTargetCost <= 0) {
        ctx.throw(400, '拆出商品价格合计必须大于0');
      }
      if (totalTargetCost - totalSourceCost > 0.01) {
        ctx.throw(400, `拆出商品价格合计 ${totalTargetCost} 不能超过被拆商品当前成本 ${totalSourceCost}`);
      }
    } else if (Math.abs(totalTargetCost - expectedTargetCost) > 0.01) {
      ctx.throw(400, `成本不守恒：目标成本 ${totalTargetCost} 必须等于来源成本 ${totalSourceCost}${serviceCost ? ` + 服务成本 ${serviceCost}` : ''}`);
    }

    const conversionId = generateUUID();
    const conversionNo = generateConversionNo(conversionType);
    await InventoryConversion.create({
      conversion_id: conversionId,
      conversion_no: conversionNo,
      conversion_type: conversionType,
      store_id: storeId,
      status: 'completed',
      total_source_cost: totalSourceCost,
      total_target_cost: totalTargetCost,
      service_cost: serviceCost,
      remark: body.remark || '',
      create_user: user.name || user.staffId || '',
      create_time: new Date()
    }, { transaction: t });

    const sourceStatus = conversionType === 'assemble' ? 'assembled' : 'split';
    const sourceAction = conversionType === 'assemble' ? 'inventory_assemble_source' : 'inventory_split_source';
    const targetAction = conversionType === 'assemble' ? 'inventory_assemble_target' : 'inventory_split_target';
    const splitRemainingCost = conversionType === 'split' ? money(totalSourceCost - totalTargetCost) : 0;

    for (const row of sourceRows) {
      if (row.snRecord) {
        const updatePayload = conversionType === 'split'
          ? { inbound_price: splitRemainingCost }
          : { status: sourceStatus };
        await row.snRecord.update(updatePayload, { transaction: t });
        await SnLog.create({
          log_id: generateUUID(),
          sn_id: row.snRecord.sn_id,
          sn_code: row.snRecord.sn_code,
          product_id: row.product_id,
          product_name: row.product_name,
          store_id: storeId,
          action: sourceAction,
          remark: conversionType === 'split'
            ? `库存拆分来源成本调整，单号：${conversionNo}，拆分前成本：${totalSourceCost}，拆出金额：${totalTargetCost}，剩余成本：${splitRemainingCost}`
            : `库存组装来源，单号：${conversionNo}`,
          create_user: conversion.create_user || user.name || user.staffId
        }, { transaction: t });
      } else if (conversionType === 'split') {
        await setProductCostPrice(row.product_id, splitRemainingCost, user, t);
      }
      if (conversionType !== 'split') {
        await updateInventory(row.product_id, storeId, row.inventory_type, -Number(row.quantity || 1), t, row.location_id);
      }
      await createConversionItem(conversionId, {
        ...row,
        remark: conversionType === 'split'
          ? [row.remark, `拆分前成本:${totalSourceCost};拆出金额:${totalTargetCost};拆分后原商品成本:${splitRemainingCost}`].filter(Boolean).join(' ')
          : row.remark
      }, t);
    }

    for (const row of targetRows) {
      let snId = null;
      if (Number(row.product.need_sn) === 1) {
        const pnMaster = await ensurePn(row.product_id, row.pn_code, t);
        snId = generateUUID();
        await ProductSn.create({
          sn_id: snId,
          product_id: row.product_id,
          pn_id: pnMaster.pn_id,
          pn_code: row.pn_code,
          sn_code: row.sn_code,
          status: 'in_stock',
          inventory_type: row.inventory_type,
          store_id: storeId,
           location_id: row.location_id || null,
           inbound_time: new Date(),
           original_inbound_time: new Date(),
           inbound_price: row.unit_cost,
          original_pickup_price: row.unit_cost,
          batch_no: conversionNo,
          remark: `库存${conversionType === 'assemble' ? '组装' : '拆分'}生成，单号：${conversionNo}`,
          is_deleted: 0
        }, { transaction: t });
        await SnLog.create({
          log_id: generateUUID(),
          sn_id: snId,
          sn_code: row.sn_code,
          product_id: row.product_id,
          product_name: row.product_name,
          store_id: storeId,
          action: targetAction,
          remark: `库存${conversionType === 'assemble' ? '组装' : '拆分'}生成，单号：${conversionNo}`,
          create_user: conversion.create_user || user.name || user.staffId
        }, { transaction: t });
      }

      await updateInventory(row.product_id, storeId, row.inventory_type, Number(row.quantity || 1), t, row.location_id);
      await createConversionItem(conversionId, { ...row, sn_id: snId }, t);
    }

    if (serviceCost > 0) {
      await createConversionItem(conversionId, {
        line_role: 'service',
        product_name: '组装服务成本',
        quantity: 1,
        unit_cost: serviceCost,
        total_cost: serviceCost,
        remark: body.serviceRemark || body.service_remark || ''
      }, t);
    }

    await t.commit();
    ctx.body = { code: 0, data: { conversionId, conversionNo }, message: '库存转换已完成' };
  } catch (error) {
    await t.rollback();
    if (error.status) ctx.throw(error.status, error.message);
    console.error('createConversion error:', error);
    ctx.throw(500, error.message || '库存转换失败');
  }
}

async function voidConversion(ctx) {
  const t = await sequelize.transaction();
  try {
    const { conversionId } = ctx.params;
    const { reason = '' } = ctx.request.body || {};
    const user = ctx.state.user || {};
    const conversion = await InventoryConversion.findByPk(conversionId, {
      include: [{ model: InventoryConversionItem, as: 'items' }],
      transaction: t
    });
    if (!conversion) ctx.throw(404, '库存转换单不存在');
    assertStoreVisible(ctx, conversion.store_id);
    if (conversion.status === 'voided') ctx.throw(400, '该转换单已冲销');

    const items = conversion.items || [];
    const targetItems = items.filter(item => item.line_role === 'target');
    const sourceItems = items.filter(item => item.line_role === 'source');

    for (const item of targetItems) {
      if (item.sn_id) {
        const sn = await ProductSn.findByPk(item.sn_id, { transaction: t });
        if (!sn || sn.status !== 'in_stock') {
          ctx.throw(400, `目标SN ${item.sn_code || item.sn_id} 已被销售、占用或不存在，不能冲销`);
        }
      } else {
        const available = await getAvailableQty(item.product_id, conversion.store_id, item.inventory_type || 'normal_qty', item.location_id || '', t);
        if (available < Number(item.quantity || 1)) {
          ctx.throw(400, `目标商品 ${item.product_name || item.product_id} 库存不足，不能冲销`);
        }
      }
    }

    const reverseAction = conversion.conversion_type === 'assemble' ? 'inventory_assemble_void' : 'inventory_split_void';

    for (const item of targetItems) {
      if (item.sn_id) {
        const sn = await ProductSn.findByPk(item.sn_id, { transaction: t });
        await sn.update({ status: 'voided' }, { transaction: t });
        await SnLog.create({
          log_id: generateUUID(),
          sn_id: item.sn_id,
          sn_code: item.sn_code,
          product_id: item.product_id,
          product_name: item.product_name,
          store_id: conversion.store_id,
          action: reverseAction,
          remark: `库存转换冲销，单号：${conversion.conversion_no}`,
          create_user: user.name || user.staffId
        }, { transaction: t });
      }
      await updateInventory(item.product_id, conversion.store_id, item.inventory_type || 'normal_qty', -Number(item.quantity || 1), t, item.location_id || '');
    }

    for (const item of sourceItems) {
      if (item.sn_id) {
        const sn = await ProductSn.findByPk(item.sn_id, { transaction: t });
        if (sn) {
          const sourceUpdate = conversion.conversion_type === 'split'
            ? { inbound_price: money(item.unit_cost || 0) }
            : { status: 'in_stock' };
          await sn.update(sourceUpdate, { transaction: t });
          await SnLog.create({
            log_id: generateUUID(),
            sn_id: item.sn_id,
            sn_code: item.sn_code,
            product_id: item.product_id,
            product_name: item.product_name,
            store_id: conversion.store_id,
            action: reverseAction,
            remark: conversion.conversion_type === 'split'
              ? `库存拆分冲销恢复来源SN成本，单号：${conversion.conversion_no}，恢复成本：${money(item.unit_cost || 0)}`
              : `库存转换冲销恢复来源SN，单号：${conversion.conversion_no}`,
            create_user: conversion.create_user || user.name || user.staffId
          }, { transaction: t });
        }
      } else if (conversion.conversion_type === 'split' && item.product_id) {
        await setProductCostPrice(item.product_id, item.unit_cost || 0, user, t);
      }
      if (conversion.conversion_type !== 'split') {
        await updateInventory(item.product_id, conversion.store_id, item.inventory_type || 'normal_qty', Number(item.quantity || 1), t, item.location_id || '');
      }
    }

    await conversion.update({
      status: 'voided',
      void_reason: reason,
      void_user: user.name || user.staffId || '',
      void_time: new Date()
    }, { transaction: t });

    await t.commit();
    ctx.body = { code: 0, message: '库存转换单已冲销' };
  } catch (error) {
    await t.rollback();
    if (error.status) ctx.throw(error.status, error.message);
    console.error('voidConversion error:', error);
    ctx.throw(500, error.message || '库存转换冲销失败');
  }
}

async function getReturnStockWithItems(returnId, transaction) {
  return ReturnStock.findByPk(returnId, {
    include: [{ model: ReturnStockItem, as: 'items' }],
    transaction
  });
}

/**
 * 查询退库申请列表
 */
async function getReturnList(ctx) {
  const { status, inboundId, returnId, returnNo, scope, page = 1, pageSize = 20 } = ctx.query;
  const where = {};
  if (status) where.status = status;
  if (inboundId) where.inbound_id = inboundId;
  if (returnId) where.return_id = returnId;
  if (returnNo) where.return_no = { [Op.like]: `%${String(returnNo).trim()}%` };
  const traceReturnLookup = returnId && String(ctx.query.trace || '') === '1';
  if (!ctx.state.user.accessibleStoreIds.includes('*') && !traceReturnLookup) {
    where.store_id = ctx.state.user.accessibleStoreIds;
  }
  if (scope === 'review' && !getUserRoles(ctx.state.user).some(role => ['purchaser', 'admin', 'boss'].includes(role))) {
    where.return_id = '__NO_RETURN_APPROVAL_ACCESS__';
  }

  const { count, rows } = await ReturnStock.findAndCountAll({
    where,
    include: [{ model: ReturnStockItem, as: 'items' }],
    order: buildPendingFirstOrder(sequelize, {
      statusColumn: 'ReturnStock.status',
      pendingStatuses: ['pending', 'approved'],
      dateColumns: ['ReturnStock.create_time'],
      idColumn: 'ReturnStock.return_id'
    }),
    ...paginate({}, { page, pageSize })
  });

  const storeIds = [...new Set(rows.map(row => row.store_id).filter(Boolean))];
  const stores = storeIds.length > 0
    ? await Store.findAll({ where: { store_id: { [Op.in]: storeIds } }, attributes: ['store_id', 'name', 'distributor_id'] })
    : [];
  const storeMap = new Map(stores.map(store => [store.store_id, store]));

  if (returnId && String(ctx.query.trace || '') === '1') {
    const row = rows[0];
    const store = row ? storeMap.get(row.store_id) : null;
    if (!row || !canViewSnTraceReference(ctx.state.user, {
      store_id: row.store_id,
      distributor_id: store?.distributor_id,
      creator_names: [row.create_user]
    })) {
      ctx.throw(403, '无权查看该退库原始单据');
    }
  }

  const list = rows.map(row => {
    const data = row.toJSON();
    return {
      ...data,
       store_name: storeMap.get(data.store_id)?.name || ''
    };
  });

  ctx.body = formatPaginatedResult(list, { page, pageSize, count });
}

/**
 * 发起退库申请
 */
async function requestReturn(ctx) {
  const t = await sequelize.transaction();
  try {
    const { inboundId, reason } = ctx.request.body;
    const user = ctx.state.user;

    const inbound = await Inbound.findByPk(inboundId, { transaction: t });
    if (!inbound) ctx.throw(404, '入库单不存在');
    if (inbound.status !== 'completed') ctx.throw(400, '只有已完成的入库单才能发起退库申请');

    const activeReturn = await ReturnStock.findOne({
      where: {
        inbound_id: inboundId,
        status: { [Op.in]: ['pending', 'approved'] }
      },
      transaction: t
    });
    if (activeReturn) {
      ctx.throw(400, '该入库单已有待处理的退库申请');
    }

    const items = await InboundItem.findAll({
      where: { inbound_id: inboundId },
      transaction: t
    });
    if (items.length === 0) ctx.throw(400, '该入库单没有商品明细');

    const productIds = items.map(item => item.product_id);
    await assertActiveProducts(Product, productIds, { transaction: t });
    const products = await Product.findAll({
      where: { product_id: { [Op.in]: productIds }, is_deleted: 0, status: 1 },
      transaction: t
    });
    const productMap = new Map();
    products.forEach(p => productMap.set(p.product_id, p));

    const request = inbound.purchase_request_id
      ? await PurchaseRequest.findByPk(inbound.purchase_request_id, { transaction: t })
      : null;
    const store = await Store.findByPk(inbound.store_id, {
      attributes: ['store_id', 'distributor_id'],
      transaction: t
    });
    const supplier = request?.supplier_id
      ? await Supplier.findByPk(request.supplier_id, { transaction: t })
      : null;

    let totalQuantity = 0;
    let totalAmount = 0;

    const returnId = generateUUID();
    const returnNo = generateReturnNo();

    await ReturnStock.create({
      return_id: returnId,
      return_no: returnNo,
      inbound_id: inboundId,
      inbound_no: inbound.inbound_no,
      store_id: inbound.store_id,
      purchase_request_id: inbound.purchase_request_id || '',
      distributor_id: request?.distributor_id || store?.distributor_id || null,
      supplier_id: request?.supplier_id || '',
      supplier_name: supplier?.name || '',
      total_quantity: 0,
      total_amount: 0,
      reason: reason || '',
      status: 'pending',
      create_user: user.name || user.staffId,
      create_time: new Date()
    }, { transaction: t });

    for (const item of items) {
      const product = productMap.get(item.product_id);
      const quantity = item.quantity || 1;
      const inventoryType = item.inventory_type || 'normal_qty';
      totalQuantity += quantity;
      totalAmount += (Number(item.unit_price) || 0) * quantity;

      if (product && product.need_sn === 1) {
        const snRecords = await ProductSn.findAll({
          where: {
            product_id: item.product_id,
            ...(item.pn_code ? { pn_code: item.pn_code } : {}),
            store_id: inbound.store_id,
            status: 'in_stock',
            is_deleted: 0
          },
          order: [['inbound_time', 'ASC']],
          limit: quantity,
          transaction: t
        });
        if (snRecords.length < quantity) {
          ctx.throw(400, `商品 ${item.product_name || item.product_id} 当前在库SN数量不足，不能发起退库`);
        }

        for (const snRecord of snRecords) {
          await ReturnStockItem.create({
            return_id: returnId,
            inbound_item_id: item.item_id,
            product_id: item.product_id,
            product_name: item.product_name || '',
            pn_code: snRecord.pn_code || item.pn_code || '',
            sn_code: snRecord.sn_code || '',
            sn_id: snRecord.sn_id,
            quantity: 1,
            unit_price: item.unit_price,
            location_id: snRecord.location_id || item.location_id || '',
            inventory_type: snRecord.inventory_type || inventoryType,
            product_type: item.product_type || '',
            remark: ''
          }, { transaction: t });
        }
      } else {
        await ReturnStockItem.create({
          return_id: returnId,
          inbound_item_id: item.item_id,
          product_id: item.product_id,
          product_name: item.product_name || '',
          pn_code: item.pn_code || '',
          sn_code: '',
          sn_id: null,
          quantity: quantity,
          unit_price: item.unit_price,
          location_id: item.location_id || '',
          inventory_type: inventoryType,
          product_type: item.product_type || '',
          remark: ''
        }, { transaction: t });
      }
    }

    await ReturnStock.update(
      { total_quantity: totalQuantity, total_amount: totalAmount },
      { where: { return_id: returnId }, transaction: t }
    );

    await t.commit();
    ctx.body = { code: 0, returnId, returnNo, message: '退库申请已提交，待审批' };
  } catch (error) {
    await t.rollback();
    console.error('Error in requestReturn:', error);
    throw error;
  }
}

/**
 * 审批退库申请
 */
async function approveReturn(ctx) {
  const t = await sequelize.transaction();
  try {
    const { returnId, action = 'approved', comment = '' } = ctx.request.body;
    const user = ctx.state.user;
    if (!getUserRoles(user).some(role => ['purchaser', 'admin', 'boss'].includes(role))) {
      ctx.throw(403, '仅采购、经销商总权限账号或BOSS可以审批退库申请');
    }
    if (!['approved', 'rejected'].includes(action)) ctx.throw(400, '审批动作无效');

    const returnStock = await ReturnStock.findByPk(returnId, { transaction: t });
    if (!returnStock) ctx.throw(404, '退库申请不存在');
    assertStoreVisible(ctx, returnStock.store_id);
    if (returnStock.status !== 'pending') ctx.throw(400, '只有待审批的退库申请才能审批');

    const nextStatus = action === 'rejected' ? 'rejected' : 'approved';
    await returnStock.update({
      status: nextStatus,
      approve_user: user.name || user.staffId,
      approve_comment: comment || '',
      approve_time: new Date()
    }, { transaction: t });

    await t.commit();
    ctx.body = { code: 0, message: nextStatus === 'approved' ? '退库申请已通过' : '退库申请已拒绝' };
  } catch (error) {
    await t.rollback();
    console.error('Error in approveReturn:', error);
    throw error;
  }
}

/**
 * 执行已审批退库
 */
async function executeReturn(ctx) {
  const t = await sequelize.transaction();
  try {
    const { returnId } = ctx.request.body;
    const user = ctx.state.user;

    const returnStock = await getReturnStockWithItems(returnId, t);
    if (!returnStock) ctx.throw(404, '退库申请不存在');
    if (returnStock.status !== 'approved') ctx.throw(400, '只有已审批通过的退库申请才能执行退库');

    const inbound = await Inbound.findByPk(returnStock.inbound_id, {
      include: [{ model: InboundItem, as: 'items' }],
      transaction: t
    });
    if (!inbound) ctx.throw(404, '入库单不存在');
    if (inbound.status !== 'completed') ctx.throw(400, '当前入库单状态不能执行退库');

    const items = returnStock.items || [];
    if (items.length === 0) ctx.throw(400, '退库申请没有商品明细');
    await assertActiveProducts(Product, items.map(item => item.product_id), { transaction: t });

    for (const item of items) {
      const quantity = Number(item.quantity || 1);
      const inventoryType = item.inventory_type || 'normal_qty';
      const locationId = item.location_id || '';

      if (item.sn_id) {
        const snRecord = await ProductSn.findOne({
          where: {
            sn_id: item.sn_id,
            store_id: returnStock.store_id,
            status: 'in_stock',
            is_deleted: 0
          },
          transaction: t
        });
        if (!snRecord) {
          ctx.throw(400, `SN ${item.sn_code || item.sn_id} 当前不在库，不能执行退库`);
        }

        await snRecord.update({
          status: 'returned',
          remark: `${snRecord.remark || ''} [退库:${returnStock.return_no}]`
        }, { transaction: t });

        await SnLog.create({
          log_id: generateUUID(),
          sn_id: item.sn_id,
          sn_code: item.sn_code,
          product_id: item.product_id,
          product_name: item.product_name || '',
          store_id: returnStock.store_id,
          action: 'return',
          remark: `采购退库：${returnStock.return_no}`,
          create_user: returnStock.create_user || user.name || user.staffId
        }, { transaction: t });
      }

      await updateInventory(item.product_id, returnStock.store_id, inventoryType, -quantity, t, locationId);

      if (inventoryType === 'normal_qty' && item.product_type) {
        const typeField = getProductTypeInventoryField(item.product_type);
        if (typeField) {
          await updateInventory(item.product_id, returnStock.store_id, typeField, -quantity, t, locationId);
        }
      }
    }

    const accounting = await ensurePurchaseReturnAccounting({
      returnStock,
      transaction: t,
      userName: user.name || user.staffId || ''
    });

    await returnStock.update({
      status: 'completed',
      execute_user: user.name || user.staffId,
      execute_time: new Date(),
      payable_id: accounting.payableId
    }, { transaction: t });

    // 只有该入库单的全部数量都退完，原采购申请才显示“已退货”。
    // 部分退库仍保留 completed，由采购申请生命周期状态推导为“部分退货”。
    const completedReturnItems = await ReturnStockItem.findAll({
      include: [{
        model: ReturnStock,
        where: { inbound_id: inbound.inbound_id, status: 'completed' },
        attributes: []
      }],
      transaction: t
    });
    const returnedByInboundItem = new Map();
    completedReturnItems.forEach(item => {
      if (!item.inbound_item_id) return;
      const key = String(item.inbound_item_id);
      returnedByInboundItem.set(key, (returnedByInboundItem.get(key) || 0) + Number(item.quantity || 0));
    });
    (returnStock.items || []).forEach(item => {
      if (!item.inbound_item_id) return;
      const key = String(item.inbound_item_id);
      returnedByInboundItem.set(key, (returnedByInboundItem.get(key) || 0) + Number(item.quantity || 0));
    });
    const allInboundItemsReturned = (inbound.items || []).length > 0
      && (inbound.items || []).every(item => (
        Number(returnedByInboundItem.get(String(item.item_id)) || 0) >= Number(item.quantity || 0)
      ));
    await inbound.update({
      status: allInboundItemsReturned ? 'returned' : 'completed',
      update_time: new Date()
    }, { transaction: t });

    await t.commit();
    ctx.body = {
      code: 0,
      returnId,
      payableId: accounting.payableId,
      adjustmentId: accounting.adjustmentId,
      adjustmentNo: accounting.adjustmentNo,
      totalQuantityDelta: accounting.totalQuantityDelta,
      totalAmountDelta: accounting.totalAmountDelta,
      offsetAmount: accounting.offsetAmount,
      message: '退库已执行，已生成负向采购调整和供应商待抵扣'
    };
  } catch (error) {
    await t.rollback();
    console.error('Error in executeReturn:', error);
    throw error;
  }
}

/**
 * 获取指定门店的库位列表
 */
async function getLocationsByStore(ctx) {
  try {
    const { storeId } = ctx.params;
    // 调拨入库需要展示对方门店库位；实际入库仍由 confirmTransferIn 校验调入门店。
    if (isTransferScope(ctx)) {
      await assertTransferStoreScope(ctx, storeId);
    } else {
      assertStoreVisible(ctx, storeId);
    }
    const store = await Store.findOne({ where: { store_id: storeId, is_deleted: 0 } });
    if (!store) ctx.throw(404, '门店不存在');
    let locations = await Location.findAll({ where: { store_id: storeId } });
    if (locations.length === 0) {
      await ensureStandardLocationsForStores(Location, [store]);
      locations = await Location.findAll({ where: { store_id: storeId } });
    }
    locations = locations
      .filter(location => Number(location.status) === 1)
      .sort((left, right) => {
        const order = { normal_qty: 10, demo_qty: 20, display_qty: 30, unsellable_qty: 40, pending_qty: 50, rental_demo_qty: 60 };
        return (order[left.type] || 999) - (order[right.type] || 999) || String(left.name || '').localeCompare(String(right.name || ''));
      });
    ctx.body = { code: 0, data: locations };
  } catch (error) {
    console.error('Error in getLocationsByStore:', error);
    throw error;
  }
}

module.exports = {
  getList,
  exportList,
  exportSummaryList,
  getSnInventoryList,
  exportSnInventoryList,
  setSnSpecialPrice,
  cancelSnSpecialPrice,
  getSnSpecialPriceHistory,
  getSnList,
  getInboundList,
  getInboundDetail,
  getSnTraceInboundDetail,
  executeInbound,
  updateInventory,
  getAvailableQty,
  getReturnList,
  requestReturn,
  approveReturn,
  executeReturn,
  inbound,
  outbound,
  transfer,
  getTransferList,
  getTransferDetail,
  confirmTransferOut: confirmTransferOutPartial,
  getTransferShippingPhoto,
  confirmTransferIn,
  returnTransfer,
  revokeTransfer,
  rejectTransfer,
  getConversionList,
  getConversionDetail,
  createConversion,
  voidConversion,
  getLocationsByStore,
  updateSn,
  adjustSnLocation,
  snTrace,
  _test: {
    calculateStockAgeDays,
    resolveOriginalInboundTime,
    resolveEffectiveSalePrice,
    canManageDistributorPrice,
    getTransferVisibilityLevel,
    buildTransferVisibilityWhere,
    isDistributorAccount,
    isTransferApplicant,
    transferQuantitySummary,
    visibleTransferItems,
    getPendingTransferItems,
    buildPreselectedTransferSelection,
    isTransferAwaitingReceipt,
    isTransferRequestOpen: transfer => TRANSFER_REQUEST_STATUSES.has(String(transfer?.status || '').toLowerCase()),
    validateSnLocationAdjustment,
    validateSalesReturnInboundSn,
    getInventoryQuantitySnapshot,
    isSalesWarehouseLocation,
    isInStockSalesWarehouseSn,
    getSalesWarehouseInventoryQty,
    normalizeInventoryQuantityField,
    getSnInventoryMoveFields,
    getTransferableInventoryQuantity,
    getSalesResourceQuantitySnapshot,
    getSnSalesResourceQuantitySnapshot,
    getInventoryProductType,
    getSnStatusLabel,
    isSpecialPriceProduct,
    matchesInventoryModelFilter,
    compareInventoryModelRows,
    buildStoreInventoryExportRows,
    buildInventorySummaryExportRows,
    getInventorySummaryCategoryRank,
    buildInventoryProductKeywordConditions,
    getSummaryNormalQty,
    purchaseInitiatorName,
    resolveInboundInitiator,
    resolveSnTraceLogUser,
    isTransferInboundRecord,
    buildNonTransferInboundCondition,
    updateInventory,
    getAvailableQty,
    salesReturnRequesterName,
    resolveTransferInboundSnBinding,
    normalizeSnIdentityValue,
    samePnCode,
    isPurchaseInboundItemProgressComplete,
    restoreDepositForCompletedSalesReturn,
    normalizeTransferRemark
  }
};
