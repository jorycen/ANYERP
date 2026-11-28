const { Op } = require('sequelize');
const {
  Product,
  ProductSn,
  Location,
  Inventory
} = require('../../models');
const { summariesForSns } = require('./resourceRights');

const SERIALIZED_PRODUCT_CACHE_TTL_MS = 60 * 1000;
const serializedProductCache = new Map();

const SERIALIZED_STOCK_FIELDS = [
  'normal_qty',
  'display_qty',
  'demo_qty',
  'unsellable_qty',
  'pending_qty',
  'rental_demo_qty'
];

function emptyBalance() {
  return {
    normal_qty: 0,
    display_qty: 0,
    demo_qty: 0,
    unsellable_qty: 0,
    pending_qty: 0,
    rental_demo_qty: 0,
    regular_qty: 0,
    subsidy_qty: 0,
    second_qty: 0
  };
}

function getSerializedResourceQuantity(sn, summary) {
  const label = String(summary?.sales_resource_label || '');
  const available = String(summary?.available_resource_summary || '');
  const taxType = String(sn?.tax_type || '').toUpperCase();

  if (label === '全资源货') return { regular_qty: 1, subsidy_qty: 0, second_qty: 0 };
  if (available.includes('国补')) return { regular_qty: 0, subsidy_qty: 1, second_qty: 0 };
  if (taxType === 'UNTAXED' || label === '未税货') return { regular_qty: 0, subsidy_qty: 0, second_qty: 1 };
  return { regular_qty: 1, subsidy_qty: 0, second_qty: 0 };
}

function getSerializedStockField(status, locationType) {
  if (status === 'reserved' || status === 'occupied') return 'pending_qty';
  if (status !== 'in_stock') return '';
  return SERIALIZED_STOCK_FIELDS.includes(locationType) ? locationType : '';
}

async function isSerializedProduct(productId, transaction) {
  const now = Date.now();
  const cached = serializedProductCache.get(String(productId));
  if (cached && cached.expiresAt > now) return cached.value;

  const product = await Product.findOne({
    where: { product_id: productId },
    attributes: ['product_id', 'need_sn'],
    transaction
  });
  const value = Number(product?.need_sn) === 1;
  serializedProductCache.set(String(productId), { value, expiresAt: now + SERIALIZED_PRODUCT_CACHE_TTL_MS });
  return value;
}

/**
 * Rebuilds the serialized stock projection for one product/store pair.
 * T_PRODUCT_SN remains the unit-level fact; T_INVENTORY is updated as a
 * materialized balance in the caller's transaction.
 */
async function syncSerializedInventoryBalance({ productId, storeId, transaction = null } = {}) {
  if (!productId || !storeId) return { changed: 0, skipped: true };

  if (!await isSerializedProduct(productId, transaction)) return { changed: 0, skipped: true };

  const locations = await Location.findAll({
    where: { store_id: storeId, status: 1 },
    attributes: ['location_id', 'type'],
    raw: true,
    transaction
  });
  const locationTypeMap = new Map(locations.map(location => [String(location.location_id), String(location.type || '')]));

  const snRows = await ProductSn.findAll({
    where: {
      product_id: productId,
      store_id: storeId,
      is_deleted: 0,
      status: { [Op.in]: ['in_stock', 'reserved', 'occupied'] }
    },
    attributes: ['sn_id', 'location_id', 'status', 'tax_type'],
    raw: true,
    transaction
  });
  const summaryMap = snRows.length ? await summariesForSns(snRows, transaction) : new Map();
  const desired = new Map();

  for (const sn of snRows) {
    const locationId = String(sn.location_id || '');
    const locationType = locationTypeMap.get(locationId);
    const field = getSerializedStockField(String(sn.status || ''), locationType);
    if (!field) continue;

    if (!desired.has(locationId)) desired.set(locationId, emptyBalance());
    const balance = desired.get(locationId);
    balance[field] += 1;
    if (field === 'normal_qty' && sn.status === 'in_stock') {
      const resource = getSerializedResourceQuantity(sn, summaryMap.get(sn.sn_id));
      balance.regular_qty += resource.regular_qty;
      balance.subsidy_qty += resource.subsidy_qty;
      balance.second_qty += resource.second_qty;
    }
  }

  const inventoryRows = await Inventory.findAll({
    where: { product_id: productId, store_id: storeId },
    transaction,
    lock: transaction?.LOCK?.UPDATE
  });
  const inventoryMap = new Map(inventoryRows.map(row => [String(row.location_id || ''), row]));
  let changed = 0;

  for (const [locationId, balance] of desired.entries()) {
    let row = inventoryMap.get(locationId);
    if (!row) {
      row = await Inventory.create({
        inventory_id: require('crypto').randomUUID().replace(/-/g, ''),
        product_id: productId,
        store_id: storeId,
        location_id: locationId,
        ...emptyBalance()
      }, { transaction });
      inventoryMap.set(locationId, row);
    }
    const payload = Object.fromEntries([
      ...SERIALIZED_STOCK_FIELDS.map(field => [field, balance[field]]),
      ['regular_qty', balance.regular_qty],
      ['subsidy_qty', balance.subsidy_qty],
      ['second_qty', balance.second_qty]
    ]);
    const differs = Object.entries(payload).some(([field, value]) => Number(row[field] || 0) !== Number(value || 0));
    if (differs) {
      await row.update(payload, { transaction });
      changed += 1;
    }
  }

  for (const row of inventoryRows) {
    const locationId = String(row.location_id || '');
    if (desired.has(locationId)) continue;
    const payload = Object.fromEntries([
      ...SERIALIZED_STOCK_FIELDS.map(field => [field, 0]),
      ['regular_qty', 0],
      ['subsidy_qty', 0],
      ['second_qty', 0]
    ]);
    const differs = Object.entries(payload).some(([field, value]) => Number(row[field] || 0) !== value);
    if (differs) {
      await row.update(payload, { transaction });
      changed += 1;
    }
  }

  return { changed, skipped: false };
}

module.exports = {
  SERIALIZED_STOCK_FIELDS,
  getSerializedResourceQuantity,
  getSerializedStockField,
  syncSerializedInventoryBalance
};
