// 订单处理云函数 - MySQL 连接已禁用，使用本地数据或云开发数据库
const cloud = require('wx-server-sdk');
// const mysql = require('mysql2/promise');

cloud.init({
    env: cloud.DYNAMIC_CURRENT_ENV,
});

// 旧数据库配置已禁用；如需恢复，请通过云函数环境变量注入连接信息。

/**
 * 订单处理云函数 - 已禁用
 */
exports.main = async (event, context) => {
    const { action, data } = event;

    // let pool;
    try {
        // pool = mysql.createPool(dbConfig);

        switch (action) {
            case 'createOrder':
                // return await createOrder(pool, data);
                return { code: 403, message: 'MySQL 连接已禁用，请使用本地数据或云开发数据库' };
            case 'getOrderDetails':
                // return await getOrderDetails(pool, data);
                return { code: 403, message: 'MySQL 连接已禁用，请使用本地数据或云开发数据库' };
            case 'queryOrders':
                // return await queryOrders(pool, data);
                return { code: 403, message: 'MySQL 连接已禁用，请使用本地数据或云开发数据库' };
            default:
                return { code: 400, message: 'Unsupported action' };
        }
    } catch (error) {
        console.error('Order Service Error:', error);
        return { code: 500, message: error.message };
    } finally {
        // if (pool) await pool.end();
    }
};

/**
 * 核心：创建订单（带事务）- 已禁用
 */
// async function createOrder(pool, data) {
//     const {
//         orderNo,
//         storeId,
//         storeName,
//         createUser,
//         customerId,
//         customerName,
//         customerPhone,
//         totalAmount,
//         discountAmount,
//         actualPayment,
//         items, // Array of { inventoryId, salePrice, quantity, productName, pnCode }
//         payments // Array of { methodId, amount }
//     } = data;

//     const connection = await pool.getConnection();
//     await connection.beginTransaction();

//     try {
//         // 1. 检查所有 SN 是否仍处于"在库"状态
//         for (const item of items) {
//             const [inv] = await connection.execute(
//                 'SELECT STATUS FROM T_INVENTORY_SN WHERE INVENTORY_ID = ? FOR UPDATE',
//                 [item.inventoryId]
//             );
//             if (inv.length === 0 || inv[0].STATUS !== 1) {
//                 throw new Error(`库存异常：商品 ${item.productName || item.inventoryId} 可能已被售出或不存在`);
//             }
//         }

//         // 2. 插入订单主表
//         const orderId = orderNo; // 使用业务单号作为主键或生成UUID
//         await connection.execute(
//             `INSERT INTO T_ORDER (
//         ORDER_ID, ORDER_NO, STORE_ID, STORE_NAME, CREATE_USER, 
//         CUSTOMER_ID, CUSTOMER_NAME, CUSTOMER_PHONE, 
//         TOTAL_AMOUNT, DISCOUNT_AMOUNT, ACTUAL_PAYMENT, ORDER_STATUS
//       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '已完成')`,
//             [orderId, orderNo, storeId, storeName, createUser, customerId, customerName, customerPhone, totalAmount, discountAmount, actualPayment]
//         );

//         // 3. 插入订单明细并更新库存状态
//         for (const item of items) {
//             // 插入明细
//             await connection.execute(
//                 `INSERT INTO T_ORDER_ITEM (
//           ORDER_ID, INVENTORY_ID, PRODUCT_NAME, PN_CODE, SALE_PRICE, QUANTITY, SUBTOTAL
//         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
//                 [orderId, item.inventoryId, item.productName, item.pnCode, item.salePrice, item.quantity, item.salePrice * item.quantity]
//             );

//             // 更新库存状态为"已销售"(2)
//             await connection.execute(
//                 'UPDATE T_INVENTORY_SN SET STATUS = 2 WHERE INVENTORY_ID = ?',
//                 [item.inventoryId]
//             );
//         }

//         // 4. 记录支付流水
//         if (payments && payments.length > 0) {
//             for (const pay of payments) {
//                 await connection.execute(
//                     'INSERT INTO T_ORDER_PAYMENT (ORDER_ID, PAYMENT_METHOD_ID, AMOUNT) VALUES (?, ?, ?)',
//                     [orderId, pay.methodId, pay.amount]
//                 );
//             }
//         }

//         await connection.commit();
//         return { code: 200, message: '订单创建成功', data: { orderId } };

//     } catch (error) {
//         await connection.rollback();
//         console.error('Create Order Transaction Rollback:', error);
//         return { code: 500, message: '开单失败: ' + error.message };
//     } finally {
//         connection.release();
//     }
// }

// async function getOrderDetails(pool, data) {
//     const { orderId } = data;
//     const [order] = await pool.execute('SELECT * FROM T_ORDER WHERE ORDER_ID = ?', [orderId]);
//     if (order.length === 0) return { code: 404, message: '未找到订单' };

//     const [items] = await pool.execute('SELECT * FROM T_ORDER_ITEM WHERE ORDER_ID = ?', [orderId]);
//     const [payments] = await pool.execute('SELECT * FROM T_ORDER_PAYMENT WHERE ORDER_ID = ?', [orderId]);

//     return {
//         code: 200,
//         data: {
//             ...order[0],
//             items,
//             payments
//         }
//     };
// }

// async function queryOrders(pool, data) {
//     const { storeId, startDate, endDate, phone } = data;
//     let sql = 'SELECT * FROM T_ORDER WHERE 1=1';
//     const params = [];

//     if (storeId) {
//         sql += ' AND STORE_ID = ?';
//         params.push(storeId);
//     }
//     if (startDate) {
//         sql += ' AND CREATE_TIME >= ?';
//         params.push(startDate);
//     }
//     if (endDate) {
//         sql += ' AND CREATE_TIME <= ?';
//         params.push(endDate);
//     }
//     if (phone) {
//         sql += ' AND CUSTOMER_PHONE = ?';
//         params.push(phone);
//     }

//     sql += ' ORDER BY CREATE_TIME DESC LIMIT 100';
//     const [rows] = await pool.execute(sql, params);
//     return { code: 200, data: rows };
// }
