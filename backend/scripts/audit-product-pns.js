const { sequelize } = require('../src/models');
const { normalizePnCode, splitPnCodes, isUsablePnCode } = require('../src/utils/productPn');

async function auditProductPns() {
  const [products, barcodes, pnRows, stockRows, snRows] = await Promise.all([
    sequelize.query(
      `SELECT PRODUCT_ID, PRODUCT_CODE, NAME, MANUFACTURER_CODE
       FROM T_PRODUCT WHERE STATUS = 1 AND IS_DELETED = 0`,
      { type: sequelize.QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT b.PRODUCT_ID, b.BARCODE_CODE
       FROM T_PRODUCT_BARCODE b
       INNER JOIN T_PRODUCT p ON p.PRODUCT_ID = b.PRODUCT_ID
       WHERE b.BARCODE_TYPE = 'manufacturer' AND b.STATUS = 1
         AND p.STATUS = 1 AND p.IS_DELETED = 0`,
      { type: sequelize.QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT PRODUCT_ID, PN_CODE
       FROM T_PRODUCT_PN
       WHERE STATUS = 1 AND IS_DELETED = 0`,
      { type: sequelize.QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT PRODUCT_ID,
              SUM(COALESCE(NORMAL_QTY, 0) + COALESCE(REGULAR_QTY, 0) +
                  COALESCE(SUBSIDY_QTY, 0) + COALESCE(SECOND_QTY, 0) +
                  COALESCE(DISPLAY_QTY, 0) + COALESCE(DEMO_QTY, 0)) AS STOCK_QTY
       FROM T_INVENTORY GROUP BY PRODUCT_ID`,
      { type: sequelize.QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT PRODUCT_ID, COUNT(*) AS SN_COUNT
       FROM T_PRODUCT_SN
       WHERE IS_DELETED = 0 AND STATUS IN ('reserved', 'in_stock')
       GROUP BY PRODUCT_ID`,
      { type: sequelize.QueryTypes.SELECT }
    )
  ]);

  const codesByProduct = new Map();
  const addCode = (productId, rawCode) => {
    const code = String(rawCode || '').trim();
    if (!productId || !isUsablePnCode(code)) return;
    const key = normalizePnCode(code);
    if (!codesByProduct.has(productId)) codesByProduct.set(productId, new Map());
    codesByProduct.get(productId).set(key, code);
  };
  for (const product of products) {
    splitPnCodes(product.MANUFACTURER_CODE).forEach(code => addCode(product.PRODUCT_ID, code));
  }
  for (const barcode of barcodes) addCode(barcode.PRODUCT_ID, barcode.BARCODE_CODE);

  const pnByProduct = new Map();
  const pnOwners = new Map();
  for (const row of pnRows) {
    const key = normalizePnCode(row.PN_CODE);
    if (!key) continue;
    if (!pnByProduct.has(row.PRODUCT_ID)) pnByProduct.set(row.PRODUCT_ID, new Set());
    pnByProduct.get(row.PRODUCT_ID).add(key);
    if (!pnOwners.has(key)) pnOwners.set(key, new Set());
    pnOwners.get(key).add(row.PRODUCT_ID);
  }

  const stockByProduct = new Map(stockRows.map(row => [row.PRODUCT_ID, Number(row.STOCK_QTY || 0)]));
  const snByProduct = new Map(snRows.map(row => [row.PRODUCT_ID, Number(row.SN_COUNT || 0)]));
  const productById = new Map(products.map(product => [product.PRODUCT_ID, product]));
  const missing = [];
  const conflicts = [];
  for (const [productId, codes] of codesByProduct) {
    const owned = pnByProduct.get(productId) || new Set();
    const missingCodes = [...codes.entries()]
      .filter(([key]) => !owned.has(key))
      .map(([, code]) => code);
    if (missingCodes.length) {
      const product = productById.get(productId) || {};
      missing.push({
        productId,
        productCode: product.PRODUCT_CODE,
        name: product.NAME,
        missingCodes,
        stockQty: stockByProduct.get(productId) || 0,
        snCount: snByProduct.get(productId) || 0
      });
    }
  }
  for (const [code, owners] of pnOwners) {
    if (owners.size > 1) conflicts.push({ code, productIds: [...owners] });
  }

  return {
    summary: {
      activeProducts: products.length,
      activePnRows: pnRows.length,
      missingProducts: missing.length,
      missingWithStock: missing.filter(row => row.stockQty > 0).length,
      missingWithSn: missing.filter(row => row.snCount > 0).length,
      duplicatePnCodes: conflicts.length
    },
    missing,
    conflicts
  };
}

(async () => {
  try {
    console.log(JSON.stringify(await auditProductPns(), null, 2));
  } catch (error) {
    console.error('[PN Audit] 审计失败:', error.stack || error.message);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
})();

module.exports = { auditProductPns };
