// One-time data correction. Preview by default; pass --execute after reviewing the list.
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../src/models');

const suppliers = [
  { id: 'SP2026091522196', name: '抖音（官旗）直播间' },
  { id: 'SP2026071555763', name: '成都荣创世纪科技有限公司' }
];
const productIds = [
  'be70c84d6922443d98fadd9f27384920',
  '753d738086864b708ac8047b35c91367',
  '0d5c5a3cb0c14352902c399aa3fcc6b3',
  'd78cffa899344c18a5d83737d6572e2f'
];

async function main() {
  const execute = process.argv.includes('--execute');
  const supplierIds = suppliers.map(item => item.id);
  const actualSuppliers = await sequelize.query(
    'SELECT SUPPLIER_ID id, NAME name FROM T_SUPPLIER WHERE IS_DELETED = 0 AND SUPPLIER_ID IN (:supplierIds)',
    { replacements: { supplierIds }, type: QueryTypes.SELECT }
  );
  for (const supplier of suppliers) {
    if (!actualSuppliers.some(item => item.id === supplier.id && item.name === supplier.name)) {
      throw new Error(`供应商主数据不匹配：${supplier.name}，已停止`);
    }
  }

  const rows = await sequelize.query(`
    SELECT p.PRODUCT_ID productId, p.NAME productName, p.GROSS_PROFIT_COST_MODE costMode,
           COUNT(*) stockCount,
           (SELECT MAX(pp.STANDARD_PRICE) FROM T_PRODUCT_PRICE pp
             WHERE pp.PRODUCT_ID = p.PRODUCT_ID AND pp.STATUS = 1) companyPrice,
           (SELECT COUNT(*) FROM T_PRODUCT_SN other
             WHERE other.PRODUCT_ID = p.PRODUCT_ID AND other.IS_DELETED = 0
               AND other.STATUS = 'in_stock'
               AND COALESCE(other.SUPPLIER_ID, '') NOT IN (:supplierIds)) otherSupplierStock
      FROM T_PRODUCT p
      JOIN T_PRODUCT_SN sn ON sn.PRODUCT_ID = p.PRODUCT_ID
      WHERE p.PRODUCT_ID IN (:productIds) AND p.IS_DELETED = 0
        AND sn.IS_DELETED = 0 AND sn.STATUS = 'in_stock'
        AND sn.SUPPLIER_ID IN (:supplierIds)
      GROUP BY p.PRODUCT_ID, p.NAME, p.GROSS_PROFIT_COST_MODE
      ORDER BY p.PRODUCT_ID`,
    { replacements: { supplierIds, productIds }, type: QueryTypes.SELECT }
  );
  console.table(rows);
  if (rows.length !== productIds.length || rows.some(row =>
    !['PURCHASE_PRICE', 'COMPANY_PRICE'].includes(row.costMode) || Number(row.companyPrice) <= 0 || Number(row.otherSupplierStock) !== 0
  )) {
    throw new Error('商品范围、现行计价方式、公司定价或其他来源库存发生变化，已停止');
  }
  const pendingIds = rows.filter(row => row.costMode === 'PURCHASE_PRICE').map(row => row.productId);
  if (!pendingIds.length) {
    console.log('目标商品已全部按公司定价，无需再次修改。');
    return;
  }
  if (!execute) {
    console.log(`仅预览。待修改 ${pendingIds.length} 个商品；使用 --execute 执行。`);
    return;
  }

  await sequelize.transaction(async transaction => {
    const [updated] = await sequelize.query(
      `UPDATE T_PRODUCT SET GROSS_PROFIT_COST_MODE = 'COMPANY_PRICE'
        WHERE PRODUCT_ID IN (:pendingIds) AND IS_DELETED = 0
          AND GROSS_PROFIT_COST_MODE = 'PURCHASE_PRICE'`,
      { replacements: { pendingIds }, transaction }
    );
    const changed = typeof updated === 'number' ? updated : Number(updated?.affectedRows || 0);
    if (changed !== pendingIds.length) {
      throw new Error(`预计修改 ${pendingIds.length} 个商品，实际修改 ${changed} 个；事务已回滚`);
    }
  });
  console.log(`已将 ${pendingIds.length} 个商品改为按公司定价。`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => sequelize.close());
