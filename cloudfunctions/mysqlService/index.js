// MySQL 服务云函数已禁用 - 小程序使用本地数据或云函数查询集合
const cloud = require('wx-server-sdk');
// const db = require('./db');

cloud.init({
    env: cloud.DYNAMIC_CURRENT_ENV,
});

/**
 * mysqlService 云函数入口 - 已禁用
 * 用于执行通用的 SQL 查询（建议仅内部或管理端使用）
 */
exports.main = async (event, context) => {
    // const { action, sql, params } = event;

    // try {
    //     switch (action) {
    //         case 'query':
    //             const rows = await db.query(sql, params);
    //             return {
    //                 code: 200,
    //                 data: rows,
    //                 message: 'success'
    //             };
    //         default:
    //             return {
    //                 code: 400,
    //                 message: 'Action not supported'
    //             };
    //     }
    // } catch (error) {
    //     console.error('Cloud Function Error:', error);
    //     return {
    //         code: 500,
    //         message: error.message,
    //         error: error
    //     };
    // }

    return {
        code: 403,
        message: 'MySQL 服务已禁用，请使用本地数据或云开发数据库'
    };
};
