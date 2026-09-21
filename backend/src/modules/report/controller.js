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
  Region,
  PerformanceProfitAdjustment,
  ExpensePerformanceAllocation,
  sequelize
} = require('../../models');
const { Op } = require('sequelize');
const { loadLegacyCostMaps, calculateItemBaseProfit } = require('./profitCalculation');
const { DashboardService, canViewProfit } = require('./dashboardService');
const { ARCHIVED_STATUSES: POSITIVE_SALES_ORDER_STATUSES } = require('./dashboardDataSource');
const { buildDecisionInsights, buildAiAdvisor } = require('./decisionEngine');
const { resolveReportStoreIds, isSelfOnlyReportUser } = require('../../utils/storePermissions');
const {
  FORMULA_VERSION: GROSS_PROFIT_FORMULA_VERSION,
  snapshotToResponse
} = require('../sales/grossProfit');

const dashboardService = new DashboardService();

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
    return {
      category: product.category || '未分类',
      categoryPath: buildCategoryPath(product.category_id, categoryMap, product.category),
      brand: product.brand,
      series: product.series,
      model: product.model,
      quantity,
      salesAmount,
      salesGrossProfit: baseProfit.grossProfit,
      productGrossProfit: settlement && settlement.cost_status === 'ready' ? roundMoney(settlement.gross_profit_amount) : null,
      financialGrossProfit: quantity > 0 && unitCost <= 0 ? null : roundMoney(netRevenue - bookCost)
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

  const returnSettlementWhere = { store_id: storeIds };
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

  const { rows: normalizedCategoryStats, summary } = buildInventoryReportMetrics(categoryStats);

  ctx.body = { inStockStats, categoryStats: normalizedCategoryStats, summary };
}

