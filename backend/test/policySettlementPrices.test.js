const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const { loadPolicySettlementPrices } = require('../src/modules/product/policySettlementPrices');
test('policy display preserves PN prices, zero, missing values and product ownership', async t => {
  t.mock.method(M.ProductPn, 'findAll', async () => [{ product_id: 'p', pn_code: 'PN2' }]);
  t.mock.method(M.ManufacturerPriceHistory, 'findAll', async () => [
    { product_id: 'other', pn: 'PN1', settlement_price: 999 },
    { product_id: null, pn: 'PN1', settlement_price: 0 },
    { product_id: null, pn: 'PN1', settlement_price: 100 },
    { product_id: 'p', pn: 'PN2', settlement_price: 25 },
    { product_id: null, pn: 'BAR', settlement_price: null }
  ]);
  const result = await loadPolicySettlementPrices([{ product_id: 'p', manufacturer_code: 'PN1' },
    { product_id: 'empty', manufacturer_code: '' }], [{ product_id: 'p', barcode_code: 'BAR' }]);
  assert.deepEqual(result.get('p'), [{ pn: 'PN1', settlement_price: 0 },
    { pn: 'PN2', settlement_price: 25 }, { pn: 'BAR', settlement_price: null }]);
  assert.deepEqual(result.get('empty'), []);
});
