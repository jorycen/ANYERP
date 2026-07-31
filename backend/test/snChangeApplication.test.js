const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../src/modules/inventory/snChangeApplication');

test('SN修改申请明细必须包含唯一SN和新SN', () => {
  const items = _test.normalizeItems([
    { snId: 'sn-1', newCode: 'new-1' },
    { sn_id: 'sn-2', new_sn_code: 'new-2' }
  ]);

  assert.deepEqual(items, [
    { snId: 'sn-1', newSnCode: 'new-1' },
    { snId: 'sn-2', newSnCode: 'new-2' }
  ]);
  assert.throws(() => _test.normalizeItems([]));
  assert.throws(() => _test.normalizeItems([{ snId: 'sn-1', newCode: 'new-1' }, { snId: 'sn-1', newCode: 'new-2' }]));
});

test('SN修改申请快照可以安全解析', () => {
  assert.deepEqual(_test.parsePayload('{"reason":"盘点纠错","items":[]}'), { reason: '盘点纠错', items: [] });
  assert.deepEqual(_test.parsePayload('invalid-json'), {});
});
