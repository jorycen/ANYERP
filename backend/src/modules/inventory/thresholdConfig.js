const { sequelize } = require('../../models');
const { QueryTypes } = require('sequelize');

const FIELDS = ['turnoverDays', 'coverageDays', 'staleAgeDays', 'slowMovingQuantity', 'slowMovingRate'];

function roles(user) {
  return Array.isArray(user?.roles) ? user.roles.map(String).map(v => v.toLowerCase()) : String(user?.roleCode || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
}

function normalizeNumber(value, key) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 999999) throw Object.assign(new Error(`${key} 必须是0至999999的数字`), { status: 400 });
  return Number(number.toFixed(4));
}

function assertAdmin(user) {
  if (!roles(user).some(role => ['admin', 'boss'].includes(role))) throw Object.assign(new Error('仅admin或boss可配置库存阈值'), { status: 403 });
}

async function list(ctx) {
  const rows = await sequelize.query(`SELECT CONFIG_ID AS configId, SCOPE_TYPE AS scopeType, SCOPE_ID AS scopeId,
      TURNOVER_DAYS AS turnoverDays, COVERAGE_DAYS AS coverageDays, STALE_AGE_DAYS AS staleAgeDays,
      SLOW_MOVING_QUANTITY AS slowMovingQuantity, SLOW_MOVING_RATE AS slowMovingRate, STATUS AS status,
      UPDATED_BY AS updatedBy, UPDATE_TIME AS updateTime
    FROM T_INVENTORY_THRESHOLD_CONFIG WHERE STATUS = 1 ORDER BY SCOPE_TYPE, SCOPE_ID`, { type: QueryTypes.SELECT });
  ctx.body = { rows, fields: FIELDS, valueStatus: '未配置字段返回null；具体经营阈值数值待确认' };
}

async function save(ctx) {
  assertAdmin(ctx.state.user);
  const body = ctx.request.body || {};
  const scopeType = String(body.scopeType || 'global');
  if (!['global', 'productLine', 'product', 'store'].includes(scopeType)) ctx.throw(400, '无效的库存阈值作用域');
  const scopeId = scopeType === 'global' ? 'GLOBAL' : String(body.scopeId || '').trim();
  if (!scopeId) ctx.throw(400, '非全局阈值必须指定作用域');
  const values = Object.fromEntries(FIELDS.map(key => [key, normalizeNumber(body[key], key)]));
  const configId = String(body.configId || `${scopeType}-${scopeId}`).slice(0, 64);
  await sequelize.query(`INSERT INTO T_INVENTORY_THRESHOLD_CONFIG
    (CONFIG_ID,SCOPE_TYPE,SCOPE_ID,TURNOVER_DAYS,COVERAGE_DAYS,STALE_AGE_DAYS,SLOW_MOVING_QUANTITY,SLOW_MOVING_RATE,STATUS,UPDATED_BY)
    VALUES (:configId,:scopeType,:scopeId,:turnoverDays,:coverageDays,:staleAgeDays,:slowMovingQuantity,:slowMovingRate,1,:updatedBy)
    ON DUPLICATE KEY UPDATE SCOPE_TYPE=VALUES(SCOPE_TYPE), SCOPE_ID=VALUES(SCOPE_ID),
      TURNOVER_DAYS=VALUES(TURNOVER_DAYS), COVERAGE_DAYS=VALUES(COVERAGE_DAYS), STALE_AGE_DAYS=VALUES(STALE_AGE_DAYS),
      SLOW_MOVING_QUANTITY=VALUES(SLOW_MOVING_QUANTITY), SLOW_MOVING_RATE=VALUES(SLOW_MOVING_RATE), STATUS=1, UPDATED_BY=VALUES(UPDATED_BY)`,
    { replacements: { configId, scopeType, scopeId, ...values, updatedBy: String(ctx.state.user.staffId || ctx.state.user.username || '') } });
  ctx.body = { configId, scopeType, scopeId, ...values };
}

module.exports = { list, save, FIELDS };
