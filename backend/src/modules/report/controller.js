/**
 * 报表管理控制器
 */
const {
  Order,
  OrderItem,
  OrderGrossProfit,
  SalesReturnGrossProfitLedger,
  ProductSn,
  Product,
  Store,
  PerformanceProfitAdjustment,
  sequelize
} = require('../../models');
const { Op } = require('sequelize');
const { loadLegacyCostMaps, calculateItemBaseProfit } = require('./profitCalculation');
const { DashboardService } = require('./dashboardService');
const { FORMULA_VERSION: GROSS_PROFIT_FORMULA_VERSION } = require('../sales/grossProfit');

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

async function getEmployeeReportStoreIds(user, requestedStoreId) {
  const where = {};
  if (!user.accessibleStoreIds?.includes('*')) {
    where.store_id = { [Op.in]: user.accessibleStoreIds || [] };
  }
  if (requestedStoreId && !user.accessibleStoreIds?.includes('*') && !(user.accessibleStoreIds || []).map(String).includes(String(requestedStoreId))) return [];
  if (requestedStoreId) where.store_id = requestedStoreId;
  const stores = await Store.findAll({ where, attributes: ['store_id'], raw: true });
  return stores.map(store => store.store_id);
}

/**
 * 销售报表
 */
async function getSalesReport(ctx) {
  const { storeId, startDate, endDate } = ctx.query;
  const user = ctx.state.user;

  const whereStore = {};
  if (!user.accessibleStoreIds.includes('*')) {
    whereStore.store_id = user.accessibleStoreIds;
  }
  if (storeId) whereStore.store_id = storeId;

  const stores = await Store.findAll({ where: whereStore });
  const storeIds = stores.map(s => s.store_id);

  const where = {
    is_deleted: 0,
    store_id: storeIds
  };

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

  // 按商品类别统计
  const statsByCategory = await OrderItem.findAll({
    where: { '$Order.store_id$': storeIds },
    attributes: [
      [sequelize.col('Product.category'), 'category'],
      [sequelize.fn('COUNT', sequelize.col('OrderItem.item_id')), 'itemCount'],
      [sequelize.fn('SUM', sequelize.col('OrderItem.quantity')), 'totalQuantity'],
      [sequelize.fn('SUM', sequelize.col('OrderItem.subtotal')), 'totalAmount']
    ],
    include: [{
      model: Order,
      where,
      attributes: []
    }, {
      model: Product,
      as: 'Product',
      attributes: []
    }],
    group: [sequelize.col('Product.category')],
    raw: true
  });

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

  ctx.body = {
    summary: summary[0] || {},
    statsByStore,
    statsByCategory,
    statsByDate
  };
}

/**
 * 库存报表
 */
async function getInventoryReport(ctx) {
  const { storeId, category } = ctx.query;
  const user = ctx.state.user;

  const whereStore = {};
  if (!user.accessibleStoreIds.includes('*')) {
    whereStore.store_id = user.accessibleStoreIds;
  }
  if (storeId) whereStore.store_id = storeId;

  const stores = await Store.findAll({ where: whereStore });
  const storeIds = stores.map(s => s.store_id);

  const whereSn = { is_deleted: 0, status: 'in_stock' };
  if (storeId) whereSn.store_id = storeId;

  // 在库统计
  const inStockStats = await ProductSn.findAll({
    where: whereSn,
    attributes: [
      'product_id',
      [sequelize.fn('COUNT', sequelize.col('sn_id')), 'inStockCount']
    ],
    include: [{
      model: Product,
      attributes: ['name', 'category']
    }],
    group: ['product_id'],
    raw: true
  });

  // 按类别汇总
  const categoryStats = await ProductSn.findAll({
    where: whereSn,
    attributes: [
      [sequelize.col('Product.category'), 'category'],
      [sequelize.fn('COUNT', sequelize.col('sn_id')), 'totalCount']
    ],
    include: [{
      model: Product,
      attributes: []
    }],
    group: [sequelize.col('Product.category')],
    raw: true
  });

  ctx.body = { inStockStats, categoryStats };
}

async function getEmployeePerformanceReport(ctx) {
  const { storeId, staffName, startDate, endDate, page = 1, pageSize = 20 } = ctx.query;
  const user = ctx.state.user;

  const storeIds = await getEmployeeReportStoreIds(user, storeId);
  if (storeIds.length === 0) {
    ctx.body = { list: [], summary: {}, employees: [], pagination: { total: 0, page, pageSize, totalPages: 0 } };
    return;
  }

  const where = {
    is_deleted: 0,
    store_id: { [Op.in]: storeIds },
    order_status: { [Op.in]: ['已归档', 'completed', 'archived', 'returned'] }
  };
  if (staffName) where.create_user = staffName;
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
          ? '基础毛利使用订单毛利快照：用户应收－产品定价－应收税率费用－增值税＋补录净额'
          : (usesLegacyFallback
            ? '该历史订单未生成新毛利快照，当前按原成本口径兼容计算'
            : '该订单尚未生成新毛利快照，暂按原归档销售毛利兼容展示'),
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

  const summary = {
    orderCount: summaryRows.reduce((sum, row) => sum + Number(row.orderCount || 0), 0),
    totalAmount: roundMoney(summaryRows.reduce((sum, row) => sum + toNumber(row.totalAmount), 0)),
    actualPayment: roundMoney(summaryRows.reduce((sum, row) => sum + toNumber(row.actualPayment), 0)),
    baseGrossProfit: totalBaseGrossProfit,
    approvedAdjustment: totalApprovedAdjustment,
    grossProfit: roundMoney(totalBaseGrossProfit + totalApprovedAdjustment),
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
  ctx.body = await dashboardService.buildOverview(ctx.state.user, ctx.query);
}

module.exports = {
  getSalesReport,
  getInventoryReport,
  getEmployeePerformanceReport,
  getDashboardFilters,
  getDashboardOverview
};
