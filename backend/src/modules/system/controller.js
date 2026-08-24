/**
 * 系统管理控制器
 */
const bcrypt = require('bcryptjs');
const { sequelize, Menu, Role, RoleMenu, Staff, StaffRole, StaffStorePermission, StaffDistributorPermission, RegionPermission, Region, Store, Location, Inventory, ProductSn, Distributor } = require('../../models');
const { Op } = require('sequelize');
const { generateUUID } = require('../../utils');
const { getStandardLocation } = require('../../utils/standardLocations');
const { isRegionScopedAccount } = require('../../utils/storePermissions');
const { accessibleDistributorIds, canAccessDistributor, uniqueIds, validateDistributorIds } = require('../../utils/distributorScope');

function getResetPasswordFromPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 6) return '';
  return digits.slice(-6);
}

function isBoss(user) {
  return user.roles.includes('boss');
}

function manageableStoreWhere(user) {
  if (isBoss(user)) return { is_deleted: 0 };
  const distributorIds = accessibleDistributorIds(user);
  if (distributorIds.length === 0) {
    const error = new Error('当前账号未绑定经销商');
    error.status = 403;
    throw error;
  }
  return { distributor_id: distributorIds.length === 1 ? distributorIds[0] : { [Op.in]: distributorIds }, is_deleted: 0 };
}

async function getStaffDistributorIds(staffId) {
  const rows = await StaffDistributorPermission.findAll({ where: { staff_id: staffId }, attributes: ['distributor_id'], raw: true });
  return uniqueIds(rows.map(row => row.distributor_id));
}

function normalizeRequestedDistributorIds(body = {}, fallback = '') {
  const values = body.distributorIds ?? body.distributor_ids;
  if (Array.isArray(values)) return uniqueIds(values);
  if (body.distributorId !== undefined) return uniqueIds([body.distributorId]);
  return uniqueIds([fallback]);
}

async function replaceStaffDistributorPermissions(staff, distributorIds, transaction) {
  await StaffDistributorPermission.destroy({ where: { staff_id: staff.staff_id }, transaction });
  if (distributorIds.length) {
    await StaffDistributorPermission.bulkCreate(
      distributorIds.map(distributorId => ({ staff_id: staff.staff_id, distributor_id: distributorId })),
      { transaction }
    );
  }
}

function normalizeLocationInput(ctx, body, isUpdate = false) {
  const name = String(body.name || '').trim();
  const type = String(body.type || '').trim();
  const standardLocation = getStandardLocation(type);
  const isSellable = body.isSellable ?? body.is_sellable ?? standardLocation?.is_sellable ?? 1;
  const status = body.status ?? 1;

  if (!type) ctx.throw(400, '请选择仓位编码');
  if (!standardLocation) ctx.throw(400, '仓位编码不在标准仓位范围内');

  if (Number(isSellable) !== Number(standardLocation.is_sellable)) {
    ctx.throw(400, `${standardLocation.name}的可销售属性固定为${standardLocation.is_sellable ? '可销售' : '不可销售'}`);
  }

  if (!isUpdate || name) {
    if (!name) ctx.throw(400, '请输入库位名称');
    if (name.length > 64) ctx.throw(400, '库位名称不能超过64个字符');
  }

  return {
    name,
    type,
    is_sellable: Number(isSellable) ? 1 : 0,
    status: Number(status) ? 1 : 0
  };
}

async function getManageableStores(ctx, extraWhere = {}) {
  return Store.findAll({
    where: { ...manageableStoreWhere(ctx.state.user), ...extraWhere },
    attributes: ['store_id', 'name', 'distributor_id'],
    order: [['name', 'ASC']]
  });
}

function sortLocationGroups(a, b) {
  const aStd = getStandardLocation(a.type);
  const bStd = getStandardLocation(b.type);
  const aOrder = aStd?.sort_order || 999;
  const bOrder = bStd?.sort_order || 999;
  if (aOrder !== bOrder) return aOrder - bOrder;
  return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN');
}


/**
 * 获取菜单列表
 */
async function getMenus(ctx) {
  const { type, status } = ctx.query;
  const where = {};
  if (type) where.menu_type = type;
  if (status !== undefined) where.status = status;

  const menus = await Menu.findAll({
    where,
    order: [['sort_order', 'ASC'], ['menu_id', 'ASC']]
  });

  ctx.body = buildMenuTree(menus);
}

/**
 * 保存菜单树的顺序和层级
 *
 * 菜单权限仍然只关联 menu_id；这里仅更新 parent_id 和 sort_order。
 */
async function reorderMenus(ctx) {
  const rawItems = ctx.request.body?.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    ctx.throw(400, '菜单排序数据不能为空');
  }

  const menus = await Menu.findAll({ attributes: ['menu_id', 'parent_id'] });
  const menuMap = new Map(menus.map(menu => [String(menu.menu_id), menu]));
  const seenIds = new Set();
  const items = rawItems.map((item, index) => {
    const menuId = String(item?.menuId ?? item?.menu_id ?? '').trim();
    if (!menuId || !menuMap.has(menuId)) ctx.throw(400, `菜单不存在: ${menuId || index + 1}`);
    if (seenIds.has(menuId)) ctx.throw(400, `菜单重复提交: ${menuId}`);
    seenIds.add(menuId);

    const rawParentId = item?.parentId ?? item?.parent_id ?? null;
    const parentId = rawParentId === null || rawParentId === undefined || String(rawParentId).trim() === ''
      ? null
      : String(rawParentId).trim();
    if (parentId && !menuMap.has(parentId)) ctx.throw(400, `父菜单不存在: ${parentId}`);

    const sortOrder = Number(item?.sortOrder ?? item?.sort_order ?? index);
    if (!Number.isInteger(sortOrder) || sortOrder < 0) {
      ctx.throw(400, '菜单排序值必须是非负整数');
    }

    return { menuId, parentId, sortOrder };
  });

  // 用提交后的父级关系检查环，避免菜单成为自己的祖先。
  const proposedParents = new Map(
    menus.map(menu => [String(menu.menu_id), menu.parent_id ? String(menu.parent_id) : null])
  );
  items.forEach(item => proposedParents.set(item.menuId, item.parentId));
  for (const item of items) {
    const visited = new Set();
    let currentId = item.menuId;
    while (currentId) {
      if (visited.has(currentId)) ctx.throw(400, '菜单层级不能形成循环');
      visited.add(currentId);
      currentId = proposedParents.get(currentId) || null;
    }
  }

  await sequelize.transaction(async transaction => {
    for (const item of items) {
      await Menu.update(
        { parent_id: item.parentId, sort_order: item.sortOrder },
        { where: { menu_id: item.menuId }, transaction }
      );
    }
  });

  ctx.body = { message: '菜单排序已保存' };
}

