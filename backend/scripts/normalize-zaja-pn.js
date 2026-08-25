const { sequelize } = require('../src/config/database');
const { ensureProductPnEffectiveUniqueIndex } = require('../src/utils/dbMigration');

const TARGET_PRODUCT_CODE = 'SP04956';
const DELETED_PRODUCT_CODE = 'SP04953';
const TARGET_PN = 'ZAJA0002CN';
const LEGACY_PN = '(1S)ZAJA0002CN';

function normalizePn(value) {
  return String(value || '').trim().replace(/\s+/g, '').toLowerCase();
}

async function normalizeZajaPn() {
  await ensureProductPnEffectiveUniqueIndex();
  const transaction = await sequelize.transaction();

  try {
    const [target] = await sequelize.query(
      `SELECT PRODUCT_ID, PRODUCT_CODE, STATUS, IS_DELETED
       FROM T_PRODUCT
       WHERE PRODUCT_CODE = ?
       FOR UPDATE`,
      { replacements: [TARGET_PRODUCT_CODE], type: sequelize.QueryTypes.SELECT, transaction }
    );
    if (!target || Number(target.STATUS) !== 1 || Number(target.IS_DELETED) !== 0) {
      throw new Error(`目标商品 ${TARGET_PRODUCT_CODE} 不是启用商品`);
    }

    const [deletedProduct] = await sequelize.query(
      `SELECT PRODUCT_ID, PRODUCT_CODE, STATUS, IS_DELETED
       FROM T_PRODUCT
       WHERE PRODUCT_CODE = ?
       FOR UPDATE`,
      { replacements: [DELETED_PRODUCT_CODE], type: sequelize.QueryTypes.SELECT, transaction }
    );
    if (!deletedProduct || Number(deletedProduct.IS_DELETED) !== 1) {
      throw new Error(`历史商品 ${DELETED_PRODUCT_CODE} 不存在或未处于删除状态`);
    }

    const [sourceSnEvidence] = await sequelize.query(
      `SELECT COUNT(*) AS cnt
       FROM T_PRODUCT_SN
       WHERE PRODUCT_ID = ?
         AND IS_DELETED = 0
         AND STATUS IN ('in_stock', 'reserved', 'transferring')`,
      { replacements: [deletedProduct.PRODUCT_ID], type: sequelize.QueryTypes.SELECT, transaction }
    );
    if (Number(sourceSnEvidence.cnt || 0) > 0) {
      throw new Error(`历史商品 ${DELETED_PRODUCT_CODE} 仍有可用SN，停止归集`);
    }

    const activePnRows = await sequelize.query(
      `SELECT PN_ID, PRODUCT_ID, PN_CODE, STATUS, IS_DELETED
       FROM T_PRODUCT_PN
       WHERE PRODUCT_ID = ?
         AND STATUS = 1
         AND IS_DELETED = 0
       FOR UPDATE`,
      { replacements: [target.PRODUCT_ID], type: sequelize.QueryTypes.SELECT, transaction }
    );
    if (activePnRows.length !== 1) {
      throw new Error(`目标商品 ${TARGET_PRODUCT_CODE} 当前有效PN数量为${activePnRows.length}，不是1条`);
    }
    const targetPn = activePnRows[0];
    if (![normalizePn(LEGACY_PN), normalizePn(TARGET_PN)].includes(normalizePn(targetPn.PN_CODE))) {
      throw new Error(`目标商品当前PN为 ${targetPn.PN_CODE}，不是预期历史PN`);
    }

    const conflictingActiveRows = await sequelize.query(
      `SELECT PN_ID, PRODUCT_ID, PN_CODE
       FROM T_PRODUCT_PN
       WHERE LOWER(REPLACE(TRIM(PN_CODE), ' ', '')) = ?
         AND STATUS = 1
         AND IS_DELETED = 0
         AND PRODUCT_ID <> ?
       FOR UPDATE`,
      { replacements: [normalizePn(TARGET_PN), target.PRODUCT_ID], type: sequelize.QueryTypes.SELECT, transaction }
    );
    if (conflictingActiveRows.length > 0) {
      throw new Error(`PN ${TARGET_PN} 已被其他有效商品使用，停止归集`);
    }

    const [pnUpdate] = await sequelize.query(
      `UPDATE T_PRODUCT_PN
       SET PN_CODE = ?, STATUS = 1, IS_DELETED = 0, IS_PRIMARY = 1
       WHERE PN_ID = ?`,
      { replacements: [TARGET_PN, targetPn.PN_ID], transaction }
    );
    await sequelize.query(
      `UPDATE T_PRODUCT
       SET MANUFACTURER_CODE = ?
       WHERE PRODUCT_ID = ?`,
      { replacements: [TARGET_PN, target.PRODUCT_ID], transaction }
    );
    const [snUpdate] = await sequelize.query(
      `UPDATE T_PRODUCT_SN
       SET PN_CODE = ?
       WHERE PRODUCT_ID = ?
         AND IS_DELETED = 0
         AND LOWER(REPLACE(TRIM(PN_CODE), ' ', '')) = ?`,
      { replacements: [TARGET_PN, target.PRODUCT_ID, normalizePn(LEGACY_PN)], transaction }
    );
    await sequelize.query(
      `UPDATE T_PRODUCT_PN
       SET STATUS = 0, IS_DELETED = 1
       WHERE PRODUCT_ID = ?
         AND PN_ID <> ?`,
      { replacements: [deletedProduct.PRODUCT_ID, targetPn.PN_ID], transaction }
    );

    await transaction.commit();
    console.log(JSON.stringify({
      targetProduct: TARGET_PRODUCT_CODE,
      canonicalPn: TARGET_PN,
      targetPnId: targetPn.PN_ID,
      updatedPnRows: pnUpdate.affectedRows,
      updatedSnRows: snUpdate.affectedRows,
      historicalProductKept: DELETED_PRODUCT_CODE,
      historicalPnKept: true
    }, null, 2));
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

normalizeZajaPn()
  .catch(error => {
    console.error('[Normalize ZAJA PN] 处理失败:', error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());

module.exports = { normalizeZajaPn };
