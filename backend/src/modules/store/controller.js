/**
 * 门店管理控制器
 */
const { Store, Region, Location, Staff } = require('../../models');
const { Op } = require('sequelize');
const { paginate, formatPaginatedResult } = require('../../utils');
const { generateId } = require('../../utils');
const { ensureStandardLocationsForStores } = require('../../utils/standardLocations');

/**
 * 获取区域列表
 */
async function getRegionList(ctx) {
  let regions = await Region.findAll({
    where: { status: 1 },
    order: [['sort_order', 'ASC']],
    attributes: ['region_id', 'region_code', 'name']
  });
  
  // 如果没有区域数据，自动初始化默认区域
  if (regions.length === 0) {
    const defaultRegions = [
      { region_id: 'R001', region_code: 'CD', name: '成都区域', sort_order: 1, status: 1 },
      { region_id: 'R002', region_code: 'CQ', name: '重庆区域', sort_order: 2, status: 1 },
      { region_id: 'R003', region_code: 'DS', name: '地市区域', sort_order: 3, status: 1 }
    ];
    
    await Region.bulkCreate(defaultRegions);
    
    regions = await Region.findAll({
      where: { status: 1 },
      order: [['sort_order', 'ASC']],
      attributes: ['region_id', 'region_code', 'name']
    });
  }
  
  ctx.body = { code: 0, data: regions };
}

/**
 * 获取所有门店（用于下拉选择，不分页）
 */
async function getAllStores(ctx) {
  const user = ctx.state.user;

  const where = { is_deleted: 0, status: 1 };

  if (!user.accessibleStoreIds.includes('*')) {
    where.store_id = user.accessibleStoreIds;
  }

  const rows = await Store.findAll({
    where,
    attributes: ['store_id', 'name', 'manager_staff_id'],
    order: [['name', 'ASC']]
  });

  ctx.body = { code: 0, data: rows };
}

/**
 * 调拨门店选项：向登录用户开放同一经销商、同一区域内的有效门店。
 * 普通库存下拉仍保持原有的门店权限范围。
 */
async function getTransferStores(ctx) {
  const user = ctx.state.user || {};
  const where = { is_deleted: 0, status: 1 };
  let currentRegionKeys = [];
  if (!user.roles?.includes('boss')) {
    let distributorId = '';
    if (user.storeId) {
      const currentStore = await Store.findOne({
        where: { store_id: user.storeId, is_deleted: 0 },
        attributes: ['distributor_id', 'region_id'],
        include: [{ model: Region, attributes: ['region_id', 'region_code', 'name'] }]
      });
      distributorId = currentStore?.distributor_id || '';
      currentRegionKeys = [
        currentStore?.region_id,
        currentStore?.Region?.region_id,
        currentStore?.Region?.region_code,
        currentStore?.Region?.name
      ].filter(Boolean).map(String);
    }
    distributorId = distributorId || user.distributorId || '';
    if (distributorId) where.distributor_id = distributorId;
  }

  // 门店账号也要能看到本经销商的全部门店，区域限制在提交调拨时由
  // assertTransferScope 统一校验，避免区域字段格式不一致导致下拉只剩当前门店。

  const rows = await Store.findAll({
    where,
    attributes: ['store_id', 'distributor_id', 'region_id', 'name'],
    include: [{ model: Region, attributes: ['region_code', 'name'] }],
    order: [['name', 'ASC']]
  });

  ctx.body = {
    code: 0,
    data: rows.map(row => ({
      ...row.toJSON(),
      region_code: row.Region?.region_code || '',
      region_name: row.Region?.name || '',
      same_region: !currentRegionKeys.length || [
        row.region_id,
        row.Region?.region_id,
        row.Region?.region_code,
        row.Region?.name
      ].filter(Boolean).map(String).some(key => currentRegionKeys.includes(key))
    }))
  };
}

/**
 * 门店列表
 */
