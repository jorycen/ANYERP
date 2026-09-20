const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  normalizeFlowConfig,
  getApprovalStoreIds,
  canReadApprovalStore,
  resolveApprovers
} = require('../src/modules/approval/service');
const M = require('../src/models');

test('审批流程配置支持串行签批和或签', () => {
  const config = normalizeFlowConfig({
    nodes: [
      { name: '店长审批', signMode: 'serial', approvers: [{ type: 'store_manager' }] },
      { name: '财务或签', signMode: 'or', approvers: [{ type: 'role', roleCode: 'finance', scope: 'subject_distributor' }] }
    ]
  });

  assert.equal(config.nodes[0].signMode, 'serial');
  assert.equal(config.nodes[1].signMode, 'or');
  assert.equal(config.nodes[1].approvers[0].scope, 'subject_distributor');
});

test('审批流程配置拒绝空节点和未知审批人类型', () => {
  assert.throws(() => normalizeFlowConfig({ nodes: [] }), /至少需要一个审批节点/);
  assert.throws(() => normalizeFlowConfig({ nodes: [{ approvers: [{ type: 'unknown' }] }] }), /审批人类型不支持/);
});

test('通用审批允许申请人进入审批人任务', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/modules/approval/service.js'), 'utf8');
  assert.doesNotMatch(source, /id !== Number\(instance\.applicant_staff_id\)/);
});

test('explicit store permission remains valid across distributor ownership', async t => {
  const subject = {
    staff_id: 14,
    status: 1,
    is_deleted: 0,
    store_id: 'D023000',
    distributor_id: 'DIST002',
    toJSON() { return { ...this }; }
  };
  const crossDistributorAdmin = {
    staff_id: 47,
    status: 1,
    is_deleted: 0,
    role_code: 'admin',
    distributor_id: 'DIST001',
    Roles: [{ role_code: 'admin' }]
  };
  t.mock.method(M.Staff, 'findByPk', async () => subject);
  t.mock.method(M.StaffStorePermission, 'findAll', async () => [{ staff_id: 47 }]);
  t.mock.method(M.Staff, 'findAll', async () => [crossDistributorAdmin]);

  const ids = await resolveApprovers({
    name: 'transfer receipt',
    signMode: 'or',
    approvers: [{ type: 'store_staff', scope: 'subject_store' }]
  }, {
    subject_staff_id: 14,
    store_id: 'D023000',
    distributor_id: 'DIST002'
  });

  assert.deepEqual(ids, [47]);
});

test('distributor-scoped role remains limited to its distributor', async t => {
  const subject = {
    staff_id: 14,
    status: 1,
    is_deleted: 0,
    store_id: 'D023000',
    distributor_id: 'DIST002',
    toJSON() { return { ...this }; }
  };
  t.mock.method(M.Staff, 'findByPk', async () => subject);
  t.mock.method(M.StaffStorePermission, 'findAll', async () => []);
  t.mock.method(M.Staff, 'findAll', async () => [{
    staff_id: 47,
    status: 1,
    is_deleted: 0,
    role_code: 'admin',
    distributor_id: 'DIST001',
    Roles: [{ role_code: 'admin' }]
  }]);

  await assert.rejects(resolveApprovers({
    name: 'distributor approval',
    signMode: 'or',
    approvers: [{ type: 'role', roleCode: 'admin', scope: 'subject_distributor' }]
  }, {
    subject_staff_id: 14,
    store_id: 'D023000',
    distributor_id: 'DIST002'
  }));
});

test('店长审批范围只包含已分配管理门店', () => {
  const manager = { roles: ['manager'], accessibleStoreIds: ['STORE_1', 'STORE_2'] };
  assert.deepEqual(getApprovalStoreIds(manager), ['STORE_1', 'STORE_2']);
  assert.equal(canReadApprovalStore(manager, 'STORE_1'), true);
  assert.equal(canReadApprovalStore(manager, 'STORE_3'), false);
  assert.deepEqual(getApprovalStoreIds({ roles: ['admin'], accessibleStoreIds: ['STORE_1'] }), ['STORE_1']);
  assert.deepEqual(getApprovalStoreIds({ roles: ['finance'], accessibleStoreIds: ['STORE_1'] }), ['STORE_1']);
  assert.equal(getApprovalStoreIds({ roles: ['boss'], accessibleStoreIds: ['STORE_1'] }), null);
  assert.deepEqual(
    getApprovalStoreIds({ roles: ['manager', 'finance'], accessibleStoreIds: ['STORE_1'] }),
    ['STORE_1']
  );
});
