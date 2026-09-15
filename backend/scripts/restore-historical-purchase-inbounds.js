/**
 * Restore the user-approved historical purchase inbound statuses after the
 * backend that contained a startup rewrite has been replaced.
 *
 * This script changes T_INBOUND.STATUS only. It does not call any inbound,
 * inventory, SN, payable, or settlement business service.
 *
 * Usage:
 *   node scripts/restore-historical-purchase-inbounds.js --preview
 *   node scripts/restore-historical-purchase-inbounds.js --execute
 */
const { sequelize } = require('../src/models');

const execute = process.argv.includes('--execute');
const preview = process.argv.includes('--preview');
const cutoff = '2026-08-31 00:00:00';

if (!execute && !preview) {
  console.error('Use --preview to inspect targets or --execute to restore statuses.');
  process.exitCode = 1;
  return;
}

const targetSql = `
  SELECT INBOUND_ID, INBOUND_NO, STATUS, SOURCE_TYPE, PURCHASE_REQUEST_ID, CREATE_TIME, UPDATE_TIME
  FROM T_INBOUND
  WHERE STATUS = 'pending'
    AND (LOWER(COALESCE(SOURCE_TYPE, '')) = 'purchase' OR PURCHASE_REQUEST_ID IS NOT NULL)
    AND CREATE_TIME < ?
  ORDER BY CREATE_TIME, INBOUND_NO`;

async function main() {
  await sequelize.authenticate();
  const targets = await sequelize.query(targetSql, {
    replacements: [cutoff],
    type: sequelize.QueryTypes.SELECT
  });
  console.log(JSON.stringify({
    mode: execute ? 'execute' : 'preview',
    cutoff,
    count: targets.length,
    targets
  }, null, 2));
  if (!execute || !targets.length) return;

  await sequelize.transaction(async transaction => {
    const [result] = await sequelize.query(`
      UPDATE T_INBOUND
      SET STATUS = 'completed', UPDATE_TIME = NOW()
      WHERE STATUS = 'pending'
        AND INBOUND_ID IN (${targets.map(() => '?').join(', ')})`, {
      replacements: targets.map(row => row.INBOUND_ID),
      transaction
    });
    const affected = Number(result.affectedRows || 0);
    if (affected !== targets.length) {
      throw new Error(`Expected to update ${targets.length} inbounds, updated ${affected}`);
    }
  });
  console.log(JSON.stringify({ mode: 'execute', updated: targets.length }, null, 2));
}

main()
  .catch(error => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => sequelize.close());
