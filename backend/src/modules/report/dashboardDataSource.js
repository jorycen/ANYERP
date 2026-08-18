const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../models');

const ARCHIVED_STATUSES = ['已归档', 'completed', 'archived', 'returned'];
const GROSS_PROFIT_FORMULA_VERSION = 'ORDER_GP_V5_20260706';
const INVENTORY_CATEGORY_ORDER = ['拯救者', '小新', 'Yoga', '其他电脑', '手机', '平板'];

function classifyInventoryCategory(row) {
  const text = [row.brand, row.series, row.model, row.productName, row.categoryPath]
    .filter(Boolean).join(' ').toLowerCase();
  if (/(手机|iphone|华为|荣耀|oppo|vivo|小米手机|三星手机)/i.test(text)) return '手机';
  if (/(平板|pad|ipad|matepad|小米平板)/i.test(text)) return '平板';
  if (text.includes('拯救者')) return '拯救者';
  if (text.includes('小新')) return '小新';
  if (text.includes('yoga')) return 'Yoga';
  return '其他电脑';
}

function toNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function roundMoney(value) {
  return Number(toNumber(value).toFixed(2));
}

function safeJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function participantKey(staffId, name) {
  return staffId ? `id:${staffId}` : `name:${String(name || '').trim()}`;
}

function normalizeParticipants(order) {
  const participants = [];
  const seen = new Set();
  const add = (staffId, name, role) => {
    const normalizedId = staffId === null || staffId === undefined || staffId === '' ? '' : String(staffId);
    const normalizedName = String(name || '').trim() || '未命名员工';
    const key = participantKey(normalizedId, normalizedName);
    if (seen.has(key)) return;
    seen.add(key);
    participants.push({ key, staffId: normalizedId || null, name: normalizedName, role });
  };

  add(order.create_staff_id, order.create_user, 'primary');
  safeJsonArray(order.auxiliary_sales_list).forEach(item => {
    if (!item || typeof item !== 'object') return;
    add(
      item.staffId ?? item.staff_id ?? item.id,
      item.name ?? item.staffName ?? item.staff_name ?? item.selected,
      'auxiliary'
    );
  });
  return participants;
}

function legacyGrossProfitSql(itemAlias = 'oi') {
  return `CASE
    WHEN COALESCE(${itemAlias}.ORIGINAL_INVENTORY_COST, 0) <> 0
      OR COALESCE(${itemAlias}.SALES_SETTLEMENT_COST, 0) <> 0
      OR COALESCE(${itemAlias}.SALES_GROSS_PROFIT, 0) <> 0
      OR COALESCE(${itemAlias}.COST_ADJUSTMENT_AMOUNT, 0) <> 0
      OR COALESCE(${itemAlias}.ORIGINAL_PICKUP_PRICE, 0) <> 0
    THEN COALESCE(${itemAlias}.SALES_GROSS_PROFIT, 0)
    ELSE COALESCE(${itemAlias}.SUBTOTAL, 0)
      - COALESCE(NULLIF(ps.INBOUND_PRICE, 0), pp.COST_PRICE, 0) * COALESCE(${itemAlias}.QUANTITY, 1)
  END`;
}

function grossProfitSql(itemAlias = 'oi', orderAlias = 'o', snapshotAlias = 'gp') {
  return `CASE
    WHEN ${snapshotAlias}.GROSS_PROFIT_ID IS NOT NULL
    THEN COALESCE(${snapshotAlias}.GROSS_PROFIT_AMOUNT, 0)
      * CASE
          WHEN COALESCE(${orderAlias}.TOTAL_AMOUNT, 0) <> 0
          THEN COALESCE(${itemAlias}.SUBTOTAL, 0) / ${orderAlias}.TOTAL_AMOUNT
          ELSE 0
        END
    ELSE ${legacyGrossProfitSql(itemAlias)}
  END`;
}

function bucketSql(granularity) {
  if (granularity === 'month') return "DATE_FORMAT(o.CREATE_TIME, '%Y-%m')";
  if (granularity === 'week') return "DATE_FORMAT(DATE_SUB(DATE(o.CREATE_TIME), INTERVAL WEEKDAY(o.CREATE_TIME) DAY), '%Y-%m-%d')";
  return "DATE_FORMAT(o.CREATE_TIME, '%Y-%m-%d')";
}

