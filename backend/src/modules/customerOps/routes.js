const Router = require('koa-router');
const { Op } = require('sequelize');
const M = require('./models');
const S = require('./security');
const V = require('./service');
const W = require('./wechat');
const { Store, Distributor, Product, Order } = require('../../models');
const { recordBusinessAction } = require('../../utils/businessActionLog');
const customer = new Router({ prefix: '/api/v1/customer' });
const staff = new Router();
const attempts = new Map();
async function limit(ctx, next) {
  if (!ctx.path.endsWith('/claim-code')) S.enabled();
  ctx.set('Cache-Control', 'no-store');
  const principal = ctx.state.member ? `member:${ctx.state.member.id}`
    : ctx.state.user ? `staff:${ctx.state.user.staffId}` : ctx.ip;
  const now = Date.now(), key = `${principal}:${ctx.path}`;
  if (attempts.size > 10000) for (const [key, item] of attempts) if (item.until < now) attempts.delete(key);
  if (attempts.size > 20000) S.fail(429, '服务繁忙，请稍后重试');
  const entry = attempts.get(key);
  if (entry && entry.until > now) { if (++entry.count > 40) S.fail(429, '操作过于频繁，请稍后重试'); }
  else attempts.set(key, { count: 1, until: now + 60000 });
  await next();
}
staff.use(limit);
customer.post('/auth/wechat', limit, async ctx => {
  const identity = await W.login(ctx.request.body.code);
  const identity_hash = S.hash(`${identity.appid}:${identity.openid}`);
  const member = await V.transaction(async transaction => {
    const found = await M.Identity.findOne({ where: { identity_hash }, transaction });
    if (found) return M.Member.findByPk(found.member_id, { transaction });
    const row = await M.Member.create({}, { transaction });
    await M.Identity.create({ ...identity, identity_hash, member_id: row.id }, { transaction });
    return row;
  });
  if (member.status !== 'active') S.fail(403, '会员账号不可用');
  ctx.body = { token: S.sign(member), memberId: member.id };
});
customer.use(S.customerAuth);
customer.use(limit);
customer.post('/member/phone', async ctx => {
  const phone = String(ctx.request.body.phone || '').replace(/\s+/g, '');
  if (!/^1\d{10}$/.test(phone)) S.fail(400, '请输入正确的手机号');
  await ctx.state.member.update({ phone, phone_verified_at: new Date() });
  ctx.body = { verified: true };
});
customer.get('/member/profile', async ctx => {
  const member = ctx.state.member;
  const accounts = await M.Account.findAll({ where: { member_id: member.id } });
  ctx.body = { memberId: member.id, phone: member.phone ? member.phone.replace(/^(\d{3})\d+(\d{4})$/, '$1****$2') : null, accounts };
});
customer.post('/member/bind-order', async ctx => { ctx.body = await V.bind(ctx.state.member, ctx.request.body); });
customer.get('/member/points', async ctx => {
  const row = await M.Account.findOne({ where: { member_id: ctx.state.member.id, distributor_id: String(ctx.query.distributor_id || '') } });
  ctx.body = { balance: String(row?.balance || '0'), available: String(BigInt(row?.balance || 0) > 0n ? row.balance : '0') };
});
function pagination(ctx) {
  const page = Math.max(1, Math.min(10000, parseInt(ctx.query.page) || 1));
  const limit = Math.max(1, Math.min(100, parseInt(ctx.query.pageSize) || 20));
  return { limit, offset: (page - 1) * limit, page };
}
async function list(model, where, ctx, attributes) {
  const { limit, offset, page } = pagination(ctx);
  const result = await model.findAndCountAll({ where, attributes, limit, offset, order: [['created_at', 'DESC'], ['id', 'DESC']] });
  return { list: result.rows, total: result.count, page, pageSize: limit };
}
customer.get('/member/points/ledger', async ctx => { ctx.body = await list(M.Ledger, { member_id: ctx.state.member.id,
  ...(ctx.query.distributor_id ? { distributor_id: ctx.query.distributor_id } : {}) }, ctx, ['id', 'delta', 'after', 'type', 'created_at']); });
