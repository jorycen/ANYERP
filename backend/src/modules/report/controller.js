/**
 * 报表管理控制器
 */
const {
  Order,
  OrderItem,
  OrderGrossProfit,
  SalesReturnGrossProfitLedger,
  SalesReturnSettlement,
  ProductSn,
  Product,
  ProductPrice,
  ProductCategory,
  ProductSettlementItem,
  Store,
  Distributor,
  Staff,
  SalesReturnRequest,
  Region,
  PerformanceProfitAdjustment,
  ExpensePerformanceAllocation,
  sequelize
} = require('../../models');
const { Op } = require('sequelize');
const { loadLegacyCostMaps, calculateItemBaseProfit } = require('./profitCalculation');
const { DashboardService, canViewProfit } = require('./dashboardService');
const { normalizeParticipants } = require('./dashboardDataSource');
const { allocateProfit } = require('./performanceAllocation');
const { PERFORMANCE_SALE_STATUSES: POSITIVE_SALES_ORDER_STATUSES, returnEvents, savedItemProfit } = require('./performanceEvents');
const { buildDecisionInsights, buildAiAdvisor } = require('./decisionEngine');
const { resolveReportStoreIds, isSelfOnlyReportUser } = require('../../utils/storePermissions');
const { appendOperatingSourceCondition, INTERNAL_TRANSFER_SOURCE } = require('./operatingScope');
const {
  snapshotToResponse
} = require('../sales/grossProfit');
const { careCostDetails } = require('../sales/staffCareCredit');
const { sendExcel } = require('../../utils/excelExport');

const dashboardService = new DashboardService();
const EMPLOYEE_PROFIT_EXPORT_HEADERS = [
  "\u4e1a\u52a1\u7c7b\u578b", "\u539f\u9500\u552e\u5355\u53f7",
  '订单号', '销售时间', '员工', '门店', '客户', '商品名称', 'PN', 'SN', '数量', '销售单价', '商品销售额',
  '商品定价单价', '商品定价金额', '商品分摊收入', '商品分摊基础毛利', '毛利计算口径', '订单组成-用户应收',
  '订单组成-商品定价', '订单组成-支付手续费', '订单组成-增值税', '订单组成-补录净额', '订单组成-运费',
  '订单组成-开票金额', '订单组成-外调费', '支付方式明细', '补录明细', '运费明细', '订单基础毛利',
  'Care可用金抵扣', '其他审批调整', '员工业绩毛利', '毛利率百分比', '毛利来源'
];

function toNumber(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
}

function roundMoney(value) {
  return Number(toNumber(value).toFixed(2));
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function calcRate(value, base) {
  const denominator = toNumber(base);
  if (denominator === 0) return 0;
  return Number(((toNumber(value) / denominator) * 100).toFixed(2));
}

function hasRole(user, role) {
  if (Array.isArray(user?.roles) && user.roles.length > 0) return user.roles.includes(role);
  return String(user?.roleCode || '').split(',').map(item => item.trim()).includes(role);
}

function taxRate(value, fallback = 0.13) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function buildCategoryPath(categoryId, categoryMap, fallback = '') {
  const names = [];
  const visited = new Set();
  let currentId = String(categoryId || '');
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const current = categoryMap.get(currentId);
    if (!current) break;
    if (current.name) names.unshift(current.name);
    currentId = String(current.parent_id || '');
  }
  return names.join(' / ') || fallback || '未分类';
}

function aggregateProductSalesMetrics(rows = []) {
  const groups = new Map();
  rows.forEach(row => {
    const dimensions = {
      category: row.category || '未分类',
      categoryPath: row.categoryPath || row.category || '未分类',
      brand: row.brand || '-',
      series: row.series || '-',
      model: row.model || '-'
    };
    const key = JSON.stringify(dimensions);
    const current = groups.get(key) || {
      ...dimensions,
      itemCount: 0,
      totalQuantity: 0,
      totalAmount: 0,
      salesGrossProfit: 0,
      productGrossProfit: 0,
      financialGrossProfit: 0,
      productGrossProfitPendingCount: 0,
      financialGrossProfitPendingCount: 0
    };
    current.itemCount += 1;
    current.totalQuantity += toNumber(row.quantity);
    current.totalAmount += toNumber(row.salesAmount);
    current.salesGrossProfit += toNumber(row.salesGrossProfit);
    if (row.productGrossProfit === null || row.productGrossProfit === undefined) current.productGrossProfitPendingCount += 1;
    else current.productGrossProfit += toNumber(row.productGrossProfit);
    if (row.financialGrossProfit === null || row.financialGrossProfit === undefined) current.financialGrossProfitPendingCount += 1;
    else current.financialGrossProfit += toNumber(row.financialGrossProfit);
    groups.set(key, current);
  });
  return [...groups.values()].map(row => ({
    ...row,
    totalQuantity: Number(row.totalQuantity.toFixed(2)),
    totalAmount: roundMoney(row.totalAmount),
    salesGrossProfit: roundMoney(row.salesGrossProfit),
    productGrossProfit: row.productGrossProfitPendingCount ? null : roundMoney(row.productGrossProfit),
    financialGrossProfit: row.financialGrossProfitPendingCount ? null : roundMoney(row.financialGrossProfit)
  })).sort((a, b) => b.totalAmount - a.totalAmount || a.categoryPath.localeCompare(b.categoryPath, 'zh-CN'));
}

async function queryProductSalesStats(where) {
  const items = await OrderItem.findAll({
    include: [{
      model: Order,
      where,
      required: true,
      attributes: ['order_id', 'total_amount', 'discount_amount']
    }, {
      model: Product,
      as: 'Product',
      required: false,
      attributes: ['product_id', 'category_id', 'category', 'brand', 'series', 'model']
    }]
  });
  if (!items.length) return [];

  const itemIds = items.map(item => item.item_id).filter(Boolean);
  const productIds = [...new Set(items.map(item => item.product_id).filter(Boolean).map(String))];
  const [legacyMaps, settlementItems, prices, categories] = await Promise.all([
    loadLegacyCostMaps(items),
    ProductSettlementItem.findAll({ where: { source_order_item_id: { [Op.in]: itemIds } }, raw: true }),
    productIds.length ? ProductPrice.findAll({ where: { product_id: { [Op.in]: productIds } }, raw: true }) : [],
    ProductCategory.findAll({ attributes: ['category_id', 'parent_id', 'name'], raw: true })
  ]);
  const settlementMap = new Map(settlementItems.map(item => [String(item.source_order_item_id), item]));
  const priceMap = new Map(prices.map(price => [String(price.product_id), price]));
  const categoryMap = new Map(categories.map(category => [String(category.category_id), category]));
  const education = await require('../inventory/educationReward').educationIncome({ orderIds: [...new Set(items.map(item => String(item.order_id)))] });
  const educationByItem = new Map();
  for (const entry of education) {
    const current = educationByItem.get(String(entry.itemId)) || { amount: 0, employeeAmount: 0, productAmount: 0 };
    for (const key of ['amount', 'employeeAmount', 'productAmount']) current[key] = roundMoney(current[key] + entry[key]);
    educationByItem.set(String(entry.itemId), current);
  }
  const orderSubtotalMap = new Map();
  items.forEach(item => {
    const orderId = String(item.order_id || '');
    orderSubtotalMap.set(orderId, toNumber(orderSubtotalMap.get(orderId)) + Math.max(0, toNumber(item.subtotal)));
  });

  const rows = items.map(item => {
    const product = item.Product || {};
    const order = item.Order || {};
    const price = priceMap.get(String(item.product_id || '')) || {};
    const settlement = settlementMap.get(String(item.item_id || ''));
    const quantity = Math.max(0, toNumber(item.quantity));
    const salesAmount = roundMoney(item.subtotal);
    const baseProfit = calculateItemBaseProfit(item, legacyMaps);
    const orderSubtotal = orderSubtotalMap.get(String(item.order_id || '')) || 0;
    const orderRevenue = Math.max(0, toNumber(order.total_amount) - toNumber(order.discount_amount));
    const allocatedGrossRevenue = orderSubtotal > 0 ? roundMoney(orderRevenue * salesAmount / orderSubtotal) : salesAmount;
    const netRevenue = roundMoney(allocatedGrossRevenue / (1 + taxRate(price.output_tax_rate)));
    const unitCost = toNumber(settlement?.purchase_unit_cost) || toNumber(item.original_inventory_cost) || toNumber(price.cost_price);
    const deductible = Number(price.input_tax_deductible ?? 1) === 1;
    const grossCost = roundMoney(unitCost * quantity);
    const bookCost = deductible ? roundMoney(grossCost / (1 + taxRate(price.input_tax_rate))) : grossCost;
    const educationIncome = educationByItem.get(String(item.item_id)) || { amount: 0, employeeAmount: 0, productAmount: 0 };
    return {
      category: product.category || '未分类',
      categoryPath: buildCategoryPath(product.category_id, categoryMap, product.category),
      brand: product.brand,
      series: product.series,
      model: product.model,
      quantity,
      salesAmount,
      salesGrossProfit: roundMoney(baseProfit.grossProfit + educationIncome.employeeAmount),
      productGrossProfit: settlement && settlement.cost_status === 'ready' ? roundMoney(Number(settlement.gross_profit_amount) + educationIncome.productAmount) : null,
      financialGrossProfit: quantity > 0 && unitCost <= 0 ? null : roundMoney(netRevenue - bookCost + educationIncome.amount)
    };
  });
  return aggregateProductSalesMetrics(rows);
}

