const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../src/modules/sales/controller');

test('同一销售订单不能重复使用同一个SN', () => {
  assert.throws(
    () => _test.assertUniqueOrderSnItems([
      { sn_code: 'BH01VQTZ' },
      { sn_code: ' bh01vqtz ' }
    ]),
    error => error.message === '订单包含重复SN码 [BH01VQTZ]，同一商品的 SN 只能使用一次'
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


test('不同 PN 的同码商品可在同一销售单中出现，重复内部 ID 仍拦截', () => {
  const service = { product_id: 'service', pn_code: 'SERVICE', sn_code: '20261126', sn_id: 'service-stock' };
  const memory = { product_id: 'memory', pn_code: 'MEMORY', sn_code: '20261126', sn_id: 'memory-stock' };
  assert.doesNotThrow(() => _test.assertUniqueOrderSnItems([service, memory]));
  assert.throws(() => _test.assertUniqueOrderSnItems([service, { ...memory, sn_id: service.sn_id }]), /重复SN码/);
});
