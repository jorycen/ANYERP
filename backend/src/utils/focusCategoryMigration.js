// Idempotent and fail closed: category/report queries require this column.
async function ensureFocusCategoryColumn(sequelize) {
  const exists = async () => {
    const [rows] = await sequelize.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='T_PRODUCT_CATEGORY' AND COLUMN_NAME='IS_FOCUS_CATEGORY'`
    );
    return rows.length > 0;
  };
  if (!(await exists())) {
    try {
      await sequelize.query('ALTER TABLE T_PRODUCT_CATEGORY ADD COLUMN IS_FOCUS_CATEGORY TINYINT NOT NULL DEFAULT 0 COMMENT \'是否为报表重点分类\'');
    } catch (error) {
      if (!(await exists())) throw error;
    }
  }
  if (!(await exists())) throw new Error('重点分类字段迁移未完成');
}
module.exports = { ensureFocusCategoryColumn };