function buildEmployeeParticipationCondition(staffId) {
  const normalizedStaffId = String(staffId || '');
  const numericStaffId = Number(normalizedStaffId);
  const staffIdValue = Number.isFinite(numericStaffId) ? numericStaffId : normalizedStaffId;
  return {
    [Op.or]: [
      { create_staff_id: normalizedStaffId },
      sequelize.where(sequelize.fn('JSON_SEARCH', sequelize.col('auxiliary_sales_list'), 'one', normalizedStaffId, null, '$[*].staffId'), { [Op.ne]: null }),
      sequelize.where(sequelize.fn('JSON_SEARCH', sequelize.col('auxiliary_sales_list'), 'one', normalizedStaffId, null, '$[*].staff_id'), { [Op.ne]: null }),
      sequelize.where(sequelize.fn('JSON_CONTAINS', sequelize.col('auxiliary_sales_list'), JSON.stringify({ staffId: staffIdValue })), 1),
      sequelize.where(sequelize.fn('JSON_CONTAINS', sequelize.col('auxiliary_sales_list'), JSON.stringify({ staff_id: staffIdValue })), 1)
    ]
  };
}

async function getEmployeeReportStoreIds(user, requestedStoreId) {
  return getReportStoreIds(user, requestedStoreId);
}

async function getReportStoreIds(user, requestedStoreId) {
  const readableStoreIds = await resolveReportStoreIds(user);
  const where = { is_deleted: 0, status: 1 };
  if (!readableStoreIds.includes('*')) {
    where.store_id = readableStoreIds.length ? { [Op.in]: readableStoreIds } : '__NO_STORE__';
  }
  if (requestedStoreId) {
    if (!readableStoreIds.includes('*') && !readableStoreIds.map(String).includes(String(requestedStoreId))) return [];
    where.store_id = requestedStoreId;
  }
  const stores = await Store.findAll({ where, attributes: ['store_id'], raw: true });
  return stores.map(store => store.store_id);
}

/**
 * 销售报表
 */
