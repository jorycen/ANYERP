// SN formatting only: never remove internal characters or alter SN record IDs.
function normalizeSnCode(value) {
  return value == null ? value : String(value).trim().toUpperCase();
}
const scalarKeys = new Set(['sn', 'sncode', 'oldsncode', 'newsncode', 'sourcesncode', 'targetsncode', 'directinboundsncode', 'requestedsncode']);
const listKeys = new Set(['sncodes', 'receivedsncodes']);
const keyOf = key => String(key).replace(/_/g, '').toLowerCase();
function normalizeSnValue(value, list = false) {
  if (!list) return normalizeSnCode(value);
  if (Array.isArray(value)) return value.map(normalizeSnCode);
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return JSON.stringify(parsed.map(normalizeSnCode));
  } catch (_) { /* Plain lists are also accepted by existing import APIs. */ }
  return value.split(/([,;\r\n])/).map(part => /[,;\r\n]/.test(part) ? part : normalizeSnCode(part)).join('');
}
function normalizeSnFields(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || value instanceof Date || seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) {
    const normalizedKey = keyOf(key);
    if (scalarKeys.has(normalizedKey)) value[key] = normalizeSnValue(value[key]);
    else if (listKeys.has(normalizedKey)) value[key] = normalizeSnValue(value[key], true);
    else normalizeSnFields(value[key], seen);
  }
  return value;
}
function installSnModelNormalization(models) {
  const { Op, where, fn, col } = require('sequelize');
  for (const model of Object.values(models)) {
    const fields = Object.keys(model.rawAttributes).filter(name => scalarKeys.has(keyOf(name)) || listKeys.has(keyOf(name)));
    if (!fields.length) continue;
    for (const name of fields) {
      model.rawAttributes[name].set = function(value) {
        this.setDataValue(name, normalizeSnValue(value, listKeys.has(keyOf(name))));
      };
    }
    model.refreshAttributes();
    model.addHook('beforeBulkUpdate', 'normalizeSnCodes', options => normalizeSnFields(options.attributes));
    const normalizeOperand = value => {
      if (Array.isArray(value)) return value.map(normalizeOperand);
      if (value && Object.getPrototypeOf(value) === Object.prototype) {
        return Object.fromEntries(Reflect.ownKeys(value).map(key => [key, normalizeOperand(value[key])]));
      }
      return typeof value === 'string' ? normalizeSnCode(value) : value;
    };
    const rewriteWhere = value => {
      if (Array.isArray(value)) return value.map(rewriteWhere);
      if (!value || Object.getPrototypeOf(value) !== Object.prototype) return value;
      const result = {}, clauses = [];
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'string' && fields.includes(key) && scalarKeys.has(keyOf(key))) {
          const field = model.rawAttributes[key].field || key;
          clauses.push(where(fn('UPPER', fn('TRIM', col(`${model.name}.${field}`))), normalizeOperand(value[key])));
        } else result[key] = typeof key === 'symbol' ? rewriteWhere(value[key]) : value[key];
      }
      if (clauses.length) result[Op.and] = [...(result[Op.and] ? [result[Op.and]] : []), ...clauses];
      return result;
    };
    for (const hook of ['beforeFind', 'beforeCount']) model.addHook(hook, 'normalizeSnQuery', options => { options.where = rewriteWhere(options.where); });
  }
}
module.exports = { normalizeSnCode, normalizeSnFields, normalizeSnValue, installSnModelNormalization };
