const { Op } = require('sequelize');
const { StaffStorePermission, RegionPermission, Region, Store } = require('../models');

function uniqueIds(values) {
  return [...new Set((values || []).map(value => String(value || '')).filter(Boolean))];
}

const STORE_ONLY_ROLE_CODES = new Set(['clerk', 'staff', 'manager', 'store_manager']);

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

  // 经销商级账号的精确门店权限是唯一事实来源；没有分配门店时必须返回空范围。
  // 仅店员/店长保留旧账号的主门店/区域兼容逻辑。
  if (!isStoreScopedAccount(roleCodes)) return [];

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
  isRegionScopedAccount,
  isStoreScopedAccount
};
