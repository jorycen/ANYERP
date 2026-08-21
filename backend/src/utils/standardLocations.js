const { generateUUID } = require('./index');

const STANDARD_INVENTORY_LOCATIONS = [
  { type: 'normal_qty', name: '销售仓', is_sellable: 1, sort_order: 10 },
  { type: 'demo_qty', name: '样品仓', is_sellable: 1, sort_order: 20 },
  { type: 'display_qty', name: '铺货仓', is_sellable: 1, sort_order: 30 },
  { type: 'unsellable_qty', name: '不可售仓', is_sellable: 0, sort_order: 40 },
  { type: 'pending_qty', name: '占用仓', is_sellable: 0, sort_order: 50 },
  { type: 'rental_demo_qty', name: '租赁样机仓', is_sellable: 0, sort_order: 60 }
];

const STANDARD_LOCATION_TYPE_MAP = STANDARD_INVENTORY_LOCATIONS.reduce((map, item) => {
  map[item.type] = item;
  return map;
}, {});

function normalizeLocationType(type) {
  return String(type || '').trim();
}

function getStandardLocation(type) {
  return STANDARD_LOCATION_TYPE_MAP[normalizeLocationType(type)] || null;
}

async function ensureStandardLocationsForStores(Location, stores, options = {}) {
  const transaction = options.transaction;
  const storeList = (stores || []).filter(Boolean);
  if (storeList.length === 0) return { created: 0, updated: 0 };

  let created = 0;
  let updated = 0;

  for (const store of storeList) {
    const storeId = String(store.store_id || store.storeId || '').trim();
    if (!storeId) continue;

    for (const item of STANDARD_INVENTORY_LOCATIONS) {
      const existing = await Location.findOne({
        where: { store_id: storeId, type: item.type },
        transaction
      });

      if (existing) continue;

      await Location.create({
        location_id: `LOC${generateUUID().slice(0, 20).toUpperCase()}`,
        store_id: storeId,
        name: item.name,
        type: item.type,
        is_sellable: item.is_sellable,
        status: 1
      }, { transaction });
      created += 1;
    }
  }

  return { created, updated };
}

module.exports = {
  STANDARD_INVENTORY_LOCATIONS,
  STANDARD_LOCATION_TYPE_MAP,
  normalizeLocationType,
  getStandardLocation,
  ensureStandardLocationsForStores
};
