const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
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

test('经销商级国补照片查询按分配门店过滤', () => {
  const query = _test.buildSubsidyPhotoQuery({ roles: ['finance'], distributorId: 'DIST-1', accessibleStoreIds: ['STORE-1', 'STORE-2'] });
  assert.deepEqual(query.where.store_id[Op.in], ['STORE-1', 'STORE-2']);
  assert.equal(query.include[0].where, undefined);

  const storeQuery = _test.buildSubsidyPhotoQuery(
    { roles: ['finance'], distributorId: 'DIST-1', accessibleStoreIds: ['STORE-1', 'STORE-2'] },
    { storeId: 'STORE-2', startDate: '2026-08-01', endDate: '2026-08-07' }
  );
  assert.equal(storeQuery.where.store_id, 'STORE-2');
  assert.ok(storeQuery.where.create_time[Op.gte] instanceof Date);
  assert.ok(storeQuery.where.create_time[Op.lte] instanceof Date);
  assert.equal(storeQuery.where.create_time[Op.gte].toISOString(), '2026-07-31T16:00:00.000Z');
  assert.equal(storeQuery.where.create_time[Op.lte].toISOString(), '2026-08-07T15:59:59.999Z');

  const unauthorizedQuery = _test.buildSubsidyPhotoQuery(
    { roles: ['finance'], distributorId: 'DIST-1', accessibleStoreIds: ['STORE-1'] },
    { storeId: 'STORE-2' }
  );
  assert.equal(unauthorizedQuery.where.store_id, '__NO_ACCESS__');
});

test('销售订单和国补照片日期筛选使用中国时区的完整日期边界', () => {
  const onlyStart = _test.buildChinaDateRange('2026-08-01', '');
  assert.equal(onlyStart[Op.gte].toISOString(), '2026-07-31T16:00:00.000Z');
  assert.equal(onlyStart[Op.lte], undefined);

  const onlyEnd = _test.buildChinaDateRange('', '2026-08-07');
  assert.equal(onlyEnd[Op.gte], undefined);
  assert.equal(onlyEnd[Op.lte].toISOString(), '2026-08-07T15:59:59.999Z');

  const fullRange = _test.buildChinaDateRange('2026-08-01', '2026-08-07');
  assert.equal(fullRange[Op.gte].toISOString(), '2026-07-31T16:00:00.000Z');
  assert.equal(fullRange[Op.lte].toISOString(), '2026-08-07T15:59:59.999Z');
});
