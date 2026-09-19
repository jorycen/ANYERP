const test = require('node:test');
const assert = require('node:assert/strict');
const runtime = require('../src/modules/approval/businessRuntime');
const models = require('../src/models');
const targets = [
  ['退库', '../src/modules/inventory/controller', 'getReturnList', 'return_stock'],
  ['采购', '../src/modules/purchase/controller', 'getRequestList', 'purchase_request'],
  ['商品', '../src/modules/product/controller', 'getProductApplicationList', 'product_application'],
  ['销售退单', '../src/modules/sales/controller', 'listSalesReturnRequests', 'sales_return'],
  ['退定金', '../src/modules/sales/controller', 'listDepositRefunds', 'deposit_refund'],
  ['采购报销', '../src/modules/finance/controller', 'getExpenseList', 'purchase_expense'],
  ['国补差额', '../src/modules/finance/controller', 'getSubsidyAdjustments', 'subsidy_receivable_adjustment'],
  ['资源套回', '../src/modules/inventory/resourceRights', 'listChanges', 'resource_claim'],
  ['毛利调整', '../src/modules/report/profitAdjustmentController', 'listProfitAdjustments', 'profit_adjustment'],
  ['费用分摊', '../src/modules/finance/expenseAccountingController', 'listExpensePerformanceAllocations', 'expense_performance_allocation'],
  ['批量库存', '../src/modules/inventory/batchMaintenance', 'listBatchApplications', 'inventory_batch']
];
for (const [label, path, method, type] of targets) {
  test(label + '待审批接口使用统一任务权限，不再按旧角色提前拦截', async t => {
    t.mock.method(models.sequelize, 'query', async () => { throw new Error('unexpected database access'); });
    const expected = { code: 0, data: { list: [{ can_review: true }], total: 1 } };
    const check = t.mock.method(runtime, 'reviewList', async (ctx, actualType) => {
      assert.equal(actualType, type);
      assert.equal(ctx.state.user.roles[0], 'clerk');
      ctx.body = expected;
      return true;
    });
    const ctx = { state: { user: { staffId: 2, roles: ['clerk'], accessibleStoreIds: ['S1'] } }, query: { scope: 'review' } };
    await require(path)[method](ctx);
    assert.equal(check.mock.calls.length, 1);
    assert.equal(ctx.body, expected);
  });
}
