const { Op } = require('sequelize');
const crypto = require('crypto');
const { sequelize } = require('../../config/database');
const { Order, OrderItem, Store, SalesReturnRequest, SalesReturnRequestItem } = require('../../models');
const M = require('./models');
const S = require('./security');
const math = require('./math');
const txOptions = { retry: { max: 0 } };
async function transaction(work) {
  for (let attempt = 0; ; attempt++) {
    try { return await sequelize.transaction(txOptions, work); }
    catch (e) {
      if (attempt >= 2 || !['ER_LOCK_DEADLOCK', 'ER_DUP_ENTRY'].includes(e.original?.code)) throw e;
    }
  }
}
const lock = transaction => ({ transaction, lock: transaction.LOCK.UPDATE });
async function account(memberId, distributorId, t) {
  const row = await M.Account.findOne({ where: { member_id: memberId, distributor_id: distributorId }, ...lock(t) });
  return row || M.Account.create({ member_id: memberId, distributor_id: distributorId }, { transaction: t });
}
async function post(account, delta, fields, t) {
  const before = BigInt(account.balance), after = before + delta;
  await M.Ledger.create({ ...fields, account_id: account.id, member_id: account.member_id,
    distributor_id: account.distributor_id, delta: String(delta), before: String(before), after: String(after) }, { transaction: t });
  const changes = { balance: String(after) };
  if (fields.type === 'earn') changes.earned = String(BigInt(account.earned) + delta);
  if (fields.type === 'return') changes.reversed = String(BigInt(account.reversed) - delta);
  if (fields.type === 'exchange') changes.spent = String(BigInt(account.spent) - delta);
  await account.update(changes, { transaction: t });
}
async function returned(orderId, t, including) {
  const requests = await SalesReturnRequest.findAll({ where: { order_id: orderId,
    [Op.or]: [{ status: 'completed' }, ...(including ? [{ return_id: including }] : [])] }, transaction: t });
  if (!requests.length) return {};
  const items = await SalesReturnRequestItem.findAll({ where: { return_id: requests.map(r => r.return_id) }, transaction: t });
  return items.reduce((map, i) => { map[String(i.order_item_id)] = (map[String(i.order_item_id)] || 0) + Number(i.quantity); return map; }, {});
}
// Called inside the existing sales archive transaction. No rule means not enrolled.
async function snapshotOrder(order, t) {
  if (process.env.CUSTOMER_OPS_ENABLED !== 'true') return null;
  const existing = await M.Claim.findOne({ where: { order_id: order.order_id }, transaction: t });
  if (existing) return existing;
  const store = await Store.findByPk(order.store_id, { transaction: t });
  const rules = await M.Rule.findAll({ where: { distributor_id: store.distributor_id, effective_at: { [Op.lte]: new Date() } }, order: [['effective_at', 'DESC']], limit: 1, transaction: t });
  if (!rules.length) return null;
  const items = await OrderItem.findAll({ where: { order_id: order.order_id }, order: [['item_id', 'ASC']], transaction: t });
  if (!items.length) S.fail(409, '订单没有可计分商品');
  const snapshot = math.makeSnapshot(order, items, rules[0]);
  const nonce = crypto.randomBytes(16).toString('hex');
  return M.Claim.create({ order_id: order.order_id, store_id: order.store_id, distributor_id: store.distributor_id,
    snapshot, nonce, token_hash: S.hash(S.token('claim', nonce)), expires_at: new Date(Date.now() + 90 * 86400000) }, { transaction: t });
}
async function claimCode(orderId, user) {
  S.enabled();
  const order = await Order.findByPk(orderId);
  if (!order || order.is_deleted || !['已归档', 'completed', 'archived'].includes(order.order_status)) S.fail(409, '仅已归档有效销售单可以领取');
  const store = await Store.findByPk(order.store_id); S.store(user, store);
  const claim = await M.Claim.findOne({ where: { order_id: orderId } });
  if (!claim) S.fail(409, '该订单未参与积分活动，请检查归档时的积分规则');
  if (claim.expires_at <= new Date()) S.fail(409, '领取凭据已过期');
  return { orderId, token: S.token('claim', claim.nonce), expiresAt: claim.expires_at };
}
async function bind(member, input) {
  return transaction(async t => {
    const found = await M.Claim.findOne({ where: { token_hash: S.hash(input.token) }, transaction: t });
    if (!found || (input.order_id && input.order_id !== found.order_id)) S.fail(409, '领取凭据无效');
    const order = await Order.findByPk(found.order_id, lock(t));
    const claim = await M.Claim.findByPk(found.id, lock(t));
    const previous = await M.Binding.findOne({ where: { order_id: order.order_id }, transaction: t });
    if (previous) {
      if (previous.member_id !== member.id) S.fail(409, '该订单已经领取');
      const existingAccount = await M.Account.findByPk(previous.account_id, { transaction: t });
      return { alreadyClaimed: true, awardedPoints: String(previous.awarded),
        distributorId: existingAccount.distributor_id, balance: String(existingAccount.balance) };
    }
    if (claim.expires_at <= new Date() || order.is_deleted || !['已归档', 'completed', 'archived'].includes(order.order_status)) S.fail(409, '订单当前不可领取');
    const verified = member.phone_verified_at && member.phone && member.phone === order.customer_phone;
    if (!verified && claim.approved_member_id !== member.id) S.fail(409, '请授权与订单一致的手机号；不一致请联系原门店核验');
    const balance = await account(member.id, claim.distributor_id, t);
    const net = math.remaining(claim.snapshot, await returned(order.order_id, t));
    const awarded = math.points(net, claim.snapshot);
    if (awarded <= 0n) S.fail(409, '该订单没有可领取积分');
    await M.Binding.create({ order_id: order.order_id, member_id: member.id, account_id: balance.id,
      awarded: String(awarded), snapshot: claim.snapshot }, { transaction: t });
    await post(balance, awarded, { type: 'earn', business_key: `earn:${order.order_id}`, order_id: order.order_id,
      store_id: order.store_id, actor: `member:${member.id}`, snapshot: claim.snapshot }, t);
    await M.Member.update({ source_store_id: order.store_id }, { where: { id: member.id, source_store_id: null }, transaction: t });
    return { awardedPoints: String(awarded), balance: String(balance.balance), distributorId: balance.distributor_id };
  });
}
async function exchange(member, rewardId, key, quotedPoints) {
  S.requestKey(key);
  return transaction(async t => {
    const previous = await M.Exchange.findOne({ where: { member_id: member.id, request_key: key }, transaction: t });
    if (previous) { if (previous.reward_id !== rewardId) S.fail(409, '幂等键不能用于其他商品'); return previous; }
    const item = await M.Reward.findByPk(rewardId, { transaction: t });
    if (!item) S.fail(404, '权益不存在');
    const balance = await account(member.id, item.distributor_id, t);
    const reward = await M.Reward.findByPk(rewardId, lock(t));
    if (quotedPoints !== undefined && String(quotedPoints) !== String(reward.points)) S.fail(409, '积分价格已更新，请刷新详情后兑换');
    if (!reward.on_sale || (reward.stock !== null && reward.stock <= 0)) S.fail(409, '权益已下架或售罄');
    if (BigInt(balance.balance) < BigInt(reward.points)) S.fail(409, '积分不足');
    if (reward.per_member_limit !== null && await M.Exchange.count({ where: { member_id: member.id, reward_id: rewardId }, transaction: t }) >= reward.per_member_limit) S.fail(409, '已达到兑换数量限制');
    const stores = await M.RewardStore.findAll({ where: { reward_id: rewardId }, transaction: t });
    const activeStores = await Store.findAll({ where: { store_id: stores.map(s => s.store_id),
      distributor_id: reward.distributor_id, status: 1, is_deleted: 0 }, transaction: t });
    if (!activeStores.length) S.fail(409, '权益当前没有可用门店');
    const id = crypto.randomBytes(16).toString('hex');
    const code = S.token('redeem', id);
    const row = await M.Exchange.create({ id, member_id: member.id, account_id: balance.id, reward_id: rewardId,
      distributor_id: reward.distributor_id, points: String(reward.points), request_key: key,
      expires_at: new Date(Date.now() + reward.valid_days * 86400000), code_hash: S.hash(code),
      snapshot: { name: reward.name, image: reward.image, kind: reward.kind, instructions: reward.instructions,
        storeIds: activeStores.map(s => s.store_id) } }, { transaction: t });
    await post(balance, -BigInt(reward.points), { type: 'exchange', exchange_id: id,
      business_key: `exchange:${id}`, actor: `member:${member.id}` }, t);
    await reward.update({ ...(reward.stock !== null ? { stock: reward.stock - 1 } : {}), revision: reward.revision + 1 }, { transaction: t });
    return row;
  });
}
async function redeem(code, storeId, user, confirm, expectedId) {
  return transaction(async t => {
    const store = await Store.findByPk(storeId, { transaction: t });
    if (!store || store.is_deleted || store.status !== 1) S.fail(403, '门店不可用');
    S.store(user, store);
    const found = await M.Exchange.findOne({ where: { code_hash: S.hash(code) }, transaction: t });
    if (!found || (expectedId && expectedId !== found.id)) S.fail(404, '核销凭证无效');
    const balance = await M.Account.findByPk(found.account_id, lock(t));
    const row = await M.Exchange.findByPk(found.id, lock(t));
    if (row.distributor_id !== store.distributor_id || !row.snapshot.storeIds.includes(store.store_id)) S.fail(403, '该权益不适用于本店');
    const used = await M.Redemption.findOne({ where: { exchange_id: row.id }, transaction: t });
    const member = await M.Member.findByPk(row.member_id, { transaction: t });
    const result = { id: row.id, name: row.snapshot.name, points: String(row.points), expiresAt: row.expires_at,
      status: row.status === 'pending' && row.expires_at <= new Date() ? 'expired' : row.status,
      member: member.phone ? member.phone.replace(/^(\d{3})\d+(\d{4})$/, '$1****$2') : member.id.slice(-8),
      redemption: used, alreadyRedeemed: Boolean(used) };
    if (!confirm || used) return result;
    if (row.status !== 'pending' || row.expires_at <= new Date()) S.fail(409, '权益已失效');
    if (BigInt(balance.balance) < 0n) S.fail(409, '会员有待抵扣积分，暂不可核销');
    const redemption = await M.Redemption.create({ exchange_id: row.id, member_id: row.member_id,
      distributor_id: row.distributor_id, store_id: storeId, staff_id: user.staffId }, { transaction: t });
    await row.update({ status: 'redeemed' }, { transaction: t });
    return { ...result, status: 'redeemed', redemption };
  });
}
// Must run in the caller's return-completion transaction, including legacy inbound.
async function reverseReturn(order, request, t) {
  let binding;
  try { binding = await M.Binding.findOne({ where: { order_id: order.order_id }, ...lock(t) }); }
  catch (error) {
    if (process.env.CUSTOMER_OPS_ENABLED !== 'true' && error.original?.code === 'ER_NO_SUCH_TABLE') return;
    throw error;
  }
  if (!binding) return;
  const key = `return:${request.return_id}`;
  if (await M.Ledger.findOne({ where: { business_key: key }, transaction: t })) return;
  const balance = await M.Account.findByPk(binding.account_id, lock(t));
  const net = math.remaining(binding.snapshot, await returned(order.order_id, t, request.return_id));
  const available = math.points(net, binding.snapshot);
  const target = BigInt(binding.awarded) > available ? BigInt(binding.awarded) - available : 0n;
  const delta = target - BigInt(binding.reversed);
  if (delta < 0n) S.fail(409, '积分冲回快照异常，请核对');
  await post(balance, -delta, { type: 'return', business_key: key, order_id: order.order_id,
    return_id: request.return_id, store_id: order.store_id, actor: 'system', snapshot: { remaining: String(net) } }, t);
  await binding.update({ reversed: String(target) }, { transaction: t });
}
module.exports = { transaction, lock, account, post, snapshotOrder, claimCode, bind, exchange, redeem, reverseReturn };
