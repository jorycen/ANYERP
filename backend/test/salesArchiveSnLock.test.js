const test = require('node:test');
const assert = require('node:assert/strict');
const models = require('../src/models');
const salesController = require('../src/modules/sales/controller');

function buildContext(items) {
  return {
    params: { orderId: 'ORDER_1' },
    request: { body: { items } },
    state: { user: { accessibleStoreIds: ['STORE_1'] } },
    body: null
  };
}

async function withSalesStubs({ lockedCount }, callback) {
  const originals = {
    orderFindByPk: models.Order.findByPk,
    itemFindAll: models.OrderItem.findAll,
    rightCount: models.InventoryResourceRight.count,
    grossProfitFindOne: models.OrderGrossProfit.findOne,
    transaction: models.sequelize.transaction
  };
  const updatedItem = {};
  const order = {
    order_id: 'ORDER_1',
    order_no: 'SO001',
    store_id: 'STORE_1',
    order_status: '未归档',
    update: async () => {}
  };
  const item = {
    item_id: 1,
    sn_id: null,
    sn_code: 'SN001',
    use_gov_subsidy: 1,
    selected_resource_types: '["GOV_SUBSIDY"]',
    update: async values => Object.assign(updatedItem, values)
  };

  models.Order.findByPk = async () => order;
  models.OrderItem.findAll = async () => [item];
  models.InventoryResourceRight.count = async () => lockedCount;
  models.OrderGrossProfit.findOne = async () => null;
  models.sequelize.transaction = async handler => handler({});

  try {
    await callback(updatedItem);
  } finally {
    models.Order.findByPk = originals.orderFindByPk;
    models.OrderItem.findAll = originals.itemFindAll;
    models.InventoryResourceRight.count = originals.rightCount;
    models.OrderGrossProfit.findOne = originals.grossProfitFindOne;
    models.sequelize.transaction = originals.transaction;
  }
}

test('selected resources do not block filling the real SN id during archive preparation', async () => {
  await withSalesStubs({ lockedCount: 0 }, async updatedItem => {
    const ctx = buildContext([{ itemId: 1, snId: 'SN_ROW_1', snCode: 'SN001' }]);
    await salesController.update(ctx);
    assert.equal(updatedItem.sn_id, 'SN_ROW_1');
  });
});

test('an actual resource lock still prevents replacing the SN', async () => {
  await withSalesStubs({ lockedCount: 1 }, async () => {
    const ctx = buildContext([{ itemId: 1, snId: 'OTHER_SN_ROW', snCode: 'SN002' }]);
    await assert.rejects(
      salesController.update(ctx),
      error => error.status === 409 && error.message.includes('存在已锁定的SN资源权益')
    );
  });
});
