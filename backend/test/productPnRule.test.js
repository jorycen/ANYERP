const test = require('node:test');
const assert = require('node:assert/strict');
const { assertSingleSnProductPn } = require('../src/utils/productPn');

test('SN商品只能绑定一个PN，并拒绝不一致的入库PN', () => {
  assert.equal(
    assertSingleSnProductPn({
      needSn: 1,
      productCode: 'SP02098',
      configuredCodes: ['83F40007CD'],
      requestedCode: '83f40007cd'
    }),
    '83F40007CD'
  );

  assert.throws(
    () => assertSingleSnProductPn({
      needSn: 1,
      productCode: 'SP02098',
      configuredCodes: ['83F40007CD'],
      requestedCode: '83F60002CD'
    }),
    error => error.code === 'SN_PRODUCT_PN_MISMATCH'
  );

  assert.throws(
    () => assertSingleSnProductPn({
      needSn: 1,
      productCode: 'SP02098',
      configuredCodes: ['83F40007CD', '83F60002CD']
    }),
    error => error.code === 'SN_PRODUCT_PN_NOT_UNIQUE'
  );
});

test('非SN商品允许同一商品编码维护多个PN', () => {
  assert.equal(
    assertSingleSnProductPn({
      needSn: 0,
      productCode: 'SP00001',
      configuredCodes: ['PN-A', 'PN-B'],
      requestedCode: 'PN-C'
    }),
    'PN-C'
  );
});
