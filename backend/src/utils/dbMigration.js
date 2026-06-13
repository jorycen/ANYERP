/**
 * 数据库自动迁移工具
 * 在启动时自动检查并添加缺少的字段和表
 */

const { sequelize } = require('../models');

async function checkAndAddColumn(tableName, columnName, columnDefinition, afterColumn = null) {
  try {
    const [result] = await sequelize.query(
      `SELECT COUNT(*) as cnt 
       FROM information_schema.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() 
       AND TABLE_NAME = ? 
       AND COLUMN_NAME = ?`,
      { replacements: [tableName, columnName], type: sequelize.QueryTypes.SELECT }
    );

    if (result.cnt === 0) {
      let sql = `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`;
      if (afterColumn) {
        sql += ` AFTER ${afterColumn}`;
      }
      await sequelize.query(sql);
      console.log(`[DB Migration] 已添加字段: ${tableName}.${columnName}`);
      return true;
    }
    console.log(`[DB Migration] 字段已存在: ${tableName}.${columnName}`);
    return false;
  } catch (error) {
    console.error(`[DB Migration] 检查字段失败: ${tableName}.${columnName} - ${error.message}`);
    return false;
  }
}

async function checkAndCreateTable(tableName, createSql) {
  try {
    const [result] = await sequelize.query(
      `SELECT COUNT(*) as cnt 
       FROM information_schema.TABLES 
       WHERE TABLE_SCHEMA = DATABASE() 
       AND TABLE_NAME = ?`,
      { replacements: [tableName], type: sequelize.QueryTypes.SELECT }
    );

    if (result.cnt === 0) {
      await sequelize.query(createSql);
      console.log(`[DB Migration] 已创建表: ${tableName}`);
      return true;
    }
    console.log(`[DB Migration] 表已存在: ${tableName}`);
    return false;
  } catch (error) {
    console.error(`[DB Migration] 检查表失败: ${tableName} - ${error.message}`);
    return false;
  }
}

async function checkAndAddIndex(tableName, indexName, createIndexSql) {
  try {
    const [result] = await sequelize.query(
      `SELECT COUNT(*) as cnt
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND INDEX_NAME = ?`,
      { replacements: [tableName, indexName], type: sequelize.QueryTypes.SELECT }
    );

    if (result.cnt === 0) {
      await sequelize.query(createIndexSql);
      console.log(`[DB Migration] 已添加索引: ${tableName}.${indexName}`);
      return true;
    }
    console.log(`[DB Migration] 索引已存在: ${tableName}.${indexName}`);
    return false;
  } catch (error) {
    console.error(`[DB Migration] 检查索引失败: ${tableName}.${indexName} - ${error.message}`);
    return false;
  }
}

async function dropProductSnGlobalUniqueIndex() {
  try {
    const indexes = await sequelize.query(
      `SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'T_PRODUCT_SN'
       AND NON_UNIQUE = 0
       GROUP BY INDEX_NAME`,
      { type: sequelize.QueryTypes.SELECT }
    );

    for (const idx of indexes) {
      const columns = String(idx.columns || '').toUpperCase();
      if (columns === 'SN_CODE') {
        await sequelize.query(`ALTER TABLE T_PRODUCT_SN DROP INDEX \`${idx.INDEX_NAME}\``);
        console.log(`[DB Migration] 已删除SN全局唯一索引: ${idx.INDEX_NAME}`);
      }
    }
  } catch (error) {
    console.error(`[DB Migration] 删除SN全局唯一索引失败 - ${error.message}`);
  }
}

async function normalizeInventoryLocationIndex() {
  try {
    await sequelize.query("UPDATE T_INVENTORY SET LOCATION_ID = '' WHERE LOCATION_ID IS NULL");

    const indexes = await sequelize.query(
      `SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'T_INVENTORY'
       AND NON_UNIQUE = 0
       GROUP BY INDEX_NAME`,
      { type: sequelize.QueryTypes.SELECT }
    );

    for (const idx of indexes) {
      const columns = String(idx.columns || '').toUpperCase();
      if (columns === 'PRODUCT_ID,STORE_ID') {
        await sequelize.query(`ALTER TABLE T_INVENTORY DROP INDEX \`${idx.INDEX_NAME}\``);
        console.log(`[DB Migration] Dropped inventory product/store unique index: ${idx.INDEX_NAME}`);
      }
    }

    await checkAndAddIndex(
      'T_INVENTORY',
      'uk_product_store_location',
      'ALTER TABLE T_INVENTORY ADD UNIQUE KEY uk_product_store_location (PRODUCT_ID, STORE_ID, LOCATION_ID)'
    );
  } catch (error) {
    console.error(`[DB Migration] Normalize inventory location index failed - ${error.message}`);
  }
}

async function initializeSupplierSortOrder() {
  try {
    const [stat] = await sequelize.query(
      `SELECT COUNT(*) AS total, COALESCE(MAX(SORT_ORDER), 0) AS maxSort
       FROM T_SUPPLIER
       WHERE IS_DELETED = 0`,
      { type: sequelize.QueryTypes.SELECT }
    );

    if (!stat || Number(stat.total) === 0 || Number(stat.maxSort) > 0) {
      return;
    }

    const rows = await sequelize.query(
      `SELECT SUPPLIER_ID
       FROM T_SUPPLIER
       WHERE IS_DELETED = 0
       ORDER BY CREATE_TIME DESC, SUPPLIER_ID ASC`,
      { type: sequelize.QueryTypes.SELECT }
    );

    for (const [index, row] of rows.entries()) {
      await sequelize.query(
        `UPDATE T_SUPPLIER SET SORT_ORDER = ? WHERE SUPPLIER_ID = ?`,
        { replacements: [index, row.SUPPLIER_ID] }
      );
    }

    console.log(`[DB Migration] 已初始化 ${rows.length} 个供应商排序值`);
  } catch (error) {
    console.error(`[DB Migration] 初始化供应商排序失败 - ${error.message}`);
  }
}

async function initializeCategorySortOrder() {
  try {
    const [stat] = await sequelize.query(
      `SELECT COUNT(*) AS total, COALESCE(MAX(SORT_ORDER), 0) AS maxSort
       FROM T_PRODUCT_CATEGORY
       WHERE STATUS = 1`,
      { type: sequelize.QueryTypes.SELECT }
    );

    if (!stat || Number(stat.total) === 0 || Number(stat.maxSort) > 0) {
      return;
    }

    const rows = await sequelize.query(
      `SELECT CATEGORY_ID, PARENT_ID
       FROM T_PRODUCT_CATEGORY
       WHERE STATUS = 1
       ORDER BY LEVEL ASC, NAME ASC, CATEGORY_ID ASC`,
      { type: sequelize.QueryTypes.SELECT }
    );

    const grouped = new Map();
    for (const row of rows) {
      const parentId = row.PARENT_ID || '__root__';
      if (!grouped.has(parentId)) grouped.set(parentId, []);
      grouped.get(parentId).push(row);
    }

    let count = 0;
    for (const siblings of grouped.values()) {
      for (const [index, row] of siblings.entries()) {
        await sequelize.query(
          `UPDATE T_PRODUCT_CATEGORY SET SORT_ORDER = ? WHERE CATEGORY_ID = ?`,
          { replacements: [index, row.CATEGORY_ID] }
        );
        count++;
      }
    }

    console.log(`[DB Migration] 已初始化 ${count} 个商品分类排序值`);
  } catch (error) {
    console.error(`[DB Migration] 初始化商品分类排序失败 - ${error.message}`);
  }
}