customer.get('/stores', async ctx => {
  const rows = await Store.findAll({ where: { status: 1, is_deleted: 0 }, attributes: ['store_id', 'distributor_id', 'name', 'address', 'phone'] });
  const dealers = await Distributor.findAll({ where: { distributor_id: [...new Set(rows.map(r => r.distributor_id))], status: 1 }, attributes: ['distributor_id', 'name'] });
  ctx.body = rows.filter(r => dealers.some(d => d.distributor_id === r.distributor_id)).map(r => ({ ...r.toJSON(), distributor_name: dealers.find(d => d.distributor_id === r.distributor_id).name }));
});
customer.get('/rewards', async ctx => { ctx.body = await list(M.Reward, { on_sale: true,
  ...(ctx.query.distributor_id ? { distributor_id: ctx.query.distributor_id } : {}) }, ctx, ['id', 'distributor_id', 'name', 'image', 'kind', 'points', 'stock', 'valid_days']); });
customer.get('/rewards/:id', async ctx => {
  const item = await M.Reward.findOne({ where: { id: ctx.params.id, on_sale: true } });
  if (!item) S.fail(404, '权益不存在');
  const links = await M.RewardStore.findAll({ where: { reward_id: item.id } });
  const stores = await Store.findAll({ where: { store_id: links.map(l => l.store_id) }, attributes: ['store_id', 'name', 'address'] });
  ctx.body = { ...item.toJSON(), stores };
});
function exchangeDto(row) {
  const { code_hash, request_key, ...data } = row.toJSON();
  return { ...data, status: data.status === 'pending' && data.expires_at <= new Date() ? 'expired' : data.status };
}
customer.post('/rewards/:id/exchange', async ctx => {
  const quote = ctx.request.body.expected_points;
  if (typeof quote !== 'string' || !/^[1-9]\d{0,11}$/.test(quote)) S.fail(400, '请先加载权益详情再兑换');
  // A client quote is only a precondition, never the amount charged.
  ctx.body = exchangeDto(await V.exchange(ctx.state.member, ctx.params.id, ctx.get('Idempotency-Key'), quote));
});
customer.get('/member/exchanges', async ctx => {
  const where = { member_id: ctx.state.member.id };
  if (ctx.query.status === 'pending') Object.assign(where, { status: 'pending', expires_at: { [Op.gt]: new Date() } });
  if (ctx.query.status === 'redeemed') where.status = 'redeemed';
  if (ctx.query.status === 'expired') Object.assign(where, { status: 'pending', expires_at: { [Op.lte]: new Date() } });
  const data = await list(M.Exchange, where, ctx); data.list = data.list.map(exchangeDto); ctx.body = data;
});
customer.get('/exchange/:id', async ctx => {
  const row = await M.Exchange.findOne({ where: { id: ctx.params.id, member_id: ctx.state.member.id } });
  if (!row) S.fail(404, '兑换不存在'); ctx.body = exchangeDto(row);
});
customer.get('/exchange/:id/credential', async ctx => {
  const row = await M.Exchange.findOne({ where: { id: ctx.params.id, member_id: ctx.state.member.id } });
  if (!row || row.status !== 'pending' || row.expires_at <= new Date()) S.fail(409, '兑换凭证不可用');
  const code = S.token('redeem', row.id);
  const QR = require('qrcode');
  ctx.body = { code, image: await QR.toDataURL(code, { errorCorrectionLevel: 'M', margin: 4, width: 320 }) };
});
staff.get('/options', async ctx => {
  const user = ctx.state.user;
  const ids = user.accessibleDistributorIds || [user.distributorId];
  const distributors = await Distributor.findAll({ where: { status: 1, ...(ids.includes('*') || user.roles.includes('boss') ? {} : { distributor_id: ids }) }, attributes: ['distributor_id', 'name'] });
  const stores = await Store.findAll({ where: { status: 1, is_deleted: 0, distributor_id: distributors.map(d => d.distributor_id),
    ...(user.roles.includes('boss') || user.accessibleStoreIds?.includes('*') ? {} : { store_id: user.accessibleStoreIds || [] }) }, attributes: ['store_id', 'distributor_id', 'name'] });
  ctx.body = { distributors, stores, canRedeem: user.roles.some(r => ['boss','admin','manager','store_manager','store_admin','clerk','staff'].includes(r)) && stores.length > 0 };
});
staff.post('/redemptions/preview', async ctx => { const b = ctx.request.body; ctx.body = await V.redeem(b.code, b.store_id, ctx.state.user, false); });
staff.post('/exchange/:id/redeem', async ctx => { const b = ctx.request.body; ctx.body = await V.redeem(b.code, b.store_id, ctx.state.user, true, ctx.params.id); });
staff.post('/orders/:id/claim-code', async ctx => {
  if (process.env.CUSTOMER_OPS_ENABLED !== 'true') { ctx.body = { enabled: false }; return; }
  const claim = await M.Claim.findOne({ where: { order_id: ctx.params.id } });
  if (!claim) { ctx.body = { enabled: true, eligible: false }; return; }
  const data = await V.claimCode(ctx.params.id, ctx.state.user);
  const image = await W.claimImage(data.token);
  if (!Buffer.isBuffer(image)) S.fail(502, '小程序码生成失败');
  const { PNG } = require('pngjs');
  const png = image[0] === 0x89 && image[1] === 0x50 ? PNG.sync.read(image)
    : require('jpeg-js').decode(image, { maxResolutionInMP: 1, maxMemoryUsageInMB: 32 });
  if (png.width > 384 || png.height > 1024) S.fail(502, '小程序码尺寸不适合小票');
  const stride = Math.ceil(png.width / 8), raster = Buffer.alloc(stride * png.height);
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
    const i = (y * png.width + x) * 4;
    if (png.data[i + 3] > 127 && (png.data[i] + png.data[i + 1] + png.data[i + 2]) < 384) raster[y * stride + (x >> 3)] |= 128 >> (x % 8);
  }
  const command = Buffer.concat([Buffer.from([0x1d,0x76,0x30,0,stride & 255,stride >> 8,png.height & 255,png.height >> 8]),raster]);
  ctx.body = { ...data, eligible: true, image: `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`, printBase64: command.toString('base64') };
});
// Management pages are restricted to admins in phase one; staff only get redemption APIs.
staff.use(async (ctx, next) => {
  S.admin(ctx.state.user);
  const scopeId = ctx.query.distributor_id || ctx.request.body?.distributor_id;
  if (scopeId) {
    S.distributor(ctx.state.user, scopeId);
    if (!await Distributor.findOne({ where: { distributor_id: scopeId, status: 1, is_deleted: 0 } })) S.fail(404, '经销商不存在或已停用');
  }
  await next();
});
staff.get('/members', async ctx => {
  const distributor_id = S.distributor(ctx.state.user, ctx.query.distributor_id);
  const data = await list(M.Account, { distributor_id }, ctx);
  const members = await M.Member.findAll({ where: { id: data.list.map(a => a.member_id) } });
  data.list = await Promise.all(data.list.map(async a => {
    const member = members.find(m => m.id === a.member_id);
    const [identity, bindings, exchangeCount] = await Promise.all([
      M.Identity.findOne({ where: { member_id: a.member_id }, attributes: ['openid'] }),
      M.Binding.findAll({ where: { account_id: a.id }, attributes: ['order_id'] }),
      M.Exchange.count({ where: { member_id: a.member_id, distributor_id } })
    ]);
    const firstPurchase = bindings.length ? await Order.min('create_time', { where: { order_id: bindings.map(b => b.order_id) } }) : null;
    return { ...a.toJSON(), phone: member?.phone?.replace(/^(\d{3})\d+(\d{4})$/, '$1****$2'),
      wechat_identity: identity ? `***${identity.openid.slice(-8)}` : '', source_store_id: member?.source_store_id,
      first_purchase_at: firstPurchase, exchange_count: exchangeCount };
  }));
  ctx.body = data;
});
for (const [path, model] of [['points/ledger', M.Ledger], ['point-rules', M.Rule], ['rewards', M.Reward], ['exchanges', M.Exchange], ['redemptions', M.Redemption]]) {
  staff.get(`/${path}`, async ctx => { const where = { distributor_id: S.distributor(ctx.state.user, ctx.query.distributor_id) };
    if (ctx.query.member_id && ['points/ledger', 'exchanges'].includes(path)) where.member_id = ctx.query.member_id;
    const data = await list(model, where, ctx); if (model === M.Exchange) data.list = data.list.map(exchangeDto); ctx.body = data; });
}
staff.post('/point-rules', async ctx => {
  const b = ctx.request.body, distributor_id = S.distributor(ctx.state.user, b.distributor_id);
  if (!/^\d{1,9}$/.test(String(b.numerator)) || !/^\d{1,9}$/.test(String(b.denominator)) || BigInt(b.denominator) < 1n || BigInt(b.numerator) < 1n) S.fail(400, '积分比例必须为正整数，分母单位为分');
  const product_ids = [...new Set((Array.isArray(b.product_ids) ? b.product_ids : []).map(String))];
  if (product_ids.length > 1000 || (product_ids.length && await Product.count({ where: { product_id: product_ids } }) !== product_ids.length)) S.fail(400, '请指定有效的参与商品ID');
  ctx.body = await V.transaction(async transaction => {
    await Distributor.findByPk(distributor_id, V.lock(transaction));
    const row = await M.Rule.create({ distributor_id, numerator: b.numerator, denominator: b.denominator,
      product_ids, effective_at: new Date(), actor: String(ctx.state.user.staffId) }, { transaction });
    await recordBusinessAction({ businessType: 'customer_rule', businessId: row.id, action: 'publish', user: ctx.state.user, detail: row.toJSON(), transaction });
    return row;
  });
});
async function saveReward(ctx) {
  const b = ctx.request.body, distributor_id = S.distributor(ctx.state.user, b.distributor_id);
  if (!b.name || String(b.name).length > 128 || !['gift', 'service'].includes(b.kind) || !/^[1-9]\d{0,11}$/.test(String(b.points))) S.fail(400, '名称、类型或所需积分无效');
  if (!Number.isInteger(b.valid_days) || b.valid_days < 1 || b.valid_days > 3650) S.fail(400, '有效天数应为1到3650');
  for (const key of ['stock', 'per_member_limit']) if (b[key] !== null && (!Number.isInteger(b[key]) || b[key] < 0)) S.fail(400, '数量应为非负整数或留空');
  if (b.image && !/^https:\/\//.test(b.image)) S.fail(400, '图片必须使用HTTPS地址');
  const storeIds = [...new Set(Array.isArray(b.store_ids) ? b.store_ids.map(String) : [])];
  if (!storeIds.length || await Store.count({ where: { store_id: storeIds, distributor_id, status: 1, is_deleted: 0 } }) !== storeIds.length) S.fail(400, '请选择同经销商有效门店');
  ctx.body = await V.transaction(async transaction => {
    let row = ctx.params.id ? await M.Reward.findByPk(ctx.params.id, V.lock(transaction)) : null;
    if (ctx.params.id && (!row || row.distributor_id !== distributor_id)) S.fail(404, '权益不存在');
    if (row && row.revision !== b.revision) S.fail(409, '商品已被兑换或更新，请刷新后重试');
    const fields = { distributor_id, name: String(b.name), kind: b.kind, points: String(b.points), image: b.image || '',
      valid_days: b.valid_days, stock: b.stock, per_member_limit: b.per_member_limit, instructions: String(b.instructions || '').slice(0, 10000), on_sale: b.on_sale === true,
      revision: row ? row.revision + 1 : 0 };
    const before = row?.toJSON();
    row = row ? await row.update(fields, { transaction }) : await M.Reward.create(fields, { transaction });
    await M.RewardStore.destroy({ where: { reward_id: row.id }, transaction });
    await M.RewardStore.bulkCreate(storeIds.map(store_id => ({ reward_id: row.id, store_id })), { transaction });
    await recordBusinessAction({ businessType: 'customer_reward', businessId: row.id, action: before ? 'update' : 'create', user: ctx.state.user, detail: { before, after: fields, storeIds }, transaction });
    return row;
  });
}
staff.post('/rewards', saveReward); staff.patch('/rewards/:id', saveReward);
staff.get('/rewards/:id', async ctx => {
  const row = await M.Reward.findByPk(ctx.params.id); if (!row) S.fail(404, '权益不存在');
  S.distributor(ctx.state.user, row.distributor_id);
  ctx.body = { ...row.toJSON(), store_ids: (await M.RewardStore.findAll({ where: { reward_id: row.id } })).map(r => r.store_id) };
});
staff.post('/points/adjustments', async ctx => {
  const b = ctx.request.body, key = S.requestKey(ctx.get('Idempotency-Key'));
  S.distributor(ctx.state.user, b.distributor_id);
  if (!/^-?[1-9]\d{0,11}$/.test(String(b.delta)) || !String(b.reason || '').trim() || String(b.reason).length > 512) S.fail(400, '请输入非零整数积分与512字以内的调整原因');
  ctx.body = await V.transaction(async transaction => {
    const account = await M.Account.findOne({ where: { member_id: b.member_id, distributor_id: b.distributor_id }, ...V.lock(transaction) });
    if (!account) S.fail(404, '积分账户不存在');
    const business_key = `adjust:${ctx.state.user.staffId}:${key}`;
    const existing = await M.Ledger.findOne({ where: { business_key }, transaction });
    if (existing) { if (existing.account_id !== account.id || String(existing.delta) !== String(b.delta) || existing.reason !== b.reason) S.fail(409, '幂等键内容冲突'); return existing; }
    await V.post(account, BigInt(b.delta), { type: 'adjustment', business_key, actor: String(ctx.state.user.staffId), reason: b.reason }, transaction);
    return { balance: String(account.balance) };
  });
});
staff.post('/claims/:id/approve', async ctx => {
  const b = ctx.request.body;
  if (!b.reason || !b.member_id) S.fail(400, '请填写会员ID与核验原因');
  ctx.body = await V.transaction(async transaction => {
    const row = await M.Claim.findOne({ where: { order_id: ctx.params.id }, ...V.lock(transaction) });
    if (!row) S.fail(404, '领取记录不存在');
    const store = await Store.findByPk(row.store_id, { transaction }); S.store(ctx.state.user, store);
    if (!await M.Member.findByPk(b.member_id, { transaction })) S.fail(404, '会员不存在');
    if (await M.Binding.findOne({ where: { order_id: row.order_id }, transaction })) S.fail(409, '订单已经领取');
    await row.update({ approved_member_id: b.member_id, approved_staff_id: ctx.state.user.staffId, approved_reason: b.reason }, { transaction });
    await recordBusinessAction({ businessType: 'customer_claim', businessId: row.order_id, action: 'approve_identity', user: ctx.state.user, comment: b.reason, detail: { memberId: b.member_id }, transaction });
    return { approved: true };
  });
});
module.exports = { customer, staff };
