const { Op } = require('sequelize');
const { StaffStorePermission, RegionPermission, Region, Store } = require('../models');
const { resolveStaffDistributorIds } = require('./distributorScope');

function uniqueIds(values) {
  return [...new Set((values || []).map(value => String(value || '')).filter(Boolean))];
}

const STORE_ONLY_ROLE_CODES = new Set(['clerk', 'staff', 'manager', 'store_manager', 'store_admin', 'mall_report_viewer']);

function normalizeRoleCodes(roleCodes = []) {
  return [...new Set((Array.isArray(roleCodes) ? roleCodes : [roleCodes])
    .map(roleCode => String(roleCode || '').trim().toLowerCase())
    .filter(Boolean))];
}

/**
 * 只有店员/店长类账号才保留“主门店”语义。
 * 经销商级账号和 BOSS 的组织归属分别是经销商/系统，不再绑定当前门店。
 */
function isStoreScopedAccount(roleCodes = []) {
  const roles = normalizeRoleCodes(roleCodes);
  return roles.length > 0 && roles.every(roleCode => STORE_ONLY_ROLE_CODES.has(roleCode));
}

function isRegionScopedAccount(roleCodes = []) {
  return !isStoreScopedAccount(roleCodes);
}

function isStoreManagerAccount(roleCodes = []) {
  const roles = normalizeRoleCodes(roleCodes);
  return roles.some(roleCode => ['manager', 'store_manager', 'store_admin'].includes(roleCode));
}

function isMallReportViewer(roleCodes = []) {
  return normalizeRoleCodes(roleCodes).includes('mall_report_viewer');
}

/**
 * 库存只读范围。所有已登录账号都可以查看其可访问经销商下的全部有效门店库存，
 * 但库存写入仍由 accessibleStoreIds 和业务控制器单独校验。
 */
async function resolveAllReadableStoreIds(user = {}) {
  const roles = normalizeRoleCodes(user.roles || user.roleCode || []);
  if (roles.includes('boss') || (user.accessibleStoreIds || []).includes('*')) return ['*'];

  const distributorIds = uniqueIds(
    Array.isArray(user.accessibleDistributorIds)
      ? user.accessibleDistributorIds
      : Array.isArray(user.distributorIds)
        ? user.distributorIds
        : user.distributorId
          ? [user.distributorId]
          : []
  );
  if (distributorIds.length === 0) return [];

  const stores = await Store.findAll({
    where: {
      distributor_id: { [Op.in]: distributorIds },
      is_deleted: 0,
      status: 1
    },
    attributes: ['store_id'],
    raw: true
  });
  return uniqueIds(stores.map(store => store.store_id));
}

/**
 * 经营报表范围沿用账号已配置的门店权限；BOSS 的全局范围保持不变。
 */
async function resolveReportStoreIds(user = {}) {
  const roles = normalizeRoleCodes(user.roles || user.roleCode || []);
  if (roles.includes('boss') || (user.accessibleStoreIds || []).includes('*')) return ['*'];
  return uniqueIds(user.accessibleStoreIds || []);
}

/**
 * 读取账号直接配置的区域权限。
 * 区域权限用于区域范围；精确门店权限用于最终可操作门店范围。
 * 历史只有区域权限的账号继续兼容为该区域下全部有效门店。
 */
