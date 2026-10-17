const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../models');
const { resolveReportStoreIds, isSelfOnlyReportUser } = require('../../utils/storePermissions');
const { summarizeAllocatedExpenses } = require('../finance/expenseCostAllocation');
const { INTERNAL_TRANSFER_SOURCE } = require('./operatingScope');
const { canViewProfit } = require('./dashboardService');

const SALES_CATEGORIES = ['nb', 'dt', 'phone', 'tablet', 'service', 'option'];
const ARCHIVED_STATUSES = ['已归档', 'completed', 'archived'];

function money(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round((number + Number.EPSILON) * 100) / 100 : 0;
}

function monthRange(startMonth, endMonth) {
  const start = String(startMonth || '').trim();
  const end = String(endMonth || '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(start) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(end)) {
    const error = new Error('请选择开始月份和结束月份');
    error.status = 400;
    throw error;
  }
  if (start > end) {
    const error = new Error('开始月份不能晚于结束月份');
    error.status = 400;
    throw error;
  }
  const [year, month] = end.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start, end, startAt: `${start}-01 00:00:00`, endAt: `${end}-${String(lastDay).padStart(2, '0')} 23:59:59` };
}

function categoryKey(value) {
  const root = String(value || '').split('/')[0].trim().toLowerCase().replace(/[\s_-]/g, '');
  if (/^(nb|笔记本|笔记本电脑|laptop|notebook)/.test(root)) return 'nb';
  if (/^(dt|台机|台式机|台式电脑|desktop)/.test(root)) return 'dt';
  if (/^(手机|phone|mobile)/.test(root)) return 'phone';
  if (/^(平板|tablet|ipad)/.test(root)) return 'tablet';
  if (/售后|电脑配件|服务|care/.test(root)) return 'service';
  // 其他 IoT 与选件在本报表统一归入选件。
  return 'option';
}

function expenseBucket(value) {
  const type = String(value || '').replace(/\s/g, '').toLowerCase();
  if (/固定|房租|租金|物业|水电|电话|宽带/.test(type)) return 'fixed';
  if (/人员|工资|社保|公积金|员工|招聘/.test(type)) return 'personnel';
  if (/日常|办公|差旅|交通|招待|餐饮|快递/.test(type)) return 'daily';
  return 'other';
}

function emptyRow(store) {
  return {
    storeId: String(store.storeId), storeName: store.storeName,
    sales: Object.fromEntries(SALES_CATEGORIES.map(key => [key, 0])),
    grossProfit: Object.fromEntries(SALES_CATEGORIES.map(key => [key, 0])),
    rebate: 0,
    expenses: { fixed: 0, personnel: 0, daily: 0, other: 0 }
  };
}

function finalizeRow(row, canSeeProfit) {
  const salesTotal = money(SALES_CATEGORIES.reduce((sum, key) => sum + row.sales[key], 0));
  const categoryGrossProfitTotal = money(SALES_CATEGORIES.reduce((sum, key) => sum + row.grossProfit[key], 0));
  const grossProfit = money(categoryGrossProfitTotal + row.rebate);
  const expenseTotal = money(Object.values(row.expenses).reduce((sum, value) => sum + value, 0));
  const netProfit = money(grossProfit - expenseTotal);
  const pct = (value, denominator) => denominator ? Number((value / denominator * 100).toFixed(2)) : 0;
  const result = {
    storeId: row.storeId,
    storeName: row.storeName,
    salesTotal,
    categoryGrossProfitTotal,
    sales: Object.fromEntries(SALES_CATEGORIES.map(key => [key, money(row.sales[key])])),
    salesShare: Object.fromEntries(SALES_CATEGORIES.map(key => [key, pct(row.sales[key], salesTotal)])),
    expenses: Object.fromEntries(Object.entries(row.expenses).map(([key, value]) => [key, money(value)])),
    expenseTotal
  };
  if (canSeeProfit) {
    result.grossProfit = grossProfit;
    result.netProfit = netProfit;
    result.grossProfitRate = pct(grossProfit, salesTotal);
    result.expenseRate = pct(expenseTotal, salesTotal);
    result.categoryGrossProfit = Object.fromEntries(SALES_CATEGORIES.map(key => [key, money(row.grossProfit[key])]));
    result.categoryGrossProfitRate = Object.fromEntries(SALES_CATEGORIES.map(key => [key, pct(row.grossProfit[key], row.sales[key])]));
    result.categoryGrossProfitShare = Object.fromEntries(SALES_CATEGORIES.map(key => [key, pct(row.grossProfit[key], categoryGrossProfitTotal)]));
    result.rebate = money(row.rebate);
  }
  return result;
}

