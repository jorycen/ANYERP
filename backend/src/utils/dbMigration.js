/**
 * 数据库自动迁移工具
 * 在启动时自动检查并添加缺少的字段和表
 */

const { sequelize } = require('../models');
const { normalizePnCode, splitPnCodes, isUsablePnCode } = require('./productPn');

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

async function checkAndMakeColumnNullable(tableName, columnName, columnDefinition) {
  try {
    const [result] = await sequelize.query(
      `SELECT IS_NULLABLE
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = ?
         AND COLUMN_NAME = ?`,
      { replacements: [tableName, columnName], type: sequelize.QueryTypes.SELECT }
    );
    if (!result || result.IS_NULLABLE === 'YES') return false;
    await sequelize.query(`ALTER TABLE ${tableName} MODIFY COLUMN ${columnName} ${columnDefinition} NULL`);
    console.log(`[DB Migration] 已允许字段为空: ${tableName}.${columnName}`);
    return true;
  } catch (error) {
    console.error(`[DB Migration] 调整字段为空失败: ${tableName}.${columnName} - ${error.message}`);
    return false;
  }
}

// Ensure fields used by the product/order read path exist before the rest of
// the startup migrations run.
async function ensureCriticalSchemaCompatibility() {
  await checkAndAddColumn(
    'T_PRODUCT',
    'IS_USED_PRODUCT',
    'TINYINT(1) NOT NULL DEFAULT 0 COMMENT "used product flag"'
  );
  await checkAndAddColumn(
    'T_PURCHASE_REQUEST_ITEM',
    'IS_USED_PRODUCT',
    'TINYINT(1) NOT NULL DEFAULT 0 COMMENT "二手商品标记"',
    'PN_CODE'
  );

  const [column] = await sequelize.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'T_PRODUCT'
       AND COLUMN_NAME = 'IS_USED_PRODUCT'`,
    { type: sequelize.QueryTypes.SELECT }
  );

  if (Number(column?.cnt || 0) !== 1) {
    throw new Error('Required schema column T_PRODUCT.IS_USED_PRODUCT is unavailable');
  }

  const [purchaseItemColumn] = await sequelize.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'T_PURCHASE_REQUEST_ITEM'
       AND COLUMN_NAME = 'IS_USED_PRODUCT'`,
    { type: sequelize.QueryTypes.SELECT }
  );

  if (Number(purchaseItemColumn?.cnt || 0) !== 1) {
    throw new Error('Required schema column T_PURCHASE_REQUEST_ITEM.IS_USED_PRODUCT is unavailable');
  }

  // 二手采购明细没有商品主数据 ID，必须允许 PRODUCT_ID 为空。
  await checkAndMakeColumnNullable('T_PURCHASE_REQUEST_ITEM', 'PRODUCT_ID', 'VARCHAR(32)');
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

async function ensureProductPnEffectiveUniqueIndex() {
  const conflicts = await sequelize.query(
    `SELECT LOWER(REPLACE(TRIM(PN_CODE), ' ', '')) AS normalized_pn_code, COUNT(*) AS row_count
     FROM T_PRODUCT_PN
     WHERE STATUS = 1 AND IS_DELETED = 0
     GROUP BY LOWER(REPLACE(TRIM(PN_CODE), ' ', ''))
     HAVING COUNT(*) > 1`,
    { type: sequelize.QueryTypes.SELECT }
  );
  if (conflicts.length > 0) {
    throw new Error(
      `T_PRODUCT_PN 存在有效PN重复，暂停唯一约束迁移：${conflicts[0].normalized_pn_code}`
    );
  }

  const [activeColumn] = await sequelize.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'T_PRODUCT_PN'
       AND COLUMN_NAME = 'ACTIVE_PN_CODE'`,
    { type: sequelize.QueryTypes.SELECT }
  );
  if (Number(activeColumn.cnt || 0) === 0) {
    await sequelize.query(
      `ALTER TABLE T_PRODUCT_PN
       ADD COLUMN ACTIVE_PN_CODE VARCHAR(64)
       GENERATED ALWAYS AS (
         IF(STATUS = 1 AND IS_DELETED = 0,
           LOWER(REPLACE(TRIM(PN_CODE), ' ', '')),
           NULL
         )
       ) STORED AFTER IS_DELETED`
    );
    console.log('[DB Migration] 已添加 T_PRODUCT_PN.ACTIVE_PN_CODE');
  }

  const [legacyIndex] = await sequelize.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'T_PRODUCT_PN'
       AND INDEX_NAME = 'uni_pn_code'`,
    { type: sequelize.QueryTypes.SELECT }
  );
  if (Number(legacyIndex.cnt || 0) > 0) {
    await sequelize.query('ALTER TABLE T_PRODUCT_PN DROP INDEX uni_pn_code');
    console.log('[DB Migration] 已移除 T_PRODUCT_PN.uni_pn_code');
  }

  const [effectiveIndex] = await sequelize.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'T_PRODUCT_PN'
       AND INDEX_NAME = 'uni_active_pn_code'`,
    { type: sequelize.QueryTypes.SELECT }
  );
  if (Number(effectiveIndex.cnt || 0) === 0) {
    await sequelize.query(
      'ALTER TABLE T_PRODUCT_PN ADD UNIQUE KEY uni_active_pn_code (ACTIVE_PN_CODE)'
    );
    console.log('[DB Migration] 已建立有效 PN 唯一约束');
  }
}

async function ensureSerializedInventorySchema() {
  await checkAndCreateTable('T_INVENTORY_RECONCILIATION_LOG', `
    CREATE TABLE T_INVENTORY_RECONCILIATION_LOG (
      RECONCILIATION_ID VARCHAR(32) NOT NULL,
      RUN_ID VARCHAR(32) NOT NULL,
      PRODUCT_ID VARCHAR(32) NOT NULL,
      STORE_ID VARCHAR(32) NOT NULL,
      LOCATION_ID VARCHAR(32) NOT NULL,
      ACTION VARCHAR(16) NOT NULL,
      BEFORE_NORMAL_QTY INT NOT NULL DEFAULT 0,
      AFTER_NORMAL_QTY INT NOT NULL DEFAULT 0,
      SN_QTY INT NOT NULL DEFAULT 0,
      DIFF INT NOT NULL DEFAULT 0,
      REASON VARCHAR(255),
      OPERATOR VARCHAR(64),
      CREATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (RECONCILIATION_ID),
      KEY idx_inventory_reconcile_run (RUN_ID, CREATE_TIME),
      KEY idx_inventory_reconcile_scope (PRODUCT_ID, STORE_ID, LOCATION_ID, CREATE_TIME)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='序列号库存余额对账日志'
  `);
  await checkAndAddIndex(
    'T_PRODUCT_SN',
    'idx_product_store_status_deleted_location',
    'ALTER TABLE T_PRODUCT_SN ADD INDEX idx_product_store_status_deleted_location (PRODUCT_ID, STORE_ID, STATUS, IS_DELETED, LOCATION_ID)'
  );
  await checkAndAddIndex(
    'T_PRODUCT_SN',
    'idx_pn_status_deleted_store',
    'ALTER TABLE T_PRODUCT_SN ADD INDEX idx_pn_status_deleted_store (PN_CODE, STATUS, IS_DELETED, STORE_ID)'
  );
  await checkAndAddIndex(
    'T_ORDER_ITEM',
    'idx_order_item_sn',
    'ALTER TABLE T_ORDER_ITEM ADD INDEX idx_order_item_sn (SN_ID, SN_CODE, PRODUCT_ID)'
  );
  await checkAndAddIndex(
    'T_TRANSFER_ITEM',
    'idx_transfer_item_sn',
    'ALTER TABLE T_TRANSFER_ITEM ADD INDEX idx_transfer_item_sn (SN_ID, SN_CODE, PRODUCT_ID)'
  );
}

async function ensureVarcharLength(tableName, columnName, length, columnDefinition) {
  try {
    const [result] = await sequelize.query(
      `SELECT CHARACTER_MAXIMUM_LENGTH AS maxLength
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
      { replacements: [tableName, columnName], type: sequelize.QueryTypes.SELECT }
    );
    if (!result || Number(result.maxLength || 0) >= Number(length)) return false;
    await sequelize.query(`ALTER TABLE ${tableName} MODIFY COLUMN ${columnName} ${columnDefinition}`);
    console.log(`[DB Migration] 已扩展字段长度: ${tableName}.${columnName} -> ${length}`);
    return true;
  } catch (error) {
    console.error(`[DB Migration] 扩展字段失败: ${tableName}.${columnName} - ${error.message}`);
    return false;
  }
}

async function ensureColumnType(tableName, columnName, allowedTypes, columnDefinition) {
  try {
    const [column] = await sequelize.query(
      `SELECT DATA_TYPE
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
      { replacements: [tableName, columnName], type: sequelize.QueryTypes.SELECT }
    );
    if (!column || allowedTypes.includes(String(column.DATA_TYPE || '').toLowerCase())) return false;
    await sequelize.query(`ALTER TABLE ${tableName} MODIFY COLUMN ${columnName} ${columnDefinition}`);
    console.log(`[DB Migration] 已调整字段类型: ${tableName}.${columnName} -> ${columnDefinition}`);
    return true;
  } catch (error) {
    console.error(`[DB Migration] 调整字段类型失败: ${tableName}.${columnName} - ${error.message}`);
    return false;
  }
}

async function ensureNullableColumn(tableName, columnName, columnDefinition) {
  try {
    const [column] = await sequelize.query(
      `SELECT IS_NULLABLE
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
      { replacements: [tableName, columnName], type: sequelize.QueryTypes.SELECT }
    );
    if (!column || column.IS_NULLABLE === 'YES') return false;
    await sequelize.query(`ALTER TABLE ${tableName} MODIFY COLUMN ${columnName} ${columnDefinition} NULL`);
    console.log(`[DB Migration] 已允许字段为空: ${tableName}.${columnName}`);
    return true;
  } catch (error) {
    console.error(`[DB Migration] 调整字段为空失败: ${tableName}.${columnName} - ${error.message}`);
    return false;
  }
}

