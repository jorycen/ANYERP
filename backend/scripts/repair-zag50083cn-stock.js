// 默认只读核查；--apply仅修复已核实的鹏瑞利铺货仓孤立余额。
const { randomUUID } = require('crypto');
const { Op } = require('sequelize');
const { sequelize, ProductSn, Inventory, Location } = require('../src/models');
const { syncSerializedInventoryBalance, SERIALIZED_STOCK_FIELDS } = require('../src/modules/inventory/serializedInventoryBalance');
const { recordBusinessAction } = require('../src/utils/businessActionLog');
const productId = '009391cc17854d9f855bc5228fecddf5';
const storeId = 'D0218262';
const inventoryId = 'a83aba9fab104591ad860c3043106719';
const fields = [...SERIALIZED_STOCK_FIELDS, 'regular_qty', 'subsidy_qty', 'second_qty'];

async function main() {
  const result = await sequelize.transaction(async transaction => {
    const sns = await ProductSn.findAll({
      where: { product_id: productId, is_deleted: 0, status: { [Op.in]: ['in_stock', 'reserved', 'occupied'] } },
      transaction, lock: transaction.LOCK.UPDATE, raw: true
    });
    if (sns.length !== 1 || sns[0].sn_code !== 'HA2AF3W9' || sns[0].store_id !== 'D0218603' || sns[0].status !== 'in_stock') {
      throw new Error('SN事实已变化，停止本次定向修复');
    }
    const demoLocation = await Location.findOne({ where: {
      location_id: sns[0].location_id, store_id: 'D0218603', type: 'demo_qty', status: 1
    }, transaction });
    if (!demoLocation) throw new Error('吾悦样机库位已变化，停止修复');
    const before = await Inventory.findAll({ where: { product_id: productId, store_id: storeId },
      transaction, lock: transaction.LOCK.UPDATE, raw: true });
    const target = before.find(row => row.inventory_id === inventoryId);
    if (!target) throw new Error('目标余额不存在');
    if (before.some(row => fields.some(field => Number(row[field] || 0) !==
      (row.inventory_id === inventoryId && field === 'display_qty' ? Number(target.display_qty) : 0)))
      || ![0, 1].includes(Number(target.display_qty))) throw new Error('库存余额已变化，停止修复');
    if (!process.argv.includes('--apply')) return { mode: 'preview', before, sn: sns[0].sn_code };
    if (Number(target.display_qty) === 0) return { changed: 0, message: '已修复，无需重复执行' };
    const result = await syncSerializedInventoryBalance({ productId, storeId, transaction });
    const after = await Inventory.findAll({ where: { product_id: productId, store_id: storeId }, raw: true, transaction });
    if (after.some(row => fields.some(field => Number(row[field] || 0) !== 0))) throw new Error('修复验证失败');
    const runId = randomUUID().replace(/-/g, '');
    await recordBusinessAction({ businessType: 'inventory_reconciliation', businessId: inventoryId,
      businessNo: 'ZAG50083CN-20260905', action: 'rebuild_serialized_balance',
      user: { name: 'Codex（库存差异修复）' },
      comment: '鹏瑞利铺货仓余额1，无当前SN；按现有SN事实同步规则修复为0。吾悦样品仓SN HA2AF3W9保留。',
      detail: { runId, before, after, currentSn: sns.map(row => ({ sn_code: row.sn_code, store_id: row.store_id, location_id: row.location_id })) }, transaction });
    await sequelize.query(`INSERT INTO T_INVENTORY_RECONCILIATION_LOG
      (RECONCILIATION_ID,RUN_ID,PRODUCT_ID,STORE_ID,LOCATION_ID,ACTION,BEFORE_NORMAL_QTY,AFTER_NORMAL_QTY,SN_QTY,DIFF,REASON,OPERATOR)
      VALUES (:id,:runId,:productId,:storeId,:locationId,'UPDATE',0,0,0,0,:reason,'Codex')`, {
      replacements: { id: randomUUID().replace(/-/g, ''), runId, productId, storeId, locationId: target.location_id,
        reason: 'display_qty 1 -> 0; no current SN; full snapshot in business action log ZAG50083CN-20260905' }, transaction
    });
    return { ...result, runId, beforeDisplay: 1, afterDisplay: 0, retainedSn: 'HA2AF3W9' };
  });
  console.log(JSON.stringify(result));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => sequelize.close());
