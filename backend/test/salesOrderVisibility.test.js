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
  assert.equal(_test.canQueryAllSalesOrders({ roleCode: 'finance' }), true);
  assert.equal(_test.canQueryAllSalesOrders({ roleCode: 'clerk' }), false);
});

test('订单导出字段与附件保持 58 列明细结构', () => {
  assert.equal(_test.ORDER_EXPORT_HEADERS.length, 58);
  assert.equal(_test.ORDER_EXPORT_HEADERS[0], '订单编号');
  assert.equal(_test.ORDER_EXPORT_HEADERS.at(-1), '操作人');
});

test('订单导出按商品明细展开并汇总收款方式', () => {
  const rows = _test.buildOrderExportRows([{
    toJSON: () => ({
      order_no: 'ORD-1',
      store_id: 'STORE-1',
      total_amount: 100,
      national_subsidy: 10,
      actual_payment: 90,
      order_status: 'completed',
      OrderPayments: [
        { payment_method: '现金', amount: 20 },
        { payment_method: '国补POS（电脑）-客户实收', amount: 70 }
      ],
      OrderItems: [{ product_name: '商品A', pn_code: 'PN-1', sale_price: 100, quantity: 1, subtotal: 100 }],
      Store: { name: '门店A' }
    })
  }]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].商品名称, '商品A');
  assert.equal(rows[0].现金, 20);
  assert.equal(rows[0]['国补POS（电脑）'], 70);
  assert.equal(rows[0].应收金额, 90);
});

test('经销商级国补照片查询按经销商过滤门店', () => {
  const query = _test.buildSubsidyPhotoQuery({ roles: ['finance'], distributorId: 'DIST-1' });
  assert.deepEqual(query.include[0].where, { distributor_id: 'DIST-1' });
  assert.equal(query.include[0].required, true);
});
