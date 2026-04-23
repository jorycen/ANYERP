/**
 * 采购管理控制器
 */
const { PurchaseRequest, PurchaseRequestItem, Supplier, Store } = require('../../models');
const { Op } = require('sequelize');
const { generateRequestNo, generateUUID, paginate, formatPaginatedResult } = require('../../utils');

/**
 * 采购申请列表
 */
async function getRequestList(ctx) {
  const { storeId, status, page = 1, pageSize = 20 } = ctx.query;
  const user = ctx.state.user;

  const where = {};
  const whereStore = {};

  // 区域权限过滤
  if (!user.regionCodes.includes('*')) {
    whereStore.region_id = user.regionCodes;
  }
  if (storeId) whereStore.store_id = storeId;

  const stores = await Store.findAll({ where: whereStore });
  const storeIds = stores.map(s => s.store_id);
  where.store_id = storeIds;

  if (status) where.status = status;

  const { count, rows } = await PurchaseRequest.findAndCountAll({
    where,
    include: [
      { model: Store },
      { model: Supplier }
    ],
    order: [['create_time', 'DESC']],
    ...paginate({}, { page, pageSize })
  });

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

/**
 * 创建采购申请
 */
async function createRequest(ctx) {
  const user = ctx.state.user;
  const { storeId, supplierId, reason, items } = ctx.request.body;

  const requestNo = generateRequestNo();
  const requestId = generateUUID();

  const totalAmount = items.reduce((sum, item) => sum + Number(item.subtotal), 0);

  await PurchaseRequest.create({
    request_id: requestId,
    request_no: requestNo,
    store_id: storeId || user.storeId,
    supplier_id: supplierId,
    reason,
    total_amount: totalAmount,
    status: 'pending',
    apply_user: user.name
  });

  // 创建明细
  for (const item of items) {
    await PurchaseRequestItem.create({
      request_id: requestId,
      product_id: item.productId,
      product_name: item.productName,
      pn_code: item.pnCode,
      quantity: item.quantity,
      unit_price: item.unitPrice,
      subtotal: item.subtotal
    });
  }

  ctx.body = { requestId, requestNo, message: '采购申请提交成功' };
}

/**
 * 审批采购申请
 */
async function approveRequest(ctx) {
  const { requestId } = ctx.params;
  const { status, comment } = ctx.request.body;
  const user = ctx.state.user;

  const request = await PurchaseRequest.findByPk(requestId);
  if (!request) {
    ctx.throw(404, '采购申请不存在');
  }

  await request.update({
    status,
    approve_user: user.name,
    approve_comment: comment
  });

  ctx.body = { message: '审批完成' };
}

/**
 * 供应商列表
 */
async function getSupplierList(ctx) {
  const { keyword, page = 1, pageSize = 20 } = ctx.query;

  const where = { is_deleted: 0 };
  if (keyword) {
    where[Op.or] = [
      { name: { [Op.like]: `%${keyword}%` } },
      { contact: { [Op.like]: `%${keyword}%` } }
    ];
  }

  const { count, rows } = await Supplier.findAndCountAll({
    where,
    order: [['create_time', 'DESC']],
    ...paginate({}, { page, pageSize })
  });

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

module.exports = { getRequestList, createRequest, approveRequest, getSupplierList };
