/**
 * 鉴权中间件
 * 验证 JWT token 并检查数据权限
 */
const jwt = require('jsonwebtoken');
const config = require('../config');
const { Staff, Role } = require('../models');
const { resolveAccessibleStoreIds, resolvePrimaryStoreId, resolveConfiguredRegions, isStoreScopedAccount, isMallReportViewer } = require('../utils/storePermissions');
const { resolveStaffDistributorIds } = require('../utils/distributorScope');
const { isDealerTraceAccount } = require('../utils/snTracePermission');
const { consumeDownloadTicket } = require('../utils/downloadTicket');

async function authMiddleware(ctx, next) {
  // 获取 token
  const headerToken = ctx.headers.authorization?.replace('Bearer ', '');
  const token = headerToken || consumeDownloadTicket(ctx.query?.downloadToken);

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

    let roles = (staff.Roles || [])
      .map(role => String(role.role_code || '').trim().toLowerCase())
      .filter(Boolean);
    if (roles.length === 0 && staff.role_code) roles = [String(staff.role_code).trim().toLowerCase()];
    roles = [...new Set(roles)];

    const configuredRegions = await resolveConfiguredRegions(staff, roles);
    const regionCodes = configuredRegions.codes;
    const accessibleDistributorIds = roles.includes('boss') ? ['*'] : await resolveStaffDistributorIds(staff);
    const accessibleStoreIds = await resolveAccessibleStoreIds(staff, roles);
    const effectiveStoreId = isStoreScopedAccount(roles)
      ? resolvePrimaryStoreId(staff, accessibleStoreIds)
      : null;

    ctx.state.user = {
      staffId: staff.staff_id,
      name: staff.name,
      phone: staff.phone,
      roleCode: staff.role_code,
      roles,
      distributorId: staff.distributor_id,
      distributorIds: accessibleDistributorIds,
      accessibleDistributorIds,
      storeId: effectiveStoreId,
      regionId: staff.region_id,
      regionCodes,
      regionIds: configuredRegions.ids,
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
 * 拦截显式传入的未授权门店。普通写入接口仍按 accessibleStoreIds 过滤；
 * 库存和经营报表只读接口由对应控制器执行更细的数据范围规则。
 */
async function storeAccessMiddleware(ctx, next) {
  const user = ctx.state.user;
  if (isMallReportViewer(user?.roles || user?.roleCode)) {
    const isAllowedQuery = ctx.method === 'GET' && (
      ctx.path === '/api/v1/sales/list' ||
      /^\/api\/v1\/sales\/[^/]+$/.test(ctx.path)
    );
    if (!isAllowedQuery) {
      ctx.throw(403, '商场查询账号仅允许查询已上报商场数据');
    }
    return next();
  }
  if (!user || user.roles?.includes('boss') || user.accessibleStoreIds?.includes('*')) return next();
  if (ctx.path.startsWith('/api/v1/system/')) return next();
  if (ctx.path === '/api/v1/store/create' && ctx.method === 'POST') return next();
  // 新建/编辑销售订单的门店范围由销售控制器按经销商权限校验，允许先通过门店切换参数。
  if (isDealerTraceAccount(user) && ctx.method !== 'GET' && (
    ctx.path === '/api/v1/sales/create' ||
    ctx.path === '/api/v1/sales/draft' ||
    /^\/api\/v1\/sales\/draft\/[^/]+$/.test(ctx.path) ||
    /^\/api\/v1\/sales\/draft\/[^/]+\/(submit)$/.test(ctx.path) ||
    /^\/api\/v1\/sales\/[^/]+$/.test(ctx.path)
  )) return next();
  // 调拨申请由同一区域内任意登录用户发起，具体经销商/区域范围由调拨控制器二次校验。
  if (ctx.path === '/api/v1/inventory/transfer' && ctx.method === 'POST') return next();
  // 经销商级账号可以操作本经销商全部调拨门店，具体单据和区域范围由调拨控制器二次校验。
  if (isDealerTraceAccount(user) && ctx.method === 'POST' && (
    ctx.path === '/api/v1/inventory/transfer/confirm-out' ||
    ctx.path === '/api/v1/inventory/transfer/confirm-in' ||
    ctx.path === '/api/v1/inventory/transfer/return' ||
    ctx.path === '/api/v1/inventory/transfer/revoke' ||
    ctx.path === '/api/v1/inventory/transfer/reject'
  )) return next();
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
       ctx.path === '/api/v1/store/all' ||
       ctx.path === '/api/v1/store/order-options') &&
      isDealerTraceAccount(user)) {
    return next();
  }

  if (ctx.method === 'GET' && ctx.path === '/api/v1/store/order-options') return next();

  // 库存查询、报表查询和只读门店选项由各自控制器按业务范围校验，
  // 不在通用门店中间件中拦截跨门店的查询参数；库存写入接口仍走原门店权限链路。
  if (ctx.method === 'GET' && new Set([
    '/api/v1/store/readable',
    '/api/v1/store/inventory-readable',
    '/api/v1/inventory/list',
    '/api/v1/inventory/list/export',
    '/api/v1/inventory/summary-export',
    '/api/v1/inventory/sn-inventory-list',
    '/api/v1/inventory/sn-inventory-list/export',
    '/api/v1/inventory/sn-list',
    '/api/v1/report/sales',
    '/api/v1/report/inventory',
    '/api/v1/report/employee-performance',
    '/api/v1/report/dashboard/filters',
    '/api/v1/report/dashboard/overview',
    '/api/v1/report/finance-overview',
    '/api/v1/report/monthly-task-achievement',
    '/api/v1/sales/monthly-tasks/options',
    '/api/v1/sales/monthly-tasks'
  ]).has(ctx.path)) {
    return next();
  }

  // 经销商级账号的库存汇总按直接配置的区域读取，不能再用旧的门店权限列表拦截。
  if (ctx.method === 'GET' &&
      (ctx.path === '/api/v1/inventory/list' ||
       ctx.path === '/api/v1/inventory/list/export' ||
       ctx.path === '/api/v1/inventory/summary-export') &&
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
  const isSalesOrderScopedWrite = ctx.method !== 'GET' && (
    ctx.path === '/api/v1/sales/create' ||
    ctx.path === '/api/v1/sales/draft' ||
    /^\/api\/v1\/sales\/draft\/[^/]+$/.test(ctx.path) ||
    /^\/api\/v1\/sales\/draft\/[^/]+\/(submit)$/.test(ctx.path) ||
    /^\/api\/v1\/sales\/[^/]+$/.test(ctx.path)
  );
  if (allowed.size === 0 && storeBusinessPrefixes.some(prefix => ctx.path.startsWith(prefix)) && !isReadOnlySalesQuery && !isSalesOrderScopedWrite) {
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
