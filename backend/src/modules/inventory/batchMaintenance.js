const XLSX = require('xlsx');
const { Op } = require('sequelize');
const {
  sequelize, Product, ProductPn, ProductSn, Store, Location, Inventory,
  InventoryBatchApplication, InventoryBatchApplicationItem, NonSnInventoryBatchRight,
  InventoryResourceRight, ResourceRightChangeOrder, SnLog
} = require('../../models');
const { generateUUID, generateBatchNo, paginate, formatPaginatedResult } = require('../../utils');
const { getUserRoles } = require('../../middleware/permission');
const {
  findResourceRule, calculatePreSaleRuleAmount, createPendingSettlement
} = require('./resourceRights');

const VALID_OPERATION_TYPES = new Set(['INBOUND', 'OUTBOUND', 'ADJUST']);
const VALID_INVENTORY_TYPES = new Set(['normal_qty', 'display_qty', 'demo_qty', 'unsellable_qty', 'pending_qty']);
const OPERATION_LABELS = { INBOUND: '批量入库', OUTBOUND: '批量出库', ADJUST: '数量调整' };

function roles(user) {
  return getUserRoles(user);
}

function canReview(user) {
  const userRoles = roles(user);
  return userRoles.includes('boss') || userRoles.includes('admin');
}

function isBoss(user) {
  return roles(user).includes('boss');
}

function normalizeText(value) {
  return String(value ?? '').trim();
}

function numberValue(value, fallback = 0) {
  if (value === '' || value == null) return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function intValue(value, fallback = 0) {
  const num = parseInt(value, 10);
  return Number.isFinite(num) ? num : fallback;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

function unique(values) {
  return [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))];
}

function getCell(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') return row[key];
  }
  return '';
}

function normalizeResourceTypes(value) {
  return unique(String(value || '')
    .split(/[,，;；\s]+/)
    .map(item => item.trim()));
}

function parseWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
}

function applicationNo() {
  return `IBM${generateBatchNo().slice(1)}${generateUUID().slice(-4).toUpperCase()}`;
}

function businessNo(prefix) {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join('');
  return `${prefix}${stamp}${generateUUID().slice(-6).toUpperCase()}`;
}

function assertStoreVisible(ctx, storeId) {
  const allowed = ctx.state.user.accessibleStoreIds || [];
  if (!allowed.includes('*') && !allowed.map(String).includes(String(storeId || ''))) {
    ctx.throw(403, '无权操作该门店库存');
  }
}

async function resolveProduct(row, transaction) {
  const productId = normalizeText(getCell(row, ['商品ID', 'productId', 'product_id']));
  const productCode = normalizeText(getCell(row, ['商品编码', 'productCode', 'product_code']));
  const productName = normalizeText(getCell(row, ['商品名称', 'productName', 'product_name']));
  const pnCode = normalizeText(getCell(row, ['PN', 'pn', 'pnCode', 'pn_code']));

  if (productId) {
    const product = await Product.findOne({ where: { product_id: productId, is_deleted: 0 }, transaction });
    if (product) return product;
  }
  if (productCode) {
    const product = await Product.findOne({ where: { product_code: productCode, is_deleted: 0 }, transaction });
    if (product) return product;
  }
  if (pnCode) {
    const pn = await ProductPn.findOne({ where: { pn_code: pnCode, is_deleted: 0 }, transaction });
    if (pn) {
      const product = await Product.findOne({ where: { product_id: pn.product_id, is_deleted: 0 }, transaction });
      if (product) return product;
    }
  }
  if (productName) {
    const product = await Product.findOne({ where: { name: productName, is_deleted: 0 }, transaction });
    if (product) return product;
  }
  return null;
}