function buildSalesWhere(filters, range, options = {}) {
  const clauses = [
    'o.IS_DELETED = 0',
    'o.ORDER_STATUS IN (:archivedStatuses)',
    'o.STORE_ID IN (:storeIds)',
    'o.CREATE_TIME >= :startAt',
    'o.CREATE_TIME <= :endAt'
  ];
  const replacements = {
    archivedStatuses: ARCHIVED_STATUSES,
    storeIds: filters.storeIds,
    startAt: range.startAt,
    endAt: range.endAt
  };

  if (filters.storeId) {
    clauses.push('o.STORE_ID = :storeId');
    replacements.storeId = filters.storeId;
  }
  if (filters.productLine && options.includeProduct !== false) {
    clauses.push("(p.CATEGORY = :productLine OR p.CATEGORY LIKE :productLinePrefix)");
    replacements.productLine = filters.productLine;
    replacements.productLinePrefix = `${filters.productLine}/%`;
  }
  if (filters.employeeId) {
    clauses.push(`(
      CAST(o.CREATE_STAFF_ID AS CHAR) = :employeeId
      OR JSON_SEARCH(o.AUXILIARY_SALES_LIST, 'one', :employeeId, NULL, '$[*].staffId') IS NOT NULL
      OR JSON_SEARCH(o.AUXILIARY_SALES_LIST, 'one', :employeeId, NULL, '$[*].staff_id') IS NOT NULL
      OR JSON_CONTAINS(o.AUXILIARY_SALES_LIST, JSON_OBJECT('staffId', CAST(:employeeId AS UNSIGNED)), '$')
      OR JSON_CONTAINS(o.AUXILIARY_SALES_LIST, JSON_OBJECT('staff_id', CAST(:employeeId AS UNSIGNED)), '$')
    )`);
    replacements.employeeId = String(filters.employeeId);
  }

  return { sql: clauses.join('\n AND '), replacements };
}

function allocationSql(filters) {
  if (!filters.employeeId) return '1';
  return '(1 / GREATEST(1, 1 + COALESCE(JSON_LENGTH(o.AUXILIARY_SALES_LIST), 0)))';
}

class DashboardDataSource {
  async getFilters() {
    throw new Error('DashboardDataSource.getFilters must be implemented');
  }

  async getOverview() {
    throw new Error('DashboardDataSource.getOverview must be implemented');
  }
}

class RealtimeSqlDashboardDataSource extends DashboardDataSource {
  async query(sql, replacements = {}) {
    return sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
  }

  async getFilters(filters) {
    const storeRows = await this.query(
      `SELECT STORE_ID AS storeId, NAME AS name
         FROM T_STORE
        WHERE IS_DELETED = 0
          AND STATUS = 1
          AND STORE_ID IN (:storeIds)
        ORDER BY NAME ASC`,
      { storeIds: filters.storeIds }
    );

    const staffScope = filters.storeIds.includes('*')
      ? '1 = 1'
      : '(s.STORE_ID IN (:storeIds) OR s.STAFF_ID IN (SELECT sp.STAFF_ID FROM T_STAFF_STORE_PERMISSION sp WHERE sp.STORE_ID IN (:storeIds)))';
    const [employeeRows, productLineRows] = await Promise.all([
      this.query(
        `SELECT DISTINCT s.STAFF_ID AS staffId, s.NAME AS name
           FROM T_STAFF s
          WHERE s.IS_DELETED = 0
            AND s.STATUS = 1
            AND ${staffScope}
          ORDER BY s.NAME ASC`,
        { storeIds: filters.storeIds }
      ),
      this.query(
        `SELECT DISTINCT SUBSTRING_INDEX(CATEGORY, '/', 1) AS productLine
           FROM T_PRODUCT
          WHERE IS_DELETED = 0
            AND CATEGORY IS NOT NULL
            AND CATEGORY <> ''
          ORDER BY productLine ASC`
      )
    ]);

    return {
      stores: storeRows,
      employees: employeeRows,
      productLines: productLineRows.map(row => row.productLine).filter(Boolean)
    };
  }

