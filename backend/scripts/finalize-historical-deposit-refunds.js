const fs = require('fs');
const path = require('path');
const { sequelize } = require('../src/models');
const { QueryTypes } = require('sequelize');

const execute = process.argv.includes('--execute');
const cutoff = '2026-09-15 00:00:00';

const candidateSql = `
  SELECT r.REFUND_ID AS refundId, r.REFUND_NO AS refundNo, r.AMOUNT AS refundAmount,
         r.CREATE_TIME AS refundCreateTime, d.DEPOSIT_NO AS depositNo,
         d.STATUS AS depositStatus, d.REFUNDED_AMOUNT AS refundedAmount
    FROM T_DEPOSIT_REFUND r
    INNER JOIN T_DEPOSIT_ORDER d ON d.DEPOSIT_ID = r.DEPOSIT_ID
   WHERE r.STATUS = 'pending'
     AND r.APPROVAL_STAGE = 'pending_store'
     AND r.CREATE_TIME < :cutoff
     AND d.STATUS = 'refunded'
     AND d.REDEEMED_AMOUNT = 0
     AND r.AMOUNT = d.REFUNDED_AMOUNT
   ORDER BY r.CREATE_TIME ASC, r.REFUND_ID ASC`;

async function main() {
  const candidates = await sequelize.query(candidateSql, {
    replacements: { cutoff }, type: QueryTypes.SELECT
  });
  console.log(JSON.stringify({ mode: execute ? 'execute' : 'preview', cutoff, count: candidates.length, candidates }, null, 2));
  if (!execute) return;
  if (candidates.length !== 19) throw new Error(`安全中止：预期仅处理19笔历史退款，当前命中${candidates.length}笔`);

  const backupDir = path.resolve(__dirname, '../../backup/historical-deposit-refund-finalization-20260917');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, 'before.json'), JSON.stringify(candidates, null, 2));

  await sequelize.transaction(async transaction => {
    await sequelize.query(`
      UPDATE T_DEPOSIT_REFUND
         SET STATUS = 'approved', APPROVAL_STAGE = 'approved'
       WHERE REFUND_ID IN (:ids)
         AND STATUS = 'pending'
         AND APPROVAL_STAGE = 'pending_store'`, {
      replacements: { ids: candidates.map(row => row.refundId) }, transaction, type: QueryTypes.UPDATE
    });
  });

  const after = await sequelize.query(`
    SELECT STATUS AS status, APPROVAL_STAGE AS approvalStage, COUNT(*) AS count
      FROM T_DEPOSIT_REFUND
     WHERE REFUND_ID IN (:ids)
     GROUP BY STATUS, APPROVAL_STAGE`, {
    replacements: { ids: candidates.map(row => row.refundId) }, type: QueryTypes.SELECT
  });
  fs.writeFileSync(path.join(backupDir, 'after.json'), JSON.stringify(after, null, 2));
  console.log(JSON.stringify({ updated: candidates.length, after, backupDir }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => sequelize.close());
