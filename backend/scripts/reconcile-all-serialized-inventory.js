// 全量重建SN商品库存余额。默认预览；--apply执行并保存完整审计快照。
const crypto = require('crypto');
const { sequelize, Inventory } = require('../src/models');
const { syncSerializedInventoryBalance } = require('../src/modules/inventory/serializedInventoryBalance');
const { recordBusinessAction } = require('../src/utils/businessActionLog');

const APPLY = process.argv.includes('--apply');
const FIELDS = [
  'normal_qty', 'display_qty', 'demo_qty', 'unsellable_qty', 'pending_qty',
  'rental_demo_qty', 'regular_qty', 'subsidy_qty', 'second_qty'
];
const id = () => crypto.randomUUID().replace(/-/g, '');
const value = (row, field) => Number(row?.[field] || 0);
const changed = (before, after) => FIELDS.some(field => value(before, field) !== value(after, field));

async function scopes(transaction) {
  return sequelize.query(`
    SELECT DISTINCT keyscope.product_id, keyscope.store_id
    FROM (
      SELECT i.PRODUCT_ID product_id, i.STORE_ID store_id
      FROM T_INVENTORY i JOIN T_PRODUCT p ON p.PRODUCT_ID=i.PRODUCT_ID
      WHERE p.NEED_SN=1 AND p.STATUS=1 AND p.IS_DELETED=0
        AND (i.NORMAL_QTY<>0 OR i.DISPLAY_QTY<>0 OR i.DEMO_QTY<>0 OR i.UNSELLABLE_QTY<>0
          OR i.PENDING_QTY<>0 OR i.RENTAL_DEMO_QTY<>0 OR i.REGULAR_QTY<>0 OR i.SUBSIDY_QTY<>0 OR i.SECOND_QTY<>0)
      UNION
      SELECT sn.PRODUCT_ID, sn.STORE_ID
      FROM T_PRODUCT_SN sn JOIN T_PRODUCT p ON p.PRODUCT_ID=sn.PRODUCT_ID
      WHERE p.NEED_SN=1 AND p.STATUS=1 AND p.IS_DELETED=0 AND sn.IS_DELETED=0
        AND sn.STATUS IN ('in_stock','reserved','occupied')
    ) keyscope
    WHERE COALESCE(keyscope.store_id,'')<>''
    ORDER BY keyscope.product_id, keyscope.store_id`, { type: 'SELECT', transaction });
}

async function snapshot(productId, storeId, transaction) {
  return Inventory.findAll({ where: { product_id: productId, store_id: storeId },
    order: [['location_id', 'ASC']], raw: true, transaction });
}

function snapshotMap(rows) {
  return new Map(rows.map(row => [String(row.location_id || ''), row]));
}

async function main() {
  const runId = id();
  const list = await scopes();
  const changes = [];
  for (const scope of list) {
    const change = await sequelize.transaction(async transaction => {
      const before = await snapshot(scope.product_id, scope.store_id, transaction);
      await syncSerializedInventoryBalance({ productId: scope.product_id, storeId: scope.store_id, transaction });
      const after = await snapshot(scope.product_id, scope.store_id, transaction);
      const beforeMap = snapshotMap(before);
      const afterMap = snapshotMap(after);
      const locationIds = new Set([...beforeMap.keys(), ...afterMap.keys()]);
      const rowChanges = [...locationIds].filter(locationId => changed(beforeMap.get(locationId), afterMap.get(locationId)));
      if (!rowChanges.length) return null;
      const detail = { product_id: scope.product_id, store_id: scope.store_id, locations: rowChanges, before, after };
      if (!APPLY) throw Object.assign(new Error('__PREVIEW_ROLLBACK__'), { detail });
      await recordBusinessAction({ businessType: 'inventory_reconciliation',
        businessId: `${scope.product_id}:${scope.store_id}`, businessNo: `SN-ALL-${runId}`,
        action: 'rebuild_serialized_balance', user: { name: 'Codex（用户确认全量优化）' },
        comment: '用户确认全部SN商品库存余额与当前SN事实保持一致。',
        detail: { runId, before, after }, transaction });
      for (const locationId of rowChanges) {
        const oldRow = beforeMap.get(locationId) || {};
        const newRow = afterMap.get(locationId) || {};
        await sequelize.query(`INSERT INTO T_INVENTORY_RECONCILIATION_LOG
          (RECONCILIATION_ID,RUN_ID,PRODUCT_ID,STORE_ID,LOCATION_ID,ACTION,
           BEFORE_NORMAL_QTY,AFTER_NORMAL_QTY,SN_QTY,DIFF,REASON,OPERATOR)
          VALUES (:id,:runId,:productId,:storeId,:locationId,:action,:before,:after,:after,:diff,:reason,:operator)`, {
          replacements: { id: id(), runId, productId: scope.product_id, storeId: scope.store_id,
            locationId, action: beforeMap.has(locationId) ? 'UPDATE' : 'INSERT',
            before: value(oldRow, 'normal_qty'), after: value(newRow, 'normal_qty'),
            diff: value(newRow, 'normal_qty') - value(oldRow, 'normal_qty'),
            reason: 'all serialized inventory fields rebuilt; full snapshot in business action log',
            operator: 'Codex（用户确认全量优化）' }, transaction
        });
      }
      return detail;
    }).catch(error => {
      if (error.message === '__PREVIEW_ROLLBACK__') return error.detail;
      throw error;
    });
    if (change) changes.push(change);
  }
  const result = { runId, scannedScopes: list.length, changedScopes: changes.length,
    changedLocations: changes.reduce((sum, item) => sum + item.locations.length, 0), changes };
  console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'preview', ...result }));
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => sequelize.close());