/**
 * 获取角色列表
 */
async function getRoles(ctx) {
  const where = { status: 1 };
  if (!ctx.state.user.roles.includes('boss')) where.role_code = { [Op.ne]: 'boss' };
  const roles = await Role.findAll({
    where,
    attributes: ['role_id', 'name', 'description', 'is_system', 'status'],
    order: [['role_id', 'ASC']]
  });
  ctx.body = roles;
}

async function resolveLocationStoreIds(ctx, rawStoreIds, { fallbackToAll = false, allowEmpty = false } = {}) {
  const manageableStores = await getManageableStores(ctx, { status: 1 });
  const manageableIds = new Set(manageableStores.map(store => String(store.store_id)));
  const provided = rawStoreIds === undefined || rawStoreIds === null
    ? []
    : (Array.isArray(rawStoreIds) ? rawStoreIds : [rawStoreIds]);
  const requestedIds = [...new Set(provided.map(value => String(value || '').trim()).filter(Boolean))];
  const storeIds = requestedIds.length || !fallbackToAll
    ? requestedIds
    : manageableStores.map(store => String(store.store_id));

  const invalidStoreId = storeIds.find(storeId => !manageableIds.has(storeId));
  if (invalidStoreId) ctx.throw(403, '适用门店不存在、已停用或不在当前账号管理范围内');
  if (storeIds.length === 0 && !allowEmpty) ctx.throw(400, '至少选择一个适用门店');

  return {
    storeIds,
    stores: manageableStores.filter(store => storeIds.includes(String(store.store_id)))
  };
}

function getInventoryQuantityForLocation(row) {
  const normalQty = Math.max(Number(row.normal_qty || 0), Number(row.regular_qty || 0) + Number(row.subsidy_qty || 0) + Number(row.second_qty || 0));
  return normalQty
    + Number(row.display_qty || 0)
    + Number(row.demo_qty || 0)
    + Number(row.unsellable_qty || 0)
    + Number(row.pending_qty || 0)
    + Number(row.rental_demo_qty || 0);
}

async function getLocationStockSummary(locationId, transaction) {
  const inventoryRows = await Inventory.findAll({
    where: { location_id: locationId },
    attributes: ['normal_qty', 'regular_qty', 'subsidy_qty', 'second_qty', 'display_qty', 'demo_qty', 'unsellable_qty', 'pending_qty', 'rental_demo_qty'],
    transaction,
    raw: true
  });
  const quantity = inventoryRows.reduce((sum, row) => sum + Math.max(getInventoryQuantityForLocation(row), 0), 0);
  const snCount = await ProductSn.count({
    where: { location_id: locationId, status: 'in_stock', is_deleted: 0 },
    transaction
  });
  return { quantity, snCount };
}

async function assertLocationsCanBeDisabled(ctx, locations, transaction) {
  for (const location of locations) {
    if (Number(location.status) !== 1) continue;
    const summary = await getLocationStockSummary(location.location_id, transaction);
    if (summary.quantity > 0 || summary.snCount > 0) {
      const storeName = location.Store?.name || location.store_name || location.store_id;
      const detail = [
        summary.quantity > 0 ? `库存数量 ${summary.quantity}` : '',
        summary.snCount > 0 ? `在库SN ${summary.snCount} 台` : ''
      ].filter(Boolean).join('，');
      ctx.throw(409, `库位“${location.name}”（${storeName}）仍有${detail}，无法停用，请先处理库存`);
    }
  }
}

/** 获取可用于账号归属和多经销商权限配置的经销商列表。 */
async function getUserDistributors(ctx) {
  const scope = accessibleDistributorIds(ctx.state.user);
  const where = { is_deleted: 0, status: 1 };
  if (!scope.includes('*')) {
    if (!scope.length) ctx.throw(403, '当前账号未配置经销商范围');
    where.distributor_id = { [Op.in]: scope };
  }
  const rows = await Distributor.findAll({ where, attributes: ['distributor_id', 'name', 'region_id'], order: [['distributor_id', 'ASC']], raw: true });
  const data = rows.map(row => ({ distributor_id: row.distributor_id, name: row.name || row.distributor_id, region_id: row.region_id || '' }));
  ctx.body = { code: 0, data };
}

/**
 * 获取角色的菜单权限
 */
function validateRoleInput(ctx, body, isUpdate = false) {
  const name = String(body.name || '').trim();
  const description = String(body.description || '').trim();

  if (!isUpdate || name) {
    if (!name) ctx.throw(400, '请输入角色名称');
  }
  return { name, description };
}

async function createRole(ctx) {
  const { name, description } = validateRoleInput(ctx, ctx.request.body);
  const roleId = generateUUID();

  const role = await Role.create({
    role_id: roleId,
    role_code: `role_${roleId.slice(0, 27)}`,
    name,
    description,
    is_system: 0,
    status: 1
  });

  ctx.body = { code: 0, message: '角色创建成功', data: { roleId: role.role_id } };
}