async function getSalesReport(ctx) {
  const { storeId, regionId, regionCode, startDate, endDate, archiveScope = 'archived' } = ctx.query;
  const user = ctx.state.user;
  const selfOnly = isSelfOnlyReportUser(user);

  const whereStore = {};
  const reportStoreIds = await resolveReportStoreIds(user);
  if (!reportStoreIds.includes('*')) whereStore.store_id = reportStoreIds;
  if (storeId && !reportStoreIds.includes('*') && !reportStoreIds.map(String).includes(String(storeId))) {
    ctx.throw(403, '无权访问该门店销售报表');
  }
  if (storeId) whereStore.store_id = storeId;
  if (regionId) whereStore.region_id = regionId;
  else if (regionCode) {
    const region = await Region.findOne({ where: { region_code: regionCode, status: 1 }, attributes: ['region_id'], raw: true });
    whereStore.region_id = region?.region_id || '__NO_REGION__';
  }

  const stores = await Store.findAll({ where: whereStore });
  const storeIds = stores.map(s => s.store_id);

  const where = {
    is_deleted: 0,
    store_id: storeIds
  };
  appendOperatingSourceCondition(where);
  if (archiveScope === 'all') {
    where[Op.or] = [
      { order_status: null },
      { order_status: { [Op.notIn]: ['已作废', 'voided', 'cancelled', 'canceled'] } }
    ];
  } else {
    where.order_status = { [Op.in]: POSITIVE_SALES_ORDER_STATUSES };
  }
  if (selfOnly) {
    const participation = buildEmployeeParticipationCondition(user.staffId);
    if (where[Op.or]) {
      const statusScope = { [Op.or]: where[Op.or] };
      delete where[Op.or];
      where[Op.and] = [statusScope, participation];
    } else {
      where[Op.and] = [participation];
    }
  }

  if (startDate && endDate) {
    where.create_time = {
      [Op.gte]: new Date(startDate),
      [Op.lte]: new Date(endDate + ' 23:59:59')
    };
  }

  // 按门店统计
  const statsByStore = await Order.findAll({
    where,
    attributes: [
      'store_id',
      [sequelize.fn('COUNT', sequelize.col('order_id')), 'orderCount'],
      [sequelize.fn('SUM', sequelize.col('total_amount')), 'totalAmount'],
      [sequelize.fn('SUM', sequelize.col('actual_payment')), 'actualPayment'],
      [sequelize.fn('SUM', sequelize.col('national_subsidy')), 'nationalSubsidy'],
      [sequelize.fn('SUM', sequelize.col('education_subsidy')), 'educationSubsidy']
    ],
    include: [{ model: Store, attributes: ['name'] }],
    group: ['store_id'],
    raw: true
  });

  const returnSettlementWhere = {
    store_id: storeIds,
    [Op.and]: [sequelize.literal(`NOT EXISTS (
      SELECT 1 FROM T_ORDER operating_order
       WHERE operating_order.ORDER_ID = SalesReturnSettlement.ORDER_ID
         AND COALESCE(TRIM(operating_order.CUSTOMER_SOURCE), '') LIKE '${INTERNAL_TRANSFER_SOURCE}%'
    )`)]
  };
  if (startDate && endDate) {
    returnSettlementWhere.create_time = {
      [Op.gte]: new Date(startDate),
      [Op.lte]: new Date(endDate + ' 23:59:59')
    };
  }
  const returnSettlementByStore = await SalesReturnSettlement.findAll({
    where: returnSettlementWhere,
    attributes: [
      'store_id',
      [sequelize.fn('SUM', sequelize.col('user_receivable_amount')), 'userReceivableAmount'],
      [sequelize.fn('SUM', sequelize.col('customer_received_amount')), 'customerReceivedAmount'],
      [sequelize.fn('SUM', sequelize.col('policy_subsidy_receivable_amount')), 'policySubsidyReceivableAmount'],
      [sequelize.fn('SUM', sequelize.col('education_subsidy_amount')), 'educationSubsidyAmount']
    ],
    group: ['store_id'],
    raw: true
  });
  const returnSettlementMap = new Map(returnSettlementByStore.map(row => [String(row.store_id), row]));
  const adjustedStatsByStore = statsByStore.map(row => {
    const adjustment = returnSettlementMap.get(String(row.store_id)) || {};
    return {
      ...row,
      negativeSettlementUserReceivable: Number(adjustment.userReceivableAmount || 0),
      negativeSettlementCustomerReceived: Number(adjustment.customerReceivedAmount || 0),
      negativeSettlementPolicySubsidy: Number(adjustment.policySubsidyReceivableAmount || 0),
      negativeSettlementEducationSubsidy: Number(adjustment.educationSubsidyAmount || 0),
      totalAmount: Number(row.totalAmount || 0) + Number(adjustment.userReceivableAmount || 0),
      actualPayment: Number(row.actualPayment || 0) + Number(adjustment.customerReceivedAmount || 0),
      nationalSubsidy: Number(row.nationalSubsidy || 0) + Number(adjustment.policySubsidyReceivableAmount || 0),
      educationSubsidy: Number(row.educationSubsidy || 0) + Number(adjustment.educationSubsidyAmount || 0)
    };
  });

  const statsByCategory = await queryProductSalesStats(where);
  const profitVisible = canViewProfit(user);
  const visibleStatsByCategory = profitVisible ? statsByCategory : statsByCategory.map(row => ({
    ...row,
    salesGrossProfit: null,
    productGrossProfit: null,
    financialGrossProfit: null
  }));

  // 按日期统计
  const statsByDate = await Order.findAll({
    where,
    attributes: [
      [sequelize.fn('DATE', sequelize.col('create_time')), 'date'],
      [sequelize.fn('COUNT', sequelize.col('order_id')), 'orderCount'],
      [sequelize.fn('SUM', sequelize.col('total_amount')), 'totalAmount']
    ],
    group: [sequelize.fn('DATE', sequelize.col('create_time'))],
    order: [[sequelize.fn('DATE', sequelize.col('create_time')), 'DESC']],
    raw: true
  });
  const returnSettlementByDate = await SalesReturnSettlement.findAll({
    where: returnSettlementWhere,
    attributes: [
      [sequelize.fn('DATE', sequelize.col('create_time')), 'date'],
      [sequelize.fn('SUM', sequelize.col('user_receivable_amount')), 'userReceivableAmount'],
      [sequelize.fn('SUM', sequelize.col('customer_received_amount')), 'customerReceivedAmount']
    ],
    group: [sequelize.fn('DATE', sequelize.col('create_time'))],
    raw: true
  });
  const returnSettlementDateMap = new Map(returnSettlementByDate.map(row => [String(row.date), row]));
  const adjustedStatsByDate = statsByDate.map(row => {
    const adjustment = returnSettlementDateMap.get(String(row.date)) || {};
    return {
      ...row,
      negativeSettlementUserReceivable: Number(adjustment.userReceivableAmount || 0),
      negativeSettlementCustomerReceived: Number(adjustment.customerReceivedAmount || 0),
      totalAmount: Number(row.totalAmount || 0) + Number(adjustment.userReceivableAmount || 0),
      actualPayment: Number(row.actualPayment || 0) + Number(adjustment.customerReceivedAmount || 0)
    };
  });

  // 汇总
  const summary = await Order.findAll({
    where,
    attributes: [
      [sequelize.fn('COUNT', sequelize.col('order_id')), 'totalOrders'],
      [sequelize.fn('SUM', sequelize.col('total_amount')), 'totalSales'],
      [sequelize.fn('SUM', sequelize.col('actual_payment')), 'totalPayment']
    ],
    raw: true
  });

  const returnSettlementSummary = returnSettlementByStore.reduce((result, row) => {
    result.userReceivableAmount += Number(row.userReceivableAmount || 0);
    result.customerReceivedAmount += Number(row.customerReceivedAmount || 0);
    result.policySubsidyReceivableAmount += Number(row.policySubsidyReceivableAmount || 0);
    result.educationSubsidyAmount += Number(row.educationSubsidyAmount || 0);
    return result;
  }, {
    userReceivableAmount: 0,
    customerReceivedAmount: 0,
    policySubsidyReceivableAmount: 0,
    educationSubsidyAmount: 0
  });
  const baseSummary = summary[0] || {};
  ctx.body = {
    summary: {
      ...baseSummary,
      totalSales: Number(baseSummary.totalSales || 0) + returnSettlementSummary.userReceivableAmount,
      totalPayment: Number(baseSummary.totalPayment || 0) + returnSettlementSummary.customerReceivedAmount,
      totalNationalSubsidy: Number(baseSummary.totalNationalSubsidy || baseSummary.nationalSubsidy || 0) + returnSettlementSummary.policySubsidyReceivableAmount,
      totalEducationSubsidy: Number(baseSummary.totalEducationSubsidy || baseSummary.educationSubsidy || 0) + returnSettlementSummary.educationSubsidyAmount
    },
    negativeSettlementSummary: returnSettlementSummary,
    statsByStore: adjustedStatsByStore,
    statsByCategory: visibleStatsByCategory,
    canViewProfit: profitVisible,
    statsByDate: adjustedStatsByDate
  };
}

/**
 * 库存报表
 */
function buildInventoryReportMetrics(categoryStats = []) {
  const rows = categoryStats.map(row => {
    const totalCount = Number(row.totalCount || 0);
    const staleCount = Number(row.staleCount || 0);
    return {
      ...row,
      totalCount,
      totalCost: roundMoney(row.totalCost),
      staleCount,
      staleRate: totalCount > 0 ? Number((staleCount / totalCount * 100).toFixed(2)) : 0
    };
  });
  const summary = rows.reduce((result, row) => ({
    totalCount: result.totalCount + row.totalCount,
    totalCost: roundMoney(result.totalCost + row.totalCost),
    staleCount: result.staleCount + row.staleCount,
    staleRate: 0
  }), { totalCount: 0, totalCost: 0, staleCount: 0, staleRate: 0 });
  summary.staleRate = summary.totalCount > 0
    ? Number((summary.staleCount / summary.totalCount * 100).toFixed(2))
    : 0;
  return { rows, summary };
}

