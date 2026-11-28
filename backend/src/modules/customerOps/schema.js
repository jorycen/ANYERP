const { sequelize } = require('../../config/database');
const M = require('./models');
const { migrate, columns } = require('../../../scripts/migrate-reward-fulfillment');

async function ensureRewardFulfillmentSchema() {
  const tables = await sequelize.getQueryInterface().showAllTables();
  const required = [M.Reward.tableName, M.Redemption.tableName];
  if (!required.some(name => tables.includes(name))) {
    if (process.env.CUSTOMER_OPS_ENABLED === 'true') throw new Error('客户运营基础表缺失，请先执行客户运营基础迁移');
    return { installed: false };
  }
  if (!required.every(name => tables.includes(name))) throw new Error('客户运营基础结构不完整，请先执行客户运营基础迁移');
  // Startup readiness must wait for the same additive migration used by operators.
  await migrate(true);
  const qi = sequelize.getQueryInterface().queryGenerator;
  for (const [name, fields] of Object.entries(columns)) {
    const model = M[name];
    await sequelize.query(`SELECT ${fields.map(field => qi.quoteIdentifier(field)).join(', ')} FROM ${qi.quoteTable(model.tableName)} LIMIT 0`);
  }
  await sequelize.query('SELECT inventory_id, status, expires_at FROM T_REWARD_STOCK_RESERVATION LIMIT 0');
  const [triggers] = await sequelize.query("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME IN ('reward_stock_hold_update','reward_stock_hold_delete')");
  if (triggers.length !== 2) throw new Error('会员礼品库存保护规则尚未就绪');
  return { installed: true };
}

module.exports = { ensureRewardFulfillmentSchema };
