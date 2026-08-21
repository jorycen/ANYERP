const test = require('node:test');
const assert = require('node:assert/strict');
const { canViewSnTraceReference } = require('../src/utils/snTracePermission');

const reference = {
  store_id: 'store-a',
  distributor_id: 'dist-a',
  creator_names: ['张三']
};

test('SN追踪：boss可查看全部关联单据', () => {
  assert.equal(canViewSnTraceReference({ roles: ['boss'], name: '其他人' }, reference), true);
});

test('SN追踪：经销商级账号仅查看已分配门店单据', () => {
  assert.equal(canViewSnTraceReference({ roles: ['finance'], distributorId: 'dist-a', accessibleStoreIds: ['store-a'] }, reference), true);
  assert.equal(canViewSnTraceReference({ roles: ['finance'], distributorId: 'dist-a', accessibleStoreIds: ['store-b'] }, reference), false);
});

test('SN追踪：店长按可管理门店查看', () => {
  assert.equal(canViewSnTraceReference({ roles: ['manager'], accessibleStoreIds: ['store-a'] }, reference), true);
  assert.equal(canViewSnTraceReference({ roles: ['manager'], accessibleStoreIds: ['store-b'] }, reference), false);
});

test('SN追踪：员工只查看自己发起的原始单据', () => {
  assert.equal(canViewSnTraceReference({ roles: ['staff'], name: '张三' }, reference), true);
  assert.equal(canViewSnTraceReference({ roles: ['staff'], name: '李四' }, reference), false);
});
