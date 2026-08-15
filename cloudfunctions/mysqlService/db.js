// MySQL 连接已禁用 - 小程序使用本地数据或云函数查询集合
// const mysql = require('mysql2/promise');

// 如需恢复数据库连接，请仅通过云函数环境变量注入配置。

// let pool;

// async function getPool() {
//     if (!pool) {
//         pool = mysql.createPool(config);
//     }
//     return pool;
// }

/**
 * 执行 SQL 查询 - 已禁用
 */
async function query(sql, params = []) {
    // const p = await getPool();
    // try {
    //     const [rows] = await p.execute(sql, params);
    //     return rows;
    // } catch (error) {
    //     console.error('MySQL Query Error:', error);
    //     throw error;
    // }
    throw new Error('MySQL 查询已禁用，请使用本地数据或云开发数据库');
}

/**
 * 执行事务 - 已禁用
 * @param {Function} callback (connection) => Promise
 */
async function transaction(callback) {
    // const p = await getPool();
    // const connection = await p.getConnection();
    // await connection.beginTransaction();
    // try {
    //     const result = await callback(connection);
    //     await connection.commit();
    //     return result;
    // } catch (error) {
    //     await connection.rollback();
    //     throw error;
    // } finally {
    //     connection.release();
    // }
    throw new Error('MySQL 事务已禁用，请使用本地数据或云开发数据库');
}

module.exports = {
    query,
    transaction,
    // getPool
};
