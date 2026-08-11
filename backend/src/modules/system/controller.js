/**
 * 系统管理控制器
 */
const bcrypt = require('bcryptjs');
const { sequelize, Menu, Role, RoleMenu, Staff, StaffRole, StaffStorePermission, RegionPermission, Region, Store, Location, Inventory, ProductSn } = require('../../models');
const { Op } = require('sequelize');
const { generateUUID } = require('../../utils');
const { getStandardLocation } = require('../../utils/standardLocations');
const { isRegionScopedAccount } = require('../../utils/storePermissions');

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
  if (!user.distributorId) {
    const error = new Error('当前账号未绑定经销商');
    error.status = 403;
    throw error;
  }
  return { distributor_id: user.distributorId, is_deleted: 0 };
}

function normalizeLocationInput(ctx, body, isUpdate = false) {
  const name = String(body.name || '').trim();
  const type = String(body.type || '').trim();
  const standardLocation = getStandardLocation(type);
  const isSellable = body.isSellable ?? body.is_sellable ?? standardLocation?.is_sellable ?? 1;
  const status = body.status ?? 1;

  if (!type) ctx.throw(400, '请选择仓位编码');
  if (!standardLocation) ctx.throw(400, '仓位编码不在标准仓位范围内');

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
    order: [['sort_order', 'ASC']]
  });

  ctx.body = buildMenuTree(menus);
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
    + Number(row.pending_qty || 0);
}