async function getCustomerSourceAnalysis(ctx) {
  const { startDate, endDate, dimension = 'company' } = ctx.query;
  const user = ctx.state.user;
  const groupBy = ['company', 'store', 'employee'].includes(dimension) ? dimension : 'company';
  const storeIds = await resolveReportStoreIds(user);
  const where = {
    is_deleted: 0,
    store_id: storeIds.includes('*') ? { [Op.ne]: null } : { [Op.in]: storeIds },
    order_status: { [Op.in]: POSITIVE_SALES_ORDER_STATUSES }
  };
  appendOperatingSourceCondition(where);
  if (startDate && endDate) {
    where.create_time = { [Op.gte]: new Date(startDate), [Op.lte]: new Date(`${endDate} 23:59:59`) };
  }
  if (isSelfOnlyReportUser(user)) {
    const participation = buildEmployeeParticipationCondition(user.staffId);
    where[Op.and] = [...(where[Op.and] || []), participation];
  }

  const [orders, categories] = await Promise.all([
    Order.findAll({
      where,
      attributes: [
        'order_id', 'store_id', 'create_staff_id', 'create_user', 'operator_staff_id', 'operator_name',
        'customer_source', 'customer_source_detail', 'total_amount', 'create_time'
      ],
      include: [
        { model: Store, attributes: ['store_id', 'name', 'distributor_id'], include: [{ model: Distributor, attributes: ['distributor_id', 'name'], required: false }] },
        { model: Staff, as: 'Applicant', attributes: ['staff_id', 'name'], required: false },
        { model: OrderGrossProfit, as: 'grossProfitSnapshot', attributes: ['gross_profit_amount'], required: false },
        { model: OrderItem, include: [{ model: Product, as: 'Product', attributes: ['category_id', 'category'], required: false }] }
      ],
      order: [['create_time', 'DESC']]
    }),
    ProductCategory.findAll({ attributes: ['category_id', 'parent_id', 'name'], raw: true })
  ]);

  if (!orders.length) {
    ctx.body = { dimension: groupBy, canViewProfit: canViewProfit(user), summary: { orderCount: 0, salesAmount: 0, grossProfit: 0, afterSalesOrderCount: 0 }, rows: [] };
    return;
  }

  const orderIds = orders.map(order => order.order_id);
  const orderIdSet = new Set(orderIds.map(String));
  const returnRows = await SalesReturnRequest.findAll({
    where: { order_id: { [Op.in]: orderIds }, status: { [Op.notIn]: ['cancelled', 'canceled', 'voided', 'rejected'] } },
    attributes: ['order_id'],
    raw: true
  });
  const afterSalesOrderIds = new Set(returnRows.map(row => String(row.order_id)));
  const categoryMap = new Map(categories.map(row => [String(row.category_id), row]));
  const groups = new Map();
  const getRootCategory = product => {
    let current = categoryMap.get(String(product?.category_id || ''));
    let root = current;
    const seen = new Set();
    while (current?.parent_id && !seen.has(String(current.category_id))) {
      seen.add(String(current.category_id));
      const parent = categoryMap.get(String(current.parent_id));
      if (!parent) break;
      root = parent;
      current = parent;
    }
    return String(root?.name || product?.category || '其他').trim() || '其他';
  };
  const categoryLabel = name => {
    const normalized = String(name || '').replace(/\s+/g, '').toLowerCase();
    if (/电脑|笔记本|thinkpad|thinkbook|yoga|小新/.test(normalized)) return '电脑销售';
    if (/台机|台式|主机/.test(normalized)) return '台机销售';
    if (/手机|iphone|motorola|moto/.test(normalized)) return '手机销售';
    if (/平板|tablet|ipad/.test(normalized)) return '平板销售';
    if (/配件/.test(normalized)) return '配件销售';
    if (/选件/.test(normalized)) return '选件销售';
    if (/二手/.test(normalized)) return '二手销售';
    return `${name}销售`;
  };

  orders.forEach(order => {
    const store = order.Store || {};
    const distributor = store.Distributor || {};
    const employeeId = order.operator_staff_id || order.create_staff_id || '';
    const employeeName = order.operator_name || order.create_user || order.Applicant?.name || '未指定员工';
    let dimensionId, dimensionName;
    if (groupBy === 'store') {
      dimensionId = store.store_id || order.store_id;
      dimensionName = store.name || '未命名门店';
    } else if (groupBy === 'employee') {
      dimensionId = employeeId || employeeName;
      dimensionName = employeeName;
    } else {
      dimensionId = distributor.distributor_id || store.distributor_id || 'unknown-company';
      dimensionName = distributor.name || '未配置公司';
    }
    const sourceName = String(order.customer_source || '').trim() || '未填写来源';
    const sourceDetail = String(order.customer_source_detail || '').trim() || '-';
    const key = JSON.stringify([dimensionId, sourceName, sourceDetail]);
    const group = groups.get(key) || {
      dimensionId: String(dimensionId || ''), dimensionName, customerSource: sourceName, sourceDetail,
      orderCount: 0, salesAmount: 0, grossProfit: 0, afterSalesOrderCount: 0, categories: new Map()
    };
    group.orderCount += 1;
    group.salesAmount += toNumber(order.total_amount);
    group.grossProfit += toNumber(order.grossProfitSnapshot?.gross_profit_amount);
    if (afterSalesOrderIds.has(String(order.order_id))) group.afterSalesOrderCount += 1;
    const orderCategories = new Set((order.OrderItems || []).map(item => categoryLabel(getRootCategory(item.Product))));
    orderCategories.forEach(name => group.categories.set(name, (group.categories.get(name) || 0) + 1));
    groups.set(key, group);
  });

  const rows = [...groups.values()].map(group => ({
    ...group,
    salesAmount: roundMoney(group.salesAmount),
    grossProfit: canViewProfit(user) ? roundMoney(group.grossProfit) : null,
    categories: [...group.categories.entries()].map(([name, orderCount]) => ({ name, orderCount })).sort((a, b) => b.orderCount - a.orderCount || a.name.localeCompare(b.name, 'zh-CN'))
  })).sort((a, b) => b.salesAmount - a.salesAmount || a.dimensionName.localeCompare(b.dimensionName, 'zh-CN'));
  ctx.body = {
    dimension: groupBy,
    canViewProfit: canViewProfit(user),
    summary: {
      orderCount: orders.length,
      salesAmount: roundMoney(orders.reduce((sum, order) => sum + toNumber(order.total_amount), 0)),
      grossProfit: canViewProfit(user) ? roundMoney(orders.reduce((sum, order) => sum + toNumber(order.grossProfitSnapshot?.gross_profit_amount), 0)) : null,
      afterSalesOrderCount: [...afterSalesOrderIds].filter(id => orderIdSet.has(id)).length
    },
    rows
  };
}

function buildInventoryCategoryOrderMap(categories = []) {
  const childrenByParent = new Map();
  const rows = categories
    .filter(row => Number(row.status ?? 1) === 1)
    .map(row => ({ ...row, category_id: String(row.category_id || ''), parent_id: String(row.parent_id || '') }))
    .filter(row => row.category_id);
  rows.forEach(row => {
    if (!childrenByParent.has(row.parent_id)) childrenByParent.set(row.parent_id, []);
    childrenByParent.get(row.parent_id).push(row);
  });
  childrenByParent.forEach(children => children.sort((a, b) =>
    Number(a.sort_order || 0) - Number(b.sort_order || 0)
    || String(a.category_id).localeCompare(String(b.category_id))
  ));
  const orderMap = new Map();
  const visited = new Set();
  let order = 0;
  const visit = (parentId, parentPath = []) => {
    for (const row of childrenByParent.get(String(parentId || '')) || []) {
      if (visited.has(row.category_id)) continue;
      visited.add(row.category_id);
      const path = [...parentPath, String(row.name || '').trim()].filter(Boolean);
      orderMap.set(path.join('/'), order++);
      visit(row.category_id, path);
    }
  };
  visit('');
  rows.filter(row => !visited.has(row.category_id))
    .sort((a, b) => Number(a.level || 0) - Number(b.level || 0)
      || Number(a.sort_order || 0) - Number(b.sort_order || 0)
      || String(a.category_id).localeCompare(String(b.category_id)))
    .forEach(row => visit(row.parent_id));
  return orderMap;
}

