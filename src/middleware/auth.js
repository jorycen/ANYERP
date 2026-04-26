/**
 * 鉴权中间件
 * 验证 JWT token 并检查数据权限
 */
const jwt = require('jsonwebtoken');
const config = require('../config');
const { Staff, RegionPermission } = require('../models');

async function authMiddleware(ctx, next) {
  // 获取 token
  const token = ctx.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    ctx.throw(401, '未登录，请先登录');
  }

  try {
    // 验证 token
    const decoded = jwt.verify(token, config.jwt.secret);

    // 查询用户信息 - 不再使用 RegionPermission，避免别名问题
    const staff = await Staff.findByPk(decoded.staffId);

    if (!staff) {
      ctx.throw(401, '用户不存在');
    }

    if (staff.status !== 1) {
      ctx.throw(401, '账号已被禁用');
    }

    // 老板角色拥有所有区域权限，其他角色使用 staff.region_id
    const regionCodes = staff.role_code === 'boss'
      ? ['*']
      : (staff.region_id ? [staff.region_id] : []);

    // 将用户信息挂载到 ctx
    ctx.state.user = {
      staffId: staff.staff_id,
      name: staff.name,
      phone: staff.phone,
      roleCode: staff.role_code,
      distributorId: staff.distributor_id,
      storeId: staff.store_id,
      regionId: staff.region_id,
      regionCodes
    };

    await next();

  } catch (err) {
    if (err.name === 'JsonWebTokenError') {
      ctx.throw(401, 'token无效');
    } else if (err.name === 'TokenExpiredError') {
      ctx.throw(401, 'token已过期');
    }
    throw err;
  }
}

/**
 * 区域数据权限检查中间件
 * 用于检查用户是否有权访问特定区域的数据
 */
function regionAuth(regionField = 'region_id') {
  return async (ctx, next) => {
    const user = ctx.state.user;
    const targetRegion = ctx.request.body[regionField] ||
                        ctx.query.region_code ||
                        ctx.params.region_code;

    // 老板和系统管理员拥有所有权限
    if (user.roleCode === 'boss' || user.regionCodes.includes('*')) {
      return await next();
    }

    // 检查目标区域是否在用户权限范围内
    if (targetRegion && !user.regionCodes.includes(targetRegion)) {
      ctx.throw(403, '无权访问该区域数据');
    }

    await next();
  };
}

module.exports = { authMiddleware, regionAuth };
