// Repair only empty locations on a named, completed conversion's in-stock SN targets.
// Default is preview. This does not recreate inventory or alter conversion costs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const M = require('../src/models');
const { syncSerializedInventoryBalance } = require('../src/modules/inventory/serializedInventoryBalance');
const uid = () => crypto.randomUUID().replace(/-/g, '');

async function main() {
  const args = process.argv.slice(2);
  const conversionNo = args.find(arg => !arg.startsWith('--'));
  if (!conversionNo) throw new Error('conversion number required');
  const execute = args.includes('--execute');
  const t = await M.sequelize.transaction();
  try {
    const conversion = await M.InventoryConversion.findOne({ where: { conversion_no: conversionNo }, transaction: t, lock: t.LOCK.UPDATE });
    if (!conversion || conversion.status !== 'completed') throw new Error('Completed conversion required');
    const targets = await M.InventoryConversionItem.findAll({ where: { conversion_id: conversion.conversion_id, line_role: 'target' }, transaction: t, lock: t.LOCK.UPDATE });
    const locations = await M.Location.findAll({ where: { store_id: conversion.store_id, type: 'normal_qty', status: 1 }, transaction: t, lock: t.LOCK.UPDATE });
    if (locations.length !== 1) throw new Error('Exactly one active sales location required');
    const locationId = locations[0].location_id;
    const repairs = [], beforeInventory = [];
    for (const item of targets) {
      if (item.location_id) continue;
      if (!item.sn_id || item.inventory_type !== 'normal_qty' || Number(item.quantity) !== 1) throw new Error('Target needs manual review');
      const sn = await M.ProductSn.findByPk(item.sn_id, { transaction: t, lock: t.LOCK.UPDATE });
      if (!sn || sn.is_deleted || sn.status !== 'in_stock' || sn.store_id !== conversion.store_id || sn.product_id !== item.product_id
        || sn.batch_no !== conversionNo || sn.location_id || sn.inventory_type !== 'normal_qty') throw new Error('SN source/state changed; do not repair');
      const inventory = await M.Inventory.findAll({ where: { product_id: item.product_id, store_id: conversion.store_id }, transaction: t, lock: t.LOCK.UPDATE });
      beforeInventory.push(...inventory.map(row => row.toJSON()));
      repairs.push({ item, sn });
    }
    if (!execute) {
      console.log(JSON.stringify({ mode: 'preview', conversionNo, locationId, repairs: repairs.map(({item,sn}) => ({ itemId: item.item_id, snId: sn.sn_id, snCode: sn.sn_code })) }, null, 2));
      await t.rollback(); return;
    }
    if (!repairs.length) { await t.rollback(); console.log('No empty target locations to repair'); return; }
    const dir = path.resolve(__dirname, '../../backup/conversion-location-repair');
    fs.mkdirSync(dir, { recursive: true });
    const backupFile = path.join(dir, `${conversionNo}-${uid()}.json`);
    const before = { conversion: conversion.toJSON(), targets: repairs.map(({item,sn}) => ({ item: item.toJSON(), sn: sn.toJSON() })), inventory: beforeInventory, locationId };
    fs.writeFileSync(backupFile, JSON.stringify(before, null, 2));
    for (const {item, sn} of repairs) {
      await sn.update({ location_id: locationId }, { transaction: t });
      await item.update({ location_id: locationId }, { transaction: t });
      await M.SnLog.create({ log_id: uid(), sn_id: sn.sn_id, sn_code: sn.sn_code, product_id: sn.product_id, product_name: item.product_name,
        store_id: conversion.store_id, action: 'conversion_location_repair', remark: `修复拆装单${conversionNo}目标空库位，归入本店销售仓`, create_user: 'Codex（用户授权）' }, { transaction: t });
      await syncSerializedInventoryBalance({ productId: item.product_id, storeId: conversion.store_id, transaction: t });
    }
    const afterInventory = await M.Inventory.findAll({ where: { product_id: [...new Set(repairs.map(r=>r.item.product_id))], store_id: conversion.store_id }, raw: true, transaction: t });
    for (const {item} of repairs) {
      const row = afterInventory.find(r=>r.product_id===item.product_id && r.location_id===locationId);
      if (!row || Number(row.normal_qty) < 1) throw new Error('Sales inventory verification failed');
    }
    await M.BusinessActionLog.create({ log_id: uid(), business_type: 'inventory_conversion', business_id: conversion.conversion_id,
      business_no: conversionNo, action: 'repair_target_location', actor_name: 'Codex（用户授权）', comment: '修复拆出商品空库位，按现有SN事实同步库存汇总',
      detail_json: JSON.stringify({ before, afterInventory, backupFile }) }, { transaction: t });
    await t.commit();
    console.log(JSON.stringify({ committed: true, conversionNo, repaired: repairs.length, locationId, backupFile, afterInventory }, null, 2));
  } catch (error) { if (!t.finished) await t.rollback(); throw error; }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => M.sequelize.close());
