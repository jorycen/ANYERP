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
    await checkAndAddColumn('T_SUPPLIER', 'CREATE_TIME', 'DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT "创建时间"', 'IS_DELETED');
    await checkAndAddColumn('T_SUPPLIER', 'UPDATE_TIME', 'DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT "更新时间"', 'CREATE_TIME');
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
        STATUS VARCHAR(32) DEFAULT 'unpaid' COMMENT '状态:unpaid/paid',
        CREATE_USER VARCHAR(64) COMMENT '制单人',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
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
    await checkAndAddColumn('T_INVENTORY', 'REGULAR_QTY', 'INT DEFAULT 0 COMMENT "正规货数量"', 'NORMAL_QTY');
    await checkAndAddColumn('T_INVENTORY', 'SUBSIDY_QTY', 'INT DEFAULT 0 COMMENT "国补货数量"', 'REGULAR_QTY');
    await checkAndAddColumn('T_INVENTORY', 'SECOND_QTY', 'INT DEFAULT 0 COMMENT "纯二批数量"', 'SUBSIDY_QTY');

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
    const [roleCount] = await sequelize.query(
      "SELECT COUNT(*) as cnt FROM T_ROLE",
      { type: sequelize.QueryTypes.SELECT }
    );
    if (roleCount.cnt > 0) {
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

    const uuid = require('crypto').randomUUID;
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