async function getLocationStockSummary(locationId, transaction) {
  const inventoryRows = await Inventory.findAll({
    where: { location_id: locationId },
    attributes: ['normal_qty', 'regular_qty', 'subsidy_qty', 'second_qty', 'display_qty', 'demo_qty', 'unsellable_qty', 'pending_qty'],
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

/**
 * 获取可用于账号归属的经销商列表。
 * 当前经销商主数据表可能为空，因此从有效门店的 distributor_id 推导选项，
 * 保证历史组织数据也能被正常维护。
 */
async function getUserDistributors(ctx) {
  const where = { is_deleted: 0, status: 1 };
  if (!isBoss(ctx.state.user)) {
    if (!ctx.state.user.distributorId) ctx.throw(403, '当前账号未绑定经销商');
    where.distributor_id = ctx.state.user.distributorId;
  }

  const rows = await Store.findAll({
    where,
    attributes: [[sequelize.fn('DISTINCT', sequelize.col('distributor_id')), 'distributor_id']],
    raw: true
  });
  const data = rows
    .map(row => String(row.distributor_id || '').trim())
    .filter(Boolean)
    .sort()
    .map(distributorId => ({ distributor_id: distributorId, name: distributorId }));
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
    attributes: ['menu_id']
  });
  ctx.body = roleMenus.map(rm => rm.menu_id);
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

  ctx.body = { message: '权限分配成功' };
}

/**
 * 获取用户列表
 */
async function getUsers(ctx) {
  const { keyword, storeId, regionCode, page = 1, pageSize = 20 } = ctx.query;
  const user = ctx.state.user;
  const where = { is_deleted: 0 };

  if (!user.roles.includes('boss')) {
    if (!user.distributorId) ctx.throw(403, '当前账号未绑定经销商');
    where.distributor_id = user.distributorId;
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
      assignedStoresInclude
    ],
    distinct: true,
    order: [['create_time', 'DESC']],
    limit: Number(pageSize),
    offset: (Number(page) - 1) * Number(pageSize)
  });

  const allActiveStores = user.roles.includes('boss') ? await Store.findAll({
    where: { is_deleted: 0, status: 1 },
    attributes: ['store_id', 'name', 'region_id'],
    include: [{ model: Region, attributes: ['region_id', 'name'], required: false }],
    order: [['name', 'ASC']]
  }) : [];
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
      const isBoss = (data.Roles || []).some(role => role.role_code === 'boss') || data.role_code === 'boss';
      const roleCodes = (data.Roles || []).map(role => role.role_code);
      const regionScoped = !isBoss && isRegionScopedAccount(roleCodes);
      const assignedStores = isBoss ? allActiveStores : (data.AssignedStores || []);
      const assignedStoreNames = assignedStores.map(store => store.name);
      const assignedRegionNames = [...new Set(assignedStores.map(store => store.Region?.name).filter(Boolean))];
      const directRegionNames = [...new Set((data.RegionPermissions || []).map(permission => {
        const key = String(permission.region_code || '');
        const region = allActiveRegions.find(item => String(item.region_id) === key || String(item.region_code) === key || String(item.name) === key);
        return region?.name || '';
      }).filter(Boolean))];
      const regionNames = regionScoped ? directRegionNames : assignedRegionNames;
      delete data.Roles;
      delete data.AssignedStores;
      delete data.RegionPermissions;
      data.region_names = regionNames;
      data.region_name = isBoss ? '全部区域' : (regionNames.join('、') || '暂无区域');
      const storeName = isBoss
        ? '全部门店'
        : regionScoped
          ? (regionNames.length ? `区域内全部门店（${regionNames.join('、')}）` : '暂无区域')
          : (assignedStoreNames.join('、') || '暂无门店');
      return { ...data, role_ids: roleIds, role_codes: roleCodes, role_names: roleNames, supervisor_name: data.Supervisor?.name || '', supervisor_staff_id: data.supervisor_staff_id || null, store_names: regionScoped ? [] : assignedStoreNames, store_name: storeName, is_boss: isBoss, region_scoped: regionScoped };
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
  if (!Array.isArray(roleIds) || roleIds.length === 0) ctx.throw(400, '请至少选择一个角色');
  if (!password) ctx.throw(400, '请输入初始密码');

  const exist = await Staff.findOne({ where: { phone, is_deleted: 0 } });
  if (exist) ctx.throw(400, '该手机号已存在');

  const uniqueRoleIds = [...new Set(roleIds.map(String))];
  const roles = await Role.findAll({ where: { role_id: uniqueRoleIds, status: 1 } });
  if (roles.length !== uniqueRoleIds.length) ctx.throw(400, '选择的角色不存在或已停用');
  if (!ctx.state.user.roles.includes('boss') && roles.some(role => role.role_code === 'boss')) ctx.throw(403, '无权分配BOSS角色');

  const requestedDistributorId = String(ctx.request.body.distributorId || '').trim();
  const distributorId = requestedDistributorId || ctx.state.user.distributorId;
  if (!distributorId) ctx.throw(400, '当前账号未绑定经销商，无法创建用户');
  if (!isBoss(ctx.state.user) && distributorId !== ctx.state.user.distributorId) {
    ctx.throw(403, '无权将用户归属到其他经销商');
  }
  const distributorStoreCount = await Store.count({ where: { distributor_id: distributorId, is_deleted: 0, status: 1 } });
  if (distributorStoreCount === 0) ctx.throw(400, '所属经销商下暂无有效门店');

  let supervisor = null;
  if (supervisorStaffId) {
    supervisor = await Staff.findByPk(supervisorStaffId);
    if (!supervisor || supervisor.status !== 1 || supervisor.is_deleted) ctx.throw(400, '直属上级不存在或已停用');
    if (!ctx.state.user.roles.includes('boss') && supervisor.distributor_id !== distributorId) ctx.throw(403, '直属上级不在当前经销商范围内');
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
  ensureManageableStaff(ctx, staff);

  const requestedDistributorId = ctx.request.body.distributorId === undefined
    ? String(staff.distributor_id || '').trim()
    : String(ctx.request.body.distributorId || '').trim();
  if (!requestedDistributorId) ctx.throw(400, '请选择所属经销商');
  if (!isBoss(ctx.state.user) && requestedDistributorId !== String(ctx.state.user.distributorId || '')) {
    ctx.throw(403, '无权将用户归属到其他经销商');
  }
  if (requestedDistributorId !== String(staff.distributor_id || '')) {
    const distributorStoreCount = await Store.count({ where: { distributor_id: requestedDistributorId, is_deleted: 0, status: 1 } });
    if (distributorStoreCount === 0) ctx.throw(400, '所属经销商下暂无有效门店');
  }
  if (storeIds !== undefined) {
    if (!Array.isArray(storeIds)) ctx.throw(400, '门店权限格式不正确');
    const uniqueStoreIds = [...new Set(storeIds.map(String))];
    const validStores = uniqueStoreIds.length > 0 ? await Store.findAll({
      where: { store_id: uniqueStoreIds, distributor_id: requestedDistributorId, is_deleted: 0, status: 1 },
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
  if (requestedDistributorId !== String(staff.distributor_id || '')) updateData.distributor_id = requestedDistributorId;
  if (status !== undefined) updateData.status = normalizeStaffStatus(ctx, status);
  if (supervisorStaffId !== undefined) {
    if (String(supervisorStaffId || '') === String(staffId)) ctx.throw(400, '直属上级不能是本人');
    if (supervisorStaffId) {
      const supervisor = await Staff.findByPk(supervisorStaffId);
      if (!supervisor || supervisor.status !== 1 || supervisor.is_deleted) ctx.throw(400, '直属上级不存在或已停用');
      if (!ctx.state.user.roles.includes('boss') && supervisor.distributor_id !== staff.distributor_id) ctx.throw(403, '直属上级不在当前经销商范围内');
      updateData.supervisor_staff_id = supervisor.staff_id;
    } else {
      updateData.supervisor_staff_id = null;
    }
  }
  if (roleIds !== undefined) {
    if (!Array.isArray(roleIds) || roleIds.length === 0) ctx.throw(400, '请至少选择一个角色');
    const uniqueRoleIds = [...new Set(roleIds.map(String))];
    const roles = await Role.findAll({ where: { role_id: uniqueRoleIds, status: 1 } });
    if (roles.length !== uniqueRoleIds.length) ctx.throw(400, '选择的角色不存在或已停用');
    if (!ctx.state.user.roles.includes('boss') && roles.some(role => role.role_code === 'boss')) ctx.throw(403, '无权分配BOSS角色');
    updateData.role_code = roles[0].role_code;
    await sequelize.transaction(async transaction => {
      await StaffRole.destroy({ where: { staff_id: staffId }, transaction });
      await StaffRole.bulkCreate(uniqueRoleIds.map(roleId => ({ staff_id: staffId, role_id: roleId })), { transaction });
      await Staff.update(updateData, { where: { staff_id: staffId }, transaction });
    });
  } else {
    await Staff.update(updateData, { where: { staff_id: staffId } });
  }
  // 更新门店区域权限
  if (storeIds !== undefined || requestedDistributorId !== String(staff.distributor_id || '')) {
    staff.distributor_id = requestedDistributorId;
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
  ensureManageableStaff(ctx, staff);

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
  ensureManageableStaff(ctx, staff);
  const targetIsBoss = (staff.Roles || []).some(role => role.role_code === 'boss') || staff.role_code === 'boss';
  const targetRoles = (staff.Roles || []).length > 0 ? staff.Roles.map(role => role.role_code) : [staff.role_code];
  const targetRegionScoped = !targetIsBoss && isRegionScopedAccount(targetRoles);
  if (targetRegionScoped) {
    const [permissions, availableRegions] = await Promise.all([
      RegionPermission.findAll({ where: { staff_id: staffId, can_view: 1 }, attributes: ['region_code'], raw: true }),
      Region.findAll({ where: { status: 1 }, attributes: ['region_id', 'region_code', 'name'], order: [['sort_order', 'ASC']], raw: true })
    ]);
    const regionIds = permissions.map(permission => {
      const key = String(permission.region_code || '');
      return availableRegions.find(region => String(region.region_id) === key || String(region.region_code) === key || String(region.name) === key)?.region_id || '';
    }).filter(Boolean);
    ctx.body = { code: 0, data: { scopeType: 'region', regionIds: [...new Set(regionIds)], regions: availableRegions, isBoss: false } };
    return;
  }
  const [permissions, availableStores] = await Promise.all([
    targetIsBoss ? Promise.resolve([]) : StaffStorePermission.findAll({ where: { staff_id: staffId }, attributes: ['store_id'], raw: true }),
    Store.findAll({
      where: { distributor_id: staff.distributor_id, is_deleted: 0, status: 1 },
      attributes: ['store_id', 'name'],
      order: [['name', 'ASC']],
      raw: true
    })
  ]);

  const availableStoreIds = new Set(availableStores.map(store => String(store.store_id)));
  ctx.body = { code: 0, data: { storeIds: targetIsBoss ? [...availableStoreIds] : permissions.map(p => String(p.store_id)).filter(storeId => availableStoreIds.has(storeId)), availableStores, isBoss: targetIsBoss } };
}

/**
 * 分配用户区域权限
 */
async function assignUserRegions(ctx) {
  const { staffId } = ctx.params;
  const { storeIds, regionIds } = ctx.request.body;

  if (!staffId) ctx.throw(400, '用户ID不能为空');
  const staff = await Staff.findByPk(staffId, {
    include: [{ model: Role, as: 'Roles', attributes: ['role_code'], through: { attributes: [] } }]
  });
  if (!staff) ctx.throw(404, '用户不存在');
  ensureManageableStaff(ctx, staff);

  const targetIsBoss = (staff.Roles || []).some(role => role.role_code === 'boss') || staff.role_code === 'boss';
  const targetRoles = (staff.Roles || []).length > 0 ? staff.Roles.map(role => role.role_code) : [staff.role_code];
  const targetRegionScoped = !targetIsBoss && isRegionScopedAccount(targetRoles);
  if (targetRegionScoped) {
    if (!Array.isArray(regionIds)) ctx.throw(400, '区域权限格式不正确');
    const uniqueRegionIds = [...new Set(regionIds.map(String).filter(Boolean))];
    const regions = uniqueRegionIds.length > 0 ? await Region.findAll({
      where: { region_id: uniqueRegionIds, status: 1 },
      attributes: ['region_id']
    }) : [];
    if (regions.length !== uniqueRegionIds.length) ctx.throw(403, '区域不存在或已停用');
    await replaceDirectRegionPermissions(staff, uniqueRegionIds);
    ctx.body = { code: 0, message: '区域分配成功' };
    return;
  }

  await replaceRegionPermissions(ctx, staff, storeIds || []);

  ctx.body = { code: 0, message: '门店分配成功' };
}

async function replaceDirectRegionPermissions(staff, regionIds) {
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
    await staff.update({ store_id: null }, { transaction });
  });
}

function ensureManageableStaff(ctx, staff) {
  if (ctx.state.user.roles.includes('boss')) return;
  if ((staff.Roles || []).some(role => role.role_code === 'boss') || staff.role_code === 'boss') ctx.throw(403, '无权管理BOSS账号');
  if (staff.distributor_id !== ctx.state.user.distributorId) ctx.throw(403, '无权管理其他经销商的用户');
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
    } else if (!menu.parent_id) {
      rootMenus.push(menuMap[menu.menu_id]);
    }
  });

  return rootMenus;
}

module.exports = {
  getMenus,
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
