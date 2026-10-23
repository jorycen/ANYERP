const test = require('node:test');
const assert = require('node:assert/strict');
const { corporateInvoiceDefaults: defaults } = require('../src/modules/sales/invoiceDefaults');

test('corporate invoice defaults include only corporate transfers, summing cents across split payments', () => {
  assert.deepEqual(defaults({ payments: [
    { method: '对公转账', amount: '100.10' }, { type: '对公转账', amount: '200.20' },
    { type: '现金', amount: 1000 }, { type: '对私转账', amount: 500 },
    { type: '定金抵扣', amount: 100 }
  ] }), { applies: true, invoiceStatus: '开专票', invoiceAmount: '300.30' });
});
test('corporate selection with empty amount still defaults to special invoice without a fabricated amount', () => {
  assert.deepEqual(defaults({ payments: [{ type: '对公转账', amount: '' }] }),
    { applies: true, invoiceStatus: '开专票', invoiceAmount: '0.00' });
  assert.deepEqual(defaults({ payments: [{ type: '现金', amount: 500 }] }), { applies: false });
});
test('existing national subsidy invoice requirements take priority', () => {
  const payments = [{ type: '对公转账', amount: 500 }];
  assert.equal(defaults({ payments, subsidyStatus: '国补' }).applies, false);
  assert.equal(defaults({ payments, nationalSubsidy: 100 }).applies, false);
  assert.equal(defaults({ payments: [...payments, { type: '国补POS', amount: 100 }] }).applies, false);
});
