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
 *   - 库存查询: 所有角色可查看本经销商全部有效门店，写入仍受门店权限限制
 *   - 经营报表: 店长/店员沿用账号已配置的门店范围，BOSS 保持全局范围
 *   - 入库/退库: 店员/店长只能操作自己门店
 *   - 财务管理: 经销商级账号；店长/店员不可访问
 *   - 采购管理: purchaser/admin/boss
 */

function getUserRoles(user) {
  if (Array.isArray(user?.roles) && user.roles.length > 0) {
    return [...new Set(user.roles.map(role => String(role).trim().toLowerCase()).filter(Boolean))];
  }
  return String(user?.roleCode || '')
    .split(',')
    .map(role => role.trim().toLowerCase())
    .filter(Boolean);
}

function hasAnyRole(user, allowedRoles) {
  const roles = getUserRoles(user);
  return roles.includes('boss') || roles.includes('admin') || roles.some(role => allowedRoles.includes(role));
}

const STORE_ONLY_ROLE_CODES = new Set(['clerk', 'staff', 'manager', 'store_manager', 'store_admin']);
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

function requireDistributorAccount() {
  return async (ctx, next) => {
    if (!isDealerAccount(ctx.state.user)) {
      ctx.throw(403, '店长及店员不可访问财务管理');
    }

    await next();
  };
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
 * 销售订单允许选择账号已配置经销商下的任意有效门店。
 * 具体门店归属由控制器再次校验；这里负责兼容写入路由的门店参数。
 */
async function enforceOrderStoreOwnership(ctx, next) {
  const requestedStoreId = ctx.request.body?.storeId
    || ctx.request.body?.store_id
    || ctx.query?.storeId
    || ctx.query?.store_id
    || '';
  if (requestedStoreId) {
    const { Store } = require('../models');
    const { canAccessDistributor } = require('../utils/distributorScope');
    const store = await Store.findOne({
      where: { store_id: requestedStoreId, is_deleted: 0, status: 1 },
      attributes: ['store_id', 'distributor_id']
    });
    if (!store || !canAccessDistributor(ctx.state.user || {}, store.distributor_id)) {
      ctx.throw(403, '无权操作该门店订单');
    }
    if (ctx.request.body) ctx.request.body.store_id = store.store_id;
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
  enforceOrderStoreOwnership,
  filterByStore,
  isDealerAccount,
  requireDistributorAccount,
  isDealerTransferOperation
};
