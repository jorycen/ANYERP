const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEditableOrderItem } = require('../../utils/model');

test('订单详情保存以当前商品输入字段覆盖历史商品字段', () => {
  const item = normalizeEditableOrderItem({
    itemId: 'ITEM_1',
    productName: '旧商品名称',
    name: '新商品名称',
    unitPrice: 999,
    price: '799.50',
    quantity: '2',
    subtotal: 999
  });

  assert.equal(item.productName, '新商品名称');
  assert.equal(item.unitPrice, 799.5);
  assert.equal(item.quantity, 2);
  assert.equal(item.subtotal, 1599);
});
