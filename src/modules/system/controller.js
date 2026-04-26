/**
 * 系统管理控制器
 * 包含：菜单、角色、用户、权限分配
 */
const { Menu, Role, RoleMenu, Staff, StaffRole, RegionPermission, Region } = require('../../models');
const { Op } = require('sequelize');

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
  const roles = await Role.findAll({
    where: { status: 1 },
    order: [['role_id', 'ASC']]
  });

  ctx.body = roles;
}

/**
 * 获取角色的菜单权限
 */
async function getRoleMenus(ctx) {
  const { roleId } = ctx.params;

  const roleMenus = await RoleMenu.findAll({
    where: { role_id: roleId },
    include: [{ model: Menu }]
  });

  const menuIds = roleMenus.map(rm => rm.menu_id);

  ctx.body = menuIds;
}

/**
 * 分配角色菜单权限
 */
async function assignMenus(ctx) {
  const { roleId } = ctx.params;
  const { menuIds } = ctx.request.body;

  // 老板角色不允许修改
  const role = await Role.findByPk(roleId);
  if (role && role.role_code === 'boss') {
    ctx.throw(400, '老板角色权限不可修改');
  }

  // 删除原有权限
  await RoleMenu.destroy({ where: { role_id: roleId } });

  // 添加新权限
  if (menuIds && menuIds.length > 0) {
    const roleMenus = menuIds.map(menuId => ({
      role_id: roleId,
      menu_id: menuId
    }));
    await RoleMenu.bulkCreate(roleMenus);
  }

  ctx.body = { message: '权限分配成功' };
}

/**
 * 获取用户列表
 */
async function getUsers(ctx) {
  const { keyword, storeId, regionCode, page = 1, pageSize = 20 } = ctx.query;
  const user = ctx.state.user;

  const where = { is_deleted: 0 };

  // 按区域权限过滤
  if (!user.regionCodes.includes('*')) {
    where.region_id = user.regionCodes;
  }

  if (keyword) {
    where[Op.or] = [
      { name: { [Op.like]: `%${keyword}%` } },
      { phone: { [Op.like]: `%${keyword}%` } }
    ];
  }
  if (storeId) where.store_id = storeId;
  if (regionCode) where.region_id = regionCode;

  const { count, rows } = await Staff.findAndCountAll({
    where,
    attributes: { exclude: ['password_hash'] },
    include: [
      { model: Role, as: 'Roles', through: { attributes: [] } },
      { model: Region, as: 'Region' },
      { model: RegionPermission, as: 'RegionPermissions' }
    ],
    order: [['create_time', 'DESC']],
    limit: Number(pageSize),
    offset: (Number(page) - 1) * Number(pageSize)
  });

  ctx.body = {
    list: rows,
    pagination: {
      total: count,
      page: Number(page),
      pageSize: Number(pageSize),
      totalPages: Math.ceil(count / pageSize)
    }
  };
}

/**
 * 更新用户角色
 */
async function updateUserRoles(ctx) {
  const { staffId } = ctx.params;
  const { roleIds } = ctx.request.body;

  // 删除原有角色
  await StaffRole.destroy({ where: { staff_id: staffId } });

  // 添加新角色
  if (roleIds && roleIds.length > 0) {
    const staffRoles = roleIds.map(roleId => ({
      staff_id: staffId,
      role_id: roleId
    }));
    await StaffRole.bulkCreate(staffRoles);
  }

  ctx.body = { message: '角色分配成功' };
}

/**
 * 获取用户的区域权限
 */
async function getUserRegions(ctx) {
  const { staffId } = ctx.params;

  const permissions = await RegionPermission.findAll({
    where: { staff_id: staffId }
  });

  ctx.body = permissions.map(p => ({
    regionCode: p.region_code,
    canView: p.can_view === 1,
    canManage: p.can_manage === 1
  }));
}

/**
 * 分配用户区域权限
 */
async function assignUserRegions(ctx) {
  const { staffId } = ctx.params;
  const { regionCodes } = ctx.request.body;

  // 不能给自己分配所有区域（除非是老板）
  const currentUser = ctx.state.user;
  if (currentUser.staffId === Number(staffId) && !regionCodes.includes('*')) {
    ctx.throw(400, '不能取消自己的全部区域权限');
  }

  // 删除原有权限
  await RegionPermission.destroy({ where: { staff_id: staffId } });

  // 添加新权限
  if (regionCodes && regionCodes.length > 0) {
    const permissions = regionCodes.map(code => ({
      staff_id: staffId,
      region_code: code,
      can_view: 1,
      can_manage: 0
    }));
    await RegionPermission.bulkCreate(permissions);
  }

  ctx.body = { message: '区域权限分配成功' };
}

/**
 * 构建菜单树
 */
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
  getRoleMenus,
  assignMenus,
  getUsers,
  updateUserRoles,
  getUserRegions,
  assignUserRegions
};
