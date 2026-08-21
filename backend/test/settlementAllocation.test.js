const test = require('node:test');
const assert = require('node:assert/strict');
const {
  actualUnitPrice,
  getSettlementItemAvailableAmount,
  getOpenPayableStatus,
  getPayableRemaining,
  getExpenseStatus
} = require('../src/modules/finance/settlementAllocation');

test('purchase settlement unit price deducts per-unit rebate', () => {
  assert.equal(actualUnitPrice({ quantity: 10, unit_price: 100, rebate_deduction: 50 }), 95);
});

test('purchase settlement amount allocation uses remaining line amount', () => {
  const item = { quantity: 10, unit_price: 100, rebate_deduction: 50 };
  assert.equal(getSettlementItemAvailableAmount(item), 950);
  assert.equal(getSettlementItemAvailableAmount(item, 300), 650);
  assert.equal(getSettlementItemAvailableAmount(item, 1000), 0);
});

test('payable status distinguishes partial allocation from fully allocated', () => {
  assert.equal(getOpenPayableStatus(1000, 300, 0), 'partial_settled');
  assert.equal(getOpenPayableStatus(1000, 1000, 0), 'settling');
  assert.equal(getOpenPayableStatus(1000, 1000, 1000), 'paid');
});

test('reimbursement status distinguishes partial reimbursement from pending payment', () => {
  assert.equal(getExpenseStatus(1000, 300, 0, 'approved'), 'partial_reimbursement');
  assert.equal(getExpenseStatus(1000, 1000, 0, 'approved'), 'processing');
  assert.equal(getExpenseStatus(1000, 1000, 1000, 'approved'), 'paid');
});

test('purchase return remaining amount offsets unpaid payable before supplier credit', () => {
  assert.equal(getPayableRemaining(10000, 0, 2000), 8000);
  assert.equal(getPayableRemaining(10000, 9000, 1000), 0);
  assert.equal(getPayableRemaining(-2000, 0, 500), -1500);
});
