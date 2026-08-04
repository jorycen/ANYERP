/**
 * 鉴权中间件
 * 验证 JWT token 并检查数据权限
 */
const jwt = require('jsonwebtoken');
const config = require('../config');
const { Staff, Role, RegionPermission } = require('../models');
const { resolveAccessibleStoreIds, resolvePrimaryStoreId } = require('../utils/storePermissions');
const { isDealerTraceAccount } = require('../utils/snTracePermission');

async function authMiddleware(ctx, next) {
  // 获取 token
  const token = ctx.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    ctx.throw(401, '未登录，请先登录');
  }

  try {
    // 验证 token
    const decoded = jwt.verify(token, config.jwt.secret);

    // 查询用户信息
    const staff = await Staff.findByPk(decoded.staffId, {
      include: [{ model: Role, as: 'Roles', through: { attributes: [] }, where: { status: 1 }, required: false }]
    });

    if (!staff) {
      ctx.throw(401, '用户不存在');
    }

    if (staff.status !== 1) {
      ctx.throw(401, '账号已停用');
    }

    let roles = (staff.Roles || []).map(role => role.role_code);
    if (roles.length === 0 && staff.role_code) roles = [staff.role_code];
    roles = [...new Set(roles)];

    const permissions = await RegionPermission.findAll({
      where: { staff_id: staff.staff_id, can_view: 1 },
      attributes: ['region_code']
    });
    const regionCodes = roles.includes('boss')
      ? ['*']
      : [...new Set([staff.region_id, ...permissions.map(item => item.region_code)].filter(Boolean))];
    const accessibleStoreIds = await resolveAccessibleStoreIds(staff, roles);
    const effectiveStoreId = roles.includes('boss')
      ? staff.store_id
      : resolvePrimaryStoreId(staff, accessibleStoreIds);

    ctx.state.user = {
      staffId: staff.staff_id,
      name: staff.name,
      phone: staff.phone,
      roleCode: staff.role_code,
      roles,
      distributorId: staff.distributor_id,
      storeId: effectiveStoreId,
      regionId: staff.region_id,
      regionCodes,
      accessibleStoreIds
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
 * 拦截显式传入的未授权门店。列表接口仍需在查询层按 accessibleStoreIds 过滤。
 */
async function storeAccessMiddleware(ctx, next) {
  const user = ctx.state.user;
  if (!user || user.roles?.includes('boss') || user.accessibleStoreIds?.includes('*')) return next();
  if (ctx.path.startsWith('/api/v1/system/')) return next();
  if (ctx.path === '/api/v1/store/create' && ctx.method === 'POST') return next();
  // 调拨申请由同一区域内任意登录用户发起，具体经销商/区域范围由调拨控制器二次校验。
  if (ctx.path === '/api/v1/inventory/transfer' && ctx.method === 'POST') return next();
  // 调拨商品查询由控制器按经销商/区域二次校验，不使用普通库存的门店授权列表。
  if (ctx.method === 'GET' && ctx.query?.scope === 'transfer' && (
    ctx.path === '/api/v1/inventory/list' ||
    ctx.path === '/api/v1/inventory/sn-list' ||
    ctx.path.startsWith('/api/v1/inventory/locations/') ||
    ctx.path === '/api/v1/product/pn-list'
  )) return next();
  if (ctx.method === 'GET' && (
    ctx.path === '/api/v1/purchase/supplier-list' ||
    ctx.path === '/api/v1/purchase/supplier-all'
  )) return next();

  if (ctx.method === 'GET' &&
      (ctx.path === '/api/v1/sales/list' ||
       ctx.path === '/api/v1/sales/export' ||
       ctx.path === '/api/v1/store/all') &&
      isDealerTraceAccount(user)) {
    return next();
  }

  if (ctx.path.startsWith('/api/v1/sales/subsidy-photos') && isDealerTraceAccount(user)) {
    return next();
  }

  const allowed = new Set((user.accessibleStoreIds || []).map(String));
  const storeBusinessPrefixes = ['/api/v1/sales', '/api/v1/inventory', '/api/v1/purchase', '/api/v1/finance', '/api/v1/report', '/api/v1/store'];
  const isReadOnlySalesQuery = ctx.method === 'GET' && (
    ctx.path === '/api/v1/sales/list' ||
    ctx.path === '/api/v1/sales/export' ||
    ctx.path.startsWith('/api/v1/sales/subsidy-photos') ||
    /^\/api\/v1\/sales\/[^/]+$/.test(ctx.path)
  );
  if (allowed.size === 0 && storeBusinessPrefixes.some(prefix => ctx.path.startsWith(prefix)) && !isReadOnlySalesQuery) {
    ctx.throw(403, '当前账号尚未分配门店');
  }
  const isStoreKey = key => /store_?ids?$/.test(key.toLowerCase());
  const requested = [];
  const collect = (value, skipNestedStoreIds = false) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (isStoreKey(key)) {
        // 辅助销售人可以来自其他门店；这里的 storeId 只是人员归属信息，
        // 不是本次订单实际操作的门店。订单主门店仍由顶层 storeId 校验。
        if (skipNestedStoreIds) continue;
        const values = Array.isArray(item) ? item : [item];
        requested.push(...values.filter(Boolean).map(String));
      } else if (item && typeof item === 'object') {
        const isAuxiliarySalesList = /^(auxiliary_?sales_?list)$/i.test(key);
        collect(item, skipNestedStoreIds || isAuxiliarySalesList);
      }
    }
  };
  collect(ctx.query);
  collect(ctx.request.body);

  if (requested.some(storeId => !allowed.has(storeId))) {
    ctx.throw(403, allowed.size === 0 ? '当前账号尚未分配门店' : '无权访问该门店');
  }
  await next();
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
    if (user.roles?.includes('boss') || user.regionCodes.includes('*')) {
      return await next();
    }

    // 检查目标区域是否在用户权限范围内
    if (targetRegion && !user.regionCodes.includes(targetRegion)) {
      ctx.throw(403, '无权访问该区域数据');
    }

    await next();
  };
}

module.exports = { authMiddleware, regionAuth, storeAccessMiddleware };