  async getTrend(filters, range, granularity) {
    const where = buildSalesWhere(filters, range);
    const factor = allocationSql(filters);
    const bucket = bucketSql(granularity);
    return this.query(
      `SELECT ${bucket} AS bucket,
              ROUND(SUM(oi.SUBTOTAL * ${factor}), 2) AS salesAmount,
              ROUND(SUM((${grossProfitSql()}) * ${factor}), 2) AS grossProfit,
              COUNT(DISTINCT o.ORDER_ID) AS orderCount
         FROM T_ORDER o
         INNER JOIN T_ORDER_ITEM oi ON oi.ORDER_ID = o.ORDER_ID
         LEFT JOIN T_ORDER_GROSS_PROFIT gp ON gp.ORDER_ID = o.ORDER_ID AND gp.FORMULA_VERSION = '${GROSS_PROFIT_FORMULA_VERSION}'
         LEFT JOIN T_PRODUCT p ON p.PRODUCT_ID = oi.PRODUCT_ID
         LEFT JOIN T_PRODUCT_SN ps ON ps.SN_ID = oi.SN_ID AND ps.IS_DELETED = 0
         LEFT JOIN T_PRODUCT_PRICE pp ON pp.PRODUCT_ID = oi.PRODUCT_ID AND pp.STATUS = 1
        WHERE ${where.sql}
        GROUP BY ${bucket}
        ORDER BY ${bucket} ASC`,
      where.replacements
    );
  }

  async getStoreRanking(filters, range) {
    const where = buildSalesWhere(filters, range);
    const factor = allocationSql(filters);
    return this.query(
      `SELECT o.STORE_ID AS storeId,
              MAX(s.NAME) AS storeName,
              ROUND(SUM(oi.SUBTOTAL * ${factor}), 2) AS salesAmount,
              ROUND(SUM((${grossProfitSql()}) * ${factor}), 2) AS grossProfit,
              COUNT(DISTINCT o.ORDER_ID) AS orderCount
         FROM T_ORDER o
         INNER JOIN T_ORDER_ITEM oi ON oi.ORDER_ID = o.ORDER_ID
         LEFT JOIN T_ORDER_GROSS_PROFIT gp ON gp.ORDER_ID = o.ORDER_ID AND gp.FORMULA_VERSION = '${GROSS_PROFIT_FORMULA_VERSION}'
         LEFT JOIN T_STORE s ON s.STORE_ID = o.STORE_ID
         LEFT JOIN T_PRODUCT p ON p.PRODUCT_ID = oi.PRODUCT_ID
         LEFT JOIN T_PRODUCT_SN ps ON ps.SN_ID = oi.SN_ID AND ps.IS_DELETED = 0
         LEFT JOIN T_PRODUCT_PRICE pp ON pp.PRODUCT_ID = oi.PRODUCT_ID AND pp.STATUS = 1
        WHERE ${where.sql}
        GROUP BY o.STORE_ID
        ORDER BY salesAmount DESC
        LIMIT 10`,
      where.replacements
    );
  }

  async getProductRows(filters, range) {
    const where = buildSalesWhere(filters, range);
    const factor = allocationSql(filters);
    return this.query(
      `SELECT oi.PRODUCT_ID AS productId,
              MAX(COALESCE(p.NAME, oi.PRODUCT_NAME)) AS productName,
              MAX(COALESCE(p.PRODUCT_CODE, '')) AS productCode,
              MAX(COALESCE(p.IS_FOCUS_PRODUCT, 0)) AS isFocusProduct,
              ROUND(SUM(oi.SUBTOTAL * ${factor}), 2) AS salesAmount,
              ROUND(SUM((${grossProfitSql()}) * ${factor}), 2) AS grossProfit,
              ROUND(SUM(oi.QUANTITY * ${factor}), 2) AS quantity
         FROM T_ORDER o
         INNER JOIN T_ORDER_ITEM oi ON oi.ORDER_ID = o.ORDER_ID
         LEFT JOIN T_ORDER_GROSS_PROFIT gp ON gp.ORDER_ID = o.ORDER_ID AND gp.FORMULA_VERSION = '${GROSS_PROFIT_FORMULA_VERSION}'
         LEFT JOIN T_PRODUCT p ON p.PRODUCT_ID = oi.PRODUCT_ID
         LEFT JOIN T_PRODUCT_SN ps ON ps.SN_ID = oi.SN_ID AND ps.IS_DELETED = 0
         LEFT JOIN T_PRODUCT_PRICE pp ON pp.PRODUCT_ID = oi.PRODUCT_ID AND pp.STATUS = 1
        WHERE ${where.sql}
        GROUP BY oi.PRODUCT_ID
        ORDER BY salesAmount DESC`,
      where.replacements
    );
  }

