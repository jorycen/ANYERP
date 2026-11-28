const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../src/modules/inventory/controller');

test('出库和调拨的PN比较忽略大小写及内部空格', () => {
  assert.equal(_test.samePnCode('(1S)ZAJA0002CN', '(1s) ZAJA0002CN'), true);
  assert.equal(_test.samePnCode('(1S)ZAJA0002CN', 'ZAJA0002CN'), false);
});
