const test = require('node:test');
const assert = require('node:assert/strict');
const { cents, makeSnapshot, remaining, points } = require('../src/modules/customerOps/math');
test('decimal money is exact and unsafe money inputs are rejected', () => {
  assert.equal(cents('9999999999.99'), 999999999999n);
  for (const value of ['-1', '1.001', 'NaN', '1e6']) assert.throws(() => cents(value));
});
test('deposit is not counted twice; discounts and subsidy are removed once', () => {
  const snapshot = makeSnapshot({ discount_amount: '100', national_subsidy: '900', education_subsidy: '0', deposit_deduction_total: '500' },
    [{ item_id: 1, product_id: 'pc', sale_price: '6000', quantity: 1 }], { id: 'r', product_ids: ['pc'], numerator: '1', denominator: '100' });
  assert.equal(points(remaining(snapshot), snapshot), 5000n);
  assert.equal(points(remaining(snapshot, { 1: 1 }), snapshot), 0n);
});
test('partial return cumulative rounding reaches exact full reversal', () => {
  const snapshot = { numerator: '1', denominator: '100', lines: [{ item_id: 'a', quantity: 3, amount: '100001' }] };
  assert.equal(points(remaining(snapshot), snapshot), 1000n);
  assert.equal(points(remaining(snapshot, { a: 1 }), snapshot), 666n);
  assert.equal(points(remaining(snapshot, { a: 2 }), snapshot), 333n);
  assert.equal(points(remaining(snapshot, { a: 3 }), snapshot), 0n);
  assert.throws(() => remaining(snapshot, { a: 4 }));
});
test('unselected products never earn points', () => {
  const snapshot = makeSnapshot({}, [{ item_id: 1, product_id: 'gift', sale_price: '100', quantity: 1 }], { product_ids: ['pc'], numerator: '1', denominator: '100' });
  assert.equal(remaining(snapshot), 0n);
});
