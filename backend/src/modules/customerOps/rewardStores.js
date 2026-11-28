const { Store, Distributor } = require('../../models');
const S = require('./security');

async function activeStores(ids, transaction) {
  if (!ids.length) return [];
  const rows = await Store.findAll({ where: { store_id: ids, status: 1, is_deleted: 0 }, transaction });
  const dealers = await Distributor.findAll({ where: { distributor_id: [...new Set(rows.map(r => r.distributor_id))], status: 1, is_deleted: 0 }, transaction });
  const active = new Set(dealers.map(d => String(d.distributor_id)));
  return rows.filter(r => active.has(String(r.distributor_id)));
}

async function validateSelection(user, owner, ids, transaction) {
  const rows = await activeStores(ids, transaction);
  if (!ids.length || rows.length !== ids.length) S.fail(400, '请选择有效门店，停用门店或经销商不可使用');
  const boss = (user.roles || [user.roleCode]).includes('boss');
  for (const row of rows) {
    if (!boss && String(row.distributor_id) !== String(owner)) S.fail(403, '仅boss可配置跨经销商适用门店');
    S.store(user, row);
  }
  return rows;
}

function accepts(snapshot, store, owner) {
  if (!(snapshot.storeIds || []).map(String).includes(String(store.store_id))) return false;
  const frozen = (snapshot.stores || []).find(s => String(s.store_id) === String(store.store_id));
  // New snapshots pin the fulfillment store's distributor. Old vouchers retain
  // their original same-distributor boundary even if stores are later moved.
  return String(frozen?.distributor_id || owner) === String(store.distributor_id);
}

module.exports = { activeStores, validateSelection, accepts };
