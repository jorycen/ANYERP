/**
 * 修复已执行但未生成采购调整/负向应付款的历史采购退库单。
 * 用法：node scripts/repair-purchase-return.js RTN20260826043915938
 */
const { sequelize, ReturnStock } = require('../src/models');
const { ensurePurchaseReturnAccounting } = require('../src/modules/purchase/purchaseReturnAccounting');

async function ensureRepairSchema() {
  const [column] = await sequelize.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'T_RETURN_STOCK'
       AND COLUMN_NAME = 'DISTRIBUTOR_ID'`,
    { type: sequelize.QueryTypes.SELECT }
  );
  if (Number(column?.cnt || 0) === 0) {
    await sequelize.query(
      'ALTER TABLE T_RETURN_STOCK ADD COLUMN DISTRIBUTOR_ID VARCHAR(32) COMMENT "退库所属经销商快照" AFTER PURCHASE_REQUEST_ID'
    );
    console.log('[Repair] 已补齐 T_RETURN_STOCK.DISTRIBUTOR_ID');
  }
}

async function main() {
  const returnNo = String(process.argv[2] || '').trim();
  if (!returnNo) throw new Error('请传入退库单号');

  await sequelize.authenticate();
  await ensureRepairSchema();
  const result = await sequelize.transaction(async transaction => {
    const returnStock = await ReturnStock.findOne({
      where: { return_no: returnNo },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!returnStock) throw new Error(`退库单 ${returnNo} 不存在`);
    if (returnStock.status !== 'completed') {
      throw new Error(`退库单 ${returnNo} 当前状态为 ${returnStock.status}，仅允许修复已执行退库单`);
    }
    return ensurePurchaseReturnAccounting({
      returnStock,
      transaction,
      userName: '历史退库修复'
    });
  });

  console.log(JSON.stringify({ returnNo, ...result }, null, 2));
}

main()
  .catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close();
  });
