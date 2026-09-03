const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../src/modules/inventory/controller');

test('销售退库重新入库只允许退库待入库的原SN', () => {
  assert.equal(_test.validateSalesReturnInboundSn({
    sn: { sn_code: 'SN-001', status: 'return_pending' },
    requestedSnCode: 'SN-001'
  }), null);

  assert.deepEqual(
    _test.validateSalesReturnInboundSn({
      sn: { sn_code: 'SN-001', status: 'sold' },
      requestedSnCode: 'SN-001'
    }),
    { status: 409, message: '销售退单SN当前不是待重新入库状态' }
  );

  assert.deepEqual(
    _test.validateSalesReturnInboundSn({
      sn: { sn_code: 'SN-001', status: 'return_pending' },
      requestedSnCode: 'SN-002'
    }),
    { status: 400, message: '销售退单SN必须为 SN-001' }
  );
});
