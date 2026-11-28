const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const M = require('./models');
function fail(status, message) { const e = new Error(message); e.status = status; throw e; }
function enabled() { if (process.env.CUSTOMER_OPS_ENABLED !== 'true') fail(503, '客户运营尚未启用'); }
function key() {
  const value = process.env.CUSTOMER_TOKEN_SECRET || '';
  if (value.length < 32) fail(503, '客户身份服务尚未配置');
  return value;
}
function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function token(purpose, value) { return crypto.createHmac('sha256', key()).update(`${purpose}:${value}`).digest('base64url').slice(0, 24); }
function sign(member) { return jwt.sign({}, key(), { subject: member.id, audience: 'erp-customer', issuer: 'any-erp', expiresIn: '7d', algorithm: 'HS256' }); }
async function customerAuth(ctx, next) {
  enabled();
  let decoded;
  try { decoded = jwt.verify((ctx.headers.authorization || '').replace(/^Bearer /, ''), key(), { audience: 'erp-customer', issuer: 'any-erp', algorithms: ['HS256'] }); }
  catch { fail(401, '请重新登录客户小程序'); }
  const member = await M.Member.findByPk(decoded.sub);
  if (!member || member.status !== 'active') fail(401, '会员身份不可用');
  ctx.state.member = member;
  await next();
}
function roles(user) { return user.roles || [user.roleCode]; }
function admin(user) { if (!roles(user).some(r => ['boss', 'admin'].includes(r))) fail(403, '仅管理员可以执行此操作'); }
function distributor(user, id) {
  const ids = user.accessibleDistributorIds || user.distributorIds || [user.distributorId];
  if (!id || (!roles(user).includes('boss') && !ids.includes('*') && !ids.map(String).includes(String(id)))) fail(403, '无权访问该经销商');
  return String(id);
}
function store(user, row) {
  distributor(user, row.distributor_id);
  if (!roles(user).some(r => ['boss', 'admin', 'manager', 'store_manager', 'store_admin', 'clerk', 'staff'].includes(r))) fail(403, '无核销权限');
  const ids = user.accessibleStoreIds || [];
  if (!roles(user).includes('boss') && !ids.includes('*') && !ids.map(String).includes(String(row.store_id))) fail(403, '无权操作该门店');
}
function requestKey(value) {
  if (!/^[a-zA-Z0-9_-]{16,80}$/.test(value || '')) fail(400, '缺少有效操作幂等键');
  return value;
}
module.exports = { fail, enabled, key, hash, token, sign, customerAuth, admin, distributor, store, requestKey };
