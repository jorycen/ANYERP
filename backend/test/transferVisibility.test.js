const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../src/modules/inventory/controller');

test('调拨查询按角色区分本人参与、经销商和系统全量范围', () => {
  assert.equal(_test.getTransferVisibilityLevel({ roles: ['boss'] }), 'all');
  assert.equal(_test.getTransferVisibilityLevel({ roles: ['admin'] }), 'distributor');
  assert.equal(_test.getTransferVisibilityLevel({ roles: ['finance'] }), 'distributor');
  assert.equal(_test.getTransferVisibilityLevel({ roles: ['purchaser'] }), 'distributor');
  assert.equal(_test.getTransferVisibilityLevel({ roles: ['manager'] }), 'store');
  assert.equal(_test.getTransferVisibilityLevel({ roles: ['clerk'] }), 'participant');
  assert.equal(_test.getTransferVisibilityLevel({ roles: ['manager', 'clerk'] }), 'store');
  assert.equal(_test.getTransferVisibilityLevel({ roles: ['manager', 'finance'] }), 'distributor');
});

test('店员调拨查询同时限制授权门店和本人参与人字段', () => {
  const conditions = _test.buildTransferVisibilityWhere(
    { roles: ['clerk'], name: '张三' },
    ['STORE_1']
  );

  assert.equal(conditions.length, 2);
  const participantCondition = conditions[1];
  const participantOr = participantCondition[Object.getOwnPropertySymbols(participantCondition)[0]];
  assert.equal(participantOr.length, 5);
  assert.deepEqual(participantOr[0], { apply_user: '张三' });
  assert.deepEqual(participantOr[4], { receiving_user: '张三' });
});

test('经销商级账号按本经销商门店范围查询，不能因无门店而放开数据', () => {
  const conditions = _test.buildTransferVisibilityWhere({ roles: ['admin'] }, []);
  assert.equal(conditions.length, 1);
  const scopeCondition = conditions[0];
  const scopeOr = scopeCondition[Object.getOwnPropertySymbols(scopeCondition)[0]];
  assert.equal(scopeOr.length, 1);
  assert.deepEqual(scopeOr[0].transfer_id, { [Object.getOwnPropertySymbols(scopeOr[0].transfer_id)[0]]: ['__NO_TRANSFER_SCOPE__'] });
});
