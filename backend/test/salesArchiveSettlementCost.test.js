const test = require('node:test');
const assert = require('node:assert/strict');
const models = require('../src/models');
const { calculateSalesSettlementCosts } = require('../src/modules/sales/controller')._test;

for (const scenario of [
  { name: '有供应商的SN，无教育补贴、无返利政策', serialized: true, serviceProvider: 1 },
  { name: '非服务商SN，无教育补贴、无返利政策', serialized: true, serviceProvider: 0 },
  { name: '无SN商品，无教育补贴、无返利政策', serialized: false }
]) {
  test(`归档成本计算：${scenario.name}`, async t => {
    // 禁止测试访问数据库，所有读写均通过桩验证。
    t.mock.method(models.sequelize, 'query', async () => { throw new Error('Unexpected database access'); });
    const transaction = { id: 'archive-transaction' };
    let saved;
    const item = {
      item_id: 'ITEM1', product_id: 'PRODUCT1', pn_code: 'PN1',
      sn_code: scenario.serialized ? 'SN1' : '', quantity: 1, subtotal: 1500,
      use_edu_subsidy: 0, selected_resource_types: '[]',
      update: async (values, options) => {
        assert.equal(options.transaction, transaction);
        saved = values;
      }
    };
    t.mock.method(models.SalesSettlementCostAdjustment, 'count', async () => 0);
    t.mock.method(models.OrderItem, 'findAll', async () => [item]);
    t.mock.method(models.Store, 'findByPk', async () => ({ distributor_id: 'D1' }));
    t.mock.method(models.ProductPrice, 'findAll', async () => [{ product_id: 'PRODUCT1', cost_price: 1000 }]);
    const snLookup = t.mock.method(models.ProductSn, 'findOne', async () => ({
      sn_id: 'SN_ID', supplier_id: 'SUPPLIER1', inbound_price: 1000,
      original_pickup_price: 1000, original_inbound_time: new Date('2026-09-16T00:00:00+08:00')
    }));
    t.mock.method(models.ManufacturerPriceHistory, 'findOne', async () => null);
    t.mock.method(models.ManufacturerRebatePolicy, 'findAll', async () => []);
    const supplierLookup = t.mock.method(models.Supplier, 'findByPk', async (id, options) => {
      assert.equal(id, 'SUPPLIER1');
      assert.equal(options.transaction, transaction);
      return { supplier_id: id, is_service_provider: scenario.serviceProvider };
    });
    await calculateSalesSettlementCosts({
      order_id: 'ORDER1', store_id: 'STORE1', education_subsidy: 0,
      create_time: new Date('2026-10-03T12:00:00+08:00')
    }, transaction);
    assert.equal(supplierLookup.mock.callCount(), scenario.serialized ? 1 : 0);
    assert.equal(snLookup.mock.callCount(), scenario.serialized ? 1 : 0);
    assert.equal(saved.sales_settlement_cost, 1000);
    assert.equal(saved.sales_gross_profit, 500);
    assert.equal(saved.cost_adjustment_amount, 0);
    assert.equal(saved.p0_difference_amount, 0);
  });
}
