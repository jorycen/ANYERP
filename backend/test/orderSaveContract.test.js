const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('../src/modules/sales/orderSaveContract');

test('单价只接受一致别名，区分缺失、空值与明确零元', () => {
  assert.deepEqual(contract.lineAmounts({ unitPrice: 0, quantity: 2, subtotal: 999 }), { sale_price: 0, quantity: 2, subtotal: 0 });
  assert.equal(contract.lineAmounts({ quantity: 1 }).sale_price, undefined);
  for (const value of ['', null, false, [1], {}, -1, 'abc', Infinity, '1.001']) assert.throws(() => contract.lineAmounts({ unitPrice: value, quantity: 1 }));
  assert.throws(() => contract.lineAmounts({ unitPrice: 0, sale_price: 14468, quantity: 1 }), /冲突/);
  assert.equal(contract.lineAmounts({ unitPrice: '14468.00', sale_price: 14468, quantity: 1 }).subtotal, 14468);
});
test('小计只能由单价数量生成，按分计算，拒绝非法数量和溢出', () => {
  assert.equal(contract.lineAmounts({ salePrice: 0.29, quantity: 3, subtotal: 999 }).subtotal, 0.87);
  for (const quantity of [0, -1, 1.5, '', null]) assert.throws(() => contract.lineAmounts({ salePrice: 1, quantity }));
  assert.throws(() => contract.subtotal(9999999999, 9999999));
});
test('创建与编辑共用整单金额，优惠超额不再被截断为零元', () => {
  assert.deepEqual(contract.orderTotals([{ subtotal: 14468 }], { nationalSubsidy: 1500 }), { totalAmount: 14468, payableBeforeDeposit: 12968, actualPayment: 12968 });
  assert.deepEqual(contract.orderTotals([{ subtotal: 0 }]), { totalAmount: 0, payableBeforeDeposit: 0, actualPayment: 0 });
  assert.equal(contract.orderTotals([{ subtotal: 0.1 }, { subtotal: 0.2 }]).totalAmount, 0.3);
  assert.throws(() => contract.orderTotals([{ subtotal: 0 }], { nationalSubsidy: 1500 }), /超过商品金额/);
  assert.throws(() => contract.orderTotals([{ subtotal: 100 }], { discount: -1 }), /格式/);
  assert.throws(() => contract.orderTotals([{ subtotal: 100 }], { deposit: 101 }), /定金抵扣/);
});
test('版本覆盖订单、商品及收款，不受属性或行顺序影响', () => {
  const order = { order_id: 'O', invoice_amount: 0, deposit_items: [{ amount: 20 }] };
  const items = [{ item_id: 1, sale_price: 20 }, { item_id: 2, sale_price: 0 }];
  const original = contract.revision(order, items, [{ amount: 20 }]);
  assert.equal(original, contract.revision(order, [...items].reverse(), [{ amount: 20 }]));
  assert.notEqual(original, contract.revision({ ...order, invoice_amount: 1 }, items, [{ amount: 20 }]));
  assert.notEqual(original, contract.revision(order, items, [{ amount: 21 }]));
  assert.notEqual(original, contract.revision({ ...order, deposit_items: [{ amount: 21 }] }, items, [{ amount: 20 }]));
});
test('保存后回读版本、相同请求重放、旧版本和冲突请求拒绝', async () => {
  let price = '14468.00', log;
  const order = { order_id: 'O', total_amount: '14468.00' };
  const models = {
    Order: { findByPk: async () => order },
    OrderItem: { findAll: async () => [{ item_id: 1, sale_price: price, quantity: 1, subtotal: price }] },
    OrderPayment: { findAll: async () => [] },
    BusinessActionLog: { findOne: async ({ where }) => log?.business_no === where.business_no ? log : null, create: async data => { log = data; } }
  };
  const user = { staffId: 1 };
  const body = { saveContract: 1, requestId: 'request-1234', expectedRevision: (await contract.snapshot(models, order)).saveRevision };
  const token = await contract.begin(models, order, body, user, {});
  price = '14300.00';
  const response = await contract.finish(models, order, body, user, {}, token, { status: 'saved' });
  assert.equal(response.savedOrder.items[0].unitPrice, '14300.00');
  assert.equal(response.saveRevision, (await contract.snapshot(models, order)).saveRevision);
  assert.deepEqual((await contract.begin(models, order, body, user, {})).replay, JSON.parse(JSON.stringify(response)));
  await assert.rejects(contract.begin(models, order, { ...body, x: 1 }, user, {}), /内容不一致/);
  await assert.rejects(contract.begin(models, order, { ...body, requestId: 'request-next' }, user, {}), /其他操作更新/);
});