async function updateRole(ctx) {
  const { roleId } = ctx.params;
  const role = await Role.findByPk(roleId);
  if (!role || role.status === 0) ctx.throw(404, '角色不存在');
  if (role.is_system) ctx.throw(400, '系统角色不可编辑');

  const { name, description } = validateRoleInput(ctx, ctx.request.body, true);
  const updateData = {};
  if (name) updateData.name = name;
  if (Object.prototype.hasOwnProperty.call(ctx.request.body, 'description')) updateData.description = description;
  await role.update(updateData);

  ctx.body = { code: 0, message: '角色更新成功' };
}

async function deleteRole(ctx) {
  const { roleId } = ctx.params;
  const role = await Role.findByPk(roleId);
  if (!role || role.status === 0) ctx.throw(404, '角色不存在');
  if (role.is_system) ctx.throw(400, '系统角色不可删除');

  const userCount = await StaffRole.count({ where: { role_id: roleId } });
  if (userCount > 0) ctx.throw(400, '该角色已有用户使用，不能删除');

  await RoleMenu.destroy({ where: { role_id: roleId } });
  await StaffRole.destroy({ where: { role_id: roleId } });
  await role.update({ status: 0 });

  ctx.body = { code: 0, message: '角色删除成功' };
}

async function getRoleMenus(ctx) {
  const { roleId } = ctx.params;
  const roleMenus = await RoleMenu.findAll({
    where: { role_id: roleId },
    attributes: ['menu_id'],
    raw: true
  });
  ctx.body = {
    code: 0,
    message: 'success',
    data: roleMenus.map(rm => String(rm.menu_id))
  };
}

/**
 * 分配角色菜单权限
 */
async function assignMenus(ctx) {
  const { roleId } = ctx.params;
  const { menuIds } = ctx.request.body;

  const role = await Role.findOne({ where: { role_id: roleId, status: 1 } });
  if (!role) ctx.throw(404, '角色不存在');
  if (role.role_code === 'boss') {
    ctx.throw(400, '老板角色权限不可修改');
  }

  if (!Array.isArray(menuIds)) ctx.throw(400, '菜单权限格式不正确');
  const uniqueMenuIds = [...new Set(menuIds.map(id => String(id || '').trim()).filter(Boolean))];
  const validMenus = uniqueMenuIds.length > 0
    ? await Menu.findAll({ where: { menu_id: uniqueMenuIds, status: 1 }, attributes: ['menu_id'] })
    : [];
  if (validMenus.length !== uniqueMenuIds.length) ctx.throw(400, '菜单权限中存在无效菜单');

  await sequelize.transaction(async transaction => {
    await RoleMenu.destroy({ where: { role_id: roleId }, transaction });
    if (uniqueMenuIds.length > 0) {
      await RoleMenu.bulkCreate(uniqueMenuIds.map(menuId => ({ role_id: roleId, menu_id: menuId })), { transaction });
    }
  });

  ctx.body = { code: 0, message: '权限分配成功' };
}

/**
 * 获取用户列表
 */
async function getUsers(ctx) {
  const { keyword, storeId, regionCode, page = 1, pageSize = 20 } = ctx.query;
  const user = ctx.state.user;
  const where = { is_deleted: 0 };

  const visibleDistributorIds = accessibleDistributorIds(user);
  if (!visibleDistributorIds.includes('*')) {
    if (!visibleDistributorIds.length) ctx.throw(403, '当前账号未配置经销商范围');
    where.distributor_id = { [Op.in]: visibleDistributorIds };
  }

  if (keyword) {
    where[Op.or] = [
      { name: { [Op.like]: `%${keyword}%` } },
      { phone: { [Op.like]: `%${keyword}%` } }
    ];
  }
  const hasStoreScopeFilter = Boolean(storeId || regionCode);
  const assignedStoresInclude = {
    model: Store,
    as: 'AssignedStores',
    attributes: ['store_id', 'name', 'region_id'],
    include: [{ model: Region, attributes: ['region_id', 'name'], required: false }],
    through: { attributes: [] },
    where: { ...(storeId ? { store_id: storeId } : {}), ...(regionCode ? { region_id: regionCode } : {}), is_deleted: 0, status: 1 },
    required: hasStoreScopeFilter,
  };
  const { count, rows } = await Staff.findAndCountAll({
    where,
    attributes: { exclude: ['password_hash', 'role_code'] },
    include: [
      { model: Role, as: 'Roles', attributes: ['role_id', 'role_code', 'name'], through: { attributes: [] } },
      { model: Staff, as: 'Supervisor', attributes: ['staff_id', 'name'], required: false },
      { model: Region, as: 'Region' },
      { model: RegionPermission, as: 'RegionPermissions' },
      { model: Distributor, as: 'AssignedDistributors', attributes: ['distributor_id', 'name'], through: { attributes: [] }, required: false },
      assignedStoresInclude
    ],
    distinct: true,
    order: [['create_time', 'DESC']],
    limit: Number(pageSize),
    offset: (Number(page) - 1) * Number(pageSize)
  });

  const allActiveStores = await Store.findAll({
    where: { ...(visibleDistributorIds.includes('*') ? {} : { distributor_id: { [Op.in]: visibleDistributorIds } }), is_deleted: 0, status: 1 },
    attributes: ['store_id', 'name', 'region_id'],
    include: [{ model: Region, attributes: ['region_id', 'name'], required: false }],
    order: [['name', 'ASC']]
  });
  const allActiveRegions = await Region.findAll({
    where: { status: 1 },
    attributes: ['region_id', 'region_code', 'name'],
    order: [['sort_order', 'ASC']]
  });

  ctx.body = {
    list: rows.map(row => {
      const data = row.toJSON();
      const roleNames = (data.Roles || []).map(role => role.name);
      const roleIds = (data.Roles || []).map(role => role.role_id);
      const isBoss = (data.Roles || []).some(role => String(role.role_code || '').trim().toLowerCase() === 'boss')
        || String(data.role_code || '').trim().toLowerCase() === 'boss';
      const roleCodes = (data.Roles || []).map(role => String(role.role_code || '').trim().toLowerCase()).filter(Boolean);
      const regionScoped = !isBoss && isRegionScopedAccount(roleCodes);
      const assignedStores = isBoss ? allActiveStores : (data.AssignedStores || []);
      const assignedStoreNames = assignedStores.map(store => store.name);
      const assignedRegionNames = [...new Set(assignedStores.map(store => store.Region?.name).filter(Boolean))];
      const directRegionNames = [...new Set((data.RegionPermissions || []).map(permission => {
        const key = String(permission.region_code || '');
        const region = allActiveRegions.find(item => String(item.region_id) === key || String(item.region_code) === key || String(item.name) === key);
        return region?.name || '';
      }).filter(Boolean))];
      data.distributor_ids = (data.AssignedDistributors || []).map(item => item.distributor_id || '').filter(Boolean);
      if (!data.distributor_ids.length && data.distributor_id) data.distributor_ids = [data.distributor_id];
      data.distributor_names = (data.AssignedDistributors || []).map(item => item.name || item.distributor_id || '').filter(Boolean);
      const regionNames = directRegionNames.length > 0 ? directRegionNames : assignedRegionNames;
      delete data.Roles;
      delete data.AssignedStores;
      delete data.AssignedDistributors;
      delete data.RegionPermissions;
      data.region_names = regionNames;
      data.region_name = isBoss ? '全部区域' : (regionNames.join('、') || '暂无区域');
      // 历史上只有区域权限的账号没有精确门店记录；列表展示和登录权限继续兼容为该区域全部有效门店。
      const effectiveStores = !isBoss && regionScoped && assignedStores.length === 0
        ? allActiveStores.filter(store => directRegionNames.includes(store.Region?.name))
        : assignedStores;
      const effectiveStoreNames = effectiveStores.map(store => store.name).filter(Boolean);
      const storeName = isBoss ? '全部门店' : (effectiveStoreNames.join('、') || '暂无门店');
      return { ...data, role_ids: roleIds, role_codes: roleCodes, role_names: roleNames, supervisor_name: data.Supervisor?.name || '', supervisor_staff_id: data.supervisor_staff_id || null, store_names: effectiveStoreNames, store_name: storeName, is_boss: isBoss, region_scoped: regionScoped };
    }),
    pagination: {
      total: count,
      page: Number(page),
      pageSize: Number(pageSize),
      totalPages: Math.ceil(count / pageSize)
    }
  };
}