async function getEmployeePerformanceReport(ctx) {
  const { storeId, staffName, orderNo, startDate, endDate, page = 1, pageSize = 20 } = ctx.query;
  const user = ctx.state.user;

  const storeIds = await getEmployeeReportStoreIds(user, storeId);
  if (storeIds.length === 0) {
    ctx.body = { list: [], summary: {}, employees: [], pagination: { total: 0, page, pageSize, totalPages: 0 } };
    return;
  }

  const where = {
    is_deleted: 0,
    store_id: { [Op.in]: storeIds },
    order_status: { [Op.in]: POSITIVE_SALES_ORDER_STATUSES }
  };
  if (staffName) where.create_user = staffName;
  if (orderNo) where.order_no = { [Op.like]: `%${String(orderNo).trim()}%` };
  if (startDate && endDate) {
    where.create_time = {
      [Op.gte]: new Date(startDate),
      [Op.lte]: new Date(`${endDate} 23:59:59`)
    };
  }

  const employees = await Order.findAll({
    where: {
      is_deleted: 0,
      store_id: { [Op.in]: storeIds },
      create_user: { [Op.ne]: null }
    },
    attributes: [[sequelize.fn('DISTINCT', sequelize.col('create_user')), 'name']],
    raw: true
  });

  const { count, rows: orders } = await Order.findAndCountAll({
    where,
    include: [
      { model: Store, attributes: ['store_id', 'name'] },
      { model: OrderItem },
      {
        model: OrderGrossProfit,
        as: 'grossProfitSnapshot',
        where: { formula_version: GROSS_PROFIT_FORMULA_VERSION },
        required: false
      }
    ],
    order: [['create_time', 'DESC']],
    offset: (Math.max(Number(page) || 1, 1) - 1) * Math.max(Number(pageSize) || 20, 1),
    limit: Math.max(Number(pageSize) || 20, 1),
    distinct: true
  });

  const pageOrderIds = orders.map(order => order.order_id);
  const [approvedPageAdjustments, returnGrossProfitAdjustments] = pageOrderIds.length
    ? await Promise.all([
        PerformanceProfitAdjustment.findAll({
          where: { order_id: { [Op.in]: pageOrderIds }, status: 'approved' },
          attributes: [
            'order_id',
            [sequelize.fn('SUM', sequelize.col('signed_amount')), 'amount']
          ],
          group: ['order_id'],
          raw: true
        }),
        SalesReturnGrossProfitLedger.findAll({
          where: { order_id: { [Op.in]: pageOrderIds } },
          attributes: [
            'order_id',
            [sequelize.fn('SUM', sequelize.col('gross_profit_amount')), 'amount']
          ],
          group: ['order_id'],
          raw: true
        })
      ])
    : [[], []];
  const adjustmentMap = new Map();
  [...approvedPageAdjustments, ...returnGrossProfitAdjustments].forEach(row => {
    adjustmentMap.set(
      row.order_id,
      roundMoney((adjustmentMap.get(row.order_id) || 0) + toNumber(row.amount))
    );
  });
  const pageItems = orders.flatMap(order => order.OrderItems || []);
  const legacyCostMaps = await loadLegacyCostMaps(pageItems);

  const list = orders.map(order => {
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
      const saleSubtotal = roundMoney(item.subtotal || (toNumber(item.sale_price) * quantity));
      const allocatedRevenue = saleSubtotal;
      const baseCalculation = calculateItemBaseProfit(item, legacyCostMaps);
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
    const grossProfit = roundMoney(baseGrossProfit + approvedAdjustment);
    const usesNewSnapshot = !!grossProfitSnapshot;
    const usesLegacyFallback = !usesNewSnapshot && itemCalculations.some(item => item.source === 'legacy_fallback');
    return {
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
      approvedAdjustment,
      grossProfit,
      grossProfitSource: usesNewSnapshot
        ? 'order_gross_profit_snapshot'
        : (usesLegacyFallback ? 'legacy_fallback' : 'archived'),
      grossRate: calcRate(grossProfit, totalAmount),
      calculation: {
        orderFormula: `${baseGrossProfit.toFixed(2)} + 已审批调整 ${approvedAdjustment.toFixed(2)} = ${grossProfit.toFixed(2)}`,
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
    where: { formula_version: GROSS_PROFIT_FORMULA_VERSION },
    attributes: ['order_id', 'gross_profit_amount'],
    include: [{ model: Order, where, attributes: [], required: true }],
    raw: true
  });
  const snapshotOrderIds = snapshotRows.map(row => row.order_id);
  const fallbackOrderWhere = {
    ...where,
    ...(snapshotOrderIds.length ? { order_id: { [Op.notIn]: snapshotOrderIds } } : {})
  };
  const [approvedAdjustmentRows, returnGrossProfitRows, fallbackItems] = await Promise.all([
    PerformanceProfitAdjustment.findAll({
      where: { status: 'approved' },
      attributes: [[sequelize.fn('SUM', sequelize.col('PerformanceProfitAdjustment.signed_amount')), 'amount']],
      include: [{ model: Order, where, attributes: [], required: true }],
      raw: true
    }),
    SalesReturnGrossProfitLedger.findAll({
      attributes: [[sequelize.fn('SUM', sequelize.col('gross_profit_amount')), 'amount']],
      include: [{ model: Order, as: 'order', where, attributes: [], required: true }],
      raw: true
    }),
    OrderItem.findAll({
      include: [{ model: Order, where: fallbackOrderWhere, attributes: [], required: true }],
      raw: true
    })
  ]);
  const approvedAdjustmentRow = approvedAdjustmentRows[0] || { amount: 0 };
  const returnGrossProfitRow = returnGrossProfitRows[0] || { amount: 0 };
  const summaryLegacyMaps = await loadLegacyCostMaps(fallbackItems);
  const fallbackGrossProfit = roundMoney(fallbackItems.reduce(
    (sum, item) => sum + calculateItemBaseProfit(item, summaryLegacyMaps).grossProfit,
    0
  ));
  const snapshotGrossProfit = roundMoney(snapshotRows.reduce(
    (sum, row) => sum + toNumber(row.gross_profit_amount),
    0
  ));
  const totalBaseGrossProfit = roundMoney(snapshotGrossProfit + fallbackGrossProfit);
  const totalApprovedAdjustment = roundMoney(
    toNumber(approvedAdjustmentRow?.amount) + toNumber(returnGrossProfitRow?.amount)
  );

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
    orderCount: summaryRows.reduce((sum, row) => sum + Number(row.orderCount || 0), 0),
    totalAmount: roundMoney(summaryRows.reduce((sum, row) => sum + toNumber(row.totalAmount), 0)),
    actualPayment: roundMoney(summaryRows.reduce((sum, row) => sum + toNumber(row.actualPayment), 0)),
    baseGrossProfit: totalBaseGrossProfit,
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
  getInventoryReport,
  getEmployeePerformanceReport,
  getDashboardFilters,
  getDashboardOverview,
  _test: { aggregateProductSalesMetrics, buildCategoryPath, buildInventoryReportMetrics }
};
