const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../src/modules/inventory/controller');

const sequelize = {
  literal(value) {
    return { literal: value };
  }
};

test('SN 查询按业务仓型优先级、库龄和状态更新时间在分页前排序', () => {
  const order = _test.buildSnListBusinessOrder(sequelize);

  assert.equal(order.length, 4);
  assert.equal(order[0][1], 'ASC');
  assert.match(order[0][0].literal, /status` = 'in_stock'.*inventory_type` = 'normal_qty' THEN 10/s);
  assert.match(order[0][0].literal, /inventory_type` = 'display_qty' THEN 20/s);
  assert.match(order[0][0].literal, /status` IN \('reserved', 'occupied'\).*inventory_type` = 'pending_qty'\) THEN 30/s);
  assert.match(order[0][0].literal, /inventory_type` = 'demo_qty' THEN 40/s);
  assert.match(order[0][0].literal, /inventory_type` = 'rental_demo_qty' THEN 50/s);
  assert.match(order[0][0].literal, /inventory_type` = 'unsellable_qty' THEN 60/s);
  assert.match(order[0][0].literal, /status` = 'sold' THEN 90/s);
  assert.match(order[0][0].literal, /ELSE 99/s);
  assert.deepEqual(order.slice(1).map(item => item[1]), ['ASC', 'DESC', 'DESC']);
  assert.match(order[1][0].literal, /COALESCE\(`ProductSn`\.`original_inbound_time`, `ProductSn`\.`inbound_time`\)/);
  assert.match(order[2][0].literal, /`ProductSn`\.`update_time`/);
  assert.equal(order[3][0].literal, '`ProductSn`.`sn_id`');
});

test('销售仓在库的排序优先级早于已销售 SN', () => {
  const prioritySql = _test.buildSnListBusinessOrder(sequelize)[0][0].literal;
  const priority = ({ status, inventoryType }) => {
    if (status === 'in_stock' && inventoryType === 'normal_qty') return 10;
    if (status === 'sold') return 90;
    return 99;
  };

  assert.match(prioritySql, /normal_qty' THEN 10/);
  assert.match(prioritySql, /status` = 'sold' THEN 90/);
  assert.ok(
    priority({ status: 'in_stock', inventoryType: 'normal_qty' })
      < priority({ status: 'sold', inventoryType: 'normal_qty' })
  );
});
