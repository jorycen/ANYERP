/**
 * 系统管理控制器
 */
const bcrypt = require('bcryptjs');
const { sequelize, Menu, Role, RoleMenu, Staff, StaffRole, StaffStorePermission, RegionPermission, Region, Store } = require('../../models');
const { Op } = require('sequelize');
const { generateUUID } = require('../../utils');

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
  if (regionCode) where.region_id = regionCode;

  const assignedStoresInclude = {
    model: Store,
    as: 'AssignedStores',
    attributes: ['store_id', 'name'],
    through: { attributes: [] },
    where: { ...(storeId ? { store_id: storeId } : {}), is_deleted: 0, status: 1 },
    required: Boolean(storeId),
  };
  const { count, rows } = await Staff.findAndCountAll({
    where,
    attributes: { exclude: ['password_hash', 'role_code'] },
    include: [
      { model: Role, as: 'Roles', attributes: ['role_id', 'role_code', 'name'], through: { attributes: [] } },
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
    attributes: ['store_id', 'name'],
    order: [['name', 'ASC']]
  }) : [];

  ctx.body = {
    list: rows.map(row => {
      const data = row.toJSON();
      const roleNames = (data.Roles || []).map(role => role.name);
      const roleIds = (data.Roles || []).map(role => role.role_id);
      const isBoss = (data.Roles || []).some(role => role.role_code === 'boss') || data.role_code === 'boss';
      const assignedStores = isBoss ? allActiveStores : (data.AssignedStores || []);
      const storeNames = assignedStores.map(store => store.name);
      delete data.Roles;
      delete data.AssignedStores;
      delete data.RegionPermissions;
      return { ...data, role_ids: roleIds, role_names: roleNames, store_names: storeNames, store_name: isBoss ? '全部门店' : (storeNames.join('、') || '暂无门店'), is_boss: isBoss };
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
  const { name, phone, password, roleIds, status } = ctx.request.body;

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

  const hash = bcrypt.hashSync(password, 10);
  const distributorId = ctx.state.user.distributorId;
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
  const { name, phone, roleIds, storeIds, status } = ctx.request.body;

  if (!staffId) ctx.throw(400, '用户ID不能为空');

  const staff = await Staff.findByPk(staffId, {
    include: [{ model: Role, as: 'Roles', attributes: ['role_code'], through: { attributes: [] } }]
  });
  if (!staff) ctx.throw(404, '用户不存在');
  ensureManageableStaff(ctx, staff);

  if (phone && phone !== staff.phone) {
    const exist = await Staff.findOne({ where: { phone, staff_id: { [Op.ne]: staffId }, is_deleted: 0 } });
    if (exist) ctx.throw(400, '该手机号已被其他用户使用');
  }

  const updateData = {};
  if (name) updateData.name = name;
  if (phone) updateData.phone = phone;
  if (status !== undefined) updateData.status = normalizeStaffStatus(ctx, status);
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
  if (storeIds !== undefined) {
    await replaceRegionPermissions(ctx, staff, storeIds);
  }

  ctx.body = { code: 0, message: '用户更新成功' };
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
  const operatorIsBoss = ctx.state.user.roles.includes('boss');
  const [permissions, availableStores] = await Promise.all([
    targetIsBoss ? Promise.resolve([]) : StaffStorePermission.findAll({ where: { staff_id: staffId }, attributes: ['store_id'], raw: true }),
    Store.findAll({
      where: { ...(operatorIsBoss ? {} : { distributor_id: staff.distributor_id }), is_deleted: 0, status: 1 },
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
  const { storeIds } = ctx.request.body;

  if (!staffId) ctx.throw(400, '用户ID不能为空');
  const staff = await Staff.findByPk(staffId, {
    include: [{ model: Role, as: 'Roles', attributes: ['role_code'], through: { attributes: [] } }]
  });
  if (!staff) ctx.throw(404, '用户不存在');
  ensureManageableStaff(ctx, staff);

  await replaceRegionPermissions(ctx, staff, storeIds || []);

  ctx.body = { code: 0, message: '门店分配成功' };
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
  const operatorIsBoss = ctx.state.user.roles.includes('boss');
  const stores = uniqueStoreIds.length > 0 ? await Store.findAll({
    where: { store_id: uniqueStoreIds, ...(operatorIsBoss ? {} : { distributor_id: staff.distributor_id }), is_deleted: 0, status: 1 }
  }) : [];
  if (stores.length !== uniqueStoreIds.length) {
    ctx.throw(403, operatorIsBoss ? '包含不存在或已停用的门店' : '门店不属于该用户所在经销商');
  }

  await sequelize.transaction(async transaction => {
    await StaffStorePermission.destroy({ where: { staff_id: staff.staff_id }, transaction });
    if (uniqueStoreIds.length > 0) {
      await StaffStorePermission.bulkCreate(uniqueStoreIds.map(storeId => ({
        staff_id: staff.staff_id,
        store_id: storeId
      })), { transaction });
    }
  });
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
  createRole,
  updateRole,
  deleteRole,
  getRoleMenus,
  assignMenus,
  getUsers,
  createUser,
  updateUser,
  getUserRegions,
  assignUserRegions
};
