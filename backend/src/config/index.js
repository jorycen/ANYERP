/**
 * 配置文件
 */
module.exports = {
  // 数据库配置
  database: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME || 'any_erp',
    username: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    charset: 'utf8mb4',
    logging: process.env.NODE_ENV === 'development' ? console.log : false
  },

  // JWT配置
  jwt: {
    secret: process.env.JWT_SECRET || 'change-me-in-env',
    expiresIn: '7d' // 7天过期
  },

  // 分页配置
  page: {
    defaultSize: 20,
    maxSize: 100
  }
};
