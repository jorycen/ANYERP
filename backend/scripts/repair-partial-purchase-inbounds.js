/**
 * Preview or explicitly repair purchase inbound records whose receipt detail
 * is incomplete. This must never run during API startup.
 *
 * Usage:
 *   node scripts/repair-partial-purchase-inbounds.js --preview
 *   node scripts/repair-partial-purchase-inbounds.js --execute
 */
const { sequelize } = require('../src/models');

const execute = process.argv.includes('--execute');
const preview = process.argv.includes('--preview');

if (!execute && !preview) {
  console.error('Use --preview to inspect targets or --execute to perform the repair.');
  process.exitCode = 1;
  return;
}

const targetSql = `
  SELECT inbound.INBOUND_ID, inbound.INBOUND_NO, inbound.STATUS, inbound.CREATE_TIME,
    SUM(COALESCE(item.QUANTITY, 0)) AS total_quantity,
    SUM(COALESCE(item.RECEIVED_QUANTITY, 0)) AS received_quantity
  FROM T_INBOUND inbound
  INNER JOIN T_INBOUND_ITEM item ON item.INBOUND_ID = inbound.INBOUND_ID
  WHERE inbound.STATUS = 'completed'
    AND (LOWER(COALESCE(inbound.SOURCE_TYPE, '')) = 'purchase' OR inbound.PURCHASE_REQUEST_ID IS NOT NULL)
  GROUP BY inbound.INBOUND_ID, inbound.INBOUND_NO, inbound.STATUS, inbound.CREATE_TIME
  HAVING SUM(COALESCE(item.RECEIVED_QUANTITY, 0)) < SUM(COALESCE(item.QUANTITY, 0))
  ORDER BY inbound.CREATE_TIME, inbound.INBOUND_NO`;

async function main() {
  await sequelize.authenticate();
  const targets = await sequelize.query(targetSql, { type: sequelize.QueryTypes.SELECT });
  console.log(JSON.stringify({ mode: execute ? 'execute' : 'preview', count: targets.length, targets }, null, 2));
  if (!execute || targets.length === 0) return;

  await sequelize.transaction(async transaction => {
    const [result] = await sequelize.query(`
      UPDATE T_INBOUND inbound
      SET inbound.STATUS = 'pending', inbound.UPDATE_TIME = NOW()
      WHERE inbound.INBOUND_ID IN (${targets.map(() => '?').join(', ')})
        AND inbound.STATUS = 'completed'`, {
      replacements: targets.map(item => item.INBOUND_ID),
      transaction
    });
    if (Number(result.affectedRows || 0) !== targets.length) {
      throw new Error(`Expected to update ${targets.length} inbounds, updated ${result.affectedRows || 0}`);
    }
  });
  console.log(JSON.stringify({ mode: 'execute', updated: targets.length }, null, 2));
}

main()
  .catch(error => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => sequelize.close());
