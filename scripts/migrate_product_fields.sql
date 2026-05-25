-- ==========================================
-- 商品表字段迁移脚本 v1.0
-- 功能：添加厂商编码、69码，修改成本价为最低销售限价
-- ==========================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- 检查并添加 MANUFACTURER_CODE 字段
SET @col_exists = (SELECT COUNT(*) 
                   FROM information_schema.COLUMNS 
                   WHERE TABLE_SCHEMA = DATABASE() 
                     AND TABLE_NAME = 'T_PRODUCT' 
                     AND COLUMN_NAME = 'MANUFACTURER_CODE');

SET @sql = IF(@col_exists = 0,
              'ALTER TABLE T_PRODUCT ADD COLUMN MANUFACTURER_CODE VARCHAR(64) COMMENT \"厂商编码\" AFTER CATEGORY',
              'SELECT \"MANUFACTURER_CODE 字段已存在\" AS status');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 检查并添加 BARCODE_69 字段
SET @col_exists = (SELECT COUNT(*) 
                   FROM information_schema.COLUMNS 
                   WHERE TABLE_SCHEMA = DATABASE() 
                     AND TABLE_NAME = 'T_PRODUCT' 
                     AND COLUMN_NAME = 'BARCODE_69');

SET @sql = IF(@col_exists = 0,
              'ALTER TABLE T_PRODUCT ADD COLUMN BARCODE_69 VARCHAR(64) COMMENT \"69码\" AFTER MANUFACTURER_CODE',
              'SELECT \"BARCODE_69 字段已存在\" AS status');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 检查并添加 MIN_SALE_PRICE 字段
SET @col_exists = (SELECT COUNT(*) 
                   FROM information_schema.COLUMNS 
                   WHERE TABLE_SCHEMA = DATABASE() 
                     AND TABLE_NAME = 'T_PRODUCT' 
                     AND COLUMN_NAME = 'MIN_SALE_PRICE');

SET @sql = IF(@col_exists = 0,
              'ALTER TABLE T_PRODUCT ADD COLUMN MIN_SALE_PRICE DECIMAL(12,2) COMMENT \"最低销售限价\" AFTER STANDARD_PRICE',
              'SELECT \"MIN_SALE_PRICE 字段已存在\" AS status');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 数据迁移：将 COST_PRICE 的数据复制到 MIN_SALE_PRICE（如果 MIN_SALE_PRICE 为空且 COST_PRICE 有值）
SET @col_exists = (SELECT COUNT(*) 
                   FROM information_schema.COLUMNS 
                   WHERE TABLE_SCHEMA = DATABASE() 
                     AND TABLE_NAME = 'T_PRODUCT' 
                     AND COLUMN_NAME = 'COST_PRICE');

SET @sql = IF(@col_exists = 1,
              'UPDATE T_PRODUCT SET MIN_SALE_PRICE = COST_PRICE WHERE MIN_SALE_PRICE IS NULL AND COST_PRICE IS NOT NULL',
              'SELECT \"COST_PRICE 字段不存在，跳过数据迁移\" AS status');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET FOREIGN_KEY_CHECKS = 1;

-- ==========================================
-- 迁移完成
-- ==========================================
