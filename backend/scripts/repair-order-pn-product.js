const { sequelize } = require('../src/models');
const { normalizePnCode } = require('../src/utils/productPn');

const orderNo = 'ORD202607151218081574';
const pnCode = '870017165';

async function repairOrderPnProduct() {
  const transaction = await sequelize.transaction();
  try {
    const [item] = await sequelize.query(
      `SELECT oi.ITEM_ID, oi.ORDER_ID, oi.PRODUCT_ID, oi.PRODUCT_NAME, oi.PN_CODE,
              oi.QUANTITY, o.ORDER_NO, o.ORDER_STATUS, o.STORE_ID,
              p.PRODUCT_CODE AS CURRENT_PRODUCT_CODE,
              pn.PRODUCT_ID AS PN_PRODUCT_ID,
              pnProduct.PRODUCT_CODE AS PN_PRODUCT_CODE,
              pnProduct.NAME AS PN_PRODUCT_NAME
       FROM T_ORDER_ITEM oi
       INNER JOIN T_ORDER o ON o.ORDER_ID = oi.ORDER_ID
       LEFT JOIN T_PRODUCT p ON p.PRODUCT_ID = oi.PRODUCT_ID
       INNER JOIN T_PRODUCT_PN pn
         ON LOWER(REPLACE(TRIM(pn.PN_CODE), ' ', '')) = ?
        AND pn.STATUS = 1 AND pn.IS_DELETED = 0
       INNER JOIN T_PRODUCT pnProduct ON pnProduct.PRODUCT_ID = pn.PRODUCT_ID
       WHERE o.ORDER_NO = ?
         AND LOWER(REPLACE(TRIM(oi.PN_CODE), ' ', '')) = ?
       FOR UPDATE`,
      { replacements: [normalizePnCode(pnCode), orderNo, normalizePnCode(pnCode)], type: sequelize.QueryTypes.SELECT, transaction }
    );
    if (!item) throw new Error(`未找到订单 ${orderNo} 中的 PN ${pnCode} 明细`);
    if (item.CURRENT_PRODUCT_CODE === item.PN_PRODUCT_CODE) {
      await transaction.commit();
      console.log('[Order PN Repair] 订单明细已经是正确商品，无需修改');
      return;
    }
    if (String(item.ORDER_STATUS || '') === '已归档') {
      throw new Error(`订单 ${orderNo} 已归档，禁止修改历史明细`);
    }
    if (String(item.PRODUCT_NAME || '').trim() !== String(item.PN_PRODUCT_NAME || '').trim()) {
      throw new Error(`订单商品名称与PN商品名称不一致，停止自动修复`);
    }

    const [stock] = await sequelize.query(
      `SELECT COALESCE(SUM(NORMAL_QTY + REGULAR_QTY + SUBSIDY_QTY + SECOND_QTY + DISPLAY_QTY + DEMO_QTY), 0) AS STOCK_QTY
       FROM T_INVENTORY
       WHERE PRODUCT_ID = ? AND STORE_ID = ?`,
      { replacements: [item.PN_PRODUCT_ID, item.STORE_ID], type: sequelize.QueryTypes.SELECT, transaction }
    );
    if (Number(stock.STOCK_QTY || 0) < Number(item.QUANTITY || 0)) {
      throw new Error(`PN商品门店库存不足，停止自动修复`);
    }

    await sequelize.query(
      `UPDATE T_ORDER_ITEM SET PRODUCT_ID = ? WHERE ITEM_ID = ?`,
      { replacements: [item.PN_PRODUCT_ID, item.ITEM_ID], transaction }
    );
    await transaction.commit();
    console.log(`[Order PN Repair] ${orderNo} 明细 ${item.ITEM_ID} 已从 ${item.CURRENT_PRODUCT_CODE} 修正为 ${item.PN_PRODUCT_CODE}`);
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

(async () => {
  try {
    await repairOrderPnProduct();
  } catch (error) {
    console.error('[Order PN Repair] 修复失败:', error.stack || error.message);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
})();

module.exports = { repairOrderPnProduct };