/**
 * 创建用户
 */
async function createUser(ctx) {
  const { name, phone, password, roleIds, status, supervisorStaffId } = ctx.request.body;

  if (!name) ctx.throw(400, '请输入姓名');
  if (!phone) ctx.throw(400, '请输入手机号');
  if (!Array.isArray(roleIds) || roleIds.length !== 1) ctx.throw(400, '每个账号只能选择一个岗位角色');
  if (!password) ctx.throw(400, '请输入初始密码');

  const exist = await Staff.findOne({ where: { phone, is_deleted: 0 } });
  if (exist) ctx.throw(400, '该手机号已存在');

  const uniqueRoleIds = [...new Set(roleIds.map(String))];
  const roles = await Role.findAll({ where: { role_id: uniqueRoleIds, status: 1 } });
  if (roles.length !== uniqueRoleIds.length) ctx.throw(400, '选择的角色不存在或已停用');
  if (!ctx.state.user.roles.includes('boss') && roles.some(role => role.role_code === 'boss')) ctx.throw(403, '无权分配BOSS角色');

  const requestedDistributorIds = normalizeRequestedDistributorIds(ctx.request.body, ctx.state.user.distributorId);
  if (!requestedDistributorIds.length) ctx.throw(400, '请选择所属经销商');
  const targetRoles = roles.map(role => String(role.role_code || '').toLowerCase());
  if (isRegionScopedAccount(targetRoles) && requestedDistributorIds.length > 1) {
    ctx.throw(400, '店员/店长账号只能归属一个经销商');
  }
  const operatorDistributorIds = accessibleDistributorIds(ctx.state.user);
  if (!operatorDistributorIds.includes('*') && requestedDistributorIds.some(id => !operatorDistributorIds.includes(id))) {
    ctx.throw(403, '无权分配其他经销商范围');
  }
  await validateDistributorIds(requestedDistributorIds);
  const distributorId = requestedDistributorIds[0];

  let supervisor = null;
  if (supervisorStaffId) {
    supervisor = await Staff.findByPk(supervisorStaffId);
    if (!supervisor || supervisor.status !== 1 || supervisor.is_deleted) ctx.throw(400, '直属上级不存在或已停用');
    if (!ctx.state.user.roles.includes('boss') && !operatorDistributorIds.includes(String(supervisor.distributor_id))) ctx.throw(403, '直属上级不在当前经销商范围内');
  }

  const hash = bcrypt.hashSync(password, 10);
  if (!distributorId) ctx.throw(400, '当前账号未绑定经销商，无法创建用户');
  const transaction = await sequelize.transaction();
  let staff;
  try {
    staff = await Staff.create({
      distributor_id: distributorId,
      name,
      phone,
      password_hash: hash,
      role_code: roles[0].role_code,
      supervisor_staff_id: supervisor?.staff_id || null,
      status: normalizeStaffStatus(ctx, status, 1)
    }, { transaction });
    await StaffRole.bulkCreate(uniqueRoleIds.map(roleId => ({ staff_id: staff.staff_id, role_id: roleId })), { transaction });
    await replaceStaffDistributorPermissions(staff, requestedDistributorIds, transaction);
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }

  ctx.body = { code: 0, message: '用户创建成功', data: { staffId: staff.staff_id } };
}