  async getProductLineRows(filters, range) {
    const where = buildSalesWhere(filters, range);
    const factor = allocationSql(filters);
    return this.query(
      `SELECT COALESCE(NULLIF(SUBSTRING_INDEX(p.CATEGORY, '/', 1), ''), '未分类') AS productLine,
              ROUND(SUM(oi.SUBTOTAL * ${factor}), 2) AS salesAmount,
              ROUND(SUM((${grossProfitSql()}) * ${factor}), 2) AS grossProfit
         FROM T_ORDER o
         INNER JOIN T_ORDER_ITEM oi ON oi.ORDER_ID = o.ORDER_ID
         LEFT JOIN T_ORDER_GROSS_PROFIT gp ON gp.ORDER_ID = o.ORDER_ID AND gp.FORMULA_VERSION = '${GROSS_PROFIT_FORMULA_VERSION}'
         LEFT JOIN T_PRODUCT p ON p.PRODUCT_ID = oi.PRODUCT_ID
         LEFT JOIN T_PRODUCT_SN ps ON ps.SN_ID = oi.SN_ID AND ps.IS_DELETED = 0
         LEFT JOIN T_PRODUCT_PRICE pp ON pp.PRODUCT_ID = oi.PRODUCT_ID AND pp.STATUS = 1
        WHERE ${where.sql}
        GROUP BY COALESCE(NULLIF(SUBSTRING_INDEX(p.CATEGORY, '/', 1), ''), '未分类')
        ORDER BY salesAmount DESC`,
      where.replacements
    );
  }

  async getEmployeeOrderRows(filters, range) {
    const where = buildSalesWhere(filters, range);
    return this.query(
      `SELECT o.ORDER_ID AS order_id,
              o.ORDER_NO AS order_no,
              o.CREATE_TIME AS create_time,
              o.STORE_ID AS store_id,
              MAX(s.NAME) AS store_name,
              o.CREATE_STAFF_ID AS create_staff_id,
              o.CREATE_USER AS create_user,
              o.AUXILIARY_SALES_LIST AS auxiliary_sales_list,
              ROUND(SUM(oi.SUBTOTAL), 2) AS sales_amount,
              ROUND(SUM(${grossProfitSql()}), 2) AS base_gross_profit
         FROM T_ORDER o
         INNER JOIN T_ORDER_ITEM oi ON oi.ORDER_ID = o.ORDER_ID
         LEFT JOIN T_ORDER_GROSS_PROFIT gp ON gp.ORDER_ID = o.ORDER_ID AND gp.FORMULA_VERSION = '${GROSS_PROFIT_FORMULA_VERSION}'
         LEFT JOIN T_STORE s ON s.STORE_ID = o.STORE_ID
         LEFT JOIN T_PRODUCT p ON p.PRODUCT_ID = oi.PRODUCT_ID
         LEFT JOIN T_PRODUCT_SN ps ON ps.SN_ID = oi.SN_ID AND ps.IS_DELETED = 0
         LEFT JOIN T_PRODUCT_PRICE pp ON pp.PRODUCT_ID = oi.PRODUCT_ID AND pp.STATUS = 1
        WHERE ${where.sql}
        GROUP BY o.ORDER_ID, o.ORDER_NO, o.CREATE_TIME, o.STORE_ID,
                 o.CREATE_STAFF_ID, o.CREATE_USER, o.AUXILIARY_SALES_LIST
        ORDER BY o.CREATE_TIME DESC`,
      where.replacements
    );
  }

