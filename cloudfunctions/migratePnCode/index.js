const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function first(source, keys, fallback = '') {
  for (const key of keys) {
    if (source && source[key] !== undefined && source[key] !== null && String(source[key]).trim() !== '') {
      return source[key];
    }
  }
  return fallback;
}

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function normalizeItem(record = {}) {
  const next = Object.assign({}, record);
  const fields = {
    itemId: ['itemId', 'item_id', 'ITEM_ID', 'orderItemId', 'order_item_id', '_id', 'id'],
    productId: ['productId', 'product_id', 'PRODUCT_ID'],
    inventoryId: ['inventoryId', 'inventory_id', 'INVENTORY_ID', 'inventorySnId', 'inventory_sn_id', 'snId', 'sn_id'],
    pnCode: ['pnCode', 'pn_code', 'PN_CODE', 'pn', 'PN'],
    snCode: ['snCode', 'sn_code', 'SN_CODE', 'sn', 'SN', 'serialNo', 'serial_no', 'productSn', 'product_sn'],
    productName: ['productName', 'product_name', 'PRODUCT_NAME', 'NAME', 'name'],
    unitPrice: ['unitPrice', 'unit_price', 'salePrice', 'sale_price', 'PRICE', 'price'],
    quantity: ['quantity', 'QUANTITY'],
    subtotal: ['subtotal', 'SUBTOTAL'],
    mtmCode: ['mtmCode', 'mtm_code', 'MTM_CODE'],
    needSn: ['needSn', 'need_sn', 'NEED_SN'],
    previousSnStatus: ['previousSnStatus', 'previous_sn_status', 'previousInventoryStatus', 'previous_inventory_status'],
    inventoryStatus: ['inventoryStatus', 'inventory_status', 'STATUS', 'status'],
    imei1: ['imei1', 'imei_1', 'IMEI1'],
    imei2: ['imei2', 'imei_2', 'IMEI2'],
    customerSource: ['customerSource', 'customer_source'],
    customerSourceDetail: ['customerSourceDetail', 'customer_source_detail']
  };

  const values = {};
  Object.keys(fields).forEach(key => { values[key] = first(record, fields[key]); });
  values.itemId = text(values.itemId);
  values.productId = text(values.productId);
  values.inventoryId = text(values.inventoryId);
  values.pnCode = text(values.pnCode).toUpperCase();
  values.snCode = text(values.snCode).toUpperCase();
  values.productName = text(values.productName);
  values.unitPrice = money(values.unitPrice);
  values.quantity = Number(values.quantity) > 0 ? Number(values.quantity) : 1;
  values.subtotal = values.subtotal === '' ? money(values.unitPrice * values.quantity) : money(values.subtotal);
  values.needSn = values.needSn === true || values.needSn === 1 || values.needSn === '1' || values.needSn === 'true';
  values.imei1 = text(values.imei1);
  values.imei2 = text(values.imei2);
  values.customerSource = text(values.customerSource);
  values.customerSourceDetail = text(values.customerSourceDetail);

  Object.keys(fields).forEach(key => {
    fields[key].forEach(alias => {
      if (alias !== key) delete next[alias];
    });
  });
  Object.keys(values).forEach(key => {
    if (values[key] !== '' && values[key] !== undefined) next[key] = values[key];
  });
  return next;
}

function normalizeRecord(record = {}) {
  const next = normalizeItem(record);
  const aliases = {
    orderNo: ['orderNo', 'order_no', 'ORDER_NO'],
    orderId: ['orderId', 'order_id', 'ORDER_ID', '_id'],
    storeId: ['storeId', 'store_id', 'STORE_ID'],
    createUser: ['createUser', 'create_user'],
    createTime: ['createTime', 'create_time', 'createdAt', 'created_at'],
    updateTime: ['updateTime', 'update_time', 'updatedAt', 'updated_at'],
    totalAmount: ['totalAmount', 'total_amount'],
    actualAmount: ['actualAmount', 'actual_amount', 'actualPayment', 'actual_payment'],
    discount: ['discount', 'discountAmount', 'discount_amount'],
    status: ['status', 'orderStatus', 'order_status']
  };
  Object.keys(aliases).forEach(key => {
    const value = first(record, aliases[key]);
    aliases[key].forEach(alias => { if (alias !== key) delete next[alias]; });
    if (value !== '') next[key] = ['totalAmount', 'actualAmount', 'discount'].includes(key) ? money(value) : text(value);
  });
  if (Array.isArray(record.items)) next.items = record.items.map(normalizeItem);
  if (Array.isArray(record.goods)) next.goods = record.goods.map(normalizeItem);
  return next;
}

async function getAll(collectionName) {
  const rows = [];
  let offset = 0;
  const pageSize = 100;
  while (true) {
    const result = await db.collection(collectionName).skip(offset).limit(pageSize).get();
    const page = result.data || [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
    offset += page.length;
  }
}

async function migrateCollection(collectionName, transform, dryRun) {
  const rows = await getAll(collectionName);
  let changed = 0;
  for (const row of rows) {
    const next = transform(row);
    if (JSON.stringify(next) === JSON.stringify(row)) continue;
    changed += 1;
    if (!dryRun) {
      const updateData = Object.assign({}, next);
      delete updateData._id;
      await db.collection(collectionName).doc(row._id).update({ data: updateData });
    }
  }
  return { scanned: rows.length, changed };
}

exports.main = async (event = {}) => {
  const dryRun = event.dryRun !== false;
  const goods = await migrateCollection('goods', normalizeRecord, dryRun);
  const orders = await migrateCollection('orders', normalizeRecord, dryRun);
  return {
    code: 0,
    dryRun,
    message: dryRun ? '预览完成，未写入数据' : '订单、商品及库存字段规范化完成',
    data: { goods, orders }
  };
};