/**
 * 更新用户（姓名/手机/角色/门店权限/状态）
 */
async function updateUser(ctx) {
  const { staffId } = ctx.params;
  const { name, phone, roleIds, storeIds, status, supervisorStaffId } = ctx.request.body;

  if (!staffId) ctx.throw(400, '用户ID不能为空');

  const staff = await Staff.findByPk(staffId, {
    include: [{ model: Role, as: 'Roles', attributes: ['role_code'], through: { attributes: [] } }]
  });
  if (!staff) ctx.throw(404, '用户不存在');
  await ensureManageableStaff(ctx, staff);

  const existingDistributorIds = await getStaffDistributorIds(staff.staff_id);
  const requestedDistributorIds = normalizeRequestedDistributorIds(
    ctx.request.body,
    existingDistributorIds[0] || staff.distributor_id || ctx.state.user.distributorId
  );
  if (!requestedDistributorIds.length) ctx.throw(400, '请选择所属经销商');
  if (storeIds !== undefined) {
    if (!Array.isArray(storeIds)) ctx.throw(400, '门店权限格式不正确');
    const uniqueStoreIds = [...new Set(storeIds.map(String))];
    const validStores = uniqueStoreIds.length > 0 ? await Store.findAll({
      where: { store_id: uniqueStoreIds, distributor_id: { [Op.in]: requestedDistributorIds }, is_deleted: 0, status: 1 },
      attributes: ['store_id']
    }) : [];
    if (validStores.length !== uniqueStoreIds.length) {
      ctx.throw(403, '门店不属于该用户所属经销商，或门店不存在/已停用');
    }
  }

  if (phone && phone !== staff.phone) {
    const exist = await Staff.findOne({ where: { phone, staff_id: { [Op.ne]: staffId }, is_deleted: 0 } });
    if (exist) ctx.throw(400, '该手机号已被其他用户使用');
  }

  const updateData = {};
  if (name) updateData.name = name;
  if (phone) updateData.phone = phone;
  if (requestedDistributorIds[0] !== String(staff.distributor_id || '')) updateData.distributor_id = requestedDistributorIds[0];
  if (status !== undefined) updateData.status = normalizeStaffStatus(ctx, status);
  if (supervisorStaffId !== undefined) {
    if (String(supervisorStaffId || '') === String(staffId)) ctx.throw(400, '直属上级不能是本人');
    if (supervisorStaffId) {
      const supervisor = await Staff.findByPk(supervisorStaffId);
      if (!supervisor || supervisor.status !== 1 || supervisor.is_deleted) ctx.throw(400, '直属上级不存在或已停用');
       if (!ctx.state.user.roles.includes('boss') && !accessibleDistributorIds(ctx.state.user).includes(String(supervisor.distributor_id))) ctx.throw(403, '直属上级不在当前经销商范围内');
      updateData.supervisor_staff_id = supervisor.staff_id;
    } else {
      updateData.supervisor_staff_id = null;
    }
  }
  let nextRoleCodes = (staff.Roles || []).map(role => String(role.role_code || '').toLowerCase());
  let nextRoleIds = null;
  if (roleIds !== undefined) {
    if (!Array.isArray(roleIds) || roleIds.length !== 1) ctx.throw(400, '每个账号只能选择一个岗位角色');
    nextRoleIds = [...new Set(roleIds.map(String))];
    const roles = await Role.findAll({ where: { role_id: nextRoleIds, status: 1 } });
    if (roles.length !== nextRoleIds.length) ctx.throw(400, '选择的角色不存在或已停用');
    if (!ctx.state.user.roles.includes('boss') && roles.some(role => role.role_code === 'boss')) ctx.throw(403, '无权分配BOSS角色');
    nextRoleCodes = roles.map(role => String(role.role_code || '').toLowerCase());
    updateData.role_code = roles[0].role_code;
  }
  await validateDistributorIds(requestedDistributorIds);
  if (isRegionScopedAccount(nextRoleCodes) && requestedDistributorIds.length > 1) {
    ctx.throw(400, '店员/店长账号只能归属一个经销商');
  }
  if (!isBoss(ctx.state.user) && requestedDistributorIds.some(id => !accessibleDistributorIds(ctx.state.user).includes(id))) {
    ctx.throw(403, '无权分配其他经销商范围');
  }
  const distributorChanged = requestedDistributorIds[0] !== String(staff.distributor_id || '');
  await sequelize.transaction(async transaction => {
    if (nextRoleIds) {
      await StaffRole.destroy({ where: { staff_id: staffId }, transaction });
      await StaffRole.bulkCreate(nextRoleIds.map(roleId => ({ staff_id: staffId, role_id: roleId })), { transaction });
    }
    await replaceStaffDistributorPermissions(staff, requestedDistributorIds, transaction);
    await staff.update({ ...updateData, distributor_id: requestedDistributorIds[0] }, { transaction });
  });
  if (storeIds !== undefined || distributorChanged) {
    staff.setDataValue('distributor_id', requestedDistributorIds[0]);
    await replaceRegionPermissions(ctx, staff, storeIds || []);
  }

  ctx.body = { code: 0, message: '用户更新成功' };
}

/**
 * 重置用户密码为手机号后6位
 */
async function resetUserPassword(ctx) {
  const { staffId } = ctx.params;
  if (!staffId) ctx.throw(400, '用户ID不能为空');

  const staff = await Staff.findByPk(staffId, {
    include: [{ model: Role, as: 'Roles', attributes: ['role_code'], through: { attributes: [] } }]
  });
  if (!staff) ctx.throw(404, '用户不存在');
  await ensureManageableStaff(ctx, staff);

  const defaultPassword = getResetPasswordFromPhone(staff.phone);
  if (!defaultPassword) ctx.throw(400, '用户手机号不足6位，无法生成默认密码');

  const passwordHash = bcrypt.hashSync(defaultPassword, 10);
  await staff.update({ password_hash: passwordHash });

  ctx.body = {
    code: 0,
    message: '密码重置成功',
    data: { defaultPassword }
  };
}

