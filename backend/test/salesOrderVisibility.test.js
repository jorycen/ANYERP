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
  assert.equal(_test.canQueryAllSalesOrders({ roles: ['store_admin'] }), true);
  assert.equal(_test.canQueryAllSalesOrders({ roles: ['clerk'] }), false);
  assert.equal(_test.canQueryAllSalesOrders({ roles: ['staff'] }), false);
  assert.equal(_test.canQueryAllSalesOrders({ roles: ['manager', 'finance'] }), true);
  assert.equal(_test.canQueryAllSalesOrders({ roleCode: 'finance' }), true);
  assert.equal(_test.canQueryAllSalesOrders({ roleCode: 'clerk' }), false);
});

test('订单查询列表仅按创建时间倒序排列', () => {
  assert.deepEqual(_test.buildSalesOrderListOrder(), [['create_time', 'DESC']]);
});

test('店长角色可以导出授权门店订单，普通店员不能导出', () => {
  assert.equal(_test.canExportSalesOrders({ roles: ['manager'] }), true);
  assert.equal(_test.canExportSalesOrders({ roles: ['store_manager'] }), true);
  assert.equal(_test.canExportSalesOrders({ roles: ['store_admin'] }), true);
  assert.equal(_test.canExportSalesOrders({ roles: ['finance'] }), true);
  assert.equal(_test.canExportSalesOrders({ roles: ['clerk'] }), false);
  assert.equal(_test.canExportSalesOrders({ roles: ['staff'] }), false);
});

