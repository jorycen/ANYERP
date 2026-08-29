-- 商品分类改为分类/品牌/系列/型号分字段保存。
-- 后端启动迁移会自动把旧的 A/B/C/D 路径拆分到对应字段；本文件用于手工部署场景。
SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'T_PRODUCT' AND COLUMN_NAME = 'CATEGORY_ID'
);
SET @sql := IF(
  @column_exists = 0,
  'ALTER TABLE T_PRODUCT ADD COLUMN CATEGORY_ID VARCHAR(32) NULL COMMENT ''selected product category node'' AFTER CATEGORY',
  'SELECT 1'
);
PREPARE add_product_category_id FROM @sql;
EXECUTE add_product_category_id;
DEALLOCATE PREPARE add_product_category_id;

SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'T_PRODUCT' AND COLUMN_NAME = 'CATEGORY_PATH_LEGACY'
);
SET @sql := IF(
  @column_exists = 0,
  'ALTER TABLE T_PRODUCT ADD COLUMN CATEGORY_PATH_LEGACY VARCHAR(512) NULL COMMENT ''legacy category path for compatibility'' AFTER CATEGORY_ID',
  'SELECT 1'
);
PREPARE add_product_category_path_legacy FROM @sql;
EXECUTE add_product_category_path_legacy;
DEALLOCATE PREPARE add_product_category_path_legacy;

SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'T_PRODUCT_APPLICATION' AND COLUMN_NAME = 'CATEGORY_PATH_LEGACY'
);
SET @sql := IF(
  @column_exists = 0,
  'ALTER TABLE T_PRODUCT_APPLICATION ADD COLUMN CATEGORY_PATH_LEGACY VARCHAR(512) NULL COMMENT ''legacy category path for compatibility'' AFTER CATEGORY_NAME',
  'SELECT 1'
);
PREPARE add_application_category_path_legacy FROM @sql;
EXECUTE add_application_category_path_legacy;
DEALLOCATE PREPARE add_application_category_path_legacy;

SET @index_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'T_PRODUCT' AND INDEX_NAME = 'idx_product_category_id'
);
SET @sql := IF(
  @index_exists = 0,
  'ALTER TABLE T_PRODUCT ADD INDEX idx_product_category_id (CATEGORY_ID)',
  'SELECT 1'
);
PREPARE add_product_category_id_index FROM @sql;
EXECUTE add_product_category_id_index;
DEALLOCATE PREPARE add_product_category_id_index;

SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND ((TABLE_NAME = 'T_PRODUCT' AND COLUMN_NAME IN ('CATEGORY_ID', 'CATEGORY_PATH_LEGACY'))
    OR (TABLE_NAME = 'T_PRODUCT_APPLICATION' AND COLUMN_NAME = 'CATEGORY_PATH_LEGACY'));
