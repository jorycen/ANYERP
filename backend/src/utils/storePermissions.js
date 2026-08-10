const { Op } = require('sequelize');
const { StaffStorePermission, RegionPermission, Region, Store } = require('../models');

function uniqueIds(values) {
  return [...new Set((values || []).map(value => String(value || '')).filter(Boolean))];
}

const STORE_ONLY_ROLE_CODES = new Set(['clerk', 'staff', 'manager', 'store_manager']);

function isRegionScopedAccount(roleCodes = []) {
  return roleCodes.some(roleCode => !STORE_ONLY_ROLE_CODES.has(String(roleCode || '').trim()));
}

/**
 * 读取账号直接配置的区域权限。
 * 经销商级账号只使用 T_REGION_PERMISSION，不再从已分配门店反推区域。
 * 店员/店长保留 staff.region_id 的历史兼容逻辑。
 */
async function resolveConfiguredRegions(staff, roleCodes = []) {
  if (roleCodes.includes('boss')) {
    return { ids: ['*'], codes: ['*'], regions: [] };
  }

  const permissions = await RegionPermission.findAll({
    where: { staff_id: staff.staff_id, can_view: 1 },
    attributes: ['region_code'],
    raw: true
  });
  const keys = uniqueIds(permissions.map(item => item.region_code));
  if (!isRegionScopedAccount(roleCodes) && staff.region_id) keys.push(String(staff.region_id));
  const uniqueKeys = uniqueIds(keys);
  if (uniqueKeys.includes('*')) return { ids: ['*'], codes: ['*'], regions: [] };
  if (uniqueKeys.length === 0) return { ids: [], codes: [], regions: [] };

  const regions = await Region.findAll({
    where: {
      status: 1,
      [Op.or]: [
        { region_id: { [Op.in]: uniqueKeys } },
        { region_code: { [Op.in]: uniqueKeys } },
        { name: { [Op.in]: uniqueKeys } }
      ]
    },
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
 * 新数据以 T_STAFF_STORE_PERMISSION 为准；没有精确门店权限时，才兼容旧版
 * T_STAFF.STORE_ID / T_REGION_PERMISSION，避免升级前已分配门店的店员失去权限。
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

module.exports = { resolveAccessibleStoreIds, resolvePrimaryStoreId, resolveConfiguredRegions, isRegionScopedAccount };
