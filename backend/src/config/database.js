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
    dialectOptions: {
      charset: 'utf8mb4'
    }
  }
);

module.exports = {
  sequelize,
  Sequelize
};
