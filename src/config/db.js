const mysql = require('mysql2');
const dotenv = require('dotenv');

dotenv.config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'ainuoyun_erp',
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
