const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeSalesReturnReason } = require('../src/modules/sales/controller')._test;

test('销售退单缘由统一去除首尾空白', () => {
  assert.equal(normalizeSalesReturnReason('  客户重复下单  '), '客户重复下单');
  assert.equal(normalizeSalesReturnReason('   '), '');
  assert.equal(normalizeSalesReturnReason(null), '');
});

test('销售退单缘由保留原始内容并由接口校验长度', () => {
  assert.equal(normalizeSalesReturnReason('a'.repeat(512)).length, 512);
  assert.equal(normalizeSalesReturnReason('a'.repeat(513)).length, 513);
});
