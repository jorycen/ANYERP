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

test('订单导出按销售人和辅助销售人顺序展示名称', () => {
  const rows = _test.buildOrderExportRows([{
    toJSON: () => ({
      create_user: '销售人',
      auxiliary_sales_list: [
        { name: '辅助销售人1', ratio: 60, amount: 60 },
        { name: '辅助销售人2', ratio: 40, amount: 40 }
      ],
      OrderItems: [{ product_name: '商品A', subtotal: 100, quantity: 1 }]
    })
  }]);

  assert.equal(rows[0].辅助销售人比例分配, '销售人/辅助销售人1/辅助销售人2');
  assert.equal(rows[0].辅助销售人金额分配, '辅助销售人1:60；辅助销售人2:40');
});

test('订单导出按主商品分摊国补，配件国补字段留空并按商品行分摊收款', () => {
  const rows = _test.buildOrderExportRows([{
    toJSON: () => ({
      order_no: 'ORD-2',
      total_amount: 1200,
      national_subsidy: 200,
      OrderPayments: [{ payment_method: '现金', amount: 1200 }],
      OrderItems: [
        {
          product_name: '笔记本电脑',
          subtotal: 1000,
          quantity: 1,
          Product: { name: '笔记本电脑', category: '电脑/笔记本' }
        },
        {
          product_name: '无线鼠标',
          subtotal: 200,
          quantity: 1,
          Product: { name: '无线鼠标', category: '配件' }
        }
      ]
    })
  }]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].国补, 200);
  assert.equal(rows[1].国补, '');
  assert.equal(rows[0].国补状态, '');
  assert.equal(rows[1].国补状态, '');
  assert.equal(rows[0].现金, 1000);
  assert.equal(rows[1].现金, 200);
  assert.equal(rows[0].现金 + rows[1].现金, 1200);
});

test('定金订单进入销售导出并按实际收款方式归列', () => {
  const rows = _test.buildDepositExportRows([{
    toJSON: () => ({
      deposit_id: 'DEP-1',
      deposit_no: 'DEP-001',
      amount: 500,
      payment_method: '现金',
      customer_name: '客户A',
      status: 'available',
      Store: { name: '门店A' }
    })
  }]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].订单编号, 'DEP-001');
  assert.equal(rows[0].预留字段1, '定金收款');
  assert.equal(rows[0].现金, 500);
  assert.equal(rows[0].订单状态, '定金收款');
  assert.equal(rows[0].收款金额汇总, 500);
});

test('合并销售列表中的定金记录使用定金业务类型和订单兼容字段', () => {
  const row = _test.normalizeDepositListRow({
    toJSON: () => ({ deposit_id: 'DEP-2', deposit_no: 'DEP-002', amount: 300 })
  });
  assert.equal(row.record_type, 'deposit');
  assert.equal(row.order_id, 'DEP-2');
  assert.equal(row.order_no, 'DEP-002');
  assert.equal(row.order_status, 'deposit_receipt');
  assert.equal(row.actual_payment, 300);
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
