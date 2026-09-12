'use strict';
function cents(value) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value ?? '0'));
  if (!match) throw new Error('金额必须为非负且最多两位小数');
  return BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
}
function points(amount, rule) { return BigInt(amount) * BigInt(rule.numerator) / BigInt(rule.denominator); }
function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (!sum) return weights.map(() => 0n);
  let used = 0n;
  return weights.map((weight, index) => {
    const value = index === weights.length - 1 ? total - used : total * weight / sum;
    used += value; return value;
  });
}
function makeSnapshot(order, items, rule) {
  const weights = items.map(i => cents(i.sale_price) * BigInt(i.quantity));
  const gross = weights.reduce((a, b) => a + b, 0n);
  const deduction = cents(order.discount_amount) + cents(order.national_subsidy) + cents(order.education_subsidy);
  if (deduction > gross) throw new Error('订单优惠与补贴超过商品金额，须先核对订单');
  const nets = allocate(gross - deduction, weights);
  const eligible = new Set((rule.product_ids || []).map(String));
  return { numerator: String(rule.numerator), denominator: String(rule.denominator), rule_id: rule.id,
    lines: items.map((item, index) => ({ item_id: String(item.item_id), quantity: Number(item.quantity),
      amount: (!eligible.size || eligible.has(String(item.product_id))) ? String(nets[index]) : '0' })) };
}
function remaining(snapshot, returned = {}) {
  return snapshot.lines.reduce((sum, line) => {
    const qty = Number(returned[line.item_id] || 0);
    if (!Number.isInteger(qty) || qty < 0 || qty > line.quantity) throw new Error('退货数量与原订单不一致');
    return sum + BigInt(line.amount) * BigInt(line.quantity - qty) / BigInt(line.quantity);
  }, 0n);
}
module.exports = { cents, points, allocate, makeSnapshot, remaining };
