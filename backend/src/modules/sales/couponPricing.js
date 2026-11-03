const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const cents = value => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1e9 || Math.abs(n * 100 - Math.round(n * 100)) > 0.00001) fail('优惠券金额必须为非负数，最多两位小数');
  return Math.round(n * 100);
};
function normalizeRule(value) {
  if (value == null) return null;
  let rule;
  try { rule = parse(value); } catch { fail('优惠券规则格式不正确'); }
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) fail('优惠券规则格式不正确');
  if (!['mall', 'douyin'].includes(rule.kind)) fail('优惠券类型不正确');
  const rate = (value, label) => {
    const n = Number(value);
    if (value === '' || value == null || !Number.isFinite(n) || n < 0 || n > 100 || Math.abs(n * 100 - Math.round(n * 100)) > 0.00001) fail(`${label}必须为0至100，最多两位小数`);
    return n;
  };
  const face = cents(rule.faceAmount), purchase = rule.kind === 'douyin' ? cents(rule.purchaseAmount) : 0;
  if (rule.kind === 'douyin' && (face <= 0 || purchase <= 0 || purchase > face)) fail('抖音购券金额必须大于0且不超过抵扣面额');
  const mallRate = rate(rule.mallRate, '商场承担比例');
  const platformRate = rule.kind === 'douyin' ? rate(rule.platformRate, '平台手续费率') : 0;
  const mallAccountId = String(rule.mallAccountId || '');
  const platformAccountId = String(rule.platformAccountId || '');
  const date = value => {
    if (!value) return '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(new Date(value).getTime()) || new Date(value).toISOString().slice(0,10) !== value) fail('优惠券有效日期格式不正确');
    return value;
  };
  const validFrom = date(rule.validFrom), validTo = date(rule.validTo);
  if (validFrom && validTo && validFrom > validTo) fail('优惠券结束日期不得早于开始日期');
  if (mallRate > 0 && !mallAccountId) fail('请选择商场返款结算账户');
  if (purchase > 0 && platformRate < 100 && !platformAccountId) fail('请选择购券返款结算账户');
  return { version: 1, kind: rule.kind, faceAmount: face / 100, purchaseAmount: purchase / 100,
    mallRate, platformRate, mallAccountId, platformAccountId, validFrom, validTo };
}
function calculateCoupon(ruleValue, amount) {
  const rule = normalizeRule(ruleValue);
  if (!rule) return null;
  const face = cents(amount), single = cents(rule.faceAmount);
  if (face <= 0) fail('优惠券抵扣金额必须大于0');
  if (single > 0 && face % single !== 0) fail('优惠券抵扣金额必须为券面额的整数倍');
  const count = single > 0 ? face / single : 1;
  const purchase = cents(rule.purchaseAmount) * count;
  const fee = Math.round(cents(rule.purchaseAmount) * rule.platformRate / 100) * count;
  const difference = face - purchase;
  // Round each voucher separately. Company bears the remaining cent.
  const mall = single > 0 ? Math.round((single - cents(rule.purchaseAmount)) * rule.mallRate / 100) * count : Math.round(difference * rule.mallRate / 100);
  const company = difference - mall, platformNet = purchase - fee;
  return { ...rule, rule, count, faceAmount: face / 100, purchaseAmount: purchase / 100,
    platformFee: fee / 100, platformNet: platformNet / 100, mallAmount: mall / 100,
    companyAmount: company / 100, totalCost: (company + fee) / 100,
    settlementAmount: (platformNet + mall) / 100 };
}
function settlementLines(payment) {
  const snapshot = parse(payment.coupon_snapshot);
  if (!snapshot) return [payment];
  return [
    { suffix: '购券返还', amount: snapshot.platformNet, account: snapshot.platformAccountId },
    { suffix: '商场承担', amount: snapshot.mallAmount, account: snapshot.mallAccountId }
  ].filter(row => row.amount > 0).map(row => ({ ...payment,
    payment_method: `${payment.payment_method}/${row.suffix}`, amount: row.amount,
    coupon_account_id: row.account, coupon_settlement: true }));
}
function reversalLines(payments, priorGross, returnGross, orderGross) {
  if (!(orderGross > 0)) fail('优惠券退单缺少原单商品金额');
  const before = Math.min(1, Math.max(0, priorGross / orderGross));
  const after = Math.min(1, Math.max(0, (priorGross + returnGross) / orderGross));
  return payments.filter(p => p.coupon_snapshot).flatMap(settlementLines).map(p => ({ ...p,
    amount: (Math.round(cents(p.amount) * after) - Math.round(cents(p.amount) * before)) / 100
  })).filter(p => p.amount > 0);
}
function expandSettlementPayments(payments) {
  const ordinary = [], coupons = new Map();
  for (const payment of payments) {
    if (!payment.coupon_snapshot) { ordinary.push(payment); continue; }
    for (const line of settlementLines(payment)) {
      const key = `${line.payment_method}:${line.coupon_account_id}`;
      const previous = coupons.get(key);
      coupons.set(key, { ...line, amount: (cents(previous?.amount || 0) + cents(line.amount)) / 100 });
    }
  }
  return [...ordinary, ...coupons.values()];
}
async function paymentSnapshot(payment, storeId, transaction, previous = []) {
  const { PaymentMethod, PaymentMethodStore, SettlementAccount, Store } = require('../../models');
  const { Op } = require('sequelize');
  const name = payment.method || payment.payment_method;
  if (typeof name !== 'string' || !name.trim() || name.length > 64) fail('收款方式不能为空且最多64字');
  // Preserve the order's own rule on edit; do not import a snapshot from a client.
  const previousRow = previous.find(row => row.payment_method === name);
  if (previousRow && !previousRow.coupon_snapshot) return null;
  const old = previousRow;
  if (old) return calculateCoupon(parse(old.coupon_snapshot).rule, payment.amount);
  const method = await PaymentMethod.findOne({ where: { [Op.or]: [{ name }, { code: name }] }, transaction });
  if (!method?.coupon_rule && ['商场优惠券', '抖音减满券', '抖音优惠券'].includes(String(method?.name || name))) fail('请先在收款方式中配置优惠券分担方案，再用于新订单');
  if (!method?.coupon_rule) return null;
  if (Number(method.status) !== 1) fail('优惠券方案已停用');
  if (!Number(method.is_global)) {
    const scope = await PaymentMethodStore.findOne({ where: { method_id: method.method_id, store_id: storeId }, transaction });
    if (!scope) fail('该优惠券方案不适用当前门店');
  }
  const rule = normalizeRule(method.coupon_rule);
  if (!isActiveToday(rule)) fail('优惠券方案不在有效期内');
  const ids = [...new Set([rule.mallAccountId, rule.platformAccountId].filter(Boolean))];
  const accounts = await SettlementAccount.findAll({ where: { account_id: { [Op.in]: ids }, status: 1 }, transaction });
  const store = await Store.findByPk(storeId, { transaction });
  if (!store || accounts.length !== ids.length || accounts.some(a =>
    a.account_type !== 'FUND' ||
    (a.distributor_id && String(a.distributor_id) !== String(store.distributor_id)))) fail('优惠券返款账户已停用或不适用当前门店经销商');
  if (name.length > 50 || String(method.name || name).length > 50) fail('优惠券方案名称或编码最多50字');
  return calculateCoupon(rule, payment.amount);
}
function isActiveToday(value) {
  if (!value) return true;
  const rule=normalizeRule(value);
  const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  return (!rule.validFrom || today>=rule.validFrom) && (!rule.validTo || today<=rule.validTo);
}
module.exports = { isActiveToday, normalizeRule, calculateCoupon, settlementLines, reversalLines, expandSettlementPayments, paymentSnapshot };
