const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const models = require('../src/models');
const {
  accessibleDistributorIds,
  canAccessDistributor,
  distributorWhere
} = require('../src/utils/distributorScope');

test('中台账号可以读取和操作多个经销商范围，店员账号保留单一范围', () => {
  const centralUser = { roles: ['finance'], accessibleDistributorIds: ['DIST001', 'DIST002'] };
  const storeUser = { roles: ['clerk'], accessibleDistributorIds: ['DIST001'] };

  assert.deepEqual(accessibleDistributorIds(centralUser), ['DIST001', 'DIST002']);
  assert.equal(canAccessDistributor(centralUser, 'DIST002'), true);
  assert.equal(canAccessDistributor(storeUser, 'DIST002'), false);
});

test('BOSS拥有全局经销商范围，普通账号不能访问空归属的新数据', () => {
  assert.deepEqual(accessibleDistributorIds({ roles: ['boss'] }), ['*']);
  assert.equal(canAccessDistributor({ roles: ['finance'], accessibleDistributorIds: ['DIST001'] }, ''), false);
  assert.deepEqual(distributorWhere({ roles: ['finance'], accessibleDistributorIds: ['DIST001', 'DIST002'] }).distributor_id[Op.in], ['DIST001', 'DIST002']);
});

test('核心业务模型包含经销商归属快照字段', () => {
  for (const model of [models.PurchaseRequest, models.PurchaseAdjustment, models.Expense, models.Payable, models.Settlement, models.SettlementPaymentBatch, models.SettlementPaymentRecord, models.SettlementAccount]) {
    assert.ok(model.rawAttributes.distributor_id, `${model.name} 缺少 distributor_id`);
  }
  assert.ok(models.StaffDistributorPermission);
});
