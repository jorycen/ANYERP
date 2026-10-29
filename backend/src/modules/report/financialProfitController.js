const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../models');


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
  // 原整机已计入公司成本；回收审批确认的是内部经营价值，不能再当成一次外部采购成本扣除。
  if (row.purchaseCostSource === 'sales_component_recovery_value') return { unitCost: null, source: 'recovery_financial_allocation_pending' };
  const settlement = validCost(row.purchaseUnitCost);
  // Pending rows may contain default zeroes; confirmed zero costs are valid.
  if (settlement !== null && (settlement > 0 || row.purchaseCostStatus === 'ready' || row.purchaseCostSource === 'manual_sold_cost')) {
    return { unitCost: settlement, source: 'product_settlement' };
  }
  const archived = validCost(row.originalInventoryCost);
  if (archived !== null && (archived > 0 || row.archivedCostKnown === true)) {
    return { unitCost: archived, source: 'archived_inventory_cost' };
  }
  const frozen = snapshotPurchaseCost(row);
  if (frozen !== null) return { unitCost: frozen, source: 'frozen_purchase_cost' };
  return { unitCost: null, source: 'missing_inventory_cost' };
}

function rate(value, fallback = 0.13) {
  const parsed = value === null || value === undefined || value === '' ? NaN : Number(value);
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
  require('./financialProfitControl').validDate(startDate);
  require('./financialProfitControl').validDate(endDate);
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
      'SELECT STORE_ID AS storeId FROM T_STORE',
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
        WHERE REGION_ID = :regionId
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
  const detailItems = [];

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
    detailItems.push({ itemId: row.itemId, productName: row.productName, quantity, unitCost: cost.unitCost,
      costSource: cost.source, costState: require('../../utils/costKnowledge').costState(cost.unitCost), grossRevenue: allocatedGrossRevenue, netRevenue: itemNetRevenue, outputVat: itemOutputVat,
      grossCost: itemGrossCost, bookCost: itemBookCost, estimatedInputVat: itemInputVat, outputRate, inputRate });
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
    costState: missingCost ? 'pending' : detailItems.every(item => item.quantity === 0) ? 'not_applicable' : grossCost === 0 ? 'confirmed_zero' : 'known',
    missingCostItems,
    pendingCostReason: missingCostItems.map(item => `${item.productName || item.itemId || '商品'}：${item.reason}`).join('；'),
    detailItems,
    itemCount: rows.length
  };
}

async function queryFinancialProfit(filters) {
  return require('./financialProfitEngine').query(filters, calculateOrder);
}

function summarize(items, operatingExpense) {
  return require('./financialProfitEngine').summarize(items, operatingExpense);
}

