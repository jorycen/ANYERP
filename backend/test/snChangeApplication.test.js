const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../src/modules/inventory/snChangeApplication');

test('SN修改申请明细必须包含唯一SN和新SN', () => {
  const items = _test.normalizeItems([
    { snId: 'sn-1', newCode: 'new-1' },
    { sn_id: 'sn-2', new_sn_code: 'new-2' }
  ]);

  assert.deepEqual(items, [
    { snId: 'sn-1', newSnCode: 'NEW-1' },
    { snId: 'sn-2', newSnCode: 'NEW-2' }
  ]);
  assert.throws(() => _test.normalizeItems([]));
  assert.throws(() => _test.normalizeItems([{ snId: 'sn-1', newCode: 'new-1' }, { snId: 'sn-1', newCode: 'new-2' }]));
});

test('SN修改申请快照可以安全解析', () => {
  assert.deepEqual(_test.parsePayload('{"reason":"盘点纠错","items":[]}'), { reason: '盘点纠错', items: [] });
  assert.deepEqual(_test.parsePayload('invalid-json'), {});
});

test('SN修改申请完整校验使用规范化新码，并拒绝大小写重复', async t => {
  const M = require('../src/models');
  const { createSnChangeApplication } = require('../src/modules/inventory/snChangeApplication');
  const tx = { LOCK: { UPDATE: 'UPDATE' } };
  t.mock.method(M.sequelize, 'transaction', async callback => callback(tx));
  t.mock.method(M.ProductSn, 'findAll', async () => [{ sn_id: 'S', sn_code: 'OLD', status: 'in_stock', store_id: 'STORE' }]);
  t.mock.method(M.ProductSn, 'findOne', async () => null);
  t.mock.method(M.ApprovalFlowInstance, 'findAll', async () => []);
  const input = { reason: '纠错', items: [{ snId: 'S', newSnCode: ' new-code ' }] };
  const user = { staffId: 1, name: '甲', accessibleStoreIds: ['STORE'] };
  const result = await createSnChangeApplication(input, user, async request => {
    assert.equal(request.payload.items[0].newSnCode, 'NEW-CODE');
    return { instance_id: 'I', instance_no: 'A001', status: 'pending' };
  });
  assert.equal(result.items[0].newSnCode, 'NEW-CODE');
  t.mock.method(M.ProductSn, 'findOne', async () => ({ sn_id: 'OTHER', sn_code: 'new-code' }));
  await assert.rejects(createSnChangeApplication(input, user, async () => { throw new Error('must not approve'); }), /已被使用/);
});
