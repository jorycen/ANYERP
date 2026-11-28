const test = require('node:test');
const assert = require('node:assert/strict');

const inventoryController = require('../src/modules/inventory/controller');

test('采购退库只读取入库明细保存的SN关联，不生成同款库存候选', () => {
  const collect = inventoryController._test.collectInboundItemSnReferences;
  const { snIds, snCodes } = collect(
    { sn_id: 'legacy-sn-id', sn_code: 'LEGACY-SN', received_sn_codes: JSON.stringify(['LEGACY-SN', 'SECOND-SN']) },
    [{ sn_id: 'immutable-sn-id', sn_code: 'ORIGINAL-SN' }]
  );

  assert.deepEqual([...snIds], ['immutable-sn-id']);
  assert.deepEqual([...snCodes], ['ORIGINAL-SN']);

  const legacy = collect({ sn_id: 'legacy-sn-id', sn_code: 'LEGACY-SN', received_sn_codes: JSON.stringify(['SECOND-SN']) });
  assert.deepEqual([...legacy.snIds], ['legacy-sn-id']);
  assert.deepEqual([...legacy.snCodes], ['LEGACY-SN', 'SECOND-SN']);
});
