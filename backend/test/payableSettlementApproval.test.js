const test = require('node:test');
const assert = require('node:assert/strict');
const models = require('../src/models');
const payableController = require('../src/modules/finance/payableController');

test('应付单税务属性按已有发票类型映射，缺失时保持未知', () => {
  assert.equal(payableController.getPayableTaxStatus('未税（收据或普票）'), 'UNTAXED');
  assert.equal(payableController.getPayableTaxStatus('增专票（13%）'), 'TAX_INCLUDED');
  assert.equal(payableController.getPayableTaxStatus(''), 'UNKNOWN');
});

function context({ body = {}, user = {} } = {}) {
  return {
    request: { body },
    state: { user: { staffId: 101, name: '财务审批员', roles: ['finance'], ...user } },
    throw(status, message) {
      throw Object.assign(new Error(message), { status });
    }
  };
}

test('结算单提交进入待审批状态', async () => {
  const original = models.Settlement.findByPk;
  const updates = {};
  models.Settlement.findByPk = async () => ({
    settlement_id: 'SETTLEMENT_1',
    status: 'draft',
    update: async values => Object.assign(updates, values)
  });

  try {
    const ctx = context({ body: { settlementId: 'SETTLEMENT_1' } });
    await payableController.submitSettlement(ctx);
    assert.equal(updates.status, 'pending_approval');
    assert.ok(updates.submit_time instanceof Date);
    assert.equal(ctx.body.message, '结算单已提交，等待审批');
  } finally {
    models.Settlement.findByPk = original;
  }
});

test('待审批结算单审批通过并记录审批人及意见', async () => {
  const original = models.Settlement.findByPk;
  const updates = {};
  models.Settlement.findByPk = async () => ({
    settlement_id: 'SETTLEMENT_2',
    status: 'pending_approval',
    update: async values => Object.assign(updates, values)
  });

  try {
    const ctx = context({
      body: { settlementId: 'SETTLEMENT_2', comment: '金额及采购明细已核对' },
      user: { name: '审批人' }
    });
    await payableController.confirmSettlement(ctx);
    assert.equal(updates.status, 'confirmed');
    assert.equal(updates.approval_user, '审批人');
    assert.equal(updates.approval_comment, '金额及采购明细已核对');
    assert.ok(updates.approval_time instanceof Date);
    assert.ok(updates.confirmed_time instanceof Date);
  } finally {
    models.Settlement.findByPk = original;
  }
});

test('待审批结算单退回草稿并保留退回原因', async () => {
  const original = models.Settlement.findByPk;
  const updates = {};
  models.Settlement.findByPk = async () => ({
    settlement_id: 'SETTLEMENT_3',
    status: 'pending_approval',
    update: async values => Object.assign(updates, values)
  });

  try {
    const ctx = context({
      body: { settlementId: 'SETTLEMENT_3', comment: '请补充付款说明' }
    });
    await payableController.rejectSettlement(ctx);
    assert.equal(updates.status, 'draft');
    assert.equal(updates.approval_comment, '请补充付款说明');
    assert.equal(ctx.body.message, '结算单已退回草稿');
  } finally {
    models.Settlement.findByPk = original;
  }
});

test('制单人可以审批自己的结算单', async () => {
  const original = models.Settlement.findByPk;
  const updates = {};
  models.Settlement.findByPk = async () => ({
    settlement_id: 'SETTLEMENT_5',
    status: 'pending_approval',
    create_user: '财务审批员',
    update: async values => Object.assign(updates, values)
  });

  try {
    const ctx = context({ body: { settlementId: 'SETTLEMENT_5' } });
    await payableController.confirmSettlement(ctx);
    assert.equal(updates.status, 'confirmed');
    assert.equal(updates.approval_user, '财务审批员');
  } finally {
    models.Settlement.findByPk = original;
  }
});

test('结算单模型保留备注和审批字段', async () => {
  const settlement = models.Settlement.build({
    settlement_id: 'SETTLEMENT_4',
    settlement_no: 'S_TEST_4',
    total_amount: 100,
    remark: '部分到货，按本次到货数量结算',
    status: 'pending_approval',
    approval_user: '审批人',
    approval_comment: '已核对'
  });

  await assert.doesNotReject(() => settlement.validate());
  assert.equal(settlement.remark, '部分到货，按本次到货数量结算');
  assert.equal(settlement.status, 'pending_approval');
  assert.equal(settlement.approval_comment, '已核对');
});
