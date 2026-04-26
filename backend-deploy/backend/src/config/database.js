/**
 * Sequelize 数据库连接配置
 */
const { Sequelize } = require('sequelize');
const config = require('./index');

const sequelize = new Sequelize(
  config.database.database,
  config.database.username,
  config.database.password,
  {
    host: config.database.host,
    port: config.database.port,
    dialect: 'mysql',
    charset: config.database.charset,
    logging: config.database.logging,
    timezone: '+08:00', // 东八区
    define: {
      timestamps: true,
      createdAt: 'create_time',
      updatedAt: 'update_time',
      underscored: false
    }
  }
);

// 测试连接
async function testConnection() {
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功');
    return true;
  } catch (error) {
    console.error('数据库连接失败:', error.message);
    return false;
  }
}

module.exports = { sequelize, testConnection };
