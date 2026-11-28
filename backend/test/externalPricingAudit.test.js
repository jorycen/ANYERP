const test = require('node:test');
const assert = require('node:assert/strict');
const { assessPricing } = require('../scripts/audit-october-external-pricing');
const line = { snCode: 'SN', category: '笔记本', productName: '电脑', purchasePrice: 5000,
  isCompanyPriced: true, source: 'product_standard_price' };
const supplier = { is_service_provider: 0, purchase_cost_mode_allowed: 'PURCHASE_PRICE' };
const receipt = { unit_price: 5000, mode_flag: null, purchase_mode: 'COMPANY_PRICE', uplift: 200 };
test('current supplier rules are only a suspicion, not historical proof', () => {
  const result = assessPricing(line, receipt, null, supplier, new Date());
  assert.equal(result.company, true);
  assert.equal(result.explicitPurchase, false);
  assert.match(result.certainty, /^疑似/);
});
test('receipt purchase-price flag conflicting with company-price sale is explicit evidence', () => {
  const result = assessPricing(line, { ...receipt, mode_flag: 0 }, null, supplier, new Date());
  assert.equal(result.explicitPurchase, true);
  assert.match(result.certainty, /^采购来源明确/);
});
test('authorized corrections and unknown or changed cost evidence are excluded', () => {
  assert.equal(assessPricing({ ...line, correctionId: 'approved' }, receipt, null, supplier, new Date()), null);
  assert.equal(assessPricing(line, { ...receipt, unit_price: 9999 }, null, supplier, new Date()), null);
  assert.equal(assessPricing({ ...line, purchasePrice: 0 }, receipt, null, supplier, new Date()), null);
});