async function resolveStore(row, transaction) {
  const storeId = normalizeText(getCell(row, ['门店ID', 'storeId', 'store_id']));
  const storeName = normalizeText(getCell(row, ['门店', '门店名称', 'storeName', 'store_name']));
  if (storeId) {
    return Store.findOne({ where: { store_id: storeId, is_deleted: 0, status: 1 }, transaction });
  }
  if (storeName) {
    return Store.findOne({ where: { name: storeName, is_deleted: 0, status: 1 }, transaction });
  }
  return null;
}

async function resolveLocation(row, storeId, transaction, preferredType = '') {
  const locationType = normalizeText(preferredType);
  if (locationType) {
    return Location.findOne({ where: { store_id: storeId, type: locationType, status: 1 }, transaction });
  }
  const locationId = normalizeText(getCell(row, ['库位ID', 'locationId', 'location_id']));
  const locationName = normalizeText(getCell(row, ['库位', '库位名称', 'locationName', 'location_name']));
  if (!locationId && !locationName) return null;
  const where = { store_id: storeId, status: 1 };
  if (locationId) where.location_id = locationId;
  if (!locationId && locationName) where.name = locationName;
  return Location.findOne({ where, transaction });
}

async function inventoryQty(productId, storeId, inventoryType, locationId, transaction) {
  const where = { product_id: productId, store_id: storeId, location_id: locationId || '' };
  const row = await Inventory.findOne({ where, transaction });
  return row ? Number(row[inventoryType] || 0) : 0;
}

async function updateInventoryQty(productId, storeId, inventoryType, delta, transaction, locationId = '') {
  const normalizedLocationId = locationId || '';
  let row = await Inventory.findOne({
    where: { product_id: productId, store_id: storeId, location_id: normalizedLocationId },
    transaction
  });
  if (!row) {
    row = await Inventory.create({
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
      pending_qty: 0
    }, { transaction });
  }
  const current = Number(row[inventoryType] || 0);
  const next = current + Number(delta || 0);
  if (next < 0) throw Object.assign(new Error('库存不足，不能执行负库存调整'), { status: 409 });
  await row.update({ [inventoryType]: next }, { transaction });
  return { before: current, after: next };
}

