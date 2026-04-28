/**
 * 认证控制器
 */
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Staff, Role, Menu, RoleMenu, StaffRole, Store, Region } = require('../../models');
const config = require('../../config');

/**
 * 登录
 */
async function login(ctx) {
  const { phone, password } = ctx.request.body;

  if (!phone || !password) {
    ctx.throw(400, '请输入手机号和密码');
  }

  // 查询用户（包含角色信息）
  const staff = await Staff.findOne({
    where: { phone, is_deleted: 0 },
    include: [
      { model: Role, as: 'Roles', through: { attributes: [] } },
      { model: Store, as: 'Store', include: [{ model: Region, as: 'Region' }] }
    ]
  });

  if (!staff) {
    ctx.throw(401, '账号或密码错误');
  }

  // 验证密码
  const isValid = await bcrypt.compare(password, staff.password_hash);
  if (!isValid) {
    ctx.throw(401, '账号或密码错误');
  }

  // 检查状态
  if (staff.status !== 1) {
    ctx.throw(401, '账号已被禁用');
  }

  // 获取角色信息
  const roles = staff.Roles || [];
  const roleCodes = roles.map(r => r.role_code);

  // 查询菜单权限
  const roleIds = roles.map(r => r.role_id);
  const roleMenus = await RoleMenu.findAll({
    where: { role_id: roleIds },
    include: [{ model: Menu }]
  });
  const menuIds = [...new Set(roleMenus.map(rm => rm.menu_id))];
  const menus = await Menu.findAll({
    where: { menu_id: menuIds, status: 1 },
    order: [['sort_order', 'ASC']]
  });

  // 老板角色拥有所有区域权限
  let regionCodes = [];
  if (roleCodes.includes('boss')) {
    regionCodes = ['*'];
  } else if (staff.region_id) {
    regionCodes = [staff.region_id];
  }

  // 生成 token
  const token = jwt.sign(
    {
      staffId: staff.staff_id,
      phone: staff.phone,
      roleCode: staff.role_code
    },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );

  ctx.body = {
    token,
    userInfo: {
      staffId: staff.staff_id,
      name: staff.name,
      phone: staff.phone,
      roleCode: staff.role_code,
      roleName: roles[0]?.name || '员工',
      roles: roleCodes,
      storeId: staff.store_id,
      storeName: staff.Store?.name,
      regionId: staff.region_id,
      regionCodes,
      menus: buildMenuTree(menus)
    }
  };
}

/**
 * 获取用户信息
 */
async function getUserInfo(ctx) {
  const user = ctx.state.user;

  const staff = await Staff.findByPk(user.staffId, {
    include: [
      { model: Role, as: 'Roles', through: { attributes: [] } },
      { model: Store, as: 'Store', include: [{ model: Region, as: 'Region' }] }
    ]
  });

  if (!staff) {
    ctx.throw(404, '用户不存在');
  }

  // 查询角色和菜单
  const roles = staff.Roles || [];
  const roleIds = roles.map(r => r.role_id);
  const roleMenus = await RoleMenu.findAll({
    where: { role_id: roleIds }
  });

  const menuIds = [...new Set(roleMenus.map(rm => rm.menu_id))];
  const menus = await Menu.findAll({
    where: { menu_id: menuIds, status: 1 },
    order: [['sort_order', 'ASC']]
  });

  const roleCodes = roles.map(r => r.role_code);

  ctx.body = {
    staffId: staff.staff_id,
    name: staff.name,
    phone: staff.phone,
    roleCode: staff.role_code,
    roles: roleCodes,
    storeId: staff.store_id,
    storeName: staff.Store?.name,
    regionId: staff.region_id,
    regionCodes: user.regionCodes,
    menus: buildMenuTree(menus)
  };
}

/**
 * 修改密码
 */
async function changePassword(ctx) {
  const user = ctx.state.user;
  const { oldPassword, newPassword } = ctx.request.body;

  if (!oldPassword || !newPassword) {
    ctx.throw(400, '请输入旧密码和新密码');
  }

  const staff = await Staff.findByPk(user.staffId);

  // 验证旧密码
  const isValid = await bcrypt.compare(oldPassword, staff.password_hash);
  if (!isValid) {
    ctx.throw(400, '旧密码错误');
  }

  // 更新密码
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await staff.update({ password_hash: passwordHash });

  ctx.body = { message: '密码修改成功' };
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
      path: menu.path,
      icon: menu.icon,
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

module.exports = { login, getUserInfo, changePassword };
