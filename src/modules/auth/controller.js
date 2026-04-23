/**
 * 认证控制器
 */
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Staff, Role, Menu, RoleMenu, StaffRole, RegionPermission, Store, Region } = require('../../models');
const config = require('../../config');

/**
 * 登录
 */
async function login(ctx) {
  const { phone, password } = ctx.request.body;

  if (!phone || !password) {
    ctx.throw(400, '请输入手机号和密码');
  }

  // 查询用户
  const staff = await Staff.findOne({
    where: { phone, is_deleted: 0 }
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

  // 老板角色拥有所有区域权限
  const roleCode = staff.role_code;
  let regionCodes = ['CD', 'CQ', 'DS', '*']; // 默认老板有所有权限
  if (roleCode !== 'boss') {
    // 非老板查询区域权限
    const regionPermissions = await RegionPermission.findAll({
      where: { staff_id: String(staff.staff_id) }
    });
    regionCodes = regionPermissions.map(rp => rp.region_code);
  }

  // 生成 token
  const token = jwt.sign(
    {
      staffId: staff.staff_id,
      phone: staff.phone,
      roleCode: roleCode
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
      roleCode: roleCode,
      regionCodes
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
      { model: Store, include: [Region] }
    ]
  });

  if (!staff) {
    ctx.throw(404, '用户不存在');
  }

  // 查询角色和菜单
  const staffRoles = await StaffRole.findAll({
    where: { staff_id: user.staffId },
    include: [{ model: Role }]
  });

  const roleIds = staffRoles.map(sr => sr.role_id);
  const roleMenus = await RoleMenu.findAll({
    where: { role_id: roleIds }
  });

  const menuIds = [...new Set(roleMenus.map(rm => rm.menu_id))];
  const menus = await Menu.findAll({
    where: { menu_id: menuIds, status: 1 },
    order: [['sort_order', 'ASC']]
  });

  const roleCodes = staffRoles.map(sr => sr.Role?.role_code || 'staff');

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
