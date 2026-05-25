const { sequelize } = require('../backend/src/models');
const fs = require('fs');
const path = require('path');

async function executeMigration() {
  try {
    console.log('开始执行退库表数据库迁移...');
    
    await sequelize.authenticate();
    console.log('数据库连接成功！');
    
    // 1. 创建退库表
    console.log('创建退库表 T_RETURN_STOCK...');
    const createReturnStock = `
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
    `;
    await sequelize.query(createReturnStock);
    console.log('✓ 退库表创建成功！');
    
    // 2. 创建退库明细表
    console.log('创建退库明细表 T_RETURN_STOCK_ITEM...');
    const createReturnStockItem = `
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
    `;
    await sequelize.query(createReturnStockItem);
    console.log('✓ 退库明细表创建成功！');
    
    console.log('退库表数据库迁移完成！');
    
  } catch (error) {
    console.error('执行退库表数据库迁移失败：', error);
  } finally {
    await sequelize.close();
  }
}

executeMigration();
