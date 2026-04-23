/**
 * 库房管理控制器
 */
const { ProductSn, Product, Store, Location, InventoryWarning } = require('../../models');
const { Op } = require('sequelize');
const { generateInboundNo, generateOutboundNo, generateTransferNo, generateUUID, generateBatchNo, paginate, formatPaginatedResult } = require('../../utils');

/**
 * SN序列号列表
 */
async function getSnList(ctx) {
  const { storeId, productId, status, snCode, page = 1, pageSize = 20 } = ctx.query;
  const user = ctx.state.user;

  const where = { is_deleted: 0 };
  const whereStore = {};

  // 区域权限过滤
  if (!user.regionCodes.includes('*')) {
    whereStore.region_id = user.regionCodes;
  }
  if (storeId) whereStore.store_id = storeId;

  const stores = await Store.findAll({ where: whereStore });
  const storeIds = stores.map(s => s.store_id);
  where.store_id = storeIds;

  if (productId) where.product_id = productId;
  if (status) where.status = status;
  if (snCode) where.sn_code = { [Op.like]: `%${snCode}%` };

  const { count, rows } = await ProductSn.findAndCountAll({
    where,
    include: [
      { model: Product, attributes: ['name', 'category', 'need_sn'] },
      { model: Store, attributes: ['name', 'region_id'] },
      { model: Location, attributes: ['name'] }
    ],
    order: [['create_time', 'DESC']],
    ...paginate({}, { page, pageSize })
  });

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

/**
 * 入库操作
 */
async function inbound(ctx) {
  const user = ctx.state.user;
  const { storeId, sourceType, sourceNo, items } = ctx.request.body;

  const inboundNo = generateInboundNo();
  const inboundId = generateUUID();

  // TODO: 创建入库单和明细，更新SN状态

  ctx.body = { inboundId, inboundNo, message: '入库成功' };
}

/**
 * 出库操作
 */
async function outbound(ctx) {
  const user = ctx.state.user;
  const { storeId, outType, items } = ctx.request.body;

  const outboundNo = generateOutboundNo();
  const outboundId = generateUUID();

  // TODO: 创建出库单和明细，更新SN状态

  ctx.body = { outboundId, outboundNo, message: '出库成功' };
}

/**
 * 调拨操作
 */
async function transfer(ctx) {
  const user = ctx.state.user;
  const { fromStoreId, toStoreId, items } = ctx.request.body;

  const transferNo = generateTransferNo();
  const transferId = generateUUID();

  // TODO: 创建调拨单，更新SN状态

  ctx.body = { transferId, transferNo, message: '调拨成功' };
}

module.exports = { getSnList, inbound, outbound, transfer };
