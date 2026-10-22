const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../models');
const { summarizeAllocatedExpenses } = require('../finance/expenseCostAllocation');
const { sendExcel } = require('../../utils/excelExport');

const ARCHIVED_STATUSES = ['completed', 'archived', '已归档', 'returned', '已退单'];

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value) {
  return Number(number(value).toFixed(2));
}

function validCost(value) {
  if (value === null || value === undefined || typeof value === 'boolean' || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function snapshotPurchaseCost(row) {
  let details = row.frozenPricingDetails;
  if (typeof details === 'string') {
    try { details = JSON.parse(details); } catch (_) { return null; }
  }
  const detail = Array.isArray(details) ? details.find(item => String(item.itemId ?? item.item_id) === String(row.itemId)) : null;
  if (!detail) return null;
  const cost = validCost(detail.purchasePrice);
  return cost !== null && (cost > 0 || detail.purchasePriceKnown === true) ? cost : null;
}

function resolveFinancialCost(row) {
  const settlement = validCost(row.purchaseUnitCost);
  // Pending rows may contain default zeroes; confirmed zero costs are valid.
  if (settlement !== null && (settlement > 0 || row.purchaseCostStatus === 'ready')) {
    return { unitCost: settlement, source: 'product_settlement' };
  }
  const archived = validCost(row.originalInventoryCost);
  if (archived !== null && (archived > 0 || row.archivedCostKnown === true)) {
    return { unitCost: archived, source: 'archived_inventory_cost' };
  }
  const frozen = snapshotPurchaseCost(row);
  if (frozen !== null) return { unitCost: frozen, source: 'frozen_purchase_cost' };
  const current = validCost(row.currentCostPrice);
  const active = row.currentPriceStatus === undefined || Number(row.currentPriceStatus) === 1;
  if (active && current !== null && (current > 0 || Number(row.costPriceLocked) === 1)) {
    return { unitCost: current, source: current === 0 ? 'explicit_locked_zero_cost' : 'estimated_inventory_cost' };
  }
  return { unitCost: null, source: 'missing_inventory_cost' };
}

function rate(value, fallback = 0.13) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function today() {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

function resolveDates(query = {}) {
  const endDate = String(query.endDate || today()).slice(0, 10);
  const startDate = String(query.startDate || `${endDate.slice(0, 7)}-01`).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    const error = new Error('日期格式不正确');
    error.status = 400;
    throw error;
  }
  if (startDate > endDate) {
    const error = new Error('开始日期不能晚于结束日期');
    error.status = 400;
    throw error;
  }
  return { startDate, endDate };
}

async function resolveStoreIds(user, requestedStoreId, requestedRegionId) {
  let storeIds = Array.isArray(user?.accessibleStoreIds) ? user.accessibleStoreIds.map(String) : [];
  if (storeIds.includes('*')) {
    const stores = await sequelize.query(
      'SELECT STORE_ID AS storeId FROM T_STORE WHERE IS_DELETED = 0 AND STATUS = 1',
      { type: QueryTypes.SELECT }
    );
    storeIds = stores.map(row => String(row.storeId));
  }
  if (requestedStoreId) {
    if (!storeIds.includes(String(requestedStoreId))) {
      const error = new Error('无权访问该门店');
      error.status = 403;
      throw error;
    }
    storeIds = [String(requestedStoreId)];
  }
  if (requestedRegionId) {
    const rows = await sequelize.query(
      `SELECT STORE_ID AS storeId
         FROM T_STORE
        WHERE IS_DELETED = 0 AND STATUS = 1
          AND REGION_ID = :regionId
          AND STORE_ID IN (:storeIds)`,
      { replacements: { regionId: String(requestedRegionId), storeIds: storeIds.length ? storeIds : ['__NO_STORE__'] }, type: QueryTypes.SELECT }
    );
    storeIds = rows.map(row => String(row.storeId));
  }
  return storeIds;
}

function calculateOrder(rows) {
  const first = rows[0];
  const originalGrossRevenue = money(Math.max(0, number(first.totalAmount) - number(first.discountAmount)));
  const returnedRevenue = money(rows.reduce((sum, row) => sum + Math.abs(number(row.returnedReceivable)), 0));
  const grossRevenue = money(Math.max(0, originalGrossRevenue - returnedRevenue));
  const itemSubtotal = rows.reduce((sum, row) => sum + Math.max(0, number(row.subtotal)), 0);
  let netRevenue = 0;
  let outputVat = 0;
  let grossCost = 0;
  let deductibleInputVat = 0;
  let bookCost = 0;
  let missingCost = false;
  const missingCostItems = [];

  rows.forEach((row, index) => {
    const weight = itemSubtotal > 0
      ? Math.max(0, number(row.subtotal)) / itemSubtotal
      : (rows.length ? 1 / rows.length : 0);
    const allocatedOriginalRevenue = index === rows.length - 1
      ? money(originalGrossRevenue - rows.slice(0, index).reduce((sum, previous) => {
          const previousWeight = itemSubtotal > 0
            ? Math.max(0, number(previous.subtotal)) / itemSubtotal
            : 1 / rows.length;
          return sum + money(originalGrossRevenue * previousWeight);
        }, 0))
      : money(originalGrossRevenue * weight);
    const allocatedGrossRevenue = money(Math.max(0, allocatedOriginalRevenue - Math.abs(number(row.returnedReceivable))));
    const outputRate = rate(row.outputTaxRate);
    const itemNetRevenue = money(allocatedGrossRevenue / (1 + outputRate));
    const itemOutputVat = money(allocatedGrossRevenue - itemNetRevenue);
    const quantity = Math.max(0, Math.trunc(number(row.quantity) || 1) - Math.abs(Math.trunc(number(row.returnedQuantity))));
    const cost = resolveFinancialCost(row);
    const itemGrossCost = money((cost.unitCost ?? 0) * quantity);
    const inputRate = rate(row.inputTaxRate);
    const deductible = Number(row.inputTaxDeductible ?? 1) === 1;
    const itemBookCost = deductible ? money(itemGrossCost / (1 + inputRate)) : itemGrossCost;
    const itemInputVat = deductible ? money(itemGrossCost - itemBookCost) : 0;

    if (quantity > 0 && cost.unitCost === null) {
      missingCost = true;
      missingCostItems.push({ itemId: row.itemId, productName: row.productName || '',
        reason: '缺少可确认的采购或归档库存成本；公司定价不能替代实际库存成本' });
    }
    netRevenue += itemNetRevenue;
    outputVat += itemOutputVat;
    grossCost += itemGrossCost;
    deductibleInputVat += itemInputVat;
    bookCost += itemBookCost;
  });

  netRevenue = money(netRevenue);
  outputVat = money(outputVat);
  grossCost = money(grossCost);
  deductibleInputVat = money(deductibleInputVat);
  bookCost = money(bookCost);
  const grossProfit = missingCost ? null : money(netRevenue - bookCost);
  return {
    orderId: first.orderId,
    orderNo: first.orderNo,
    businessDate: first.businessDate,
    storeId: first.storeId,
    storeName: first.storeName || '',
    customerName: first.customerName || '',
    grossRevenue,
    netRevenue,
    outputVat,
    grossCost,
    deductibleInputVat,
    bookCost,
    grossProfit,
    grossMargin: grossProfit === null || netRevenue <= 0 ? null : Number((grossProfit / netRevenue * 100).toFixed(2)),
    status: missingCost ? 'cost_pending' : 'estimated',
    missingCostItems,
    pendingCostReason: missingCostItems.map(item => `${item.productName || item.itemId || '商品'}：${item.reason}`).join('；'),
    itemCount: rows.length
  };
}

async function queryFinancialProfit(filters) {
  if (!filters.storeIds.length) return { items: [], operatingExpense: 0 };
  const replacements = {
    storeIds: filters.storeIds,
    startDate: filters.startDate,
    endDate: filters.endDate,
    statuses: ARCHIVED_STATUSES,
    orderKeyword: `%${filters.orderNo || ''}%`
  };
  const orderFilter = filters.orderNo ? 'AND o.ORDER_NO LIKE :orderKeyword' : '';
  const rows = await sequelize.query(
    `SELECT o.ORDER_ID AS orderId,
            o.ORDER_NO AS orderNo,
            DATE(o.CREATE_TIME) AS businessDate,
            o.STORE_ID AS storeId,
            s.NAME AS storeName,
            o.CUSTOMER_NAME AS customerName,
            o.TOTAL_AMOUNT AS totalAmount,
            o.DISCOUNT_AMOUNT AS discountAmount,
            oi.ITEM_ID AS itemId,
            oi.PRODUCT_NAME AS productName,
            oi.QUANTITY AS quantity,
            oi.SUBTOTAL AS subtotal,
            oi.ORIGINAL_INVENTORY_COST AS originalInventoryCost,
            psi.PURCHASE_UNIT_COST AS purchaseUnitCost,
            psi.COST_STATUS AS purchaseCostStatus,
            gp.PRODUCT_PRICING_DETAILS AS frozenPricingDetails,
            pp.COST_PRICE AS currentCostPrice,
            pp.COST_PRICE_LOCKED AS costPriceLocked,
            pp.STATUS AS currentPriceStatus,
            pp.OUTPUT_TAX_RATE AS outputTaxRate,
            pp.INPUT_TAX_RATE AS inputTaxRate,
            pp.INPUT_TAX_DEDUCTIBLE AS inputTaxDeductible,
            COALESCE(ret.RETURNED_QUANTITY, 0) AS returnedQuantity,
            COALESCE(ret.RETURNED_RECEIVABLE, 0) AS returnedReceivable
       FROM T_ORDER o
       INNER JOIN T_ORDER_ITEM oi ON oi.ORDER_ID = o.ORDER_ID
       LEFT JOIN T_STORE s ON s.STORE_ID = o.STORE_ID
       LEFT JOIN T_PRODUCT_SETTLEMENT_ITEM psi ON psi.SOURCE_ORDER_ITEM_ID = oi.ITEM_ID
       LEFT JOIN T_ORDER_GROSS_PROFIT gp ON gp.ORDER_ID = o.ORDER_ID AND gp.SNAPSHOT_STATUS = 'final'
       LEFT JOIN T_PRODUCT_PRICE pp ON pp.PRODUCT_ID = oi.PRODUCT_ID
       LEFT JOIN (
         SELECT sri.ORDER_ITEM_ID,
                SUM(sri.QUANTITY) AS RETURNED_QUANTITY,
                SUM(sri.USER_RECEIVABLE_AMOUNT) AS RETURNED_RECEIVABLE
           FROM T_SALES_RETURN_SETTLEMENT_ITEM sri
           INNER JOIN T_SALES_RETURN_SETTLEMENT sr ON sr.SETTLEMENT_ID = sri.SETTLEMENT_ID
          WHERE sr.SETTLEMENT_STATUS <> 'cancelled'
          GROUP BY sri.ORDER_ITEM_ID
       ) ret ON ret.ORDER_ITEM_ID = oi.ITEM_ID
      WHERE o.IS_DELETED = 0
        AND o.ORDER_STATUS IN (:statuses)
        AND o.STORE_ID IN (:storeIds)
        AND DATE(o.CREATE_TIME) BETWEEN :startDate AND :endDate
        ${orderFilter}
      ORDER BY o.CREATE_TIME DESC, o.ORDER_ID, oi.ITEM_ID`,
    { replacements, type: QueryTypes.SELECT }
  );
  const grouped = new Map();
  rows.forEach(row => {
    const list = grouped.get(String(row.orderId)) || [];
    list.push(row);
    grouped.set(String(row.orderId), list);
  });
  let items = [...grouped.values()].map(calculateOrder);
  const education = await require('../inventory/educationReward').educationIncome({ orderIds: [...grouped.keys()] });
  const educationByOrder = new Map();
  for (const row of education) educationByOrder.set(String(row.orderId), money((educationByOrder.get(String(row.orderId)) || 0) + row.amount));
  items = items.map(item => {
    const educationIncomeAmount = educationByOrder.get(String(item.orderId)) || 0;
    const grossProfit = item.grossProfit === null ? null : money(item.grossProfit + educationIncomeAmount);
    return { ...item, educationIncomeAmount, grossProfit,
      grossMargin: grossProfit === null || item.netRevenue <= 0 ? null : Number((grossProfit / item.netRevenue * 100).toFixed(2)) };
  });
  if (filters.status) items = items.filter(item => item.status === filters.status);

  const expenseSummary = await summarizeAllocatedExpenses({
    storeIds: filters.storeIds,
    dateMode: 'date',
    startDate: filters.startDate,
    endDate: filters.endDate
  });
  return { items, operatingExpense: money(expenseSummary.amount) };
}

function summarize(items, operatingExpense) {
  const ready = items.filter(item => item.grossProfit !== null);
  const netRevenue = money(items.reduce((sum, item) => sum + item.netRevenue, 0));
  const grossProfit = money(ready.reduce((sum, item) => sum + item.grossProfit, 0));
  return {
    orderCount: items.length,
    pendingOrderCount: items.length - ready.length,
    grossRevenue: money(items.reduce((sum, item) => sum + item.grossRevenue, 0)),
    netRevenue,
    outputVat: money(items.reduce((sum, item) => sum + item.outputVat, 0)),
    grossCost: money(items.reduce((sum, item) => sum + item.grossCost, 0)),
    deductibleInputVat: money(items.reduce((sum, item) => sum + item.deductibleInputVat, 0)),
    bookCost: money(items.reduce((sum, item) => sum + item.bookCost, 0)),
    grossProfit,
    grossMargin: netRevenue > 0 ? Number((grossProfit / netRevenue * 100).toFixed(2)) : 0,
    operatingExpense,
    operatingProfit: money(grossProfit - operatingExpense)
  };
}

async function resolveFilters(ctx) {
  const dates = resolveDates(ctx.query);
  return {
    ...dates,
    storeIds: await resolveStoreIds(
      ctx.state.user,
      String(ctx.query.storeId || '').trim(),
      String(ctx.query.regionId || '').trim()
    ),
    orderNo: String(ctx.query.orderNo || '').trim(),
    status: String(ctx.query.status || '').trim()
  };
}

async function getFinancialProfitOrders(ctx) {
  const filters = await resolveFilters(ctx);
  const result = await queryFinancialProfit(filters);
  const page = Math.max(1, Number(ctx.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(ctx.query.pageSize) || 20));
  const offset = (page - 1) * pageSize;
  ctx.body = {
    code: 0,
    data: {
      items: result.items.slice(offset, offset + pageSize),
      total: result.items.length,
      pagination: { page, pageSize, total: result.items.length },
      summary: summarize(result.items, result.operatingExpense),
      formulaVersion: 'FINANCIAL_GP_ESTIMATE_V1_20260919',
      note: '当前为财务暂估口径：不含税销售额-不含税存货成本，已完成退单按负向业务事实冲减；已确认0元库存成本正常计算，缺少成本依据的订单保留待补并列明原因。最终结果需结合发票勾选和月末结转确认。'
    }
  };
}

async function exportFinancialProfitOrders(ctx) {
  const filters = await resolveFilters(ctx);
  const result = await queryFinancialProfit(filters);
  const rows = result.items.map(item => ({
    '业务日期': item.businessDate,
    '销售单号': item.orderNo,
    '门店': item.storeName,
    '客户': item.customerName,
    '含税销售额': item.grossRevenue,
    '不含税销售额': item.netRevenue,
    '销项税额': item.outputVat,
    '含税成本': item.grossCost,
    '可抵扣进项税': item.deductibleInputVat,
    '不含税存货成本': item.bookCost,
    '财务毛利': item.grossProfit ?? '',
    '已确认教育补贴': item.educationIncomeAmount || 0,
    '毛利率': item.grossMargin === null ? '' : `${item.grossMargin}%`,
    '口径状态': item.status === 'cost_pending' ? '待补成本' : '暂估',
    '待补成本原因': item.pendingCostReason || ''
  }));
  sendExcel(ctx, rows, Object.keys(rows[0] || {}), `财务利润表_${filters.startDate}_${filters.endDate}.xlsx`, '逐单财务毛利');
}

module.exports = {
  resolveFinancialCost,
  queryFinancialProfit,
  summarize,
  calculateOrder,
  getFinancialProfitOrders,
  exportFinancialProfitOrders
};
