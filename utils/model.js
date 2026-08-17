const { normalizePnCode } = require('./pn.js');

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function normalizeSnCode(value) {
  return text(value).toUpperCase();
}

function first(source, keys, fallback = '') {
  for (const key of keys) {
    if (source && source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
  }
  return fallback;
}

function normalizeId(value) {
  return text(value);
}

function normalizeMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function normalizeQuantity(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 1;
}

function normalizeStatus(value, fallback = '') {
  const status = text(value);
  const lower = status.toLowerCase();
  if (['archived', 'archive', 'completed'].includes(lower)) return 'archived';
  if (['voided', 'void', 'cancelled', 'canceled'].includes(lower)) return 'voided';
  if (['unarchived', 'pending', 'draft'].includes(lower)) return 'unarchived';
  return status || fallback;
}

function normalizeTimestamp(value) {
  if (value === undefined || value === null || value === '') return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function normalizeOrderItem(item = {}) {
  const product = item.Product || item.product || {};
  const priceInfo = item.ProductPrice || item.productPrice || product.ProductPrice || product.productPrice || {};
  const productName = first(item, ['productName', 'product_name', 'name']);
  const unitPrice = normalizeMoney(first(item, ['unitPrice', 'unit_price', 'salePrice', 'sale_price', 'price'], 0));
  const quantity = normalizeQuantity(item.quantity);
  const rawSubtotal = first(item, ['subtotal', 'SUBTOTAL'], '');
  const subtotal = rawSubtotal === '' ? normalizeMoney(unitPrice * quantity) : normalizeMoney(rawSubtotal);
  const originalQuantity = Math.max(quantity, Number(first(item, ['originalQuantity', 'original_quantity', 'soldQuantity', 'sold_quantity'], quantity)) || quantity);
  const returnedQuantity = Math.max(0, Number(first(item, ['returnedQuantity', 'returned_quantity', 'refundedQuantity', 'refunded_quantity', 'returnQuantity', 'return_quantity'], 0)) || 0);
  const refundableQuantity = Math.max(0, Number(first(item, ['refundableQuantity', 'refundable_quantity', 'remainingQuantity', 'remaining_quantity'], originalQuantity - returnedQuantity)) || 0);
  const rawSelectedResourceTypes = first(item, ['selectedResourceTypes', 'selected_resource_types'], []);
  let selectedResourceTypes = rawSelectedResourceTypes;
  if (typeof selectedResourceTypes === 'string') {
    try {
      selectedResourceTypes = JSON.parse(selectedResourceTypes);
    } catch (_) {
      selectedResourceTypes = selectedResourceTypes.split(',');
    }
  }
  if (!Array.isArray(selectedResourceTypes)) selectedResourceTypes = [];

  return {
    itemId: normalizeId(first(item, ['itemId', 'item_id', 'orderItemId', 'order_item_id', '_id', 'id'])),
    productId: normalizeId(first(item, ['productId', 'product_id', 'PRODUCT_ID'])),
    inventoryId: normalizeId(first(item, ['inventoryId', 'inventory_id', 'INVENTORY_ID', 'inventorySnId', 'inventory_sn_id', 'snId', 'sn_id'])),
    category: text(first(item, ['category', 'productCategory', 'product_category'], first(product, ['category', 'productCategory', 'product_category']))),
    accessoryType: text(first(item, ['accessoryType', 'accessory_type'], first(product, ['accessoryType', 'accessory_type']))),
    pnCode: normalizePnCode(first(item, ['pnCode', 'pn_code', 'PN_CODE', 'pn', 'PN'])),
    snCode: normalizeSnCode(first(item, ['snCode', 'sn_code', 'SN_CODE', 'sn', 'SN', 'serialNo', 'serial_no', 'productSn', 'product_sn'])),
    productName,
    mtmCode: text(first(item, ['mtmCode', 'mtm_code', 'MTM_CODE'])),
    standardPrice: Number(first(item, [
      'standardPrice', 'standard_price', 'productStandardPrice', 'product_standard_price'
    ], first(priceInfo, ['standardPrice', 'standard_price', 'productStandardPrice', 'product_standard_price'], first(product, ['standardPrice', 'standard_price', 'productStandardPrice', 'product_standard_price'], 0)))) || 0,
    minSalePrice: Number(first(item, [
      'minSalePrice', 'min_sale_price', 'minimumSalePrice', 'minimum_sale_price',
      'minimumPrice', 'minimum_price', 'minPrice', 'min_price',
      'lowestSalePrice', 'lowest_sale_price', 'lowestPrice', 'lowest_price',
      'floorPrice', 'floor_price', 'lowPrice', 'low_price'
    ], first(priceInfo, [
      'minSalePrice', 'min_sale_price', 'minimumSalePrice', 'minimum_sale_price', 'minimumPrice', 'minimum_price',
      'minPrice', 'min_price', 'lowestSalePrice', 'lowest_sale_price', 'lowestPrice', 'lowest_price',
      'floorPrice', 'floor_price', 'lowPrice', 'low_price'
    ], first(product, [
      'minSalePrice', 'min_sale_price', 'minimumSalePrice', 'minimum_sale_price', 'minimumPrice', 'minimum_price',
      'minPrice', 'min_price', 'lowestSalePrice', 'lowest_sale_price', 'lowestPrice', 'lowest_price',
      'floorPrice', 'floor_price', 'lowPrice', 'low_price'
    ], 0)))) || 0,
    unitPrice,
    costPrice: Number(first(item, [
      'costPrice', 'cost_price', 'purchasePrice', 'purchase_price',
      'importPrice', 'import_price', 'cost', 'settlementPrice', 'settlement_price'
    ], first(priceInfo, [
      'costPrice', 'cost_price', 'purchasePrice', 'purchase_price',
      'importPrice', 'import_price', 'cost', 'settlementPrice', 'settlement_price'
    ], first(product, [
      'costPrice', 'cost_price', 'purchasePrice', 'purchase_price',
      'importPrice', 'import_price', 'cost', 'settlementPrice', 'settlement_price'
    ], 0)))) || 0,
    purchasePrice: Number(first(item, [
      'purchasePrice', 'purchase_price', 'originalPickupPrice', 'original_pickup_price',
      'originalInventoryCost', 'original_inventory_cost', 'inboundPrice', 'inbound_price'
    ], 0)) || 0,
    originalInventoryCost: Number(first(item, ['originalInventoryCost', 'original_inventory_cost'], 0)) || 0,
    originalPickupPrice: Number(first(item, ['originalPickupPrice', 'original_pickup_price'], 0)) || 0,
    supplierId: normalizeId(first(item, ['supplierId', 'supplier_id', 'SUPPLIER_ID'])),
    supplierName: text(first(item, ['supplierName', 'supplier_name', 'SUPPLIER_NAME'])),
    isServiceProvider: first(item, ['isServiceProvider', 'is_service_provider', 'IS_SERVICE_PROVIDER'], undefined),
    quantity,
    subtotal,
    originalQuantity,
    returnedQuantity,
    refundableQuantity,
    // MySQL/历史接口通常返回 need_sn；如果只读取 needSn，带 SN 商品的
    // SN 输入框会被误判为不需要 SN，从而在详情页隐藏。
    needSn: item.needSn === true || item.needSn === 1 || item.needSn === '1' || item.needSn === 'true' ||
      item.need_sn === true || item.need_sn === 1 || item.need_sn === '1' || item.need_sn === 'true' ||
      item.needSN === true || item.needSN === 1 || item.needSN === '1' || item.needSN === 'true' ||
      product.needSn === true || product.needSn === 1 || product.needSn === '1' || product.needSn === 'true' ||
      product.need_sn === true || product.need_sn === 1 || product.need_sn === '1' || product.need_sn === 'true',
    inventoryStatus: first(item, ['inventoryStatus', 'inventory_status', 'status'], ''),
    inventoryStatusLabel: first(item, ['inventoryStatusLabel', 'inventory_status_label', 'statusLabel', 'status_label', 'statusText'], ''),
    previousSnStatus: first(item, ['previousSnStatus', 'previous_sn_status', 'previousInventoryStatus', 'previous_inventory_status'], ''),
    imei1: text(first(item, ['imei1', 'imei_1', 'IMEI1'])),
    imei2: text(first(item, ['imei2', 'imei_2', 'IMEI2'])),
    customerSource: text(first(item, ['customerSource', 'customer_source'])),
    customerSourceDetail: text(first(item, ['customerSourceDetail', 'customer_source_detail'])),
    selectedResourceTypes: selectedResourceTypes.map(value => text(value)).filter(Boolean),
    resourceSummary: first(item, ['resourceSummary', 'resource_summary'], null),
    resourceTypes: Array.isArray(item.resourceTypes) ? item.resourceTypes : [],
    resourceRights: Array.isArray(item.resourceRights) ? item.resourceRights : []
  };
}

function isEmptyOrderItem(item = {}) {
  const normalized = normalizeOrderItem(item);
  return !normalized.productId &&
    !normalized.productName &&
    !normalized.pnCode &&
    !normalized.snCode &&
    !normalized.imei1 &&
    !normalized.imei2 &&
    normalized.unitPrice === 0 &&
    normalized.subtotal === 0;
}

module.exports = {
  first,
  normalizeId,
  normalizeMoney,
  normalizeQuantity,
  normalizeStatus,
  normalizeTimestamp,
  normalizeSnCode,
  normalizeOrderItem,
  isEmptyOrderItem
};
