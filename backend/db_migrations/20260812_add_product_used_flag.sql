-- Fixes order creation/query failures when the deployed T_PRODUCT table is
-- older than the Sequelize Product model.
-- Safe to run repeatedly: the information_schema guard prevents a duplicate
-- column error.
SET @column_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'T_PRODUCT'
    AND COLUMN_NAME = 'IS_USED_PRODUCT'
);
SET @sql := IF(
  @column_exists = 0,
  'ALTER TABLE T_PRODUCT ADD COLUMN IS_USED_PRODUCT TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''used product flag'' AFTER REMARK',
  'SELECT 1'
);
PREPARE add_used_product_column FROM @sql;
EXECUTE add_used_product_column;
DEALLOCATE PREPARE add_used_product_column;

SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'T_PRODUCT'
  AND COLUMN_NAME = 'IS_USED_PRODUCT';
