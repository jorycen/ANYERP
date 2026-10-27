const crypto = require('node:crypto');

function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function numberInput(value, name, integer = false) {
  if (value === null || value === undefined || String(value).trim() === '') fail(`${name}不能为空`);
  if (typeof value !== 'number' && typeof value !== 'string') fail(`${name}格式不正确`);
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (integer ? !Number.isSafeInteger(n) || n === 0 : Math.abs(n * 100 - Math.round(n * 100)) > 0.00001)) fail(`${name}格式不正确`);
  return n;
}
function aliases(input, keys, name, integer = false) {
  const present = keys.filter(key => Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined);
  if (!present.length) return undefined;
  const values = present.map(key => numberInput(input[key], name, integer));
  if (values.some(value => value !== values[0])) fail(`${name}存在冲突字段，请刷新后重新填写`);
  return values[0];
}
function lineAmounts(input) {
  const sale_price = aliases(input, ['unitPrice', 'salePrice', 'sale_price', 'SALE_PRICE', 'unit_price', 'price'], '销售单价');
  const quantity = aliases(input, ['quantity', 'QUANTITY'], '数量', true);
  return { sale_price, quantity, subtotal: sale_price === undefined || quantity === undefined ? undefined : subtotal(sale_price, quantity) };
}
function subtotal(price, quantity) {
  const cents = Math.round(numberInput(price, '销售单价') * 100) * numberInput(quantity, '数量', true);
  if (!Number.isSafeInteger(cents) || cents > 999999999999) fail('商品金额超过允许范围');
  return cents / 100;
}
function orderTotals(items, { discount = 0, nationalSubsidy = 0, educationSubsidy = 0, deposit = 0 } = {}) {
  const cents = (value, label) => Math.round(numberInput(value, label) * 100);
  const total = items.reduce((sum, item) => sum + cents(item.subtotal, '商品小计'), 0);
  const deductions = cents(discount, '订单优惠') + cents(nationalSubsidy, '国补金额') + cents(educationSubsidy, '教育补贴');
  const depositCents = cents(deposit, '定金抵扣');
  if (!Number.isSafeInteger(total) || total > 999999999999) fail('订单金额超过允许范围');
  if (deductions > total) fail('订单优惠与补贴超过商品金额');
  if (depositCents > total - deductions) fail('定金抵扣金额不能超过订单应付金额');
  return { totalAmount: total / 100, payableBeforeDeposit: (total - deductions) / 100, actualPayment: (total - deductions - depositCents) / 100 };
}
function revision(order, items, payments) {
  const plain = row => {
    if (!row?.get) return row;
    const data = row.get({ plain: true });
    return Object.fromEntries(Object.keys(row.constructor.rawAttributes).sort().map(key => [key, data[key]]));
  };
  const sorted = rows => rows.map(plain).map(row => Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]]))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return digest([sorted([order]), sorted(items), sorted(payments)]);
}
async function snapshot(models, order, transaction) {
  const persisted = await models.Order.findByPk(order.order_id, { transaction });
  const options = { where: { order_id: order.order_id }, transaction };
  const items = await models.OrderItem.findAll(options);
  const payments = await models.OrderPayment.findAll(options);
  return { order: persisted, items, payments, saveRevision: revision(persisted, items, payments) };
}
async function begin(models, order, body, user, transaction) {
  if (body.saveContract !== 1 && !body.expectedRevision) return null;
  if (!/^[a-f0-9]{64}$/.test(body.expectedRevision || '') || !/^[\w-]{8,64}$/.test(body.requestId || '')) fail('订单保存凭据缺失，请刷新订单后重试');
  const hash = digest(body);
  const prior = await models.BusinessActionLog.findOne({ where: { business_type: 'sales_save', business_id: order.order_id, business_no: body.requestId }, transaction });
  if (prior) {
    const saved = JSON.parse(prior.detail_json);
    if (saved.hash !== hash || String(prior.actor_staff_id || '') !== String(user.staffId || '')) fail('重复请求内容不一致', 409);
    return { replay: saved.response };
  }
  const current = await snapshot(models, order, transaction);
  if (current.saveRevision !== body.expectedRevision) fail('订单已被其他操作更新，请刷新后重新编辑，当前修改未保存', 409);
  return { hash, before: {
    saveRevision: current.saveRevision,
    totalAmount: current.order.total_amount,
    invoiceAmount: current.order.invoice_amount,
    items: current.items.map(item => ({ itemId: item.item_id, unitPrice: item.sale_price, quantity: item.quantity, subtotal: item.subtotal })),
    payments: current.payments.map(payment => ({ method: payment.payment_method, amount: payment.amount }))
  } };
}
async function finish(models, order, body, user, transaction, token, response) {
  const current = await snapshot(models, order, transaction);
  order = current.order;
  const result = { ...response, saveRevision: current.saveRevision, savedOrder: {
    orderId: order.order_id, totalAmount: order.total_amount, actualPayment: order.actual_payment,
    invoiceAmount: order.invoice_amount,
    items: current.items.map(item => ({ itemId: item.item_id, unitPrice: item.sale_price, quantity: item.quantity, subtotal: item.subtotal })),
    payments: current.payments.map(payment => ({ method: payment.payment_method, amount: payment.amount }))
  } };
  if (token) {
    await models.BusinessActionLog.create({ log_id: crypto.randomUUID().replace(/-/g, ''), business_type: 'sales_save', business_id: order.order_id, business_no: body.requestId, action: 'saved', actor_staff_id: user.staffId || null, actor_name: user.name || '', detail_json: JSON.stringify({ hash: token.hash, before: token.before, response: result }), create_time: new Date() }, { transaction });
  }
  return result;
}
module.exports = { numberInput, lineAmounts, subtotal, orderTotals, revision, snapshot, begin, finish };