test('订单导出字段包含国补 POS/OMO 明细列', () => {
  assert.equal(_test.ORDER_EXPORT_HEADERS.length, 60);
  assert.equal(_test.ORDER_EXPORT_HEADERS[0], '订单编号');
  assert.equal(_test.ORDER_EXPORT_HEADERS[54], '补录信息');
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

test('订单导出的归档状态包含作废和退单状态', () => {
  assert.equal(_test.getOrderExportArchiveStatus('已归档'), '已归档');
  assert.equal(_test.getOrderExportArchiveStatus('completed'), '已归档');
  assert.equal(_test.getOrderExportArchiveStatus('voided'), '已作废');
  assert.equal(_test.getOrderExportArchiveStatus('cancelled'), '已取消');
  assert.equal(_test.getOrderExportArchiveStatus('return_pending'), '退库处理中');
  assert.equal(_test.getOrderExportArchiveStatus('returned'), '已退单');
  assert.equal(_test.getOrderExportArchiveStatus('已退单'), '已退单');
  assert.equal(_test.getOrderExportArchiveStatus('draft'), '');
});

test('订单导出按实际收款方式名称兼容历史列名', () => {
  const rows = _test.buildOrderExportRows([{
    toJSON: () => ({
      OrderPayments: [
        { payment_method: '线上OMO', amount: 10 },
        { payment_method: '龙湖POS', amount: 20 },
        { payment_method: '智店通 POS', amount: 30 },
        { payment_method: '二手回收抵扣', amount: 40 },
        { payment_method: 'deposit', amount: 5 },
        { payment_method: '未知收款方式', amount: 50 }
      ],
      OrderItems: [{ product_name: '商品A', subtotal: 150, quantity: 1 }]
    })
  }]);

  assert.equal(rows[0].线上OMO平台, 10);
  assert.equal(rows[0]['龙湖POS（北城专用）'], 20);
  assert.equal(rows[0].智店通POS, 30);
  assert.equal(rows[0].旧机回收抵扣, 40);
  assert.equal(rows[0].定金抵扣, 5);
  assert.equal(rows[0].其他收款方式2, 50);
  assert.equal(rows[0].收款金额汇总, 155);
});

test('订单导出中不开票时开票金额为0', () => {
  const noInvoiceRows = _test.buildOrderExportRows([{
    toJSON: () => ({
      invoice_status: '不开票',
      invoice_amount: 999,
      OrderItems: [{ product_name: '商品A', subtotal: 100, quantity: 1 }]
    })
  }]);
  const invoicedRows = _test.buildOrderExportRows([{
    toJSON: () => ({
      invoice_status: '普通发票',
      invoice_amount: 999,
      OrderItems: [{ product_name: '商品A', subtotal: 100, quantity: 1 }]
    })
  }]);

  assert.equal(noInvoiceRows[0].开票金额, 0);
  assert.equal(invoicedRows[0].开票金额, 999);
});

test('订单导出按销售人和辅助销售人顺序展示名称', () => {
  const rows = _test.buildOrderExportRows([{
    toJSON: () => ({
      create_user: '销售人',
      total_amount: 100,
      auxiliary_sales_list: [
        { name: '辅助销售人1', allocation_type: 'amount', amount: 30 },
        { name: '辅助销售人2', allocation_type: 'amount', amount: 20 }
      ],
      OrderItems: [{ product_name: '商品A', subtotal: 100, quantity: 1 }]
    })
  }]);

  assert.equal(rows[0].辅助销售人比例分配, '销售人/辅助销售人1/辅助销售人2');
  assert.equal(rows[0].辅助销售人金额分配, '辅助销售人1:30；辅助销售人2:20');
});

test('订单导出没有辅助销售金额明细时显示0，不按订单总额平均拆分', () => {
  const rows = _test.buildOrderExportRows([{
    toJSON: () => ({
      create_user: '销售人',
      total_amount: 100,
      auxiliary_sales_list: [{ name: '辅助销售人1' }],
      OrderItems: [{ product_name: '商品A', subtotal: 100, quantity: 1 }]
    })
  }]);

  assert.equal(rows[0].辅助销售人金额分配, 0);
});

test('销售退货导出以负数展示数量和商品金额', () => {
  const rows = _test.buildSalesReturnSettlementExportRows([{
    toJSON: () => ({
      return_no: 'RET-001',
      order_no: 'ORD-001',
      user_receivable_amount: -100,
      customer_received_amount: -85,
      items: [{
        product_name: '商品A',
        product_id: 'P-001',
        Product: { product_code: 'PRD-001', manufacturer_code: 'MFR-001' },
        quantity: -1,
        user_receivable_amount: -100,
        customer_received_amount: -85,
        policy_subsidy_receivable_amount: -10,
        education_subsidy_amount: -5
      }]
    })
  }]);

  assert.equal(rows[0].订单编号, 'RET-001');
  assert.equal(rows[0].数量, -1);
  assert.equal(rows[0].商品编码, 'MFR-001');
  assert.equal(rows[0].订单总计, -100);
  assert.equal(rows[0].单价, 100);
  assert.equal(rows[0].小计, -100);
  assert.equal(rows[0].商品应收金额, -100);
  assert.equal(rows[0].商品收款金额, -85);
  assert.equal(rows[0].国补, -10);
  assert.equal(rows[0].教育补贴, -5);
  assert.equal(rows[0].其他收款方式2, -85);
  assert.match(rows[0].备注, /ORD-001/);
});

test('历史退单明细金额为0时按原销售订单补算负向金额', () => {
  const rows = _test.buildSalesReturnSettlementExportRows([{
    toJSON: () => ({
      return_no: 'RET-003',
      order_id: 'ORD-003',
      items: [{
        order_item_id: 3,
        product_id: 'P-003',
        product_name: '历史商品',
        quantity: -1,
        user_receivable_amount: 0,
        customer_received_amount: 0
      }]
    })
  }], {
    returnOrderById: new Map([
      ['ORD-003', {
        order_id: 'ORD-003',
        total_amount: 100,
        discount_amount: 0,
        actual_payment: 100,
        OrderItems: [{
          item_id: 3,
          product_id: 'P-003',
          sale_price: 100,
          quantity: 1,
          use_gov_subsidy: 0,
          use_edu_subsidy: 0
        }]
      }]
    ])
  });

  assert.equal(rows[0].数量, -1);
  assert.equal(rows[0].单价, 100);
  assert.equal(rows[0].小计, -100);
  assert.equal(rows[0].商品应收金额, -100);
  assert.equal(rows[0].商品收款金额, -100);
});

test('订单导出商品编码列使用厂商编码，不使用内部商品编码', () => {
  const rows = _test.buildOrderExportRows([{
    toJSON: () => ({
      OrderItems: [{
        product_name: '商品A',
        product_code: 'PRD-001',
        pn_code: 'MFR-001',
        quantity: 1,
        subtotal: 100,
        Product: { product_code: 'PRD-001', manufacturer_code: 'MFR-MASTER-001' }
      }]
    })
  }]);

  assert.equal(rows[0].商品编码, 'MFR-001');
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

test('订单导出包含完整金额补录信息', () => {
  const rows = _test.buildOrderExportRows([{
    toJSON: () => ({
      OrderItems: [{ product_name: '商品A', subtotal: 100, quantity: 1 }],
      supplements: [
        { item_name: '教育优惠', amount: 20, amount_type: 'decrease', content: '学生证已核验' },
        { item_name: '提货费用', amount: 15, amount_type: 'increase' },
        { item_name: '优惠券', amount: 30, amount_type: 'increase', coupon_code: 'COUPON-1' }
      ]
    })
  }]);

  assert.equal(rows[0].补录教育优惠, -20);
  assert.equal(rows[0].商品提货运费, 15);
  assert.equal(rows[0].补录信息, '教育优惠:20(减少，学生证已核验)；提货费用:15(增加)；优惠券:30(增加，券码:COUPON-1)');
});

test('负毛利订单按店长初审和经销商总权限复审严格串行', () => {
  assert.equal(_test.salesApprovalStageFromStatus('pending_approval'), 'store');
  assert.equal(_test.salesApprovalStageFromStatus('pending_store_approval'), 'store');
  assert.equal(_test.salesApprovalStageFromStatus('pending_distributor_approval'), 'distributor');
  assert.equal(_test.canApproveSalesStage({ roles: ['store_manager'] }, 'store'), true);
  assert.equal(_test.canApproveSalesStage({ roles: ['store_admin'] }, 'store'), true);
  assert.equal(_test.canApproveSalesStage({ roles: ['admin'] }, 'store'), true);
  assert.equal(_test.canApproveSalesStage({ roles: ['distributor'] }, 'store'), true);
  assert.equal(_test.canApproveSalesStage({ roles: ['admin'] }, 'distributor'), true);
  assert.equal(_test.canApproveSalesStage({ roles: ['boss'] }, 'distributor'), true);
  assert.equal(_test.canApproveSalesStage({ roles: ['manager'] }, 'distributor'), false);
  assert.equal(_test.canApproveSalesStage({ roles: ['store_manager', 'admin'] }, 'store'), true);
  assert.equal(_test.canApproveSalesStage({ roles: ['store_manager', 'admin'] }, 'distributor'), true);
});

test('订单导出按国补 OMO 客户实收归入对应收款方式列', () => {
  const rows = _test.buildOrderExportRows([{
    toJSON: () => ({
      OrderPayments: [
        { payment_method: '国补OMO（电脑）-客户实收', amount: 8500 },
        { payment_method: '国补OMO（手机平板）-政策补贴应收', amount: 500 }
      ],
      OrderItems: [{ product_name: '电脑A', subtotal: 9000, quantity: 1 }]
    })
  }]);

  assert.equal(rows[0]['国补OMO（电脑）'], 8500);
  assert.equal(rows[0]['国补OMO（手机平板）'], 500);
});

test('订单导出兼容驼峰补录字段和毛利快照补录明细', () => {
  const rows = _test.buildOrderExportRows([{
    toJSON: () => ({
      OrderItems: [{ product_name: '商品A', subtotal: 100, quantity: 1 }],
      grossProfitSnapshot: {
        supplementDetails: [
          { itemName: '教育优惠', amount: '20.00', amountType: 'decrease' },
          { itemName: '提货费用', amount: '15.00', amountType: 'increase' }
        ]
      }
    })
  }]);

  assert.equal(rows[0].补录教育优惠, -20);
  assert.equal(rows[0].商品提货运费, 15);
  assert.equal(rows[0].补录信息, '教育优惠:20(减少)；提货费用:15(增加)');
});

test('订单详情补录净额按增加和减少方向计算', () => {
  assert.equal(_test.getSupplementNetAmount([
    { amount: 15, amount_type: 'increase' },
    { amount: 20, amount_type: 'decrease' },
    { amount: 5, amount_type: 'increase' }
  ]), 0);
  assert.equal(_test.getSupplementNetAmount([
    { amount: 30, amount_type: 'decrease' }
  ]), -30);
});

test('退单导出不把内部商品ID作为商品编码', () => {
  const rows = _test.buildSalesReturnSettlementExportRows([{
    toJSON: () => ({
      return_no: 'RET-002',
      items: [{ product_id: 'internal-product-id', product_name: '历史商品', quantity: -1 }]
    })
  }]);

  assert.equal(rows[0].商品编码, '');
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

test('定金管理排序优先当天，再按未归档和已归档，最后按时间倒序', () => {
  const order = _test.buildDepositListOrder();
  assert.match(order[0][0].val, /CURRENT_DATE\(\)/);
  assert.match(order[1][0].val, /status.*archived/);
  assert.deepEqual(order.slice(2), [
    ['create_time', 'DESC'],
    ['deposit_id', 'DESC']
  ]);
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