/**
 * 获取用户的区域权限（可访问门店列表）
 */
async function getUserRegions(ctx) {
  const { staffId } = ctx.params;

  const staff = await Staff.findByPk(staffId, {
    include: [{ model: Role, as: 'Roles', attributes: ['role_code'], through: { attributes: [] } }]
  });
  if (!staff) ctx.throw(404, '用户不存在');
  await ensureManageableStaff(ctx, staff);
  const targetIsBoss = (staff.Roles || []).some(role => role.role_code === 'boss') || staff.role_code === 'boss';
  const targetDistributorIds = await getStaffDistributorIds(staffId);
  const [regionPermissions, availableStores] = await Promise.all([
    RegionPermission.findAll({ where: { staff_id: staffId, can_view: 1 }, attributes: ['region_code'], raw: true }),
    Store.findAll({
      where: { distributor_id: { [Op.in]: targetDistributorIds.length ? targetDistributorIds : [staff.distributor_id] }, is_deleted: 0, status: 1 },
      attributes: ['store_id', 'name', 'region_id'],
      order: [['name', 'ASC']],
      raw: true
    })
  ]);
  const availableRegionIds = [...new Set(availableStores.map(store => String(store.region_id || '')).filter(Boolean))];
  const availableRegions = await Region.findAll({
    where: { region_id: availableRegionIds, status: 1 },
    attributes: ['region_id', 'region_code', 'name'],
    order: [['sort_order', 'ASC']],
    raw: true
  });
  const configuredRegionIds = regionPermissions.map(permission => {
    const key = String(permission.region_code || '');
    return availableRegions.find(region => String(region.region_id) === key || String(region.region_code) === key || String(region.name) === key)?.region_id || '';
  }).filter(Boolean);
  const storePermissions = targetIsBoss
    ? []
    : await StaffStorePermission.findAll({ where: { staff_id: staffId }, attributes: ['store_id'], raw: true });
  const availableStoreIds = new Set(availableStores.map(store => String(store.store_id)));
  const explicitStoreIds = storePermissions.map(permission => String(permission.store_id)).filter(storeId => availableStoreIds.has(storeId));
  const selectedRegionIds = new Set(configuredRegionIds);
  const storeIds = targetIsBoss
    ? [...availableStoreIds]
    : explicitStoreIds.length > 0
      ? explicitStoreIds
      : availableStores.filter(store => selectedRegionIds.has(String(store.region_id || ''))).map(store => String(store.store_id));
  const regionIds = configuredRegionIds.length > 0
    ? [...new Set(configuredRegionIds)]
    : [...new Set(availableStores.filter(store => storeIds.includes(String(store.store_id))).map(store => String(store.region_id || '')).filter(Boolean))];
  ctx.body = { code: 0, data: { scopeType: 'combined', regionIds, regions: availableRegions, storeIds, availableStores, isBoss: targetIsBoss } };
}

/**
 * 分配用户区域权限
 */
async function assignUserRegions(ctx) {
  const { staffId } = ctx.params;
  const { regionIds } = ctx.request.body;
  let { storeIds } = ctx.request.body;

  if (!staffId) ctx.throw(400, '用户ID不能为空');
  const staff = await Staff.findByPk(staffId, {
    include: [{ model: Role, as: 'Roles', attributes: ['role_code'], through: { attributes: [] } }]
  });
  if (!staff) ctx.throw(404, '用户不存在');
  await ensureManageableStaff(ctx, staff);

  const targetIsBoss = (staff.Roles || []).some(role => role.role_code === 'boss') || staff.role_code === 'boss';
  const targetDistributorIds = await getStaffDistributorIds(staffId);
  if (targetIsBoss) ctx.throw(400, 'BOSS账号默认拥有全部区域和门店，无需分配');
  if (!Array.isArray(regionIds)) ctx.throw(400, '区域权限格式不正确');
  const uniqueRegionIds = [...new Set(regionIds.map(String).filter(Boolean))];
  // 兼容尚未刷新页面的旧前端：只提交区域时，按该区域全部有效门店保存。
  // 新前端始终同时提交 storeIds，并由下方校验精确门店范围。
  if (storeIds === undefined) {
    storeIds = uniqueRegionIds.length > 0
      ? (await Store.findAll({
          where: { region_id: uniqueRegionIds, distributor_id: { [Op.in]: targetDistributorIds.length ? targetDistributorIds : [staff.distributor_id] }, is_deleted: 0, status: 1 },
          attributes: ['store_id'],
          raw: true
        })).map(store => store.store_id)
      : [];
  }
  if (!Array.isArray(storeIds)) ctx.throw(400, '门店权限格式不正确');
  const uniqueStoreIds = [...new Set(storeIds.map(String).filter(Boolean))];
  const regions = uniqueRegionIds.length > 0 ? await Region.findAll({
    where: { region_id: uniqueRegionIds, status: 1 },
    attributes: ['region_id']
  }) : [];
  if (regions.length !== uniqueRegionIds.length) ctx.throw(403, '区域不存在或已停用');
  const stores = uniqueStoreIds.length > 0 ? await Store.findAll({
    where: { store_id: uniqueStoreIds, distributor_id: { [Op.in]: targetDistributorIds.length ? targetDistributorIds : [staff.distributor_id] }, is_deleted: 0, status: 1 },
    attributes: ['store_id', 'region_id']
  }) : [];
  if (stores.length !== uniqueStoreIds.length) ctx.throw(403, '门店不属于该用户所属经销商，或门店不存在/已停用');
  const regionSet = new Set(uniqueRegionIds);
  if (stores.some(store => !regionSet.has(String(store.region_id || '')))) ctx.throw(400, '只能选择所选区域内的门店');
  if (uniqueRegionIds.length > 0 && uniqueStoreIds.length === 0) ctx.throw(400, '选择区域后至少选择一家门店');
  await replaceCombinedPermissions(staff, uniqueRegionIds, uniqueStoreIds);
  ctx.body = { code: 0, message: '区域及门店分配成功' };
}