function sortInventoryCategoryStats(rows = [], categories = []) {
  const orderMap = buildInventoryCategoryOrderMap(categories);
  const rank = row => {
    const parts = [row.category, row.brand, row.series, row.model]
      .map(value => String(value || '').trim())
      .filter(Boolean);
    for (let length = parts.length; length > 0; length -= 1) {
      const path = parts.slice(0, length).join('/');
      if (orderMap.has(path)) return orderMap.get(path);
    }
    return Number.MAX_SAFE_INTEGER;
  };
  return [...rows].sort((a, b) => rank(a) - rank(b)
    || String(a.category || '').localeCompare(String(b.category || ''), 'zh-Hans-CN')
    || String(a.brand || '').localeCompare(String(b.brand || ''), 'zh-Hans-CN')
    || String(a.series || '').localeCompare(String(b.series || ''), 'zh-Hans-CN')
    || String(a.model || '').localeCompare(String(b.model || ''), 'zh-Hans-CN'));
}

async function getInventoryReport(ctx) {
  const { storeId, regionId, category } = ctx.query;
  const user = ctx.state.user;

  const whereStore = {};
  const reportStoreIds = await resolveReportStoreIds(user);
  if (!reportStoreIds.includes('*')) whereStore.store_id = reportStoreIds;
  if (storeId && !reportStoreIds.includes('*') && !reportStoreIds.map(String).includes(String(storeId))) {
    ctx.throw(403, '无权访问该门店库存报表');
  }
  if (storeId) whereStore.store_id = storeId;
  if (regionId) whereStore.region_id = regionId;

  const stores = await Store.findAll({ where: whereStore });
  const storeIds = stores.map(s => s.store_id);

  const whereSn = { is_deleted: 0, status: 'in_stock', store_id: { [Op.in]: storeIds } };
  if (storeId) whereSn.store_id = storeId;
  const productWhere = { is_deleted: 0 };
  if (category) productWhere.category = category;
  const inventoryUnitCostSql = `COALESCE(
    NULLIF(\`ProductSn\`.\`inbound_price\`, 0),
    NULLIF(\`ProductSn\`.\`original_pickup_price\`, 0),
    (SELECT NULLIF(pp.COST_PRICE, 0)
       FROM T_PRODUCT_PRICE pp
      WHERE pp.PRODUCT_ID = \`ProductSn\`.\`product_id\` AND pp.STATUS = 1
      ORDER BY pp.EFFECTIVE_TIME DESC, pp.PRICE_ID DESC
      LIMIT 1),
    0
  )`;
  const staleCountSql = `SUM(CASE
    WHEN COALESCE(\`ProductSn\`.\`original_inbound_time\`, \`ProductSn\`.\`inbound_time\`) IS NOT NULL
     AND TIMESTAMPDIFF(DAY, COALESCE(\`ProductSn\`.\`original_inbound_time\`, \`ProductSn\`.\`inbound_time\`), NOW()) > 30
    THEN 1 ELSE 0 END)`;

  // 在库统计
  const inStockStats = await ProductSn.findAll({
    where: whereSn,
    attributes: [
      'product_id',
      [sequelize.fn('COUNT', sequelize.col('sn_id')), 'inStockCount'],
      [sequelize.literal(`ROUND(SUM(${inventoryUnitCostSql}), 2)`), 'totalCost'],
      [sequelize.literal(staleCountSql), 'staleCount']
    ],
    include: [{
      model: Product,
      attributes: ['name', 'category', 'brand', 'series', 'model'],
      where: productWhere,
      required: true
    }],
    group: ['product_id'],
    raw: true
  });

  // 按类别汇总
  const categoryStats = await ProductSn.findAll({
    where: whereSn,
    attributes: [
      [sequelize.col('Product.category'), 'category'],
      [sequelize.col('Product.brand'), 'brand'],
      [sequelize.col('Product.series'), 'series'],
      [sequelize.col('Product.model'), 'model'],
      [sequelize.fn('COUNT', sequelize.col('sn_id')), 'totalCount'],
      [sequelize.fn('JSON_ARRAYAGG', sequelize.col('ProductSn.store_id')), 'storeIds'],
      [sequelize.literal(`ROUND(SUM(${inventoryUnitCostSql}), 2)`), 'totalCost'],
      [sequelize.literal(staleCountSql), 'staleCount']
    ],
    include: [{
      model: Product,
      attributes: [],
      where: productWhere,
      required: true
    }],
    group: [
      sequelize.col('Product.category'),
      sequelize.col('Product.brand'),
      sequelize.col('Product.series'),
      sequelize.col('Product.model')
    ],
    raw: true
  });

  const storeNames = new Map(stores.map(store => [String(store.store_id), store.name || String(store.store_id)]));
  for (const row of categoryStats) {
    const ids = Array.isArray(row.storeIds) ? row.storeIds : JSON.parse(row.storeIds || '[]');
    row.storeNames = [...new Set(ids.map(id => storeNames.get(String(id))).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right, 'zh-CN')).join('、');
    delete row.storeIds;
  }

  const categoryRows = await ProductCategory.findAll({
    where: { status: 1 },
    attributes: ['category_id', 'parent_id', 'name', 'level', 'sort_order', 'status'],
    raw: true
  });
  const { rows: normalizedCategoryStats, summary } = buildInventoryReportMetrics(categoryStats);
  const sortedCategoryStats = sortInventoryCategoryStats(normalizedCategoryStats, categoryRows);

  ctx.body = { inStockStats, categoryStats: sortedCategoryStats, summary };
}

