async function ensureCouponColumns(sequelize) {
  for (const [table, column] of [['T_DICT_PAYMENT_METHOD', 'COUPON_RULE'], ['T_ORDER_PAYMENT', 'COUPON_SNAPSHOT']]) {
    const exists = async () => {
      const [rows] = await sequelize.query(`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=:table AND COLUMN_NAME=:column`, { replacements: { table, column } });
      return rows.length > 0;
    };
    if (!(await exists())) {
      try { await sequelize.query(`ALTER TABLE ${table} ADD COLUMN ${column} JSON NULL`); }
      catch (error) { if (!(await exists())) throw error; }
    }
    if (!(await exists())) throw new Error(`优惠券迁移未完成: ${table}.${column}`);
  }
}
module.exports = { ensureCouponColumns };
