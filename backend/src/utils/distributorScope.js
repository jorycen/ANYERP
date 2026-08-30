const { Op } = require('sequelize');
const { Distributor, StaffDistributorPermission, Store } = require('../models');

function uniqueIds(values) {
  const list = Array.isArray(values) ? values : (values === undefined || values === null ? [] : [values]);
  return [...new Set(list.map(value => String(value || '').trim()).filter(Boolean))];
}

function normalizeRoles(userOrRoles = {}) {
  const roles = Array.isArray(userOrRoles)
    ? userOrRoles
    : (userOrRoles.roles || userOrRoles.roleCode || []);
  return uniqueIds(Array.isArray(roles) ? roles : String(roles).split(','))
    .map(role => role.toLowerCase());
}

function isBoss(userOrRoles = {}) {
  return normalizeRoles(userOrRoles).includes('boss');
}

async function resolveStaffDistributorIds(staffOrId, fallbackId = '') {
  const staffId = typeof staffOrId === 'object' ? staffOrId.staff_id || staffOrId.staffId : staffOrId;
  const rows = staffId
    ? await StaffDistributorPermission.findAll({
      where: { staff_id: staffId },
      attributes: ['distributor_id'],
      raw: true
    })
    : [];
  const ids = uniqueIds(rows.map(row => row.distributor_id));
  if (ids.length) return ids;
  const fallback = typeof staffOrId === 'object' ? staffOrId.distributor_id : fallbackId;
  return uniqueIds([fallback]);
}

function accessibleDistributorIds(user = {}) {
  if (isBoss(user) || user.accessibleDistributorIds?.includes('*')) return ['*'];
  return uniqueIds(user.accessibleDistributorIds || user.distributorIds || user.distributorId);
}

function canAccessDistributor(user, distributorId) {
  const target = String(distributorId || '').trim();
  const ids = accessibleDistributorIds(user);
  // 仅兼容尚未回填经销商快照的历史单据/旧测试上下文；已识别经销商范围的账号不得访问空归属数据。
  if (!target) return ids.length === 0;
  return ids.includes('*') || ids.includes(target);
}

function distributorWhere(user, field = 'distributor_id') {
  const ids = accessibleDistributorIds(user);
  if (ids.includes('*')) return {};
  return { [field]: ids.length ? { [Op.in]: ids } : '__NO_DISTRIBUTOR__' };
}

async function resolveStoresForDistributors(distributorIds) {
  const ids = uniqueIds(distributorIds);
  if (!ids.length) return [];
  const rows = await Store.findAll({
    where: { distributor_id: { [Op.in]: ids }, is_deleted: 0, status: 1 },
    attributes: ['store_id'],
    raw: true
  });
  return uniqueIds(rows.map(row => row.store_id));
}

/**
 * 销售订单场景的门店范围：按账号已配置的经销商权限展开全部有效门店。
 * 该范围只供订单创建/查询使用，不改变库存、财务等模块的门店权限。
 */
async function resolveOrderStoreIds(user = {}) {
  const distributorIds = accessibleDistributorIds(user);
  if (distributorIds.includes('*')) return ['*'];
  return resolveStoresForDistributors(distributorIds);
}

async function validateDistributorIds(ids) {
  const normalized = uniqueIds(ids);
  if (!normalized.length) return [];
  const rows = await Distributor.findAll({
    where: { distributor_id: { [Op.in]: normalized }, is_deleted: 0, status: 1 },
    attributes: ['distributor_id', 'name'],
    raw: true
  });
  if (rows.length !== normalized.length) {
    const valid = new Set(rows.map(row => String(row.distributor_id)));
    const invalid = normalized.filter(id => !valid.has(id));
    const error = new Error(`经销商不存在或已停用：${invalid.join(', ')}`);
    error.status = 400;
    throw error;
  }
  return rows;
}

module.exports = {
  uniqueIds,
  normalizeRoles,
  isBoss,
  resolveStaffDistributorIds,
  accessibleDistributorIds,
  canAccessDistributor,
  distributorWhere,
  resolveStoresForDistributors,
  resolveOrderStoreIds,
  validateDistributorIds
};
