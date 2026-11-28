const { Store, Region } = require('../models');
const { accessibleDistributorIds, canAccessDistributor } = require('./distributorScope');

function transferRegionKeys(store) {
  return [
    store?.region_id,
    store?.Region?.region_id,
    store?.Region?.region_code,
    store?.Region?.name
  ].filter(Boolean).map(String);
}

function userRegionKeys(user) {
  return (Array.isArray(user?.regionCodes) ? user.regionCodes : [])
    .filter(code => code && String(code) !== '*')
    .map(String);
}

/** 调拨查询/操作不依赖 accessibleStoreIds，但仍限制在当前经销商和区域内。 */
async function assertTransferStoreScope(ctx, storeId, { ignoreRegion = false } = {}) {
  const targetStoreId = String(storeId || '').trim();
  if (!targetStoreId) ctx.throw(400, '调拨查询必须指定门店');

  const user = ctx.state.user || {};
  const targetStore = await Store.findOne({
    where: { store_id: targetStoreId, is_deleted: 0, status: 1 },
    include: [{ model: Region, attributes: ['region_id', 'region_code', 'name'] }]
  });
  if (!targetStore) ctx.throw(404, '门店不存在或已停用');
  if ((user.roles || []).includes('boss')) return targetStore;

  const userDistributorIds = accessibleDistributorIds(user);
  let distributorId = String(user.distributorId || '');
  let currentStore = null;
  const accessibleStoreIds = Array.isArray(user.accessibleStoreIds)
    ? user.accessibleStoreIds.map(String).filter(id => id && id !== '*')
    : [];
  const currentStoreId = user.storeId || accessibleStoreIds[0] || '';
  if (currentStoreId) {
    currentStore = await Store.findOne({
      where: { store_id: currentStoreId, is_deleted: 0, status: 1 },
      include: [{ model: Region, attributes: ['region_id', 'region_code', 'name'] }]
    });
    distributorId = distributorId || String(currentStore?.distributor_id || '');
  }

  if (!distributorId && userDistributorIds.length === 1 && userDistributorIds[0] !== '*') {
    distributorId = String(userDistributorIds[0]);
  }

  if (!distributorId && !userDistributorIds.includes('*')) {
    ctx.throw(403, '当前账号未绑定经销商，无法访问调拨门店');
  }

  if (!canAccessDistributor(user, targetStore.distributor_id)) {
    ctx.throw(403, '无权访问该门店');
  }

  if (ignoreRegion || (user.regionCodes || []).includes('*')) return targetStore;

  const regionScope = [...new Set(userRegionKeys(user).concat(transferRegionKeys(currentStore)))];
  const targetRegions = transferRegionKeys(targetStore);
  if (regionScope.length && !targetRegions.some(region => regionScope.includes(region))) {
    ctx.throw(403, '无权访问该区域门店');
  }
  return targetStore;
}

function isTransferScope(ctx) {
  return String(ctx.query?.scope || '').toLowerCase() === 'transfer';
}

module.exports = { assertTransferStoreScope, isTransferScope, transferRegionKeys };