async function getEmployeePerformanceReport(ctx, exportMode = false) {
  const { storeId, staffName, orderNo, startDate, endDate, page = 1, pageSize = 20 } = ctx.query;
  const user = ctx.state.user;

  const storeIds = await getEmployeeReportStoreIds(user, storeId);
  if (storeIds.length === 0) {
    if (exportMode) {
      sendExcel(ctx, [], EMPLOYEE_PROFIT_EXPORT_HEADERS, `个人毛利明细_${startDate || '全部'}_${endDate || '全部'}.xlsx`, '销售商品毛利', { textHeaders: ['订单号', 'PN', 'SN'] });
      return;
    }
    ctx.body = { list: [], summary: {}, employees: [], pagination: { total: 0, page, pageSize, totalPages: 0 } };
    return;
  }

  const where = {
    is_deleted: 0,
    store_id: { [Op.in]: storeIds },
    order_status: { [Op.in]: POSITIVE_SALES_ORDER_STATUSES }
  };
  appendOperatingSourceCondition(where);
  if (staffName) where.create_user = staffName;
  if (orderNo) where.order_no = { [Op.like]: `%${String(orderNo).trim()}%` };
  if (startDate && endDate) {
    where.create_time = {
      [Op.gte]: new Date(`${startDate}T00:00:00+08:00`),
      [Op.lte]: new Date(`${endDate}T23:59:59.999+08:00`)
    };
  }

  const employees = await Order.findAll({
    where: {
      is_deleted: 0,
      store_id: { [Op.in]: storeIds },
      create_user: { [Op.ne]: null },
      [Op.and]: [{
        [Op.or]: [
          { customer_source: null },
          { customer_source: { [Op.notLike]: `${INTERNAL_TRANSFER_SOURCE}%` } }
        ]
      }]
    },
    attributes: [[sequelize.fn('DISTINCT', sequelize.col('create_user')), 'name']],
    raw: true
  });

  const returnOrderWhere = { ...where };
  delete returnOrderWhere.create_time;
  delete returnOrderWhere.order_status;
  delete returnOrderWhere.order_no;
  const returnWhere = {};
  if (where.create_time) returnWhere.create_time = where.create_time;
  if (orderNo) returnWhere[Op.or] = [
    { return_no: { [Op.like]: '%' + String(orderNo).trim() + '%' } },
    { order_no: { [Op.like]: '%' + String(orderNo).trim() + '%' } }
  ];
  const returnRows = await SalesReturnGrossProfitLedger.findAll({
    where: returnWhere,
    include: [{ model: Order, as: 'order', where: returnOrderWhere, required: true,
      include: [{ model: Store, attributes: ['name'] }] }]
  });
  const reversals = returnEvents(returnRows.map(row => row.toJSON()));
  const reversalAdjustmentCondition = { [Op.or]: [
    { adjustment_no: { [Op.like]: 'AUTO-CARE-RET-%' } },
    { adjustment_no: { [Op.like]: 'EDUR-%' } }
  ] };
  const originalAdjustmentCondition = { [Op.and]: [
    { adjustment_no: { [Op.notLike]: 'AUTO-CARE-RET-%' } },
    { adjustment_no: { [Op.notLike]: 'EDUR-%' } }
  ] };
  const reversalAdjustments = await PerformanceProfitAdjustment.findAll({
    where: { status: 'approved', ...reversalAdjustmentCondition,
      ...(where.create_time ? { create_time: where.create_time } : {}) },
    include: [{ model: Order, where: returnOrderWhere, required: true, include: [{ model: Store }] }]
  });
  for (const model of reversalAdjustments) {
    const row = model.toJSON();
    if (orderNo && !String(row.reason || '').includes(String(orderNo).trim()) &&
        !String(row.order_no || '').includes(String(orderNo).trim())) continue;
    const order = row.Order || {};
    const participants = normalizeParticipants(order);
    const shares = allocateProfit(participants.map(p => ({ ...p, profitAmount: '', ratio: '' })), row.signed_amount);
    reversals.push({ orderId: 'return-adjustment:' + row.adjustment_id, entryType: 'return',
      isReturnAdjustment: true, orderNo: row.adjustment_no, sourceOrderNo: row.order_no,
      sourceOrderId: row.order_id, orderTime: row.create_time, storeName: order.Store?.name || '',
      employeeName: row.employee_name, totalAmount: 0, actualPayment: 0, totalCost: 0,
      baseGrossProfit: 0, grossProfit: roundMoney(row.signed_amount),
      approvedAdjustment: roundMoney(row.signed_amount),
      careCreditAdjustment: row.adjustment_no.startsWith('AUTO-CARE-') ? roundMoney(row.signed_amount) : 0,
      otherApprovedAdjustment: row.adjustment_no.startsWith('AUTO-CARE-') ? 0 : roundMoney(row.signed_amount),
      participantAllocations: participants.map((p, index) => ({ staffId: p.staffId, employeeName: p.name,
        role: p.role, baseGrossProfit: 0, approvedAdjustment: shares[index], grossProfit: shares[index] })),
      grossProfitSource: 'return_adjustment',
      calculation: { orderFormula: row.reason, revenueNote: row.reason, items: [] } });
  }

  const positiveKeys = await Order.findAll({ where, attributes: ['order_id', 'create_time'], raw: true });
  const eventKeys = [
    ...positiveKeys.map(row => ({ id: row.order_id, time: row.create_time, type: 'sale' })),
    ...reversals.map(row => ({ id: row.orderId, time: row.orderTime, type: 'return' }))
  ].sort((a, b) => new Date(b.time) - new Date(a.time) || String(a.id).localeCompare(String(b.id)));
  const count = eventKeys.length;
  const selectedKeys = exportMode ? eventKeys : eventKeys.slice(
    (Math.max(Number(page) || 1, 1) - 1) * Math.max(Number(pageSize) || 20, 1),
    Math.max(Number(page) || 1, 1) * Math.max(Number(pageSize) || 20, 1));
  const selectedIds = selectedKeys.filter(row => row.type === 'sale').map(row => row.id);
  const orders = await Order.findAll({

    where: { ...where, order_id: { [Op.in]: selectedIds } },
    include: [
      { model: Store, attributes: ['store_id', 'name'] },
      { model: OrderItem },
      {
        model: OrderGrossProfit,
        as: 'grossProfitSnapshot',
        required: false
      }
    ],
    order: [['create_time', 'DESC']],
    distinct: true
  });

  const pageOrderIds = orders.map(order => order.order_id);
  const approvedPageAdjustments = pageOrderIds.length
    ? await PerformanceProfitAdjustment.findAll({
        where: { order_id: { [Op.in]: pageOrderIds }, status: 'approved', ...originalAdjustmentCondition },
        attributes: ['order_id', 'adjustment_no', 'signed_amount'], raw: true
      }) : [];
  const adjustmentMap = new Map();
  const careCreditAdjustmentMap = new Map();
  const directAdjustmentMap = new Map();
  approvedPageAdjustments.forEach(row => {
    adjustmentMap.set(
      row.order_id,
      roundMoney((adjustmentMap.get(row.order_id) || 0) + toNumber(row.signed_amount))
    );
    if (String(row.adjustment_no || '').startsWith('AUTO-CARE-')) {
      careCreditAdjustmentMap.set(row.order_id,
        roundMoney((careCreditAdjustmentMap.get(row.order_id) || 0) + toNumber(row.signed_amount)));
    }
  });
  const pageItems = orders.flatMap(order => order.OrderItems || []);

  const careCostMap = new Map(await Promise.all(orders
    .filter(order => careCreditAdjustmentMap.has(order.order_id) && order.grossProfitSnapshot)
    .map(async order => {
      const lines = await careCostDetails(order.grossProfitSnapshot);
      return [order.order_id, roundMoney(lines.reduce((sum, line) => sum + toNumber(line.pricingAmount), 0))];
    })));

  const saleList = orders.map(order => {
    const orderJson = order.toJSON();
    const items = orderJson.OrderItems || [];
    const totalAmount = roundMoney(orderJson.total_amount);
    const actualPayment = roundMoney(orderJson.actual_payment);
    const grossProfitSnapshot = orderJson.grossProfitSnapshot;
    const snapshotDetail = grossProfitSnapshot
      ? snapshotToResponse(grossProfitSnapshot, orderJson)
      : null;
    const pricingDetails = parseJsonArray(grossProfitSnapshot?.product_pricing_details);
    const pricingDetailByItem = new Map(
      pricingDetails.map(detail => [String(detail.itemId || ''), detail])
    );
    let totalCost = 0;
    let baseGrossProfit = 0;
    const itemCalculations = items.map(item => {
      const quantity = Number(item.quantity || 1);
      const saleSubtotal = roundMoney(toNumber(item.subtotal) || (toNumber(item.sale_price) * quantity));
      const allocatedRevenue = saleSubtotal;
      const baseCalculation = savedItemProfit(item);
      const pricingDetail = pricingDetailByItem.get(String(item.item_id || ''));
      const unitCost = grossProfitSnapshot && pricingDetail
        ? roundMoney(pricingDetail.unitPricing)
        : baseCalculation.unitCost;
      const costAmount = grossProfitSnapshot && pricingDetail
        ? roundMoney(pricingDetail.pricingAmount)
        : baseCalculation.costAmount;
      const grossProfit = grossProfitSnapshot
        ? roundMoney(toNumber(grossProfitSnapshot.gross_profit_amount) * (
            totalAmount ? saleSubtotal / totalAmount : 0
          ))
        : baseCalculation.grossProfit;
      totalCost += costAmount;
      baseGrossProfit += grossProfit;
      return {
        productName: item.product_name,
        pnCode: item.pn_code || '',
        snCode: item.sn_code || '',
        quantity,
        salePrice: roundMoney(item.sale_price),
        saleSubtotal,
        allocatedReduction: 0,
        allocatedRevenue,
        unitCost,
        costAmount,
        grossProfit,
        source: grossProfitSnapshot ? 'order_gross_profit_snapshot' : baseCalculation.source,
        formula: grossProfitSnapshot
          ? `订单毛利 ${roundMoney(grossProfitSnapshot.gross_profit_amount).toFixed(2)} × 商品销售占比 = ${grossProfit.toFixed(2)}`
          : `${allocatedRevenue.toFixed(2)} - (${unitCost.toFixed(2)} × ${quantity}) = ${grossProfit.toFixed(2)}`
      };
    });

    totalCost = grossProfitSnapshot
      ? roundMoney(grossProfitSnapshot.product_pricing_amount)
      : roundMoney(totalCost);
    baseGrossProfit = grossProfitSnapshot
      ? roundMoney(grossProfitSnapshot.gross_profit_amount)
      : roundMoney(baseGrossProfit);
    const approvedAdjustment = adjustmentMap.get(orderJson.order_id) || 0;
    const careCreditAdjustment = careCreditAdjustmentMap.get(orderJson.order_id) || 0;
    const otherApprovedAdjustment = roundMoney(approvedAdjustment - careCreditAdjustment);
    const careCostAmount = careCostMap.get(orderJson.order_id) || 0;
    const grossProfit = roundMoney(baseGrossProfit + approvedAdjustment);
    const participants = normalizeParticipants(orderJson);
    const customAllocation = participants.some(item => Number(item.profitAmount) > 0 || Number(item.ratio) > 0);
    const allocatedBase = allocateProfit(participants, baseGrossProfit);
    const sharedAdjustment = roundMoney(approvedPageAdjustments
      .filter(item => item.order_id === orderJson.order_id)
      .reduce((sum, item) => sum + toNumber(item.signed_amount), 0));
    const allocatedAdjustment = toNumber(baseGrossProfit)
      ? allocatedBase.map((share, index) => index === participants.length - 1
        ? roundMoney(sharedAdjustment - allocatedBase.slice(0, -1).reduce((sum, value) =>
          sum + roundMoney(sharedAdjustment * value / baseGrossProfit), 0))
        : roundMoney(sharedAdjustment * share / baseGrossProfit))
      : allocateProfit(participants.map(item => ({ ...item, profitAmount: '', ratio: '' })), sharedAdjustment);
    const participantAllocations = participants.map((participant, index) => ({
      staffId: participant.staffId,
      employeeName: participant.name,
      role: participant.role,
      ratio: participant.ratio,
      fixedAmount: participant.profitAmount,
      baseGrossProfit: allocatedBase[index],
      approvedAdjustment: roundMoney(allocatedAdjustment[index]),
      grossProfit: roundMoney(allocatedBase[index] + allocatedAdjustment[index])
    }));
    const usesNewSnapshot = !!grossProfitSnapshot;
    const usesLegacyFallback = !usesNewSnapshot && itemCalculations.some(item => item.source === 'legacy_fallback');
    return {
      entryType: 'sale',
      sourceOrderNo: orderJson.order_no,
      orderId: orderJson.order_id,
      orderNo: orderJson.order_no,
      orderTime: orderJson.create_time,
      employeeName: orderJson.create_user || '-',
      storeName: orderJson.Store?.name || '',
      customerName: orderJson.customer_name || '',
      totalAmount,
      discountAmount: roundMoney(orderJson.discount_amount),
      nationalSubsidy: roundMoney(orderJson.national_subsidy),
      educationSubsidy: roundMoney(orderJson.education_subsidy),
      actualPayment,
      totalCost,
      baseGrossProfit,
      careCostAmount,
      careCreditAdjustment,
      otherApprovedAdjustment,
      approvedAdjustment,
      grossProfit,
      customAllocation,
      participantAllocations,
      grossProfitSource: usesNewSnapshot
        ? 'order_gross_profit_snapshot'
        : (usesLegacyFallback ? 'legacy_fallback' : 'archived'),
      grossRate: calcRate(grossProfit, totalAmount),
      calculation: {
        orderFormula: `${baseGrossProfit.toFixed(2)} + Care可用金抵扣 ${careCreditAdjustment.toFixed(2)} + 其他调整 ${otherApprovedAdjustment.toFixed(2)} = ${grossProfit.toFixed(2)}`,
        revenueNote: usesNewSnapshot
          ? `基础毛利使用订单毛利快照：${snapshotDetail.formula}`
          : (usesLegacyFallback
            ? '该历史订单未生成新毛利快照，当前按原成本口径兼容计算'
            : '该订单尚未生成新毛利快照，暂按原归档销售毛利兼容展示'),
        snapshot: snapshotDetail,
        items: itemCalculations
      }
    };
  });

  const allEventRows = new Map([...saleList, ...reversals].map(row => [row.orderId, row]));
  const list = selectedKeys.map(row => allEventRows.get(row.id)).filter(Boolean);
  const returnProfit = roundMoney(reversals.reduce((sum, row) => sum + row.baseGrossProfit, 0));
  const returnSales = roundMoney(reversals.reduce((sum, row) => sum + row.totalAmount, 0));

  const summaryRows = await Order.findAll({
    where,
    attributes: [
      'create_user',
      [sequelize.fn('COUNT', sequelize.col('order_id')), 'orderCount'],
      [sequelize.fn('SUM', sequelize.col('total_amount')), 'totalAmount'],
      [sequelize.fn('SUM', sequelize.col('actual_payment')), 'actualPayment']
    ],
    group: ['create_user'],
    raw: true
  });

  const snapshotRows = await OrderGrossProfit.findAll({
    attributes: ['order_id', 'gross_profit_amount'],
    include: [{ model: Order, where, attributes: [], required: true }],
    raw: true
  });
  const snapshotOrderIds = snapshotRows.map(row => row.order_id);
  const fallbackOrderWhere = {
    ...where,
    ...(snapshotOrderIds.length ? { order_id: { [Op.notIn]: snapshotOrderIds } } : {})
  };
  const [approvedAdjustmentRows, fallbackItems, careCreditRows] = await Promise.all([
    PerformanceProfitAdjustment.findAll({
      where: { status: 'approved', ...originalAdjustmentCondition },
      attributes: [[sequelize.fn('SUM', sequelize.col('PerformanceProfitAdjustment.signed_amount')), 'amount']],
      include: [{ model: Order, where, attributes: [], required: true }],
      raw: true
    }),
    OrderItem.findAll({
      include: [{ model: Order, where: fallbackOrderWhere, attributes: [], required: true }],
      raw: true
    }),
    PerformanceProfitAdjustment.findAll({
      where: { status: 'approved', ...originalAdjustmentCondition, adjustment_no: { [Op.like]: 'AUTO-CARE-%' } },
      attributes: [[sequelize.fn('SUM', sequelize.col('PerformanceProfitAdjustment.signed_amount')), 'amount']],
      include: [{ model: Order, where, attributes: [], required: true }],
      raw: true
    })
  ]);
  const approvedAdjustmentRow = approvedAdjustmentRows[0] || { amount: 0 };


  const fallbackGrossProfit = roundMoney(fallbackItems.reduce(
    (sum, item) => sum + savedItemProfit(item).grossProfit,
    0
  ));
  const snapshotGrossProfit = roundMoney(snapshotRows.reduce(
    (sum, row) => sum + toNumber(row.gross_profit_amount),
    0
  ));
  const totalBaseGrossProfit = roundMoney(snapshotGrossProfit + fallbackGrossProfit + returnProfit);
  const totalApprovedAdjustment = roundMoney(
    toNumber(approvedAdjustmentRow?.amount) + reversals.reduce((sum, row) => sum + row.approvedAdjustment, 0)
  );
  const totalCareCreditAdjustment = roundMoney(toNumber(careCreditRows[0]?.amount) + reversals.reduce((sum, row) => sum + row.careCreditAdjustment, 0));

  const expenseAllocationWhere = {
    store_id: { [Op.in]: storeIds },
    status: 'approved'
  };
  if (staffName) expenseAllocationWhere.staff_name = staffName;
  if (startDate && endDate) {
    const start = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);
    const months = [];
    const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    while (cursor <= end) {
      months.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`);
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    expenseAllocationWhere.performance_month = { [Op.in]: months };
  }
  const expenseAllocationRows = await ExpensePerformanceAllocation.findAll({
    where: expenseAllocationWhere,
    attributes: [
      'staff_id',
      'staff_name',
      [sequelize.fn('SUM', sequelize.col('amount')), 'amount']
    ],
    group: ['staff_id', 'staff_name'],
    order: [[sequelize.literal('amount'), 'DESC'], ['staff_name', 'ASC']],
    raw: true
  });
  const profitVisible = canViewProfit(user);
  const visibleExpenseAllocationRows = profitVisible ? expenseAllocationRows : [];
  const totalExpensePerformanceDeduction = roundMoney(
    visibleExpenseAllocationRows.reduce((sum, row) => sum + toNumber(row.amount), 0)
  );

  const summary = {
    returnCount: reversals.filter(row => !row.isReturnAdjustment).length,
    orderCount: summaryRows.reduce((sum, row) => sum + Number(row.orderCount || 0), 0),
    totalAmount: roundMoney(summaryRows.reduce((sum, row) => sum + toNumber(row.totalAmount), 0) + returnSales),
    actualPayment: roundMoney(summaryRows.reduce((sum, row) => sum + toNumber(row.actualPayment), 0) + returnSales),
    baseGrossProfit: totalBaseGrossProfit,
    careCreditAdjustment: totalCareCreditAdjustment,
    otherApprovedAdjustment: roundMoney(totalApprovedAdjustment - totalCareCreditAdjustment),
    approvedAdjustment: totalApprovedAdjustment,
    grossProfit: roundMoney(totalBaseGrossProfit + totalApprovedAdjustment),
    expensePerformanceDeduction: profitVisible ? totalExpensePerformanceDeduction : null,
    netGrossProfit: profitVisible ? roundMoney(totalBaseGrossProfit + totalApprovedAdjustment - totalExpensePerformanceDeduction) : null,
    expenseDeductions: visibleExpenseAllocationRows.map(row => ({
      staffId: row.staff_id,
      staffName: row.staff_name || '-',
      amount: roundMoney(row.amount)
    })),
    pageGrossProfit: roundMoney(list.reduce((sum, row) => sum + toNumber(row.grossProfit), 0)),
    legacyOrderCount: new Set(fallbackItems.map(item => item.order_id)).size
  };

  if (startDate && endDate && !staffName && !orderNo) {
    const range = require('./dashboardService').buildRanges({ startDate, endDate }).current;
    const operating = await require('./operatingProfit').queryOperatingProfit({ storeIds, archiveScope: 'archived' }, range);
    summary.baseGrossProfit = operating.summary.baseGrossProfit;
    summary.approvedAdjustment = operating.summary.approvedAdjustment;
    summary.otherApprovedAdjustment = roundMoney(summary.approvedAdjustment - summary.careCreditAdjustment);
    summary.grossProfit = operating.summary.grossProfit;
    summary.netGrossProfit = profitVisible ? roundMoney(summary.grossProfit - totalExpensePerformanceDeduction) : null;
    summary.grossProfitSource = operating.source;
  }

  if (exportMode) {
    const exportRows = list.flatMap(order => {
      const snapshot = order.calculation?.snapshot || {};
      const items = order.calculation?.items || [];
      const paymentDetails = (snapshot.paymentDetails || []).map(item =>
        `${item.method || item.paymentMethod || '支付方式'} ${toNumber(item.amount).toFixed(2)}（手续费 ${toNumber(item.fee).toFixed(2)}）`
      ).join('；');
      const supplementDetails = (snapshot.supplementDetails || []).map(item =>
        `${item.itemName || item.content || '补录'} ${toNumber(item.amount).toFixed(2)}`
      ).join('；');
      const freightDetails = (snapshot.freightCostDetails || []).map(item =>
        `${item.sourceNo || item.platformName || item.sourceType || '运费'} ${item.snCode || item.sn || ''} ${toNumber(item.amount).toFixed(2)}`.trim()
      ).join('；');
      return (items.length ? items : [{}]).map(item => ({
        "\u4e1a\u52a1\u7c7b\u578b": order.entryType === "return" ? "\u9000\u5355\u51b2\u56de" : "\u9500\u552e",
        "\u539f\u9500\u552e\u5355\u53f7": order.sourceOrderNo || order.orderNo,
        订单号: order.orderNo,
        销售时间: order.orderTime,
        员工: order.employeeName,
        门店: order.storeName,
        客户: order.customerName,
        商品名称: item.productName || '',
        PN: item.pnCode || '',
        SN: item.snCode || '',
        数量: item.quantity ?? '',
        销售单价: item.salePrice ?? '',
        商品销售额: item.saleSubtotal ?? '',
        商品定价单价: item.unitCost ?? '',
        商品定价金额: item.costAmount ?? '',
        商品分摊收入: item.allocatedRevenue ?? '',
        商品分摊基础毛利: item.grossProfit ?? '',
        毛利计算口径: item.formula || '',
        '订单组成-用户应收': snapshot.receivableAmount ?? '',
        '订单组成-商品定价': snapshot.productPricingAmount ?? '',
        '订单组成-支付手续费': snapshot.paymentFeeAmount ?? '',
        '订单组成-增值税': snapshot.vatAmount ?? '',
        '订单组成-补录净额': snapshot.supplementAmount ?? '',
        '订单组成-运费': snapshot.freightCostAmount ?? '',
        '订单组成-开票金额': snapshot.invoiceAmount ?? '',
        '订单组成-外调费': snapshot.externalAdjustmentFee ?? '',
        支付方式明细: paymentDetails,
        补录明细: supplementDetails,
        运费明细: freightDetails,
        订单基础毛利: order.baseGrossProfit,
        Care可用金抵扣: order.careCreditAdjustment,
        其他审批调整: order.otherApprovedAdjustment,
        员工业绩毛利: order.grossProfit,
        毛利率百分比: order.grossRate,
        毛利来源: order.grossProfitSource
      }));
    });
    sendExcel(ctx, exportRows, EMPLOYEE_PROFIT_EXPORT_HEADERS, `个人毛利明细_${startDate || '全部'}_${endDate || '全部'}.xlsx`, '销售商品毛利', { textHeaders: ['订单号', 'PN', 'SN'] });
    return;
  }

  ctx.body = {
    list,
    summary,
    employees: employees.map(item => item.name).filter(Boolean).sort(),
    pagination: {
      total: count,
      page: Number(page),
      pageSize: Number(pageSize),
      totalPages: Math.ceil(count / Number(pageSize || 20))
    }
  };
}

async function getDashboardFilters(ctx) {
  ctx.body = await dashboardService.buildFilters(ctx.state.user);
}

async function getDashboardOverview(ctx) {
  const overview = await dashboardService.buildOverview(ctx.state.user, ctx.query);
  overview.decisionInsights = buildDecisionInsights(overview);
  overview.aiAdvisor = buildAiAdvisor(overview);
  ctx.body = overview;
}

module.exports = {
  getSalesReport,
  getCustomerSourceAnalysis,
  getInventoryReport,
  getEmployeePerformanceReport,
  getDashboardFilters,
  getDashboardOverview,
  _test: {
    aggregateProductSalesMetrics,
    buildCategoryPath,
    buildInventoryReportMetrics,
    buildInventoryCategoryOrderMap,
    sortInventoryCategoryStats
  }
};
