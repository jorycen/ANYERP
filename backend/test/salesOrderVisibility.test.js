const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../src/modules/sales/controller');

test('经销商级角色可以查询全部人员订单，店员和店长保持受限范围', () => {
  assert.equal(_test.canQueryAllSalesOrders({ roles: ['finance'] }), true);
  assert.equal(_test.canQueryAllSalesOrders({ roles: ['cashier'] }), true);
  assert.equal(_test.canQueryAllSalesOrders({ roles: ['business'] }), true);
  assert.equal(_test.canQueryAllSalesOrders({ roles: ['manager'] }), true);
  assert.equal(_test.canQueryAllSalesOrders({ roles: ['store_manager'] }), true);
  assert.equal(_test.canQueryAllSalesOrders({ roles: ['clerk'] }), false);
  assert.equal(_test.canQueryAllSalesOrders({ roles: ['staff'] }), false);
  assert.equal(_test.canQueryAllSalesOrders({ roles: ['manager', 'finance'] }), true);
});
