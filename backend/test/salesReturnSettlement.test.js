const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isSubsidyEligibleItem,
  orderReceivable
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
