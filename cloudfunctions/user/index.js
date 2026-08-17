// 用户管理云函数 - MySQL 连接已禁用，使用本地数据或云开发数据库
const cloud = require('wx-server-sdk');
// const mysql = require('mysql2/promise');

cloud.init({
    env: cloud.DYNAMIC_CURRENT_ENV,
});

// 旧数据库配置已禁用；如需恢复，请通过云函数环境变量注入连接信息。

/**
 * user 云函数入口 - 已禁用
 */
exports.main = async (event, context) => {
    const { action, phoneNumber, password } = event;
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID;

    // let connection;
    try {
        // connection = await mysql.createConnection(dbConfig);

        switch (action) {
            case 'login':
                // // 1. 根据手机号查询员工信息
                // const [users] = await connection.execute(
                //     'SELECT * FROM T_STAFF WHERE PHONE = ? AND IS_DELETED = 0',
                //     [phoneNumber]
                // );

                // if (users.length === 0) {
                //     return { code: 404, message: '该手机号未授权，请联系管理员' };
                // }

                // const user = users[0];

                // // 2. 如果之前没绑定过 OpenID，或者权限变了，可以进行静默更新（可选）
                // // 这里简单返回用户信息
                // return {
                //     code: 200,
                //     data: {
                //         staffId: user.STAFF_ID,
                //         name: user.NAME,
                //         phone: user.PHONE,
                //         role: user.ROLE,
                //         distributorId: user.DISTRIBUTOR_ID,
                //         storeId: user.STORE_ID
                //     },
                //     message: '登录成功'
                // };
                return { code: 403, message: 'MySQL 连接已禁用，请使用本地数据或云开发数据库' };

            case 'getProfile':
                // // 根据 OpenID 或者手机号获取当前详细信息
                // const [profiles] = await connection.execute(
                //     'SELECT s.*, st.NAME as STORE_NAME FROM T_STAFF s LEFT JOIN T_STORE st ON s.STORE_ID = st.STORE_ID WHERE s.PHONE = ? AND s.IS_DELETED = 0',
                //     [phoneNumber]
                // );
                // return {
                //     code: 200,
                //     data: profiles[0] || null
                // };
                return { code: 403, message: 'MySQL 连接已禁用，请使用本地数据或云开发数据库' };

            default:
                return { code: 400, message: 'Unsupported action' };
        }
    } catch (error) {
        console.error('User Service Error:', error);
        return { code: 500, message: error.message };
    } finally {
        // if (connection) await connection.end();
    }
};
