/**
 * 配置文件
 */
module.exports = {
  // 数据库配置
  database: {
    host: process.env.DB_HOST || 'sh-cynosdbmysql-grp-lpycb6gi.sql.tencentcdb.com',
    port: process.env.DB_PORT || 29244,
    database: process.env.DB_NAME || 'cloud1-8glwjlnq4c74f7f1',
    username: process.env.DB_USER || 'ainuoyun',
    password: process.env.DB_PASSWORD || 'lx123456.',
    charset: 'utf8mb4',
    logging: process.env.NODE_ENV === 'development' ? console.log : false
  },

  // JWT配置
  jwt: {
    secret: process.env.JWT_SECRET || 'any-erp-secret-key-2024',
    expiresIn: '7d' // 7天过期
  },

  // 分页配置
  page: {
    defaultSize: 20,
    maxSize: 100
  }
};
