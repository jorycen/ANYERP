const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isSubsidyEligibleItem,
  orderReceivable,
  mergeReturnItemsWithOrderResources,
  _test
} = require('../src/modules/sales/salesReturnSettlement');

test('销售退单按用户应收计算，只扣除普通折扣', () => {
  assert.equal(orderReceivable({
    total_amount: 1000,
    discount_amount: 50,
    national_subsidy: 150,
    education_subsidy: 100
  }), 950);
});

test('电脑、手机、平板或已有补贴权益的商品触发国补/教育补贴退回', () => {
  assert.equal(isSubsidyEligibleItem({ product_name: '笔记本电脑', use_gov_subsidy: 0 }), true);
  assert.equal(isSubsidyEligibleItem({ product_name: '手机壳配件', use_gov_subsidy: 0 }), false);
  assert.equal(isSubsidyEligibleItem({ product_name: '普通商品', use_edu_subsidy: 1 }), true);
});

test('全额退单使用订单明细销售价计算客户退款，不依赖预加载关联', () => {
  const result = _test.calculateReturnSettlementAmounts({
    order: { total_amount: 15999, discount_amount: 0, actual_payment: 14499, national_subsidy: 1500 },
    orderItems: [
      { sale_price: 15999, quantity: 1, use_gov_subsidy: 1 },
      { sale_price: 0, quantity: 1 }
    ],
    requestItems: [
      { unit_price: 15999, quantity: 1, use_gov_subsidy: 1 },
      { unit_price: 0, quantity: 1 }
    ]
  });
  assert.deepEqual(result, {
    orderGross: 15999,
    returnGross: 15999,
    returnedReceivable: 15999,
    eligibleOrderGross: 15999,
    eligibleReturnGross: 15999,
    policyAmount: 1500,
    educationAmount: 0,
    customerRefundAmount: 14499
  });
});

test('国补退单按日结实际到账退款并独立退回补贴权益', () => {
  const orderItems = [
    { item_id: 8547, sale_price: 4353, quantity: 1, selected_resource_types: '["GOV_SUBSIDY"]', use_gov_subsidy: 1 },
    { item_id: 8548, sale_price: 0, quantity: 1, selected_resource_types: '[]' }
  ];
  const requestItems = mergeReturnItemsWithOrderResources(orderItems, [
    { order_item_id: 8547, unit_price: 4353, quantity: 1 },
    { order_item_id: 8548, unit_price: 0, quantity: 1 }
  ]);
  const result = _test.calculateReturnSettlementAmounts({
    order: {
      total_amount: 4452,
      discount_amount: 0,
      actual_payment: 3799.05,
      national_subsidy: 652.95,
      education_subsidy: 0
    },
    orderItems,
    requestItems,
    customerReceiptAmount: 3776.85
  });

  assert.equal(result.returnedReceivable, 4452);
  assert.equal(result.customerRefundAmount, 3776.85);
  assert.equal(result.policyAmount, 652.95);
});

test('部分退单按商品金额比例分摊日结实际到账', () => {
  const result = _test.calculateReturnSettlementAmounts({
    order: { total_amount: 1000, actual_payment: 800, national_subsidy: 200 },
    orderItems: [
      { item_id: 1, sale_price: 600, quantity: 1, use_gov_subsidy: 1 },
      { item_id: 2, sale_price: 400, quantity: 1 }
    ],
    requestItems: [{ order_item_id: 2, unit_price: 400, quantity: 1 }],
    customerReceiptAmount: 790
  });

  assert.equal(result.customerRefundAmount, 316);
});

test('退单结算相关迁移、财务确认路由和导出字段已注册', () => {
  const fs = require('fs');
  const migration = fs.readFileSync(require.resolve('../src/utils/dbMigration.js'), 'utf8');
  const routes = fs.readFileSync(require.resolve('../src/modules/sales/routes.js'), 'utf8');
  const controller = fs.readFileSync(require.resolve('../src/modules/sales/controller.js'), 'utf8');
  assert.match(migration, /T_SALES_RETURN_SETTLEMENT/);
  assert.match(migration, /T_SALES_RETURN_RED_INVOICE/);
  assert.match(routes, /refund-confirm/);
  assert.match(controller, /buildSalesReturnSettlementExportRows/);
  assert.match(controller, /redInvoice/);
});
