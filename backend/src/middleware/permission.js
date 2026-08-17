/**
 * RBAC 权限中间件
 * 
 * 角色定义:
 *   boss     - 系统管理员, 全部权限
 *   admin    - 经销商总权限, 全部权限
 *   finance  - 财务, 仅财务管理
 *   purchaser- 采购, 仅采购管理
 *   manager  - 店长, 店员权限 + 本门店操作记录
 *   clerk    - 店员, 基础销售/库存查询/报表
 * 
 * 规则:
 *   - 销售管理、库存管理: 所有角色可查询(跨门店)
 *   - 入库/退库: 店员/店长只能操作自己门店
 *   - 财务管理: finance/admin/boss
 *   - 采购管理: purchaser/admin/boss
 */

function getUserRoles(user) {
  if (Array.isArray(user?.roles) && user.roles.length > 0) {
    return [...new Set(user.roles.map(role => String(role).trim()).filter(Boolean))];
  }
  return String(user?.roleCode || '')
    .split(',')
    .map(role => role.trim())
    .filter(Boolean);
}

function hasAnyRole(user, allowedRoles) {
  const roles = getUserRoles(user);
  return roles.includes('boss') || roles.includes('admin') || roles.some(role => allowedRoles.includes(role));
}

const STORE_ONLY_ROLE_CODES = new Set(['clerk', 'staff', 'manager', 'store_manager']);
const TRANSFER_OPERATION_PATHS = new Set([
  '/api/v1/inventory/transfer/confirm-out',
  '/api/v1/inventory/transfer/confirm-in',
  '/api/v1/inventory/transfer/return',
  '/api/v1/inventory/transfer/revoke',
  '/api/v1/inventory/transfer/reject'
]);

function isDealerAccount(user) {
  return getUserRoles(user).some(role => !STORE_ONLY_ROLE_CODES.has(role));
}

function isDealerTransferOperation(ctx) {
  return ctx.method === 'POST'
    && TRANSFER_OPERATION_PATHS.has(ctx.path)
    && isDealerAccount(ctx.state.user);
}

function requireRole(...allowedRoles) {
  return async (ctx, next) => {
    if (!hasAnyRole(ctx.state.user, allowedRoles)) {
      ctx.throw(403, '无权访问此功能');
    }

    await next();
  };
}

/**
 * 门店数据隔离
 * 店员/店长只能操作自己门店的数据
 * 写入操作强制绑定 store_id = ctx.state.user.storeId
 */
function storeGuard(ctx) {
  const user = ctx.state.user;
  if (getUserRoles(user).includes('boss')) return null;
  // 经销商级账号可以操作本经销商全部调拨门店，具体单据范围由调拨控制器校验。
  if (isDealerTransferOperation(ctx)) return null;
  const storeIds = (user.accessibleStoreIds || []).map(String);
  if (storeIds.length === 0) ctx.throw(403, '当前账号尚未分配门店');
  const requestedStoreId = ctx.request.body?.storeId || ctx.request.body?.store_id || ctx.query?.storeId || ctx.query?.store_id || '';
  if (requestedStoreId && !storeIds.includes(String(requestedStoreId))) ctx.throw(403, '无权操作该门店');
  return requestedStoreId || (storeIds.length === 1 ? storeIds[0] : null);
}

/**
 * 自动将用户门店写入请求体
 * 用于入库、退库等写入接口
 */
function enforceStoreOwnership(ctx, next) {
  const storeId = storeGuard(ctx);
  if (storeId) {
    ctx.request.body.store_id = storeId;
  }
  return next();
}

/**
 * 查询数据门店过滤
 * 店员/店长只能查自己门店
 */
function filterByStore(ctx, queryObj = ctx.query) {
  const storeId = storeGuard(ctx);
  if (storeId) {
    queryObj.store_id = storeId;
  }
}

module.exports = {
  getUserRoles,
  hasAnyRole,
  requireRole,
  storeGuard,
  enforceStoreOwnership,
  filterByStore,
  isDealerAccount,
  isDealerTransferOperation
};
