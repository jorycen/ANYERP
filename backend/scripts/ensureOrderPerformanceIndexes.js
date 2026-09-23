const { sequelize } = require('../src/models');

const indexes = [
  ['T_ORDER', 'idx_order_list_scope_time', 'ALTER TABLE T_ORDER ADD INDEX idx_order_list_scope_time (IS_DELETED, STORE_ID, CREATE_TIME, ORDER_ID)'],
  ['T_ORDER_ITEM', 'idx_order_item_order', 'ALTER TABLE T_ORDER_ITEM ADD INDEX idx_order_item_order (ORDER_ID)'],
  ['T_ORDER_ITEM', 'idx_order_item_product_order', 'ALTER TABLE T_ORDER_ITEM ADD INDEX idx_order_item_product_order (PRODUCT_ID, ORDER_ID)'],
  ['T_ORDER_ITEM', 'idx_order_item_pn_order', 'ALTER TABLE T_ORDER_ITEM ADD INDEX idx_order_item_pn_order (PN_CODE, ORDER_ID)'],
  ['T_ORDER_ITEM', 'idx_order_item_sn_order', 'ALTER TABLE T_ORDER_ITEM ADD INDEX idx_order_item_sn_order (SN_CODE, ORDER_ID)'],
  ['T_ORDER_PAYMENT', 'idx_order_payment_order', 'ALTER TABLE T_ORDER_PAYMENT ADD INDEX idx_order_payment_order (ORDER_ID)'],
  ['T_ORDER_SUPPLEMENT', 'idx_order_supplement_order_deleted', 'ALTER TABLE T_ORDER_SUPPLEMENT ADD INDEX idx_order_supplement_order_deleted (ORDER_ID, IS_DELETED)'],
  ['T_ORDER_GROSS_PROFIT', 'idx_order_gross_profit_order_version', 'ALTER TABLE T_ORDER_GROSS_PROFIT ADD INDEX idx_order_gross_profit_order_version (ORDER_ID, FORMULA_VERSION)']
];

(async () => {
  const results = [];
  for (const [tableName, indexName, createSql] of indexes) {
    const [rows] = await sequelize.query(
      `SELECT COUNT(*) AS count FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
      { replacements: [tableName, indexName] }
    );
    if (Number(rows[0]?.count || 0) > 0) {
      results.push({ tableName, indexName, status: 'exists' });
      continue;
    }
    await sequelize.query(createSql);
    results.push({ tableName, indexName, status: 'created' });
  }
  console.log(JSON.stringify(results));
  await sequelize.close();
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
