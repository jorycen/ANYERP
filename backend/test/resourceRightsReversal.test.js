const test = require('node:test');
const assert = require('node:assert/strict');
const models = require('../src/models');
const resourceRights = require('../src/modules/inventory/resourceRights');

function context({ body = {}, roles = ['finance'] } = {}) {
  return {
    request: { body },
    state: { user: { staffId: 101, name: '财务测试员', roles } },
    body: null,
    throw(status, message) {
      throw Object.assign(new Error(message), { status });
    }
  };
}

function installReversalStubs({ orderStatus = 'returned', existingReversal = null, settlements = [] } = {}) {
  const originals = {
    transaction: models.sequelize.transaction,
    snFindByPk: models.ProductSn.findByPk,
    rightFindOne: models.InventoryResourceRight.findOne,
    changeFindOne: models.ResourceRightChangeOrder.findOne,
    changeCreate: models.ResourceRightChangeOrder.create,
    orderFindByPk: models.Order.findByPk,
    settlementFindAll: models.ResourceSettlement.findAll
  };
  const state = { rightUpdates: null, change: null, settlementUpdates: [] };
  const right = {
    right_id: 'RIGHT_1',
    sn_id: 'SN_1',
    sn_code: 'PF6CQWDB',
    product_id: 'PRODUCT_1',
    resource_type: 'GOV_SUBSIDY',
    current_status: 'USED',
    amount: 0,
    version: 3,
    update: async values => { state.rightUpdates = values; Object.assign(right, values); }
  };
  const sourceChange = {
    change_id: 'CHANGE_USED',
    change_order_no: 'RRC_USED',
    related_sale_order_id: 'ORDER_RETURNED'
  };
  models.sequelize.transaction = async handler => handler({ LOCK: { UPDATE: 'UPDATE' } });
  models.ProductSn.findByPk = async () => ({ sn_id: 'SN_1', sn_code: 'PF6CQWDB', product_id: 'PRODUCT_1', status: 'in_stock', is_deleted: 0 });
  models.InventoryResourceRight.findOne = async () => right;
  models.ResourceRightChangeOrder.findOne = async options => options.where.change_reason === 'SALE_USE_REVERSAL' ? existingReversal : sourceChange;
  models.ResourceRightChangeOrder.create = async values => { state.change = values; return values; };
  models.Order.findByPk = async () => ({ order_id: 'ORDER_RETURNED', order_no: 'ORD_RETURNED', order_status: orderStatus });
  models.ResourceSettlement.findAll = async () => settlements;
  for (const settlement of settlements) {
    const originalUpdate = settlement.update;
    settlement.update = async values => {
      state.settlementUpdates.push(values);
      if (originalUpdate) await originalUpdate(values);
    };
  }
  return { originals, state, right, sourceChange };
}

function restoreStubs(originals) {
  models.sequelize.transaction = originals.transaction;
  models.ProductSn.findByPk = originals.snFindByPk;
  models.InventoryResourceRight.findOne = originals.rightFindOne;
  models.ResourceRightChangeOrder.findOne = originals.changeFindOne;
  models.ResourceRightChangeOrder.create = originals.changeCreate;
  models.Order.findByPk = originals.orderFindByPk;
  models.ResourceSettlement.findAll = originals.settlementFindAll;
}

test('已退单且SN已回库时可以冲销国补资格并取消待下账记录', async () => {
  const pendingSettlement = { status: 'PENDING', update: async () => {} };
  const { originals, state } = installReversalStubs({ settlements: [pendingSettlement] });
  try {
    const ctx = context({ body: { snId: 'SN_1', resourceType: 'GOV_SUBSIDY', reason: '测试退单时遗漏退回国补资格' } });
    await resourceRights.reverseSaleUseResource(ctx);
    assert.equal(state.rightUpdates.current_status, 'AVAILABLE');
    assert.equal(state.rightUpdates.version, 4);
    assert.equal(state.change.before_status, 'USED');
    assert.equal(state.change.after_status, 'AVAILABLE');
    assert.equal(state.change.change_reason, 'SALE_USE_REVERSAL');
    assert.equal(state.change.related_sale_order_id, 'ORDER_RETURNED');
    assert.equal(state.settlementUpdates[0].status, 'CANCELLED');
    assert.equal(ctx.body.data.cancelledSettlementCount, 1);
  } finally {
    restoreStubs(originals);
  }
});

test('同一原销售核销重复冲销时拒绝', async () => {
  const { originals } = installReversalStubs({ existingReversal: { change_order_no: 'RRC_REVERSAL' } });
  try {
    await assert.rejects(
      resourceRights.reverseSaleUseResource(context({ body: { snId: 'SN_1', reason: '重复测试' } })),
      error => error.status === 409 && error.message.includes('RRC_REVERSAL')
    );
  } finally {
    restoreStubs(originals);
  }
});

test('原销售单未完成退单时不得冲销国补资格', async () => {
  const { originals } = installReversalStubs({ orderStatus: '已归档' });
  try {
    await assert.rejects(
      resourceRights.reverseSaleUseResource(context({ body: { snId: 'SN_1', reason: '不应允许' } })),
      error => error.status === 409 && error.message.includes('尚未完成退单')
    );
  } finally {
    restoreStubs(originals);
  }
});

test('国补资格冲销仅允许财务、admin或BOSS角色', async () => {
  await assert.rejects(
    resourceRights.reverseSaleUseResource(context({ roles: ['manager'], body: { snId: 'SN_1', reason: '越权测试' } })),
    error => error.status === 403
  );
});
