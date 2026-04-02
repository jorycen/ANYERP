const db = require('../config/db');
const ApiResponse = require('../utils/ApiResponse');

/**
 * 根据 PN 码查询基础商品信息
 */
exports.getProductByPN = async (req, res) => {
  const { pn } = req.params;
  try {
    const [products] = await db.execute(
      'SELECT PN_CODE, PRODUCT_NAME, CATEGORY_ID, BASE_PRICE FROM T_PRODUCT WHERE PN_CODE = ? AND DELETE_FLAG = b\'0\'',
      [pn]
    );

    if (products.length === 0) {
      return ApiResponse.error('Product not found').send(res, 404);
    }

    return ApiResponse.success(products[0]).send(res);
  } catch (error) {
    return ApiResponse.error('Error fetching product', error.message).send(res, 500);
  }
};

/**
 * 校验序列号 (SN) 状态
 */
exports.checkSNStatus = async (req, res) => {
  const { sn } = req.params;
  try {
    const [snDetails] = await db.execute(
      'SELECT SN_CODE, PN_CODE, STATUS, STORE_ID FROM T_SN_POOL WHERE SN_CODE = ?',
      [sn]
    );

    if (snDetails.length === 0) {
      return ApiResponse.error('SN not found in system pool').send(res, 404);
    }

    return ApiResponse.success(snDetails[0]).send(res);
  } catch (error) {
    return ApiResponse.error('Error checking SN status', error.message).send(res, 500);
  }
};

/**
 * 获取当前门店库存列表
 */
exports.getStoreInventory = async (req, res) => {
  const storeId = req.user.storeId;
  try {
    const [inventory] = await db.execute(
      `SELECT i.PN_CODE, p.PRODUCT_NAME, i.QUANTITY, i.LOW_STOCK_THRESHOLD 
       FROM T_INVENTORY i 
       JOIN T_PRODUCT p ON i.PN_CODE = p.PN_CODE 
       WHERE i.STORE_ID = ?`,
      [storeId]
    );

    return ApiResponse.success(inventory).send(res);
  } catch (error) {
    return ApiResponse.error('Error fetching inventory', error.message).send(res, 500);
  }
};

/**
 * 采购入库 (简单逻辑：增加库存并记录日志)
 */
exports.stockIn = async (req, res) => {
  const { pn, quantity, sns } = req.body; // sns 为序列号数组
  const storeId = req.user.storeId;
  const userId = req.user.userId;

  if (!pn || !quantity) {
    return ApiResponse.error('PN and quantity are required').send(res, 400);
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // 1. 更新 T_INVENTORY (增加数量)
    await connection.execute(
      `INSERT INTO T_INVENTORY (STORE_ID, PN_CODE, QUANTITY) 
       VALUES (?, ?, ?) 
       ON DUPLICATE KEY UPDATE QUANTITY = QUANTITY + ?`,
      [storeId, pn, quantity, quantity]
    );

    // 2. 插入 T_STOCK_LOG
    await connection.execute(
      'INSERT INTO T_STOCK_LOG (STORE_ID, TYPE, PN_CODE, QTY_CHANGE, REMARK) VALUES (?, "PURCHASE", ?, ?, ?)',
      [storeId, pn, quantity, `Manual Stock In by user ${userId}`]
    );

    // 3. 处理序列号池 (如果有)
    if (sns && Array.isArray(sns)) {
      for (const sn of sns) {
        await connection.execute(
          'INSERT INTO T_SN_POOL (SN_CODE, PN_CODE, STATUS, STORE_ID, IN_TIME) VALUES (?, ?, 1, ?, CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE STATUS = 1, STORE_ID = ?',
          [sn, pn, storeId, storeId]
        );
      }
    }

    await connection.commit();
    return ApiResponse.success(null, 'Stock In successful').send(res);
  } catch (error) {
    await connection.rollback();
    return ApiResponse.error('Stock In failed', error.message).send(res, 500);
  } finally {
    connection.release();
  }
};