async function getStoreList(ctx) {
  const { regionName, keyword, page = 1, pageSize = 20 } = ctx.query;
  const user = ctx.state.user;

  const where = { is_deleted: 0 };

  // 区域权限过滤
  if (!user.accessibleStoreIds.includes('*')) {
    where.store_id = user.accessibleStoreIds;
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
    attributes: ['store_id', 'name', 'phone', 'address', 'status', 'manager_staff_id'],
    include: [
      { model: Region, attributes: ['region_code', 'name'] },
      { model: Staff, as: 'Manager', attributes: ['staff_id', 'name'], required: false }
    ],
    order: [['create_time', 'DESC']],
    ...paginate({}, { page, pageSize })
  });

  // 格式化返回数据，添加 region_name
  const formattedRows = rows.map(row => ({
    ...row.toJSON(),
    region_name: row.Region ? row.Region.name : null,
    manager_name: row.Manager?.name || ''
  }));

  ctx.body = formatPaginatedResult(formattedRows, { page, pageSize, count });
}

/**
 * 创建门店
 */
async function createStore(ctx) {
  const { storeId: userStoreId, name, regionName, regionCode, phone, address, status = 1 } = ctx.request.body;
  const user = ctx.state.user;

  if (!name) {
    ctx.throw(400, '门店名称不能为空');
  }

  if (!userStoreId) {
    ctx.throw(400, '门店ID不能为空');
  }

  const existingStore = await Store.findOne({ where: { store_id: userStoreId, is_deleted: 0 } });
  if (existingStore) {
    ctx.throw(400, '门店ID已存在');
  }

  // 根据区域查找 region_id（优先 regionCode，其次 regionName）
  let regionId = null;
  if (regionCode) {
    const region = await Region.findOne({ where: { region_code: regionCode } });
    if (region) {
      regionId = region.region_id;
    }
  } else if (regionName) {
    const region = await Region.findOne({ where: { name: regionName } });
    if (region) {
      regionId = region.region_id;
    }
  }

  const storeId = userStoreId;

  // 如果用户有区域限制，只能创建该区域的门店
  let distributorId = user.distributorId;
  if (!user.regionCodes.includes('*') && regionId) {
    if (!user.regionCodes.includes(regionId)) {
      ctx.throw(403, '无权创建该区域的门店');
    }
  }

  const store = await Store.create({
    store_id: storeId,
    distributor_id: distributorId,
    region_id: regionId,
    name,
    phone: phone || '',
    address: address || '',
    status
  });
  await ensureStandardLocationsForStores(Location, [store]);

  ctx.body = { code: 0, message: '创建成功', data: { storeId: store.store_id } };
}

/**
 * 更新门店
 */
async function updateStore(ctx) {
  const { id } = ctx.params;
  const { name, regionName, regionCode, phone, address, status } = ctx.request.body;
  const user = ctx.state.user;

  const store = await Store.findOne({
    where: { store_id: id, is_deleted: 0 }
  });

  if (!store) {
    ctx.throw(404, '门店不存在');
  }

  // 区域权限检查
  if (!user.accessibleStoreIds.includes('*') && !user.accessibleStoreIds.includes(String(store.store_id))) {
    ctx.throw(403, '无权操作该门店');
  }

  // 根据区域查找 region_id（优先 regionCode，其次 regionName）
  let regionId = store.region_id;
  if (regionCode) {
    const region = await Region.findOne({ where: { region_code: regionCode } });
    if (region) {
      regionId = region.region_id;
    }
  } else if (regionName) {
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

/**
 * 删除门店
 */
async function deleteStore(ctx) {
  const { id } = ctx.params;
  const user = ctx.state.user;

  const store = await Store.findOne({
    where: { store_id: id, is_deleted: 0 }
  });

  if (!store) {
    ctx.throw(404, '门店不存在');
  }

  // 区域权限检查
  if (!user.accessibleStoreIds.includes('*') && !user.accessibleStoreIds.includes(String(store.store_id))) {
    ctx.throw(403, '无权操作该门店');
  }

  await store.update({ is_deleted: 1 });
  ctx.body = { code: 0, message: '删除成功' };
}

module.exports = { getStoreList, getAllStores, getTransferStores, createStore, updateStore, deleteStore, getRegionList };
