const { Op } = require('sequelize');
const crypto = require('crypto');
const { sequelize } = require('../../config/database');
const { Order, OrderItem, Store, SalesReturnRequest, SalesReturnRequestItem } = require('../../models');
const M = require('./models');
const S = require('./security');
const math = require('./math');
const P = require('./rewardPolicy');
const RS = require('./rewardStores');
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
const claimableStatuses = ['未归档', '已归档', 'completed', 'archived', 'pending_approval', 'pending_store_approval', 'pending_distributor_approval'];
function phoneInput(value) {
  if (typeof value !== 'string' || !/^1\d{10}$/.test(value.trim())) S.fail(400, '请输入11位购机手机号');
  return value.trim();
}
async function account(memberId, distributorId, t) {
  const row = await M.Account.findOne({ where: { member_id: memberId, distributor_id: distributorId }, ...lock(t) });
  return row || M.Account.create({ member_id: memberId, distributor_id: distributorId }, { transaction: t });
}
async function post(account, delta, fields, t) {
  const before = BigInt(account.balance), after = before + delta;
  await M.Ledger.create({ ...fields, account_id: account.id, member_id: account.member_id,
    distributor_id: account.distributor_id, delta: String(delta), before: String(before), after: String(after) }, { transaction: t });
  const changes = { balance: String(after) };
  if (['earn', 'order_adjust', 'activity'].includes(fields.type)) changes.earned = String(BigInt(account.earned) + delta);
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
    const matches = member.phone && member.phone === order.customer_phone;
    if (!matches && claim.approved_member_id !== member.id) S.fail(409, '请输入与订单一致的手机号；不一致请联系原门店核验');
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
// Each order commits independently. Replays and racing members are serialized by
// the existing order row and the unique binding / earn-ledger business keys.
async function claimByPhone(member, input) {
  const phone = phoneInput(input.phone);
  if (input.after !== undefined && (typeof input.after !== 'string' || input.after.length > 32)) S.fail(400, '分页参数无效');
  const candidates = await Order.findAll({ where: { customer_phone: phone, is_deleted: 0,
    ...(input.after ? { order_id: { [Op.gt]: input.after } } : {}) },
    attributes: ['order_id'], order: [['order_id', 'ASC']], limit: 51 });
  const results = [];
  for (const candidate of candidates.slice(0, 50)) {
    try {
      results.push(await transaction(async t => {
        const order = await Order.findByPk(candidate.order_id, lock(t));
        const result = { orderId: candidate.order_id, orderNo: order?.order_no, awardedPoints: '0', status: 'skipped' };
        if (!order || order.is_deleted || order.customer_phone !== phone) return { ...result, reason: '订单信息已变化' };
        const previous = await M.Binding.findOne({ where: { order_id: order.order_id }, transaction: t });
        if (previous) return { ...result, reason: '订单已领取', status: 'already_claimed' };
        if (!claimableStatuses.includes(order.order_status)) return { ...result, reason: '草稿、取消或退货中的订单不可领取' };
        if (order.order_status === '未归档' && !order.submit_time) return { ...result, reason: '订单尚未提交' };
        const store = await Store.findByPk(order.store_id, { transaction: t });
        if (!store || store.is_deleted) return { ...result, reason: '订单门店不可用' };
        const rule = await M.Rule.findOne({ where: { distributor_id: store.distributor_id,
          effective_at: { [Op.lte]: new Date() } }, order: [['effective_at', 'DESC']], transaction: t });
        if (!rule) return { ...result, reason: '门店尚未配置积分规则' };
        const items = await OrderItem.findAll({ where: { order_id: order.order_id }, order: [['item_id', 'ASC']], transaction: t });
        if (!items.length) return { ...result, reason: '订单无商品' };
        const snapshot = math.makeSnapshot(order, items, rule);
        snapshot.phoneSource = 'manual';
        const awarded = math.points(math.remaining(snapshot, await returned(order.order_id, t)), snapshot);
        if (awarded <= 0n) return { ...result, reason: '订单没有可领取积分' };
        const balance = await account(member.id, store.distributor_id, t);
        await M.Binding.create({ order_id: order.order_id, member_id: member.id, account_id: balance.id,
          awarded: String(awarded), snapshot }, { transaction: t });
        await post(balance, awarded, { type: 'earn', business_key: `earn:${order.order_id}`, order_id: order.order_id,
          store_id: order.store_id, actor: `member:${member.id}`, snapshot }, t);
        await M.Member.update({ phone, phone_verified_at: null }, { where: { id: member.id }, transaction: t });
        await M.Member.update({ source_store_id: order.store_id }, { where: { id: member.id, source_store_id: null }, transaction: t });
        return { ...result, status: 'claimed', awardedPoints: String(awarded), distributorId: store.distributor_id };
      }));
    } catch (error) {
      // Never publish SQL, phone, SN, or internal order data in the batch result.
      console.error('[customer claim]', candidate.order_id, error.original?.code || error.name);
      results.push({ orderId: candidate.order_id, status: 'failed', awardedPoints: '0', reason: '领取未完成，请重试或联系门店核对' });
    }
  }
  return { results, awardedPoints: String(results.reduce((sum, r) => sum + BigInt(r.awardedPoints), 0n)),
    claimedCount: results.filter(r => r.status === 'claimed').length,
    next: candidates.length > 50 ? candidates[49].order_id : null };
}
// Submission awards must follow later price/item corrections and cancellation.
// Call only inside the sales transaction after locking and saving the order.
async function reconcileOrder(order, t) {
  let binding;
  try { binding = await M.Binding.findOne({ where: { order_id: order.order_id }, ...lock(t) }); }
  catch (error) {
    if (process.env.CUSTOMER_OPS_ENABLED !== 'true' && error.original?.code === 'ER_NO_SUCH_TABLE') return;
    throw error;
  }
  if (!binding) return;
  const store = await Store.findByPk(order.store_id, { transaction: t });
  const balance = await M.Account.findByPk(binding.account_id, lock(t));
  if (!store || store.distributor_id !== balance.distributor_id) S.fail(409, '已领取积分订单不能跨经销商移动');
  const rule = await M.Rule.findByPk(binding.snapshot.rule_id, { transaction: t });
  // Legacy imported snapshots without a rule remain governed by return reversal.
  if (!rule) return;
  const items = await OrderItem.findAll({ where: { order_id: order.order_id }, order: [['item_id', 'ASC']], transaction: t });
  const snapshot = math.makeSnapshot(order, items, rule);
  const cancelled = order.is_deleted || ['cancelled', 'canceled', 'voided', '已取消', '作废', '已作废', 'draft'].includes(order.order_status);
  const target = cancelled ? 0n : math.points(math.remaining(snapshot, await returned(order.order_id, t)), snapshot);
  const delta = target - (BigInt(binding.awarded) - BigInt(binding.reversed));
  if (delta) await post(balance, delta, { type: 'order_adjust', business_key: `order_adjust:${order.order_id}:${crypto.randomBytes(16).toString('hex')}`,
    order_id: order.order_id, store_id: order.store_id, actor: 'system', reason: cancelled ? '订单作废冲回' : '订单计分金额调整', snapshot }, t);
  await binding.update({ awarded: String(target + BigInt(binding.reversed)), snapshot }, { transaction: t });
}
async function exchange(member, rewardId, key, quotedPoints, quotedCash) {
  S.requestKey(key);
  return transaction(async t => {
    const previous = await M.Exchange.findOne({ where: { member_id: member.id, request_key: key }, transaction: t });
    if (previous) { if (previous.reward_id !== rewardId) S.fail(409, '幂等键不能用于其他商品'); return previous; }
    const item = await M.Reward.findByPk(rewardId, { transaction: t });
    if (!item) S.fail(404, '权益不存在');
    const balance = await account(member.id, item.distributor_id, t);
    const reward = await M.Reward.findByPk(rewardId, lock(t));
    if (quotedPoints !== undefined && String(quotedPoints) !== String(reward.points)) S.fail(409, '积分价格已更新，请刷新详情后兑换');
    if ((quotedCash === undefined && math.cents(reward.cash_required) > 0n) || (quotedCash !== undefined && P.money(quotedCash) !== P.money(reward.cash_required))) S.fail(409, '现金价格已更新，请刷新详情后兑换');
    if ((reward.valid_start_time && reward.valid_start_time > new Date()) || (reward.valid_end_time && reward.valid_end_time <= new Date())) S.fail(409, '不在权益兑换有效期内');
    if (!reward.on_sale || (reward.stock !== null && reward.stock <= 0)) S.fail(409, '权益已下架或售罄');
    if (BigInt(balance.balance) < BigInt(reward.points)) S.fail(409, '积分不足');
    if (reward.per_member_limit !== null && await M.Exchange.count({ where: { member_id: member.id, reward_id: rewardId }, transaction: t }) >= reward.per_member_limit) S.fail(409, '已达到兑换数量限制');
    const stores = await M.RewardStore.findAll({ where: { reward_id: rewardId }, transaction: t });
    const activeStores = await RS.activeStores(stores.map(s => s.store_id), t);
    if (!activeStores.length) S.fail(409, '权益当前没有可用门店');
    const id = crypto.randomBytes(16).toString('hex');
    const code = S.token('redeem', id);
    const row = await M.Exchange.create({ id, member_id: member.id, account_id: balance.id, reward_id: rewardId,
      distributor_id: reward.distributor_id, points: String(reward.points), request_key: key,
      expires_at: new Date(Date.now() + reward.valid_days * 86400000), code_hash: S.hash(code),
      snapshot: { name: reward.name, image: reward.image, kind: reward.kind, instructions: reward.instructions,
        description: reward.description, cash_required: P.money(reward.cash_required), self_only: reward.self_only,
        coupon_value: P.money(reward.coupon_value), coupon_min_spend: P.money(reward.coupon_min_spend), coupon_scope: reward.coupon_scope,
        stores: activeStores.map(s => ({ store_id: s.store_id, distributor_id: s.distributor_id, name: s.name, address: s.address })),
        storeIds: activeStores.map(s => s.store_id) } }, { transaction: t });
    await post(balance, -BigInt(reward.points), { type: 'exchange', exchange_id: id,
      business_key: `exchange:${id}`, actor: `member:${member.id}`, reason: `兑换${reward.name}` }, t);
    await reward.update({ ...(reward.stock !== null ? { stock: reward.stock - 1 } : {}), revision: reward.revision + 1 }, { transaction: t });
    return row;
  });
}
async function redeem(code, storeId, user, confirm, expectedId, evidence = {}) {
  return transaction(async t => {
    const store = (await RS.activeStores([storeId], t))[0];
    if (!store || store.is_deleted || store.status !== 1) S.fail(403, '门店不可用');
    S.store(user, store);
    const found = await M.Exchange.findOne({ where: { code_hash: S.hash(code) }, transaction: t });
    if (!found || (expectedId && expectedId !== found.id)) S.fail(404, '核销凭证无效');
    const balance = await M.Account.findByPk(found.account_id, lock(t));
    const row = await M.Exchange.findByPk(found.id, lock(t));
    if (!RS.accepts(row.snapshot, store, row.distributor_id)) S.fail(403, '该权益不适用于本店');
    const used = await M.Redemption.findOne({ where: { exchange_id: row.id }, transaction: t });
    const member = await M.Member.findByPk(row.member_id, { transaction: t });
    const result = { id: row.id, name: row.snapshot.name, points: String(row.points), expiresAt: row.expires_at,
      cashRequired: P.money(row.snapshot.cash_required || '0'), selfOnly: row.snapshot.self_only !== false,
      kind: row.snapshot.kind, couponValue: row.snapshot.coupon_value || '0.00',
      couponMinSpend: row.snapshot.coupon_min_spend || '0.00', couponScope: row.snapshot.coupon_scope || '',
      status: row.status === 'pending' && row.expires_at <= new Date() ? 'expired' : row.status,
      member: member.phone ? member.phone.replace(/^(\d{3})\d+(\d{4})$/, '$1****$2') : member.id.slice(-8),
      redemption: used, alreadyRedeemed: Boolean(used) };
    if (!confirm || used) return result;
    if (row.status !== 'pending' || row.expires_at <= new Date()) S.fail(409, '权益已失效');
    if (BigInt(balance.balance) < 0n) S.fail(409, '会员有待抵扣积分，暂不可核销');
    let coupon_check = null;
    if (row.snapshot.kind === 'coupon') {
      if (evidence.scope_confirmed !== true) S.fail(400, '请核对优惠券使用范围');
      if (math.cents(evidence.eligible_amount || '0') < math.cents(row.snapshot.coupon_min_spend || '0')) S.fail(409, '消费金额未达到优惠券门槛');
      if (!String(evidence.receipt_reference || '').trim()) S.fail(400, '请填写优惠券使用的销售单号或服务工单号');
      coupon_check = { eligible_amount: P.money(evidence.eligible_amount || '0'), scope_confirmed: true,
        scope: row.snapshot.coupon_scope, value: row.snapshot.coupon_value, checked_at: new Date().toISOString() };
    }
    const cash = P.money(row.snapshot.cash_required || '0');
    if (math.cents(cash) > 0n) {
      if (evidence.cash_confirmed !== true || P.money(evidence.cash_received || '0') !== cash) S.fail(409, '请核对并确认已收齐现金补差');
      if (!String(evidence.receipt_reference || '').trim()) S.fail(400, '请填写收款流水或销售单号');
    }
    if (String(evidence.receipt_reference || '').length > 128) S.fail(400, '凭据编号不能超过128字');
    const redemption = await M.Redemption.create({ exchange_id: row.id, member_id: row.member_id,
      distributor_id: row.distributor_id, store_id: storeId, staff_id: user.staffId,
      cash_received: cash, receipt_reference: String(evidence.receipt_reference || '').trim() || null, coupon_check }, { transaction: t });
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
module.exports = { transaction, lock, account, post, snapshotOrder, claimCode, bind, claimByPhone, phoneInput, reconcileOrder, exchange, redeem, reverseReturn };
