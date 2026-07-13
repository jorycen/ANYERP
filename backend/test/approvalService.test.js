const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeFlowConfig } = require('../src/modules/approval/service');

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
