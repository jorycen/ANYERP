const test = require('node:test');
const assert = require('node:assert/strict');
const models = require('../src/models');
const financeRouter = require('../src/modules/finance/routes');
const payableController = require('../src/modules/finance/payableController');

function context({ id, user = {} } = {}) {
  return {
    params: { id },
    state: { user: { staffId: 101, name: '财务人员', roles: ['finance'], ...user } },
    throw(status, message) {
      throw Object.assign(new Error(message), { status });
    }
  };
}

test('结算单路由提供草稿删除接口', () => {
  const route = financeRouter.stack.find(layer => layer.path === '/settlement/:id' && layer.methods.includes('DELETE'));
  assert.ok(route);
  assert.deepEqual(route.stack.map(handler => handler.name), ['deleteSettlementDraft']);
});

test('从未提交过的结算单草稿可以软删除并恢复应付款状态', async () => {
  const originals = {
    findOne: models.Settlement.findOne,
    transaction: models.sequelize.transaction,
    logCreate: models.BusinessActionLog.create
  };
  const updates = [];
  let loggedAction = null;

  models.Settlement.findOne = async () => ({
    settlement_id: 'SETTLEMENT_DRAFT',
    settlement_no: 'S_DRAFT',
    status: 'draft',
    submit_time: null,
    payment_status: 'unpaid',
    paid_amount: 0,
    items: [],
    update: async values => updates.push(values)
  });
  models.sequelize.transaction = async handler => handler({ LOCK: { UPDATE: 'UPDATE' } });
  models.BusinessActionLog.create = async values => {
    loggedAction = values;
    return values;
  };

  try {
    const ctx = context({ id: 'SETTLEMENT_DRAFT' });
    await payableController.deleteSettlementDraft(ctx);
    assert.deepEqual(updates, [{ is_deleted: 1 }]);
    assert.equal(loggedAction.business_type, 'payable_settlement');
    assert.equal(loggedAction.action, 'deleted');
    assert.equal(ctx.body.settlementId, 'SETTLEMENT_DRAFT');
  } finally {
    models.Settlement.findOne = originals.findOne;
    models.sequelize.transaction = originals.transaction;
    models.BusinessActionLog.create = originals.logCreate;
  }
});

test('已提交后退回草稿的结算单不可删除', async () => {
  const originals = {
    findOne: models.Settlement.findOne,
    transaction: models.sequelize.transaction
  };
  models.Settlement.findOne = async () => ({
    settlement_id: 'SETTLEMENT_RETURNED',
    status: 'draft',
    submit_time: new Date(),
    payment_status: 'unpaid',
    paid_amount: 0,
    items: []
  });
  models.sequelize.transaction = async handler => handler({ LOCK: { UPDATE: 'UPDATE' } });

  try {
    await assert.rejects(
      payableController.deleteSettlementDraft(context({ id: 'SETTLEMENT_RETURNED' })),
      error => error.status === 400 && error.message.includes('从未提交过')
    );
  } finally {
    models.Settlement.findOne = originals.findOne;
    models.sequelize.transaction = originals.transaction;
  }
});