async function resolveConfiguredRegions(staff, roleCodes = []) {
  if (roleCodes.includes('boss')) {
    return { ids: ['*'], codes: ['*'], regions: [] };
  }

  // 区域仅作为已分配门店的派生信息使用，不再独立扩大账号的数据范围。
  // 店员/店长仍兼容历史区域权限生成门店后，再由门店反推区域。
  const accessibleStoreIds = await resolveAccessibleStoreIds(staff, roleCodes);
  if (accessibleStoreIds.includes('*')) return { ids: ['*'], codes: ['*'], regions: [] };
  if (accessibleStoreIds.length === 0) return { ids: [], codes: [], regions: [] };

  const stores = await Store.findAll({
    where: { store_id: { [Op.in]: accessibleStoreIds }, is_deleted: 0, status: 1 },
    attributes: ['region_id'],
    raw: true
  });
  const regionIds = uniqueIds(stores.map(store => store.region_id));
  if (regionIds.length === 0) return { ids: [], codes: [], regions: [] };
  const regions = await Region.findAll({
    where: { region_id: { [Op.in]: regionIds }, status: 1 },
    attributes: ['region_id', 'region_code', 'name'],
    raw: true
  });
  return {
    ids: uniqueIds(regions.map(region => region.region_id)),
    codes: uniqueIds(regions.flatMap(region => [region.region_id, region.region_code])),
    regions
  };
}

/**
 * 读取员工可访问门店。
 *
 * 新数据以 T_STAFF_STORE_PERMISSION 为准；没有精确门店权限时，仅兼容旧版
 * T_STAFF.STORE_ID / T_REGION_PERMISSION，避免升级前已分配门店的纯门店账号失去权限。
 */
async function resolveAccessibleStoreIds(staff, roleCodes = []) {
  if (roleCodes.includes('boss')) return ['*'];

  // 中台账号的门店操作范围由经销商多选权限决定，不受历史精确门店授权残留影响。
  if (!isStoreScopedAccount(roleCodes)) {
    const distributorIds = await resolveStaffDistributorIds(staff);
    if (!distributorIds.length) return [];
    const stores = await Store.findAll({
      where: { distributor_id: { [Op.in]: distributorIds }, is_deleted: 0, status: 1 },
      attributes: ['store_id'],
      raw: true
    });
    return uniqueIds(stores.map(store => store.store_id));
  }

  const permissions = await StaffStorePermission.findAll({
    where: { staff_id: staff.staff_id },
    attributes: ['store_id'],
    include: [{
      model: Store,
      attributes: [],
      required: true,
      where: { is_deleted: 0, status: 1 }
    }],
    raw: true
  });
  const assignedStoreIds = uniqueIds(permissions.map(item => item.store_id));
  if (assignedStoreIds.length > 0) return assignedStoreIds;

  const legacyPermissions = await RegionPermission.findAll({
    where: { staff_id: staff.staff_id, can_view: 1 },
    attributes: ['region_code'],
    raw: true
  });
  const legacyRegionCodes = uniqueIds(legacyPermissions.map(item => item.region_code));
  const legacyStoreId = String(staff.store_id || '');
  const legacyScopes = [];

  if (legacyStoreId) legacyScopes.push({ store_id: legacyStoreId });
  if (legacyRegionCodes.length > 0) {
    legacyScopes.push(
      { store_id: { [Op.in]: legacyRegionCodes } },
      { region_id: { [Op.in]: legacyRegionCodes } }
    );
  }
  if (legacyScopes.length === 0) return [];

  const stores = await Store.findAll({
    where: {
      distributor_id: staff.distributor_id,
      is_deleted: 0,
      status: 1,
      [Op.or]: legacyScopes
    },
    attributes: ['store_id'],
    raw: true
  });
  return uniqueIds(stores.map(store => store.store_id));
}

function resolvePrimaryStoreId(staff, accessibleStoreIds) {
  const storeIds = uniqueIds(accessibleStoreIds).filter(storeId => storeId !== '*');
  const legacyStoreId = String(staff.store_id || '');
  if (legacyStoreId && storeIds.includes(legacyStoreId)) return legacyStoreId;
  return storeIds[0] || null;
}

module.exports = {
  resolveAccessibleStoreIds,
  resolvePrimaryStoreId,
  resolveConfiguredRegions,
  resolveAllReadableStoreIds,
  resolveReportStoreIds,
  isStoreManagerAccount,
  isRegionScopedAccount,
  isStoreScopedAccount,
  isMallReportViewer
};
