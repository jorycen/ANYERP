const mysql = require('mysql2');
const dotenv = require('dotenv');

dotenv.config();

const pool = mysql.createPool({
  // 微信云托管会自动注入 MYSQL_ADDRESS, MYSQL_USERNAME, MYSQL_PASSWORD, MYSQL_DATABASE
  host: process.env.MYSQL_ADDRESS || process.env.DB_HOST || 'localhost',
  user: process.env.MYSQL_USERNAME || process.env.DB_USER || 'root',
  password: process.env.MYSQL_PASSWORD || process.env.DB_PASS || '',
  database: process.env.MYSQL_DATABASE || process.env.DB_NAME || 'ainuoyun_erp',
  port: process.env.MYSQL_PORT || process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
});

// 使用 promise 版本的 pool
const db = pool.promise();

// 测试连接
db.getConnection()
  .then(connection => {
    console.log('✅ MySQL Database Connected Successfully');
    connection.release();
  })
  .catch(err => {
    console.error('❌ Database Connection Failed:', err.message);
  });

module.exports = db;