async function validateRows(ctx, rows, options, transaction) {
  if (typeof options === 'string') {
    options = { operationType: options, triggerResourceRights: arguments[3] };
    transaction = arguments[4];
  }
  const {
    operationType,
    triggerResourceRights,
    importMode = '',
    inventoryType: batchInventoryType = '',
    resourceTypes: batchResourceTypes = []
  } = options;
  const validRows = [];
  const errors = [];
  const seenSn = new Set();

  for (const [index, row] of rows.entries()) {
    const rowNo = index + 2;
    const rowErrors = [];
    const product = await resolveProduct(row, transaction);
    const store = await resolveStore(row, transaction);
    const inventoryType = batchInventoryType || normalizeText(getCell(row, ['库存类型', 'inventoryType', 'inventory_type'])) || 'normal_qty';
    const location = store ? await resolveLocation(row, store.store_id, transaction, batchInventoryType) : null;
    const snCode = normalizeText(getCell(row, ['SN', 'sn', 'snCode', 'sn_code']));
    const pnCode = normalizeText(getCell(row, ['PN', 'pn', 'pnCode', 'pn_code']));
    const resourceTypes = batchResourceTypes.length > 0
      ? batchResourceTypes
      : normalizeResourceTypes(getCell(row, ['资源权益', '资源类型', 'resourceTypes', 'resource_types']));
    const unitPrice = numberValue(getCell(row, ['提货价', '采购价', '入库单价', '单价', 'unitPrice', 'unit_price']), 0);
    const originalPickupPrice = numberValue(getCell(row, ['原始提货价', '提货价', '采购价', 'originalPickupPrice', 'original_pickup_price']), unitPrice);
    const quantityRaw = getCell(row, ['数量', '调整数量', 'quantity', 'qty']);
    const quantity = product && Number(product.need_sn || 0) === 1 ? 1 : intValue(quantityRaw, operationType === 'ADJUST' ? 0 : 1);

    if (!product) rowErrors.push('商品不存在，请填写有效商品ID、商品编码、PN或商品名称');
    if (product && Number(product.status || 1) !== 1) rowErrors.push('商品已停用');
    if (product && importMode === 'SN' && Number(product.need_sn || 0) !== 1) rowErrors.push('当前导入模式为SN商品，但该商品不需要SN管理');
    if (product && importMode === 'NON_SN' && Number(product.need_sn || 0) === 1) rowErrors.push('当前导入模式为非SN商品，但该商品需要SN管理');
    if (!store) rowErrors.push('门店不存在或已停用');
    if (store) {
      try {
        assertStoreVisible(ctx, store.store_id);
      } catch (_) {
        rowErrors.push('无权操作该门店');
      }
    }
    if (!VALID_INVENTORY_TYPES.has(inventoryType)) rowErrors.push('库存类型无效');
    if ((operationType === 'INBOUND' || operationType === 'OUTBOUND') && quantity <= 0) rowErrors.push('数量必须大于0');
    if (operationType === 'ADJUST' && quantity === 0) rowErrors.push('调整数量不能为0');
    if ((operationType === 'INBOUND' || (operationType === 'OUTBOUND' && triggerResourceRights)) && resourceTypes.length === 0) {
      rowErrors.push(operationType === 'INBOUND' ? '入库必须填写资源权益' : '出库触发权益时必须填写资源权益');
    }
    if (!location) rowErrors.push(batchInventoryType ? '所选仓位在该门店不存在或已停用' : '库位不存在或不属于该门店');

    let sn = null;
    if (product && Number(product.need_sn || 0) === 1) {
      if (operationType === 'ADJUST') rowErrors.push('SN商品不得通过数量调整维护，请使用SN清单入库或出库');
      if (!snCode) rowErrors.push('SN商品必须填写SN');
      const snKey = `${pnCode || ''}:${snCode}`;
      if (snCode && seenSn.has(snKey)) rowErrors.push('导入文件中SN重复');
      if (snCode) seenSn.add(snKey);

      if (operationType === 'INBOUND') {
        if (snCode) {
          const existing = await ProductSn.findOne({
            where: {
              sn_code: snCode,
              ...(pnCode ? { pn_code: pnCode } : {}),
              status: { [Op.in]: ['in_stock', 'transferring'] },
              is_deleted: 0
            },
            transaction
          });
          if (existing) rowErrors.push('SN当前已在库或调拨中');
        }
      } else if (snCode) {
        sn = await ProductSn.findOne({
          where: { sn_code: snCode, product_id: product.product_id, status: 'in_stock', is_deleted: 0 },
          transaction
        });
        if (!sn) rowErrors.push('SN不存在、未在库或不属于该商品');
        if (sn && store && String(sn.store_id || '') !== String(store.store_id)) rowErrors.push('SN不在当前门店');
      }
    } else if (product && Number(product.need_sn || 0) === 0 && operationType !== 'INBOUND') {
      const before = store ? await inventoryQty(product.product_id, store.store_id, inventoryType, location?.location_id || '', transaction) : 0;
      const delta = operationType === 'OUTBOUND' ? -quantity : quantity;
      if (before + delta < 0) rowErrors.push(`库存不足，当前可用 ${before}`);
    }

    const normalized = {
      rowNo,
      operationType,
      product,
      store,
      location,
      pnCode,
      sn,
      snCode,
      inventoryType,
      quantity,
      unitPrice,
      originalPickupPrice,
      resourceTypes,
      triggerResourceRights,
      remark: normalizeText(getCell(row, ['备注', 'remark'])),
      raw: row
    };

    if (rowErrors.length > 0) {
      errors.push({ rowNo, message: rowErrors.join('；'), raw: row });
    } else {
      validRows.push(normalized);
    }
  }

  return { validRows, errors };
}

