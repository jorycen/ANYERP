// 客户管理云函数 - MySQL 连接已禁用，使用本地数据或云开发数据库
const cloud = require('wx-server-sdk');
// const mysql = require('mysql2/promise');

cloud.init({
    env: cloud.DYNAMIC_CURRENT_ENV,
});

// 旧 MySQL 配置已禁用；如需恢复，请通过云函数环境变量注入连接信息。

exports.main = async (event, context) => {
    const { action, data } = event;
    // let connection;
    try {
        // connection = await mysql.createConnection(dbConfig);
        switch (action) {
            case 'saveCustomer':
                // return await saveCustomer(connection, data);
                return { code: 403, message: 'MySQL 连接已禁用，请使用本地数据或云开发数据库' };
            case 'getCustomerByPhone':
                // return await getCustomerByPhone(connection, data);
                return { code: 403, message: 'MySQL 连接已禁用，请使用本地数据或云开发数据库' };
            case 'queryCustomers':
                // return await queryCustomers(connection, data);
                return { code: 403, message: 'MySQL 连接已禁用，请使用本地数据或云开发数据库' };
            default:
                return { code: 400, message: 'Action not supported' };
        }
    } catch (error) {
        console.error('Customer Service Error:', error);
        return { code: 500, message: error.message };
    } finally {
        // if (connection) await connection.end();
    }
};

// async function saveCustomer(connection, data) {
//     const { customerId, distributorId, name, phone, customerType, registerStoreId } = data;

//     // 检查手机号冲突
//     const [existing] = await connection.execute(
//         'SELECT CUSTOMER_ID FROM T_CUSTOMER WHERE PHONE = ? AND DISTRIBUTOR_ID = ?',
//         [phone, distributorId]
//     );

//     if (existing.length > 0 && (!customerId || existing[0].CUSTOMER_ID !== customerId)) {
//         return { code: 409, message: '该手机号已注册为客户' };
//     }

//     if (customerId) {
//         // 更新
//         await connection.execute(
//             `UPDATE T_CUSTOMER SET NAME = ?, PHONE = ?, CUSTOMER_TYPE = ? 
//        WHERE CUSTOMER_ID = ?`,
//             [name, phone, customerType, customerId]
//         );
//         return { code: 200, message: '更新成功' };
//     } else {
//         // 新增
//         const newId = 'C' + Date.now();
//         await connection.execute(
//             `INSERT INTO T_CUSTOMER (CUSTOMER_ID, DISTRIBUTOR_ID, NAME, PHONE, CUSTOMER_TYPE, REGISTER_STORE_ID)
//        VALUES (?, ?, ?, ?, ?, ?)`,
//             [newId, distributorId, name, phone, customerType || 'retail', registerStoreId]
//         );
//         return { code: 200, data: { customerId: newId }, message: '保存成功' };
//     }
// }

// async function getCustomerByPhone(connection, data) {
//     const { phone, distributorId } = data;
//     const [rows] = await connection.execute(
//         'SELECT * FROM T_CUSTOMER WHERE PHONE = ? AND DISTRIBUTOR_ID = ?',
//         [phone, distributorId]
//     );
//     return { code: 200, data: rows[0] || null };
// }

// async function queryCustomers(connection, data) {
//     const { distributorId, keywords } = data;
//     let sql = 'SELECT * FROM T_CUSTOMER WHERE DISTRIBUTOR_ID = ?';
//     const params = [distributorId];

//     if (keywords) {
//         sql += ' AND (NAME LIKE ? OR PHONE LIKE ?)';
//         params.push(`%${keywords}%`, `%${keywords}%`);
//     }

//     sql += ' ORDER BY CREATE_TIME DESC LIMIT 100';
//     const [rows] = await connection.execute(sql, params);
//     return { code: 200, data: rows };
// }
