const db = require('../config/db');
const ApiResponse = require('../utils/ApiResponse');

/**
 * 创建采购单 (PO)
 */
exports.createPurchaseOrder = async (req, res) => {
  const { supplierId, items } = req.body;
  const storeId = req.user.storeId;
  const userId = req.user.userId;

  if (!items || items.length === 0) return ApiResponse.error('Items are required').send(res, 400);

  const poId = `PO-${Date.now()}`;
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();

    let totalAmount = 0;

    // 1. 插入明细并计算总额
    for (const item of items) {
      await connection.execute(
        'INSERT INTO T_PURCHASE_ITEM (PO_ID, PN_CODE, QUANTITY, UNIT_PRICE) VALUES (?, ?, ?, ?)',
        [poId, item.pnCode, item.quantity, item.unitPrice]
      );
      totalAmount += item.quantity * item.unitPrice;
    }

    // 2. 插入主单
    await connection.execute(
      'INSERT INTO T_PURCHASE_ORDER (PO_ID, SUPPLIER_ID, STORE_ID, TOTAL_AMOUNT, STATUS, CREATOR) VALUES (?, ?, ?, ?, 0, ?)',
      [poId, supplierId, storeId, totalAmount, userId]
    );

    await connection.commit();
    return ApiResponse.success({ poId }).send(res, 201);
  } catch (error) {
    await connection.rollback();
    return ApiResponse.error('PO Creation failed', error.message).send(res, 500);
  } finally {
    connection.release();
  }
};

/**
 * 确认入库 (同步增加库存与 SN 池)
 */
exports.receiveOrder = async (req, res) => {
  const { poId, sns } = req.body; // sns 格式: [{pnCode, snCodes: []}]
  const storeId = req.user.storeId;

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // 1. 获取 PO 明细
    const [items] = await connection.execute('SELECT PN_CODE, QUANTITY FROM T_PURCHASE_ITEM WHERE PO_ID = ?', [poId]);
    if (items.length === 0) throw new Error('PO not found or no items');

    for (const item of items) {
      // 2. 更新库存 (T_INVENTORY)
      await connection.execute(
        'INSERT INTO T_INVENTORY (STORE_ID, PN_CODE, QUANTITY) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE QUANTITY = QUANTITY + ?',
        [storeId, item.PN_CODE, item.QUANTITY, item.QUANTITY]
      );

      // 3. 记录日志 (T_STOCK_LOG)
      await connection.execute(
        'INSERT INTO T_STOCK_LOG (STORE_ID, TYPE, ORDER_REF_ID, PN_CODE, QTY_CHANGE) VALUES (?, "PURCHASE", ?, ?, ?)',
        [storeId, poId, item.PN_CODE, item.QUANTITY]
      );

      // 4. 处理 SN 池 (如果有)
      const snData = sns.find(s => s.pnCode === item.PN_CODE);
      if (snData && snData.snCodes) {
        for (const sn of snData.snCodes) {
          await connection.execute(
            'INSERT INTO T_SN_POOL (SN_CODE, PN_CODE, STATUS, STORE_ID, IN_TIME) VALUES (?, ?, 1, ?, CURRENT_TIMESTAMP)',
            [sn, item.PN_CODE, storeId]
          );
        }
      }
    }

    // 5. 更新单据状态为已收 (1)
    await connection.execute('UPDATE T_PURCHASE_ORDER SET STATUS = 1 WHERE PO_ID = ?', [poId]);

    await connection.commit();
    return ApiResponse.success(null, 'PO Received and Stock Updated').send(res);
  } catch (error) {
    await connection.rollback();
    return ApiResponse.error('Receive failed', error.message).send(res, 500);
  } finally {
    connection.release();
  }
};
