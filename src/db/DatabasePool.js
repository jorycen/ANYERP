const mysql = require('mysql2/promise');

class DatabasePool {
    constructor() {
        if (!DatabasePool.instance) {
            this.pool = null;
            DatabasePool.instance = this;
        }
        return DatabasePool.instance;
    }

    /**
     * 初始化数据库连接池
     * @param {Object} config 数据库配置对象
     */
    init(config) {
        if (!this.pool) {
            this.pool = mysql.createPool({
                host: config.host || 'localhost',
                port: config.port || 3306,
                user: config.user || 'root',
                password: config.password || '',
                database: config.database || 'lenovo_smart_mgmt',
                waitForConnections: true,
                connectionLimit: config.connectionLimit || 10,
                queueLimit: 0,
                enableKeepAlive: true,
                keepAliveInitialDelay: 0,
                ...config
            });
            console.log('✅ MySQL Connection Pool Initialized.');
        }
    }

    /**
     * 获取连接池实例（可用于事务或直接查询）
     * @returns {mysql.Pool}
     */
    getPool() {
        if (!this.pool) {
            throw new Error('Database pool has not been initialized. Call init() first.');
        }
        return this.pool;
    }

    /**
     * 快捷查询方法封装
     * @param {string} sql SQL 语句
     * @param {Array} params 参数
     * @returns {Promise<any>}
     */
    async query(sql, params = []) {
        const pool = this.getPool();
        try {
            const [rows, fields] = await pool.execute(sql, params);
            return rows;
        } catch (error) {
            console.error('❌ Database Query Error:', error.message);
            console.error('SQL:', sql);
            console.error('Params:', params);
            throw error;
        }
    }

    /**
     * 关闭连接池
     */
    async close() {
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
            console.log('🛑 MySQL Connection Pool Closed.');
        }
    }
}

const instance = new DatabasePool();

module.exports = instance;
