const test = require('node:test');
const assert = require('node:assert/strict');

// Opt-in writes are confined to a new empty schema. No production rows copied.
test('special transfer receipt: target restriction, rollback, stock and duplicate receipt',
  { skip: process.env.RUN_SN_ELIGIBILITY_DB_TESTS !== 'true' }, async () => {
  const config = require('../src/config');
  const mysql = require('mysql2/promise');
  const source = config.database.database;
  assert.match(source, /^[a-zA-Z0-9_-]+$/);
  const name = `sn_gate_test_${Date.now()}_${process.pid}`;
  const control = await mysql.createConnection({ host: config.database.host, port: config.database.port,
    user: config.database.username, password: config.database.password });
  let sequelize;
  try {
    await control.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`);
    config.database.database = name;
    const DB = require('../src/models');
    sequelize = DB.sequelize;
    for (const key of ['Product','ProductPn','ProductSn','Location','Inventory','Transfer','TransferItem',
      'Inbound','InboundItem','SnLog','PurchaseRequest','PurchaseRequestItem','BusinessActionLog',
      'InventoryResourceRight','ResourceCategory','InventoryBatchApplication','InventoryBatchApplicationItem']) {
      const table = DB[key].getTableName();
      assert.match(table, /^[A-Za-z0-9_]+$/);
      await control.query(`CREATE TABLE \`${name}\`.\`${table}\` LIKE \`${source}\`.\`${table}\``);
    }
    const controller = require('../src/modules/inventory/controller');
    const gate = require('../src/utils/snEligibility');
    await DB.Product.create({ product_id: 'P', product_code: 'P', name: 'Fixture', need_sn: 1, status: 1, is_deleted: 0 });
    for (const [id, store, type] of [['AR','A','rental_demo_qty'],['BN','B','normal_qty'],['BR','B','rental_demo_qty'],['BD','B','display_qty']]) {
      await DB.Location.create({ location_id: id, store_id: store, name: id, type, status: 1 });
    }
    const sn = await DB.ProductSn.create({ sn_id: 'S', sn_code: 'SN-FIXTURE', product_id: 'P', store_id: 'A',
      location_id: 'AR', inventory_type: 'rental_demo_qty', status: 'transferring', inbound_price: '12.00', is_deleted: 0 });
    await DB.Transfer.create({ transfer_id: 'T', transfer_no: 'TR-FIXTURE', from_store_id: 'A', to_store_id: 'B', status: 'out_confirmed' });
    await DB.TransferItem.create({ item_id: 1, transfer_id: 'T', product_id: 'P', sn_id: 'S', sn_code: sn.sn_code, quantity: 1 });
    const context = locationId => ({ state: { user: { roles: ['boss'], name: 'Fixture' } },
      request: { body: { transferId: 'T', items: [{ itemId: 1, locationId }] } },
      throw(status, message) { throw Object.assign(new Error(message), { status }); } });
    await assert.rejects(controller.confirmTransferIn(context('BN')), /须完成采购转换/);
    await sn.reload();
    assert.equal(sn.status, 'transferring'); assert.equal(sn.store_id, 'A');
    assert.equal(await DB.Inventory.count(), 0);
    assert.equal(await DB.BusinessActionLog.count(), 0);
    assert.equal((await DB.Transfer.findByPk('T')).status, 'out_confirmed');
    // Rental to display is a permitted special-to-special movement.
    await controller.confirmTransferIn(context('BD'));
    await sn.reload();
    assert.equal(sn.store_id, 'B'); assert.equal(sn.location_id, 'BD');
    assert.equal(sn.inventory_type, 'display_qty'); assert.equal(sn.inbound_price, '12.00');
    let balance = await DB.Inventory.findOne({ where: { product_id: 'P', store_id: 'B', location_id: 'BD' } });
    assert.equal(balance.display_qty, 1); assert.equal(balance.normal_qty, 0);
    assert.equal((await DB.Transfer.findByPk('T')).status, 'completed');
    await controller.confirmTransferIn(context('BD'));
    await balance.reload(); assert.equal(balance.display_qty, 1);
    assert.equal(await DB.SnLog.count({ where: { action: 'special_warehouse_flow' } }), 1);
    await assert.rejects(controller.confirmTransferIn(context('BN')), /须完成采购转换/);
    await sn.reload(); assert.equal(sn.location_id, 'BD');
    await assert.rejects(gate.assertSnEligible(sn), /须完成采购转换/);
    // Model the existing atomic purchase conversion facts, after special entry.
    await DB.PurchaseRequest.create({ request_id: 'PR', request_no: 'PR-FIXTURE', store_id: 'B', status: 'approved' });
    await DB.PurchaseRequestItem.create({ request_id: 'PR', product_id: 'P', source_sn_id: 'S', quantity: 1 });
    await DB.SnLog.create({ log_id: 'PURCHASE-LOG', sn_id: 'S', sn_code: sn.sn_code, product_id: 'P', store_id: 'B',
      action: 'special_warehouse_purchase', remark: 'PR-FIXTURE', create_time: new Date(Date.now() + 2000) });
    await sn.update({ location_id: 'BN', inventory_type: 'normal_qty', source_type: 'PURCHASED_FROM_SPECIAL_WAREHOUSE' });
    await gate.assertSnEligible(sn);
    // No special lineage and a genuine zero cost remain legal.
    const zero = await DB.ProductSn.create({ sn_id: 'ZERO', sn_code: 'ZERO-FIXTURE', product_id: 'P', store_id: 'B',
      location_id: 'BN', inventory_type: 'normal_qty', status: 'in_stock', inbound_price: '0.00', is_deleted: 0 });
    await gate.assertSnEligible(zero);
  } finally {
    if (sequelize) await sequelize.close();
    await control.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await control.end();
  }
});
