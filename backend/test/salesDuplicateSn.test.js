const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../src/modules/sales/controller');

test('同一销售订单不能重复使用同一个SN', () => {
  assert.throws(
    () => _test.assertUniqueOrderSnItems([
      { sn_code: 'BH01VQTZ' },
      { sn_code: ' bh01vqtz ' }
    ]),
    error => error.message === '订单包含重复SN码 [BH01VQTZ]，同一SN只能对应一个商品'
  );
});

test('不同SN可以同时出现在同一销售订单', () => {
  assert.doesNotThrow(() => _test.assertUniqueOrderSnItems([
    { sn_code: 'BH01VQTZ' },
    { sn_code: 'BH01VR3B' }
  ]));
});

test('销售退单恢复资源权益时可以读取订单明细资源', () => {
  assert.deepEqual(
    _test.selectedResourcesForReturn({
      selected_resource_types: '["GOV_SUBSIDY", "EDU_SUBSIDY"]'
    }),
    ['GOV_SUBSIDY', 'EDU_SUBSIDY']
  );
  assert.deepEqual(
    _test.selectedResourcesForReturn({ use_gov_subsidy: 1 }),
    ['GOV_SUBSIDY']
  );
});
