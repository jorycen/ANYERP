const crypto = require('crypto');
const { sequelize, Inventory } = require('../src/models');
const { syncSerializedInventoryBalance } = require('../src/modules/inventory/serializedInventoryBalance');

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.find(arg => arg.startsWith('--limit='));
const LIMIT = limitArg ? Math.max(Number(limitArg.split('=')[1]) || 0, 0) : 0;

const mismatchSql = `
  SELECT scope.product_id,
         scope.store_id,
         scope.location_id,
         scope.before_normal_qty,
         scope.sn_qty,
         scope.sn_qty - scope.before_normal_qty AS diff
  FROM (
    SELECT i.PRODUCT_ID AS product_id,
           i.STORE_ID AS store_id,
           COALESCE(i.LOCATION_ID, '') AS location_id,
           COALESCE(i.NORMAL_QTY, 0) AS before_normal_qty,
           COALESCE(sn.sn_qty, 0) AS sn_qty
    FROM T_INVENTORY i
    INNER JOIN T_PRODUCT p
      ON p.PRODUCT_ID = i.PRODUCT_ID
     AND p.NEED_SN = 1
     AND p.STATUS = 1
     AND p.IS_DELETED = 0
    LEFT JOIN (
      SELECT s.PRODUCT_ID,
             s.STORE_ID,
             s.LOCATION_ID,
             COUNT(*) AS sn_qty
      FROM T_PRODUCT_SN s
      INNER JOIN T_LOCATION l
        ON l.LOCATION_ID = s.LOCATION_ID
       AND l.STORE_ID = s.STORE_ID
       AND l.TYPE = 'normal_qty'
       AND l.STATUS = 1
      WHERE s.STATUS = 'in_stock'
        AND s.IS_DELETED = 0
      GROUP BY s.PRODUCT_ID, s.STORE_ID, s.LOCATION_ID
    ) sn
      ON sn.PRODUCT_ID = i.PRODUCT_ID
     AND sn.STORE_ID = i.STORE_ID
     AND sn.LOCATION_ID = i.LOCATION_ID
    UNION
    SELECT sn.PRODUCT_ID AS product_id,
           sn.STORE_ID AS store_id,
           sn.LOCATION_ID AS location_id,
           COALESCE(i.NORMAL_QTY, 0) AS before_normal_qty,
           sn.sn_qty AS sn_qty
    FROM (
      SELECT s.PRODUCT_ID,
             s.STORE_ID,
             s.LOCATION_ID,
             COUNT(*) AS sn_qty
      FROM T_PRODUCT_SN s
      INNER JOIN T_PRODUCT p
        ON p.PRODUCT_ID = s.PRODUCT_ID
       AND p.NEED_SN = 1
       AND p.STATUS = 1
       AND p.IS_DELETED = 0
      INNER JOIN T_LOCATION l
        ON l.LOCATION_ID = s.LOCATION_ID
       AND l.STORE_ID = s.STORE_ID
       AND l.TYPE = 'normal_qty'
       AND l.STATUS = 1
      WHERE s.STATUS = 'in_stock'
        AND s.IS_DELETED = 0
      GROUP BY s.PRODUCT_ID, s.STORE_ID, s.LOCATION_ID
    ) sn
    LEFT JOIN T_INVENTORY i
      ON i.PRODUCT_ID = sn.PRODUCT_ID
     AND i.STORE_ID = sn.STORE_ID
     AND i.LOCATION_ID = sn.LOCATION_ID
  ) scope
  WHERE scope.before_normal_qty <> scope.sn_qty
  ORDER BY ABS(scope.sn_qty - scope.before_normal_qty) DESC,
           scope.product_id,
           scope.store_id,
           scope.location_id
`;

function newId() {
  return crypto.randomUUID().replace(/-/g, '');
}

function toNumber(value) {
  return Number(value || 0);
}

function changedInventoryFields(before, after) {
  const fields = [
    'normal_qty', 'display_qty', 'demo_qty', 'unsellable_qty',
    'pending_qty', 'rental_demo_qty', 'regular_qty', 'subsidy_qty', 'second_qty'
  ];
  return fields.some(field => toNumber(before?.[field]) !== toNumber(after?.[field]));
}

async function loadMismatches() {
  const rows = await sequelize.query(mismatchSql, { type: sequelize.QueryTypes.SELECT });
  return LIMIT > 0 ? rows.slice(0, LIMIT) : rows;
}

async function snapshotInventory(productId, storeId, transaction) {
  const rows = await Inventory.findAll({
    where: { product_id: productId, store_id: storeId },
    raw: true,
    transaction
  });
  return new Map(rows.map(row => [String(row.location_id || ''), row]));
}

async function writeReconciliationLog({ runId, productId, storeId, before, after, transaction }) {
  const beforeRow = before || {};
  const afterRow = after || {};
  await sequelize.query(
    `INSERT INTO T_INVENTORY_RECONCILIATION_LOG
       (RECONCILIATION_ID, RUN_ID, PRODUCT_ID, STORE_ID, LOCATION_ID, ACTION,
        BEFORE_NORMAL_QTY, AFTER_NORMAL_QTY, SN_QTY, DIFF, REASON, OPERATOR)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    {
      replacements: [
        newId(),
        runId,
        productId,
        storeId,
        String(afterRow.location_id || beforeRow.location_id || ''),
        before ? 'UPDATE' : 'INSERT',
        toNumber(beforeRow.normal_qty),
        toNumber(afterRow.normal_qty),
        toNumber(afterRow.normal_qty),
        toNumber(afterRow.normal_qty) - toNumber(beforeRow.normal_qty),
        'serialized_inventory_projection_rebuild',
        'serialized_inventory_reconciliation'
      ],
      transaction
    }
  );
}

async function applyMismatches(rows) {
  const runId = newId();
  let changedRows = 0;

  await sequelize.transaction(async transaction => {
    const scopes = new Map();
    rows.forEach(row => {
      const key = `${row.product_id}|${row.store_id}`;
      scopes.set(key, { productId: row.product_id, storeId: row.store_id });
    });

    for (const { productId, storeId } of scopes.values()) {
      const before = await snapshotInventory(productId, storeId, transaction);
      await syncSerializedInventoryBalance({ productId, storeId, transaction });
      const after = await snapshotInventory(productId, storeId, transaction);

      for (const [locationId, afterRow] of after.entries()) {
        const beforeRow = before.get(locationId);
        if (!beforeRow || changedInventoryFields(beforeRow, afterRow)) {
          await writeReconciliationLog({
            runId,
            productId,
            storeId,
            before: beforeRow,
            after: afterRow,
            transaction
          });
          changedRows += 1;
        }
      }
    }
  });

  return { runId, changedRows };
}

async function main() {
  const rows = await loadMismatches();
  const summary = {
    generatedAt: new Date().toISOString(),
    mode: APPLY ? 'apply' : 'audit',
    limit: LIMIT || null,
    mismatchRows: rows.length,
    inventoryNormalQty: rows.reduce((sum, row) => sum + toNumber(row.before_normal_qty), 0),
    serializedSnQty: rows.reduce((sum, row) => sum + toNumber(row.sn_qty), 0),
    difference: rows.reduce((sum, row) => sum + toNumber(row.diff), 0),
    top: rows.slice(0, 20)
  };

  if (!APPLY) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const result = await applyMismatches(rows);
  console.log(JSON.stringify({ ...summary, ...result }, null, 2));
}

main()
  .catch(error => {
    console.error('[Serialized Inventory Reconciliation] failed:', error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
