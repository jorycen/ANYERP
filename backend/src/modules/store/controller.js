/**
 * 门店管理控制器
 */
const { Store, Region } = require('../../models');
const { Op } = require('sequelize');
const { paginate, formatPaginatedResult } = require('../../utils');
const { generateId } = require('../../utils');

/**
 * 门店列表
 */
async function getStoreList(ctx) {
  const { regionName, keyword, page = 1, pageSize = 20 } = ctx.query;
  const user = ctx.state.user;

  const where = { is_deleted: 0 };

  // 区域权限过滤
  if (!user.regionCodes.includes('*')) {
    where.region_id = user.regionCodes;
  }

  // 按区域名称过滤
  if (regionName) {
    const region = await Region.findOne({ where: { name: regionName } });
    if (region) {
      where.region_id = region.region_id;
    }
  }

  if (keyword) {
    where[Op.or] = [
      { name: { [Op.like]: `%${keyword}%` } },
      { address: { [Op.like]: `%${keyword}%` } }
    ];
  }

  const { count, rows } = await Store.findAndCountAll({
    where,
    include: [
      { model: Region, attributes: ['region_code', 'name'] }
    ],
    order: [['create_time', 'DESC']],
    ...paginate({}, { page, pageSize })
  });

  // 格式化返回数据，添加 region_name
  const formattedRows = rows.map(row => ({
    ...row.toJSON(),
    region_name: row.Region ? row.Region.name : null
  }));

  ctx.body = formatPaginatedResult(formattedRows, { page, pageSize, count });
}

/**
 * 创建门店
 */
async function createStore(ctx) {
  const { name, regionName, phone, address, status = 1 } = ctx.request.body;
  const user = ctx.state.user;

  if (!name) {
    ctx.throw(400, '门店名称不能为空');
  }

  // 根据区域名称查找 region_id
  let regionId = null;
  if (regionName) {
    const region = await Region.findOne({ where: { name: regionName } });
    if (region) {
      regionId = region.region_id;
    }
  }

  const storeId = generateId('S');

  // 如果用户有区域限制，只能创建该区域的门店
  let distributorId = user.distributorId;
  if (!user.regionCodes.includes('*') && regionId) {
    if (!user.regionCodes.includes(regionId)) {
      ctx.throw(403, '无权创建该区域的门店');
    }
  }

  await Store.create({
    store_id: storeId,
    distributor_id: distributorId,
    region_id: regionId,
    name,
    phone: phone || '',
    address: address || '',
    status
  });

  ctx.body = { code: 0, message: '创建成功' };
}

/**
 * 更新门店
 */
async function updateStore(ctx) {
  const { id } = ctx.params;
  const { name, regionName, phone, address, status } = ctx.request.body;
  const user = ctx.state.user;

  const store = await Store.findOne({
    where: { store_id: id, is_deleted: 0 }
  });

  if (!store) {
    ctx.throw(404, '门店不存在');
  }

  // 区域权限检查
  if (!user.regionCodes.includes('*') && !user.regionCodes.includes(store.region_id)) {
    ctx.throw(403, '无权操作该门店');
  }

  // 根据区域名称查找 region_id
  let regionId = store.region_id;
  if (regionName) {
    const region = await Region.findOne({ where: { name: regionName } });
    if (region) {
      regionId = region.region_id;
    }
  }

  await store.update({
    name: name || store.name,
    region_id: regionId,
    phone: phone !== undefined ? phone : store.phone,
    address: address !== undefined ? address : store.address,
    status: status !== undefined ? status : store.status
  });

  ctx.body = { code: 0, message: '更新成功' };
}

module.exports = { getStoreList, createStore, updateStore };
