const db = require('../config/db');
const ApiResponse = require('../utils/ApiResponse');
const OrderService = require('../services/orderService');

/**
 * 创建订单
 */
exports.createOrder = async (req, res) => {
  const { customerName, customerPhone, customerSource, items } = req.body;
  const storeId = req.user.storeId;
  const userId = req.user.userId;

  if (!items || items.length === 0) {
    return ApiResponse.error('Order items are required').send(res, 400);
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // 1. 计算补贴与总额
    const summary = OrderService.summaryOrder(items);
    const orderId = `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    // 2. 插入 T_ORDER 主表
    await connection.execute(
      `INSERT INTO T_ORDER (ORDER_ID, STORE_ID, SALES_PERSON_ID, CUSTOMER_NAME, CUSTOMER_PHONE, CUSTOMER_SOURCE, TOTAL_AMOUNT, SUBSIDY_AMOUNT, FINAL_AMOUNT, STATUS) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [orderId, storeId, userId, customerName, customerPhone, customerSource, summary.totalAmount, summary.subsidyAmount, summary.finalAmount]
    );

    // 3. 循环处理明细、库存与 SN
    for (const item of items) {
      // 记录明细
      await connection.execute(
        'INSERT INTO T_ORDER_ITEM (ORDER_ID, PN_CODE, SN_CODE, SELL_PRICE, SUBSIDY_VAL) VALUES (?, ?, ?, ?, ?)',
        [orderId, item.pnCode, item.snCode, item.price, item.subsidyVal]
      );

      // 更新 SN 状态为“已售 (2)”并关联订单
      const [updateSN] = await connection.execute(
        'UPDATE T_SN_POOL SET STATUS = 2, ORDER_ID = ?, OUT_TIME = CURRENT_TIMESTAMP WHERE SN_CODE = ? AND STORE_ID = ? AND STATUS = 1',
        [orderId, item.snCode, storeId]
      );

      if (updateSN.affectedRows === 0) {
        throw new Error(`SN ${item.snCode} is not available in stock`);
      }

      // 更新库存扣减
      await connection.execute(
        'UPDATE T_INVENTORY SET QUANTITY = QUANTITY - 1 WHERE STORE_ID = ? AND PN_CODE = ?',
        [storeId, item.pnCode]
      );

      // 自动记录库存出库日志
      await connection.execute(
        'INSERT INTO T_STOCK_LOG (STORE_ID, TYPE, ORDER_REF_ID, PN_CODE, QTY_CHANGE, REMARK) VALUES (?, "SALES", ?, ?, -1, ?)',
        [storeId, orderId, item.pnCode, `Order Sale ${orderId}`]
      );
      
      // 自动生成业绩分成记录 (T_ORDER_SHARE) - 初步方案：全额归属销售员
      await connection.execute(
        'INSERT INTO T_ORDER_SHARE (ORDER_ID, USER_ID, SHARE_AMOUNT, SHARE_TYPE) VALUES (?, ?, ?, "MAIN")',
        [orderId, userId, 0] // 提成计算后期可异步或批量处理
      );
    }

    await connection.commit();
    return ApiResponse.success({ orderId }, 'Order created successfully').send(res);
  } catch (error) {
    await connection.rollback();
    console.error('Order Create Error:', error);
    return ApiResponse.error('Order creation failed: ' + error.message).send(res, 500);
  } finally {
    connection.release();
  }
};

/**
 * 获取订单列表
 */
exports.getOrders = async (req, res) => {
  const storeId = req.user.storeId;
  const role = req.user.role;
  const userId = req.user.userId;

  try {
    let query = 'SELECT * FROM T_ORDER WHERE STORE_ID = ?';
    let params = [storeId];

    // 非经理只能看自己的订单
    if (role === 'SALES') {
      query += ' AND SALES_PERSON_ID = ?';
      params.push(userId);
    }

    query += ' ORDER BY CREATE_TIME DESC';
    const [orders] = await db.execute(query, params);

    return ApiResponse.success(orders).send(res);
  } catch (error) {
    return ApiResponse.error('Error fetching orders', error.message).send(res, 500);
  }
};

/**
 * 上传订单合规照片
 */
exports.uploadOrderPhoto = async (req, res) => {
  const { orderId, photoType, photoUrl } = req.body;
  if (!orderId || !photoType || !photoUrl) {
    return ApiResponse.error('orderId, photoType, and photoUrl are required').send(res, 400);
  }

  try {
    await db.execute(
      'INSERT INTO T_ORDER_PHOTO (ORDER_ID, PHOTO_TYPE, PHOTO_URL) VALUES (?, ?, ?)',
      [orderId, photoType, photoUrl]
    );
    return ApiResponse.success(null, 'Photo uploaded successfully').send(res);
  } catch (error) {
    return ApiResponse.error('Error saving photo reference', error.message).send(res, 500);
  }
};
