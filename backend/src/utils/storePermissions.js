const { Op } = require('sequelize');
const { StaffStorePermission, RegionPermission, Store } = require('../models');

function uniqueIds(values) {
  return [...new Set((values || []).map(value => String(value || '')).filter(Boolean))];
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

module.exports = { resolveAccessibleStoreIds, resolvePrimaryStoreId };
