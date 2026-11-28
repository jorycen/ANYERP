const test = require('node:test');
const assert = require('node:assert/strict');
const { assertPurchaseExpenseReviewAllowed } = require('../src/modules/finance/controller');

test('采购申请被拒绝后，关联采购报销允许拒绝', () => {
  assert.doesNotThrow(() => assertPurchaseExpenseReviewAllowed('rejected', 'purchase', { status: 'rejected' }));
});

test('采购申请未通过时，关联采购报销不允许通过', () => {
  assert.throws(
    () => assertPurchaseExpenseReviewAllowed('approved', 'purchase', { status: 'rejected' }),
    /关联采购申请尚未审批通过/
  );
  assert.throws(
    () => assertPurchaseExpenseReviewAllowed('approved', 'purchase', null),
    /关联采购申请尚未审批通过/
  );
});

test('采购申请已通过时，关联采购报销允许通过', () => {
  assert.doesNotThrow(() => assertPurchaseExpenseReviewAllowed('approved', 'purchase', { status: 'approved' }));
});

test('非采购报销不受采购审批状态校验影响', () => {
  assert.doesNotThrow(() => assertPurchaseExpenseReviewAllowed('approved', 'expense', null));
});