async function replaceCombinedPermissions(staff, regionIds, storeIds) {
  await sequelize.transaction(async transaction => {
    await StaffStorePermission.destroy({ where: { staff_id: staff.staff_id }, transaction });
    await RegionPermission.destroy({ where: { staff_id: staff.staff_id }, transaction });
    if (regionIds.length > 0) {
      await RegionPermission.bulkCreate(regionIds.map(regionId => ({
        staff_id: staff.staff_id,
        region_code: regionId,
        can_view: 1,
        can_manage: 1
      })), { transaction });
    }
    if (storeIds.length > 0) {
      await StaffStorePermission.bulkCreate(storeIds.map(storeId => ({ staff_id: staff.staff_id, store_id: storeId })), { transaction });
    }
    await staff.update({ store_id: storeIds[0] || null }, { transaction });
  });
}

async function ensureManageableStaff(ctx, staff) {
  if (ctx.state.user.roles.includes('boss')) return;
  if ((staff.Roles || []).some(role => role.role_code === 'boss') || staff.role_code === 'boss') ctx.throw(403, '无权管理BOSS账号');
  const targetDistributorIds = await getStaffDistributorIds(staff.staff_id);
  const operatorIds = accessibleDistributorIds(ctx.state.user);
  if (!operatorIds.includes('*') && !operatorIds.includes(String(staff.distributor_id || '')) && !targetDistributorIds.some(id => operatorIds.includes(String(id)))) {
    ctx.throw(403, '无权管理其他经销商的用户');
  }
}

function normalizeStaffStatus(ctx, status, defaultValue = undefined) {
  if (status === undefined || status === null || status === '') return defaultValue;
  const normalized = Number(status);
  if (![0, 1].includes(normalized)) ctx.throw(400, '用户状态只能是启用或停用');
  return normalized;
}

async function replaceRegionPermissions(ctx, staff, storeIds) {
  if (!Array.isArray(storeIds)) ctx.throw(400, '门店权限格式不正确');
  if ((staff.Roles || []).some(role => role.role_code === 'boss') || staff.role_code === 'boss') ctx.throw(400, 'BOSS账号默认拥有全部门店，无需分配');
  const uniqueStoreIds = [...new Set(storeIds.map(String))];
  const stores = uniqueStoreIds.length > 0 ? await Store.findAll({
    where: { store_id: uniqueStoreIds, distributor_id: staff.distributor_id, is_deleted: 0, status: 1 }
  }) : [];
  if (stores.length !== uniqueStoreIds.length) {
    ctx.throw(403, '门店不属于该用户所属经销商，或门店不存在/已停用');
  }

  await sequelize.transaction(async transaction => {
    await StaffStorePermission.destroy({ where: { staff_id: staff.staff_id }, transaction });
    // 新版门店权限精确到门店；清理旧区域权限，避免清空门店后又被兼容逻辑恢复。
    await RegionPermission.destroy({ where: { staff_id: staff.staff_id }, transaction });
    if (uniqueStoreIds.length > 0) {
      await StaffStorePermission.bulkCreate(uniqueStoreIds.map(storeId => ({
        staff_id: staff.staff_id,
        store_id: storeId
      })), { transaction });
    }
    // 同步一个主门店，兼容仍读取 T_STAFF.STORE_ID 的旧接口和客户端。
    await staff.update({ store_id: uniqueStoreIds[0] || null }, { transaction });
  });
}

async function getLocations(ctx) {
  const { storeId = '', keyword = '', status = '' } = ctx.query;
  const storeWhere = { ...manageableStoreWhere(ctx.state.user) };
  if (storeId) storeWhere.store_id = String(storeId);
  storeWhere.status = 1;

  const where = {};
  if (keyword) {
    where[Op.or] = [
      { type: { [Op.like]: `%${keyword}%` } },
      { name: { [Op.like]: `%${keyword}%` } }
    ];
  }
  if (status !== '') where.status = Number(status);

  const rows = await Location.findAll({
    where,
    include: [{ model: Store, attributes: ['store_id', 'name', 'distributor_id'], where: storeWhere }],
    order: [['type', 'ASC'], [Store, 'name', 'ASC']]
  });

  const grouped = new Map();
  for (const row of rows) {
    const data = row.toJSON();
    const storeName = data.Store?.name || '';
    const type = data.type || '';
    if (!grouped.has(type)) {
      grouped.set(type, {
        location_id: type,
        type,
        name: data.name,
        is_sellable: Number(data.is_sellable || 0),
        status: Number(data.status || 0),
        store_count: 0,
        enabled_store_count: 0,
        stores: []
      });
    }
    const group = grouped.get(type);
    group.store_count += 1;
    if (Number(data.status) === 1) group.enabled_store_count += 1;
    if (Number(data.status) === 1) group.status = 1;
    group.stores.push({
      store_id: data.store_id,
      store_name: storeName,
      location_id: data.location_id,
      status: Number(data.status || 0)
    });
  }

  ctx.body = {
    code: 0,
    data: Array.from(grouped.values()).sort(sortLocationGroups)
  };
}

