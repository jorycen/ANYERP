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

function requireRole(...allowedRoles) {
  return async (ctx, next) => {
    const { roleCode } = ctx.state.user;

    if (roleCode === 'boss' || roleCode === 'admin') {
      return await next();
    }

    const userRoles = (roleCode || '').split(',').map(s => s.trim());
    const hasRole = userRoles.some(r => allowedRoles.includes(r));

    if (!hasRole) {
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
  const { roleCode, storeId } = ctx.state.user;

  if (roleCode === 'boss' || roleCode === 'admin' || roleCode === 'finance' || roleCode === 'purchaser') {
    return null;
  }

  if (!storeId) {
    ctx.throw(403, '未绑定门店, 无权操作');
  }

  return storeId;
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

module.exports = { requireRole, storeGuard, enforceStoreOwnership, filterByStore };
