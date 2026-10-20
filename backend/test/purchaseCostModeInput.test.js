const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveIncomingCostMode, applyIncomingCostModes } = require('../src/modules/purchase/costModeInput');
test('legacy mini-program purchase-price selection overrides company-price product default', () => {
  for (const flag of [false, 0, '0', 'false']) {
    assert.equal(resolveIncomingCostMode({}, { useProductStandardPrice: flag }, { gross_profit_cost_mode: 'COMPANY_PRICE' }), 'PURCHASE_PRICE');
  }
});
test('whole-request selection overrides stale product modes; web per-line modes remain supported without a global flag', () => {
  assert.equal(resolveIncomingCostMode({ grossProfitCostMode: 'COMPANY_PRICE' }, { useProductStandardPrice: false }), 'PURCHASE_PRICE');
  assert.equal(resolveIncomingCostMode({ gross_profit_cost_mode: 'PURCHASE_PRICE' }, { useProductStandardPrice: true }), 'COMPANY_PRICE');
  assert.equal(resolveIncomingCostMode({ grossProfitCostMode: 'COMPANY_PRICE' }), 'COMPANY_PRICE');
  assert.equal(resolveIncomingCostMode({ gross_profit_cost_mode: 'PURCHASE_PRICE' }), 'PURCHASE_PRICE');
  assert.equal(resolveIncomingCostMode({ isUsedProduct: true, grossProfitCostMode: 'COMPANY_PRICE' }, { useProductStandardPrice: true }), 'PURCHASE_PRICE');
});
test('company-price selection and no-selection legacy fallback remain distinct', () => {
  assert.equal(resolveIncomingCostMode({}, { useProductStandardPrice: true }), 'COMPANY_PRICE');
  assert.equal(resolveIncomingCostMode({}, {}, { gross_profit_cost_mode: 'COMPANY_PRICE' }), 'COMPANY_PRICE');
  assert.equal(resolveIncomingCostMode({}, {}), 'PURCHASE_PRICE');
  assert.throws(() => resolveIncomingCostMode({}, { useProductStandardPrice: 'invalid' }), /无效/);
  assert.throws(() => resolveIncomingCostMode({ grossProfitCostMode: 'invalid' }), /无效/);
});

test('actual supplier guard accepts normalized purchase selection and still rejects company-price selection', async t => {
  const M = require('../src/models');
  const { _test } = require('../src/modules/purchase/controller');
  t.mock.method(M.Supplier, 'findOne', async () => ({ purchase_cost_mode_allowed: 'PURCHASE_PRICE' }));
  const ctx = { throw(status, message) { throw Object.assign(new Error(message), { status }); } };
  const items = [{ productId: 'P', gross_profit_cost_mode: 'COMPANY_PRICE' }];
  await assert.rejects(_test.assertSupplierCostModes(ctx, 'supplier', items), /允许范围/);
  applyIncomingCostModes(items, { useProductStandardPrice: false }, new Map([['P', { gross_profit_cost_mode: 'COMPANY_PRICE' }]]));
  await assert.doesNotReject(_test.assertSupplierCostModes(ctx, 'supplier', items));
  applyIncomingCostModes(items, { useProductStandardPrice: true }, new Map());
  await assert.rejects(_test.assertSupplierCostModes(ctx, 'supplier', items), /允许范围/);
});
test('normalized line values are used both for supplier validation and persisted draft items', () => {
  const products = new Map([['P', { gross_profit_cost_mode: 'COMPANY_PRICE' }]]);
  const incoming = [{ productId: 'P' }, { product_id: 'P' }];
  applyIncomingCostModes(incoming, { useProductStandardPrice: false }, products);
  assert.ok(incoming.every(item => item.grossProfitCostMode === 'PURCHASE_PRICE'));
  const saved = incoming.map(item => ({ gross_profit_cost_mode: item.grossProfitCostMode }));
  assert.ok(saved.every(item => resolveIncomingCostMode(item, {}, products.get('P')) === 'PURCHASE_PRICE'));
});