async function setStoreManager(ctx) {
  const { storeId } = ctx.params;
  const staffId = ctx.request.body?.staffId || ctx.request.body?.staff_id || null;
  const store = await Store.findOne({ where: { store_id: storeId, ...manageableStoreWhere(ctx.state.user) } });
  if (!store) ctx.throw(404, '门店不存在或不在管理范围内');
  if (staffId) {
    const staff = await Staff.findOne({ where: { staff_id: staffId, status: 1, is_deleted: 0 } });
    if (!staff) ctx.throw(400, '店长不存在或已停用');
    if (String(staff.distributor_id) !== String(store.distributor_id)) ctx.throw(403, '店长必须属于该门店所属经销商');
    await store.update({ manager_staff_id: staff.staff_id });
  } else {
    await store.update({ manager_staff_id: null });
  }
  ctx.body = { code: 0, message: '门店店长已更新', data: { storeId, managerStaffId: store.manager_staff_id } };
}

async function createLocation(ctx) {
  const input = normalizeLocationInput(ctx, ctx.request.body);
  const { storeIds, stores } = await resolveLocationStoreIds(ctx, ctx.request.body?.storeIds ?? ctx.request.body?.store_ids, { fallbackToAll: true });

  let created = 0;
  let updated = 0;
  await sequelize.transaction(async transaction => {
    for (const store of stores) {
      const existing = await Location.findOne({
        where: { store_id: store.store_id, type: input.type },
        transaction
      });
      if (existing) {
        if (input.status === 0) await assertLocationsCanBeDisabled(ctx, [existing], transaction);
        await existing.update(input, { transaction });
        updated += 1;
      } else {
        await Location.create({
          location_id: `LOC${generateUUID().slice(0, 20).toUpperCase()}`,
          store_id: store.store_id,
          ...input
        }, { transaction });
        created += 1;
      }
    }
  });

  ctx.body = { code: 0, message: '库位已保存', data: { type: input.type, storeIds, created, updated } };
}

async function updateLocation(ctx) {
  const { locationId } = ctx.params;
  const type = String(locationId || '').trim();
  if (!getStandardLocation(type)) ctx.throw(400, '仓位编码不在标准仓位范围内');

  const input = normalizeLocationInput(ctx, { ...ctx.request.body, type }, true);
  const { storeIds } = await resolveLocationStoreIds(ctx, ctx.request.body?.storeIds ?? ctx.request.body?.store_ids, { allowEmpty: input.status === 0 });
  const manageableStores = await getManageableStores(ctx, { status: 1 });
  const manageableStoreIds = manageableStores.map(store => String(store.store_id));
  const selectedStoreIds = input.status === 1 ? new Set(storeIds) : new Set();
  let created = 0;
  let updated = 0;
  await sequelize.transaction(async transaction => {
    const existingLocations = await Location.findAll({
      where: { store_id: { [Op.in]: manageableStoreIds }, type },
      include: [{ model: Store, attributes: ['store_id', 'name'] }],
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    const existingByStoreId = new Map(existingLocations.map(location => [String(location.store_id), location]));
    const locationsToDisable = existingLocations.filter(location => !selectedStoreIds.has(String(location.store_id)));
    await assertLocationsCanBeDisabled(ctx, locationsToDisable, transaction);

    for (const storeId of manageableStoreIds) {
      const existing = existingByStoreId.get(storeId);
      if (existing) {
        const nextStatus = selectedStoreIds.has(storeId) ? 1 : 0;
        await existing.update({ ...input, status: nextStatus }, { transaction });
        updated += 1;
      } else if (selectedStoreIds.has(storeId)) {
        await Location.create({
          location_id: `LOC${generateUUID().slice(0, 20).toUpperCase()}`,
          store_id: storeId,
          ...input,
          status: 1
        }, { transaction });
        created += 1;
      }
    }
  });

  ctx.body = { code: 0, message: '库位已更新', data: { type, storeIds: [...selectedStoreIds], created, updated } };
}

async function deleteLocation(ctx) {
  const { locationId } = ctx.params;
  const type = String(locationId || '').trim();
  if (!getStandardLocation(type)) ctx.throw(400, '仓位编码不在标准仓位范围内');

  const stores = await getManageableStores(ctx, { status: 1 });
  const storeIds = stores.map(store => store.store_id);
  if (storeIds.length === 0) ctx.throw(400, '当前没有可配置门店');

  let affected = 0;
  await sequelize.transaction(async transaction => {
    const locations = await Location.findAll({
      where: { store_id: { [Op.in]: storeIds }, type, status: 1 },
      include: [{ model: Store, attributes: ['store_id', 'name'] }],
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    await assertLocationsCanBeDisabled(ctx, locations, transaction);
    if (locations.length > 0) {
      const [count] = await Location.update(
        { status: 0 },
        { where: { location_id: { [Op.in]: locations.map(location => location.location_id) } }, transaction }
      );
      affected = count;
    }
  });
  ctx.body = { code: 0, message: '库位已停用', data: { type, affected } };
}

function buildMenuTree(menus) {
  const menuMap = {};
  const rootMenus = [];

  menus.forEach(menu => {
    menuMap[menu.menu_id] = {
      menuId: menu.menu_id,
      menuCode: menu.menu_code,
      name: menu.name,
      parentId: menu.parent_id,
      menuType: menu.menu_type,
      path: menu.path,
      icon: menu.icon,
      sortOrder: menu.sort_order,
      status: menu.status,
      children: []
    };
  });

  menus.forEach(menu => {
    if (menu.parent_id && menuMap[menu.parent_id]) {
      menuMap[menu.parent_id].children.push(menuMap[menu.menu_id]);
    } else {
      rootMenus.push(menuMap[menu.menu_id]);
    }
  });

  return rootMenus;
}

module.exports = {
  getMenus,
  reorderMenus,
  getRoles,
  getUserDistributors,
  createRole,
  updateRole,
  deleteRole,
  getRoleMenus,
  assignMenus,
  getUsers,
  createUser,
  updateUser,
  resetUserPassword,
  getUserRegions,
  assignUserRegions,
  getLocations,
  setStoreManager,
  createLocation,
  updateLocation,
  deleteLocation,
  _test: {
    getInventoryQuantityForLocation
  }
};
