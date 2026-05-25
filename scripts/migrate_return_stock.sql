-- 退库表迁移脚本

-- 1. 创建退库表 T_RETURN_STOCK
CREATE TABLE IF NOT EXISTS T_RETURN_STOCK (
  return_id VARCHAR(32) NOT NULL COMMENT '退库ID',
  return_no VARCHAR(64) NOT NULL COMMENT '退库单号',
  inbound_id VARCHAR(32) NOT NULL COMMENT '入库单ID',
  inbound_no VARCHAR(64) COMMENT '入库单号',
  store_id VARCHAR(32) NOT NULL COMMENT '门店ID',
  total_quantity INT DEFAULT 0 COMMENT '总数量',
  total_amount DECIMAL(12, 2) DEFAULT 0 COMMENT '总金额',
  reason VARCHAR(512) COMMENT '退库原因',
  create_user VARCHAR(64) COMMENT '创建用户',
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (return_id),
  UNIQUE KEY uk_return_no (return_no),
  KEY idx_inbound_id (inbound_id),
  KEY idx_store_id (store_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='退库表';

-- 2. 创建退库明细表 T_RETURN_STOCK_ITEM
CREATE TABLE IF NOT EXISTS T_RETURN_STOCK_ITEM (
  item_id BIGINT(20) NOT NULL AUTO_INCREMENT COMMENT '明细ID',
  return_id VARCHAR(32) NOT NULL COMMENT '退库ID',
  product_id VARCHAR(32) NOT NULL COMMENT '商品ID',
  product_name VARCHAR(255) COMMENT '商品名称',
  pn_code VARCHAR(64) COMMENT 'PN码',
  sn_code VARCHAR(128) COMMENT 'SN码',
  sn_id VARCHAR(32) COMMENT 'SN ID',
  quantity INT NOT NULL DEFAULT 1 COMMENT '数量',
  unit_price DECIMAL(12, 2) COMMENT '单价',
  remark VARCHAR(255) COMMENT '备注',
  PRIMARY KEY (item_id),
  KEY idx_return_id (return_id),
  KEY idx_product_id (product_id),
  KEY idx_sn_id (sn_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='退库明细表';

-- 3. 更新入库表状态，添加'completed'状态（已入库）和'returned'状态（已退库）
-- 先检查是否有status字段，如果没有则添加
-- ALTER TABLE T_INBOUND MODIFY COLUMN status VARCHAR(32) DEFAULT 'pending' COMMENT '状态：pending待入库，completed已入库，returned已退库';

-- 4. 更新ProductSn状态，添加'returned'状态
-- 已有的状态：in_stock(在库), sold(已售), damaged(损坏)
-- ALTER TABLE T_PRODUCT_SN MODIFY COLUMN status VARCHAR(32) DEFAULT 'in_stock' COMMENT '状态：in_stock在库，sold已售，damaged损坏，returned已退库';