  async getApprovedAdjustments(filters, range) {
    const where = buildSalesWhere(filters, range, { includeProduct: false });
    return this.query(
      `SELECT pa.ORDER_ID AS orderId,
              NULL AS participantKey,
              pa.SIGNED_AMOUNT AS signedAmount,
              pa.REASON AS reason,
              pa.ADJUSTMENT_TYPE AS adjustmentType,
              pa.ADJUSTMENT_NO AS adjustmentNo
         FROM T_PERFORMANCE_PROFIT_ADJUSTMENT pa
         INNER JOIN T_ORDER o ON o.ORDER_ID = pa.ORDER_ID
        WHERE pa.STATUS = 'approved'
          AND ${where.sql}
        UNION ALL
       SELECT rgp.ORDER_ID AS orderId,
              rgp.PARTICIPANT_KEY AS participantKey,
              rgp.GROSS_PROFIT_AMOUNT AS signedAmount,
              rgp.REASON AS reason,
              'return' AS adjustmentType,
              rgp.RETURN_NO AS adjustmentNo
         FROM T_SALES_RETURN_GROSS_PROFIT rgp
         INNER JOIN T_ORDER o ON o.ORDER_ID = rgp.ORDER_ID
        WHERE ${where.sql}
        ORDER BY orderId, adjustmentNo`,
      where.replacements
    );
  }

