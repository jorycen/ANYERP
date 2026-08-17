const cloud = require('wx-server-sdk');
const mysql = require('mysql2/promise');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

let pool;

function getConfig() {
  const env = process.env;
  return {
    host: env.MYSQL_HOST || env.DB_HOST,
    port: Number(env.MYSQL_PORT || env.DB_PORT || 3306),
    user: env.MYSQL_USER || env.DB_USER,
    password: env.MYSQL_PASSWORD || env.DB_PASSWORD,
    database: env.MYSQL_DATABASE || env.DB_DATABASE || env.MYSQL_DB || env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 2,
    queueLimit: 0
  };
}

function assertConfig(config) {
  const missing = [];
  ['host', 'user', 'password', 'database'].forEach(key => {
    if (!config[key]) missing.push(key);
  });
  if (missing.length) {
    throw new Error('Missing MySQL env config: ' + missing.join(', '));
  }
}

async function getPool() {
  if (!pool) {
    const config = getConfig();
    assertConfig(config);
    pool = mysql.createPool(config);
  }
  return pool;
}

function firstValue(source, keys) {
  for (const key of keys) {
    const value = source && source[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
}

function normalizeItem(item) {
  const itemId = firstValue(item, ['itemId', 'item_id', 'ITEM_ID', 'orderItemId', 'order_item_id', '_id', 'id']);
  const inventoryId = firstValue(item, ['inventoryId', 'inventory_id', 'INVENTORY_ID', 'snId', 'sn_id', 'SN_ID', 'inventorySnId', 'inventory_sn_id']);
  const snCode = firstValue(item, ['snCode', 'sn_code', 'SN_CODE', 'sn', 'SN', 'serialNo', 'serial_no', 'productSn', 'product_sn']).toUpperCase();
  return {
    itemId,
    inventoryId,
    snCode,
    imei1: firstValue(item, ['imei1', 'imei_1', 'IMEI1']),
    imei2: firstValue(item, ['imei2', 'imei_2', 'IMEI2'])
  };
}

async function getOrderId(connection, data) {
  const orderId = firstValue(data, ['orderId', 'order_id', 'ORDER_ID']);
  if (orderId) return orderId;

  const orderNo = firstValue(data, ['orderNo', 'order_no', 'ORDER_NO']);
  if (!orderNo) throw new Error('orderNo/orderId is required');

  const [rows] = await connection.execute(
    'SELECT ORDER_ID FROM T_ORDER WHERE ORDER_NO = ? LIMIT 1',
    [orderNo]
  );
  if (!rows.length) throw new Error('订单不存在: ' + orderNo);
  return rows[0].ORDER_ID || rows[0].order_id || rows[0].ORDER_id;
}

async function updateItems(data) {
  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) throw new Error('items is required');

  const p = await getPool();
  const connection = await p.getConnection();
  await connection.beginTransaction();

  try {
    const orderId = await getOrderId(connection, data);
    const results = [];

    for (const rawItem of items) {
      const item = normalizeItem(rawItem);
      if (!item.itemId) throw new Error('itemId is required');

      const [result] = await connection.execute(
        `UPDATE T_ORDER_ITEM
         SET INVENTORY_ID = COALESCE(NULLIF(?, ''), INVENTORY_ID),
             SN_CODE = COALESCE(NULLIF(?, ''), SN_CODE),
             IMEI1 = COALESCE(NULLIF(?, ''), IMEI1),
             IMEI2 = COALESCE(NULLIF(?, ''), IMEI2)
         WHERE ITEM_ID = ? AND ORDER_ID = ?`,
        [
          item.inventoryId,
          item.snCode,
          item.imei1,
          item.imei2,
          item.itemId,
          orderId
        ]
      );

      results.push({
        itemId: item.itemId,
        affectedRows: result.affectedRows,
        inventoryId: item.inventoryId,
        snCode: item.snCode,
        imei1: item.imei1,
        imei2: item.imei2
      });
    }

    await connection.commit();
    return {
      code: 0,
      data: {
        orderId,
        results
      }
    };
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

exports.main = async (event = {}) => {
  try {
    const action = event.action || 'updateOrderItems';
    const data = event.data || event;
    if (action !== 'updateOrderItems') {
      return { code: 400, message: 'Unsupported action: ' + action };
    }
    return await updateItems(data);
  } catch (err) {
    console.error('orderItemRepair failed:', err);
    return {
      code: 500,
      message: err.message || String(err)
    };
  }
};