async function normalizeProductResourceCostConfigIndex() {
  try {
    const indexes = await sequelize.query(
      `SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'T_PRODUCT_RESOURCE_COST_CONFIG'
       AND NON_UNIQUE = 0
       GROUP BY INDEX_NAME`,
      { type: sequelize.QueryTypes.SELECT }
    );

    for (const idx of indexes) {
      const columns = String(idx.columns || '').toUpperCase();
      if (columns === 'PRODUCT_ID,RESOURCE_TYPE') {
        await sequelize.query(`ALTER TABLE T_PRODUCT_RESOURCE_COST_CONFIG DROP INDEX \`${idx.INDEX_NAME}\``);
        console.log(`[DB Migration] Dropped product/resource-only unique index: ${idx.INDEX_NAME}`);
      }
    }

    await checkAndAddIndex(
      'T_PRODUCT_RESOURCE_COST_CONFIG',
      'uk_product_resource_supplier',
      'ALTER TABLE T_PRODUCT_RESOURCE_COST_CONFIG ADD UNIQUE KEY uk_product_resource_supplier (PRODUCT_ID, RESOURCE_TYPE, SUPPLIER_ID)'
    );
  } catch (error) {
    console.error(`[DB Migration] Normalize product resource config index failed - ${error.message}`);
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
  await ensureCriticalSchemaCompatibility();
  await ensureSerializedInventorySchema();
  await ensureProductPnEffectiveUniqueIndex();
  console.log('[DB Migration] 开始检查数据库结构...');
  
  try {
    await checkAndCreateTable('T_STAFF_STORE_PERMISSION', `
      CREATE TABLE T_STAFF_STORE_PERMISSION (
        ID BIGINT NOT NULL AUTO_INCREMENT,
        STAFF_ID BIGINT NOT NULL,
        STORE_ID VARCHAR(32) NOT NULL,
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (ID),
        UNIQUE KEY uk_staff_store (STAFF_ID, STORE_ID),
        KEY idx_staff_store_store (STORE_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='员工可访问门店'
    `);
    await checkAndCreateTable('T_REGION_PERMISSION', `
      CREATE TABLE T_REGION_PERMISSION (
        ID BIGINT NOT NULL AUTO_INCREMENT,
        STAFF_ID BIGINT NOT NULL,
        REGION_CODE VARCHAR(32) NOT NULL,
        CAN_VIEW TINYINT(1) DEFAULT 1,
        CAN_MANAGE TINYINT(1) DEFAULT 0,
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (ID),
        KEY idx_region_permission_staff (STAFF_ID),
        KEY idx_region_permission_region (REGION_CODE)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='账号直接区域权限'
    `);
    await checkAndCreateTable('T_STAFF_DISTRIBUTOR_PERMISSION', `
      CREATE TABLE T_STAFF_DISTRIBUTOR_PERMISSION (
        ID BIGINT NOT NULL AUTO_INCREMENT,
        STAFF_ID BIGINT NOT NULL,
        DISTRIBUTOR_ID VARCHAR(32) NOT NULL,
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (ID),
        UNIQUE KEY uk_staff_distributor (STAFF_ID, DISTRIBUTOR_ID),
        KEY idx_staff_distributor_distributor (DISTRIBUTOR_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='员工可操作经销商范围'
    `);
    await sequelize.query(`
      INSERT INTO T_DISTRIBUTOR (DISTRIBUTOR_ID, REGION_ID, NAME, STATUS, IS_DELETED)
      VALUES
        ('DIST001', 'R001', '艾诺云', 1, 0),
        ('DIST002', 'R002', '艾诺志兴', 1, 0)
      ON DUPLICATE KEY UPDATE
        REGION_ID = VALUES(REGION_ID), NAME = VALUES(NAME), STATUS = 1, IS_DELETED = 0
    `);
    await sequelize.query(`
      UPDATE T_STORE
      SET DISTRIBUTOR_ID = 'DIST002'
      WHERE REGION_ID = 'R002'
    `);
    await sequelize.query(`
      INSERT IGNORE INTO T_STAFF_DISTRIBUTOR_PERMISSION (STAFF_ID, DISTRIBUTOR_ID)
      SELECT STAFF_ID, DISTRIBUTOR_ID
      FROM T_STAFF
      WHERE DISTRIBUTOR_ID IS NOT NULL AND DISTRIBUTOR_ID <> ''
    `);
    await checkAndCreateTable('T_MONTHLY_TASK', `
      CREATE TABLE T_MONTHLY_TASK (
        TASK_ID VARCHAR(32) NOT NULL,
        DISTRIBUTOR_ID VARCHAR(32) NOT NULL,
        MONTH_KEY VARCHAR(7) NOT NULL,
        TARGET_TYPE VARCHAR(16) NOT NULL,
        TARGET_ID VARCHAR(32) NOT NULL,
        SALES_TARGET DECIMAL(12,2) NOT NULL DEFAULT 0,
        GROSS_PROFIT_TARGET DECIMAL(12,2) NOT NULL DEFAULT 0,
        STATUS TINYINT(1) NOT NULL DEFAULT 1,
        CREATE_STAFF_ID BIGINT,
        CREATE_USER VARCHAR(64),
        UPDATE_STAFF_ID BIGINT,
        UPDATE_USER VARCHAR(64),
        CREATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP,
        UPDATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (TASK_ID),
        UNIQUE KEY uk_monthly_task_scope (DISTRIBUTOR_ID, MONTH_KEY, TARGET_TYPE, TARGET_ID),
        KEY idx_monthly_task_month (DISTRIBUTOR_ID, MONTH_KEY, TARGET_TYPE, STATUS)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='月度任务目标'
    `);
    await checkAndCreateTable('T_MONTHLY_TASK_PRODUCT_BATCH', `
      CREATE TABLE T_MONTHLY_TASK_PRODUCT_BATCH (
        BATCH_ID VARCHAR(32) NOT NULL,
        TASK_ID VARCHAR(32) NOT NULL,
        BATCH_NAME VARCHAR(128) NOT NULL,
        SORT_ORDER INT NOT NULL DEFAULT 0,
        CREATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP,
        UPDATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (BATCH_ID),
        KEY idx_monthly_task_batch_task (TASK_ID, SORT_ORDER)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='月度任务商品批次'
    `);
    await checkAndCreateTable('T_MONTHLY_TASK_PRODUCT', `
      CREATE TABLE T_MONTHLY_TASK_PRODUCT (
        ID BIGINT NOT NULL AUTO_INCREMENT,
        BATCH_ID VARCHAR(32) NOT NULL,
        PRODUCT_ID VARCHAR(32) NOT NULL,
        PRODUCT_NAME VARCHAR(255) NOT NULL,
        TARGET_QUANTITY INT NOT NULL DEFAULT 0,
        CREATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (ID),
        UNIQUE KEY uk_monthly_task_batch_product (BATCH_ID, PRODUCT_ID),
        KEY idx_monthly_task_product_product (PRODUCT_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='月度任务批次商品目标'
    `);
    await checkAndCreateTable('T_MONTHLY_TASK_GROSS_PROFIT_ALLOCATION', `
      CREATE TABLE T_MONTHLY_TASK_GROSS_PROFIT_ALLOCATION (
        ALLOCATION_ID VARCHAR(32) NOT NULL,
        TASK_ID VARCHAR(32) NOT NULL,
        STAFF_ID BIGINT NOT NULL,
        ALLOCATED_TARGET DECIMAL(12,2) NOT NULL DEFAULT 0,
        CREATE_STAFF_ID BIGINT,
        CREATE_USER VARCHAR(64),
        UPDATE_STAFF_ID BIGINT,
        UPDATE_USER VARCHAR(64),
        CREATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP,
        UPDATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (ALLOCATION_ID),
        UNIQUE KEY uk_monthly_task_gp_staff (TASK_ID, STAFF_ID),
        KEY idx_monthly_task_gp_staff (STAFF_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='门店月度任务毛利员工分摊'
    `);
    // 经销商级账号从旧的门店授权迁移为直接区域授权，只执行一次性补齐，
    // 后续区域范围以 T_REGION_PERMISSION 为准，不再运行时反推。
    await sequelize.query(`
      INSERT INTO T_REGION_PERMISSION (STAFF_ID, REGION_CODE, CAN_VIEW, CAN_MANAGE)
      SELECT DISTINCT s.STAFF_ID, st.REGION_ID, 1, 1
      FROM T_STAFF s
      INNER JOIN T_STAFF_STORE_PERMISSION sp ON sp.STAFF_ID = s.STAFF_ID
      INNER JOIN T_STORE st ON st.STORE_ID = sp.STORE_ID
      WHERE s.IS_DELETED = 0
        AND st.IS_DELETED = 0
        AND st.STATUS = 1
        AND st.REGION_ID IS NOT NULL
        AND (
          s.ROLE_CODE NOT IN ('clerk', 'staff', 'manager', 'store_manager')
          OR EXISTS (
            SELECT 1
            FROM T_STAFF_ROLE sr
            INNER JOIN T_ROLE r ON r.ROLE_ID = sr.ROLE_ID AND r.STATUS = 1
            WHERE sr.STAFF_ID = s.STAFF_ID
              AND r.ROLE_CODE NOT IN ('clerk', 'staff', 'manager', 'store_manager')
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM T_REGION_PERMISSION rp
          WHERE rp.STAFF_ID = s.STAFF_ID
            AND rp.REGION_CODE = st.REGION_ID
        )
    `);
    await checkAndAddColumn('T_PRODUCT', 'T_CODE', 'VARCHAR(64) COMMENT "老厂商编码备份"', 'STATUS');
    await checkAndAddColumn('T_PRODUCT', 'T_BARCODE', 'VARCHAR(64) COMMENT "老69码备份"', 'T_CODE');
    await checkAndAddColumn('T_PRODUCT', 'T_STANDARD_PRICE', 'DECIMAL(12,2) COMMENT "老标准售价备份"', 'T_BARCODE');
    await checkAndAddColumn('T_PRODUCT', 'T_MIN_SALE_PRICE', 'DECIMAL(12,2) COMMENT "老最低售价备份"', 'T_STANDARD_PRICE');
    await checkAndAddColumn('T_PRODUCT', 'CATEGORY_ID', 'VARCHAR(32) COMMENT "分类ID"', 'NAME');
    await checkAndAddColumn('T_PRODUCT', 'CONFIG', 'VARCHAR(512) COMMENT "产品配置"', 'CATEGORY');
    await checkAndAddColumn('T_PRODUCT', 'IS_FOCUS_PRODUCT', 'TINYINT(1) NOT NULL DEFAULT 0 COMMENT "是否属于经营看板重点产品"', 'REMARK');
    await checkAndAddColumn('T_PRODUCT', 'CREATE_TIME', 'DATETIME COMMENT "创建时间"', 'CONFIG');
    await checkAndAddIndex('T_PRODUCT', 'idx_product_focus', 'ALTER TABLE T_PRODUCT ADD INDEX idx_product_focus (IS_FOCUS_PRODUCT, IS_DELETED, STATUS)');
    await checkAndAddIndex('T_ORDER', 'idx_order_bi_scope', 'ALTER TABLE T_ORDER ADD INDEX idx_order_bi_scope (IS_DELETED, ORDER_STATUS, STORE_ID, CREATE_TIME)');
    await checkAndAddColumn('T_PRODUCT_SN', 'PN_CODE', 'VARCHAR(64) COMMENT "PN料号"', 'PRODUCT_ID');
    await checkAndAddColumn('T_PRODUCT_SN', 'INVENTORY_TYPE', 'VARCHAR(32) DEFAULT "normal_qty" COMMENT "库存类型"', 'STATUS');
    await checkAndAddColumn('T_PRODUCT_SN', 'ORIGINAL_PICKUP_PRICE', 'DECIMAL(12,2) DEFAULT 0 COMMENT "原始提货价"', 'INBOUND_PRICE');
    await checkAndAddColumn('T_PRODUCT_SN', 'TAX_TYPE', 'VARCHAR(32) DEFAULT "UNKNOWN" COMMENT "税务属性:TAX_INCLUDED/UNTAXED/UNKNOWN"', 'ORIGINAL_PICKUP_PRICE');
    await checkAndAddColumn('T_PRODUCT_SN', 'SOURCE_TYPE', 'VARCHAR(32) DEFAULT "OTHER" COMMENT "货源性质"', 'TAX_TYPE');
    await checkAndAddColumn('T_PRODUCT_SN', 'BATCH_NO', 'VARCHAR(64) COMMENT "库存批次号"', 'SOURCE_TYPE');
    await checkAndAddColumn('T_PRODUCT_SN', 'SUPPLIER_ID', 'VARCHAR(32) COMMENT "采购来源供应商ID"', 'ORIGINAL_PICKUP_PRICE');
    await checkAndAddColumn('T_PRODUCT_SN', 'SUPPLIER_NAME', 'VARCHAR(255) COMMENT "采购来源供应商名称快照"', 'SUPPLIER_ID');
    await checkAndAddColumn('T_PRODUCT_SN', 'ORIGINAL_INBOUND_TIME', 'DATETIME COMMENT "公司首次采购入库时间，调拨不重置"', 'INBOUND_TIME');
    await checkAndAddColumn('T_PRODUCT_SN', 'UPDATE_TIME', 'DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT "SN最近状态更新时间"', 'ORIGINAL_INBOUND_TIME');
    await sequelize.query(`
      UPDATE T_PRODUCT_SN
      SET ORIGINAL_INBOUND_TIME = INBOUND_TIME
      WHERE ORIGINAL_INBOUND_TIME IS NULL
        AND INBOUND_TIME IS NOT NULL
    `);
    await checkAndAddColumn('T_SUPPLIER', 'IS_SERVICE_PROVIDER', 'TINYINT(1) NOT NULL DEFAULT 1 COMMENT "是否服务商"', 'ADDRESS');
    await checkAndAddColumn('T_SUPPLIER', 'GROSS_PROFIT_UPLIFT_AMOUNT', 'DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT "非服务商每件毛利上浮金额"', 'IS_SERVICE_PROVIDER');
    await checkAndAddColumn('T_ORDER_ITEM', 'SUPPLIER_ID', 'VARCHAR(32) COMMENT "采购来源供应商ID快照"', 'SUBTOTAL');
    await checkAndAddColumn('T_ORDER_ITEM', 'SUPPLIER_NAME', 'VARCHAR(255) COMMENT "采购来源供应商名称快照"', 'SUPPLIER_ID');
    await checkAndAddColumn('T_TRANSFER', 'DISTRIBUTOR_ID', 'VARCHAR(32) COMMENT "调拨所属经销商"', 'TO_STORE_ID');
    await checkAndAddColumn('T_TRANSFER', 'REGION_ID', 'VARCHAR(32) COMMENT "调拨所属区域"', 'DISTRIBUTOR_ID');
    await checkAndAddColumn('T_TRANSFER', 'SHIPPING_PHOTOS', 'JSON COMMENT "调出凭证照片"', 'REGION_ID');
    await checkAndAddColumn('T_TRANSFER', 'RECEIVING_PHOTOS', 'JSON COMMENT "收货凭证照片"', 'SHIPPING_PHOTOS');
    await checkAndAddColumn('T_TRANSFER', 'SHIPPING_USER', 'VARCHAR(64) COMMENT "出库确认人"', 'CONFIRM_USER');
    await checkAndAddColumn('T_TRANSFER', 'RECEIVING_USER', 'VARCHAR(64) COMMENT "收货确认人"', 'INBOUND_CONFIRM_USER');
    await checkAndAddColumn('T_TRANSFER', 'SHIPPING_TIME', 'DATETIME COMMENT "出库确认时间"', 'SHIPPING_USER');
    await checkAndAddColumn('T_TRANSFER', 'RECEIVING_TIME', 'DATETIME COMMENT "收货确认时间"', 'RECEIVING_USER');
    await checkAndAddColumn('T_TRANSFER_ITEM', 'PN_CODE', 'VARCHAR(64) COMMENT "调拨实际PN"', 'PRODUCT_ID');
    await checkAndAddColumn('T_TRANSFER', 'OUTBOUND_QUANTITY', 'INT NOT NULL DEFAULT 0 COMMENT "actual outbound quantity"', 'TOTAL_QUANTITY');
    await checkAndAddColumn('T_TRANSFER', 'REMAINING_QUANTITY', 'INT NOT NULL DEFAULT 0 COMMENT "remaining transfer quantity"', 'OUTBOUND_QUANTITY');
    await checkAndAddColumn('T_TRANSFER', 'REMAINING_STATUS', 'VARCHAR(32) NOT NULL DEFAULT "pending" COMMENT "pending/rejected/fulfilled"', 'REMAINING_QUANTITY');
    await dropProductSnGlobalUniqueIndex();
    await checkAndAddIndex('T_PRODUCT_SN', 'uk_product_sn_pn_sn', 'ALTER TABLE T_PRODUCT_SN ADD UNIQUE KEY uk_product_sn_pn_sn (PN_CODE, SN_CODE)');
    await checkAndAddIndex('T_PRODUCT_SN', 'idx_product_sn_code', 'ALTER TABLE T_PRODUCT_SN ADD INDEX idx_product_sn_code (SN_CODE)');
    await checkAndCreateTable('T_INVENTORY_RESOURCE_RIGHT', `
      CREATE TABLE T_INVENTORY_RESOURCE_RIGHT (
        RIGHT_ID VARCHAR(32) NOT NULL, SN_ID VARCHAR(32) NOT NULL, SN_CODE VARCHAR(128) NOT NULL,
        PRODUCT_ID VARCHAR(32) NOT NULL, RESOURCE_TYPE VARCHAR(32) NOT NULL,
        INITIAL_STATUS VARCHAR(32) NOT NULL DEFAULT 'NOT_APPLICABLE',
        CURRENT_STATUS VARCHAR(32) NOT NULL DEFAULT 'NOT_APPLICABLE', AMOUNT DECIMAL(12,2) DEFAULT 0,
        SOURCE VARCHAR(128), LOCKED_SOURCE_TYPE VARCHAR(32), LOCKED_SOURCE_ID VARCHAR(32),
        REMARK VARCHAR(512), VERSION INT DEFAULT 0,
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UPDATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (RIGHT_ID), UNIQUE KEY uk_sn_resource (SN_ID, RESOURCE_TYPE),
        KEY idx_resource_right_sn_code (SN_CODE), KEY idx_resource_right_status (RESOURCE_TYPE, CURRENT_STATUS)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='SN资源权益当前状态'
    `);
    await checkAndCreateTable('T_RESOURCE_CATEGORY', `
      CREATE TABLE T_RESOURCE_CATEGORY (
        CATEGORY_ID VARCHAR(32) NOT NULL, CATEGORY_CODE VARCHAR(32) NOT NULL, NAME VARCHAR(128) NOT NULL,
        SHORT_NAME VARCHAR(64), DEFAULT_ACCOUNT_ID VARCHAR(64), SUPPORTS_SALE_USE TINYINT(1) DEFAULT 1,
        SUPPORTS_COMPANY_CLAIM TINYINT(1) DEFAULT 1, SORT_ORDER INT DEFAULT 0, STATUS TINYINT(1) DEFAULT 1,
        REMARK VARCHAR(512), CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UPDATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (CATEGORY_ID), UNIQUE KEY uk_resource_category_code (CATEGORY_CODE),
        KEY idx_resource_category_status (STATUS, SORT_ORDER)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='资源权益类别配置'
    `);
    await checkAndCreateTable('T_GOODS_TYPE', `
      CREATE TABLE T_GOODS_TYPE (
        GOODS_TYPE_ID VARCHAR(32) NOT NULL, NAME VARCHAR(128) NOT NULL,
        SORT_ORDER INT DEFAULT 0, STATUS TINYINT(1) DEFAULT 1, REMARK VARCHAR(512),
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UPDATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (GOODS_TYPE_ID), UNIQUE KEY uk_goods_type_name (NAME),
        KEY idx_goods_type_status (STATUS, SORT_ORDER)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='采购货型模板'
    `);
    const goodsTypeResourceTableCreated = await checkAndCreateTable('T_GOODS_TYPE_RESOURCE', `
      CREATE TABLE T_GOODS_TYPE_RESOURCE (
        GOODS_TYPE_ID VARCHAR(32) NOT NULL, CATEGORY_ID VARCHAR(32) NOT NULL,
        SORT_ORDER INT DEFAULT 0, CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (GOODS_TYPE_ID, CATEGORY_ID),
        KEY idx_goods_type_resource_category (CATEGORY_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='货型包含的资源类别'
    `);
    await checkAndCreateTable('T_RESOURCE_RIGHT_CHANGE_ORDER', `
      CREATE TABLE T_RESOURCE_RIGHT_CHANGE_ORDER (
        CHANGE_ID VARCHAR(32) NOT NULL, CHANGE_ORDER_NO VARCHAR(64) NOT NULL,
        SN_ID VARCHAR(32) NOT NULL, SN_CODE VARCHAR(128) NOT NULL, PRODUCT_ID VARCHAR(32) NOT NULL,
        RESOURCE_TYPE VARCHAR(32) NOT NULL, BEFORE_STATUS VARCHAR(32) NOT NULL, AFTER_STATUS VARCHAR(32) NOT NULL,
        CHANGE_AMOUNT DECIMAL(12,2) DEFAULT 0, CHANGE_REASON VARCHAR(32) NOT NULL,
        APPROVAL_STATUS VARCHAR(32) DEFAULT 'approved', RELATED_ORDER_ID VARCHAR(32), RELATED_SALE_ORDER_ID VARCHAR(32),
        ATTACHMENT_URL VARCHAR(1000), APPLICANT_STAFF_ID BIGINT, APPLICANT_NAME VARCHAR(64),
        REVIEWER_STAFF_ID BIGINT, REVIEWER_NAME VARCHAR(64), REVIEW_COMMENT VARCHAR(512), REVIEW_TIME DATETIME,
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP, REMARK VARCHAR(512),
        PRIMARY KEY (CHANGE_ID), UNIQUE KEY uk_resource_change_no (CHANGE_ORDER_NO),
        KEY idx_resource_change_sn (SN_ID, CREATE_TIME), KEY idx_resource_change_approval (APPROVAL_STATUS, CREATE_TIME),
        KEY idx_resource_change_sale (RELATED_SALE_ORDER_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='资源权益变更及审批单'
    `);
    await checkAndCreateTable('T_PRODUCT_RESOURCE_COST_CONFIG', `
      CREATE TABLE T_PRODUCT_RESOURCE_COST_CONFIG (
        CONFIG_ID VARCHAR(32) NOT NULL, PRODUCT_ID VARCHAR(32) NOT NULL, RESOURCE_TYPE VARCHAR(32) NOT NULL,
        COST_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0, STATUS TINYINT(1) DEFAULT 1, REMARK VARCHAR(512),
        CREATE_USER VARCHAR(64), CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UPDATE_USER VARCHAR(64), UPDATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (CONFIG_ID), UNIQUE KEY uk_product_resource_cost (PRODUCT_ID, RESOURCE_TYPE)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='商品资源类型成本定义'
    `);
    await checkAndCreateTable('T_INVENTORY_RESOURCE_COST_ADJUSTMENT', `
      CREATE TABLE T_INVENTORY_RESOURCE_COST_ADJUSTMENT (
        ADJUSTMENT_ID VARCHAR(32) NOT NULL, SN_ID VARCHAR(32) NOT NULL, SN_CODE VARCHAR(128) NOT NULL,
        PRODUCT_ID VARCHAR(32) NOT NULL, RESOURCE_TYPE VARCHAR(32) NOT NULL,
        ADJUSTMENT_AMOUNT DECIMAL(12,2) NOT NULL, BEFORE_PRODUCT_COST DECIMAL(12,2) DEFAULT 0,
        AFTER_PRODUCT_COST DECIMAL(12,2) DEFAULT 0, SOURCE_TYPE VARCHAR(32) NOT NULL, SOURCE_ID VARCHAR(32) NOT NULL,
        AFFECT_SALES_SETTLEMENT_COST TINYINT(1) DEFAULT 0,
        OPERATOR_ID BIGINT, OPERATOR_NAME VARCHAR(64), CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP, REMARK VARCHAR(512),
        PRIMARY KEY (ADJUSTMENT_ID), UNIQUE KEY uk_resource_cost_source (SOURCE_TYPE, SOURCE_ID),
        KEY idx_resource_cost_sn (SN_ID, CREATE_TIME), KEY idx_resource_cost_product (PRODUCT_ID, RESOURCE_TYPE)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='产品资源成本调整流水'
    `);
    await checkAndCreateTable('T_RESOURCE_SETTLEMENT', `
      CREATE TABLE T_RESOURCE_SETTLEMENT (
        SETTLEMENT_ID VARCHAR(32) NOT NULL, SETTLEMENT_NO VARCHAR(64) NOT NULL,
        SOURCE_TYPE VARCHAR(32) NOT NULL, SOURCE_ID VARCHAR(64) NOT NULL, BATCH_NO VARCHAR(64),
        SN_ID VARCHAR(32), SN_CODE VARCHAR(128), PRODUCT_ID VARCHAR(32),
        RESOURCE_TYPE VARCHAR(32) NOT NULL, COUNTERPARTY_ID VARCHAR(32), COUNTERPARTY_NAME VARCHAR(255), AMOUNT DECIMAL(12,2) NOT NULL,
        MATCHED_AMOUNT DECIMAL(12,2) DEFAULT 0, STATUS VARCHAR(32) DEFAULT 'PENDING', TARGET_ACCOUNT_ID VARCHAR(64), SETTLED_AT DATETIME,
        SETTLED_BY BIGINT, SETTLED_BY_NAME VARCHAR(64),
        CREATE_STAFF_ID BIGINT, CREATE_USER VARCHAR(64),
        CANCELLED_AT DATETIME, CANCELLED_BY BIGINT, CANCELLED_BY_NAME VARCHAR(64),
        REVERSED_AT DATETIME, REVERSED_BY BIGINT, REVERSED_BY_NAME VARCHAR(64),
        CORRECTION_REASON VARCHAR(512), CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UPDATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        REMARK VARCHAR(512), PRIMARY KEY (SETTLEMENT_ID), UNIQUE KEY uk_resource_settlement_no (SETTLEMENT_NO),
        UNIQUE KEY uk_resource_settlement_source (SOURCE_TYPE, SOURCE_ID, RESOURCE_TYPE),
        KEY idx_resource_settlement_status (STATUS, CREATE_TIME), KEY idx_resource_settlement_sn (SN_ID, RESOURCE_TYPE)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='资源权益待下账及到账记录'
    `);
    await checkAndAddColumn('T_RESOURCE_SETTLEMENT', 'COUNTERPARTY_ID', 'VARCHAR(32) COMMENT "来源供应商或结算对象ID"', 'RESOURCE_TYPE');
    await checkAndAddColumn('T_RESOURCE_SETTLEMENT', 'COUNTERPARTY_NAME', 'VARCHAR(255) COMMENT "来源供应商或结算对象名称"', 'COUNTERPARTY_ID');
    await checkAndAddColumn('T_RESOURCE_SETTLEMENT', 'MATCHED_AMOUNT', 'DECIMAL(12,2) DEFAULT 0 COMMENT "已核销金额"', 'AMOUNT');
    await checkAndMakeColumnNullable('T_RESOURCE_SETTLEMENT', 'SN_ID', 'VARCHAR(32)');
    await checkAndMakeColumnNullable('T_RESOURCE_SETTLEMENT', 'SN_CODE', 'VARCHAR(128)');
    await checkAndMakeColumnNullable('T_RESOURCE_SETTLEMENT', 'PRODUCT_ID', 'VARCHAR(32)');
    await checkAndAddColumn('T_RESOURCE_SETTLEMENT', 'CREATE_STAFF_ID', 'BIGINT COMMENT "创建人员工ID"', 'SETTLED_BY_NAME');
    await checkAndAddColumn('T_RESOURCE_SETTLEMENT', 'CREATE_USER', 'VARCHAR(64) COMMENT "创建人"', 'CREATE_STAFF_ID');
    await checkAndAddColumn('T_RESOURCE_SETTLEMENT', 'CANCELLED_AT', 'DATETIME COMMENT "取消时间"', 'CREATE_USER');
    await checkAndAddColumn('T_RESOURCE_SETTLEMENT', 'CANCELLED_BY', 'BIGINT COMMENT "取消人员工ID"', 'CANCELLED_AT');
    await checkAndAddColumn('T_RESOURCE_SETTLEMENT', 'CANCELLED_BY_NAME', 'VARCHAR(64) COMMENT "取消人"', 'CANCELLED_BY');
    await checkAndAddColumn('T_RESOURCE_SETTLEMENT', 'REVERSED_AT', 'DATETIME COMMENT "冲销时间"', 'CANCELLED_BY_NAME');
    await checkAndAddColumn('T_RESOURCE_SETTLEMENT', 'REVERSED_BY', 'BIGINT COMMENT "冲销人员工ID"', 'REVERSED_AT');
    await checkAndAddColumn('T_RESOURCE_SETTLEMENT', 'REVERSED_BY_NAME', 'VARCHAR(64) COMMENT "冲销人"', 'REVERSED_BY');
    await checkAndAddColumn('T_RESOURCE_SETTLEMENT', 'CORRECTION_REASON', 'VARCHAR(512) COMMENT "取消或冲销原因"', 'REVERSED_BY_NAME');
    await checkAndAddColumn('T_RESOURCE_SETTLEMENT', 'UPDATE_TIME', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP', 'CREATE_TIME');
    await checkAndAddIndex('T_RESOURCE_SETTLEMENT', 'idx_resource_settlement_status', 'ALTER TABLE T_RESOURCE_SETTLEMENT ADD INDEX idx_resource_settlement_status (STATUS, CREATE_TIME)');
    await checkAndAddIndex('T_RESOURCE_SETTLEMENT', 'idx_resource_settlement_sn', 'ALTER TABLE T_RESOURCE_SETTLEMENT ADD INDEX idx_resource_settlement_sn (SN_ID, RESOURCE_TYPE)');
    await checkAndAddIndex('T_RESOURCE_SETTLEMENT', 'idx_resource_settlement_counterparty', 'ALTER TABLE T_RESOURCE_SETTLEMENT ADD INDEX idx_resource_settlement_counterparty (COUNTERPARTY_ID, CREATE_TIME)');
    await checkAndAddColumn('T_ORDER_ITEM', 'SELECTED_RESOURCE_TYPES', 'TEXT COMMENT "动态选择的资源类别JSON"', 'USE_SALES_REPORT');
    await checkAndAddColumn('T_ORDER', 'CREATE_STAFF_ID', 'BIGINT COMMENT "销售人员ID"', 'STORE_ID');
    await checkAndAddColumn('T_ORDER', 'OPERATOR_STAFF_ID', 'BIGINT COMMENT "销售经手人员工ID"');
    await checkAndAddColumn('T_ORDER', 'OPERATOR_NAME', 'VARCHAR(64) COMMENT "销售经手人姓名快照"');
    await checkAndAddColumn('T_ORDER', 'CREATE_USER', 'VARCHAR(64) COMMENT "销售订单制单人姓名快照"');
    await checkAndAddColumn('T_PURCHASE_REQUEST_ITEM', 'SELECTED_RESOURCE_TYPES', 'TEXT COMMENT "采购申请勾选的资源权益JSON"', 'STORE_ALLOCATIONS');
    await checkAndAddColumn('T_PURCHASE_REQUEST', 'PAYMENT_METHOD', 'VARCHAR(32) NOT NULL DEFAULT "COMPANY_CREDIT" COMMENT "COMPANY_CREDIT/PERSONAL_ADVANCE"', 'INVOICE_TYPE');
    await checkAndAddColumn('T_PURCHASE_REQUEST', 'OPERATOR_STAFF_ID', 'BIGINT COMMENT "采购经手人员工ID"');
    await checkAndAddColumn('T_PURCHASE_REQUEST', 'OPERATOR_NAME', 'VARCHAR(64) COMMENT "采购经手人姓名快照"');
    await checkAndAddColumn('T_PURCHASE_REQUEST', 'CREATE_STAFF_ID', 'BIGINT COMMENT "采购申请制单人员工ID"');
    await checkAndAddColumn('T_PURCHASE_REQUEST', 'CREATE_USER', 'VARCHAR(64) COMMENT "采购申请制单人姓名快照"');
    await checkAndAddColumn('T_PURCHASE_REQUEST_ITEM', 'PRODUCT_CODE', 'VARCHAR(64) COMMENT "商品编码快照"');
    await checkAndAddColumn('T_PURCHASE_REQUEST_ITEM', 'MANUFACTURER_CODE', 'VARCHAR(512) COMMENT "厂商编码快照"');
    await checkAndAddColumn('T_INBOUND_ITEM', 'SELECTED_RESOURCE_TYPES', 'TEXT COMMENT "继承采购申请的资源权益JSON"', 'STORE_ALLOCATIONS');
    await checkAndAddColumn('T_INBOUND_ITEM', 'PURCHASE_REQUEST_ITEM_ID', 'BIGINT COMMENT "来源采购申请明细ID"', 'SELECTED_RESOURCE_TYPES');
    await checkAndAddColumn('T_INVENTORY_RESOURCE_RIGHT', 'RULE_CONFIG_ID', 'VARCHAR(32) COMMENT "权益规则配置ID"', 'RESOURCE_TYPE');
    await checkAndAddColumn('T_INVENTORY_RESOURCE_RIGHT', 'SOURCE_REQUEST_ID', 'VARCHAR(32) COMMENT "来源采购申请ID"', 'RULE_CONFIG_ID');
    await checkAndAddColumn('T_INVENTORY_RESOURCE_RIGHT', 'SOURCE_REQUEST_ITEM_ID', 'BIGINT COMMENT "来源采购申请明细ID"', 'SOURCE_REQUEST_ID');
    await checkAndAddColumn('T_INVENTORY_RESOURCE_RIGHT', 'SOURCE_INBOUND_ID', 'VARCHAR(32) COMMENT "来源入库单ID"', 'SOURCE_REQUEST_ITEM_ID');
    await checkAndAddColumn('T_INVENTORY_RESOURCE_RIGHT', 'SUPPLIER_ID', 'VARCHAR(32) COMMENT "来源供应商ID"', 'SOURCE_INBOUND_ID');
    await checkAndAddColumn('T_INVENTORY_RESOURCE_RIGHT', 'SUPPLIER_NAME', 'VARCHAR(255) COMMENT "来源供应商名称"', 'SUPPLIER_ID');
    await checkAndAddColumn('T_RESOURCE_CATEGORY', 'RESOURCE_KIND', 'VARCHAR(32) DEFAULT "SALE_USE" COMMENT "SALE_USE/INTERNAL_MARKER/PO_REWARD/CARE_CREDIT/REBATE/OTHER"', 'SHORT_NAME');
    await checkAndAddColumn('T_RESOURCE_CATEGORY', 'SUPPORTS_PURCHASE_SELECT', 'TINYINT(1) DEFAULT 1 COMMENT "采购申请是否可勾选"', 'DEFAULT_ACCOUNT_ID');
    await checkAndAddColumn('T_RESOURCE_CATEGORY', 'TRIGGER_ON_SALE', 'TINYINT(1) DEFAULT 0 COMMENT "销售归档是否触发"', 'SUPPORTS_COMPANY_CLAIM');
    await checkAndAddColumn('T_RESOURCE_CATEGORY', 'GENERATES_SETTLEMENT', 'TINYINT(1) DEFAULT 1 COMMENT "是否生成待下账"', 'TRIGGER_ON_SALE');
    await checkAndAddColumn('T_RESOURCE_CATEGORY', 'GENERATES_STAFF_CARE_CREDIT', 'TINYINT(1) DEFAULT 0 COMMENT "是否生成销售个人Care可用金"', 'GENERATES_SETTLEMENT');
    await checkAndAddColumn('T_RESOURCE_CATEGORY', 'AFFECTS_PERFORMANCE_PROFIT', 'TINYINT(1) DEFAULT 0 COMMENT "是否影响员工业绩毛利"', 'GENERATES_STAFF_CARE_CREDIT');
    await checkAndAddColumn('T_RESOURCE_CATEGORY', 'PERFORMANCE_PROFIT_RATIO', 'DECIMAL(8,4) DEFAULT 100 COMMENT "计入员工业绩毛利比例"', 'AFFECTS_PERFORMANCE_PROFIT');
    await checkAndAddColumn('T_RESOURCE_CATEGORY', 'RULE_CONFIG_JSON', 'TEXT COMMENT "扩展规则JSON"', 'PERFORMANCE_PROFIT_RATIO');
    await checkAndAddColumn('T_PRODUCT_RESOURCE_COST_CONFIG', 'SUPPLIER_ID', 'VARCHAR(32) COMMENT "适用供应商ID"', 'RESOURCE_TYPE');
    await checkAndAddColumn('T_PRODUCT_RESOURCE_COST_CONFIG', 'SUPPLIER_NAME', 'VARCHAR(255) COMMENT "适用供应商名称"', 'SUPPLIER_ID');
    await checkAndAddColumn('T_PRODUCT_RESOURCE_COST_CONFIG', 'CALCULATION_TYPE', 'VARCHAR(32) DEFAULT "fixed_amount" COMMENT "fixed_amount/percentage_inventory_cost/percentage_sale_amount"', 'COST_AMOUNT');
    await checkAndAddColumn('T_PRODUCT_RESOURCE_COST_CONFIG', 'CALCULATION_VALUE', 'DECIMAL(12,4) DEFAULT 0 COMMENT "算法值"', 'CALCULATION_TYPE');
    await checkAndAddColumn('T_PRODUCT_RESOURCE_COST_CONFIG', 'EFFECTIVE_START', 'DATETIME COMMENT "生效开始时间"', 'CALCULATION_VALUE');
    await checkAndAddColumn('T_PRODUCT_RESOURCE_COST_CONFIG', 'EFFECTIVE_END', 'DATETIME COMMENT "生效结束时间"', 'EFFECTIVE_START');
    await checkAndAddColumn('T_PRODUCT_RESOURCE_COST_CONFIG', 'TRIGGER_CONDITION', 'VARCHAR(64) DEFAULT "sale_archived" COMMENT "触发条件"', 'EFFECTIVE_END');
    await checkAndAddColumn('T_PRODUCT_RESOURCE_COST_CONFIG', 'AFFECTS_PERFORMANCE_PROFIT', 'TINYINT(1) DEFAULT 0 COMMENT "是否影响员工业绩毛利"', 'TRIGGER_CONDITION');
    await checkAndAddColumn('T_PRODUCT_RESOURCE_COST_CONFIG', 'PERFORMANCE_PROFIT_RATIO', 'DECIMAL(8,4) DEFAULT 100 COMMENT "计入比例"', 'AFFECTS_PERFORMANCE_PROFIT');
    await checkAndAddColumn('T_PRODUCT_RESOURCE_COST_CONFIG', 'RULE_CONFIG_JSON', 'TEXT COMMENT "扩展规则JSON"', 'PERFORMANCE_PROFIT_RATIO');
    await normalizeProductResourceCostConfigIndex();
    await checkAndCreateTable('T_STAFF_CARE_CREDIT_TRANSACTION', `
      CREATE TABLE T_STAFF_CARE_CREDIT_TRANSACTION (
        TRANSACTION_ID VARCHAR(32) NOT NULL,
        STAFF_ID BIGINT,
        STAFF_NAME VARCHAR(64) NOT NULL,
        TYPE VARCHAR(32) NOT NULL DEFAULT 'income',
        AMOUNT DECIMAL(12,2) NOT NULL,
        BALANCE_AFTER DECIMAL(12,2) DEFAULT 0,
        SOURCE_TYPE VARCHAR(32) NOT NULL,
        SOURCE_ID VARCHAR(64) NOT NULL,
        ORDER_ID VARCHAR(32), ORDER_NO VARCHAR(64), ORDER_ITEM_ID BIGINT,
        SN_ID VARCHAR(32), SN_CODE VARCHAR(128), PRODUCT_ID VARCHAR(32), RESOURCE_TYPE VARCHAR(32),
        STATUS VARCHAR(32) DEFAULT 'active',
        REMARK VARCHAR(512),
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (TRANSACTION_ID),
        UNIQUE KEY uk_staff_care_source (SOURCE_TYPE, SOURCE_ID),
        KEY idx_staff_care_staff (STAFF_NAME, CREATE_TIME),
        KEY idx_staff_care_sn (SN_ID, RESOURCE_TYPE)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='销售个人Care可用金流水'
    `);
    await sequelize.query(`
      INSERT IGNORE INTO T_RESOURCE_CATEGORY
        (CATEGORY_ID, CATEGORY_CODE, NAME, SHORT_NAME, SUPPORTS_SALE_USE, SUPPORTS_COMPANY_CLAIM, SORT_ORDER, STATUS)
      VALUES
        ('RC_GOV_SUBSIDY', 'GOV_SUBSIDY', '国补资格', '国补', 1, 1, 10, 1),
        ('RC_EDU_SUBSIDY', 'EDU_SUBSIDY', '教育补贴资格', '教育补贴', 1, 1, 20, 1),
        ('RC_SALES_REPORT', 'SALES_REPORT', '销量报号资格', '销量报号', 1, 1, 30, 1),
        ('RC_MANUFACTURER_REBATE', 'MANUFACTURER_REBATE', '厂商返利', '厂商返利', 0, 0, 40, 1),
        ('RC_MANUAL_REBATE', 'MANUAL_REBATE', '手工返利', '手工返利', 0, 0, 45, 1)
    `);
    await sequelize.query(`
      UPDATE T_RESOURCE_CATEGORY
      SET RESOURCE_KIND = 'REBATE',
          SUPPORTS_PURCHASE_SELECT = 0,
          SUPPORTS_SALE_USE = 0,
          SUPPORTS_COMPANY_CLAIM = 0,
          TRIGGER_ON_SALE = 0,
          GENERATES_SETTLEMENT = 1
      WHERE CATEGORY_CODE IN ('MANUFACTURER_REBATE', 'MANUAL_REBATE')
    `);
    await sequelize.query(`
      INSERT IGNORE INTO T_RESOURCE_CATEGORY
        (CATEGORY_ID, CATEGORY_CODE, NAME, SHORT_NAME, RESOURCE_KIND, SUPPORTS_PURCHASE_SELECT,
         SUPPORTS_SALE_USE, SUPPORTS_COMPANY_CLAIM, TRIGGER_ON_SALE, GENERATES_SETTLEMENT,
         GENERATES_STAFF_CARE_CREDIT, AFFECTS_PERFORMANCE_PROFIT, SORT_ORDER, STATUS)
      VALUES
        ('RC_SALES_BONUS', 'SALES_BONUS', '销售红包', '销售红包', 'PO_REWARD', 1, 0, 0, 1, 1, 0, 1, 50, 1),
        ('RC_SELF_PURCHASE_REPORT', 'SELF_PURCHASE_REPORT', '报号自购', '报号自购', 'INTERNAL_MARKER', 1, 1, 0, 0, 0, 0, 0, 60, 1)
    `);
    await sequelize.query(`
      INSERT IGNORE INTO T_GOODS_TYPE
        (GOODS_TYPE_ID, NAME, SORT_ORDER, STATUS, REMARK)
      VALUES
        ('GT_SERVICE_FULL_RESOURCE', '服务商全资源货', 10, 1, '系统初始化的全资源货型模板')
    `);
    if (goodsTypeResourceTableCreated) {
      await sequelize.query(`
        INSERT IGNORE INTO T_GOODS_TYPE_RESOURCE (GOODS_TYPE_ID, CATEGORY_ID, SORT_ORDER)
        SELECT 'GT_SERVICE_FULL_RESOURCE', CATEGORY_ID,
          CASE CATEGORY_CODE
            WHEN 'GOV_SUBSIDY' THEN 10
            WHEN 'EDU_SUBSIDY' THEN 20
            WHEN 'MANUFACTURER_REBATE' THEN 30
            WHEN 'SALES_BONUS' THEN 40
            WHEN 'SELF_PURCHASE_REPORT' THEN 50
            ELSE 99
          END
        FROM T_RESOURCE_CATEGORY
        WHERE CATEGORY_CODE IN ('GOV_SUBSIDY', 'EDU_SUBSIDY', 'MANUFACTURER_REBATE', 'SALES_BONUS', 'SELF_PURCHASE_REPORT')
      `);
    }
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
    await checkAndAddColumn('T_PURCHASE_REQUEST', 'SUPPLIER_CHAT_SCREENSHOT_IDS', 'TEXT COMMENT "供应商群喊货截图云文件ID"', 'INVOICE_TYPE');
    await checkAndAddColumn('T_PURCHASE_REQUEST', 'SUPPLIER_CHAT_SCREENSHOT_URLS', 'TEXT COMMENT "供应商群喊货截图展示地址"', 'SUPPLIER_CHAT_SCREENSHOT_IDS');
    await checkAndAddColumn('T_PURCHASE_REQUEST_ITEM', 'STORE_ALLOCATIONS', 'TEXT COMMENT "门店分配"', 'QUANTITY');
    await checkAndAddColumn('T_INBOUND', 'PURCHASE_REQUEST_ID', 'VARCHAR(32) COMMENT "采购申请ID"', 'INBOUND_NO');
    await checkAndAddColumn('T_INBOUND', 'RECEIVE_USER', 'VARCHAR(64) COMMENT "最近一次入库人"', 'CREATE_USER');
    await checkAndAddColumn('T_INBOUND', 'RECEIVE_TIME', 'DATETIME COMMENT "最近一次入库时间"', 'RECEIVE_USER');
    await checkAndAddColumn('T_INBOUND_ITEM', 'REMARK', 'VARCHAR(512) COMMENT "备注"', 'UNIT_PRICE');
    await checkAndAddColumn('T_INBOUND_ITEM', 'STORE_ALLOCATIONS', 'TEXT COMMENT "门店分配"', 'REMARK');
    await checkAndAddColumn('T_INBOUND_ITEM', 'LOCATION_ID', 'VARCHAR(32) COMMENT "库位ID"', 'STORE_ALLOCATIONS');
    await checkAndAddColumn('T_INBOUND_ITEM', 'INVENTORY_TYPE', 'VARCHAR(32) DEFAULT "normal_qty" COMMENT "入库库存类型"', 'LOCATION_ID');
    await checkAndAddColumn('T_INVENTORY', 'UPDATE_TIME', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT "更新时间"', 'PENDING_QTY');
    await checkAndAddColumn('T_INVENTORY', 'RENTAL_DEMO_QTY', 'INT DEFAULT 0 COMMENT "租赁样机仓库存"', 'PENDING_QTY');
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
    await checkAndAddColumn('T_RETURN_STOCK', 'DISTRIBUTOR_ID', 'VARCHAR(32) COMMENT "退库所属经销商快照"', 'PURCHASE_REQUEST_ID');
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
    await checkAndAddColumn('T_RETURN_STOCK_ITEM', 'INBOUND_ITEM_ID', 'BIGINT(20) COMMENT "来源入库明细ID"', 'RETURN_ID');
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

    await checkAndCreateTable('T_PURCHASE_ADJUSTMENT', `
      CREATE TABLE T_PURCHASE_ADJUSTMENT (
        ADJUSTMENT_ID VARCHAR(32) NOT NULL COMMENT '采购调整单ID',
        ADJUSTMENT_NO VARCHAR(64) NOT NULL COMMENT '采购调整单号',
        REQUEST_ID VARCHAR(32) NOT NULL COMMENT '原采购申请ID',
        REQUEST_NO VARCHAR(64) COMMENT '原采购申请单号',
        STORE_ID VARCHAR(32) COMMENT '申请门店ID',
        SUPPLIER_ID VARCHAR(32) COMMENT '供应商ID',
        SUPPLIER_NAME VARCHAR(255) COMMENT '供应商名称快照',
        TOTAL_QUANTITY_DELTA INT DEFAULT 0 COMMENT '数量变化合计',
        TOTAL_AMOUNT_DELTA DECIMAL(12,2) DEFAULT 0 COMMENT '应付金额变化合计',
        REASON VARCHAR(512) COMMENT '调整原因',
        STATUS VARCHAR(32) DEFAULT 'completed' COMMENT '状态:completed/cancelled',
        CREATE_USER VARCHAR(64) COMMENT '操作人',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '操作时间',
        PRIMARY KEY (ADJUSTMENT_ID),
        UNIQUE KEY uk_purchase_adjustment_no (ADJUSTMENT_NO),
        KEY idx_purchase_adjustment_request (REQUEST_ID),
        KEY idx_purchase_adjustment_supplier (SUPPLIER_ID),
        KEY idx_purchase_adjustment_create_time (CREATE_TIME)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='采购退单/采购数量调整单'
    `);

    await checkAndCreateTable('T_PURCHASE_ADJUSTMENT_ITEM', `
      CREATE TABLE T_PURCHASE_ADJUSTMENT_ITEM (
        ITEM_ID BIGINT(20) NOT NULL AUTO_INCREMENT COMMENT '明细ID',
        ADJUSTMENT_ID VARCHAR(32) NOT NULL COMMENT '采购调整单ID',
        REQUEST_ITEM_ID BIGINT(20) NOT NULL COMMENT '原采购明细ID',
        INBOUND_ID VARCHAR(32) COMMENT '关联待入库单ID',
        INBOUND_ITEM_ID BIGINT(20) COMMENT '关联待入库明细ID',
        STORE_ID VARCHAR(32) COMMENT '门店ID',
        PRODUCT_ID VARCHAR(32) NOT NULL COMMENT '商品ID',
        PRODUCT_NAME VARCHAR(255) COMMENT '商品名称快照',
        UNIT_PRICE DECIMAL(12,2) DEFAULT 0 COMMENT '采购单价',
        ORIGINAL_QUANTITY INT DEFAULT 0 COMMENT '原采购数量',
        RECEIVED_QUANTITY INT DEFAULT 0 COMMENT '已入库数量',
        PENDING_QUANTITY_BEFORE INT DEFAULT 0 COMMENT '调整前待入库数量',
        TARGET_QUANTITY INT DEFAULT 0 COMMENT '调整后待入库数量',
        QUANTITY_DELTA INT DEFAULT 0 COMMENT '本次数量变化',
        AMOUNT_DELTA DECIMAL(12,2) DEFAULT 0 COMMENT '本次金额变化',
        REMARK VARCHAR(512) COMMENT '明细备注',
        PRIMARY KEY (ITEM_ID),
        KEY idx_purchase_adjustment_item_adjustment (ADJUSTMENT_ID),
        KEY idx_purchase_adjustment_item_request (REQUEST_ITEM_ID),
        KEY idx_purchase_adjustment_item_inbound (INBOUND_ID),
        KEY idx_purchase_adjustment_item_inbound_item (INBOUND_ITEM_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='采购退单/采购数量调整明细'
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
    await checkAndAddColumn('T_EXPENSE', 'REGION_ID', 'VARCHAR(32) COMMENT "区域ID"', 'STORE_ID');
    await checkAndAddColumn('T_EXPENSE', 'REGION_NAME', 'VARCHAR(128) COMMENT "区域名称快照"', 'REGION_ID');
    await checkAndAddColumn('T_EXPENSE', 'EXPENSE_TYPE_ID', 'VARCHAR(32) COMMENT "报销类型ID"', 'REGION_NAME');
    await checkAndAddColumn('T_EXPENSE', 'EXPENSE_PARTY', 'VARCHAR(255) NOT NULL DEFAULT "" COMMENT "费用发生方"', 'EXPENSE_TYPE');
    await checkAndAddColumn('T_EXPENSE', 'HAS_INVOICE', 'TINYINT(1) DEFAULT 0 COMMENT "是否有发票"', 'PAYMENT_METHOD');
    await checkAndAddColumn('T_EXPENSE', 'INVOICE_TYPE', 'VARCHAR(64) COMMENT "发票类型"', 'HAS_INVOICE');
    await checkAndAddColumn('T_EXPENSE', 'INVOICE_NO', 'VARCHAR(128) COMMENT "发票号码"', 'INVOICE_TYPE');
    await checkAndAddColumn('T_EXPENSE', 'EXPENSE_DATE', 'DATE COMMENT "费用发生日期"', 'INVOICE_NO');
    await checkAndAddColumn('T_EXPENSE', 'ATTACHMENT_URLS', 'LONGTEXT COMMENT "凭证附件JSON"', 'EXPENSE_DATE');
    await checkAndAddColumn('T_EXPENSE', 'APPLICANT_STAFF_ID', 'BIGINT COMMENT "申请人员工ID"', 'STATUS');
    await checkAndAddColumn('T_EXPENSE', 'APPLICANT_NAME', 'VARCHAR(64) COMMENT "申请人姓名"', 'APPLICANT_STAFF_ID');
    await checkAndAddColumn('T_EXPENSE', 'OPERATOR_STAFF_ID', 'BIGINT COMMENT "费用经手人员工ID"');
    await checkAndAddColumn('T_EXPENSE', 'OPERATOR_NAME', 'VARCHAR(64) COMMENT "费用经手人姓名快照"');
    await checkAndAddColumn('T_EXPENSE', 'REVIEW_STAFF_ID', 'BIGINT COMMENT "审批人员工ID"', 'APPLICANT_NAME');
    await checkAndAddColumn('T_EXPENSE', 'REVIEW_USER_NAME', 'VARCHAR(64) COMMENT "审批人姓名"', 'REVIEW_STAFF_ID');
    await checkAndAddColumn('T_EXPENSE', 'REVIEW_COMMENT', 'VARCHAR(512) COMMENT "审批意见"', 'REVIEW_USER_NAME');
    await checkAndAddColumn('T_EXPENSE', 'REVIEW_TIME', 'DATETIME COMMENT "审批时间"', 'REVIEW_COMMENT');
    await checkAndAddColumn('T_EXPENSE', 'SOURCE_TYPE', 'VARCHAR(32) DEFAULT "expense" COMMENT "expense/purchase"', 'REVIEW_TIME');
    await checkAndAddColumn('T_EXPENSE', 'SOURCE_ID', 'VARCHAR(64) COMMENT "来源业务ID"', 'SOURCE_TYPE');
    await checkAndAddColumn('T_EXPENSE', 'SOURCE_NO', 'VARCHAR(64) COMMENT "来源业务单号"', 'SOURCE_ID');
    await checkAndAddColumn('T_EXPENSE', 'PAYABLE_ID', 'VARCHAR(32) COMMENT "关联应付款ID"', 'SOURCE_NO');
    await checkAndAddColumn('T_EXPENSE', 'SETTLEMENT_ID', 'VARCHAR(32) COMMENT "关联报销结算单ID"', 'PAYABLE_ID');
    await checkAndAddIndex('T_EXPENSE', 'uk_expense_source', 'ALTER TABLE T_EXPENSE ADD UNIQUE KEY uk_expense_source (SOURCE_TYPE, SOURCE_ID)');
    await checkAndAddIndex('T_EXPENSE', 'idx_expense_approval', 'ALTER TABLE T_EXPENSE ADD INDEX idx_expense_approval (STATUS, CREATE_TIME)');

    await checkAndCreateTable('T_EXPENSE_TYPE', `
      CREATE TABLE T_EXPENSE_TYPE (
        TYPE_ID VARCHAR(32) NOT NULL,
        NAME VARCHAR(128) NOT NULL,
        SORT_ORDER INT DEFAULT 0,
        STATUS TINYINT(1) DEFAULT 1,
        REMARK VARCHAR(512),
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UPDATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (TYPE_ID),
        UNIQUE KEY uk_expense_type_name (NAME),
        KEY idx_expense_type_status (STATUS, SORT_ORDER)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='报销类型字典'
    `);

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
    await checkAndMakeColumnNullable('T_PAYABLE', 'SUPPLIER_ID', 'VARCHAR(32)');
    await checkAndMakeColumnNullable('T_PAYABLE', 'REQUEST_ID', 'VARCHAR(32)');
    await checkAndAddColumn('T_PAYABLE', 'PAYEE_TYPE', 'VARCHAR(32) DEFAULT "supplier" COMMENT "supplier/counterparty/employee"', 'REQUEST_NO');
    await checkAndAddColumn('T_PAYABLE', 'PAYEE_ID', 'VARCHAR(64) COMMENT "收款方ID"', 'PAYEE_TYPE');
    await checkAndAddColumn('T_PAYABLE', 'PAYEE_NAME', 'VARCHAR(255) COMMENT "收款方名称"', 'PAYEE_ID');
    await checkAndAddColumn('T_PAYABLE', 'SOURCE_TYPE', 'VARCHAR(32) DEFAULT "purchase" COMMENT "purchase/expense/reimbursement"', 'PAYEE_NAME');
    await checkAndAddColumn('T_PAYABLE', 'SOURCE_ID', 'VARCHAR(64) COMMENT "来源ID"', 'SOURCE_TYPE');
    await checkAndAddColumn('T_PAYABLE', 'SOURCE_NO', 'VARCHAR(64) COMMENT "来源单号"', 'SOURCE_ID');
    await checkAndAddIndex('T_PAYABLE', 'uk_payable_source', 'ALTER TABLE T_PAYABLE ADD UNIQUE KEY uk_payable_source (SOURCE_TYPE, SOURCE_ID)');

    await checkAndCreateTable('T_SETTLEMENT', `
      CREATE TABLE T_SETTLEMENT (
        SETTLEMENT_ID VARCHAR(32) NOT NULL COMMENT '结算单ID',
        SETTLEMENT_NO VARCHAR(64) NOT NULL COMMENT '结算单号',
        SUPPLIER_ID VARCHAR(32) NOT NULL COMMENT '供应商ID',
        SUPPLIER_NAME VARCHAR(255) COMMENT '供应商名称',
        TOTAL_AMOUNT DECIMAL(12,2) NOT NULL COMMENT '结算金额',
        PAID_AMOUNT DECIMAL(12,2) DEFAULT 0 COMMENT '已付金额',
        STATUS VARCHAR(32) DEFAULT 'draft' COMMENT '结算单状态:draft/pending_approval/confirmed/voided',
        PAYMENT_STATUS VARCHAR(32) DEFAULT 'unpaid' COMMENT '付款状态:unpaid/partial_paid/paid',
        REMARK VARCHAR(512) COMMENT '结算备注',
        CREATE_USER VARCHAR(64) COMMENT '制单人',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        SUBMIT_TIME TIMESTAMP NULL COMMENT '提交时间',
        CONFIRMED_TIME TIMESTAMP NULL COMMENT '确认时间',
        APPROVAL_USER VARCHAR(64) COMMENT '审批人',
        APPROVAL_TIME TIMESTAMP NULL COMMENT '审批时间',
        APPROVAL_COMMENT VARCHAR(512) COMMENT '审批意见',
        VOIDED_TIME TIMESTAMP NULL COMMENT '作废时间',
        PAID_TIME TIMESTAMP NULL COMMENT '付款时间',
        PRIMARY KEY (SETTLEMENT_ID),
        UNIQUE KEY uni_settlement_no (SETTLEMENT_NO),
        KEY idx_settlement_supplier (SUPPLIER_ID),
        KEY idx_settlement_status (STATUS)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='结算单表'
    `);
    await checkAndMakeColumnNullable('T_SETTLEMENT', 'SUPPLIER_ID', 'VARCHAR(32)');
    await checkAndAddColumn('T_SETTLEMENT', 'IS_DELETED', 'TINYINT(1) DEFAULT 0 COMMENT "软删除标记"', 'STATUS');
    await checkAndAddColumn('T_SETTLEMENT', 'SETTLEMENT_TYPE', 'VARCHAR(32) DEFAULT "supplier" COMMENT "supplier/expense/reimbursement"', 'SUPPLIER_NAME');
    await checkAndAddColumn('T_SETTLEMENT', 'PAYEE_TYPE', 'VARCHAR(32) DEFAULT "supplier" COMMENT "supplier/counterparty/employee"', 'SETTLEMENT_TYPE');
    await checkAndAddColumn('T_SETTLEMENT', 'PAYEE_ID', 'VARCHAR(64) COMMENT "收款方ID"', 'PAYEE_TYPE');
    await checkAndAddColumn('T_SETTLEMENT', 'PAYEE_NAME', 'VARCHAR(255) COMMENT "收款方名称"', 'PAYEE_ID');
    await checkAndAddColumn('T_SETTLEMENT', 'SOURCE_TYPE', 'VARCHAR(32) COMMENT "来源类型"', 'PAYEE_NAME');
    await checkAndAddColumn('T_SETTLEMENT', 'SOURCE_ID', 'VARCHAR(64) COMMENT "来源ID"', 'SOURCE_TYPE');
    await checkAndAddColumn('T_SETTLEMENT', 'SOURCE_NO', 'VARCHAR(64) COMMENT "来源单号"', 'SOURCE_ID');
    await checkAndAddColumn('T_SETTLEMENT', 'TAX_STATUS', 'VARCHAR(32) DEFAULT "UNKNOWN" COMMENT "税务属性快照:TAX_INCLUDED/UNTAXED/UNKNOWN"', 'SOURCE_NO');
    try {
      await sequelize.query(`
        UPDATE T_SETTLEMENT s
        LEFT JOIN (
          SELECT si.SETTLEMENT_ID,
            CASE
              WHEN SUM(CASE WHEN COALESCE(pr.INVOICE_TYPE, e.INVOICE_TYPE, '') LIKE '%未税%' OR LOWER(COALESCE(pr.INVOICE_TYPE, e.INVOICE_TYPE, '')) LIKE '%untaxed%' THEN 1 ELSE 0 END) > 0
               AND SUM(CASE WHEN COALESCE(pr.INVOICE_TYPE, e.INVOICE_TYPE, '') LIKE '%含税%' OR COALESCE(pr.INVOICE_TYPE, e.INVOICE_TYPE, '') LIKE '%增专票%' OR LOWER(COALESCE(pr.INVOICE_TYPE, e.INVOICE_TYPE, '')) LIKE '%tax_included%' THEN 1 ELSE 0 END) > 0
                THEN 'MIXED'
              WHEN SUM(CASE WHEN COALESCE(pr.INVOICE_TYPE, e.INVOICE_TYPE, '') LIKE '%未税%' OR LOWER(COALESCE(pr.INVOICE_TYPE, e.INVOICE_TYPE, '')) LIKE '%untaxed%' THEN 1 ELSE 0 END) > 0
                THEN 'UNTAXED'
              WHEN SUM(CASE WHEN COALESCE(pr.INVOICE_TYPE, e.INVOICE_TYPE, '') LIKE '%含税%' OR COALESCE(pr.INVOICE_TYPE, e.INVOICE_TYPE, '') LIKE '%增专票%' OR LOWER(COALESCE(pr.INVOICE_TYPE, e.INVOICE_TYPE, '')) LIKE '%tax_included%' THEN 1 ELSE 0 END) > 0
                THEN 'TAX_INCLUDED'
              ELSE 'UNKNOWN'
            END AS TAX_STATUS
          FROM T_SETTLEMENT_ITEM si
          INNER JOIN T_PAYABLE p ON p.PAYABLE_ID = si.PAYABLE_ID
          LEFT JOIN T_PURCHASE_REQUEST pr ON pr.REQUEST_ID = p.REQUEST_ID
          LEFT JOIN T_EXPENSE e ON e.EXPENSE_ID = p.SOURCE_ID AND p.SOURCE_TYPE IN ('expense', 'reimbursement')
          GROUP BY si.SETTLEMENT_ID
        ) tax ON tax.SETTLEMENT_ID = s.SETTLEMENT_ID
        SET s.TAX_STATUS = COALESCE(tax.TAX_STATUS, 'UNKNOWN')
        WHERE s.TAX_STATUS IS NULL OR s.TAX_STATUS = 'UNKNOWN'
      `);
    } catch (error) {
      console.warn('[DB Migration] 应付结算单税务属性回填跳过:', error.message);
    }
    await checkAndAddIndex('T_SETTLEMENT', 'idx_settlement_type', 'ALTER TABLE T_SETTLEMENT ADD INDEX idx_settlement_type (SETTLEMENT_TYPE, STATUS, CREATE_TIME)');
    await checkAndAddColumn('T_SETTLEMENT', 'SUPPLIER_ACCOUNT_ID', 'VARCHAR(32) COMMENT "供应商付款账户ID"', 'SUPPLIER_NAME');
    await checkAndAddColumn('T_SETTLEMENT', 'SUPPLIER_ACCOUNT_SNAPSHOT', 'TEXT COMMENT "供应商付款账户快照"', 'SUPPLIER_ACCOUNT_ID');
    await checkAndAddColumn('T_SETTLEMENT', 'OTHER_PAYMENT_REMARK', 'TEXT COMMENT "其他付款说明"', 'SUPPLIER_ACCOUNT_SNAPSHOT');
    await checkAndAddColumn('T_SETTLEMENT', 'OTHER_PAYMENT_IMAGE', 'LONGTEXT COMMENT "其他付款图片"', 'OTHER_PAYMENT_REMARK');
    await checkAndAddColumn('T_SETTLEMENT', 'REMARK', 'TEXT COMMENT "结算单备注"');
    await checkAndAddColumn('T_SETTLEMENT', 'CREATE_STAFF_ID', 'BIGINT COMMENT "结算单制单人员工ID"');
    await checkAndAddColumn('T_SETTLEMENT', 'OPERATOR_STAFF_ID', 'BIGINT COMMENT "结算单经手人员工ID"');
    await checkAndAddColumn('T_SETTLEMENT', 'OPERATOR_NAME', 'VARCHAR(64) COMMENT "结算单经手人姓名快照"');
    await checkAndAddColumn('T_SETTLEMENT', 'PAID_AMOUNT', 'DECIMAL(12,2) DEFAULT 0 COMMENT "已付金额"', 'TOTAL_AMOUNT');
    await checkAndAddColumn('T_SETTLEMENT', 'PAYMENT_STATUS', 'VARCHAR(32) DEFAULT "unpaid" COMMENT "付款状态:unpaid/partial_paid/paid"', 'STATUS');
    await checkAndAddColumn('T_SETTLEMENT', 'SUBMIT_TIME', 'TIMESTAMP NULL COMMENT "提交时间"', 'CREATE_TIME');
    await checkAndAddColumn('T_SETTLEMENT', 'CONFIRMED_TIME', 'TIMESTAMP NULL COMMENT "确认时间"', 'CREATE_TIME');
    await checkAndAddColumn('T_SETTLEMENT', 'APPROVAL_USER', 'VARCHAR(64) COMMENT "审批人"', 'CONFIRMED_TIME');
    await checkAndAddColumn('T_SETTLEMENT', 'APPROVAL_TIME', 'TIMESTAMP NULL COMMENT "审批时间"', 'APPROVAL_USER');
    await checkAndAddColumn('T_SETTLEMENT', 'APPROVAL_COMMENT', 'VARCHAR(512) COMMENT "审批意见"', 'APPROVAL_TIME');
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

    // Partial settlement allocation fields. They are added after the base tables so
    // upgrades remain safe for installations created by older versions.
    await checkAndAddColumn('T_EXPENSE', 'SETTLED_AMOUNT', 'DECIMAL(12,2) DEFAULT 0', 'AMOUNT');
    await checkAndAddColumn('T_PAYABLE', 'SETTLED_AMOUNT', 'DECIMAL(12,2) DEFAULT 0', 'TOTAL_AMOUNT');
    await checkAndAddColumn('T_PAYABLE', 'OFFSET_AMOUNT', 'DECIMAL(12,2) DEFAULT 0 COMMENT "已抵扣金额"', 'SETTLED_AMOUNT');
    await checkAndAddColumn('T_PAYABLE', 'OFFSET_PAYABLE_ID', 'VARCHAR(32) COMMENT "关联冲抵应付款ID"', 'OFFSET_AMOUNT');
    await checkAndAddColumn('T_SETTLEMENT_ITEM', 'REQUEST_ITEM_ID', 'BIGINT(20)', 'PAYABLE_ID');
    await checkAndAddColumn('T_SETTLEMENT_ITEM', 'PRODUCT_ID', 'VARCHAR(32)', 'REQUEST_ITEM_ID');
    await checkAndAddColumn('T_SETTLEMENT_ITEM', 'PRODUCT_NAME', 'VARCHAR(255)', 'PRODUCT_ID');
    await checkAndAddColumn('T_SETTLEMENT_ITEM', 'QUANTITY', 'DECIMAL(12,4)', 'PRODUCT_NAME');
    await checkAndAddColumn('T_SETTLEMENT_ITEM', 'UNIT_PRICE', 'DECIMAL(12,4)', 'QUANTITY');

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
    await checkAndAddColumn('T_SUPPLIER_REBATE', 'STATUS', 'VARCHAR(32) DEFAULT "active" COMMENT "active/reversed"', 'REMARK');
    await checkAndAddColumn('T_SUPPLIER_REBATE', 'SOURCE_TYPE', 'VARCHAR(32) DEFAULT "manual" COMMENT "manual/resource_settlement/purchase"', 'STATUS');
    await checkAndAddColumn('T_SUPPLIER_REBATE', 'SOURCE_ID', 'VARCHAR(64) COMMENT "来源ID"', 'SOURCE_TYPE');
    await checkAndAddColumn('T_SUPPLIER_REBATE', 'REVERSAL_OF', 'VARCHAR(32) COMMENT "被冲销返利ID"', 'SOURCE_ID');

    await checkAndCreateTable('T_REBATE_POSTING_ORDER', `
      CREATE TABLE T_REBATE_POSTING_ORDER (
        POSTING_ID VARCHAR(32) NOT NULL COMMENT '返利上账单ID',
        POSTING_NO VARCHAR(64) NOT NULL COMMENT '返利上账单号',
        SUPPLIER_ID VARCHAR(32) COMMENT '供应商ID',
        SUPPLIER_NAME VARCHAR(255) COMMENT '供应商名称快照',
        SETTLEMENT_TYPE VARCHAR(32) DEFAULT 'supplier' COMMENT 'supplier/expense/reimbursement',
        PAYEE_TYPE VARCHAR(32) DEFAULT 'supplier' COMMENT 'supplier/employee/counterparty',
        PAYEE_ID VARCHAR(64) COMMENT '收款对象ID',
        PAYEE_NAME VARCHAR(255) COMMENT '收款对象名称',
        SOURCE_TYPE VARCHAR(32) COMMENT '来源类型',
        SOURCE_ID VARCHAR(64) COMMENT '来源ID',
        SOURCE_NO VARCHAR(64) COMMENT '来源单号',
        POSTING_DATE DATE NOT NULL COMMENT '上账日期',
        AMOUNT DECIMAL(12,2) NOT NULL COMMENT '上账金额',
        MATCHED_AMOUNT DECIMAL(12,2) DEFAULT 0 COMMENT '已核销金额',
        STATUS VARCHAR(32) DEFAULT 'UNMATCHED' COMMENT 'UNMATCHED/PARTIALLY_MATCHED/MATCHED/REVERSED',
        REBATE_ID VARCHAR(32) COMMENT '供应商返利上账流水ID',
        CREATE_STAFF_ID BIGINT COMMENT '创建人员工ID',
        CREATE_USER VARCHAR(64) COMMENT '创建人',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        REVERSED_AT DATETIME COMMENT '冲销时间',
        REVERSED_BY BIGINT COMMENT '冲销人员工ID',
        REVERSED_BY_NAME VARCHAR(64) COMMENT '冲销人',
        REVERSAL_REASON VARCHAR(512) COMMENT '冲销原因',
        REMARK VARCHAR(512) NOT NULL COMMENT '活动或返利事项',
        PRIMARY KEY (POSTING_ID),
        UNIQUE KEY uk_rebate_posting_no (POSTING_NO),
        KEY idx_rebate_posting_supplier (SUPPLIER_ID, STATUS, POSTING_DATE),
        KEY idx_rebate_posting_status (STATUS, CREATE_TIME)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='供应商返利预上账单'
    `);
    await checkAndMakeColumnNullable('T_REBATE_POSTING_ORDER', 'SUPPLIER_ID', 'VARCHAR(32)');
    await checkAndAddColumn('T_REBATE_POSTING_ORDER', 'SETTLEMENT_TYPE', 'VARCHAR(32) DEFAULT "supplier" COMMENT "supplier/expense/reimbursement"', 'SUPPLIER_NAME');
    await checkAndAddColumn('T_REBATE_POSTING_ORDER', 'PAYEE_TYPE', 'VARCHAR(32) DEFAULT "supplier" COMMENT "supplier/employee/counterparty"', 'SETTLEMENT_TYPE');
    await checkAndAddColumn('T_REBATE_POSTING_ORDER', 'PAYEE_ID', 'VARCHAR(64) COMMENT "payee id"', 'PAYEE_TYPE');
    await checkAndAddColumn('T_REBATE_POSTING_ORDER', 'PAYEE_NAME', 'VARCHAR(255) COMMENT "payee name"', 'PAYEE_ID');
    await checkAndAddColumn('T_REBATE_POSTING_ORDER', 'SOURCE_TYPE', 'VARCHAR(32) COMMENT "source type"', 'PAYEE_NAME');
    await checkAndAddColumn('T_REBATE_POSTING_ORDER', 'SOURCE_ID', 'VARCHAR(64) COMMENT "source id"', 'SOURCE_TYPE');
    await checkAndAddColumn('T_REBATE_POSTING_ORDER', 'SOURCE_NO', 'VARCHAR(64) COMMENT "source no"', 'SOURCE_ID');

    await checkAndCreateTable('T_REBATE_SETTLEMENT_ALLOCATION', `
      CREATE TABLE T_REBATE_SETTLEMENT_ALLOCATION (
        ALLOCATION_ID VARCHAR(32) NOT NULL COMMENT '核销分配ID',
        SETTLEMENT_ID VARCHAR(32) NOT NULL COMMENT '返利下账单ID',
        POSTING_ID VARCHAR(32) NOT NULL COMMENT '返利上账单ID',
        AMOUNT DECIMAL(12,2) NOT NULL COMMENT '本次核销金额',
        STATUS VARCHAR(32) DEFAULT 'ACTIVE' COMMENT 'ACTIVE/REVERSED',
        CREATE_STAFF_ID BIGINT COMMENT '核销人员工ID',
        CREATE_USER VARCHAR(64) COMMENT '核销人',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '核销时间',
        REVERSED_AT DATETIME COMMENT '撤销时间',
        REVERSED_BY BIGINT COMMENT '撤销人员工ID',
        REVERSED_BY_NAME VARCHAR(64) COMMENT '撤销人',
        REVERSAL_REASON VARCHAR(512) COMMENT '撤销原因',
        PRIMARY KEY (ALLOCATION_ID),
        KEY idx_rebate_allocation_settlement (SETTLEMENT_ID, STATUS),
        KEY idx_rebate_allocation_posting (POSTING_ID, STATUS)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='返利上账与下账核销分配'
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
        SOURCE_TYPE VARCHAR(32) DEFAULT 'manual' COMMENT '来源类型',
        SOURCE_ID VARCHAR(64) COMMENT '来源业务ID',
        REVERSAL_OF VARCHAR(32) COMMENT '被冲销返利预估ID',
        REMARK VARCHAR(512) COMMENT '备注',
        CREATED_AT TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        UPDATED_AT TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
        PRIMARY KEY (ESTIMATE_ID),
        KEY idx_rebate_estimate_order (SALES_ORDER_ID),
        KEY idx_rebate_estimate_policy (POLICY_ID),
        KEY idx_rebate_estimate_status (STATUS)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='厂家返利预估表'
    `);
    await checkAndAddColumn('T_REBATE_ESTIMATE', 'SOURCE_TYPE', 'VARCHAR(32) DEFAULT "manual" COMMENT "来源类型"', 'STATUS');
    await checkAndAddColumn('T_REBATE_ESTIMATE', 'SOURCE_ID', 'VARCHAR(64) COMMENT "来源业务ID"', 'SOURCE_TYPE');
    await checkAndAddColumn('T_REBATE_ESTIMATE', 'REVERSAL_OF', 'VARCHAR(32) COMMENT "被冲销返利预估ID"', 'SOURCE_ID');
    await sequelize.query(`
      INSERT IGNORE INTO T_RESOURCE_SETTLEMENT
        (SETTLEMENT_ID, SETTLEMENT_NO, SOURCE_TYPE, SOURCE_ID, SN_ID, SN_CODE, PRODUCT_ID,
         RESOURCE_TYPE, COUNTERPARTY_ID, COUNTERPARTY_NAME, AMOUNT, STATUS, TARGET_ACCOUNT_ID, CREATE_TIME, REMARK)
      SELECT MD5(CONCAT('REBATE:', e.ESTIMATE_ID)), CONCAT('RST-REB-', e.ESTIMATE_ID),
             'MANUFACTURER_REBATE', e.ESTIMATE_ID,
             COALESCE(NULLIF(e.SN, ''), MD5(CONCAT('NO_SN:', e.ESTIMATE_ID))), COALESCE(e.SN, ''), COALESCE(e.PRODUCT_ID, ''),
             'MANUFACTURER_REBATE', e.SUPPLIER_ID, e.SUPPLIER_NAME, e.REBATE_ESTIMATE_AMOUNT, 'PENDING',
             (SELECT c.DEFAULT_ACCOUNT_ID FROM T_RESOURCE_CATEGORY c WHERE c.CATEGORY_CODE = 'MANUFACTURER_REBATE' LIMIT 1),
             e.CREATED_AT, CONCAT('历史厂商返利预估迁移：', COALESCE(e.SALES_ORDER_NO, ''))
      FROM T_REBATE_ESTIMATE e
      WHERE e.REBATE_ESTIMATE_AMOUNT > 0 AND e.STATUS IN ('estimated', 'confirmed')
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

    await checkAndCreateTable('T_PERFORMANCE_PROFIT_ADJUSTMENT', `
      CREATE TABLE T_PERFORMANCE_PROFIT_ADJUSTMENT (
        ADJUSTMENT_ID VARCHAR(32) NOT NULL COMMENT '调整申请ID',
        ADJUSTMENT_NO VARCHAR(64) NOT NULL COMMENT '调整申请单号',
        ORDER_ID VARCHAR(32) NOT NULL COMMENT '销售订单ID',
        ORDER_NO VARCHAR(64) NOT NULL COMMENT '销售订单号',
        STORE_ID VARCHAR(32) NOT NULL COMMENT '门店ID',
        EMPLOYEE_NAME VARCHAR(64) COMMENT '业绩归属员工',
        ADJUSTMENT_TYPE VARCHAR(16) NOT NULL COMMENT '类型:increase/decrease',
        AMOUNT DECIMAL(12,2) NOT NULL COMMENT '调整绝对金额',
        SIGNED_AMOUNT DECIMAL(12,2) NOT NULL COMMENT '有符号调整金额',
        BASE_GROSS_PROFIT DECIMAL(12,2) DEFAULT 0 COMMENT '申请时订单归档毛利快照',
        REASON VARCHAR(1000) NOT NULL COMMENT '调整原因',
        STATUS VARCHAR(32) DEFAULT 'pending_finance' COMMENT '状态:pending_finance/pending_admin/approved/rejected',
        APPLICANT_STAFF_ID BIGINT(20) NOT NULL COMMENT '申请人ID',
        APPLICANT_NAME VARCHAR(64) NOT NULL COMMENT '申请人',
        FINANCE_REVIEWER_ID BIGINT(20) COMMENT '财务初审人ID',
        FINANCE_REVIEWER_NAME VARCHAR(64) COMMENT '财务初审人',
        FINANCE_REVIEW_COMMENT VARCHAR(512) COMMENT '财务审核意见',
        FINANCE_REVIEW_TIME DATETIME COMMENT '财务审核时间',
        ADMIN_REVIEWER_ID BIGINT(20) COMMENT 'admin复审人ID',
        ADMIN_REVIEWER_NAME VARCHAR(64) COMMENT 'admin复审人',
        ADMIN_REVIEW_COMMENT VARCHAR(512) COMMENT 'admin审核意见',
        ADMIN_REVIEW_TIME DATETIME COMMENT 'admin审核时间',
        REJECT_STAGE VARCHAR(32) COMMENT '拒绝阶段',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '申请时间',
        UPDATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
        PRIMARY KEY (ADJUSTMENT_ID),
        UNIQUE KEY uk_performance_profit_adjustment_no (ADJUSTMENT_NO),
        KEY idx_ppa_order_status (ORDER_ID, STATUS),
        KEY idx_ppa_applicant (APPLICANT_STAFF_ID, CREATE_TIME),
        KEY idx_ppa_status_time (STATUS, CREATE_TIME)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='员工业绩毛利调整申请表'
    `);

    await checkAndCreateTable('T_PERFORMANCE_PROFIT_ADJUSTMENT_ATTACHMENT', `
      CREATE TABLE T_PERFORMANCE_PROFIT_ADJUSTMENT_ATTACHMENT (
        ATTACHMENT_ID VARCHAR(32) NOT NULL COMMENT '附件ID',
        ADJUSTMENT_ID VARCHAR(32) NOT NULL COMMENT '调整申请ID',
        ORIGINAL_NAME VARCHAR(255) NOT NULL COMMENT '原始文件名',
        STORAGE_NAME VARCHAR(255) NOT NULL COMMENT '存储文件名',
        MIME_TYPE VARCHAR(128) COMMENT '文件类型',
        FILE_SIZE BIGINT(20) DEFAULT 0 COMMENT '文件大小',
        FILE_PATH VARCHAR(1024) NOT NULL COMMENT '服务端存储路径',
        UPLOAD_STAFF_ID BIGINT(20) NOT NULL COMMENT '上传人ID',
        UPLOAD_USER VARCHAR(64) COMMENT '上传人',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '上传时间',
        PRIMARY KEY (ATTACHMENT_ID),
        KEY idx_ppaa_adjustment (ADJUSTMENT_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='员工业绩毛利调整附件表'
    `);

    await checkAndAddColumn('T_PURCHASE_REQUEST', 'REBATE_DEDUCTION', 'DECIMAL(12,2) DEFAULT 0.00 COMMENT "返利抵扣"', 'TOTAL_AMOUNT');
    await checkAndAddColumn('T_PURCHASE_REQUEST', 'ACTUAL_TOTAL', 'DECIMAL(12,2) DEFAULT 0.00 COMMENT "抵扣后实际总价"', 'REBATE_DEDUCTION');
    await checkAndAddColumn('T_PURCHASE_REQUEST', 'GOODS_TYPE_ID', 'VARCHAR(32) COMMENT "关联货型配置ID"', 'SUPPLIER_ID');
    await checkAndAddColumn('T_PURCHASE_REQUEST', 'PRODUCT_TYPE', 'VARCHAR(128) COMMENT "货型名称快照"', 'GOODS_TYPE_ID');
    await checkAndAddColumn('T_PURCHASE_REQUEST_ITEM', 'REBATE_DEDUCTION', 'DECIMAL(12,2) DEFAULT 0.00 COMMENT "item rebate deduction"', 'SUBTOTAL');
    await checkAndAddColumn('T_PURCHASE_REQUEST_ITEM', 'GOODS_TYPE_ID', 'VARCHAR(32) COMMENT "关联货型配置ID"', 'REBATE_DEDUCTION');
    await checkAndAddColumn('T_PURCHASE_REQUEST_ITEM', 'PRODUCT_TYPE', 'VARCHAR(128) COMMENT "货型名称快照"', 'GOODS_TYPE_ID');
    await ensureVarcharLength(
      'T_PURCHASE_REQUEST_ITEM',
      'PRODUCT_TYPE',
      128,
      'VARCHAR(128) COMMENT "货型名称快照"'
    );
    await sequelize.query(`
      UPDATE T_PURCHASE_REQUEST pr
      INNER JOIN (
        SELECT REQUEST_ID, MIN(PRODUCT_TYPE) AS PRODUCT_TYPE
        FROM T_PURCHASE_REQUEST_ITEM
        WHERE PRODUCT_TYPE IS NOT NULL AND PRODUCT_TYPE <> ''
        GROUP BY REQUEST_ID
      ) pri ON pri.REQUEST_ID = pr.REQUEST_ID
      LEFT JOIN T_GOODS_TYPE gt ON gt.NAME = pri.PRODUCT_TYPE
      SET pr.PRODUCT_TYPE = COALESCE(NULLIF(pr.PRODUCT_TYPE, ''), pri.PRODUCT_TYPE),
          pr.GOODS_TYPE_ID = COALESCE(NULLIF(pr.GOODS_TYPE_ID, ''), gt.GOODS_TYPE_ID)
      WHERE pr.PRODUCT_TYPE IS NULL OR pr.PRODUCT_TYPE = ''
         OR pr.GOODS_TYPE_ID IS NULL OR pr.GOODS_TYPE_ID = ''
    `);
    await sequelize.query(`
      UPDATE T_PURCHASE_REQUEST_ITEM pri
      INNER JOIN T_GOODS_TYPE gt ON gt.NAME = pri.PRODUCT_TYPE
      SET pri.GOODS_TYPE_ID = gt.GOODS_TYPE_ID
      WHERE pri.GOODS_TYPE_ID IS NULL OR pri.GOODS_TYPE_ID = ''
    `);

    await checkAndAddColumn('T_STAFF', 'CREATE_TIME', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT "创建时间"', 'STATUS');
    await checkAndAddColumn('T_STAFF', 'UPDATE_TIME', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT "更新时间"', 'CREATE_TIME');

    await checkAndAddColumn('T_ORDER', 'SUBMIT_USER', 'VARCHAR(64) COMMENT "订单提交人"', 'ORDER_STATUS');
    await checkAndAddColumn('T_ORDER', 'SUBMIT_TIME', 'DATETIME COMMENT "订单提交时间"', 'SUBMIT_USER');
    await checkAndAddColumn('T_ORDER', 'APPROVE_USER', 'VARCHAR(64) COMMENT "订单审批人"', 'SUBMIT_TIME');
    await checkAndAddColumn('T_ORDER', 'APPROVE_TIME', 'DATETIME COMMENT "订单审批时间"', 'APPROVE_USER');
    await checkAndAddColumn('T_ORDER', 'APPROVE_COMMENT', 'VARCHAR(1000) COMMENT "订单审批意见"', 'APPROVE_TIME');
    await checkAndAddColumn('T_PURCHASE_REQUEST', 'SUBMIT_USER', 'VARCHAR(64) COMMENT "采购申请提交人"', 'APPLY_USER');
    await checkAndAddColumn('T_PURCHASE_REQUEST', 'APPLICANT_STAFF_ID', 'BIGINT(20) COMMENT "采购申请人员工ID"', 'APPLY_USER');
    await checkAndAddColumn('T_PURCHASE_REQUEST', 'SUBMIT_TIME', 'DATETIME COMMENT "采购申请提交时间"', 'SUBMIT_USER');
    await checkAndAddColumn('T_PURCHASE_REQUEST', 'APPROVE_TIME', 'DATETIME COMMENT "采购申请审批时间"', 'APPROVE_USER');
    await checkAndAddColumn('T_PURCHASE_REQUEST', 'REVOKE_USER', 'VARCHAR(64) COMMENT "采购申请撤销人"', 'APPROVE_COMMENT');
    await checkAndAddColumn('T_PURCHASE_REQUEST', 'REVOKE_TIME', 'DATETIME COMMENT "采购申请撤销时间"', 'REVOKE_USER');
    await checkAndAddColumn('T_PURCHASE_REQUEST', 'REVOKE_COMMENT', 'VARCHAR(512) COMMENT "采购申请撤销原因"', 'REVOKE_TIME');
    await checkAndAddColumn('T_ORDER', 'CREATE_TIME', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT "创建时间"', 'REMARK');
    await checkAndAddColumn('T_ORDER', 'UPDATE_TIME', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT "更新时间"', 'CREATE_TIME');
    await checkAndAddColumn('T_ORDER', 'DEPOSIT_DEDUCTION_TOTAL', 'DECIMAL(12,2) DEFAULT 0 COMMENT "定金抵扣总额"', 'EDUCATION_SUBSIDY');
    await checkAndAddColumn('T_ORDER', 'DEPOSIT_ITEMS', 'JSON COMMENT "定金抵扣明细快照"', 'DEPOSIT_DEDUCTION_TOTAL');
    await checkAndAddColumn('T_ORDER', 'CUSTOMER_SOURCE_DETAIL', 'VARCHAR(128) COMMENT "二级客户来源"', 'CUSTOMER_SOURCE');
    await checkAndAddColumn('T_ORDER', 'AUXILIARY_SALES_LIST', 'JSON COMMENT "辅助销售人列表"', 'CUSTOMER_SOURCE_DETAIL');
    await checkAndAddColumn('T_ORDER', 'INVOICE_INFO', 'TEXT COMMENT "开票信息或云闪付订单号"', 'INVOICE_STATUS');
    await checkAndAddColumn('T_ORDER', 'INVOICE_AMOUNT', 'DECIMAL(12,2) DEFAULT 0 COMMENT "开票金额"', 'INVOICE_INFO');
    await checkAndAddColumn('T_ORDER', 'SUBSIDY_PHOTOS', 'JSON COMMENT "国补照片"', 'SUBSIDY_ID');
    await checkAndAddColumn('T_ORDER', 'PRODUCT_PHOTO_URLS', 'JSON COMMENT "商品照片"', 'SUBSIDY_PHOTOS');
    await checkAndAddColumn('T_ORDER', 'EDUCATION_SUBSIDY_PHOTO_URL', 'TEXT COMMENT "教育补贴核销凭证"', 'PRODUCT_PHOTO_URLS');
    await checkAndAddColumn('T_ORDER', 'EDUCATION_SUBSIDY_COUPON_CODE', 'VARCHAR(128) COMMENT "教育补贴券码"', 'EDUCATION_SUBSIDY_PHOTO_URL');
    await checkAndAddColumn('T_ORDER', 'EDUCATION_SUBSIDY_OCR_TEXT', 'TEXT COMMENT "教育补贴OCR原文"', 'EDUCATION_SUBSIDY_COUPON_CODE');
    await checkAndAddColumn('T_ORDER', 'PERSONAL_INFO_PHOTO', 'JSON COMMENT "个人资料照片"', 'EDUCATION_SUBSIDY_OCR_TEXT');
    await checkAndAddColumn('T_ORDER', 'INVENTORY_RESERVED', 'TINYINT(1) NOT NULL DEFAULT 1 COMMENT "订单创建阶段是否已占用库存"', 'ORDER_STATUS');
    await ensureNullableColumn('T_ORDER_ITEM', 'PRODUCT_ID', 'VARCHAR(32)');
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
        PAYMENT_METHOD VARCHAR(128) NOT NULL COMMENT '收款方式',
        REDEEMED_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '已核销金额',
        REFUNDED_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '已退款金额',
        STATUS VARCHAR(32) DEFAULT 'available' COMMENT '状态:available/redeemed/refunded',
        RELATED_ORDER_ID VARCHAR(32) COMMENT '关联订单ID',
        RELATED_ORDER_NO VARCHAR(64) COMMENT '关联订单号',
        REMARK TEXT COMMENT '备注',
        CREATE_STAFF_ID BIGINT(20) COMMENT '收定金员工ID',
        CREATE_USER VARCHAR(64) COMMENT '收定金员工',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        ARCHIVE_USER VARCHAR(64) COMMENT '归档人',
        ARCHIVE_TIME DATETIME COMMENT '归档时间',
        UPDATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
        IS_DELETED TINYINT(1) DEFAULT 0,
        PRIMARY KEY (DEPOSIT_ID),
        UNIQUE KEY uk_deposit_no (DEPOSIT_NO),
        KEY idx_deposit_store (STORE_ID),
        KEY idx_deposit_status (STATUS),
        KEY idx_deposit_customer_phone (CUSTOMER_PHONE),
        KEY idx_deposit_create_staff (CREATE_STAFF_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='销售定金单'
    `);

    await sequelize.query(
      "ALTER TABLE T_DEPOSIT_ORDER MODIFY COLUMN STATUS VARCHAR(32) DEFAULT 'available' COMMENT '状态:available/redeemed/refunded'"
    );
    const [, depositStatusMigration] = await sequelize.query(`
      UPDATE T_DEPOSIT_ORDER
      SET STATUS = 'available'
      WHERE STATUS = 'submitted'
        AND (AMOUNT - REDEEMED_AMOUNT - REFUNDED_AMOUNT) > 0
    `);
    if (depositStatusMigration?.affectedRows > 0) {
      console.log(`✓ 已将 ${depositStatusMigration.affectedRows} 笔历史待生效定金转入定金库`);
    }

    await checkAndCreateTable('T_DEPOSIT_REFUND', `
      CREATE TABLE T_DEPOSIT_REFUND (
        REFUND_ID VARCHAR(32) NOT NULL COMMENT '退款ID',
        REFUND_NO VARCHAR(64) NOT NULL COMMENT '退款单号',
        DEPOSIT_ID VARCHAR(32) NOT NULL COMMENT '定金单ID',
        AMOUNT DECIMAL(12,2) NOT NULL COMMENT '退款金额',
        REASON VARCHAR(512) COMMENT '退款原因',
        CREATE_STAFF_ID BIGINT(20) COMMENT '操作员工ID',
        CREATE_USER VARCHAR(64) COMMENT '操作员工',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        PRIMARY KEY (REFUND_ID),
        UNIQUE KEY uk_refund_no (REFUND_NO),
        KEY idx_refund_deposit (DEPOSIT_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='销售定金退款记录'
    `);

    await checkAndCreateTable('T_DEPOSIT_REDEMPTION', `
      CREATE TABLE T_DEPOSIT_REDEMPTION (
        REDEMPTION_ID VARCHAR(32) NOT NULL COMMENT '核销ID',
        DEPOSIT_ID VARCHAR(32) NOT NULL COMMENT '定金单ID',
        ORDER_ID VARCHAR(32) NOT NULL COMMENT '订单ID',
        ORDER_NO VARCHAR(64) COMMENT '订单号',
        AMOUNT DECIMAL(12,2) NOT NULL COMMENT '核销金额',
        STATUS VARCHAR(32) DEFAULT 'active' COMMENT '状态:active/void',
        VOID_REASON VARCHAR(512) COMMENT '作废原因',
        VOID_TIME DATETIME COMMENT '作废时间',
        CREATE_STAFF_ID BIGINT(20) COMMENT '操作员工ID',
        CREATE_USER VARCHAR(64) COMMENT '操作员工',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        PRIMARY KEY (REDEMPTION_ID),
        KEY idx_redemption_deposit (DEPOSIT_ID),
        KEY idx_redemption_order (ORDER_ID),
        KEY idx_redemption_status (STATUS)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='销售定金核销记录'
    `);

    await checkAndAddColumn('T_PRODUCT', 'NEED_SN', 'TINYINT(1) DEFAULT 0 COMMENT "是否需要SN管理"', 'STATUS');
    await checkAndAddColumn('T_DICT_PAYMENT_METHOD', 'SETTLEMENT_ACCOUNT_ID', 'VARCHAR(64) COMMENT "结算账号ID（全局默认）"', 'ICON');
    await checkAndAddColumn('T_DICT_PAYMENT_METHOD', 'IS_GLOBAL', 'TINYINT(1) DEFAULT 1 COMMENT "是否全局配置"', 'SETTLEMENT_ACCOUNT_ID');

    await checkAndAddColumn('T_PURCHASE_REQUEST_ITEM', 'PRODUCT_TYPE', 'VARCHAR(32) COMMENT "货型：正规货/国补货/纯二批"', 'SUBTOTAL');
    await checkAndAddColumn('T_INBOUND_ITEM', 'PRODUCT_TYPE', 'VARCHAR(32) COMMENT "货型：正规货/国补货/纯二批"', 'INVENTORY_TYPE');
    await checkAndAddColumn('T_INBOUND_ITEM', 'ORIGINAL_PICKUP_PRICE', 'DECIMAL(12,2) DEFAULT 0 COMMENT "原始提货价"', 'UNIT_PRICE');
    await checkAndAddColumn('T_INBOUND_ITEM', 'RECEIVED_QUANTITY', 'INT NOT NULL DEFAULT 0 COMMENT "累计已入库数量"', 'QUANTITY');
    await checkAndAddColumn('T_INBOUND_ITEM', 'RECEIVED_SN_CODES', 'TEXT COMMENT "累计已入库SN列表JSON"', 'RECEIVED_QUANTITY');
    await checkAndAddColumn('T_INBOUND_ITEM', 'RECEIVE_USER', 'VARCHAR(64) COMMENT "最近一次入库人"', 'RECEIVED_SN_CODES');
    await checkAndAddColumn('T_INBOUND_ITEM', 'RECEIVE_TIME', 'DATETIME COMMENT "最近一次入库时间"', 'RECEIVE_USER');
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
    await checkAndAddColumn('T_ORDER_ITEM', 'USE_GOV_SUBSIDY', 'TINYINT(1) DEFAULT 0 COMMENT "本行使用国补权益"', 'SALES_GROSS_PROFIT');
    await checkAndAddColumn('T_ORDER_ITEM', 'USE_EDU_SUBSIDY', 'TINYINT(1) DEFAULT 0 COMMENT "本行使用教育补贴权益"', 'USE_GOV_SUBSIDY');
    await checkAndAddColumn('T_ORDER_ITEM', 'USE_SALES_REPORT', 'TINYINT(1) DEFAULT 0 COMMENT "本行使用销量报号权益"', 'USE_EDU_SUBSIDY');
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
    await checkAndAddColumn('T_DEPOSIT_ORDER', 'PAYMENT_METHOD', 'VARCHAR(128) COMMENT "收取定金时的收款方式"', 'AMOUNT');
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
        BUSINESS_TYPE VARCHAR(32) DEFAULT 'sales_receipt' COMMENT 'sales_receipt/deposit_receipt/national_subsidy_receivable',
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
    await checkAndAddColumn('T_SETTLEMENT_ACCOUNT', 'ACCOUNT_TYPE', 'VARCHAR(32) DEFAULT "FUND" COMMENT "FUND/POLICY_RECEIVABLE/SUPPLIER_REBATE/CARE_CREDIT"', 'ACCOUNT_NUMBER');
    await checkAndAddColumn('T_SETTLEMENT_ACCOUNT', 'REGION_ID', 'VARCHAR(32) COMMENT "账户所属区域；为空表示公司级账户"', 'ACCOUNT_TYPE');
    await checkAndAddColumn('T_SETTLEMENT_ACCOUNT', 'SUPPLIER_ID', 'VARCHAR(32) COMMENT "供应商返利账户对应供应商"', 'ACCOUNT_TYPE');
    await checkAndAddColumn('T_SETTLEMENT_ACCOUNT', 'USAGE_NOTE', 'VARCHAR(512) COMMENT "账户用途及限制"', 'SUPPLIER_ID');
    await checkAndAddColumn('T_SETTLEMENT_ACCOUNT', 'DISTRIBUTOR_ID', 'VARCHAR(32) COMMENT "账户所属经销商；为空表示共享/系统级账户"', 'ACCOUNT_TYPE');
    await checkAndAddIndex(
      'T_SETTLEMENT_ACCOUNT',
      'idx_settlement_account_supplier_type',
      'ALTER TABLE T_SETTLEMENT_ACCOUNT ADD INDEX idx_settlement_account_supplier_type (ACCOUNT_TYPE, SUPPLIER_ID, STATUS)'
    );
    await checkAndAddIndex(
      'T_SETTLEMENT_ACCOUNT',
      'idx_settlement_account_region_status',
      'ALTER TABLE T_SETTLEMENT_ACCOUNT ADD INDEX idx_settlement_account_region_status (REGION_ID, STATUS)'
    );
    await checkAndAddIndex(
      'T_SETTLEMENT_ACCOUNT',
      'idx_settlement_account_distributor_status',
      'ALTER TABLE T_SETTLEMENT_ACCOUNT ADD INDEX idx_settlement_account_distributor_status (DISTRIBUTOR_ID, STATUS)'
    );
    await checkAndAddColumn('T_PAYABLE', 'REGION_ID', 'VARCHAR(32) COMMENT "采购/报销业务区域快照"', 'SOURCE_NO');
    await checkAndAddColumn('T_PAYABLE', 'DISTRIBUTOR_ID', 'VARCHAR(32) COMMENT "应付款所属经销商快照"', 'SOURCE_NO');
    await checkAndAddColumn('T_SETTLEMENT', 'REGION_ID', 'VARCHAR(32) COMMENT "结算单业务区域快照；跨区域为空"', 'SOURCE_NO');
    await checkAndAddColumn('T_SETTLEMENT', 'DISTRIBUTOR_ID', 'VARCHAR(32) COMMENT "结算单所属经销商快照"', 'SOURCE_NO');
    await checkAndAddColumn('T_PURCHASE_REQUEST', 'DISTRIBUTOR_ID', 'VARCHAR(32) COMMENT "采购业务所属经销商快照"', 'STORE_ID');
    await checkAndAddColumn('T_PURCHASE_ADJUSTMENT', 'DISTRIBUTOR_ID', 'VARCHAR(32) COMMENT "采购调整所属经销商快照"', 'STORE_ID');
    await checkAndAddColumn('T_EXPENSE', 'DISTRIBUTOR_ID', 'VARCHAR(32) COMMENT "费用所属经销商快照"', 'STORE_ID');
    await checkAndAddColumn('T_SETTLEMENT_PAYMENT_BATCH', 'DISTRIBUTOR_ID', 'VARCHAR(32) COMMENT "付款批次所属经销商快照"', 'ACCOUNT_ID');
    await checkAndAddColumn('T_SETTLEMENT_PAYMENT_RECORD', 'DISTRIBUTOR_ID', 'VARCHAR(32) COMMENT "付款记录所属经销商快照"', 'SETTLEMENT_NO');
    await checkAndAddIndex(
      'T_PAYABLE',
      'idx_payable_region_status',
      'ALTER TABLE T_PAYABLE ADD INDEX idx_payable_region_status (REGION_ID, STATUS)'
    );
    await checkAndAddIndex(
      'T_SETTLEMENT',
      'idx_settlement_region_payment',
      'ALTER TABLE T_SETTLEMENT ADD INDEX idx_settlement_region_payment (REGION_ID, PAYMENT_STATUS, IS_DELETED)'
    );
    try {
      await sequelize.query(`
        UPDATE T_PAYABLE p
        LEFT JOIN T_PURCHASE_REQUEST pr ON pr.REQUEST_ID = p.REQUEST_ID
        LEFT JOIN T_EXPENSE e ON e.EXPENSE_ID = p.SOURCE_ID
        LEFT JOIN T_STORE st ON st.STORE_ID = COALESCE(pr.STORE_ID, e.STORE_ID)
        SET p.REGION_ID = COALESCE(p.REGION_ID, e.REGION_ID, st.REGION_ID),
            p.DISTRIBUTOR_ID = COALESCE(p.DISTRIBUTOR_ID, pr.DISTRIBUTOR_ID, e.DISTRIBUTOR_ID, st.DISTRIBUTOR_ID)
        WHERE p.REGION_ID IS NULL OR p.DISTRIBUTOR_ID IS NULL
      `);
      await sequelize.query(`
        UPDATE T_PURCHASE_REQUEST pr
        INNER JOIN T_STORE st ON st.STORE_ID = pr.STORE_ID
        SET pr.DISTRIBUTOR_ID = COALESCE(pr.DISTRIBUTOR_ID, st.DISTRIBUTOR_ID)
        WHERE pr.DISTRIBUTOR_ID IS NULL
      `);
      await sequelize.query(`
        UPDATE T_PURCHASE_ADJUSTMENT pa
        INNER JOIN T_STORE st ON st.STORE_ID = pa.STORE_ID
        SET pa.DISTRIBUTOR_ID = COALESCE(pa.DISTRIBUTOR_ID, st.DISTRIBUTOR_ID)
        WHERE pa.DISTRIBUTOR_ID IS NULL
      `);
      await sequelize.query(`
        UPDATE T_EXPENSE e
        INNER JOIN T_STORE st ON st.STORE_ID = e.STORE_ID
        SET e.DISTRIBUTOR_ID = COALESCE(e.DISTRIBUTOR_ID, st.DISTRIBUTOR_ID)
        WHERE e.DISTRIBUTOR_ID IS NULL
      `);
      await sequelize.query(`
        UPDATE T_PAYABLE p
        LEFT JOIN T_PURCHASE_REQUEST pr ON pr.REQUEST_ID = p.REQUEST_ID
        LEFT JOIN T_EXPENSE e ON e.EXPENSE_ID = p.SOURCE_ID
        LEFT JOIN T_STORE st ON st.STORE_ID = COALESCE(pr.STORE_ID, e.STORE_ID)
        SET p.DISTRIBUTOR_ID = COALESCE(p.DISTRIBUTOR_ID, pr.DISTRIBUTOR_ID, e.DISTRIBUTOR_ID, st.DISTRIBUTOR_ID)
        WHERE p.DISTRIBUTOR_ID IS NULL
      `);
      await sequelize.query(`
        UPDATE T_SETTLEMENT s
        JOIN (
          SELECT si.SETTLEMENT_ID, MIN(p.REGION_ID) AS REGION_ID, MIN(p.DISTRIBUTOR_ID) AS DISTRIBUTOR_ID
          FROM T_SETTLEMENT_ITEM si
          INNER JOIN T_PAYABLE p ON p.PAYABLE_ID = si.PAYABLE_ID
          WHERE p.REGION_ID IS NOT NULL OR p.DISTRIBUTOR_ID IS NOT NULL
          GROUP BY si.SETTLEMENT_ID
          HAVING COUNT(DISTINCT p.REGION_ID) <= 1 AND COUNT(DISTINCT p.DISTRIBUTOR_ID) <= 1
        ) x ON x.SETTLEMENT_ID = s.SETTLEMENT_ID
        SET s.REGION_ID = COALESCE(s.REGION_ID, x.REGION_ID),
            s.DISTRIBUTOR_ID = COALESCE(s.DISTRIBUTOR_ID, x.DISTRIBUTOR_ID)
        WHERE s.REGION_ID IS NULL OR s.DISTRIBUTOR_ID IS NULL
      `);
      await sequelize.query(`
        UPDATE T_SETTLEMENT_PAYMENT_BATCH b
        INNER JOIN T_SETTLEMENT_PAYMENT_RECORD r ON r.BATCH_ID = b.BATCH_ID
        SET b.DISTRIBUTOR_ID = COALESCE(b.DISTRIBUTOR_ID, r.DISTRIBUTOR_ID)
        WHERE b.DISTRIBUTOR_ID IS NULL
      `);
      await sequelize.query(`
        UPDATE T_SETTLEMENT_PAYMENT_RECORD r
        INNER JOIN T_SETTLEMENT s ON s.SETTLEMENT_ID = r.SETTLEMENT_ID
        SET r.DISTRIBUTOR_ID = COALESCE(r.DISTRIBUTOR_ID, s.DISTRIBUTOR_ID)
        WHERE r.DISTRIBUTOR_ID IS NULL
      `);
      await sequelize.query(`
        UPDATE T_SETTLEMENT_PAYMENT_BATCH b
        INNER JOIN T_SETTLEMENT_PAYMENT_RECORD r ON r.BATCH_ID = b.BATCH_ID
        SET b.DISTRIBUTOR_ID = COALESCE(b.DISTRIBUTOR_ID, r.DISTRIBUTOR_ID)
        WHERE b.DISTRIBUTOR_ID IS NULL
      `);
      await sequelize.query(`
        UPDATE T_SETTLEMENT_ACCOUNT
        SET DISTRIBUTOR_ID = 'DIST001'
        WHERE (DISTRIBUTOR_ID IS NULL OR DISTRIBUTOR_ID = '')
          AND ACCOUNT_NAME LIKE '%艾诺云%'
          AND ACCOUNT_TYPE = 'FUND'
      `);
      await sequelize.query(`
        UPDATE T_SETTLEMENT_ACCOUNT
        SET DISTRIBUTOR_ID = 'DIST002'
        WHERE (DISTRIBUTOR_ID IS NULL OR DISTRIBUTOR_ID = '')
          AND ACCOUNT_NAME LIKE '%艾诺志兴%'
          AND ACCOUNT_TYPE = 'FUND'
      `);
      console.log('[DB Migration] 已回填财务单据区域快照');
    } catch (error) {
      console.warn('[DB Migration] 财务单据区域快照回填跳过:', error.message);
    }
    await sequelize.query(`
      INSERT IGNORE INTO T_SETTLEMENT_ACCOUNT
        (ACCOUNT_ID, ACCOUNT_NAME, BANK_NAME, ACCOUNT_NUMBER, ACCOUNT_TYPE, USAGE_NOTE, SORT_ORDER, STATUS)
      VALUES
        ('ACC_CARE_CREDIT_DEFAULT', 'Care卡可用金', '', '', 'CARE_CREDIT', '仅用于购买延保等指定商品或服务', 900, 1),
        ('ACC_POLICY_SUBSIDY_RECEIVABLE', '政策补贴应收', '', '', 'POLICY_RECEIVABLE', '国补订单政策补贴待回款，不属于客户当场实收', 910, 1)
    `);
    await checkAndAddColumn(
      'T_DAILY_STATEMENT_DETAIL',
      'BUSINESS_TYPE',
      'VARCHAR(32) DEFAULT "sales_receipt" COMMENT "sales_receipt/deposit_receipt/national_subsidy_receivable"',
      'PAYMENT_CODE'
    );
    await checkAndAddIndex(
      'T_DAILY_STATEMENT_DETAIL',
      'idx_daily_business_settled',
      'ALTER TABLE T_DAILY_STATEMENT_DETAIL ADD INDEX idx_daily_business_settled (BUSINESS_TYPE, SETTLED)'
    );
    await sequelize.query(`
      UPDATE T_DAILY_STATEMENT_DETAIL
      SET BUSINESS_TYPE = CASE
        WHEN PAYMENT_METHOD LIKE '国补%-政策补贴应收' THEN 'national_subsidy_receivable'
        ELSE 'sales_receipt'
      END
      WHERE BUSINESS_TYPE IS NULL
         OR BUSINESS_TYPE = ''
         OR (BUSINESS_TYPE = 'sales_receipt' AND PAYMENT_METHOD LIKE '国补%-政策补贴应收')
    `);

    await checkAndCreateTable('T_DICT_PAYMENT_METHOD', `
      CREATE TABLE T_DICT_PAYMENT_METHOD (
        METHOD_ID VARCHAR(64) NOT NULL COMMENT '方式ID',
        NAME VARCHAR(128) NOT NULL COMMENT '名称',
        CODE VARCHAR(64) COMMENT '编码',
        ICON VARCHAR(64) COMMENT '图标',
        SETTLEMENT_ACCOUNT_ID VARCHAR(64) COMMENT '结算账号ID（全局默认）',
        RECEIVABLE_SETTLEMENT_ACCOUNT_ID VARCHAR(64) COMMENT '政策补贴应收账户ID（全局默认）',
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
        RECEIVABLE_SETTLEMENT_ACCOUNT_ID VARCHAR(64) COMMENT '政策补贴应收账户ID',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        PRIMARY KEY (ID),
        UNIQUE KEY uk_method_store (METHOD_ID, STORE_ID),
        KEY idx_store (STORE_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='收款方式-门店关联表'
    `);
    await checkAndAddColumn(
      'T_DICT_PAYMENT_METHOD',
      'RECEIVABLE_SETTLEMENT_ACCOUNT_ID',
      'VARCHAR(64) COMMENT "政策补贴应收账户ID（全局默认）"',
      'SETTLEMENT_ACCOUNT_ID'
    );
    await checkAndAddColumn(
      'T_DICT_PAYMENT_METHOD_STORE',
      'RECEIVABLE_SETTLEMENT_ACCOUNT_ID',
      'VARCHAR(64) COMMENT "政策补贴应收账户ID"',
      'SETTLEMENT_ACCOUNT_ID'
    );
    await sequelize.query(`
      UPDATE T_DICT_PAYMENT_METHOD pm
      LEFT JOIN T_SETTLEMENT_ACCOUNT sa ON sa.ACCOUNT_ID = pm.SETTLEMENT_ACCOUNT_ID
      SET pm.SETTLEMENT_ACCOUNT_ID = NULL
      WHERE pm.SETTLEMENT_ACCOUNT_ID IS NOT NULL
        AND pm.SETTLEMENT_ACCOUNT_ID <> ''
        AND (sa.ACCOUNT_ID IS NULL OR sa.ACCOUNT_TYPE <> 'FUND' OR sa.STATUS <> 1)
    `);
    await sequelize.query(`
      UPDATE T_DICT_PAYMENT_METHOD_STORE pms
      LEFT JOIN T_SETTLEMENT_ACCOUNT sa ON sa.ACCOUNT_ID = pms.SETTLEMENT_ACCOUNT_ID
      SET pms.SETTLEMENT_ACCOUNT_ID = NULL
      WHERE pms.SETTLEMENT_ACCOUNT_ID IS NOT NULL
        AND pms.SETTLEMENT_ACCOUNT_ID <> ''
        AND (sa.ACCOUNT_ID IS NULL OR sa.ACCOUNT_TYPE <> 'FUND' OR sa.STATUS <> 1)
    `);
    await sequelize.query(`
      UPDATE T_DICT_PAYMENT_METHOD pm
      LEFT JOIN T_SETTLEMENT_ACCOUNT sa ON sa.ACCOUNT_ID = pm.RECEIVABLE_SETTLEMENT_ACCOUNT_ID
      SET pm.RECEIVABLE_SETTLEMENT_ACCOUNT_ID = NULL
      WHERE pm.RECEIVABLE_SETTLEMENT_ACCOUNT_ID IS NOT NULL
        AND pm.RECEIVABLE_SETTLEMENT_ACCOUNT_ID <> ''
        AND (sa.ACCOUNT_ID IS NULL OR sa.ACCOUNT_TYPE <> 'POLICY_RECEIVABLE' OR sa.STATUS <> 1)
    `);
    await sequelize.query(`
      UPDATE T_DICT_PAYMENT_METHOD_STORE pms
      LEFT JOIN T_SETTLEMENT_ACCOUNT sa ON sa.ACCOUNT_ID = pms.RECEIVABLE_SETTLEMENT_ACCOUNT_ID
      SET pms.RECEIVABLE_SETTLEMENT_ACCOUNT_ID = NULL
      WHERE pms.RECEIVABLE_SETTLEMENT_ACCOUNT_ID IS NOT NULL
        AND pms.RECEIVABLE_SETTLEMENT_ACCOUNT_ID <> ''
        AND (sa.ACCOUNT_ID IS NULL OR sa.ACCOUNT_TYPE <> 'POLICY_RECEIVABLE' OR sa.STATUS <> 1)
    `);
    await sequelize.query(`
      UPDATE T_DICT_PAYMENT_METHOD
      SET RECEIVABLE_SETTLEMENT_ACCOUNT_ID = 'ACC_POLICY_SUBSIDY_RECEIVABLE'
      WHERE NAME LIKE '国补%'
        AND (RECEIVABLE_SETTLEMENT_ACCOUNT_ID IS NULL OR RECEIVABLE_SETTLEMENT_ACCOUNT_ID = '')
    `);
    await sequelize.query(`
      UPDATE T_DICT_PAYMENT_METHOD_STORE pms
      INNER JOIN T_DICT_PAYMENT_METHOD pm ON pm.METHOD_ID = pms.METHOD_ID
      SET pms.RECEIVABLE_SETTLEMENT_ACCOUNT_ID = 'ACC_POLICY_SUBSIDY_RECEIVABLE'
      WHERE pm.NAME LIKE '国补%'
        AND (pms.RECEIVABLE_SETTLEMENT_ACCOUNT_ID IS NULL OR pms.RECEIVABLE_SETTLEMENT_ACCOUNT_ID = '')
    `);
    await sequelize.query(`
      UPDATE T_DAILY_STATEMENT_DETAIL
      SET SETTLEMENT_ACCOUNT_ID = 'ACC_POLICY_SUBSIDY_RECEIVABLE'
      WHERE SETTLED = 0
        AND PAYMENT_METHOD LIKE '国补%-政策补贴应收'
        AND (SETTLEMENT_ACCOUNT_ID IS NULL OR SETTLEMENT_ACCOUNT_ID = '')
    `);
    await sequelize.query(`
      INSERT IGNORE INTO T_DICT_PAYMENT_METHOD
        (METHOD_ID, NAME, CODE, ICON, RECEIVABLE_SETTLEMENT_ACCOUNT_ID, IS_GLOBAL, SORT_ORDER, STATUS)
      VALUES
        ('PM_GUOBU_OMO_COMPUTER', '国补OMO（电脑）', 'guobu_omo_computer', 'omo-icon', 'ACC_POLICY_SUBSIDY_RECEIVABLE', 1, 6, 1),
        ('PM_GUOBU_OMO_MOBILE', '国补OMO（手机平板）', 'guobu_omo_mobile', 'omo-icon', 'ACC_POLICY_SUBSIDY_RECEIVABLE', 1, 7, 1)
    `);
    await sequelize.query(`
      UPDATE T_DAILY_STATEMENT_DETAIL d
      INNER JOIN T_DAILY_STATEMENT ds ON ds.STATEMENT_ID = d.STATEMENT_ID
      INNER JOIN T_DICT_PAYMENT_METHOD pm ON d.PAYMENT_METHOD = CONCAT(pm.NAME, '-客户实收')
      LEFT JOIN T_DICT_PAYMENT_METHOD_STORE pms
        ON pms.METHOD_ID = pm.METHOD_ID AND pms.STORE_ID = ds.STORE_ID
      SET d.SETTLEMENT_ACCOUNT_ID = CASE
        WHEN pm.IS_GLOBAL = 1 THEN pm.SETTLEMENT_ACCOUNT_ID
        ELSE pms.SETTLEMENT_ACCOUNT_ID
      END
      WHERE d.SETTLED = 0
        AND (d.SETTLEMENT_ACCOUNT_ID IS NULL OR d.SETTLEMENT_ACCOUNT_ID = '')
    `);

    await checkAndCreateTable('T_SUBSIDY_ACCOUNT_ROUTE', `
      CREATE TABLE T_SUBSIDY_ACCOUNT_ROUTE (
        REGION_ID VARCHAR(32) NOT NULL,
        ACCOUNT_ID VARCHAR(64),
        UPDATE_USER VARCHAR(64),
        UPDATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (REGION_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='国补区域到账账户配置'
    `);
    await checkAndCreateTable('T_SUBSIDY_RECEIPT', `
      CREATE TABLE T_SUBSIDY_RECEIPT (
        RECEIPT_ID VARCHAR(32) NOT NULL,
        RECEIPT_NO VARCHAR(64) NOT NULL,
        REGION_ID VARCHAR(32) NOT NULL,
        ACCOUNT_ID VARCHAR(64) NOT NULL,
        ACCOUNT_NAME_SNAPSHOT VARCHAR(128) NOT NULL,
        RECEIPT_DATE DATE NOT NULL,
        BANK_REFERENCE VARCHAR(128),
        AMOUNT DECIMAL(12,2) NOT NULL,
        ALLOCATED_AMOUNT DECIMAL(12,2) DEFAULT 0,
        REFUNDED_AMOUNT DECIMAL(12,2) DEFAULT 0,
        STATUS VARCHAR(32) DEFAULT 'UNALLOCATED',
        REMARK VARCHAR(512),
        CREATE_USER VARCHAR(64),
        CREATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (RECEIPT_ID),
        UNIQUE KEY uk_subsidy_receipt_no (RECEIPT_NO),
        UNIQUE KEY uk_subsidy_bank_ref (ACCOUNT_ID, BANK_REFERENCE),
        KEY idx_subsidy_receipt_region (REGION_ID, RECEIPT_DATE)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='国补银行到账单'
    `);
    await checkAndAddIndex(
      'T_SUBSIDY_RECEIPT',
      'uk_subsidy_bank_ref',
      'ALTER TABLE T_SUBSIDY_RECEIPT ADD UNIQUE KEY uk_subsidy_bank_ref (ACCOUNT_ID, BANK_REFERENCE)'
    );
    await checkAndAddColumn('T_SUBSIDY_RECEIPT', 'REVERSE_REASON', 'VARCHAR(512) COMMENT "冲销原因"', 'CREATE_TIME');
    await checkAndAddColumn('T_SUBSIDY_RECEIPT', 'REVERSED_BY', 'VARCHAR(64) COMMENT "冲销人"', 'REVERSE_REASON');
    await checkAndAddColumn('T_SUBSIDY_RECEIPT', 'REVERSED_AT', 'DATETIME COMMENT "冲销时间"', 'REVERSED_BY');
    await checkAndCreateTable('T_SUBSIDY_RECEIPT_ALLOCATION', `
      CREATE TABLE T_SUBSIDY_RECEIPT_ALLOCATION (
        ALLOCATION_ID VARCHAR(32) NOT NULL,
        RECEIPT_ID VARCHAR(32) NOT NULL,
        DETAIL_ID VARCHAR(64) NOT NULL,
        AMOUNT DECIMAL(12,2) NOT NULL,
        CREATE_USER VARCHAR(64),
        CREATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (ALLOCATION_ID),
        KEY idx_subsidy_allocation_receipt (RECEIPT_ID),
        KEY idx_subsidy_allocation_detail (DETAIL_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='国补到账应收核销明细'
    `);
    await checkAndCreateTable('T_SUBSIDY_RECEIVABLE_ADJUSTMENT', `
      CREATE TABLE T_SUBSIDY_RECEIVABLE_ADJUSTMENT (
        ADJUSTMENT_ID VARCHAR(32) NOT NULL,
        DETAIL_ID VARCHAR(64) NOT NULL,
        ADJUSTMENT_TYPE VARCHAR(32) NOT NULL,
        AMOUNT DECIMAL(12,2) NOT NULL,
        FINANCE_CATEGORY VARCHAR(128) NOT NULL,
        REASON VARCHAR(512) NOT NULL,
        STATUS VARCHAR(32) DEFAULT 'PENDING',
        APPLICANT_ID VARCHAR(32),
        APPLICANT_NAME VARCHAR(64),
        REVIEWER_ID VARCHAR(32),
        REVIEWER_NAME VARCHAR(64),
        REVIEW_COMMENT VARCHAR(512),
        REVIEW_TIME DATETIME,
        CREATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (ADJUSTMENT_ID),
        KEY idx_subsidy_adjustment_detail (DETAIL_ID, STATUS)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='国补应收手续费及差额审批'
    `);
    await checkAndAddColumn(
      'T_SUBSIDY_RECEIVABLE_ADJUSTMENT',
      'FINANCE_CATEGORY',
      'VARCHAR(128) NOT NULL DEFAULT "待财务确认" COMMENT "财务处理科目"',
      'AMOUNT'
    );
    await sequelize.query(`
      INSERT IGNORE INTO T_SUBSIDY_ACCOUNT_ROUTE (REGION_ID, ACCOUNT_ID, UPDATE_USER)
      SELECT r.REGION_ID, a.ACCOUNT_ID, 'system'
      FROM T_REGION r, T_SETTLEMENT_ACCOUNT a
      WHERE r.NAME = '成都区域' AND a.ACCOUNT_NAME = '四川银行（艾诺云）' AND a.ACCOUNT_TYPE = 'FUND'
    `);
    await sequelize.query(`
      INSERT IGNORE INTO T_SUBSIDY_ACCOUNT_ROUTE (REGION_ID, ACCOUNT_ID, UPDATE_USER)
      SELECT r.REGION_ID, a.ACCOUNT_ID, 'system'
      FROM T_REGION r, T_SETTLEMENT_ACCOUNT a
      WHERE r.NAME = '重庆区域' AND a.ACCOUNT_NAME = '兴业银行（艾诺志兴）' AND a.ACCOUNT_TYPE = 'FUND'
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
    await checkAndAddColumn(
      'T_DICT_PAYMENT_METHOD',
      'DEFAULT_TAX_RATE',
      'DECIMAL(8,4) NOT NULL DEFAULT 0 COMMENT "默认收款手续费税率（百分数）"',
      'RECEIVABLE_SETTLEMENT_ACCOUNT_ID'
    );
    await checkAndAddColumn(
      'T_DICT_SUPPLEMENT_ITEM',
      'AMOUNT_TYPE',
      'VARCHAR(16) NOT NULL DEFAULT "increase" COMMENT "increase/decrease"',
      'AMOUNT'
    );

    await checkAndCreateTable('T_ORDER_SUPPLEMENT', `
      CREATE TABLE T_ORDER_SUPPLEMENT (
        SUPPLEMENT_ID VARCHAR(32) NOT NULL,
        ORDER_ID VARCHAR(32) NOT NULL,
        ITEM_ID VARCHAR(64),
        ITEM_NAME VARCHAR(128) NOT NULL,
        AMOUNT DECIMAL(12,2) NOT NULL,
        AMOUNT_TYPE VARCHAR(16) NOT NULL DEFAULT 'increase',
        CONTENT VARCHAR(500),
        PROOF_PHOTO_URL VARCHAR(1024),
        COUPON_CODE VARCHAR(128),
        COUPON_OCR_TEXT TEXT,
        CREATE_STAFF_ID BIGINT(20),
        CREATE_USER VARCHAR(64),
        CREATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP,
        UPDATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        IS_DELETED TINYINT(1) DEFAULT 0,
        PRIMARY KEY (SUPPLEMENT_ID),
        KEY idx_order_supplement (ORDER_ID, IS_DELETED)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单金额补录记录'
    `);
    await checkAndAddColumn('T_ORDER_SUPPLEMENT', 'COUPON_CODE', 'VARCHAR(128) COMMENT "补录优惠券码"', 'PROOF_PHOTO_URL');
    await checkAndAddColumn('T_ORDER_SUPPLEMENT', 'COUPON_OCR_TEXT', 'TEXT COMMENT "补录券码OCR原文"', 'COUPON_CODE');

    await checkAndCreateTable('T_SALES_RETURN_REQUEST', `
      CREATE TABLE T_SALES_RETURN_REQUEST (
        RETURN_ID VARCHAR(32) NOT NULL,
        RETURN_NO VARCHAR(64) NOT NULL,
        ORDER_ID VARCHAR(32) NOT NULL,
        ORDER_NO VARCHAR(64) NOT NULL,
        STORE_ID VARCHAR(32) NOT NULL,
        CUSTOMER_NAME VARCHAR(64),
        CUSTOMER_PHONE VARCHAR(32),
        RETURN_TYPE VARCHAR(32) NOT NULL DEFAULT 'full',
        REFUND_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0,
        REASON VARCHAR(512),
        STATUS VARCHAR(32) NOT NULL DEFAULT 'pending',
        APPROVAL_STAGE VARCHAR(32) NOT NULL DEFAULT 'pending_store',
        STORE_REVIEW_USER VARCHAR(64),
        STORE_REVIEW_COMMENT VARCHAR(512),
        STORE_REVIEW_TIME DATETIME,
        DISTRIBUTOR_REVIEW_USER VARCHAR(64),
        DISTRIBUTOR_REVIEW_COMMENT VARCHAR(512),
        DISTRIBUTOR_REVIEW_TIME DATETIME,
        CREATE_STAFF_ID BIGINT(20),
        CREATE_USER VARCHAR(64),
        CREATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP,
        UPDATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (RETURN_ID),
        UNIQUE KEY uk_sales_return_no (RETURN_NO),
        KEY idx_sales_return_order (ORDER_ID, STATUS),
        KEY idx_sales_return_store (STORE_ID, STATUS, CREATE_TIME),
        KEY idx_sales_return_stage (STATUS, APPROVAL_STAGE, CREATE_TIME)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='销售退单申请'
    `);
    await checkAndAddColumn('T_SALES_RETURN_REQUEST', 'RETURN_GOV_SUBSIDY', 'TINYINT(1) NOT NULL DEFAULT 0 COMMENT "是否退回已核销国补资格"', 'REFUND_AMOUNT');
    await checkAndAddColumn('T_SALES_RETURN_REQUEST', 'POLICY_SUBSIDY_REFUND_AMOUNT', 'DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT "退回国补资格时冲减的政策补贴应收"', 'RETURN_GOV_SUBSIDY');
    await checkAndAddColumn('T_SALES_RETURN_REQUEST', 'RESOURCE_RETURN_ACTIONS', 'TEXT COMMENT "退单时资源权益处理快照"', 'POLICY_SUBSIDY_REFUND_AMOUNT');

    await checkAndCreateTable('T_SALES_RETURN_REQUEST_ITEM', `
      CREATE TABLE T_SALES_RETURN_REQUEST_ITEM (
        ITEM_ID BIGINT(20) NOT NULL AUTO_INCREMENT,
        RETURN_ID VARCHAR(32) NOT NULL,
        ORDER_ITEM_ID BIGINT(20),
        PRODUCT_ID VARCHAR(32),
        PRODUCT_NAME VARCHAR(255),
        PN_CODE VARCHAR(64),
        SN_CODE VARCHAR(128),
        QUANTITY INT NOT NULL DEFAULT 1,
        UNIT_PRICE DECIMAL(12,2) NOT NULL DEFAULT 0,
        SUBTOTAL DECIMAL(12,2) NOT NULL DEFAULT 0,
        PRIMARY KEY (ITEM_ID),
        KEY idx_sales_return_item_return (RETURN_ID),
        KEY idx_sales_return_item_order (ORDER_ITEM_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='销售退单申请明细'
    `);

    await checkAndCreateTable('T_SALES_RETURN_SETTLEMENT', `
      CREATE TABLE T_SALES_RETURN_SETTLEMENT (
        SETTLEMENT_ID VARCHAR(32) NOT NULL,
        SETTLEMENT_NO VARCHAR(64) NOT NULL,
        RETURN_ID VARCHAR(32) NOT NULL,
        RETURN_NO VARCHAR(64) NOT NULL,
        ORDER_ID VARCHAR(32) NOT NULL,
        ORDER_NO VARCHAR(64) NOT NULL,
        STORE_ID VARCHAR(32) NOT NULL,
        USER_RECEIVABLE_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0,
        CUSTOMER_RECEIVED_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0,
        POLICY_SUBSIDY_RECEIVABLE_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0,
        EDUCATION_SUBSIDY_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0,
        CUSTOMER_REFUND_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0,
        SETTLEMENT_STATUS VARCHAR(32) NOT NULL DEFAULT 'pending_refund',
        REFUND_METHOD VARCHAR(128),
        REFUND_REMARK VARCHAR(512),
        FINANCE_CONFIRM_USER VARCHAR(64),
        FINANCE_CONFIRM_TIME DATETIME,
        RED_INVOICE_STATUS VARCHAR(32) NOT NULL DEFAULT 'not_required',
        RED_INVOICE_ID VARCHAR(32),
        SNAPSHOT_JSON TEXT,
        CREATE_USER VARCHAR(64),
        CREATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP,
        UPDATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (SETTLEMENT_ID),
        UNIQUE KEY UK_SALES_RETURN_SETTLEMENT_NO (SETTLEMENT_NO),
        UNIQUE KEY UK_SALES_RETURN_SETTLEMENT_RETURN (RETURN_ID),
        KEY IDX_SALES_RETURN_SETTLEMENT_ORDER (ORDER_ID, CREATE_TIME),
        KEY IDX_SALES_RETURN_SETTLEMENT_STORE (STORE_ID, CREATE_TIME),
        KEY IDX_SALES_RETURN_SETTLEMENT_STATUS (SETTLEMENT_STATUS, CREATE_TIME)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='销售退单负向结算'
    `);
    await checkAndCreateTable('T_SALES_RETURN_SETTLEMENT_ITEM', `
      CREATE TABLE T_SALES_RETURN_SETTLEMENT_ITEM (
        SETTLEMENT_ITEM_ID VARCHAR(32) NOT NULL,
        SETTLEMENT_ID VARCHAR(32) NOT NULL,
        RETURN_ID VARCHAR(32) NOT NULL,
        ORDER_ITEM_ID BIGINT(20),
        PRODUCT_ID VARCHAR(32),
        PRODUCT_NAME VARCHAR(255),
        QUANTITY INT NOT NULL DEFAULT 0,
        USER_RECEIVABLE_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0,
        CUSTOMER_RECEIVED_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0,
        POLICY_SUBSIDY_RECEIVABLE_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0,
        EDUCATION_SUBSIDY_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0,
        CREATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (SETTLEMENT_ITEM_ID),
        KEY IDX_SALES_RETURN_SETTLEMENT_ITEM_SETTLEMENT (SETTLEMENT_ID),
        KEY IDX_SALES_RETURN_SETTLEMENT_ITEM_RETURN (RETURN_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='销售退单负向结算明细'
    `);
    await checkAndCreateTable('T_SALES_RETURN_RED_INVOICE', `
      CREATE TABLE T_SALES_RETURN_RED_INVOICE (
        RED_INVOICE_ID VARCHAR(32) NOT NULL,
        RETURN_ID VARCHAR(32) NOT NULL,
        SETTLEMENT_ID VARCHAR(32) NOT NULL,
        ORDER_ID VARCHAR(32) NOT NULL,
        ORDER_NO VARCHAR(64) NOT NULL,
        AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0,
        STATUS VARCHAR(32) NOT NULL DEFAULT 'pending',
        INVOICE_NO VARCHAR(128),
        CREATE_USER VARCHAR(64),
        CREATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP,
        CONFIRM_USER VARCHAR(64),
        CONFIRM_TIME DATETIME,
        PRIMARY KEY (RED_INVOICE_ID),
        UNIQUE KEY UK_SALES_RETURN_RED_INVOICE_RETURN (RETURN_ID),
        KEY IDX_SALES_RETURN_RED_INVOICE_SETTLEMENT (SETTLEMENT_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='销售退单红字发票处理记录'
    `);

    await checkAndCreateTable('T_ORDER_GROSS_PROFIT', `
      CREATE TABLE T_ORDER_GROSS_PROFIT (
        GROSS_PROFIT_ID VARCHAR(32) NOT NULL,
        ORDER_ID VARCHAR(32) NOT NULL,
        ORDER_NO VARCHAR(64) NOT NULL,
        STORE_ID VARCHAR(32) NOT NULL,
        FORMULA_VERSION VARCHAR(32) NOT NULL,
        RECEIVED_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0,
        RECEIVABLE_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0,
        SETTLEMENT_COST_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0,
        PRODUCT_PRICING_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0,
        PAYMENT_FEE_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0,
        INVOICE_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0,
        VAT_TAXABLE_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0,
        VAT_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0,
        SUPPLEMENT_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0,
        GROSS_PROFIT_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0,
        PAYMENT_FEE_DETAILS JSON,
        SETTLEMENT_COST_DETAILS JSON,
        PRODUCT_PRICING_DETAILS JSON,
        SUPPLEMENT_DETAILS JSON,
        SNAPSHOT_STATUS VARCHAR(16) NOT NULL DEFAULT 'draft',
        CALCULATED_BY VARCHAR(64),
        CALCULATED_AT DATETIME DEFAULT CURRENT_TIMESTAMP,
        CREATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP,
        UPDATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (GROSS_PROFIT_ID),
        UNIQUE KEY uk_order_gross_profit (ORDER_ID),
        KEY idx_gross_profit_analysis (STORE_ID, SNAPSHOT_STATUS, CALCULATED_AT)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单经营毛利计算快照'
    `);
    await checkAndAddColumn(
      'T_ORDER_GROSS_PROFIT',
      'RECEIVABLE_AMOUNT',
      'DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT "用户应收"',
      'RECEIVED_AMOUNT'
    );
    await checkAndAddColumn(
      'T_ORDER_GROSS_PROFIT',
      'PRODUCT_PRICING_AMOUNT',
      'DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT "订单产品定价合计"',
      'SETTLEMENT_COST_AMOUNT'
    );
    await checkAndCreateTable('T_SALES_RETURN_GROSS_PROFIT', `
      CREATE TABLE T_SALES_RETURN_GROSS_PROFIT (
        LEDGER_ID VARCHAR(32) NOT NULL,
        RETURN_ID VARCHAR(32) NOT NULL,
        RETURN_NO VARCHAR(64) NOT NULL,
        ORDER_ID VARCHAR(32) NOT NULL,
        ORDER_NO VARCHAR(64) NOT NULL,
        STORE_ID VARCHAR(32) NOT NULL,
        PARTICIPANT_KEY VARCHAR(128) NOT NULL,
        STAFF_ID BIGINT(20),
        EMPLOYEE_NAME VARCHAR(64) NOT NULL,
        PARTICIPANT_ROLE VARCHAR(32) NOT NULL DEFAULT 'primary',
        RETURNED_SALES_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0,
        GROSS_PROFIT_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0,
        REASON VARCHAR(512) NOT NULL,
        CREATE_USER VARCHAR(64),
        CREATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (LEDGER_ID),
        UNIQUE KEY uk_return_gp_participant (RETURN_ID, PARTICIPANT_KEY),
        KEY idx_return_gp_order (ORDER_ID, CREATE_TIME),
        KEY idx_return_gp_staff (STAFF_ID, CREATE_TIME),
        KEY idx_return_gp_store (STORE_ID, CREATE_TIME)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='销售退单负向个人毛利台账'
    `);

    await checkAndAddColumn(
      'T_ORDER_GROSS_PROFIT',
      'PRODUCT_PRICING_DETAILS',
      'JSON COMMENT "订单产品定价明细"',
      'SETTLEMENT_COST_DETAILS'
    );
    await checkAndAddColumn(
      'T_ORDER_GROSS_PROFIT',
      'FREIGHT_COST_AMOUNT',
      'DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT "最近一次运费成本"',
      'SUPPLEMENT_AMOUNT'
    );
    await checkAndAddColumn(
      'T_ORDER_ITEM',
      'FREIGHT_COST',
      'DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT "销售时扣减的最近一次运费成本"',
      'SALES_GROSS_PROFIT'
    );
    await checkAndAddColumn(
      'T_PURCHASE_REQUEST',
      'FREIGHT_PLATFORM_ID',
      'VARCHAR(32) COMMENT "配送平台ID"',
      'ACTUAL_TOTAL'
    );
    await checkAndAddColumn(
      'T_PURCHASE_REQUEST',
      'FREIGHT_PLATFORM_NAME',
      'VARCHAR(64) COMMENT "配送平台名称快照"',
      'FREIGHT_PLATFORM_ID'
    );
    await checkAndAddColumn(
      'T_PURCHASE_REQUEST',
      'FREIGHT_AMOUNT',
      'DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT "运费金额"',
      'FREIGHT_PLATFORM_NAME'
    );
    await checkAndAddColumn(
      'T_TRANSFER',
      'FREIGHT_PLATFORM_ID',
      'VARCHAR(32) COMMENT "配送平台ID"',
      'TO_STORE_ID'
    );
    await checkAndAddColumn(
      'T_TRANSFER',
      'FREIGHT_PLATFORM_NAME',
      'VARCHAR(64) COMMENT "配送平台名称快照"',
      'FREIGHT_PLATFORM_ID'
    );
    await checkAndAddColumn(
      'T_TRANSFER',
      'FREIGHT_AMOUNT',
      'DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT "运费金额"',
      'FREIGHT_PLATFORM_NAME'
    );

    await checkAndCreateTable('T_FREIGHT_PLATFORM', `
      CREATE TABLE T_FREIGHT_PLATFORM (
        PLATFORM_ID VARCHAR(32) NOT NULL,
        PLATFORM_NAME VARCHAR(64) NOT NULL,
        SORT_ORDER INT NOT NULL DEFAULT 0,
        STATUS TINYINT(1) NOT NULL DEFAULT 1,
        CREATE_USER VARCHAR(64),
        CREATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP,
        UPDATE_USER VARCHAR(64),
        UPDATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (PLATFORM_ID),
        UNIQUE KEY uk_freight_platform_name (PLATFORM_NAME),
        KEY idx_freight_platform_status (STATUS, SORT_ORDER)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='运费配送平台'
    `);
    await checkAndCreateTable('T_FREIGHT_RECORD', `
      CREATE TABLE T_FREIGHT_RECORD (
        FREIGHT_ID VARCHAR(32) NOT NULL,
        SOURCE_TYPE VARCHAR(32) NOT NULL,
        SOURCE_ID VARCHAR(32) NOT NULL,
        SOURCE_NO VARCHAR(64),
        PLATFORM_ID VARCHAR(32),
        PLATFORM_NAME VARCHAR(64),
        AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0,
        STORE_ID VARCHAR(32),
        STORE_NAME VARCHAR(255),
        FROM_STORE_ID VARCHAR(32),
        FROM_STORE_NAME VARCHAR(255),
        TO_STORE_ID VARCHAR(32),
        TO_STORE_NAME VARCHAR(255),
        STATUS VARCHAR(32) NOT NULL DEFAULT 'active',
        CREATE_USER VARCHAR(64),
        CREATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP,
        UPDATE_USER VARCHAR(64),
        UPDATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (FREIGHT_ID),
        UNIQUE KEY uk_freight_source (SOURCE_TYPE, SOURCE_ID),
        KEY idx_freight_filter (CREATE_TIME, STORE_ID, PLATFORM_ID),
        KEY idx_freight_source (SOURCE_TYPE, SOURCE_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='采购及调拨运费记录'
    `);
    await checkAndCreateTable('T_FREIGHT_RECORD_ITEM', `
      CREATE TABLE T_FREIGHT_RECORD_ITEM (
        ITEM_ID BIGINT(20) NOT NULL AUTO_INCREMENT,
        FREIGHT_ID VARCHAR(32) NOT NULL,
        PRODUCT_ID VARCHAR(32),
        SN_ID VARCHAR(32),
        SN_CODE VARCHAR(128),
        QUANTITY INT NOT NULL DEFAULT 1,
        ALLOCATED_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0,
        UNIT_AMOUNT DECIMAL(12,2) NOT NULL DEFAULT 0,
        CREATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (ITEM_ID),
        KEY idx_freight_item_freight (FREIGHT_ID),
        KEY idx_freight_item_product (PRODUCT_ID, CREATE_TIME),
        KEY idx_freight_item_sn (SN_ID, SN_CODE, CREATE_TIME)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='运费商品分摊明细'
    `);
    await sequelize.query(`
      INSERT INTO T_FREIGHT_PLATFORM (PLATFORM_ID, PLATFORM_NAME, SORT_ORDER, STATUS)
      VALUES ('platform_shansong', '闪送', 1, 1), ('platform_sf', '顺丰', 2, 1), ('platform_other', '其他', 3, 1)
      ON DUPLICATE KEY UPDATE STATUS = VALUES(STATUS), SORT_ORDER = VALUES(SORT_ORDER)
    `);
    await sequelize.query(`
      UPDATE T_ORDER_GROSS_PROFIT
      SET RECEIVABLE_AMOUNT = RECEIVED_AMOUNT
      WHERE RECEIVABLE_AMOUNT = 0
        AND RECEIVED_AMOUNT <> 0
    `);
    await sequelize.query(`
      UPDATE T_PRODUCT_PRICE
      SET STANDARD_PRICE = COST_PRICE,
          EFFECTIVE_TIME = COALESCE(EFFECTIVE_TIME, CURRENT_TIMESTAMP)
      WHERE COALESCE(STANDARD_PRICE, 0) = 0
        AND COALESCE(COST_PRICE, 0) > 0
    `);

    await checkAndCreateTable('T_LOCATION', `
      CREATE TABLE T_LOCATION (
        LOCATION_ID VARCHAR(32) NOT NULL COMMENT '仓位实例ID',
        STORE_ID VARCHAR(32) NOT NULL COMMENT '门店ID',
        NAME VARCHAR(64) NOT NULL COMMENT '仓位名称',
        TYPE VARCHAR(32) DEFAULT 'normal_qty' COMMENT '仓位编码',
        IS_SELLABLE TINYINT(1) DEFAULT 1 COMMENT '是否可销售',
        STATUS TINYINT DEFAULT 1 COMMENT '状态',
        PRIMARY KEY (LOCATION_ID),
        KEY idx_location_store_status (STORE_ID, STATUS),
        KEY idx_location_name (NAME)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='门店标准仓位'
    `);
    await checkAndAddColumn('T_LOCATION', 'TYPE', 'VARCHAR(32) DEFAULT "normal_qty" COMMENT "仓位编码"', 'NAME');
    await checkAndAddColumn('T_LOCATION', 'IS_SELLABLE', 'TINYINT(1) DEFAULT 1 COMMENT "是否可销售"', 'TYPE');
    await checkAndAddColumn('T_LOCATION', 'STATUS', 'TINYINT DEFAULT 1 COMMENT "状态"', 'IS_SELLABLE');
    await checkAndAddIndex('T_LOCATION', 'idx_location_store_status', 'ALTER TABLE T_LOCATION ADD INDEX idx_location_store_status (STORE_ID, STATUS)');
    await checkAndAddIndex('T_LOCATION', 'idx_location_store_type', 'ALTER TABLE T_LOCATION ADD INDEX idx_location_store_type (STORE_ID, TYPE)');
    const standardLocations = [
      ['normal_qty', '销售仓', 1],
      ['demo_qty', '样品仓', 1],
      ['display_qty', '铺货仓', 1],
      ['unsellable_qty', '不可售仓', 0],
      ['pending_qty', '占用仓', 0],
      ['rental_demo_qty', '租赁样机仓', 0]
    ];
    for (const [type, name, isSellable] of standardLocations) {
      await sequelize.query(`
        INSERT INTO T_LOCATION (LOCATION_ID, STORE_ID, NAME, TYPE, IS_SELLABLE, STATUS)
        SELECT CONCAT('LOC', LEFT(MD5(CONCAT(s.STORE_ID, ':${type}')), 20)), s.STORE_ID, '${name}', '${type}', ${isSellable}, 1
        FROM T_STORE s
        WHERE COALESCE(s.IS_DELETED, 0) = 0
          AND NOT EXISTS (
            SELECT 1 FROM T_LOCATION l
            WHERE l.STORE_ID = s.STORE_ID AND l.TYPE = '${type}'
          )
      `);
    }

    await checkAndCreateTable('T_INVENTORY', `
      CREATE TABLE T_INVENTORY (
        INVENTORY_ID VARCHAR(32) NOT NULL PRIMARY KEY COMMENT '库存ID',
        PRODUCT_ID VARCHAR(32) NOT NULL COMMENT '商品ID',
        STORE_ID VARCHAR(32) NOT NULL DEFAULT '' COMMENT '门店ID',
        NORMAL_QTY INT DEFAULT 0 COMMENT '现有库存',
        DISPLAY_QTY INT DEFAULT 0 COMMENT '铺货仓库存',
        DEMO_QTY INT DEFAULT 0 COMMENT '样品仓库存',
        UNSELLABLE_QTY INT DEFAULT 0 COMMENT '不可售库存',
        PENDING_QTY INT DEFAULT 0 COMMENT '占用仓库存',
        RENTAL_DEMO_QTY INT DEFAULT 0 COMMENT '租赁样机仓库存',
        UPDATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
        UNIQUE KEY uk_product_store (PRODUCT_ID, STORE_ID),
        KEY idx_product (PRODUCT_ID),
        KEY idx_store (STORE_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='库存聚合表'
    `);

    await checkAndCreateTable('T_INVENTORY_BATCH_APPLICATION', `
      CREATE TABLE T_INVENTORY_BATCH_APPLICATION (
        APPLICATION_ID VARCHAR(32) NOT NULL COMMENT '申请ID',
        APPLICATION_NO VARCHAR(64) NOT NULL COMMENT '申请单号',
        OPERATION_TYPE VARCHAR(32) NOT NULL COMMENT 'INBOUND/OUTBOUND/ADJUST',
        TRIGGER_RESOURCE_RIGHTS TINYINT(1) DEFAULT 0 COMMENT '出库是否触发资源权益',
        SOURCE_FILE_NAME VARCHAR(255) COMMENT '导入文件名',
        STORE_IDS TEXT COMMENT '涉及门店JSON',
        TOTAL_ROWS INT DEFAULT 0 COMMENT '总行数',
        VALID_ROWS INT DEFAULT 0 COMMENT '有效行数',
        ERROR_ROWS INT DEFAULT 0 COMMENT '错误行数',
        STATUS VARCHAR(32) DEFAULT 'pending' COMMENT 'pending/executing/executed/partially_executed/rejected/execute_failed',
        ERROR_JSON TEXT COMMENT '校验错误JSON',
        EXECUTE_ERROR VARCHAR(1000) COMMENT '后台执行失败原因',
        EXECUTE_ATTEMPTS INT DEFAULT 0 COMMENT '后台执行尝试次数',
        EXECUTE_START_TIME DATETIME COMMENT '后台执行开始时间',
        APPLICANT_STAFF_ID BIGINT COMMENT '申请人员工ID',
        APPLICANT_NAME VARCHAR(64) COMMENT '申请人',
        APPLICANT_DISTRIBUTOR_ID VARCHAR(32) COMMENT '申请人经销商',
        REVIEWER_STAFF_ID BIGINT COMMENT '审批人员工ID',
        REVIEWER_NAME VARCHAR(64) COMMENT '审批人',
        REVIEW_COMMENT VARCHAR(512) COMMENT '审批意见',
        REVIEW_TIME DATETIME COMMENT '审批时间',
        EXECUTE_TIME DATETIME COMMENT '执行时间',
        CREATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        UPDATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
        REMARK VARCHAR(512) COMMENT '备注',
        PRIMARY KEY (APPLICATION_ID),
        UNIQUE KEY uk_inventory_batch_no (APPLICATION_NO),
        KEY idx_inventory_batch_status (STATUS, CREATE_TIME),
        KEY idx_inventory_batch_applicant (APPLICANT_STAFF_ID, CREATE_TIME)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='库存批量维护申请单'
    `);
    await ensureColumnType(
      'T_INVENTORY_BATCH_APPLICATION',
      'ERROR_JSON',
      ['mediumtext', 'longtext'],
      'MEDIUMTEXT COMMENT "校验错误JSON"'
    );
    await checkAndAddColumn('T_INVENTORY_BATCH_APPLICATION', 'EXECUTE_ERROR', 'VARCHAR(1000) COMMENT "后台执行失败原因"', 'ERROR_JSON');
    await checkAndAddColumn('T_INVENTORY_BATCH_APPLICATION', 'EXECUTE_ATTEMPTS', 'INT DEFAULT 0 COMMENT "后台执行尝试次数"', 'EXECUTE_ERROR');
    await checkAndAddColumn('T_INVENTORY_BATCH_APPLICATION', 'EXECUTE_START_TIME', 'DATETIME COMMENT "后台执行开始时间"', 'EXECUTE_ATTEMPTS');

    await checkAndCreateTable('T_INVENTORY_BATCH_APPLICATION_ITEM', `
      CREATE TABLE T_INVENTORY_BATCH_APPLICATION_ITEM (
        ITEM_ID BIGINT NOT NULL AUTO_INCREMENT COMMENT '明细ID',
        APPLICATION_ID VARCHAR(32) NOT NULL COMMENT '申请ID',
        ROW_NO INT NOT NULL COMMENT 'Excel行号',
        OPERATION_TYPE VARCHAR(32) NOT NULL COMMENT 'INBOUND/OUTBOUND/ADJUST',
        PRODUCT_ID VARCHAR(32) COMMENT '商品ID',
        PRODUCT_CODE VARCHAR(32) COMMENT '商品编码',
        PRODUCT_NAME VARCHAR(255) COMMENT '商品名称快照',
        NEED_SN TINYINT(1) DEFAULT 0 COMMENT '是否SN商品',
        PN_CODE VARCHAR(64) COMMENT 'PN',
        SN_ID VARCHAR(32) COMMENT 'SN记录ID',
        SN_CODE VARCHAR(128) COMMENT 'SN',
        STORE_ID VARCHAR(32) COMMENT '门店ID',
        LOCATION_ID VARCHAR(32) COMMENT '库位ID',
        INVENTORY_TYPE VARCHAR(32) DEFAULT 'normal_qty' COMMENT '库存字段',
        QUANTITY INT DEFAULT 0 COMMENT '调整数量',
        BEFORE_QTY INT DEFAULT 0 COMMENT '调整前数量',
        AFTER_QTY INT DEFAULT 0 COMMENT '调整后数量',
        UNIT_PRICE DECIMAL(12,2) DEFAULT 0 COMMENT '入库单价',
        ORIGINAL_PICKUP_PRICE DECIMAL(12,2) DEFAULT 0 COMMENT '原始提货价',
        RESOURCE_TYPES TEXT COMMENT '资源权益JSON',
        TRIGGER_RESOURCE_RIGHTS TINYINT(1) DEFAULT 0 COMMENT '是否触发权益',
        VALIDATION_STATUS VARCHAR(32) DEFAULT 'valid' COMMENT 'valid/error',
        ERROR_MESSAGE VARCHAR(1000) COMMENT '错误信息',
        RAW_JSON TEXT COMMENT '原始行JSON',
        RESULT_JSON TEXT COMMENT '执行结果JSON',
        CREATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        REMARK VARCHAR(512) COMMENT '备注',
        PRIMARY KEY (ITEM_ID),
        KEY idx_inventory_batch_item_app (APPLICATION_ID, ROW_NO),
        KEY idx_inventory_batch_item_store (STORE_ID, PRODUCT_ID),
        KEY idx_inventory_batch_item_sn (SN_CODE)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='库存批量维护申请明细'
    `);
    await checkAndAddColumn('T_INVENTORY_BATCH_APPLICATION_ITEM', 'EXECUTE_STATUS', 'VARCHAR(32) DEFAULT "pending" COMMENT "pending/success/failed"', 'ERROR_MESSAGE');
    await checkAndAddColumn('T_INVENTORY_BATCH_APPLICATION_ITEM', 'EXECUTE_ERROR', 'VARCHAR(1000) COMMENT "明细执行失败原因"', 'EXECUTE_STATUS');
    await checkAndAddColumn('T_INVENTORY_BATCH_APPLICATION_ITEM', 'EXECUTE_TIME', 'DATETIME COMMENT "明细执行时间"', 'EXECUTE_ERROR');

    await checkAndCreateTable('T_NON_SN_INVENTORY_BATCH_RIGHT', `
      CREATE TABLE T_NON_SN_INVENTORY_BATCH_RIGHT (
        RIGHT_ID VARCHAR(32) NOT NULL COMMENT '批次权益ID',
        APPLICATION_ID VARCHAR(32) NOT NULL COMMENT '来源批量申请ID',
        ITEM_ID BIGINT COMMENT '来源明细ID',
        PRODUCT_ID VARCHAR(32) NOT NULL COMMENT '商品ID',
        STORE_ID VARCHAR(32) NOT NULL COMMENT '门店ID',
        LOCATION_ID VARCHAR(32) NOT NULL DEFAULT '' COMMENT '库位ID',
        RESOURCE_TYPE VARCHAR(32) NOT NULL COMMENT '资源类型',
        RULE_CONFIG_ID VARCHAR(32) COMMENT '规则ID',
        TOTAL_QUANTITY INT NOT NULL DEFAULT 0 COMMENT '批次数量',
        REMAINING_QUANTITY INT NOT NULL DEFAULT 0 COMMENT '剩余数量',
        AMOUNT_PER_UNIT DECIMAL(12,2) DEFAULT 0 COMMENT '单件权益金额',
        SOURCE_TYPE VARCHAR(32) DEFAULT 'BATCH_INBOUND' COMMENT '来源类型',
        STATUS VARCHAR(32) DEFAULT 'AVAILABLE' COMMENT 'AVAILABLE/USED/VOIDED',
        CREATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        UPDATE_TIME DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
        REMARK VARCHAR(512) COMMENT '备注',
        PRIMARY KEY (RIGHT_ID),
        KEY idx_non_sn_right_scope (PRODUCT_ID, STORE_ID, LOCATION_ID, RESOURCE_TYPE, STATUS),
        KEY idx_non_sn_right_application (APPLICATION_ID, ITEM_ID)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='非SN库存批次资源权益'
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
        SHOW_IN_FINANCE TINYINT DEFAULT 0 COMMENT '是否展示在财务页面',
        STATUS TINYINT DEFAULT 1 COMMENT '状态',
        PRIMARY KEY (CATEGORY_ID),
        KEY idx_parent (PARENT_ID),
        KEY idx_level (LEVEL)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='商品分类表'
    `);
    await checkAndAddColumn('T_PRODUCT_CATEGORY', 'SHOW_IN_FINANCE', 'TINYINT DEFAULT 0 COMMENT \'是否展示在财务页面\'', 'SORT_ORDER');
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
    await checkAndAddColumn('T_PRODUCT_PRICE', 'RETAIL_PRICE', 'DECIMAL(12,2) DEFAULT 0 COMMENT "零售价（销售默认带入价）"', 'STANDARD_PRICE');

    await checkAndCreateTable('T_PRODUCT_IMPORT_TASK', `
      CREATE TABLE T_PRODUCT_IMPORT_TASK (
        TASK_ID VARCHAR(32) NOT NULL COMMENT '导入任务ID',
        TASK_NO VARCHAR(64) NOT NULL COMMENT '导入任务号',
        IMPORT_TYPE VARCHAR(32) NOT NULL COMMENT '导入类型:product/price',
        SOURCE_FILE_NAME VARCHAR(255) COMMENT '来源文件名',
        FILE_DATA LONGBLOB NOT NULL COMMENT '待处理Excel文件',
        TOTAL_ROWS INT DEFAULT 0 COMMENT '文件总行数',
        PROCESSED_ROWS INT DEFAULT 0 COMMENT '已处理行数',
        VALID_ROWS INT DEFAULT 0 COMMENT '校验通过行数',
        SUCCESS_ROWS INT DEFAULT 0 COMMENT '成功行数',
        FAILED_ROWS INT DEFAULT 0 COMMENT '失败行数',
        AFFECTED_PRODUCTS INT DEFAULT 0 COMMENT '影响商品数',
        PRICE_CHANGES INT DEFAULT 0 COMMENT '价格变更数',
        PENDING_CHANGES INT DEFAULT 0 COMMENT '待生效价格变更数',
        EFFECTIVE_CHANGES INT DEFAULT 0 COMMENT '已生效价格变更数',
        BATCH_NO VARCHAR(64) COMMENT '价格导入批次号',
        STATUS VARCHAR(32) DEFAULT 'queued' COMMENT '状态:queued/processing/completed/partial_failed/failed',
        ERROR_JSON LONGTEXT COMMENT '失败行快照',
        ERROR_MESSAGE VARCHAR(1000) COMMENT '任务失败原因',
        CREATE_USER VARCHAR(64) COMMENT '提交人',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        START_TIME DATETIME COMMENT '开始处理时间',
        FINISH_TIME DATETIME COMMENT '完成时间',
        PRIMARY KEY (TASK_ID),
        UNIQUE KEY uk_product_import_task_no (TASK_NO),
        KEY idx_product_import_task_status (STATUS, CREATE_TIME)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='商品及定价异步导入任务'
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
        PRICE_FIELD VARCHAR(32) NOT NULL COMMENT '价格字段:standard_price/retail_price/min_sale_price',
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

    await checkAndCreateTable('T_SN_DISTRIBUTOR_PRICE', `
      CREATE TABLE T_SN_DISTRIBUTOR_PRICE (
        PRICE_ID VARCHAR(32) NOT NULL COMMENT 'SN特价ID',
        SN_ID VARCHAR(32) NOT NULL COMMENT 'SN记录ID',
        SN_CODE VARCHAR(128) NOT NULL COMMENT 'SN快照',
        DISTRIBUTOR_ID VARCHAR(32) NOT NULL COMMENT '经销商ID',
        SPECIAL_PRICE DECIMAL(12,2) NOT NULL COMMENT 'SN销售特价',
        STATUS TINYINT(1) DEFAULT 1 COMMENT '1生效 0已取消',
        REMARK VARCHAR(512) COMMENT '备注',
        CREATE_STAFF_ID BIGINT COMMENT '创建人员工ID',
        CREATE_USER VARCHAR(64) COMMENT '创建人',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        UPDATE_STAFF_ID BIGINT COMMENT '更新人员工ID',
        UPDATE_USER VARCHAR(64) COMMENT '更新人',
        UPDATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
        PRIMARY KEY (PRICE_ID),
        UNIQUE KEY uk_sn_distributor_price (SN_ID, DISTRIBUTOR_ID),
        KEY idx_sn_distributor_price_scope (DISTRIBUTOR_ID, STATUS, UPDATE_TIME),
        KEY idx_sn_distributor_price_sn_code (SN_CODE)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='经销商SN销售特价'
    `);

    await checkAndCreateTable('T_SN_DISTRIBUTOR_PRICE_CHANGE_LOG', `
      CREATE TABLE T_SN_DISTRIBUTOR_PRICE_CHANGE_LOG (
        CHANGE_ID VARCHAR(32) NOT NULL COMMENT '变更ID',
        PRICE_ID VARCHAR(32) NOT NULL COMMENT 'SN特价ID',
        SN_ID VARCHAR(32) NOT NULL COMMENT 'SN记录ID',
        SN_CODE VARCHAR(128) NOT NULL COMMENT 'SN快照',
        DISTRIBUTOR_ID VARCHAR(32) NOT NULL COMMENT '经销商ID',
        ACTION VARCHAR(32) NOT NULL COMMENT 'SET/UPDATE/CANCEL',
        OLD_PRICE DECIMAL(12,2) COMMENT '变更前价格',
        NEW_PRICE DECIMAL(12,2) COMMENT '变更后价格',
        REMARK VARCHAR(512) COMMENT '调价原因或备注',
        OPERATOR_STAFF_ID BIGINT COMMENT '操作人员工ID',
        OPERATOR_NAME VARCHAR(64) COMMENT '操作人',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '操作时间',
        PRIMARY KEY (CHANGE_ID),
        KEY idx_sn_price_change_price (PRICE_ID, CREATE_TIME),
        KEY idx_sn_price_change_scope (SN_ID, DISTRIBUTOR_ID, CREATE_TIME)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='经销商SN特价变更记录'
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

    await checkAndCreateTable('T_PRODUCT_APPLICATION', `
      CREATE TABLE IF NOT EXISTS T_PRODUCT_APPLICATION (
        APPLICATION_ID VARCHAR(32) NOT NULL COMMENT '申请ID',
        APPLICATION_NO VARCHAR(64) NOT NULL COMMENT '申请单号',
        PRODUCT_NAME VARCHAR(255) NOT NULL COMMENT '拟新建商品名称',
        CATEGORY_ID VARCHAR(32) COMMENT '商品分类ID',
        CATEGORY_NAME VARCHAR(512) COMMENT '商品分类路径',
        PAYLOAD_JSON JSON NOT NULL COMMENT '商品创建参数快照',
        APPLICANT_STAFF_ID BIGINT NOT NULL COMMENT '申请人员工ID',
        APPLICANT_NAME VARCHAR(64) NOT NULL COMMENT '申请人姓名',
        DISTRIBUTOR_ID VARCHAR(32) COMMENT '所属经销商',
        STATUS VARCHAR(32) DEFAULT 'pending' COMMENT 'pending/approved/rejected',
        REVIEW_STAFF_ID BIGINT COMMENT '审批人员工ID',
        REVIEW_USER_NAME VARCHAR(64) COMMENT '审批人姓名',
        REVIEW_COMMENT VARCHAR(512) COMMENT '审批意见',
        REVIEW_TIME DATETIME COMMENT '审批时间',
        PRODUCT_ID VARCHAR(32) COMMENT '审批后生成的商品ID',
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '申请时间',
        UPDATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (APPLICATION_ID),
        UNIQUE KEY uk_product_application_no (APPLICATION_NO),
        KEY idx_product_application_status (STATUS, CREATE_TIME),
        KEY idx_product_application_applicant (APPLICANT_STAFF_ID, CREATE_TIME),
        KEY idx_product_application_distributor (DISTRIBUTOR_ID, CREATE_TIME)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='新建商品审批申请'
    `);

    // 通用审批中心：流程版本、实例、任务和不可删除的操作日志。
    await checkAndAddColumn('T_STAFF', 'SUPERVISOR_STAFF_ID', 'BIGINT COMMENT "直属上级员工ID"', 'STORE_ID');
    await checkAndAddColumn('T_STORE', 'MANAGER_STAFF_ID', 'BIGINT COMMENT "门店店长员工ID"', 'REGION_ID');
    await checkAndCreateTable('T_APPROVAL_FLOW_DEFINITION', `
      CREATE TABLE T_APPROVAL_FLOW_DEFINITION (
        DEFINITION_ID VARCHAR(32) NOT NULL,
        FLOW_CODE VARCHAR(64) NOT NULL,
        NAME VARCHAR(128) NOT NULL,
        BUSINESS_TYPE VARCHAR(64) NOT NULL,
        SUBJECT_TYPE VARCHAR(32) DEFAULT 'staff',
        VERSION INT NOT NULL DEFAULT 1,
        STATUS VARCHAR(16) NOT NULL DEFAULT 'draft',
        CONFIG_JSON MEDIUMTEXT NOT NULL,
        CREATE_STAFF_ID BIGINT,
        UPDATE_STAFF_ID BIGINT,
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UPDATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (DEFINITION_ID),
        UNIQUE KEY uk_approval_flow_version (FLOW_CODE, VERSION),
        KEY idx_approval_flow_type_status (BUSINESS_TYPE, STATUS)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='审批流程定义'
    `);
    await checkAndCreateTable('T_APPROVAL_FLOW_INSTANCE', `
      CREATE TABLE T_APPROVAL_FLOW_INSTANCE (
        INSTANCE_ID VARCHAR(32) NOT NULL,
        INSTANCE_NO VARCHAR(64) NOT NULL,
        DEFINITION_ID VARCHAR(32) NOT NULL,
        DEFINITION_VERSION INT NOT NULL,
        BUSINESS_TYPE VARCHAR(64) NOT NULL,
        BUSINESS_ID VARCHAR(64) NOT NULL,
        TITLE VARCHAR(255) NOT NULL,
        SUMMARY VARCHAR(1000),
        APPLICANT_STAFF_ID BIGINT NOT NULL,
        SUBJECT_STAFF_ID BIGINT NOT NULL,
        DISTRIBUTOR_ID VARCHAR(32),
        STORE_ID VARCHAR(32),
        CURRENT_NODE_INDEX INT DEFAULT 0,
        STATUS VARCHAR(16) NOT NULL DEFAULT 'pending',
        RESUBMIT_COUNT INT DEFAULT 0,
        PAYLOAD_JSON MEDIUMTEXT,
        DEFINITION_SNAPSHOT_JSON MEDIUMTEXT NOT NULL,
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UPDATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        COMPLETED_TIME DATETIME,
        PRIMARY KEY (INSTANCE_ID),
        UNIQUE KEY uk_approval_instance_no (INSTANCE_NO),
        KEY idx_approval_instance_applicant (APPLICANT_STAFF_ID, CREATE_TIME),
        KEY idx_approval_instance_subject (SUBJECT_STAFF_ID, CREATE_TIME),
        KEY idx_approval_instance_business (BUSINESS_TYPE, BUSINESS_ID),
        KEY idx_approval_instance_status (STATUS, CREATE_TIME)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='审批实例'
    `);
    await checkAndCreateTable('T_APPROVAL_TASK', `
      CREATE TABLE T_APPROVAL_TASK (
        TASK_ID VARCHAR(32) NOT NULL,
        INSTANCE_ID VARCHAR(32) NOT NULL,
        NODE_INDEX INT NOT NULL,
        NODE_NAME VARCHAR(128) NOT NULL,
        SIGN_MODE VARCHAR(16) NOT NULL,
        ROUND_NO INT DEFAULT 0,
        TASK_ORDER INT DEFAULT 0,
        ASSIGNEE_STAFF_ID BIGINT NOT NULL,
        STATUS VARCHAR(16) NOT NULL DEFAULT 'waiting',
        ACTION VARCHAR(16),
        COMMENT VARCHAR(1000),
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ACTED_TIME DATETIME,
        PRIMARY KEY (TASK_ID),
        KEY idx_approval_task_assignee (ASSIGNEE_STAFF_ID, STATUS, CREATE_TIME),
        KEY idx_approval_task_instance (INSTANCE_ID, NODE_INDEX, STATUS)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='审批任务'
    `);
    await checkAndAddColumn('T_APPROVAL_TASK', 'ROUND_NO', 'INT DEFAULT 0', 'SIGN_MODE');
    await checkAndCreateTable('T_APPROVAL_ACTION_LOG', `
      CREATE TABLE T_APPROVAL_ACTION_LOG (
        LOG_ID VARCHAR(32) NOT NULL,
        INSTANCE_ID VARCHAR(32) NOT NULL,
        TASK_ID VARCHAR(32),
        ACTION VARCHAR(32) NOT NULL,
        ACTOR_STAFF_ID BIGINT NOT NULL,
        ACTOR_NAME VARCHAR(64),
        COMMENT VARCHAR(1000),
        DETAIL_JSON TEXT,
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (LOG_ID),
        KEY idx_approval_log_instance (INSTANCE_ID, CREATE_TIME),
        KEY idx_approval_log_actor (ACTOR_STAFF_ID, CREATE_TIME)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='审批操作日志'
    `);

    await sequelize.query(
      `INSERT IGNORE INTO T_APPROVAL_FLOW_DEFINITION
       (DEFINITION_ID, FLOW_CODE, NAME, BUSINESS_TYPE, SUBJECT_TYPE, VERSION, STATUS, CONFIG_JSON)
       VALUES (?, 'sn_change', 'SN修改审批', 'sn_change', 'staff', 1, 'published', ?)`,
      {
        replacements: [
          require('crypto').randomUUID().replace(/-/g, '').substring(0, 32),
          JSON.stringify({
            nodes: [{
              name: '经销商账号审批',
              signMode: 'or',
              approvers: [
                { type: 'role', roleCode: 'admin', scope: 'subject_distributor' },
                { type: 'role', roleCode: 'boss', scope: 'subject_distributor' }
              ]
            }]
          })
        ]
      }
    );

    await checkAndCreateTable('T_BUSINESS_ACTION_LOG', `
      CREATE TABLE T_BUSINESS_ACTION_LOG (
        LOG_ID VARCHAR(32) NOT NULL,
        BUSINESS_TYPE VARCHAR(32) NOT NULL,
        BUSINESS_ID VARCHAR(64) NOT NULL,
        BUSINESS_NO VARCHAR(64),
        ACTION VARCHAR(64) NOT NULL,
        FROM_STATUS VARCHAR(32),
        TO_STATUS VARCHAR(32),
        ACTOR_STAFF_ID BIGINT,
        ACTOR_NAME VARCHAR(64),
        COMMENT VARCHAR(1000),
        DETAIL_JSON TEXT,
        CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (LOG_ID),
        KEY idx_business_action_target (BUSINESS_TYPE, BUSINESS_ID, CREATE_TIME),
        KEY idx_business_action_actor (ACTOR_STAFF_ID, CREATE_TIME)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='业务单据操作审计日志'
    `);

    // 历史单据没有独立经手人时，使用原制单人作为兼容快照。
    // 该补齐是幂等的，避免旧订单、采购申请和费用单在筛选/导出时出现空经手人。
    try {
      await sequelize.query(`UPDATE T_ORDER SET OPERATOR_STAFF_ID = COALESCE(OPERATOR_STAFF_ID, CREATE_STAFF_ID), OPERATOR_NAME = COALESCE(NULLIF(OPERATOR_NAME, ''), CREATE_USER) WHERE OPERATOR_NAME IS NULL OR OPERATOR_NAME = ''`);
      await sequelize.query(`UPDATE T_PURCHASE_REQUEST SET CREATE_USER = COALESCE(NULLIF(CREATE_USER, ''), APPLY_USER), OPERATOR_NAME = COALESCE(NULLIF(OPERATOR_NAME, ''), APPLY_USER) WHERE (CREATE_USER IS NULL OR CREATE_USER = '') OR (OPERATOR_NAME IS NULL OR OPERATOR_NAME = '')`);
      await sequelize.query(`UPDATE T_EXPENSE SET OPERATOR_STAFF_ID = COALESCE(OPERATOR_STAFF_ID, APPLICANT_STAFF_ID), OPERATOR_NAME = COALESCE(NULLIF(OPERATOR_NAME, ''), APPLICANT_NAME) WHERE OPERATOR_NAME IS NULL OR OPERATOR_NAME = ''`);
      await sequelize.query(`UPDATE T_SETTLEMENT SET OPERATOR_STAFF_ID = COALESCE(OPERATOR_STAFF_ID, CREATE_STAFF_ID), OPERATOR_NAME = COALESCE(NULLIF(OPERATOR_NAME, ''), CREATE_USER) WHERE OPERATOR_NAME IS NULL OR OPERATOR_NAME = ''`);
    } catch (error) {
      console.warn('[DB Migration] 历史单据经手人快照补齐跳过:', error.message);
    }

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

    await migrateMissingProductPns(uuid);

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

async function migrateMissingProductPns(uuid) {
  const [products, activeBarcodes, pnRows] = await Promise.all([
    sequelize.query(
      `SELECT PRODUCT_ID, MANUFACTURER_CODE
       FROM T_PRODUCT
       WHERE STATUS = 1 AND IS_DELETED = 0`,
      { type: sequelize.QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT b.PRODUCT_ID, b.BARCODE_CODE
       FROM T_PRODUCT_BARCODE b
       INNER JOIN T_PRODUCT p ON p.PRODUCT_ID = b.PRODUCT_ID
       WHERE b.BARCODE_TYPE = 'manufacturer' AND b.STATUS = 1
         AND p.STATUS = 1 AND p.IS_DELETED = 0`,
      { type: sequelize.QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT PN_ID, PRODUCT_ID, PN_CODE, STATUS, IS_DELETED
       FROM T_PRODUCT_PN`,
      { type: sequelize.QueryTypes.SELECT }
    )
  ]);

  const candidates = new Map();
  const addCandidate = (productId, rawCode, fromActiveBarcode = false) => {
    const code = String(rawCode || '').trim();
    const key = normalizePnCode(code);
    if (!productId || !isUsablePnCode(code)) return;
    const candidateKey = `${productId}|${key}`;
    const current = candidates.get(candidateKey) || {
      productId,
      code,
      fromActiveBarcode: false
    };
    current.fromActiveBarcode = current.fromActiveBarcode || fromActiveBarcode;
    candidates.set(candidateKey, current);
  };

  for (const product of products) {
    splitPnCodes(product.MANUFACTURER_CODE).forEach(code => addCandidate(product.PRODUCT_ID, code));
  }
  for (const barcode of activeBarcodes) {
    addCandidate(barcode.PRODUCT_ID, barcode.BARCODE_CODE, true);
  }

  const rowsByCode = new Map();
  const activeByProduct = new Map();
  for (const row of pnRows) {
    const key = normalizePnCode(row.PN_CODE);
    if (!key) continue;
    if (!rowsByCode.has(key)) rowsByCode.set(key, []);
    rowsByCode.get(key).push(row);
    if (Number(row.STATUS || 0) === 1 && Number(row.IS_DELETED || 0) === 0) {
      activeByProduct.set(row.PRODUCT_ID, (activeByProduct.get(row.PRODUCT_ID) || 0) + 1);
    }
  }

  const ownersByCode = new Map();
  for (const candidate of candidates.values()) {
    if (!ownersByCode.has(normalizePnCode(candidate.code))) ownersByCode.set(normalizePnCode(candidate.code), new Set());
    ownersByCode.get(normalizePnCode(candidate.code)).add(String(candidate.productId));
  }

  const insertRows = [];
  const restoreRows = [];
  let skippedConflicts = 0;
  let skippedManualReview = 0;
  for (const candidate of candidates.values()) {
    const key = normalizePnCode(candidate.code);
    const owners = ownersByCode.get(key) || new Set();
    if (owners.size > 1) {
      skippedConflicts++;
      continue;
    }

    const existingRows = rowsByCode.get(key) || [];
    const sameProduct = existingRows.find(row => String(row.PRODUCT_ID) === String(candidate.productId));
    const otherProduct = existingRows.find(row => String(row.PRODUCT_ID) !== String(candidate.productId));
    if (otherProduct) {
      skippedConflicts++;
      continue;
    }

    // 只有启用厂商条码能够证明这是明确的 PN，纯历史文本字段留给人工复核。
    if (!candidate.fromActiveBarcode) {
      skippedManualReview++;
      continue;
    }

    if (sameProduct) {
      if (Number(sameProduct.STATUS || 0) !== 1 || Number(sameProduct.IS_DELETED || 0) !== 0) {
        restoreRows.push({ pnCode: candidate.code, pnId: sameProduct.PN_ID });
      }
      continue;
    }

    const pnId = uuid().replace(/-/g, '').substring(0, 32);
    insertRows.push([
      pnId,
      candidate.productId,
      candidate.code,
      candidate.code,
      activeByProduct.get(candidate.productId) ? 0 : 1
    ]);
    activeByProduct.set(candidate.productId, (activeByProduct.get(candidate.productId) || 0) + 1);
  }

  const transaction = await sequelize.transaction();
  let inserted = 0;
  let restored = 0;
  try {
    for (let i = 0; i < insertRows.length; i += 500) {
      const chunk = insertRows.slice(i, i + 500);
      const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, 1, 0)').join(', ');
      await sequelize.query(
        `INSERT INTO T_PRODUCT_PN
         (PN_ID, PRODUCT_ID, PN_CODE, BARCODE, IS_PRIMARY, STATUS, IS_DELETED)
         VALUES ${placeholders}`,
        { replacements: chunk.flat(), transaction }
      );
      inserted += chunk.length;
    }
    for (const row of restoreRows) {
      await sequelize.query(
        `UPDATE T_PRODUCT_PN
         SET PN_CODE = ?, STATUS = 1, IS_DELETED = 0
         WHERE PN_ID = ?`,
        { replacements: [row.pnCode, row.pnId], transaction }
      );
      restored++;
    }
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }

  if (inserted || restored || skippedConflicts || skippedManualReview) {
    console.log(
      `[DB Migration] PN主数据修复完成: 新增 ${inserted}，恢复 ${restored}，冲突跳过 ${skippedConflicts}，待人工确认 ${skippedManualReview}`
    );
  }
}

async function seedPermissionData() {
  try {
    const uuid = require('crypto').randomUUID;
    const childMenus = [
      ['sales_order', '销售订单', 'sales', '/sales/order', 1],
      ['sales_subsidy_photos', '国补照片', 'sales', '/sales/subsidy-photos', 2],
      ['sales_monthly_tasks', '月度任务', 'sales', '/sales/monthly-tasks', 3],
      ['inventory_summary', '库存汇总', 'inventory', '/inventory/summary', 1],
      ['inventory_sn_inventory', 'SN库存清单', 'inventory', '/inventory/sn-inventory', 2],
      ['inventory_batch_maintenance', '批量维护', 'inventory', '/inventory/batch-maintenance', 3],
      ['inventory_inbound', '入库单管理', 'inventory', '/inventory/inbound', 4],
      ['inventory_sn_trace', 'SN追踪', 'inventory', '/inventory/sn-trace', 5],
      ['inventory_resource_rights', '库存资源权益', 'inventory', '/inventory/resource-rights', 6],
      ['inventory_transfer', '调拨管理', 'inventory', '/inventory/transfer', 7],
      ['inventory_conversion', '拆装管理', 'inventory', '/inventory/conversion', 8],
      ['purchase_request', '采购申请', 'purchase', '/purchase/request', 1],
      ['purchase_supplier', '供应商管理', 'purchase', '/purchase/supplier', 2],
      ['finance_daily', '日结单', 'finance', '/finance/daily', 1],
      ['finance_subsidy_receivable', '国补应收单', 'finance', '/finance/subsidy-receivable', 2],
      ['finance_rebate_settlement', '返利下账', 'finance', '/finance/rebate-settlement', 3],
      ['finance_expense', '费用管理', 'finance', '/finance/expense', 4],
      ['finance_payable', '应付管理', 'finance', '/finance/payable', 5],
      ['finance_reimbursement', '报销结算', 'finance', '/finance/reimbursement', 6],
      ['finance_payment', '付款管理', 'finance', '/finance/payment', 7],
      ['finance_rebate', '返利管理', 'finance', '/finance/rebate', 8],
      ['finance_resource_rights', '资源权益核销与成本调整', 'finance', '/finance/resource-rights', 9],
      ['finance_account', '账户中心', 'finance', '/finance/account', 10],
      ['finance_settlement', '应付结算单管理', 'finance', '/finance/settlement', 11],
      ['finance_freight', '运费管理', 'finance', '/finance/freight', 12],
      ['product_product', '商品管理', 'products', '/products/product', 1],
      ['product_category', '分类管理', 'products', '/products/category', 2],
      ['product_price', '价格管理', 'products', '/products/price', 3],
      ['product_approval', '新建商品审批', 'products', '/products/approval', 4],
      ['reports_dashboard', '经营数据看板', 'reports', '/reports/dashboard', 1],
      ['reports_sales', '销售报表', 'reports', '/reports/sales', 2],
      ['reports_inventory', '库存报表', 'reports', '/reports/inventory', 3],
      ['reports_employee', '员工业绩统计', 'reports', '/reports/employee', 4],
      ['reports_achievement', '业务达成', 'reports', '/reports/achievement', 5],
      ['approval_tasks', '待我审批', 'approval', '/approval/tasks', 1],
      ['approval_instances', '我的申请', 'approval', '/approval/instances', 2],
      ['approval_flows', '流程配置', 'approval', '/approval/flows', 3],
      ['system_users', '用户管理', 'system', '/system/users', 1],
      ['system_roles', '角色管理', 'system', '/system/roles', 2],
      ['system_menus', '菜单管理', 'system', '/system/menus', 3],
      ['system_locations', '库位管理', 'system', '/system/locations', 4],
      ['system_resource_categories', '货型配置', 'system', '/system/resource-categories', 5],
      ['system_customer_source', '客户来源管理', 'system', '/system/customer-source', 6],
      ['system_payment_method', '收款方式管理', 'system', '/system/payment-method', 7],
      ['system_supplement_item', '金额补录项目管理', 'system', '/system/supplement-item', 8],
      ['system_expense_type', '报销类型管理', 'system', '/system/expense-type', 9],
      ['system_category_field', '商品字段管理', 'system', '/system/category-field', 10]
    ];
    const childCodes = Object.fromEntries(childMenus.map(([code]) => [code, true]));
    const legacyMenuCodes = [
      'sales_return', 'sales_stats',
      'inventory_sn', 'inventory_warning', 'inventory_location',
      'purchase_order', 'purchase_inbound', 'finance_report',
      'product_list', 'product_list_legacy',
      'system_user', 'system_role', 'system_menu', 'system_region',
      'paymentManagement'
    ];
    const roleChildMenus = {
      boss: childMenus.map(([code]) => code),
      admin: childMenus.map(([code]) => code),
      finance: [
        'sales_order', 'sales_subsidy_photos',
        'inventory_resource_rights',
        'finance_daily', 'finance_subsidy_receivable', 'finance_rebate_settlement', 'finance_expense',
        'finance_payable', 'finance_reimbursement', 'finance_payment', 'finance_rebate',
        'finance_resource_rights', 'finance_account', 'finance_settlement', 'finance_freight',
        'reports_dashboard', 'reports_sales', 'reports_inventory', 'reports_employee', 'reports_achievement',
        'approval_tasks', 'approval_instances', 'product_approval'
      ],
      purchaser: [
        'purchase_request', 'purchase_supplier', 'reports_dashboard', 'reports_sales', 'reports_inventory',
        'reports_employee', 'reports_achievement', 'approval_tasks', 'approval_instances', 'product_approval'
      ],
      manager: [
        'sales_order', 'sales_subsidy_photos', 'sales_monthly_tasks',
        'inventory_summary', 'inventory_sn_inventory', 'inventory_batch_maintenance', 'inventory_inbound',
        'inventory_sn_trace', 'inventory_resource_rights', 'inventory_transfer', 'inventory_conversion',
        'product_product', 'product_category', 'product_price', 'product_approval',
        'reports_dashboard', 'reports_sales', 'reports_inventory', 'reports_employee', 'reports_achievement',
        'approval_tasks', 'approval_instances'
      ],
      store_manager: [
        'sales_order', 'sales_subsidy_photos', 'sales_monthly_tasks',
        'inventory_summary', 'inventory_sn_inventory', 'inventory_batch_maintenance', 'inventory_inbound',
        'inventory_sn_trace', 'inventory_transfer', 'inventory_conversion',
        'product_product', 'product_category', 'product_price', 'product_approval',
        'reports_dashboard', 'reports_sales', 'reports_inventory', 'reports_employee', 'reports_achievement',
        'approval_tasks', 'approval_instances'
      ],
      clerk: [
        'sales_order', 'inventory_summary', 'inventory_sn_inventory', 'inventory_inbound',
        'inventory_sn_trace', 'inventory_transfer', 'reports_dashboard', 'reports_sales',
        'reports_inventory', 'reports_employee', 'reports_achievement', 'approval_tasks', 'approval_instances'
      ]
    };
    const ensureChildMenus = async () => {
      for (const [code, name, parentCode, path, sortOrder] of childMenus) {
        const [parents] = await sequelize.query(
          'SELECT MENU_ID FROM T_MENU WHERE MENU_CODE = ? AND STATUS = 1 LIMIT 1',
          { replacements: [parentCode] }
        );
        if (!parents.length) continue;
        const [existing] = await sequelize.query(
          'SELECT MENU_ID FROM T_MENU WHERE MENU_CODE = ? LIMIT 1',
          { replacements: [code] }
        );
        if (existing.length) {
          await sequelize.query(
            `UPDATE T_MENU SET NAME = ?, PARENT_ID = ?, MENU_TYPE = 'menu', PATH = ?, SORT_ORDER = ?, STATUS = 1 WHERE MENU_ID = ?`,
            { replacements: [name, parents[0].MENU_ID, path, sortOrder, existing[0].MENU_ID] }
          );
        } else {
          await sequelize.query(
            `INSERT INTO T_MENU (MENU_ID, MENU_CODE, NAME, PARENT_ID, MENU_TYPE, PATH, ICON, SORT_ORDER, STATUS)
             VALUES (?, ?, ?, ?, 'menu', ?, NULL, ?, 1)`,
            { replacements: [uuid().replace(/-/g, '').substring(0, 32), code, name, parents[0].MENU_ID, path, sortOrder] }
          );
        }
      }
    };
    const ensureRoleChildMenus = async () => {
      for (const [roleCode, menuCodes] of Object.entries(roleChildMenus)) {
        const [roles] = await sequelize.query(
          'SELECT ROLE_ID FROM T_ROLE WHERE ROLE_CODE = ? AND STATUS = 1',
          { replacements: [roleCode] }
        );
        if (!roles.length) continue;
        for (const menuCode of menuCodes) {
          if (!childCodes[menuCode]) continue;
          const [menus] = await sequelize.query(
            'SELECT MENU_ID FROM T_MENU WHERE MENU_CODE = ? AND STATUS = 1',
            { replacements: [menuCode] }
          );
          for (const role of roles) {
            for (const menu of menus) {
              await sequelize.query(
                'INSERT IGNORE INTO T_ROLE_MENU (ROLE_ID, MENU_ID) VALUES (?, ?)',
                { replacements: [role.ROLE_ID, menu.MENU_ID] }
              );
            }
          }
        }
      }
    };
    const disableLegacyMenus = async () => {
      await sequelize.query(
        `UPDATE T_MENU SET STATUS = 0 WHERE MENU_CODE IN (${legacyMenuCodes.map(() => '?').join(', ')})`,
        { replacements: legacyMenuCodes }
      );
    };
    await sequelize.query(
      `INSERT IGNORE INTO T_MENU (MENU_ID, MENU_CODE, NAME, PARENT_ID, MENU_TYPE, PATH, ICON, SORT_ORDER, STATUS)
       VALUES (?, 'approval', '审批中心', NULL, 'menu', '/approval', 'Checked', 4, 1)`,
      { replacements: [uuid().replace(/-/g, '').substring(0, 32)] }
    );
    await sequelize.query(
      `INSERT IGNORE INTO T_MENU (MENU_ID, MENU_CODE, NAME, PARENT_ID, MENU_TYPE, PATH, ICON, SORT_ORDER, STATUS)
       VALUES (?, 'reports', '报表统计', NULL, 'menu', '/reports', 'DataAnalysis', 8, 1)`,
      { replacements: [uuid().replace(/-/g, '').substring(0, 32)] }
    );
    await sequelize.query(
      `INSERT IGNORE INTO T_MENU (MENU_ID, MENU_CODE, NAME, PARENT_ID, MENU_TYPE, PATH, ICON, SORT_ORDER, STATUS)
       SELECT ?, 'sales_subsidy_photos', '国补照片', MENU_ID, 'menu', '/sales/subsidy-photos', NULL, 4, 1
       FROM T_MENU WHERE MENU_CODE = 'sales' AND STATUS = 1`,
      { replacements: [uuid().replace(/-/g, '').substring(0, 32)] }
    );
    const [roleCount] = await sequelize.query(
      "SELECT COUNT(*) as cnt FROM T_ROLE",
      { type: sequelize.QueryTypes.SELECT }
    );
    if (roleCount.cnt > 0) {
      await ensureChildMenus();
      await disableLegacyMenus();
      await ensureRoleChildMenus();
      await sequelize.query(`
        INSERT IGNORE INTO T_STAFF_ROLE (STAFF_ID, ROLE_ID)
        SELECT s.STAFF_ID, r.ROLE_ID
        FROM T_STAFF s
        JOIN T_ROLE r ON r.ROLE_CODE = s.ROLE_CODE AND r.STATUS = 1
        WHERE s.IS_DELETED = 0
      `);
      await sequelize.query(`
        UPDATE T_MENU
        SET STATUS = 0
        WHERE MENU_CODE = 'paymentManagement'
      `);
      await sequelize.query(`
        INSERT IGNORE INTO T_ROLE_MENU (ROLE_ID, MENU_ID)
        SELECT r.ROLE_ID, m.MENU_ID
        FROM T_ROLE r
        JOIN T_MENU m ON m.MENU_CODE = 'reports'
        WHERE r.STATUS = 1 AND m.STATUS = 1
      `);
      await sequelize.query(`
        INSERT IGNORE INTO T_ROLE_MENU (ROLE_ID, MENU_ID)
        SELECT r.ROLE_ID, m.MENU_ID
        FROM T_ROLE r
        JOIN T_MENU m ON m.MENU_CODE = 'products'
        WHERE r.ROLE_CODE IN ('finance', 'purchaser') AND r.STATUS = 1 AND m.STATUS = 1
      `);
      await sequelize.query(`
        INSERT IGNORE INTO T_ROLE_MENU (ROLE_ID, MENU_ID)
        SELECT r.ROLE_ID, m.MENU_ID
        FROM T_ROLE r
        JOIN T_MENU m ON m.MENU_CODE = 'approval'
        WHERE r.STATUS = 1 AND m.STATUS = 1
      `);
      await sequelize.query(`
        INSERT IGNORE INTO T_ROLE_MENU (ROLE_ID, MENU_ID)
        SELECT r.ROLE_ID, m.MENU_ID
        FROM T_ROLE r
        JOIN T_MENU m ON m.MENU_CODE IN ('sales', 'inventory', 'sales_subsidy_photos')
        WHERE r.ROLE_CODE IN ('boss', 'admin', 'finance', 'manager', 'store_manager')
          AND r.STATUS = 1 AND m.STATUS = 1
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
    await ensureChildMenus();

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
      boss:   ['home', 'sales', 'inventory', 'purchase', 'finance', 'products', 'stores', 'reports', 'system', 'approval'],
      admin:  ['home', 'sales', 'inventory', 'purchase', 'finance', 'products', 'stores', 'reports', 'system', 'approval'],
      finance: ['home', 'sales', 'inventory', 'finance', 'products', 'reports', 'approval'],
      purchaser: ['home', 'purchase', 'products', 'reports', 'approval'],
      manager: ['home', 'sales', 'inventory', 'products', 'reports', 'stores', 'system', 'approval'],
      clerk:   ['home', 'sales', 'inventory', 'reports', 'approval']
    };

    const subsidyPhotoMenuId = menuMap.sales_subsidy_photos;
    if (subsidyPhotoMenuId) {
      ['boss', 'admin', 'finance', 'manager', 'store_manager'].forEach(roleCode => {
        if (roleMap[roleCode]) roleMenus[roleCode] = [...(roleMenus[roleCode] || []), 'sales_subsidy_photos'];
      });
    }

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
    await checkAndAddColumn('T_PURCHASE_REQUEST_ITEM', 'IS_USED_PRODUCT', 'TINYINT(1) DEFAULT 0 COMMENT "二手商品标记"', 'PN_CODE');
    await checkAndAddColumn('T_PURCHASE_REQUEST_ITEM', 'DIRECT_INBOUND', 'TINYINT(1) DEFAULT 0 COMMENT "审批通过后直接入库"', 'IS_USED_PRODUCT');
    await checkAndAddColumn('T_PURCHASE_REQUEST_ITEM', 'DIRECT_INBOUND_SN_CODE', 'VARCHAR(128) COMMENT "直接入库SN"', 'DIRECT_INBOUND');
    await ensureRoleChildMenus();

    console.log('[DB Migration] 权限种子数据已创建');

    await sequelize.query(
      `INSERT IGNORE INTO T_STAFF_ROLE (STAFF_ID, ROLE_ID)
       SELECT s.STAFF_ID, r.ROLE_ID
       FROM T_STAFF s
       JOIN T_ROLE r ON r.ROLE_CODE = s.ROLE_CODE AND r.STATUS = 1
       WHERE s.IS_DELETED = 0`
    );
    console.log('[DB Migration] 现有用户角色关联已补齐');
  } catch (error) {
    console.error('[DB Migration] 种子权限数据失败:', error.message);
  }
}

module.exports = {
  runMigrations,
  migrateMissingProductPns,
  ensureCriticalSchemaCompatibility,
  ensureSerializedInventorySchema,
  ensureProductPnEffectiveUniqueIndex
};
