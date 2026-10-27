// Integration check using connection-local TEMPORARY tables only. No business table writes.
const assert = require('node:assert/strict');
const { DataTypes } = require('sequelize');
const { sequelize } = require('../src/models');
const contract = require('../src/modules/sales/orderSaveContract');
async function main() {
  const prefix = `save_check_${process.pid}_`;
  const definitions = {
    Order: { order_id: { type: DataTypes.STRING(32), primaryKey: true }, total_amount: DataTypes.DECIMAL(12, 2), actual_payment: DataTypes.DECIMAL(12, 2), invoice_amount: DataTypes.DECIMAL(12, 2) },
    OrderItem: { item_id: { type: DataTypes.INTEGER, primaryKey: true }, order_id: DataTypes.STRING(32), sale_price: DataTypes.DECIMAL(12, 2), quantity: DataTypes.INTEGER, subtotal: DataTypes.DECIMAL(12, 2) },
    OrderPayment: { id: { type: DataTypes.INTEGER, primaryKey: true }, order_id: DataTypes.STRING(32), payment_method: DataTypes.STRING(64), amount: DataTypes.DECIMAL(12, 2) },
    BusinessActionLog: { log_id: { type: DataTypes.STRING(32), primaryKey: true }, business_type: DataTypes.STRING(32), business_id: DataTypes.STRING(64), business_no: DataTypes.STRING(64), action: DataTypes.STRING(64), actor_staff_id: DataTypes.BIGINT, actor_name: DataTypes.STRING(64), detail_json: DataTypes.TEXT, create_time: DataTypes.DATE }
  };
  const models = Object.fromEntries(Object.entries(definitions).map(([name, attributes]) => [name, sequelize.define(prefix + name, attributes, { tableName: prefix + name, timestamps: false })]));
  await sequelize.transaction(async transaction => {
    try {
      for (const [name, model] of Object.entries(models)) {
        const columns = Object.entries(definitions[name]).map(([key, type]) => `\`${key}\` ${(type.type || type).toString()} ${type.primaryKey ? 'PRIMARY KEY' : ''}`);
        await sequelize.query(`CREATE TEMPORARY TABLE \`${model.tableName}\` (${columns.join(',')}) ENGINE=InnoDB`, { transaction });
      }
      const order = await models.Order.create({ order_id: 'fixture', total_amount: 14468, actual_payment: 12968, invoice_amount: 14468 }, { transaction });
      await models.OrderItem.create({ item_id: 1, order_id: 'fixture', sale_price: 14468, quantity: 1, subtotal: 14468 }, { transaction });
      await models.OrderPayment.create({ id: 1, order_id: 'fixture', payment_method: 'cash', amount: 12968 }, { transaction });
      const body = { saveContract: 1, requestId: 'integration-save-1', expectedRevision: (await contract.snapshot(models, order, transaction)).saveRevision };
      const user = { staffId: 1, name: 'integration' };
      const token = await contract.begin(models, order, body, user, transaction);
      await models.OrderItem.update({ sale_price: 14300, subtotal: contract.subtotal(14300, 1) }, { where: { item_id: 1 }, transaction });
      await order.update({ total_amount: 14300, actual_payment: 12800 }, { transaction });
      await models.OrderPayment.update({ amount: 12800 }, { where: { id: 1 }, transaction });
      const response = await contract.finish(models, order, body, user, transaction, token, { status: 'saved' });
      assert.equal(Number(response.savedOrder.items[0].unitPrice), 14300);
      assert.equal(response.saveRevision, (await contract.snapshot(models, order, transaction)).saveRevision);
      assert.deepEqual((await contract.begin(models, order, body, user, transaction)).replay, JSON.parse(JSON.stringify(response)));
      await assert.rejects(contract.begin(models, order, { ...body, requestId: 'integration-save-2' }, user, transaction), error => error.status === 409);
      await assert.rejects(sequelize.transaction({ transaction }, async nested => {
        await models.OrderItem.update({ sale_price: 0, subtotal: 0 }, { where: { item_id: 1 }, transaction: nested });
        await order.update({ total_amount: 0 }, { transaction: nested });
        await models.OrderPayment.destroy({ where: { id: 1 }, transaction: nested });
        throw new Error('forced rollback');
      }), /forced rollback/);
      const afterRollback = await contract.snapshot(models, order, transaction);
      assert.equal(Number(afterRollback.items[0].sale_price), 14300);
      assert.equal(Number(afterRollback.order.total_amount), 14300);
      assert.equal(Number(afterRollback.payments[0].amount), 12800);
      console.log('PASS: MySQL temporary-table persistence, reload, replay, stale revision and transaction rollback');
    } finally {
      for (const model of Object.values(models)) await sequelize.query(`DROP TEMPORARY TABLE IF EXISTS \`${model.tableName}\``, { transaction });
    }
  });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => sequelize.close());
