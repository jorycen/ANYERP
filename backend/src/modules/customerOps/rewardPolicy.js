'use strict';
const { cents } = require('./math');
function fail(message) { const error = new Error(message); error.status = 400; throw error; }
function money(value) {
  let amount; try { amount = cents(value); } catch (_) { fail('金额必须为非负且最多两位小数'); }
  if (amount > 999999999999n) fail('金额超出范围');
  return `${amount / 100n}.${String(amount % 100n).padStart(2, '0')}`;
}
function validate(b) {
  const result = {};
  for (const key of ['original_price', 'cash_required', 'coupon_value', 'coupon_min_spend']) result[key] = money(b[key] ?? '0');
  result.description = String(b.description || '').trim();
  result.coupon_scope = String(b.coupon_scope || '').trim();
  if (result.description.length > 10000 || result.coupon_scope.length > 512) fail('权益说明或使用范围过长');
  result.sort = b.sort ?? 0;
  if (!Number.isInteger(result.sort) || Math.abs(result.sort) > 1000000) fail('排序必须为整数');
  result.self_only = b.self_only !== false;
  for (const key of ['valid_start_time', 'valid_end_time']) {
    result[key] = b[key] ? new Date(b[key]) : null;
    if (result[key] && !Number.isFinite(result[key].getTime())) fail('有效时间格式错误');
  }
  if (result.valid_start_time && result.valid_end_time && result.valid_start_time >= result.valid_end_time) fail('结束时间必须晚于开始时间');
  if (b.kind === 'coupon') {
    if (!result.coupon_scope) fail('请填写优惠券使用范围');
    if (cents(result.cash_required) !== 0n) fail('优惠券仅支持纯积分兑换');
    if (cents(result.coupon_value) === 0n && !String(b.instructions || '').trim()) fail('服务券需要填写使用说明');
  }
  return result;
}
function availability(item, balance, used = 0, hasStore = true, now = new Date()) {
  const difference = BigInt(item.points) - BigInt(balance);
  let reason = '';
  if (!item.on_sale) reason = '已下架';
  else if (item.valid_start_time && new Date(item.valid_start_time) > now) reason = '尚未开始';
  else if (item.valid_end_time && new Date(item.valid_end_time) <= now) reason = '兑换已结束';
  else if (item.stock !== null && item.stock <= 0) reason = '已兑完';
  else if (!hasStore) reason = '暂无适用门店';
  else if (item.per_member_limit !== null && used >= item.per_member_limit) reason = '已达限兑次数';
  const eligible = !reason;
  if (!reason && difference > 0n) reason = `还差${difference}积分即可兑换`;
  return { points_shortfall: String(difference > 0n ? difference : 0n), can_exchange: !reason,
    eligible, availability_text: reason || '可兑换' };
}
function dto(row, state) {
  const item = row.toJSON ? row.toJSON() : row;
  return { ...item, type: item.kind === 'gift' ? 'product' : item.kind,
    points_required: String(item.points), cash_required: money(item.cash_required || '0'),
    status: item.on_sale ? 'active' : 'inactive', exchange_limit: item.per_member_limit, ...state };
}
function compare(a, b) {
  const rank = i => i.can_exchange ? 0 : i.eligible ? 1 : 2;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (rank(a) === 1) { const gap = BigInt(a.points_shortfall) - BigInt(b.points_shortfall); if (gap) return gap < 0n ? -1 : 1; }
  return (b.sort || 0) - (a.sort || 0) || String(a.id).localeCompare(String(b.id));
}
module.exports = { money, validate, availability, dto, compare };
