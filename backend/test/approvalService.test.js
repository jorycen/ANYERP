const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  normalizeFlowConfig,
  getApprovalStoreIds,
  canReadApprovalStore
} = require('../src/modules/approval/service');

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

test('店长审批范围只包含已分配管理门店', () => {
  const manager = { roles: ['manager'], accessibleStoreIds: ['STORE_1', 'STORE_2'] };
  assert.deepEqual(getApprovalStoreIds(manager), ['STORE_1', 'STORE_2']);
  assert.equal(canReadApprovalStore(manager, 'STORE_1'), true);
  assert.equal(canReadApprovalStore(manager, 'STORE_3'), false);
  assert.equal(getApprovalStoreIds({ roles: ['admin'], accessibleStoreIds: ['STORE_1'] }), null);
  assert.deepEqual(
    getApprovalStoreIds({ roles: ['manager', 'finance'], accessibleStoreIds: ['STORE_1'] }),
    ['STORE_1']
  );
});
