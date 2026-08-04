const STORE_ONLY_ROLES = new Set(['clerk', 'staff', 'manager', 'store_manager']);

function normalizeRoles(user = {}) {
  const roles = Array.isArray(user.roles) && user.roles.length > 0
    ? user.roles
    : String(user.roleCode || '').split(',');
  return roles
    .map((role) => (typeof role === 'string' ? role : role?.code || role?.name || ''))
    .map((role) => role.trim().toLowerCase())
    .filter(Boolean);
}

function isBoss(user = {}) {
  return normalizeRoles(user).includes('boss');
}

function isDealerTraceAccount(user = {}) {
  if (isBoss(user)) return true;
  return normalizeRoles(user).some((role) => !STORE_ONLY_ROLES.has(role));
}

function includesValue(values, target) {
  if (target === undefined || target === null || target === '') return false;
  return (Array.isArray(values) ? values : [values]).some((value) => String(value) === String(target));
}

/**
 * SN 追踪单据只允许查看，不改变原有订单操作权限。
 * - boss：全系统
 * - 经销商级账号：admin/boss/财务/商务/采购等：本经销商全部门店
 * - 店长：自己可管理门店
 * - 员工：只允许查看自己发起的原始单据
 */
function canViewSnTraceReference(user = {}, reference = {}) {
  if (isBoss(user)) return true;

  if (isDealerTraceAccount(user)) {
    return Boolean(user.distributorId) && String(user.distributorId) === String(reference.distributor_id);
  }

  const roles = normalizeRoles(user);
  if (roles.includes('manager') || roles.includes('store_manager')) {
    return includesValue(user.accessibleStoreIds, reference.store_id)
      || includesValue(user.accessibleStoreIds, reference.from_store_id)
      || includesValue(user.accessibleStoreIds, reference.to_store_id);
  }

  return includesValue(reference.creator_names, user.name);
}

module.exports = {
  canViewSnTraceReference,
  isDealerTraceAccount,
  isBoss,
  normalizeRoles,
};