async function getSalesStatement(ctx) {
  const period = monthRange(ctx.query.startMonth, ctx.query.endMonth);
  const user = ctx.state.user;
  const readableStoreIds = (await resolveReportStoreIds(user)).map(String);
  let storeIds = readableStoreIds.includes('*')
    ? (await sequelize.query(
      'SELECT STORE_ID AS storeId FROM T_STORE WHERE IS_DELETED = 0 AND STATUS = 1',
      { type: QueryTypes.SELECT }
    )).map(row => String(row.storeId))
    : readableStoreIds;
  if (ctx.query.storeId) {
    if (!readableStoreIds.includes('*') && !readableStoreIds.includes(String(ctx.query.storeId))) ctx.throw(403, '无权访问该门店销售报表');
    storeIds = storeIds.filter(id => id === String(ctx.query.storeId));
  }
  if (!storeIds.length) {
    ctx.body = { code: 0, data: { period, canViewProfit: canViewProfit(user), rows: [], summary: null } };
    return;
  }

  const stores = await sequelize.query(
    `SELECT STORE_ID AS storeId, NAME AS storeName
       FROM T_STORE
      WHERE IS_DELETED = 0 AND STATUS = 1 AND STORE_ID IN (:storeIds)
      ORDER BY STORE_ID`,
    { replacements: { storeIds }, type: QueryTypes.SELECT }
  );
  const rowMap = new Map(stores.map(store => [String(store.storeId), emptyRow(store)]));
  const selfOnly = isSelfOnlyReportUser(user);
  const staffId = String(user?.staffId || '');
  const employeeClause = selfOnly
    ? `AND (:staffId <> '' AND (o.CREATE_STAFF_ID = :staffId
        OR JSON_SEARCH(o.AUXILIARY_SALES_LIST, 'one', :staffId, NULL, '$[*].staffId') IS NOT NULL
        OR JSON_SEARCH(o.AUXILIARY_SALES_LIST, 'one', :staffId, NULL, '$[*].staff_id') IS NOT NULL))`
    : '';
  const replacements = {
    storeIds,
    startAt: period.startAt,
    endAt: period.endAt,
    archivedStatuses: ARCHIVED_STATUSES,
    internalTransferSource: `${INTERNAL_TRANSFER_SOURCE}%`,
    staffId,
    selfOnly: selfOnly ? 1 : 0
  };

  const salesRows = await sequelize.query(
    `SELECT o.STORE_ID AS storeId, COALESCE(p.CATEGORY, '') AS categoryPath,
            SUM(COALESCE(oi.SUBTOTAL, 0)) AS salesAmount
       FROM T_ORDER o
       INNER JOIN T_ORDER_ITEM oi ON oi.ORDER_ID = o.ORDER_ID
       LEFT JOIN T_PRODUCT p ON p.PRODUCT_ID = oi.PRODUCT_ID
      WHERE o.IS_DELETED = 0 AND o.ORDER_STATUS IN (:archivedStatuses)
        AND o.STORE_ID IN (:storeIds) AND o.CREATE_TIME BETWEEN :startAt AND :endAt
        AND COALESCE(TRIM(o.CUSTOMER_SOURCE), '') NOT LIKE :internalTransferSource
        ${employeeClause}
      GROUP BY o.STORE_ID, COALESCE(p.CATEGORY, '')`,
    { replacements, type: QueryTypes.SELECT }
  );
  salesRows.forEach(row => {
    const store = rowMap.get(String(row.storeId));
    if (store) store.sales[categoryKey(row.categoryPath)] += Number(row.salesAmount || 0);
  });

  // 已完成退货按负向销售事实计入发生月份，并依原商品分类冲减。
  const returnRows = await sequelize.query(
    `SELECT rs.STORE_ID AS storeId, COALESCE(p.CATEGORY, '') AS categoryPath,
            SUM(COALESCE(rsi.USER_RECEIVABLE_AMOUNT, 0)) AS salesAmount
       FROM T_SALES_RETURN_SETTLEMENT rs
       INNER JOIN T_SALES_RETURN_SETTLEMENT_ITEM rsi ON rsi.SETTLEMENT_ID = rs.SETTLEMENT_ID
       LEFT JOIN T_ORDER_ITEM oi ON oi.ITEM_ID = rsi.ORDER_ITEM_ID
       LEFT JOIN T_PRODUCT p ON p.PRODUCT_ID = COALESCE(rsi.PRODUCT_ID, oi.PRODUCT_ID)
      WHERE rs.STORE_ID IN (:storeIds) AND rs.CREATE_TIME BETWEEN :startAt AND :endAt
        AND rs.SETTLEMENT_STATUS <> 'cancelled'
        AND NOT EXISTS (
          SELECT 1 FROM T_ORDER operating_order
           WHERE operating_order.ORDER_ID = rs.ORDER_ID
             AND COALESCE(TRIM(operating_order.CUSTOMER_SOURCE), '') LIKE :internalTransferSource
        )
        AND (:selfOnly = 0 OR EXISTS (
          SELECT 1 FROM T_ORDER original_order
           WHERE original_order.ORDER_ID = rs.ORDER_ID
             AND (original_order.CREATE_STAFF_ID = :staffId
               OR JSON_SEARCH(original_order.AUXILIARY_SALES_LIST, 'one', :staffId, NULL, '$[*].staffId') IS NOT NULL
               OR JSON_SEARCH(original_order.AUXILIARY_SALES_LIST, 'one', :staffId, NULL, '$[*].staff_id') IS NOT NULL)
         ))
       GROUP BY rs.STORE_ID, COALESCE(p.CATEGORY, '')`,
    { replacements, type: QueryTypes.SELECT }
  );
  returnRows.forEach(row => {
    const store = rowMap.get(String(row.storeId));
    if (store) store.sales[categoryKey(row.categoryPath)] += Number(row.salesAmount || 0);
  });

  const canProfit = canViewProfit(user);
  if (canProfit) {
    const grossProfitRows = await sequelize.query(
      `SELECT o.STORE_ID AS storeId, COALESCE(p.CATEGORY, '') AS categoryPath,
              SUM(CASE
                WHEN gp.GROSS_PROFIT_ID IS NOT NULL AND COALESCE(o.TOTAL_AMOUNT, 0) <> 0
                  THEN gp.GROSS_PROFIT_AMOUNT * COALESCE(oi.SUBTOTAL, 0) / o.TOTAL_AMOUNT
                WHEN COALESCE(oi.ORIGINAL_INVENTORY_COST, 0) <> 0
                  OR COALESCE(oi.SALES_SETTLEMENT_COST, 0) <> 0
                  OR COALESCE(oi.SALES_GROSS_PROFIT, 0) <> 0
                  OR COALESCE(oi.COST_ADJUSTMENT_AMOUNT, 0) <> 0
                  OR COALESCE(oi.ORIGINAL_PICKUP_PRICE, 0) <> 0
                  THEN COALESCE(oi.SALES_GROSS_PROFIT, 0)
                ELSE COALESCE(oi.SUBTOTAL, 0)
                  - COALESCE(NULLIF(ps.INBOUND_PRICE, 0), NULLIF(pp.COST_PRICE, 0), 0) * COALESCE(oi.QUANTITY, 1)
              END) AS grossProfit
         FROM T_ORDER o
         INNER JOIN T_ORDER_ITEM oi ON oi.ORDER_ID = o.ORDER_ID
         LEFT JOIN T_ORDER_GROSS_PROFIT gp ON gp.ORDER_ID = o.ORDER_ID
         LEFT JOIN T_PRODUCT p ON p.PRODUCT_ID = oi.PRODUCT_ID
         LEFT JOIN T_PRODUCT_SN ps ON ps.SN_ID = oi.SN_ID AND ps.IS_DELETED = 0
         LEFT JOIN T_PRODUCT_PRICE pp ON pp.PRODUCT_ID = oi.PRODUCT_ID AND pp.STATUS = 1
        WHERE o.IS_DELETED = 0 AND o.ORDER_STATUS IN (:archivedStatuses)
          AND o.STORE_ID IN (:storeIds) AND o.CREATE_TIME BETWEEN :startAt AND :endAt
          AND COALESCE(TRIM(o.CUSTOMER_SOURCE), '') NOT LIKE :internalTransferSource
          ${employeeClause}
        GROUP BY o.STORE_ID, COALESCE(p.CATEGORY, '')`,
      { replacements, type: QueryTypes.SELECT }
    );
    grossProfitRows.forEach(row => {
      const store = rowMap.get(String(row.storeId));
      if (store) store.grossProfit[categoryKey(row.categoryPath)] += Number(row.grossProfit || 0);
    });

    const returnedGrossProfitRows = await sequelize.query(
      `SELECT ri.STORE_ID AS storeId, ri.categoryPath,
              SUM(rg.grossProfit * ABS(ri.salesAmount) / NULLIF(rt.returnSales, 0)) AS grossProfit
         FROM (
           SELECT rs.RETURN_ID AS returnId, rs.STORE_ID,
                  COALESCE(p.CATEGORY, '') AS categoryPath,
                  SUM(COALESCE(rsi.USER_RECEIVABLE_AMOUNT, 0)) AS salesAmount
             FROM T_SALES_RETURN_SETTLEMENT rs
             INNER JOIN T_SALES_RETURN_SETTLEMENT_ITEM rsi ON rsi.SETTLEMENT_ID = rs.SETTLEMENT_ID
             LEFT JOIN T_ORDER_ITEM oi ON oi.ITEM_ID = rsi.ORDER_ITEM_ID
             LEFT JOIN T_PRODUCT p ON p.PRODUCT_ID = COALESCE(rsi.PRODUCT_ID, oi.PRODUCT_ID)
             INNER JOIN T_ORDER original_order ON original_order.ORDER_ID = rs.ORDER_ID
            WHERE rs.STORE_ID IN (:storeIds) AND rs.CREATE_TIME BETWEEN :startAt AND :endAt
              AND rs.SETTLEMENT_STATUS <> 'cancelled'
              AND COALESCE(TRIM(original_order.CUSTOMER_SOURCE), '') NOT LIKE :internalTransferSource
              ${selfOnly ? `AND (original_order.CREATE_STAFF_ID = :staffId
                OR JSON_SEARCH(original_order.AUXILIARY_SALES_LIST, 'one', :staffId, NULL, '$[*].staffId') IS NOT NULL
                OR JSON_SEARCH(original_order.AUXILIARY_SALES_LIST, 'one', :staffId, NULL, '$[*].staff_id') IS NOT NULL)` : ''}
            GROUP BY rs.RETURN_ID, rs.STORE_ID, COALESCE(p.CATEGORY, '')
         ) ri
         INNER JOIN (
           SELECT RETURN_ID AS returnId, SUM(ABS(USER_RECEIVABLE_AMOUNT)) AS returnSales
             FROM T_SALES_RETURN_SETTLEMENT_ITEM
            GROUP BY RETURN_ID
         ) rt ON rt.returnId = ri.returnId
         INNER JOIN (
           SELECT RETURN_ID AS returnId, STORE_ID, SUM(GROSS_PROFIT_AMOUNT) AS grossProfit
             FROM T_SALES_RETURN_GROSS_PROFIT
            GROUP BY RETURN_ID, STORE_ID
         ) rg ON rg.returnId = ri.returnId AND rg.STORE_ID = ri.STORE_ID
        GROUP BY ri.STORE_ID, ri.categoryPath`,
      { replacements, type: QueryTypes.SELECT }
    );
    returnedGrossProfitRows.forEach(row => {
      const store = rowMap.get(String(row.storeId));
      if (store) store.grossProfit[categoryKey(row.categoryPath)] += Number(row.grossProfit || 0);
    });

    const rebateRows = await sequelize.query(
      `SELECT o.STORE_ID AS storeId, SUM(COALESCE(re.REBATE_ESTIMATE_AMOUNT, 0)) AS rebate
         FROM T_REBATE_ESTIMATE re
         INNER JOIN T_ORDER o ON o.ORDER_ID = re.SALES_ORDER_ID
        WHERE re.STATUS = 'confirmed' AND re.SOURCE_TYPE = 'manufacturer_rebate_confirmation'
          AND o.IS_DELETED = 0 AND o.ORDER_STATUS IN (:archivedStatuses)
          AND o.STORE_ID IN (:storeIds) AND o.CREATE_TIME BETWEEN :startAt AND :endAt
          AND COALESCE(TRIM(o.CUSTOMER_SOURCE), '') NOT LIKE :internalTransferSource
          ${employeeClause}
        GROUP BY o.STORE_ID`,
      { replacements, type: QueryTypes.SELECT }
    );
    rebateRows.forEach(row => {
      const store = rowMap.get(String(row.storeId));
      if (store) store.rebate += Number(row.rebate || 0);
    });

    const monthKeys = [];
    for (let current = period.start; current <= period.end;) {
      monthKeys.push(current);
      const [year, month] = current.split('-').map(Number);
      current = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
    }
    const expenseSummary = await summarizeAllocatedExpenses({ storeIds, dateMode: 'accounting_month', monthKeys });
    (expenseSummary.byStoreType || []).forEach(expense => {
      const store = rowMap.get(String(expense.storeId));
      if (store) store.expenses[expenseBucket(expense.expenseType)] += Number(expense.amount || 0);
    });
  }

  let rows = [...rowMap.values()].map(row => finalizeRow(row, canProfit));
  if (selfOnly) rows = rows.filter(row => row.salesTotal !== 0);
  const summaryRow = emptyRow({ storeId: '', storeName: '合计' });
  rows.forEach(row => {
    SALES_CATEGORIES.forEach(key => {
      summaryRow.sales[key] += Number(row.sales[key] || 0);
      if (canProfit) summaryRow.grossProfit[key] += Number(row.categoryGrossProfit[key] || 0);
    });
    if (canProfit) {
      summaryRow.rebate += Number(row.rebate || 0);
      Object.keys(summaryRow.expenses).forEach(key => { summaryRow.expenses[key] += Number(row.expenses[key] || 0); });
    }
  });
  const summary = finalizeRow(summaryRow, canProfit);
  ctx.body = { code: 0, data: { period, canViewProfit: canProfit, rows, summary } };
}

module.exports = { getSalesStatement, categoryKey, expenseBucket, monthRange };