  async getInventory(filters) {
    const storeClause = filters.storeId ? 'AND i.STORE_ID = :storeId' : '';
    const snStoreClause = filters.storeId ? 'AND ps.STORE_ID = :storeId' : '';
    const productLineClause = filters.productLine
      ? "AND (p.CATEGORY = :productLine OR p.CATEGORY LIKE :productLinePrefix)"
      : '';
    const replacements = {
      storeIds: filters.storeIds,
      storeId: filters.storeId,
      productLine: filters.productLine,
      productLinePrefix: filters.productLine ? `${filters.productLine}/%` : undefined
    };

    const [snRows, nonSnRows, ageRows] = await Promise.all([
      this.query(
        `SELECT ps.PRODUCT_ID AS productId,
                MAX(p.NAME) AS productName,
                MAX(p.BRAND) AS brand,
                MAX(p.SERIES) AS series,
                MAX(p.MODEL) AS model,
                MAX(p.CATEGORY) AS categoryPath,
                COUNT(*) AS quantity,
                ROUND(SUM(COALESCE(NULLIF(ps.INBOUND_PRICE, 0), pp.COST_PRICE, 0)), 2) AS inventoryAmount,
                MIN(ps.INBOUND_TIME) AS oldestInboundTime
           FROM T_PRODUCT_SN ps
           INNER JOIN T_PRODUCT p ON p.PRODUCT_ID = ps.PRODUCT_ID
           LEFT JOIN T_PRODUCT_PRICE pp ON pp.PRODUCT_ID = ps.PRODUCT_ID AND pp.STATUS = 1
          WHERE ps.IS_DELETED = 0
            AND ps.STATUS = 'in_stock'
            AND ps.STORE_ID IN (:storeIds)
            ${snStoreClause}
            ${productLineClause}
          GROUP BY ps.PRODUCT_ID`,
        replacements
      ),
      this.query(
        `SELECT i.PRODUCT_ID AS productId,
                MAX(p.NAME) AS productName,
                MAX(p.BRAND) AS brand,
                MAX(p.SERIES) AS series,
                MAX(p.MODEL) AS model,
                MAX(p.CATEGORY) AS categoryPath,
                SUM(
                  GREATEST(COALESCE(i.NORMAL_QTY, 0),
                    COALESCE(i.REGULAR_QTY, 0) + COALESCE(i.SUBSIDY_QTY, 0) + COALESCE(i.SECOND_QTY, 0))
                  + COALESCE(i.DISPLAY_QTY, 0) + COALESCE(i.DEMO_QTY, 0)
                  + COALESCE(i.UNSELLABLE_QTY, 0) + COALESCE(i.PENDING_QTY, 0)
                ) AS quantity,
                ROUND(SUM((
                  GREATEST(COALESCE(i.NORMAL_QTY, 0),
                    COALESCE(i.REGULAR_QTY, 0) + COALESCE(i.SUBSIDY_QTY, 0) + COALESCE(i.SECOND_QTY, 0))
                  + COALESCE(i.DISPLAY_QTY, 0) + COALESCE(i.DEMO_QTY, 0)
                  + COALESCE(i.UNSELLABLE_QTY, 0) + COALESCE(i.PENDING_QTY, 0)
                ) * COALESCE(pp.COST_PRICE, 0)), 2) AS inventoryAmount,
                NULL AS oldestInboundTime
           FROM T_INVENTORY i
           INNER JOIN T_PRODUCT p ON p.PRODUCT_ID = i.PRODUCT_ID AND COALESCE(p.NEED_SN, 0) = 0
           LEFT JOIN T_PRODUCT_PRICE pp ON pp.PRODUCT_ID = i.PRODUCT_ID AND pp.STATUS = 1
          WHERE i.STORE_ID IN (:storeIds)
            ${storeClause}
            ${productLineClause}
          GROUP BY i.PRODUCT_ID`,
        replacements
      ),
      this.query(
        `SELECT CASE
                  WHEN DATEDIFF(NOW(), ps.INBOUND_TIME) <= 7 THEN '0-7天'
                  WHEN DATEDIFF(NOW(), ps.INBOUND_TIME) <= 15 THEN '8-15天'
                  WHEN DATEDIFF(NOW(), ps.INBOUND_TIME) <= 30 THEN '16-30天'
                  WHEN DATEDIFF(NOW(), ps.INBOUND_TIME) <= 60 THEN '31-60天'
                  ELSE '60天以上'
                END AS ageBucket,
                COUNT(*) AS quantity,
                ROUND(SUM(COALESCE(NULLIF(ps.INBOUND_PRICE, 0), pp.COST_PRICE, 0)), 2) AS inventoryAmount
           FROM T_PRODUCT_SN ps
           INNER JOIN T_PRODUCT p ON p.PRODUCT_ID = ps.PRODUCT_ID
           LEFT JOIN T_PRODUCT_PRICE pp ON pp.PRODUCT_ID = ps.PRODUCT_ID AND pp.STATUS = 1
          WHERE ps.IS_DELETED = 0
            AND ps.STATUS = 'in_stock'
            AND ps.INBOUND_TIME IS NOT NULL
            AND ps.STORE_ID IN (:storeIds)
            ${snStoreClause}
            ${productLineClause}
          GROUP BY ageBucket`,
        replacements
      )
    ]);

    const rows = [...snRows, ...nonSnRows]
      .map(row => ({
        ...row,
        quantity: toNumber(row.quantity),
        inventoryAmount: roundMoney(row.inventoryAmount)
      }))
      .filter(row => row.quantity > 0);
    const inventoryQuantity = rows.reduce((sum, row) => sum + row.quantity, 0);
    const inventoryAmount = roundMoney(rows.reduce((sum, row) => sum + row.inventoryAmount, 0));
    const categoryMap = new Map(INVENTORY_CATEGORY_ORDER.map(name => [name, { name, quantity: 0, amount: 0 }]));
    rows.forEach(row => {
      const category = classifyInventoryCategory(row);
      const target = categoryMap.get(category);
      if (!target) return;
      target.quantity += row.quantity;
      target.amount += row.inventoryAmount;
    });
    const staleProducts = rows
      .map(row => {
        const oldest = row.oldestInboundTime ? new Date(row.oldestInboundTime) : null;
        const inventoryAgeDays = oldest && !Number.isNaN(oldest.getTime())
          ? Math.max(0, Math.floor((Date.now() - oldest.getTime()) / 86400000))
          : null;
        return { ...row, inventoryAgeDays };
      })
      .filter(row => row.inventoryAgeDays === null || row.inventoryAgeDays > 30)
      .sort((a, b) => (b.inventoryAgeDays || 0) - (a.inventoryAgeDays || 0))
      .slice(0, 10);

    return {
      inventoryQuantity,
      skuCount: new Set(rows.map(row => row.productId).filter(Boolean)).size,
      inventoryAmount,
      categories: INVENTORY_CATEGORY_ORDER.map(name => ({
        ...categoryMap.get(name),
        quantity: Number(categoryMap.get(name).quantity || 0),
        amount: roundMoney(categoryMap.get(name).amount)
      })),
      ageStructure: ageRows.map(row => ({
        ageBucket: row.ageBucket,
        quantity: toNumber(row.quantity),
        inventoryAmount: roundMoney(row.inventoryAmount)
      })),
      staleProducts
    };
  }
}

class DailyKpiDashboardDataSource extends DashboardDataSource {
  async getFilters() {
    throw new Error('日汇总数据源尚未启用');
  }

  async getOverview() {
    throw new Error('日汇总数据源尚未启用');
  }
}

module.exports = {
  ARCHIVED_STATUSES,
  DashboardDataSource,
  RealtimeSqlDashboardDataSource,
  DailyKpiDashboardDataSource,
  normalizeParticipants,
  roundMoney,
  toNumber
};
