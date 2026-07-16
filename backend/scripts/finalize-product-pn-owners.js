const { randomUUID } = require('crypto');
const { sequelize } = require('../src/models');
const { normalizePnCode } = require('../src/utils/productPn');

const mappings = [
  { activeProductCode: 'SP02907', pnCode: 'F0HM00L8CD', inactiveProductCode: 'SP04584' },
  { activeProductCode: 'SP00437', pnCode: 'ZAG60158CN', inactiveProductCode: 'SP02845' }
];

async function finalizeProductPnOwners() {
  const transaction = await sequelize.transaction();
  try {
    for (const mapping of mappings) {
      const [activeProduct] = await sequelize.query(
        `SELECT PRODUCT_ID, PRODUCT_CODE, STATUS, IS_DELETED
         FROM T_PRODUCT WHERE PRODUCT_CODE = ? FOR UPDATE`,
        { replacements: [mapping.activeProductCode], type: sequelize.QueryTypes.SELECT, transaction }
      );
      if (!activeProduct || Number(activeProduct.STATUS) !== 1 || Number(activeProduct.IS_DELETED) !== 0) {
        throw new Error(`目标商品 ${mapping.activeProductCode} 不是启用商品，停止修复`);
      }

      const [evidence] = await sequelize.query(
        `SELECT
           (SELECT COALESCE(SUM(NORMAL_QTY + REGULAR_QTY + SUBSIDY_QTY + SECOND_QTY + DISPLAY_QTY + DEMO_QTY), 0)
              FROM T_INVENTORY WHERE PRODUCT_ID = ?) AS STOCK_QTY,
           (SELECT COUNT(*) FROM T_PRODUCT_SN
             WHERE PRODUCT_ID = ? AND IS_DELETED = 0 AND STATUS IN ('reserved', 'in_stock')) AS SN_COUNT`,
        { replacements: [activeProduct.PRODUCT_ID, activeProduct.PRODUCT_ID], type: sequelize.QueryTypes.SELECT, transaction }
      );
      if (Number(evidence.STOCK_QTY || 0) <= 0 && Number(evidence.SN_COUNT || 0) <= 0) {
        throw new Error(`目标商品 ${mapping.activeProductCode} 没有库存或可用SN证据，停止修复`);
      }

      const normalizedCode = normalizePnCode(mapping.pnCode);
      const pnRows = await sequelize.query(
        `SELECT PN_ID, PRODUCT_ID, PN_CODE, STATUS, IS_DELETED
         FROM T_PRODUCT_PN
         WHERE LOWER(REPLACE(TRIM(PN_CODE), ' ', '')) = ?
         FOR UPDATE`,
        { replacements: [normalizedCode], type: sequelize.QueryTypes.SELECT, transaction }
      );
      const conflicting = pnRows.find(row => String(row.PRODUCT_ID) !== String(activeProduct.PRODUCT_ID));
      if (conflicting) {
        throw new Error(`PN ${mapping.pnCode} 已关联其他商品 ${conflicting.PRODUCT_ID}，停止修复`);
      }

      const sameProduct = pnRows[0];
      if (sameProduct) {
        await sequelize.query(
          `UPDATE T_PRODUCT_PN
           SET PN_CODE = ?, BARCODE = ?, STATUS = 1, IS_DELETED = 0, IS_PRIMARY = 1
           WHERE PN_ID = ?`,
          { replacements: [mapping.pnCode, mapping.pnCode, sameProduct.PN_ID], transaction }
        );
      } else {
        await sequelize.query(
          `INSERT INTO T_PRODUCT_PN
           (PN_ID, PRODUCT_ID, PN_CODE, BARCODE, IS_PRIMARY, STATUS, IS_DELETED)
           VALUES (?, ?, ?, ?, 1, 1, 0)`,
          { replacements: [randomUUID().replace(/-/g, '').slice(0, 32), activeProduct.PRODUCT_ID, mapping.pnCode, mapping.pnCode], transaction }
        );
      }

      const [inactiveProduct] = await sequelize.query(
        `SELECT PRODUCT_ID, PRODUCT_CODE, STATUS, IS_DELETED
         FROM T_PRODUCT WHERE PRODUCT_CODE = ? FOR UPDATE`,
        { replacements: [mapping.inactiveProductCode], type: sequelize.QueryTypes.SELECT, transaction }
      );
      if (inactiveProduct && (Number(inactiveProduct.STATUS) !== 0 || Number(inactiveProduct.IS_DELETED) !== 0)) {
        throw new Error(`重复商品 ${mapping.inactiveProductCode} 未停用，停止修复`);
      }
      if (inactiveProduct) {
        await sequelize.query(
          `UPDATE T_PRODUCT_BARCODE SET STATUS = 0
           WHERE PRODUCT_ID = ? AND BARCODE_TYPE = 'manufacturer' AND STATUS = 1`,
          { replacements: [inactiveProduct.PRODUCT_ID], transaction }
        );
      }
    }
    await transaction.commit();
    console.log('[PN Owner Finalize] 启用商品PN归属和停用商品条码清理完成');
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

(async () => {
  try {
    await finalizeProductPnOwners();
  } catch (error) {
    console.error('[PN Owner Finalize] 处理失败:', error.stack || error.message);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
})();

module.exports = { finalizeProductPnOwners };