async function runMigrations() {
  console.log('[DB Migration] 开始检查数据库结构...');
  
  try {
    await checkAndAddColumn('T_PRODUCT', 'T_CODE', 'VARCHAR(64) COMMENT "老厂商编码备份"', 'STATUS');
    await checkAndAddColumn('T_PRODUCT', 'T_BARCODE', 'VARCHAR(64) COMMENT "老69码备份"', 'T_CODE');
    await checkAndAddColumn('T_PRODUCT', 'T_STANDARD_PRICE', 'DECIMAL(12,2) COMMENT "老标准售价备份"', 'T_BARCODE');
    await checkAndAddColumn('T_PRODUCT', 'T_MIN_SALE_PRICE', 'DECIMAL(12,2) COMMENT "老最低售价备份"', 'T_STANDARD_PRICE');
    await checkAndAddColumn('T_PRODUCT', 'CATEGORY_ID', 'VARCHAR(32) COMMENT "分类ID"', 'NAME');
    await checkAndAddColumn('T_PRODUCT', 'CONFIG', 'VARCHAR(512) COMMENT "产品配置"', 'CATEGORY');
    await checkAndAddColumn('T_PRODUCT', 'CREATE_TIME', 'DATETIME COMMENT "创建时间"', 'CONFIG');
    await checkAndAddColumn('T_PRODUCT_SN', 'PN_CODE', 'VARCHAR(64) COMMENT "PN料号"', 'PRODUCT_ID');
    await checkAndAddColumn('T_PRODUCT_SN', 'INVENTORY_TYPE', 'VARCHAR(32) DEFAULT "normal_qty" COMMENT "库存类型"', 'STATUS');
    await checkAndAddColumn('T_PRODUCT_SN', 'ORIGINAL_PICKUP_PRICE', 'DECIMAL(12,2) DEFAULT 0 COMMENT "原始提货价"', 'INBOUND_PRICE');
    await dropProductSnGlobalUniqueIndex();
    await checkAndAddIndex('T_PRODUCT_SN', 'uk_product_sn_pn_sn', 'ALTER TABLE T_PRODUCT_SN ADD UNIQUE KEY uk_product_sn_pn_sn (PN_CODE, SN_CODE)');
    await checkAndAddIndex('T_PRODUCT_SN', 'idx_product_sn_code', 'ALTER TABLE T_PRODUCT_SN ADD INDEX idx_product_sn_code (SN_CODE)');
    await checkAndAddColumn('T_PRODUCT', 'MANUFACTURER_CODE', 'VARCHAR(512) COMMENT "manufacturer code"', 'CONFIG');
    await checkAndCreateTable('T_SN_LOG', `
      CREATE TABLE T_SN_LOG (
        LOG_ID VARCHAR(32) NOT NULL,
        SN_ID VARCHAR(32),
        SN_CODE VARCHAR(128),
        OLD_SN_CODE VARCHAR(128),
        PRODUCT_ID VARCHAR(32),
        PRODUCT_NAME VARCHAR(255),
        STORE_ID VARCHAR(32),
        ACTION VARCHAR(32) NOT NULL COMMENT '事件类型: inbound/sale/return/modify_sn',
        REMARK VARCHAR(512),
        CREATE_USER VARCHAR(64),
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (LOG_ID),
        INDEX IDX_SN_CODE (SN_CODE),
        INDEX IDX_SN_ID (SN_ID)
      )
    `);
    await checkAndAddColumn('T_SUPPLIER', 'INVOICE_TYPE', 'VARCHAR(32) COMMENT "发票类型"', 'ADDRESS');
    await checkAndAddColumn('T_SUPPLIER', 'REMARK', 'VARCHAR(512) COMMENT "备注"', 'INVOICE_TYPE');
    await checkAndAddColumn('T_SUPPLIER', 'SORT_ORDER', 'INT DEFAULT 0 COMMENT "排序"', 'REMARK');
    await checkAndAddColumn('T_SUPPLIER', 'CREATE_TIME', 'DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT "创建时间"', 'IS_DELETED');
    await checkAndAddColumn('T_SUPPLIER', 'UPDATE_TIME', 'DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT "更新时间"', 'CREATE_TIME');
    await initializeSupplierSortOrder();
    await checkAndCreateTable('T_SUPPLIER_PAYMENT_ACCOUNT', `
      CREATE TABLE T_SUPPLIER_PAYMENT_ACCOUNT (
        ACCOUNT_ID VARCHAR(32) NOT NULL COMMENT '供应商付款账户ID',
        SUPPLIER_ID VARCHAR(32) NOT NULL COMMENT '供应商ID',
        COMPANY_NAME VARCHAR(255) COMMENT '公司名称',
        TAX_NO VARCHAR(64) COMMENT '税号',
        BANK_NAME VARCHAR(128) COMMENT '开户行',
        ACCOUNT_NUMBER VARCHAR(128) COMMENT '账号',
        REMARK VARCHAR(512) COMMENT '备注',
        SORT_ORDER INT DEFAULT 0 COMMENT '排序',
        STATUS TINYINT DEFAULT 1 COMMENT '状态',
        IS_DELETED TINYINT(1) DEFAULT 0 COMMENT '是否删除',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        UPDATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
        PRIMARY KEY (ACCOUNT_ID),
        KEY idx_supplier_payment_supplier (SUPPLIER_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='供应商付款账户表'
    `);
    await checkAndAddColumn('T_PURCHASE_REQUEST', 'INVOICE_TYPE', 'VARCHAR(32) COMMENT "发票类型"', 'SUPPLIER_ID');
    await checkAndAddColumn('T_PURCHASE_REQUEST_ITEM', 'STORE_ALLOCATIONS', 'TEXT COMMENT "门店分配"', 'QUANTITY');
    await checkAndAddColumn('T_INBOUND', 'PURCHASE_REQUEST_ID', 'VARCHAR(32) COMMENT "采购申请ID"', 'INBOUND_NO');
    await checkAndAddColumn('T_INBOUND_ITEM', 'REMARK', 'VARCHAR(512) COMMENT "备注"', 'UNIT_PRICE');
    await checkAndAddColumn('T_INBOUND_ITEM', 'STORE_ALLOCATIONS', 'TEXT COMMENT "门店分配"', 'REMARK');
    await checkAndAddColumn('T_INBOUND_ITEM', 'LOCATION_ID', 'VARCHAR(32) COMMENT "库位ID"', 'STORE_ALLOCATIONS');
    await checkAndAddColumn('T_INBOUND_ITEM', 'INVENTORY_TYPE', 'VARCHAR(32) DEFAULT "normal_qty" COMMENT "入库库存类型"', 'LOCATION_ID');
    await checkAndAddColumn('T_INVENTORY', 'UPDATE_TIME', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT "更新时间"', 'PENDING_QTY');
    await checkAndAddColumn('T_INVENTORY', 'LOCATION_ID', 'VARCHAR(32) NOT NULL DEFAULT "" COMMENT "库位ID"', 'STORE_ID');
    await normalizeInventoryLocationIndex();

    await checkAndCreateTable('T_INVENTORY_CONVERSION', `
      CREATE TABLE T_INVENTORY_CONVERSION (
        CONVERSION_ID VARCHAR(32) NOT NULL COMMENT '库存转换单ID',
        CONVERSION_NO VARCHAR(64) NOT NULL COMMENT '库存转换单号',
        CONVERSION_TYPE VARCHAR(32) NOT NULL COMMENT '转换类型:split-拆分,assemble-组装',
        STORE_ID VARCHAR(32) NOT NULL COMMENT '门店ID',
        STATUS VARCHAR(32) DEFAULT 'completed' COMMENT '状态:completed-已完成,voided-已冲销',
        TOTAL_SOURCE_COST DECIMAL(12,2) DEFAULT 0 COMMENT '来源总成本',
        TOTAL_TARGET_COST DECIMAL(12,2) DEFAULT 0 COMMENT '目标总成本',
        SERVICE_COST DECIMAL(12,2) DEFAULT 0 COMMENT '组装服务成本',
        REMARK VARCHAR(512) COMMENT '备注',
        VOID_REASON VARCHAR(512) COMMENT '冲销原因',
        CREATE_USER VARCHAR(64) COMMENT '创建人',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        VOID_USER VARCHAR(64) COMMENT '冲销人',
        VOID_TIME DATETIME COMMENT '冲销时间',
        PRIMARY KEY (CONVERSION_ID),
        UNIQUE KEY uk_inventory_conversion_no (CONVERSION_NO),
        KEY idx_inventory_conversion_store (STORE_ID),
        KEY idx_inventory_conversion_type_status (CONVERSION_TYPE, STATUS)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='库存拆分组装转换单'
    `);

    await checkAndCreateTable('T_INVENTORY_CONVERSION_ITEM', `
      CREATE TABLE T_INVENTORY_CONVERSION_ITEM (
        ITEM_ID BIGINT(20) NOT NULL AUTO_INCREMENT COMMENT '明细ID',
        CONVERSION_ID VARCHAR(32) NOT NULL COMMENT '转换单ID',
        LINE_ROLE VARCHAR(32) NOT NULL COMMENT '行角色:source-来源,target-目标,service-服务成本',
        PRODUCT_ID VARCHAR(32) COMMENT '商品ID',
        PRODUCT_NAME VARCHAR(255) COMMENT '商品名称快照',
        PN_CODE VARCHAR(64) COMMENT 'PN快照',
        SN_ID VARCHAR(32) COMMENT 'SN ID',
        SN_CODE VARCHAR(128) COMMENT 'SN快照',
        SOURCE_SN_ID VARCHAR(32) COMMENT '来源SN ID',
        SOURCE_SN_CODE VARCHAR(128) COMMENT '来源SN快照',
        QUANTITY INT DEFAULT 1 COMMENT '数量',
        UNIT_COST DECIMAL(12,2) DEFAULT 0 COMMENT '单位成本',
        TOTAL_COST DECIMAL(12,2) DEFAULT 0 COMMENT '总成本',
        INVENTORY_TYPE VARCHAR(32) DEFAULT 'normal_qty' COMMENT '库存类型',
        LOCATION_ID VARCHAR(32) COMMENT '库位ID',
        REMARK VARCHAR(512) COMMENT '备注',
        PRIMARY KEY (ITEM_ID),
        KEY idx_conversion_item_conversion (CONVERSION_ID),
        KEY idx_conversion_item_product (PRODUCT_ID),
        KEY idx_conversion_item_sn (SN_ID),
        KEY idx_conversion_item_source_sn (SOURCE_SN_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='库存拆分组装转换明细'
    `);

    await checkAndCreateTable('T_RETURN_STOCK', `
      CREATE TABLE T_RETURN_STOCK (
        RETURN_ID VARCHAR(32) NOT NULL COMMENT '退库ID',
        RETURN_NO VARCHAR(64) NOT NULL COMMENT '退库单号',
        INBOUND_ID VARCHAR(32) NOT NULL COMMENT '入库单ID',
        INBOUND_NO VARCHAR(64) COMMENT '入库单号',
        STORE_ID VARCHAR(32) NOT NULL COMMENT '门店ID',
        TOTAL_QUANTITY INT DEFAULT 0 COMMENT '总数量',
        TOTAL_AMOUNT DECIMAL(12,2) DEFAULT 0 COMMENT '总金额',
        REASON VARCHAR(512) COMMENT '退库原因',
        CREATE_USER VARCHAR(64) COMMENT '创建用户',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        PRIMARY KEY (RETURN_ID),
        UNIQUE KEY uk_return_no (RETURN_NO),
        KEY idx_inbound_id (INBOUND_ID),
        KEY idx_store_id (STORE_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='退库表'
    `);

    await checkAndCreateTable('T_RETURN_STOCK_ITEM', `
      CREATE TABLE T_RETURN_STOCK_ITEM (
        ITEM_ID BIGINT(20) NOT NULL AUTO_INCREMENT COMMENT '明细ID',
        RETURN_ID VARCHAR(32) NOT NULL COMMENT '退库ID',
        PRODUCT_ID VARCHAR(32) NOT NULL COMMENT '商品ID',
        PRODUCT_NAME VARCHAR(255) COMMENT '商品名称',
        PN_CODE VARCHAR(64) COMMENT 'PN码',
        SN_CODE VARCHAR(128) COMMENT 'SN码',
        SN_ID VARCHAR(32) COMMENT 'SN ID',
        QUANTITY INT NOT NULL DEFAULT 1 COMMENT '数量',
        UNIT_PRICE DECIMAL(12,2) COMMENT '单价',
        REMARK VARCHAR(255) COMMENT '备注',
        PRIMARY KEY (ITEM_ID),
        KEY idx_return_id (RETURN_ID),
        KEY idx_product_id (PRODUCT_ID),
        KEY idx_sn_id (SN_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='退库明细表'
    `);

    await checkAndAddColumn('T_RETURN_STOCK', 'PURCHASE_REQUEST_ID', 'VARCHAR(32) COMMENT "采购申请ID"', 'STORE_ID');
    await checkAndAddColumn('T_RETURN_STOCK', 'SUPPLIER_ID', 'VARCHAR(32) COMMENT "供应商ID"', 'PURCHASE_REQUEST_ID');
    await checkAndAddColumn('T_RETURN_STOCK', 'SUPPLIER_NAME', 'VARCHAR(255) COMMENT "供应商名称"', 'SUPPLIER_ID');
    await checkAndAddColumn('T_RETURN_STOCK', 'STATUS', "VARCHAR(32) DEFAULT 'pending' COMMENT '状态:pending/approved/rejected/completed'", 'REASON');
    await checkAndAddColumn('T_RETURN_STOCK', 'APPROVE_USER', 'VARCHAR(64) COMMENT "审批人"', 'STATUS');
    await checkAndAddColumn('T_RETURN_STOCK', 'APPROVE_COMMENT', 'VARCHAR(512) COMMENT "审批备注"', 'APPROVE_USER');
    await checkAndAddColumn('T_RETURN_STOCK', 'APPROVE_TIME', 'DATETIME COMMENT "审批时间"', 'APPROVE_COMMENT');
    await checkAndAddColumn('T_RETURN_STOCK', 'EXECUTE_USER', 'VARCHAR(64) COMMENT "执行人"', 'APPROVE_TIME');
    await checkAndAddColumn('T_RETURN_STOCK', 'EXECUTE_TIME', 'DATETIME COMMENT "执行时间"', 'EXECUTE_USER');
    await checkAndAddColumn('T_RETURN_STOCK', 'PAYABLE_ID', 'VARCHAR(32) COMMENT "负向应付ID"', 'EXECUTE_TIME');
    await checkAndAddColumn('T_RETURN_STOCK_ITEM', 'LOCATION_ID', 'VARCHAR(32) COMMENT "库位ID"', 'UNIT_PRICE');
    await checkAndAddColumn('T_RETURN_STOCK_ITEM', 'INVENTORY_TYPE', 'VARCHAR(32) DEFAULT "normal_qty" COMMENT "库存类型"', 'LOCATION_ID');
    await checkAndAddColumn('T_RETURN_STOCK_ITEM', 'PRODUCT_TYPE', 'VARCHAR(32) COMMENT "货型"', 'INVENTORY_TYPE');
    try {
      await sequelize.query(`
        UPDATE T_RETURN_STOCK rs
        JOIN T_INBOUND i ON rs.INBOUND_ID = i.INBOUND_ID
        SET rs.STATUS = 'completed',
            rs.EXECUTE_TIME = COALESCE(rs.EXECUTE_TIME, rs.CREATE_TIME),
            rs.EXECUTE_USER = COALESCE(rs.EXECUTE_USER, rs.CREATE_USER)
        WHERE rs.STATUS = 'pending'
          AND i.STATUS = 'returned'
      `);
    } catch (error) {
      console.warn('[DB Migration] normalize old return stock status skipped:', error.message);
    }

    await checkAndCreateTable('T_EXPENSE', `
      CREATE TABLE T_EXPENSE (
        EXPENSE_ID VARCHAR(32) NOT NULL COMMENT '支出ID',
        EXPENSE_NO VARCHAR(64) NOT NULL COMMENT '支出编号',
        STORE_ID VARCHAR(32) NOT NULL COMMENT '门店ID',
        EXPENSE_TYPE VARCHAR(32) NOT NULL COMMENT '支出类型:purchase-采购付款,operating-运营费用,other-其他',
        AMOUNT DECIMAL(12,2) NOT NULL COMMENT '支出金额',
        PAYMENT_METHOD VARCHAR(64) COMMENT '支付方式',
        RELATED_ORDER_NO VARCHAR(64) COMMENT '关联单号',
        REMARK VARCHAR(512) COMMENT '备注',
        CREATE_USER VARCHAR(64) COMMENT '制单人',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UPDATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        IS_DELETED TINYINT(1) DEFAULT 0,
        PRIMARY KEY (EXPENSE_ID),
        UNIQUE KEY uni_expense_no (EXPENSE_NO),
        KEY idx_expense_store (STORE_ID),
        KEY idx_expense_type (EXPENSE_TYPE)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='支出记录表'
    `);

    await checkAndAddColumn('T_EXPENSE', 'STATUS', "VARCHAR(32) DEFAULT 'pending'", 'PAYMENT_METHOD');
    await checkAndAddColumn('T_EXPENSE', 'SUBMIT_USER', 'VARCHAR(64)', 'STATUS');
    await checkAndAddColumn('T_EXPENSE', 'SETTLE_USER', 'VARCHAR(64)', 'SUBMIT_USER');
    await checkAndAddColumn('T_EXPENSE', 'SETTLED_PAYMENT_METHOD', 'VARCHAR(64)', 'SETTLE_USER');
    await checkAndAddColumn('T_EXPENSE', 'SETTLED_AT', 'DATETIME', 'SETTLED_PAYMENT_METHOD');
    await checkAndAddColumn('T_EXPENSE', 'SETTLEMENT_ACCOUNT_ID', 'VARCHAR(64) COMMENT "结算账号ID"', 'SETTLED_AT');

    await checkAndCreateTable('T_SETTLEMENT_ACCOUNT_TRANSACTION', `
      CREATE TABLE T_SETTLEMENT_ACCOUNT_TRANSACTION (
        TRANSACTION_ID VARCHAR(64) NOT NULL PRIMARY KEY COMMENT '流水ID',
        ACCOUNT_ID VARCHAR(64) NOT NULL COMMENT '结算账号ID',
        TYPE VARCHAR(32) NOT NULL COMMENT '类型:income-入账/expense-出账',
        AMOUNT DECIMAL(12,2) NOT NULL COMMENT '金额',
        BALANCE_AFTER DECIMAL(12,2) COMMENT '操作后余额',
        DESCRIPTION VARCHAR(512) COMMENT '摘要',
        RELATED_REF VARCHAR(128) COMMENT '关联单号',
        CREATE_USER VARCHAR(64) COMMENT '操作人',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '操作时间',
        INDEX idx_account_id (ACCOUNT_ID),
        INDEX idx_create_time (CREATE_TIME)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='结算账户流水表'
    `);

    await checkAndCreateTable('T_PAYABLE', `
      CREATE TABLE T_PAYABLE (
        PAYABLE_ID VARCHAR(32) NOT NULL COMMENT '应付款ID',
        SUPPLIER_ID VARCHAR(32) NOT NULL COMMENT '供应商ID',
        SUPPLIER_NAME VARCHAR(255) COMMENT '供应商名称',
        REQUEST_ID VARCHAR(32) NOT NULL COMMENT '采购申请ID',
        REQUEST_NO VARCHAR(64) COMMENT '采购申请单号',
        TOTAL_AMOUNT DECIMAL(12,2) NOT NULL COMMENT '应付金额',
        PAID_AMOUNT DECIMAL(12,2) DEFAULT 0 COMMENT '已付金额',
        STATUS VARCHAR(32) DEFAULT 'unpaid' COMMENT '状态:unpaid/paid',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        PRIMARY KEY (PAYABLE_ID),
        KEY idx_payable_supplier (SUPPLIER_ID),
        KEY idx_payable_status (STATUS)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='应付款表'
    `);

    await checkAndCreateTable('T_SETTLEMENT', `
      CREATE TABLE T_SETTLEMENT (
        SETTLEMENT_ID VARCHAR(32) NOT NULL COMMENT '结算单ID',
        SETTLEMENT_NO VARCHAR(64) NOT NULL COMMENT '结算单号',
        SUPPLIER_ID VARCHAR(32) NOT NULL COMMENT '供应商ID',
        SUPPLIER_NAME VARCHAR(255) COMMENT '供应商名称',
        TOTAL_AMOUNT DECIMAL(12,2) NOT NULL COMMENT '结算金额',
        PAID_AMOUNT DECIMAL(12,2) DEFAULT 0 COMMENT '已付金额',
        STATUS VARCHAR(32) DEFAULT 'draft' COMMENT '结算单状态:draft/confirmed/voided',
        PAYMENT_STATUS VARCHAR(32) DEFAULT 'unpaid' COMMENT '付款状态:unpaid/partial_paid/paid',
        CREATE_USER VARCHAR(64) COMMENT '制单人',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        CONFIRMED_TIME TIMESTAMP NULL COMMENT '确认时间',
        VOIDED_TIME TIMESTAMP NULL COMMENT '作废时间',
        PAID_TIME TIMESTAMP NULL COMMENT '付款时间',
        PRIMARY KEY (SETTLEMENT_ID),
        UNIQUE KEY uni_settlement_no (SETTLEMENT_NO),
        KEY idx_settlement_supplier (SUPPLIER_ID),
        KEY idx_settlement_status (STATUS)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='结算单表'
    `);
    await checkAndAddColumn('T_SETTLEMENT', 'SUPPLIER_ACCOUNT_ID', 'VARCHAR(32) COMMENT "供应商付款账户ID"', 'SUPPLIER_NAME');
    await checkAndAddColumn('T_SETTLEMENT', 'SUPPLIER_ACCOUNT_SNAPSHOT', 'TEXT COMMENT "供应商付款账户快照"', 'SUPPLIER_ACCOUNT_ID');
    await checkAndAddColumn('T_SETTLEMENT', 'OTHER_PAYMENT_REMARK', 'TEXT COMMENT "其他付款说明"', 'SUPPLIER_ACCOUNT_SNAPSHOT');
    await checkAndAddColumn('T_SETTLEMENT', 'OTHER_PAYMENT_IMAGE', 'LONGTEXT COMMENT "其他付款图片"', 'OTHER_PAYMENT_REMARK');
    await checkAndAddColumn('T_SETTLEMENT', 'PAID_AMOUNT', 'DECIMAL(12,2) DEFAULT 0 COMMENT "已付金额"', 'TOTAL_AMOUNT');
    await checkAndAddColumn('T_SETTLEMENT', 'PAYMENT_STATUS', 'VARCHAR(32) DEFAULT "unpaid" COMMENT "付款状态:unpaid/partial_paid/paid"', 'STATUS');
    await checkAndAddColumn('T_SETTLEMENT', 'CONFIRMED_TIME', 'TIMESTAMP NULL COMMENT "确认时间"', 'CREATE_TIME');
    await checkAndAddColumn('T_SETTLEMENT', 'VOIDED_TIME', 'TIMESTAMP NULL COMMENT "作废时间"', 'CONFIRMED_TIME');
    try {
      await sequelize.query(`
        UPDATE T_SETTLEMENT
        SET STATUS = 'confirmed',
            CONFIRMED_TIME = COALESCE(CONFIRMED_TIME, CREATE_TIME)
        WHERE STATUS = 'pending'
      `);
      console.log('[DB Migration] 已将旧待确认应付结算单归一为待付款');
    } catch (error) {
      console.warn('[DB Migration] normalize pending settlements skipped:', error.message);
    }

    await checkAndCreateTable('T_SETTLEMENT_ITEM', `
      CREATE TABLE T_SETTLEMENT_ITEM (
        ITEM_ID BIGINT(20) NOT NULL AUTO_INCREMENT COMMENT '明细ID',
        SETTLEMENT_ID VARCHAR(32) NOT NULL COMMENT '结算单ID',
        PAYABLE_ID VARCHAR(32) NOT NULL COMMENT '应付款ID',
        REQUEST_NO VARCHAR(64) COMMENT '采购单号',
        AMOUNT DECIMAL(12,2) NOT NULL COMMENT '金额',
        PRIMARY KEY (ITEM_ID),
        KEY idx_si_settlement (SETTLEMENT_ID),
        KEY idx_si_payable (PAYABLE_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='结算明细表'
    `);

    await checkAndCreateTable('T_SETTLEMENT_PAYMENT_BATCH', `
      CREATE TABLE T_SETTLEMENT_PAYMENT_BATCH (
        BATCH_ID VARCHAR(32) NOT NULL COMMENT '付款批次ID',
        BATCH_NO VARCHAR(64) NOT NULL COMMENT '付款批次号',
        ACCOUNT_ID VARCHAR(64) NOT NULL COMMENT '结算账户ID',
        ACCOUNT_NAME VARCHAR(128) COMMENT '结算账户名称',
        TOTAL_AMOUNT DECIMAL(12,2) NOT NULL COMMENT '付款总金额',
        TOTAL_COUNT INT DEFAULT 0 COMMENT '付款笔数',
        STATUS VARCHAR(32) DEFAULT 'active' COMMENT '状态:active/voided',
        REMARK VARCHAR(512) COMMENT '备注',
        CREATE_USER VARCHAR(64) COMMENT '导入人',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '导入时间',
        VOID_USER VARCHAR(64) COMMENT '撤销人',
        VOID_TIME TIMESTAMP NULL COMMENT '撤销时间',
        VOID_REASON VARCHAR(512) COMMENT '撤销原因',
        PRIMARY KEY (BATCH_ID),
        UNIQUE KEY uni_payment_batch_no (BATCH_NO),
        KEY idx_payment_batch_account (ACCOUNT_ID),
        KEY idx_payment_batch_status (STATUS)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='应付付款批次表'
    `);

    await checkAndCreateTable('T_SETTLEMENT_PAYMENT_RECORD', `
      CREATE TABLE T_SETTLEMENT_PAYMENT_RECORD (
        PAYMENT_ID VARCHAR(32) NOT NULL COMMENT '付款记录ID',
        BATCH_ID VARCHAR(32) NOT NULL COMMENT '付款批次ID',
        SETTLEMENT_ID VARCHAR(32) NOT NULL COMMENT '结算单ID',
        SETTLEMENT_NO VARCHAR(64) NOT NULL COMMENT '结算单号',
        SUPPLIER_NAME VARCHAR(255) COMMENT '供应商名称',
        ACCOUNT_ID VARCHAR(64) NOT NULL COMMENT '结算账户ID',
        AMOUNT DECIMAL(12,2) NOT NULL COMMENT '本次付款金额',
        PAYMENT_TIME TIMESTAMP NULL COMMENT '付款时间',
        REMARK VARCHAR(512) COMMENT '备注',
        IMPORT_KEY VARCHAR(128) COMMENT '导入标识',
        TRANSACTION_ID VARCHAR(64) COMMENT '账户流水ID',
        STATUS VARCHAR(32) DEFAULT 'active' COMMENT '状态:active/voided',
        CREATE_USER VARCHAR(64) COMMENT '导入人',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        VOID_TRANSACTION_ID VARCHAR(64) COMMENT '撤销流水ID',
        PRIMARY KEY (PAYMENT_ID),
        KEY idx_payment_record_batch (BATCH_ID),
        KEY idx_payment_record_settlement (SETTLEMENT_ID),
        KEY idx_payment_record_import_key (IMPORT_KEY),
        KEY idx_payment_record_status (STATUS)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='应付付款记录表'
    `);
    await checkAndAddColumn('T_SETTLEMENT_PAYMENT_RECORD', 'IMPORT_KEY', 'VARCHAR(128) COMMENT "导入标识"', 'REMARK');

    await checkAndCreateTable('T_SUPPLIER_REBATE', `
      CREATE TABLE T_SUPPLIER_REBATE (
        REBATE_ID VARCHAR(32) NOT NULL COMMENT '返利ID',
        SUPPLIER_ID VARCHAR(32) NOT NULL COMMENT '供应商ID',
        SUPPLIER_NAME VARCHAR(255) COMMENT '供应商名称',
        TYPE VARCHAR(32) NOT NULL COMMENT '类型:credit-上账,debit-抵扣',
        AMOUNT DECIMAL(12,2) NOT NULL COMMENT '金额',
        BALANCE DECIMAL(12,2) NOT NULL COMMENT '操作后余额',
        RELATED_NO VARCHAR(64) COMMENT '关联单号',
        REMARK VARCHAR(512) COMMENT '备注',
        CREATE_USER VARCHAR(64) COMMENT '操作人',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        PRIMARY KEY (REBATE_ID),
        KEY idx_rebate_supplier (SUPPLIER_ID),
        KEY idx_rebate_type (TYPE)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='供应商返利表'
    `);

    await checkAndCreateTable('T_MANUFACTURER_REBATE_POLICY', `
      CREATE TABLE T_MANUFACTURER_REBATE_POLICY (
        POLICY_ID VARCHAR(32) NOT NULL COMMENT '政策ID',
        SUPPLIER_ID VARCHAR(32) NOT NULL COMMENT '供应商/厂家ID',
        SUPPLIER_NAME VARCHAR(255) COMMENT '供应商/厂家名称',
        POLICY_NAME VARCHAR(128) NOT NULL COMMENT '政策名称',
        POLICY_TYPE VARCHAR(32) DEFAULT 'activity' COMMENT '政策类型:p0_difference/activity/education/other',
        PRODUCT_ID VARCHAR(32) COMMENT '商品ID',
        PRODUCT_NAME VARCHAR(255) COMMENT '商品名称',
        PN VARCHAR(64) COMMENT 'PN',
        MODEL VARCHAR(128) COMMENT '型号',
        START_DATE DATE COMMENT '开始日期',
        END_DATE DATE COMMENT '结束日期',
        REBATE_CALCULATION_TYPE VARCHAR(32) DEFAULT 'fixed_amount' COMMENT '返利计算方式:fixed_amount/percentage',
        REBATE_AMOUNT DECIMAL(12,2) DEFAULT 0 COMMENT '固定返利金额',
        REBATE_RATE DECIMAL(8,4) DEFAULT 0 COMMENT '返利比例',
        AFFECT_SALES_SETTLEMENT_COST TINYINT(1) DEFAULT 0 COMMENT '是否影响销售结算成本',
        COST_ADJUSTMENT_TYPE VARCHAR(32) DEFAULT 'fixed_amount' COMMENT '成本调整方式:fixed_amount/percentage/custom_rule',
        COST_ADJUSTMENT_VALUE DECIMAL(12,4) DEFAULT 0 COMMENT '成本调整值',
        MAX_COST_ADJUSTMENT_AMOUNT DECIMAL(12,2) NULL COMMENT '最大成本调整金额',
        COST_ADJUSTMENT_REMARK VARCHAR(512) COMMENT '成本调整说明',
        REMARK VARCHAR(512) COMMENT '备注',
        STATUS TINYINT DEFAULT 1 COMMENT '状态',
        CREATE_USER VARCHAR(64) COMMENT '创建人',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        UPDATE_USER VARCHAR(64) COMMENT '更新人',
        UPDATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
        PRIMARY KEY (POLICY_ID),
        KEY idx_mrp_supplier (SUPPLIER_ID),
        KEY idx_mrp_pn (PN),
        KEY idx_mrp_product (PRODUCT_ID),
        KEY idx_mrp_status (STATUS)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='厂家返利政策表'
    `);

    await checkAndCreateTable('T_MANUFACTURER_PRICE_HISTORY', `
      CREATE TABLE T_MANUFACTURER_PRICE_HISTORY (
        ID VARCHAR(32) NOT NULL COMMENT 'ID',
        SUPPLIER_ID VARCHAR(32) NOT NULL COMMENT '供应商/厂家ID',
        SUPPLIER_NAME VARCHAR(255) COMMENT '供应商/厂家名称',
        PRODUCT_ID VARCHAR(32) COMMENT '商品ID',
        PRODUCT_NAME VARCHAR(255) COMMENT '商品名称',
        PN VARCHAR(64) NOT NULL COMMENT 'PN',
        MODEL VARCHAR(128) COMMENT '型号',
        EFFECTIVE_DATE DATE NOT NULL COMMENT '生效日期',
        EXPIRE_DATE DATE NULL COMMENT '失效日期',
        PICKUP_PRICE DECIMAL(12,2) NOT NULL COMMENT '厂家提货价',
        P0_PRICE DECIMAL(12,2) NULL COMMENT 'P0价',
        IMPORT_BATCH_NO VARCHAR(64) COMMENT '导入批次号',
        SOURCE_FILE_URL VARCHAR(512) COMMENT '来源文件',
        REMARK VARCHAR(512) COMMENT '备注',
        CREATED_BY VARCHAR(64) COMMENT '创建人',
        CREATED_AT TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        UPDATED_BY VARCHAR(64) COMMENT '更新人',
        UPDATED_AT TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
        PRIMARY KEY (ID),
        KEY idx_mph_supplier_pn_date (SUPPLIER_ID, PN, EFFECTIVE_DATE),
        KEY idx_mph_pn_date (PN, EFFECTIVE_DATE),
        KEY idx_mph_product (PRODUCT_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='厂家价格历史表'
    `);

    await checkAndCreateTable('T_REBATE_ESTIMATE', `
      CREATE TABLE T_REBATE_ESTIMATE (
        ESTIMATE_ID VARCHAR(32) NOT NULL COMMENT '返利预估ID',
        SALES_ORDER_ID VARCHAR(32) NOT NULL COMMENT '销售订单ID',
        SALES_ORDER_NO VARCHAR(64) COMMENT '销售单号',
        SALES_ORDER_ITEM_ID BIGINT(20) COMMENT '销售明细ID',
        SUPPLIER_ID VARCHAR(32) COMMENT '供应商/厂家ID',
        SUPPLIER_NAME VARCHAR(255) COMMENT '供应商/厂家名称',
        PRODUCT_ID VARCHAR(32) COMMENT '商品ID',
        PRODUCT_NAME VARCHAR(255) COMMENT '商品名称',
        PN VARCHAR(64) COMMENT 'PN',
        SN VARCHAR(128) COMMENT 'SN',
        POLICY_ID VARCHAR(32) COMMENT '政策ID',
        POLICY_NAME VARCHAR(128) COMMENT '政策名称',
        POLICY_TYPE VARCHAR(32) COMMENT '政策类型',
        REBATE_ESTIMATE_AMOUNT DECIMAL(12,2) DEFAULT 0 COMMENT '返利预估金额',
        STATUS VARCHAR(32) DEFAULT 'estimated' COMMENT '状态:estimated/confirmed/received/written_off',
        REMARK VARCHAR(512) COMMENT '备注',
        CREATED_AT TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        UPDATED_AT TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
        PRIMARY KEY (ESTIMATE_ID),
        KEY idx_rebate_estimate_order (SALES_ORDER_ID),
        KEY idx_rebate_estimate_policy (POLICY_ID),
        KEY idx_rebate_estimate_status (STATUS)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='厂家返利预估表'
    `);

    await checkAndCreateTable('T_SALES_SETTLEMENT_COST_ADJUSTMENT', `
      CREATE TABLE T_SALES_SETTLEMENT_COST_ADJUSTMENT (
        ID VARCHAR(32) NOT NULL COMMENT 'ID',
        SALES_ORDER_ID VARCHAR(32) NOT NULL COMMENT '销售订单ID',
        SALES_ORDER_NO VARCHAR(64) COMMENT '销售单号',
        SALES_ORDER_ITEM_ID BIGINT(20) COMMENT '销售明细ID',
        SUPPLIER_ID VARCHAR(32) COMMENT '供应商/厂家ID',
        SUPPLIER_NAME VARCHAR(255) COMMENT '供应商/厂家名称',
        PRODUCT_ID VARCHAR(32) COMMENT '商品ID',
        PRODUCT_NAME VARCHAR(255) COMMENT '商品名称',
        PN VARCHAR(64) COMMENT 'PN',
        SN VARCHAR(128) COMMENT 'SN',
        ORIGINAL_INVENTORY_COST DECIMAL(12,2) DEFAULT 0 COMMENT '原始库存成本',
        ORIGINAL_PICKUP_PRICE DECIMAL(12,2) DEFAULT 0 COMMENT '原始提货价',
        CURRENT_PICKUP_PRICE_AT_SALE DECIMAL(12,2) DEFAULT 0 COMMENT '销售时厂家当前提货价',
        POLICY_ID VARCHAR(32) COMMENT '政策ID',
        POLICY_NAME VARCHAR(128) COMMENT '政策名称',
        POLICY_TYPE VARCHAR(32) COMMENT '政策类型',
        REBATE_ESTIMATE_ID VARCHAR(32) COMMENT '返利预估ID',
        REBATE_ESTIMATE_AMOUNT DECIMAL(12,2) DEFAULT 0 COMMENT '返利预估金额',
        AFFECT_SALES_SETTLEMENT_COST TINYINT(1) DEFAULT 0 COMMENT '是否影响销售结算成本',
        COST_ADJUSTMENT_AMOUNT DECIMAL(12,2) DEFAULT 0 COMMENT '成本调整金额',
        FINAL_SALES_SETTLEMENT_COST DECIMAL(12,2) DEFAULT 0 COMMENT '最终销售结算成本',
        REMARK VARCHAR(512) COMMENT '备注',
        CREATED_AT TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        UPDATED_AT TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
        PRIMARY KEY (ID),
        KEY idx_ssca_order (SALES_ORDER_ID),
        KEY idx_ssca_item (SALES_ORDER_ITEM_ID),
        KEY idx_ssca_policy (POLICY_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='销售结算成本调整明细表'
    `);

    await checkAndAddColumn('T_PURCHASE_REQUEST', 'REBATE_DEDUCTION', 'DECIMAL(12,2) DEFAULT 0.00 COMMENT "返利抵扣"', 'TOTAL_AMOUNT');
    await checkAndAddColumn('T_PURCHASE_REQUEST', 'ACTUAL_TOTAL', 'DECIMAL(12,2) DEFAULT 0.00 COMMENT "抵扣后实际总价"', 'REBATE_DEDUCTION');

    await checkAndAddColumn('T_STAFF', 'CREATE_TIME', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT "创建时间"', 'STATUS');
    await checkAndAddColumn('T_STAFF', 'UPDATE_TIME', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT "更新时间"', 'CREATE_TIME');

    await checkAndAddColumn('T_ORDER', 'CREATE_TIME', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT "创建时间"', 'REMARK');
    await checkAndAddColumn('T_ORDER', 'UPDATE_TIME', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT "更新时间"', 'CREATE_TIME');

    await checkAndAddColumn('T_PRODUCT', 'NEED_SN', 'TINYINT(1) DEFAULT 0 COMMENT "是否需要SN管理"', 'STATUS');
    await checkAndAddColumn('T_DICT_PAYMENT_METHOD', 'SETTLEMENT_ACCOUNT_ID', 'VARCHAR(64) COMMENT "结算账号ID（全局默认）"', 'ICON');
    await checkAndAddColumn('T_DICT_PAYMENT_METHOD', 'IS_GLOBAL', 'TINYINT(1) DEFAULT 1 COMMENT "是否全局配置"', 'SETTLEMENT_ACCOUNT_ID');

    await checkAndAddColumn('T_PURCHASE_REQUEST_ITEM', 'PRODUCT_TYPE', 'VARCHAR(32) COMMENT "货型：正规货/国补货/纯二批"', 'SUBTOTAL');
    await checkAndAddColumn('T_INBOUND_ITEM', 'PRODUCT_TYPE', 'VARCHAR(32) COMMENT "货型：正规货/国补货/纯二批"', 'INVENTORY_TYPE');
    await checkAndAddColumn('T_INBOUND_ITEM', 'ORIGINAL_PICKUP_PRICE', 'DECIMAL(12,2) DEFAULT 0 COMMENT "原始提货价"', 'UNIT_PRICE');
    await checkAndAddColumn('T_INVENTORY', 'REGULAR_QTY', 'INT DEFAULT 0 COMMENT "正规货数量"', 'NORMAL_QTY');
    await checkAndAddColumn('T_INVENTORY', 'SUBSIDY_QTY', 'INT DEFAULT 0 COMMENT "国补货数量"', 'REGULAR_QTY');
    await checkAndAddColumn('T_INVENTORY', 'SECOND_QTY', 'INT DEFAULT 0 COMMENT "纯二批数量"', 'SUBSIDY_QTY');

    await checkAndAddColumn('T_PURCHASE_REQUEST_ITEM', 'REBATE_DEDUCTION', 'DECIMAL(12,2) DEFAULT 0.00 COMMENT "item rebate deduction"', 'SUBTOTAL');

    await checkAndAddColumn('T_ORDER_ITEM', 'ORIGINAL_INVENTORY_COST', 'DECIMAL(12,2) DEFAULT 0 COMMENT "原始库存成本"', 'SUBTOTAL');
    await checkAndAddColumn('T_ORDER_ITEM', 'ORIGINAL_PICKUP_PRICE', 'DECIMAL(12,2) DEFAULT 0 COMMENT "原始提货价"', 'ORIGINAL_INVENTORY_COST');
    await checkAndAddColumn('T_ORDER_ITEM', 'CURRENT_PICKUP_PRICE_AT_SALE', 'DECIMAL(12,2) DEFAULT 0 COMMENT "销售时厂家当前提货价"', 'ORIGINAL_PICKUP_PRICE');
    await checkAndAddColumn('T_ORDER_ITEM', 'P0_DIFFERENCE_AMOUNT', 'DECIMAL(12,2) DEFAULT 0 COMMENT "P差金额"', 'CURRENT_PICKUP_PRICE_AT_SALE');
    await checkAndAddColumn('T_ORDER_ITEM', 'COST_ADJUSTMENT_AMOUNT', 'DECIMAL(12,2) DEFAULT 0 COMMENT "政策成本调整金额"', 'P0_DIFFERENCE_AMOUNT');
    await checkAndAddColumn('T_ORDER_ITEM', 'SALES_SETTLEMENT_COST', 'DECIMAL(12,2) DEFAULT 0 COMMENT "销售结算成本"', 'COST_ADJUSTMENT_AMOUNT');
    await checkAndAddColumn('T_ORDER_ITEM', 'SALES_GROSS_PROFIT', 'DECIMAL(12,2) DEFAULT 0 COMMENT "销售毛利"', 'SALES_SETTLEMENT_COST');
    await checkAndAddColumn('T_ORDER_PAYMENT', 'DEPOSIT_ID', 'VARCHAR(32) COMMENT "定金单ID"', 'PAYMENT_METHOD');

    await checkAndCreateTable('T_DEPOSIT_ORDER', `
      CREATE TABLE T_DEPOSIT_ORDER (
        DEPOSIT_ID VARCHAR(32) NOT NULL COMMENT '定金单ID',
        DEPOSIT_NO VARCHAR(64) NOT NULL COMMENT '定金单号',
        STORE_ID VARCHAR(32) NOT NULL COMMENT '门店ID',
        CUSTOMER_NAME VARCHAR(64) COMMENT '客户姓名',
        CUSTOMER_PHONE VARCHAR(32) COMMENT '客户电话',
        CUSTOMER_SOURCE VARCHAR(64) COMMENT '客户来源',
        AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '定金金额',
        REDEEMED_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '已核销金额',
        REFUNDED_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '已退款金额',
        STATUS VARCHAR(32) DEFAULT 'submitted' COMMENT '状态:submitted/archived/redeemed/refunded/voided',
        RELATED_ORDER_ID VARCHAR(32) COMMENT '核销销售订单ID',
        RELATED_ORDER_NO VARCHAR(64) COMMENT '核销销售订单号',
        REMARK TEXT COMMENT '备注',
        CREATE_STAFF_ID BIGINT(20) COMMENT '收取定金店员ID',
        CREATE_USER VARCHAR(64) COMMENT '收取定金店员',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        ARCHIVE_USER VARCHAR(64) COMMENT '归档人',
        ARCHIVE_TIME DATETIME COMMENT '归档时间',
        UPDATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
        IS_DELETED TINYINT(1) DEFAULT 0 COMMENT '是否删除',
        PRIMARY KEY (DEPOSIT_ID),
        UNIQUE KEY uk_deposit_no (DEPOSIT_NO),
        KEY idx_deposit_store (STORE_ID),
        KEY idx_deposit_staff_status (CREATE_STAFF_ID, STATUS),
        KEY idx_deposit_customer (CUSTOMER_PHONE)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='定金单'
    `);

    await checkAndCreateTable('T_DEPOSIT_REFUND', `
      CREATE TABLE T_DEPOSIT_REFUND (
        REFUND_ID VARCHAR(32) NOT NULL COMMENT '退款记录ID',
        REFUND_NO VARCHAR(64) NOT NULL COMMENT '退款记录号',
        DEPOSIT_ID VARCHAR(32) NOT NULL COMMENT '定金单ID',
        AMOUNT DECIMAL(12,2) NOT NULL COMMENT '退款金额',
        REASON VARCHAR(512) COMMENT '退款原因',
        CREATE_STAFF_ID BIGINT(20) COMMENT '记录人ID',
        CREATE_USER VARCHAR(64) COMMENT '记录人',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        PRIMARY KEY (REFUND_ID),
        UNIQUE KEY uk_deposit_refund_no (REFUND_NO),
        KEY idx_deposit_refund_deposit (DEPOSIT_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='定金退款记录'
    `);

    await checkAndCreateTable('T_DEPOSIT_REDEMPTION', `
      CREATE TABLE T_DEPOSIT_REDEMPTION (
        REDEMPTION_ID VARCHAR(32) NOT NULL COMMENT '核销记录ID',
        DEPOSIT_ID VARCHAR(32) NOT NULL COMMENT '定金单ID',
        ORDER_ID VARCHAR(32) NOT NULL COMMENT '销售订单ID',
        ORDER_NO VARCHAR(64) COMMENT '销售订单号',
        AMOUNT DECIMAL(12,2) NOT NULL COMMENT '核销金额',
        STATUS VARCHAR(32) DEFAULT 'active' COMMENT '状态:active/voided',
        VOID_REASON VARCHAR(512) COMMENT '作废原因',
        VOID_TIME DATETIME COMMENT '作废时间',
        CREATE_STAFF_ID BIGINT(20) COMMENT '核销人ID',
        CREATE_USER VARCHAR(64) COMMENT '核销人',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        PRIMARY KEY (REDEMPTION_ID),
        KEY idx_deposit_redemption_deposit (DEPOSIT_ID),
        KEY idx_deposit_redemption_order (ORDER_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='定金核销记录'
    `);

    await checkAndAddColumn('T_DEPOSIT_ORDER', 'REDEEMED_AMOUNT', 'DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT "已核销金额"', 'AMOUNT');
    await checkAndAddColumn('T_DEPOSIT_ORDER', 'REFUNDED_AMOUNT', 'DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT "已退款金额"', 'REDEEMED_AMOUNT');
    await checkAndAddColumn('T_DEPOSIT_ORDER', 'RELATED_ORDER_ID', 'VARCHAR(32) COMMENT "核销销售订单ID"', 'STATUS');
    await checkAndAddColumn('T_DEPOSIT_ORDER', 'RELATED_ORDER_NO', 'VARCHAR(64) COMMENT "核销销售订单号"', 'RELATED_ORDER_ID');
    await checkAndAddColumn('T_DEPOSIT_REDEMPTION', 'STATUS', 'VARCHAR(32) DEFAULT "active" COMMENT "状态:active/voided"', 'AMOUNT');
    await checkAndAddColumn('T_DEPOSIT_REDEMPTION', 'VOID_REASON', 'VARCHAR(512) COMMENT "作废原因"', 'STATUS');
    await checkAndAddColumn('T_DEPOSIT_REDEMPTION', 'VOID_TIME', 'DATETIME COMMENT "作废时间"', 'VOID_REASON');
    await sequelize.query(`
      INSERT IGNORE INTO T_DICT_PAYMENT_METHOD (METHOD_ID, NAME, CODE, ICON, SORT_ORDER, STATUS)
      VALUES ('PM_DEPOSIT', '定金', 'deposit', 'deposit-icon', 99, 1)
    `);

    await checkAndCreateTable('T_DAILY_STATEMENT', `
      CREATE TABLE T_DAILY_STATEMENT (
        STATEMENT_ID VARCHAR(32) NOT NULL COMMENT '日结单ID',
        STORE_ID VARCHAR(32) NOT NULL COMMENT '门店ID',
        STATEMENT_DATE DATE NOT NULL COMMENT '日期',
        TOTAL_REVENUE DECIMAL(12,2) DEFAULT 0 COMMENT '总营收',
        TOTAL_ORDER_COUNT INT DEFAULT 0 COMMENT '订单数',
        TOTAL_SETTLED DECIMAL(12,2) DEFAULT 0 COMMENT '已下账金额',
        STATUS VARCHAR(32) DEFAULT 'pending' COMMENT 'pending/partial/settled',
        SUBMIT_STAFF VARCHAR(64) COMMENT '提交人',
        CONFIRM_STAFF VARCHAR(64) COMMENT '确认人',
        PRIMARY KEY (STATEMENT_ID),
        UNIQUE KEY uk_store_date (STORE_ID, STATEMENT_DATE)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='日结单'
    `);

    await checkAndAddColumn('T_DAILY_STATEMENT', 'TOTAL_SETTLED', 'DECIMAL(12,2) DEFAULT 0', 'TOTAL_ORDER_COUNT');
    await checkAndAddColumn('T_DAILY_STATEMENT', 'SUBMIT_STAFF', 'VARCHAR(64)', 'STATUS');
    await checkAndAddColumn('T_DAILY_STATEMENT', 'CONFIRM_STAFF', 'VARCHAR(64)', 'SUBMIT_STAFF');

    await checkAndAddColumn('T_TRANSFER', 'INBOUND_CONFIRM_USER', 'VARCHAR(64) COMMENT "入库确认人"', 'CONFIRM_USER');
    await checkAndAddColumn('T_TRANSFER', 'CREATE_TIME', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT "创建时间"', 'INBOUND_CONFIRM_USER');

    await checkAndCreateTable('T_DAILY_STATEMENT_DETAIL', `
      CREATE TABLE T_DAILY_STATEMENT_DETAIL (
        DETAIL_ID VARCHAR(64) NOT NULL COMMENT '明细ID',
        STATEMENT_ID VARCHAR(32) NOT NULL COMMENT '日结单ID',
        ORDER_ID VARCHAR(32) NOT NULL COMMENT '订单ID',
        ORDER_NO VARCHAR(64) COMMENT '订单号',
        CUSTOMER_NAME VARCHAR(64) COMMENT '客户名',
        PAYMENT_METHOD VARCHAR(128) COMMENT '收款方式名称',
        PAYMENT_CODE VARCHAR(64) COMMENT '收款方式编码',
        AMOUNT DECIMAL(12,2) DEFAULT 0 COMMENT '收款金额',
        SETTLEMENT_ACCOUNT_ID VARCHAR(64) COMMENT '结算账号ID',
        SETTLED DECIMAL(12,2) DEFAULT 0 COMMENT '已下账金额',
        SETTLED_AT DATETIME COMMENT '下账时间',
        PRIMARY KEY (DETAIL_ID),
        KEY idx_statement (STATEMENT_ID),
        KEY idx_order (ORDER_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='日结单明细'
    `);

    await checkAndCreateTable('T_DICT_CUSTOMER_SOURCE', `
      CREATE TABLE T_DICT_CUSTOMER_SOURCE (
        SOURCE_ID VARCHAR(64) NOT NULL COMMENT '来源ID',
        PARENT_ID VARCHAR(64) COMMENT '父级ID',
        NAME VARCHAR(128) NOT NULL COMMENT '名称',
        LEVEL INT DEFAULT 1 COMMENT '层级',
        SORT_ORDER INT DEFAULT 0 COMMENT '排序',
        STATUS TINYINT DEFAULT 1 COMMENT '状态',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        PRIMARY KEY (SOURCE_ID),
        KEY idx_status (STATUS)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='字典-客户来源'
    `);

    await checkAndCreateTable('T_SETTLEMENT_ACCOUNT', `
      CREATE TABLE T_SETTLEMENT_ACCOUNT (
        ACCOUNT_ID VARCHAR(64) NOT NULL COMMENT '账号ID',
        ACCOUNT_NAME VARCHAR(128) NOT NULL COMMENT '账号名称',
        BANK_NAME VARCHAR(128) COMMENT '开户行',
        ACCOUNT_NUMBER VARCHAR(128) COMMENT '账号',
        SORT_ORDER INT DEFAULT 0 COMMENT '排序',
        STATUS TINYINT DEFAULT 1 COMMENT '状态',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        PRIMARY KEY (ACCOUNT_ID),
        KEY idx_status (STATUS)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='结算账号表'
    `);

    await checkAndCreateTable('T_DICT_PAYMENT_METHOD', `
      CREATE TABLE T_DICT_PAYMENT_METHOD (
        METHOD_ID VARCHAR(64) NOT NULL COMMENT '方式ID',
        NAME VARCHAR(128) NOT NULL COMMENT '名称',
        CODE VARCHAR(64) COMMENT '编码',
        ICON VARCHAR(64) COMMENT '图标',
        SETTLEMENT_ACCOUNT_ID VARCHAR(64) COMMENT '结算账号ID（全局默认）',
        IS_GLOBAL TINYINT(1) DEFAULT 1 COMMENT '是否全局配置（1=全局，0=按门店）',
        SORT_ORDER INT DEFAULT 0 COMMENT '排序',
        STATUS TINYINT DEFAULT 1 COMMENT '状态',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        PRIMARY KEY (METHOD_ID),
        KEY idx_status (STATUS)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='字典-收款方式'
    `);

    await checkAndCreateTable('T_DICT_PAYMENT_METHOD_STORE', `
      CREATE TABLE T_DICT_PAYMENT_METHOD_STORE (
        ID INT NOT NULL AUTO_INCREMENT COMMENT 'ID',
        METHOD_ID VARCHAR(64) NOT NULL COMMENT '收款方式ID',
        STORE_ID VARCHAR(64) NOT NULL COMMENT '门店ID',
        SETTLEMENT_ACCOUNT_ID VARCHAR(64) COMMENT '结算账号ID',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        PRIMARY KEY (ID),
        UNIQUE KEY uk_method_store (METHOD_ID, STORE_ID),
        KEY idx_store (STORE_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='收款方式-门店关联表'
    `);

    await checkAndCreateTable('T_DICT_SUPPLEMENT_ITEM', `
      CREATE TABLE T_DICT_SUPPLEMENT_ITEM (
        ITEM_ID VARCHAR(64) NOT NULL COMMENT '项目ID',
        NAME VARCHAR(128) NOT NULL COMMENT '名称',
        AMOUNT DECIMAL(10,2) DEFAULT 0 COMMENT '默认金额',
        IS_ACTIVE TINYINT(1) DEFAULT 1 COMMENT '是否启用',
        SORT_ORDER INT DEFAULT 0 COMMENT '排序',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        PRIMARY KEY (ITEM_ID),
        KEY idx_active (IS_ACTIVE)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='字典-金额补录项目'
    `);

    await checkAndCreateTable('T_INVENTORY', `
      CREATE TABLE T_INVENTORY (
        INVENTORY_ID VARCHAR(32) NOT NULL PRIMARY KEY COMMENT '库存ID',
        PRODUCT_ID VARCHAR(32) NOT NULL COMMENT '商品ID',
        STORE_ID VARCHAR(32) NOT NULL DEFAULT '' COMMENT '门店ID',
        NORMAL_QTY INT DEFAULT 0 COMMENT '现有库存',
        DISPLAY_QTY INT DEFAULT 0 COMMENT '铺货仓库存',
        DEMO_QTY INT DEFAULT 0 COMMENT '样机库存',
        UNSELLABLE_QTY INT DEFAULT 0 COMMENT '不可售库存',
        PENDING_QTY INT DEFAULT 0 COMMENT '待入库库存',
        UPDATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
        UNIQUE KEY uk_product_store (PRODUCT_ID, STORE_ID),
        KEY idx_product (PRODUCT_ID),
        KEY idx_store (STORE_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='库存聚合表'
    `);

    await checkAndCreateTable('T_PRODUCT_BARCODE', `
      CREATE TABLE T_PRODUCT_BARCODE (
        BARCODE_ID VARCHAR(32) NOT NULL COMMENT '条码ID',
        PRODUCT_ID VARCHAR(32) NOT NULL COMMENT '商品ID',
        BARCODE_TYPE VARCHAR(16) NOT NULL COMMENT '类型:manufacturer/barcode69',
        BARCODE_CODE VARCHAR(128) NOT NULL COMMENT '条码内容',
        SORT_ORDER INT DEFAULT 0 COMMENT '排序',
        STATUS TINYINT DEFAULT 1 COMMENT '状态',
        PRIMARY KEY (BARCODE_ID),
        KEY idx_product (PRODUCT_ID),
        KEY idx_type (BARCODE_TYPE)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='商品条码表'
    `);

    await checkAndCreateTable('T_PRODUCT_CATEGORY', `
      CREATE TABLE T_PRODUCT_CATEGORY (
        CATEGORY_ID VARCHAR(32) NOT NULL COMMENT '分类ID',
        PARENT_ID VARCHAR(32) COMMENT '父级分类ID',
        NAME VARCHAR(128) NOT NULL COMMENT '分类名称',
        LEVEL INT DEFAULT 1 COMMENT '层级(1-3)',
        SORT_ORDER INT DEFAULT 0 COMMENT '排序',
        STATUS TINYINT DEFAULT 1 COMMENT '状态',
        PRIMARY KEY (CATEGORY_ID),
        KEY idx_parent (PARENT_ID),
        KEY idx_level (LEVEL)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='商品分类表'
    `);
    await initializeCategorySortOrder();

    await checkAndCreateTable('T_PRODUCT_PRICE', `
      CREATE TABLE T_PRODUCT_PRICE (
        PRICE_ID VARCHAR(32) NOT NULL COMMENT '价格ID',
        PRODUCT_ID VARCHAR(32) NOT NULL COMMENT '商品ID',
        COST_PRICE DECIMAL(12,2) DEFAULT 0 COMMENT '库存成本价(加权平均)',
        STANDARD_PRICE DECIMAL(12,2) DEFAULT 0 COMMENT '标准售价',
        MIN_SALE_PRICE DECIMAL(12,2) DEFAULT 0 COMMENT '最低销售价',
        EFFECTIVE_TIME DATETIME COMMENT '生效时间',
        CREATE_USER VARCHAR(64) COMMENT '操作人',
        STATUS TINYINT DEFAULT 1 COMMENT '状态',
        PRIMARY KEY (PRICE_ID),
        UNIQUE KEY uk_product (PRODUCT_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='商品价格表'
    `);

    await checkAndCreateTable('T_PRODUCT_PRICE_IMPORT_BATCH', `
      CREATE TABLE T_PRODUCT_PRICE_IMPORT_BATCH (
        BATCH_ID VARCHAR(32) NOT NULL COMMENT '批次ID',
        BATCH_NO VARCHAR(64) NOT NULL COMMENT '批次号',
        SOURCE_FILE_NAME VARCHAR(255) COMMENT '来源文件名',
        TOTAL_ROWS INT DEFAULT 0 COMMENT '导入行数',
        TOTAL_PRODUCTS INT DEFAULT 0 COMMENT '影响商品数',
        TOTAL_CHANGES INT DEFAULT 0 COMMENT '价格变更条数',
        STATUS VARCHAR(32) DEFAULT 'effective' COMMENT '状态:effective/pending/failed',
        REMARK VARCHAR(512) COMMENT '备注',
        CREATE_USER VARCHAR(64) COMMENT '导入人',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '导入时间',
        PRIMARY KEY (BATCH_ID),
        UNIQUE KEY uk_product_price_batch_no (BATCH_NO),
        KEY idx_product_price_batch_status (STATUS)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='商品价格导入批次表'
    `);

    await checkAndCreateTable('T_PRODUCT_PRICE_CHANGE_LOG', `
      CREATE TABLE T_PRODUCT_PRICE_CHANGE_LOG (
        CHANGE_ID VARCHAR(32) NOT NULL COMMENT '变更ID',
        BATCH_ID VARCHAR(32) COMMENT '批次ID',
        BATCH_NO VARCHAR(64) COMMENT '批次号',
        ROW_NO INT COMMENT 'Excel行号',
        PRODUCT_ID VARCHAR(32) NOT NULL COMMENT '商品ID',
        PRODUCT_CODE VARCHAR(32) COMMENT '商品编码',
        PRODUCT_NAME VARCHAR(255) COMMENT '商品名称快照',
        MANUFACTURER_CODE VARCHAR(128) COMMENT '厂商编码',
        PRICE_FIELD VARCHAR(32) NOT NULL COMMENT '价格字段:standard_price/min_sale_price',
        OLD_PRICE DECIMAL(12,2) DEFAULT 0 COMMENT '调整前价格',
        NEW_PRICE DECIMAL(12,2) NOT NULL COMMENT '调整后价格',
        EFFECTIVE_TIME DATETIME NOT NULL COMMENT '生效时间',
        SOURCE VARCHAR(32) DEFAULT 'import' COMMENT '来源:import/manual',
        CHANGE_REASON VARCHAR(512) COMMENT '调价原因',
        REMARK VARCHAR(512) COMMENT '备注',
        STATUS VARCHAR(32) DEFAULT 'pending' COMMENT '状态:pending/effective/failed',
        CREATE_USER VARCHAR(64) COMMENT '操作人',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        APPLIED_TIME DATETIME COMMENT '实际生效时间',
        FAIL_REASON VARCHAR(512) COMMENT '失败原因',
        PRIMARY KEY (CHANGE_ID),
        KEY idx_price_change_product (PRODUCT_ID),
        KEY idx_price_change_batch (BATCH_ID),
        KEY idx_price_change_status_time (STATUS, EFFECTIVE_TIME),
        KEY idx_price_change_field (PRICE_FIELD)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='商品价格变更记录表'
    `);

    await checkAndAddColumn('T_PRODUCT', 'ATTRIBUTES', 'TEXT COMMENT "动态属性JSON"', 'SPECS_JSON');
    await checkAndAddColumn('T_PRODUCT', 'BRAND', 'VARCHAR(64) COMMENT "品牌"', 'ATTRIBUTES');
    await checkAndAddColumn('T_PRODUCT', 'SERIES', 'VARCHAR(64) COMMENT "系列"', 'BRAND');
    await checkAndAddColumn('T_PRODUCT', 'MODEL', 'VARCHAR(64) COMMENT "型号"', 'SERIES');
    await checkAndAddColumn('T_PRODUCT', 'PROCESSOR', 'VARCHAR(64) COMMENT "处理器"', 'MODEL');
    await checkAndAddColumn('T_PRODUCT', 'MEMORY', 'VARCHAR(32) COMMENT "内存"', 'PROCESSOR');
    await checkAndAddColumn('T_PRODUCT', 'STORAGE', 'VARCHAR(32) COMMENT "存储"', 'MEMORY');
    await checkAndAddColumn('T_PRODUCT', 'COLOR', 'VARCHAR(32) COMMENT "颜色"', 'STORAGE');
    await checkAndAddColumn('T_PRODUCT', 'GPU', 'VARCHAR(64) COMMENT "显卡/GPU"', 'COLOR');
    await checkAndAddColumn('T_PRODUCT', 'ACCESSORY_TYPE', 'VARCHAR(64) COMMENT "配件类别"', 'GPU');
    await checkAndAddColumn('T_PRODUCT', 'EXTRAS', 'TEXT COMMENT "扩展属性JSON"', 'ACCESSORY_TYPE');

    await checkAndCreateTable('T_PRODUCT_CATEGORY_FIELD', `
      CREATE TABLE IF NOT EXISTS T_PRODUCT_CATEGORY_FIELD (
        FIELD_ID VARCHAR(32) NOT NULL COMMENT '字段ID',
        CATEGORY_ID VARCHAR(32) NOT NULL COMMENT '分类ID',
        FIELD_LABEL VARCHAR(64) NOT NULL COMMENT '字段显示名',
        FIELD_KEY VARCHAR(64) NOT NULL COMMENT '字段标识',
        FIELD_TYPE VARCHAR(32) DEFAULT 'text' COMMENT 'text/select',
        FIELD_OPTIONS TEXT COMMENT 'select选项(JSON数组)',
        FIELD_PLACEHOLDER VARCHAR(128) COMMENT '输入提示词',
        SORT_ORDER INT DEFAULT 0 COMMENT '排序',
        REQUIRED TINYINT DEFAULT 0 COMMENT '是否必填',
        STATUS TINYINT DEFAULT 1 COMMENT '状态',
        PRIMARY KEY (FIELD_ID),
        INDEX idx_category (CATEGORY_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='商品分类字段配置'
    `);

    await checkAndAddColumn('T_PRODUCT_CATEGORY_FIELD', 'FIELD_PLACEHOLDER', 'VARCHAR(128) COMMENT \'输入提示词\'', 'FIELD_OPTIONS');

    await migrateProductData();

    await seedPermissionData();

    console.log('[DB Migration] 数据库结构检查完成！');
  } catch (error) {
    console.error('[DB Migration] 迁移失败:', error.message);
  }
}

async function migrateProductData() {
  console.log('[DB Migration] 开始迁移商品数据...');
  try {
    const uuid = require('crypto').randomUUID;

    // 迁移旧标准售价/最低售价到 T_PRODUCT_PRICE（老表中可能还有 OLD_PRICE/OLD_MIN_PRICE 备份列）
    const products = await sequelize.query(
      `SELECT PRODUCT_ID, STANDARD_PRICE, MIN_SALE_PRICE 
       FROM T_PRODUCT WHERE (STANDARD_PRICE IS NOT NULL AND STANDARD_PRICE > 0) 
          OR (MIN_SALE_PRICE IS NOT NULL AND MIN_SALE_PRICE > 0)`,
      { type: sequelize.QueryTypes.SELECT }
    );

    if (products && products.length > 0) {
      let priceCount = 0;
      for (const p of products) {
        const [exist] = await sequelize.query(
          `SELECT COUNT(*) as cnt FROM T_PRODUCT_PRICE WHERE PRODUCT_ID = ?`,
          { replacements: [p.PRODUCT_ID], type: sequelize.QueryTypes.SELECT }
        );
        if (exist.cnt > 0) continue;

        const priceId = uuid().replace(/-/g, '').substring(0, 32);
        await sequelize.query(
          `INSERT INTO T_PRODUCT_PRICE (PRICE_ID, PRODUCT_ID, COST_PRICE, STANDARD_PRICE, MIN_SALE_PRICE, STATUS)
           VALUES (?, ?, 0, ?, ?, 1)`,
          { replacements: [priceId, p.PRODUCT_ID, p.STANDARD_PRICE || 0, p.MIN_SALE_PRICE || 0] }
        );
        priceCount++;
      }
      console.log(`[DB Migration] 已迁移 ${priceCount} 条商品价格数据`);
    }

    // 迁移旧厂商编码和69码到 T_PRODUCT_BARCODE
    const productsWithCodes = await sequelize.query(
      `SELECT PRODUCT_ID, MANUFACTURER_CODE, BARCODE_69 
       FROM T_PRODUCT 
       WHERE (MANUFACTURER_CODE IS NOT NULL AND MANUFACTURER_CODE != '') 
          OR (BARCODE_69 IS NOT NULL AND BARCODE_69 != '')`,
      { type: sequelize.QueryTypes.SELECT }
    );

    if (productsWithCodes && productsWithCodes.length > 0) {
      let barcodeCount = 0;
      for (const p of productsWithCodes) {
        if (p.MANUFACTURER_CODE) {
          const [exist] = await sequelize.query(
            `SELECT COUNT(*) as cnt FROM T_PRODUCT_BARCODE WHERE PRODUCT_ID = ? AND BARCODE_TYPE = 'manufacturer' AND BARCODE_CODE = ?`,
            { replacements: [p.PRODUCT_ID, p.MANUFACTURER_CODE], type: sequelize.QueryTypes.SELECT }
          );
          if (exist.cnt === 0) {
            await sequelize.query(
              `INSERT INTO T_PRODUCT_BARCODE (BARCODE_ID, PRODUCT_ID, BARCODE_TYPE, BARCODE_CODE, STATUS)
               VALUES (?, ?, 'manufacturer', ?, 1)`,
              { replacements: [uuid().replace(/-/g, '').substring(0, 32), p.PRODUCT_ID, p.MANUFACTURER_CODE] }
            );
            barcodeCount++;
          }
        }
        if (p.BARCODE_69) {
          const [exist] = await sequelize.query(
            `SELECT COUNT(*) as cnt FROM T_PRODUCT_BARCODE WHERE PRODUCT_ID = ? AND BARCODE_TYPE = 'barcode69' AND BARCODE_CODE = ?`,
            { replacements: [p.PRODUCT_ID, p.BARCODE_69], type: sequelize.QueryTypes.SELECT }
          );
          if (exist.cnt === 0) {
            await sequelize.query(
              `INSERT INTO T_PRODUCT_BARCODE (BARCODE_ID, PRODUCT_ID, BARCODE_TYPE, BARCODE_CODE, STATUS)
               VALUES (?, ?, 'barcode69', ?, 1)`,
              { replacements: [uuid().replace(/-/g, '').substring(0, 32), p.PRODUCT_ID, p.BARCODE_69] }
            );
            barcodeCount++;
          }
        }
      }
      console.log(`[DB Migration] 已迁移 ${barcodeCount} 条商品条码数据`);
    }

    // 迁移旧分类（从category字段提取去重的分类名创建分类）
    const categories = await sequelize.query(
      `SELECT DISTINCT CATEGORY FROM T_PRODUCT WHERE CATEGORY IS NOT NULL AND CATEGORY != '' AND IS_DELETED = 0`,
      { type: sequelize.QueryTypes.SELECT }
    );

    await sequelize.query(`
      UPDATE T_PRODUCT p
      LEFT JOIN (
        SELECT PRODUCT_ID,
               GROUP_CONCAT(BARCODE_CODE ORDER BY SORT_ORDER ASC, BARCODE_ID ASC SEPARATOR ', ') AS CODES
        FROM T_PRODUCT_BARCODE
        WHERE BARCODE_TYPE = 'manufacturer' AND STATUS = 1
        GROUP BY PRODUCT_ID
      ) b ON b.PRODUCT_ID = p.PRODUCT_ID
      SET p.MANUFACTURER_CODE = b.CODES
      WHERE (p.MANUFACTURER_CODE IS NULL OR p.MANUFACTURER_CODE = '')
        AND b.CODES IS NOT NULL AND b.CODES != ''
    `);

    await sequelize.query(`
      UPDATE T_PRODUCT p
      LEFT JOIN (
        SELECT PRODUCT_ID,
               GROUP_CONCAT(PN_CODE ORDER BY IS_PRIMARY DESC, PN_ID ASC SEPARATOR ', ') AS CODES
        FROM T_PRODUCT_PN
        WHERE IS_DELETED = 0
        GROUP BY PRODUCT_ID
      ) pn ON pn.PRODUCT_ID = p.PRODUCT_ID
      SET p.MANUFACTURER_CODE = pn.CODES
      WHERE (p.MANUFACTURER_CODE IS NULL OR p.MANUFACTURER_CODE = '')
        AND pn.CODES IS NOT NULL AND pn.CODES != ''
    `);

    if (categories && categories.length > 0) {
      let catCount = 0;
      for (const c of categories) {
        const [exist] = await sequelize.query(
          `SELECT COUNT(*) as cnt FROM T_PRODUCT_CATEGORY WHERE NAME = ?`,
          { replacements: [c.CATEGORY], type: sequelize.QueryTypes.SELECT }
        );
        if (exist.cnt > 0) continue;

        const catId = uuid().replace(/-/g, '').substring(0, 32);
        await sequelize.query(
          `INSERT INTO T_PRODUCT_CATEGORY (CATEGORY_ID, PARENT_ID, NAME, LEVEL, SORT_ORDER, STATUS)
           VALUES (?, NULL, ?, 1, 0, 1)`,
          { replacements: [catId, c.CATEGORY] }
        );

        await sequelize.query(
          `UPDATE T_PRODUCT SET CATEGORY_ID = ? WHERE CATEGORY = ?`,
          { replacements: [catId, c.CATEGORY] }
        );
        catCount++;
      }
      console.log(`[DB Migration] 已迁移 ${catCount} 个商品分类`);
    }

    // 根据 CATEGORY_ID 回填 CATEGORY 路径文本
    const productsNeedPath = await sequelize.query(
      `SELECT PRODUCT_ID, CATEGORY_ID FROM T_PRODUCT 
       WHERE CATEGORY_ID IS NOT NULL AND CATEGORY_ID != '' AND IS_DELETED = 0
         AND (CATEGORY IS NULL OR CATEGORY = '')`,
      { type: sequelize.QueryTypes.SELECT }
    );

    if (productsNeedPath && productsNeedPath.length > 0) {
      let pathCount = 0;
      for (const p of productsNeedPath) {
        const parts = [];
        let currentId = p.CATEGORY_ID;
        while (currentId) {
          const [cat] = await sequelize.query(
            `SELECT PARENT_ID, NAME FROM T_PRODUCT_CATEGORY WHERE CATEGORY_ID = ?`,
            { replacements: [currentId], type: sequelize.QueryTypes.SELECT }
          );
          if (!cat) break;
          parts.unshift(cat.NAME);
          currentId = cat.PARENT_ID;
        }
        if (parts.length > 0) {
          await sequelize.query(
            `UPDATE T_PRODUCT SET CATEGORY = ? WHERE PRODUCT_ID = ?`,
            { replacements: [parts.join('/'), p.PRODUCT_ID] }
          );
          pathCount++;
        }
      }
      console.log(`[DB Migration] 已回填 ${pathCount} 个商品的分类路径`);
    }

    console.log('[DB Migration] 商品数据迁移完成');
  } catch (error) {
    console.error('[DB Migration] 商品数据迁移失败:', error.message);
  }
}

async function seedPermissionData() {
  try {
    const uuid = require('crypto').randomUUID;
    const [roleCount] = await sequelize.query(
      "SELECT COUNT(*) as cnt FROM T_ROLE",
      { type: sequelize.QueryTypes.SELECT }
    );
    if (roleCount.cnt > 0) {
      await sequelize.query(`
        UPDATE T_MENU
        SET STATUS = 0
        WHERE MENU_CODE = 'paymentManagement'
      `);
      console.log('[DB Migration] 权限数据已存在, 跳过种子');
      return;
    }

    const menus = [
      ['home', '首页', null, 'menu', '/', 'House', 1],
      ['sales', '销售管理', null, 'menu', '/sales', 'Sell', 2],
      ['inventory', '库存管理', null, 'menu', '/inventory', 'Box', 3],
      ['purchase', '采购管理', null, 'menu', '/purchase', 'ShoppingCart', 4],
      ['finance', '财务管理', null, 'menu', '/finance', 'Money', 5],
      ['products', '商品管理', null, 'menu', '/products', 'Goods', 6],
      ['stores', '门店管理', null, 'menu', '/stores', 'Shop', 7],
      ['reports', '报表统计', null, 'menu', '/reports', 'DataAnalysis', 8],
      ['system', '系统设置', null, 'menu', '/system', 'Setting', 9]
    ];

    for (const m of menus) {
      await sequelize.query(
        `INSERT IGNORE INTO T_MENU (MENU_ID, MENU_CODE, NAME, PARENT_ID, MENU_TYPE, PATH, ICON, SORT_ORDER, STATUS) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        { replacements: [uuid().replace(/-/g, '').substring(0, 32), m[0], m[1], m[2], m[3], m[4], m[5], m[6]] }
      );
    }

    const roles = [
      ['boss', '系统管理员', '全部权限'],
      ['admin', '经销商总权限', '财务+采购+全部'],
      ['finance', '财务', '所有财务管理内容'],
      ['purchaser', '采购', '所有采购管理内容'],
      ['manager', '店长', '店员权限+本门店操作记录'],
      ['clerk', '店员', '基础销售/库存查询/门店入库/报表']
    ];

    for (const r of roles) {
      await sequelize.query(
        `INSERT IGNORE INTO T_ROLE (ROLE_ID, ROLE_CODE, NAME, DESCRIPTION, IS_SYSTEM, STATUS)
         VALUES (?, ?, ?, ?, 1, 1)`,
        { replacements: [uuid().replace(/-/g, '').substring(0, 32), r[0], r[1], r[2]] }
      );
    }

    const allMenus = await sequelize.query('SELECT MENU_ID, MENU_CODE FROM T_MENU', { type: sequelize.QueryTypes.SELECT });
    const allRoles = await sequelize.query('SELECT ROLE_ID, ROLE_CODE FROM T_ROLE', { type: sequelize.QueryTypes.SELECT });

    const menuMap = {};
    allMenus.forEach(m => { menuMap[m.MENU_CODE] = m.MENU_ID; });
    const roleMap = {};
    allRoles.forEach(r => { roleMap[r.ROLE_CODE] = r.ROLE_ID; });

    const roleMenus = {
      boss:   ['home', 'sales', 'inventory', 'purchase', 'finance', 'products', 'stores', 'reports', 'system'],
      admin:  ['home', 'sales', 'inventory', 'purchase', 'finance', 'products', 'stores', 'reports', 'system'],
      finance: ['home', 'finance'],
      purchaser: ['home', 'purchase'],
      manager: ['home', 'sales', 'inventory', 'products', 'reports', 'stores', 'system'],
      clerk:   ['home', 'sales', 'inventory', 'reports']
    };

    for (const [roleCode, menuCodes] of Object.entries(roleMenus)) {
      const roleId = roleMap[roleCode];
      if (!roleId) continue;
      for (const menuCode of menuCodes) {
        const menuId = menuMap[menuCode];
        if (!menuId) continue;
        await sequelize.query(
          `INSERT IGNORE INTO T_ROLE_MENU (ROLE_ID, MENU_ID) VALUES (?, ?)`,
          { replacements: [roleId, menuId] }
        );
      }
    }

    console.log('[DB Migration] 权限种子数据已创建');

    await sequelize.query(
      `INSERT IGNORE INTO T_STAFF_ROLE (STAFF_ID, ROLE_ID)
       SELECT 1, ROLE_ID FROM T_ROLE WHERE ROLE_CODE = 'boss'`
    );
    console.log('[DB Migration] boss用户已绑定角色');
  } catch (error) {
    console.error('[DB Migration] 种子权限数据失败:', error.message);
  }
}

module.exports = { runMigrations };