async function createBatchApplication(ctx) {
  const user = ctx.state.user;
  const operationType = normalizeText(ctx.request.body.operationType || ctx.request.body.operation_type).toUpperCase();
  const triggerResourceRights = String(ctx.request.body.triggerResourceRights || ctx.request.body.trigger_resource_rights || '') === 'true'
    || Number(ctx.request.body.triggerResourceRights || ctx.request.body.trigger_resource_rights || 0) === 1;
  const importMode = normalizeText(ctx.request.body.importMode || ctx.request.body.import_mode).toUpperCase();
  const inventoryType = normalizeText(ctx.request.body.inventoryType || ctx.request.body.inventory_type || ctx.request.body.locationType || ctx.request.body.location_type);
  const resourceTypes = normalizeResourceTypes(ctx.request.body.resourceTypes || ctx.request.body.resource_types || '');

  if (!VALID_OPERATION_TYPES.has(operationType)) ctx.throw(400, '批量操作类型无效');
  if (importMode && !['SN', 'NON_SN'].includes(importMode)) ctx.throw(400, '导入模式无效');
  if (inventoryType && !VALID_INVENTORY_TYPES.has(inventoryType)) ctx.throw(400, '仓位类型无效');
  if (!ctx.file?.buffer) ctx.throw(400, '请上传Excel文件');

  const rows = parseWorkbook(ctx.file.buffer);
  if (rows.length === 0) ctx.throw(400, 'Excel没有可导入数据');

  const transaction = await sequelize.transaction();
  try {
    const { validRows, errors } = await validateRows(ctx, rows, {
      operationType,
      triggerResourceRights,
      importMode,
      inventoryType,
      resourceTypes
    }, transaction);
    if (validRows.length === 0) {
      await transaction.rollback();
      ctx.status = 400;
      ctx.body = { code: 400, message: '没有可导入的有效数据', data: { errors, totalRows: rows.length } };
      return;
    }

    const applicationId = generateUUID();
    const app = await InventoryBatchApplication.create({
      application_id: applicationId,
      application_no: applicationNo(),
      operation_type: operationType,
      trigger_resource_rights: triggerResourceRights ? 1 : 0,
      source_file_name: ctx.file.originalname || '',
      store_ids: JSON.stringify(unique(validRows.map(row => row.store.store_id))),
      total_rows: rows.length,
      valid_rows: validRows.length,
      error_rows: errors.length,
      error_json: JSON.stringify(errors),
      status: 'pending',
      applicant_staff_id: user.staffId || null,
      applicant_name: user.name || '',
      applicant_distributor_id: user.distributorId || '',
      remark: ctx.request.body.remark || ''
    }, { transaction });

    for (const row of validRows) {
      const beforeQty = row.product.need_sn ? (row.operationType === 'INBOUND' ? 0 : 1) : await inventoryQty(
        row.product.product_id,
        row.store.store_id,
        row.inventoryType,
        row.location?.location_id || '',
        transaction
      );
      const delta = row.operationType === 'OUTBOUND' ? -row.quantity : row.quantity;
      const afterQty = row.product.need_sn ? (row.operationType === 'INBOUND' ? 1 : 0) : beforeQty + delta;
      await InventoryBatchApplicationItem.create({
        application_id: applicationId,
        row_no: row.rowNo,
        operation_type: row.operationType,
        product_id: row.product.product_id,
        product_code: row.product.product_code,
        product_name: row.product.name,
        need_sn: Number(row.product.need_sn || 0),
        pn_code: row.pnCode,
        sn_id: row.sn?.sn_id || null,
        sn_code: row.snCode,
        store_id: row.store.store_id,
        location_id: row.location?.location_id || '',
        inventory_type: row.inventoryType,
        quantity: row.quantity,
        before_qty: beforeQty,
        after_qty: afterQty,
        unit_price: row.unitPrice,
        original_pickup_price: row.originalPickupPrice,
        resource_types: JSON.stringify(row.resourceTypes),
        trigger_resource_rights: row.triggerResourceRights ? 1 : 0,
        validation_status: 'valid',
        raw_json: JSON.stringify(row.raw),
        create_time: new Date(),
        remark: row.remark
      }, { transaction });
    }

    await transaction.commit();
    ctx.body = {
      application: app,
      errors,
      totalRows: rows.length,
      validRows: validRows.length,
      errorRows: errors.length,
      message: errors.length > 0
        ? `批量维护申请已生成：成功${validRows.length}行，失败${errors.length}行`
        : '批量维护申请已生成，待经销商审批'
    };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function listBatchApplications(ctx) {
  const user = ctx.state.user;
  const where = {};
  const userRoles = roles(user);
  if (ctx.query.status) where.status = ctx.query.status;
  if (ctx.query.operationType) where.operation_type = ctx.query.operationType;
  if (!isBoss(user)) {
    if (userRoles.includes('admin')) {
      where.applicant_distributor_id = user.distributorId || '';
    } else {
      where.applicant_staff_id = user.staffId || 0;
    }
  }
  const { count, rows } = await InventoryBatchApplication.findAndCountAll({
    where,
    order: [
      [sequelize.literal("CASE WHEN STATUS = 'pending' THEN 0 ELSE 1 END"), 'ASC'],
      ['create_time', 'DESC']
    ],
    ...paginate({}, { page: ctx.query.page || 1, pageSize: ctx.query.pageSize || 20 })
  });
  ctx.body = formatPaginatedResult(rows, { page: ctx.query.page || 1, pageSize: ctx.query.pageSize || 20, count });
}

async function getBatchApplicationDetail(ctx) {
  const app = await InventoryBatchApplication.findByPk(ctx.params.applicationId, {
    include: [{ model: InventoryBatchApplicationItem, as: 'items', include: [{ model: Store, attributes: ['store_id', 'name'] }] }],
    order: [[{ model: InventoryBatchApplicationItem, as: 'items' }, 'row_no', 'ASC']]
  });
  if (!app) ctx.throw(404, '批量维护申请不存在');
  const user = ctx.state.user;
  if (!isBoss(user) && String(app.applicant_distributor_id || '') !== String(user.distributorId || '')) {
    if (String(app.applicant_staff_id || '') !== String(user.staffId || '')) ctx.throw(403, '无权查看该申请');
  }
  ctx.body = app;
}

async function createSnInbound(item, application, transaction) {
  const sn = await ProductSn.create({
    sn_id: generateUUID(),
    product_id: item.product_id,
    pn_code: item.pn_code,
    sn_code: item.sn_code,
    status: 'in_stock',
    inventory_type: item.inventory_type || 'normal_qty',
    store_id: item.store_id,
    location_id: item.location_id || '',
    inbound_time: new Date(),
    inbound_price: item.unit_price || 0,
    original_pickup_price: item.original_pickup_price || item.unit_price || 0,
    batch_no: application.application_no,
    remark: `批量入库 ${application.application_no}`,
    is_deleted: 0
  }, { transaction });

  const resourceTypes = parseJsonArray(item.resource_types);
  for (const resourceType of resourceTypes) {
    const rule = await findResourceRule({ productId: item.product_id, resourceType, transaction });
    const amount = calculatePreSaleRuleAmount(rule, sn);
    await InventoryResourceRight.create({
      right_id: generateUUID(),
      sn_id: sn.sn_id,
      sn_code: sn.sn_code,
      product_id: item.product_id,
      resource_type: resourceType,
      rule_config_id: rule?.config_id || null,
      source_inbound_id: application.application_id,
      initial_status: 'AVAILABLE',
      current_status: 'AVAILABLE',
      amount,
      source: 'BATCH_INBOUND',
      remark: `批量入库 ${application.application_no} 生成`
    }, { transaction });
    await ResourceRightChangeOrder.create({
      change_id: generateUUID(),
      change_order_no: businessNo('RRC'),
      sn_id: sn.sn_id,
      sn_code: sn.sn_code,
      product_id: item.product_id,
      resource_type: resourceType,
      before_status: 'NOT_APPLICABLE',
      after_status: 'AVAILABLE',
      change_amount: amount,
      change_reason: 'BATCH_INBOUND',
      approval_status: 'approved',
      related_order_id: application.application_id,
      applicant_staff_id: application.applicant_staff_id,
      applicant_name: application.applicant_name,
      reviewer_staff_id: application.reviewer_staff_id,
      reviewer_name: application.reviewer_name,
      review_time: application.review_time,
      remark: `库存批量维护 ${application.application_no}`
    }, { transaction });
  }

  await SnLog.create({
    log_id: generateUUID(),
    sn_id: sn.sn_id,
    sn_code: sn.sn_code,
    product_id: item.product_id,
    product_name: item.product_name,
    store_id: item.store_id,
    action: 'batch_inbound',
    remark: `库存批量维护入库 ${application.application_no}`,
    create_user: application.reviewer_name || application.applicant_name,
    create_time: new Date()
  }, { transaction });

  await item.update({ sn_id: sn.sn_id, result_json: JSON.stringify({ snId: sn.sn_id }) }, { transaction });
}

async function createNonSnBatchRights(item, application, transaction) {
  const resourceTypes = parseJsonArray(item.resource_types);
  for (const resourceType of resourceTypes) {
    const rule = await findResourceRule({ productId: item.product_id, resourceType, transaction });
    const amount = calculatePreSaleRuleAmount(rule, { inbound_price: item.unit_price || 0 });
    await NonSnInventoryBatchRight.create({
      right_id: generateUUID(),
      application_id: application.application_id,
      item_id: item.item_id,
      product_id: item.product_id,
      store_id: item.store_id,
      location_id: item.location_id || '',
      resource_type: resourceType,
      rule_config_id: rule?.config_id || null,
      total_quantity: item.quantity,
      remaining_quantity: item.quantity,
      amount_per_unit: amount,
      source_type: 'BATCH_INBOUND',
      status: 'AVAILABLE',
      remark: `批量入库 ${application.application_no}`
    }, { transaction });
  }
}

async function consumeNonSnBatchRights(item, application, transaction) {
  const resourceTypes = parseJsonArray(item.resource_types);
  for (const resourceType of resourceTypes) {
    let remaining = Number(item.quantity || 0);
    const rights = await NonSnInventoryBatchRight.findAll({
      where: {
        product_id: item.product_id,
        store_id: item.store_id,
        location_id: item.location_id || '',
        resource_type: resourceType,
        status: 'AVAILABLE',
        remaining_quantity: { [Op.gt]: 0 }
      },
      order: [['create_time', 'ASC']],
      transaction
    });
    for (const right of rights) {
      if (remaining <= 0) break;
      const deduct = Math.min(Number(right.remaining_quantity || 0), remaining);
      await right.update({
        remaining_quantity: Number(right.remaining_quantity || 0) - deduct,
        status: Number(right.remaining_quantity || 0) - deduct <= 0 ? 'USED' : 'AVAILABLE'
      }, { transaction });
      await createPendingSettlement({
        sourceType: 'BATCH_OUTBOUND',
        sourceId: `${application.application_id}:${item.item_id}:${right.right_id}`,
        sn: { sn_id: null, sn_code: null, product_id: item.product_id },
        resourceType,
        amount: Number(right.amount_per_unit || 0) * deduct,
        remark: `非SN批量出库 ${application.application_no} 触发权益，数量 ${deduct}`,
        transaction
      });
      remaining -= deduct;
    }
    if (remaining > 0) throw Object.assign(new Error(`非SN资源权益 ${resourceType} 批次数量不足`), { status: 409 });
  }
}

async function executeApplication(application, transaction) {
  const items = await InventoryBatchApplicationItem.findAll({
    where: { application_id: application.application_id },
    order: [['row_no', 'ASC']],
    transaction
  });

  for (const item of items) {
    if (Number(item.need_sn || 0) === 1) {
      if (item.operation_type === 'INBOUND') {
        await createSnInbound(item, application, transaction);
        await updateInventoryQty(item.product_id, item.store_id, item.inventory_type, 1, transaction, item.location_id || '');
      } else {
        const sn = await ProductSn.findOne({ where: { sn_id: item.sn_id || '', is_deleted: 0 }, transaction });
        if (!sn || sn.status !== 'in_stock') throw Object.assign(new Error(`第 ${item.row_no} 行SN不在库，无法执行`), { status: 409 });
        await sn.update({ status: 'out_stock' }, { transaction });
        await updateInventoryQty(item.product_id, item.store_id, item.inventory_type, -1, transaction, item.location_id || '');
        if (Number(item.trigger_resource_rights || 0) === 1) {
          const resourceTypes = parseJsonArray(item.resource_types);
          const rights = await InventoryResourceRight.findAll({
            where: { sn_id: sn.sn_id, resource_type: { [Op.in]: resourceTypes }, current_status: 'AVAILABLE' },
            transaction
          });
          for (const right of rights) {
            await right.update({ current_status: 'USED', update_time: new Date() }, { transaction });
            await createPendingSettlement({
              sourceType: 'BATCH_OUTBOUND',
              sourceId: `${application.application_id}:${item.item_id}:${right.right_id}`,
              sn,
              resourceType: right.resource_type,
              amount: right.amount,
              remark: `批量出库 ${application.application_no} 触发权益`,
              transaction
            });
          }
        }
      }
    } else {
      const delta = item.operation_type === 'OUTBOUND' ? -Number(item.quantity || 0) : Number(item.quantity || 0);
      const result = await updateInventoryQty(item.product_id, item.store_id, item.inventory_type, delta, transaction, item.location_id || '');
      await item.update({ before_qty: result.before, after_qty: result.after }, { transaction });
      if (item.operation_type === 'INBOUND') {
        await createNonSnBatchRights(item, application, transaction);
      } else if (item.operation_type === 'OUTBOUND' && Number(item.trigger_resource_rights || 0) === 1) {
        await consumeNonSnBatchRights(item, application, transaction);
      }
    }
  }
}

async function reviewBatchApplication(ctx) {
  const user = ctx.state.user;
  const { action, comment = '' } = ctx.request.body || {};
  if (!canReview(user)) ctx.throw(403, '只有经销商总权限账号或BOSS可以审批批量库存维护');
  if (!['approve', 'reject'].includes(action)) ctx.throw(400, '审批动作无效');

  const transaction = await sequelize.transaction();
  try {
    const app = await InventoryBatchApplication.findByPk(ctx.params.applicationId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!app) ctx.throw(404, '批量维护申请不存在');
    if (app.status !== 'pending') ctx.throw(409, '该申请已处理');
    if (String(app.applicant_staff_id || '') === String(user.staffId || '')) ctx.throw(403, '申请人不得审批自己的申请');
    if (!isBoss(user) && String(app.applicant_distributor_id || '') !== String(user.distributorId || '')) {
      ctx.throw(403, '只能审批本经销商范围内的批量库存申请');
    }

    await app.update({
      reviewer_staff_id: user.staffId || null,
      reviewer_name: user.name || '',
      review_comment: comment,
      review_time: new Date()
    }, { transaction });

    if (action === 'reject') {
      await app.update({ status: 'rejected' }, { transaction });
      await transaction.commit();
      ctx.body = { message: '批量维护申请已拒绝' };
      return;
    }

    await executeApplication(app, transaction);
    await app.update({ status: 'executed', execute_time: new Date(), update_time: new Date() }, { transaction });
    await transaction.commit();
    ctx.body = { message: '批量维护申请已审批并执行' };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

module.exports = {
  createBatchApplication,
  listBatchApplications,
  getBatchApplicationDetail,
  reviewBatchApplication,
  _test: { parseWorkbook, normalizeResourceTypes, validateRows }
};