async function resolveFilters(ctx) {
  const dates = resolveDates(ctx.query.periodType
    ? require('./financeOverviewController').resolvePeriod(ctx.query)
    : ctx.query);
  return {
    ...dates,
    includeStores: String(ctx.query.mobile || '') === '1',
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
  const displayItems = ctx.query.view === 'company' ? result.profitDetails || [] : result.items;
  const page = Math.max(1, Number(ctx.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(ctx.query.pageSize) || 20));
  const offset = (page - 1) * pageSize;
  ctx.body = {
    code: 0,
    data: {
      items: displayItems.slice(offset, offset + pageSize),
      total: displayItems.length,
      pagination: { page, pageSize, total: displayItems.length },
      summary: result.summary,
      scopeLabel: !ctx.query.storeId && !ctx.query.regionId && (ctx.state.user.accessibleStoreIds || []).includes('*')
        ? '公司经营利润' : '所选范围财务经营利润',
      policyItems: result.policyItems,
      issueItems: result.issueItems,
      discrepancies: result.discrepancies,
      expenseEntries: result.expenseEntries,
      periods: result.periods,
      canReview: ['boss','admin','finance'].some(role => require('../../middleware/permission').getUserRoles(ctx.state.user).includes(role)),
      canClose: require('../../middleware/permission').getUserRoles(ctx.state.user).includes('boss') && (ctx.state.user.accessibleStoreIds || []).includes('*'),
      formulaVersion: 'FINANCIAL_PROFIT_V2_20261023',
      note: '销售按归档时间、退货按退货结算发生时间分开列示。成本仅读取原单及有审计的补录；商品税率仅为暂估，财务核实后冻结依据。政策不重复叠加内部80%/20%分配；月结结果使用已保存快照。'
    }
  };
  // 小程序只返回当前页展示字段，年度公司范围不携带全部订单/费用的冻结凭据。
  if (String(ctx.query.mobile || '') === '1') {
    const data = ctx.body.data;
    const range = require('./dashboardService').buildRanges(filters).current;
    const operating = await require('./operatingProfit').queryOperatingProfit({ storeIds: filters.storeIds, archiveScope: 'archived' }, range);
    const metrics = (row, summary) => {
      const known = row && row.grossProfit !== null && row.grossProfit !== undefined;
      const cost = summary.operatingExpense;
      const value = known && cost !== null && cost !== undefined ? money(row.grossProfit - cost) : null;
      return { source: operating.source, grossProfit: known ? row.grossProfit : null,
        salesGrossProfit: known ? row.grossProfit : null, approvedAdjustment: row?.approvedAdjustment ?? null,
        grossMargin: known && row.salesAmount ? money(row.grossProfit / row.salesAmount * 100) : null, salesAmount: row?.salesAmount ?? null,
        cost, estimatedOperatingProfit: value,
        operatingProfit: summary.taxComplete && !summary.pendingOrderCount ? value : null };
    };
    const operatingByStore = new Map((operating.rows || []).map(row => [String(row.storeId), row]));
    const paginate = (rows, requestedPage) => {
      const current = Math.max(1, Math.floor(Number(requestedPage) || 1));
      return { rows: rows.slice((current - 1) * pageSize, current * pageSize), page: current, total: rows.length };
    };
    const expenses = paginate(result.expenseEntries || [], ctx.query.expensePage);
    const issues = paginate(result.issueItems || [], ctx.query.issuePage);
    const fields = (row, names) => Object.fromEntries(names.map(name => [name, row[name]]));
    ctx.body.data = {
      summary: data.summary, operatingMetrics: metrics(operating.summary, data.summary),
      period: { startDate: filters.startDate, endDate: filters.endDate },
      storeSummaries: (result.storeSummaries || []).map(row => ({ ...row, operatingMetrics: metrics(operatingByStore.get(String(row.storeId)) || { salesAmount: 0, grossProfit: 0, approvedAdjustment: 0 }, row.summary) })), canReview: data.canReview,
      scopeLabel: '财务经营利润', total: data.total, pagination: data.pagination,
      items: data.items.map(row => fields(row, ['eventKey', 'orderId', 'orderNo', 'entryNo', 'entryTypeLabel', 'storeName', 'businessDate', 'grossCost', 'grossProfit', 'status', 'taxStatus', 'costState', 'salesGrossProfit', 'productGrossProfit', 'operationsGrossProfit', 'companyGrossProfit', 'profitStatus', 'profitPendingReason'])),
      expenseEntries: expenses.rows.map(row => fields(row, ['eventKey', 'expenseId', 'expenseType', 'storeId', 'storeName', 'category', 'businessDate', 'bookCost', 'amount', 'status', 'amortizationStartMonth', 'amortizationEndMonth'])),
      expensePagination: { page: expenses.page, total: expenses.total },
      issueItems: issues.rows.map(row => fields(row, ['eventKey', 'orderNo', 'entryNo', 'entryType', 'pendingCostReason'])),
      issuePagination: { page: issues.page, total: issues.total }
    };
  }
}

async function exportFinancialProfitOrders(ctx) {
  const filters = await resolveFilters(ctx);
  const result = await queryFinancialProfit(filters);
  const XLSX = require('xlsx'), workbook = XLSX.utils.book_new();
  const append = (name, rows) => XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), name);
  const value = amount => amount === null || amount === undefined ? '待核算' : amount;
  const costLabels = { known: '成本已知', confirmed_zero: '已确认零成本', pending: '待补成本', not_applicable: '不适用' };
  const detailHeaders = ['业务日期','类型','单号','关联销售单','门店','销售端毛利','产品端毛利','运营毛利','公司经营毛利','含税成本','成本状态','财务商品毛利','毛利状态','待核算原因','成本来源'];
  const profitSheet = XLSX.utils.json_to_sheet((result.profitDetails || []).map(item => ({
    业务日期: item.businessDate, 类型: item.entryTypeLabel, 单号: item.entryNo, 关联销售单: item.orderNo || '', 门店: item.storeName,
    销售端毛利: value(item.salesGrossProfit), 产品端毛利: value(item.productGrossProfit), 运营毛利: value(item.operationsGrossProfit),
    公司经营毛利: value(item.companyGrossProfit), 含税成本: item.grossCost ?? (item.costState === 'pending' ? '待核算' : '不适用'), 成本状态: costLabels[item.costState] || '待核对',
    财务商品毛利: item.grossProfit ?? (['sale','return','adjustment'].includes(item.entryType) ? '待核算' : '不适用'),
    毛利状态: item.profitStatus === 'pending' ? '待核算' : '已核算', 待核算原因: item.profitPendingReason || item.pendingCostReason || '',
    成本来源: (item.detailItems || []).map(row => `${row.productName || row.itemId}：${row.costSource || '待核对'}`).join('；')
  })), { header: detailHeaders });
  XLSX.utils.book_append_sheet(workbook, profitSheet, '利润明细');
  append('毛利汇总', [['销售端毛利','salesGrossProfit'],['产品端毛利','productGrossProfit'],['运营毛利','operationsGrossProfit'],
    ['公司经营毛利合计','companyGrossProfit'],['已核算事件毛利小计','knownCompanyGrossProfit'],['毛利待核算笔数','profitPendingCount']]
    .map(([label,key]) => ({ 指标: label, 金额或笔数: value(result.summary[key]) })));
  const summaryLabels = { netRevenue:'全部不含税销售净额', completeRevenue:'成本完整范围销售净额', completeBookCost:'成本完整范围存货成本',
    grossProfit:'成本完整范围商品毛利', grossMargin:'成本完整范围毛利率%', overallGrossMargin:'整体毛利率%', pendingOrderCount:'待补成本或依据变化笔数', pendingRevenue:'待核算销售净额', costCompleteness:'成本完整率%',
    taxPendingCount:'税务待核实笔数', policyPendingCount:'政策待分类笔数', expenseTaxPendingCount:'费用待核实笔数', unperiodizedExpenseCount:'未设置期间费用笔数',
    policyAdjustment:'本期政策调整净额', storeExpense:'门店费用', productExpense:'产品端费用', companyExpense:'公司费用', operatingExpense:'成本费用合计',
    estimatedOperatingProfit:'已知毛利减费用暂估参考', operatingProfit:'依据核实后的经营收益', managementSalesGross:'销售经营毛利含考核调整', managementProductGross:'产品端经营毛利', managementCombinedGross:'经营口径毛利合计',
    financialComparableGross:'财务商品及政策收益', managementDifference:'经营财务口径差额', expenseScopeNote:'费用范围说明' };
  append('汇总及口径', Object.entries(summaryLabels).map(([key,label]) => ({ 指标: label, 值: result.summary[key] === null || result.summary[key] === undefined ? '未完整/不适用' : result.summary[key] })));
  append('销售退货及调整', result.items.map(item => ({
    业务日期: item.businessDate, 类型: item.entryType, 单号: item.entryNo, 原销售单: item.orderNo, 门店: item.storeName,
    含税销售额: item.grossRevenue, 不含税销售额: item.netRevenue, 销项税额: item.outputVat,
    含税成本: item.status === 'cost_pending' ? '待核算' : item.grossCost, 分摊进项税额: item.status === 'cost_pending' ? '待核算' : item.deductibleInputVat, 存货成本: item.status === 'cost_pending' ? '待核算' : item.bookCost,
    商品毛利: item.grossProfit ?? '待补成本', 状态: item.status, 税务状态: item.taxStatus, 已关账: item.closed ? '是' : '否', 待核算原因: item.pendingCostReason || '', 核实依据: item.review?.evidence || ''
  })));
  append('政策调整', result.policyItems.map(item => ({ 日期: item.businessDate, 单号: item.entryNo, 原销售单: item.orderNo, 返利全额: item.policyAmount,
    产品经营分配: item.productAllocation, 财务分类: item.review?.treatment || '待核实', 本期政策损益: item.policyImpact || 0,
    税务影响: item.review?.taxImpact ?? '', 状态: item.status, 依据: item.review?.evidence || '' })));
  append('费用', result.expenseEntries.map(item => ({ 日期: item.businessDate, 费用编号: item.expenseId, 费用类型: item.expenseType, 归属: item.category,
    含税金额: item.grossCost, 分摊进项税: item.deductibleInputVat || 0, 成本费用: item.bookCost, 状态: item.status, 依据: item.review?.evidence || '' })));
  append('关账后差异', result.discrepancies.map(item => ({ 日期: item.businessDate, 单号: item.entryNo, 原因: item.reason, 原事件: item.eventKey })));
  append('口径说明', [{ 说明: '税额未经财务核实前均为暂估。商品毛利率以成本完整范围计算；内部前折、外调及80%/20%分配不重复计入公司利润。关账月份使用快照。费用按归属月份计入（月内日期按月初），未设置月份时按费用日期。' }]);
  ctx.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  ctx.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`公司利润分析_${filters.startDate}_${filters.endDate}.xlsx`)}`);
  ctx.body = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = {
  resolveFinancialCost,
  queryFinancialProfit,
  summarize,
  calculateOrder,
  getFinancialProfitOrders,
  exportFinancialProfitOrders,
  resolveFilters,
  calculateOrder
};
