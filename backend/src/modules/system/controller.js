/**
 * 系统管理控制器
 */
const bcrypt = require('bcryptjs');
const { Menu, Role, RoleMenu, Staff, StaffRole, RegionPermission, Region, Store } = require('../../models');
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
  ctx.body = roleMenus.map(rm => rm.menu_id);
}

/**
 * 分配角色菜单权限
 */
async function assignMenus(ctx) {
  const { roleId } = ctx.params;
  const { menuIds } = ctx.request.body;

  const role = await Role.findByPk(roleId);
  if (role && role.role_code === 'boss') {
    ctx.throw(400, '老板角色权限不可修改');
  }

  await RoleMenu.destroy({ where: { role_id: roleId } });

  if (menuIds && menuIds.length > 0) {
    await RoleMenu.bulkCreate(menuIds.map(menuId => ({
      role_id: roleId,
      menu_id: menuId
    })));
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
 * 创建用户
 */
async function createUser(ctx) {
  const { name, phone, password, roleCode, storeIds, status } = ctx.request.body;

  if (!name) ctx.throw(400, '请输入姓名');
  if (!phone) ctx.throw(400, '请输入手机号');
  if (!roleCode) ctx.throw(400, '请选择角色');
  if (!password) ctx.throw(400, '请输入初始密码');

  const exist = await Staff.findOne({ where: { phone, is_deleted: 0 } });
  if (exist) ctx.throw(400, '该手机号已存在');

  const role = await Role.findOne({ where: { role_code: roleCode } });
  if (!role) ctx.throw(400, '角色不存在');

  const hash = bcrypt.hashSync(password, 10);

  const staff = await Staff.create({
    distributor_id: 'DEFAULT',
    name,
    phone,
    password_hash: hash,
    role_code: roleCode,
    status: status !== undefined ? status : 1
  });

  // 绑定角色
  await StaffRole.create({
    staff_id: staff.staff_id,
    role_id: role.role_id
  });

  // 绑定门店区域权限
  if (storeIds && storeIds.length > 0) {
    const stores = await Store.findAll({
      where: { store_id: storeIds }
    });
    for (const store of stores) {
      await RegionPermission.create({
        staff_id: staff.staff_id,
        region_code: store.region_id || store.store_id,
        can_view: 1,
        can_manage: 0
      });
    }
  }

  ctx.body = { code: 0, message: '用户创建成功', data: { staffId: staff.staff_id } };
}

/**
 * 更新用户（姓名/手机/角色/门店权限/状态）
 */
async function updateUser(ctx) {
  const { staffId } = ctx.params;
  const { name, phone, roleCode, storeIds, status } = ctx.request.body;

  if (!staffId) ctx.throw(400, '用户ID不能为空');

  const staff = await Staff.findByPk(staffId);
  if (!staff) ctx.throw(404, '用户不存在');

  if (phone && phone !== staff.phone) {
    const exist = await Staff.findOne({ where: { phone, staff_id: { [Op.ne]: staffId }, is_deleted: 0 } });
    if (exist) ctx.throw(400, '该手机号已被其他用户使用');
  }

  const updateData = {};
  if (name) updateData.name = name;
  if (phone) updateData.phone = phone;
  if (roleCode) {
    updateData.role_code = roleCode;
    // 更新角色关联
    const role = await Role.findOne({ where: { role_code: roleCode } });
    if (role) {
      await StaffRole.destroy({ where: { staff_id: staffId } });
      await StaffRole.create({ staff_id: staffId, role_id: role.role_id });
    }
  }
  if (status !== undefined) updateData.status = status;

  await Staff.update(updateData, { where: { staff_id: staffId } });

  // 更新门店区域权限
  if (storeIds !== undefined) {
    await RegionPermission.destroy({ where: { staff_id: staffId } });
    if (storeIds.length > 0) {
      const stores = await Store.findAll({
        where: { store_id: storeIds }
      });
      for (const store of stores) {
        await RegionPermission.create({
          staff_id: staffId,
          region_code: store.region_id || store.store_id,
          can_view: 1,
          can_manage: 0
        });
      }
    }
  }

  ctx.body = { code: 0, message: '用户更新成功' };
}

/**
 * 获取用户的区域权限（可访问门店列表）
 */
async function getUserRegions(ctx) {
  const { staffId } = ctx.params;

  const permissions = await RegionPermission.findAll({
    where: { staff_id: staffId }
  });

  // 返回门店ID列表
  const regionCodes = permissions.map(p => p.region_code);
  const stores = await Store.findAll({ where: { region_id: regionCodes } });

  ctx.body = { code: 0, data: { storeIds: stores.map(s => s.store_id), regionCodes } };
}

/**
 * 分配用户区域权限
 */
async function assignUserRegions(ctx) {
  const { staffId } = ctx.params;
  const { storeIds } = ctx.request.body;

  if (!staffId) ctx.throw(400, '用户ID不能为空');

  await RegionPermission.destroy({ where: { staff_id: staffId } });

  if (storeIds && storeIds.length > 0) {
    const stores = await Store.findAll({
      where: { store_id: storeIds }
    });
    for (const store of stores) {
      await RegionPermission.create({
        staff_id: staffId,
        region_code: store.region_id || store.store_id,
        can_view: 1,
        can_manage: 0
      });
    }
  }

  ctx.body = { code: 0, message: '门店分配成功' };
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
  getRoleMenus,
  assignMenus,
  getUsers,
  createUser,
  updateUser,
  getUserRegions,
  assignUserRegions
};