const {
  RealtimeSqlDashboardDataSource,
  normalizeParticipants,
  roundMoney,
  toNumber
} = require('./dashboardDataSource');

const PROFIT_ROLES = new Set(['boss', 'admin', 'finance', 'manager']);
const AGE_BUCKET_ORDER = ['0-7天', '8-15天', '16-30天', '31-60天', '60天以上'];

function dateParts(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function keyFromUtcDate(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  ].join('-');
}

function shiftDateKey(key, days) {
  const parts = dateParts(key);
  if (!parts) return null;
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  date.setUTCDate(date.getUTCDate() + days);
  return keyFromUtcDate(date);
}

function shiftYearKey(key, years) {
  const parts = dateParts(key);
  if (!parts) return null;
  const date = new Date(Date.UTC(parts.year + years, parts.month - 1, parts.day));
  if (date.getUTCMonth() !== parts.month - 1) {
    date.setUTCDate(0);
  }
  return keyFromUtcDate(date);
}

function chinaTodayKey(now = new Date()) {
  return keyFromUtcDate(new Date(now.getTime() + 8 * 60 * 60 * 1000));
}

function defaultWeekRange(now = new Date()) {
  const today = chinaTodayKey(now);
  const parts = dateParts(today);
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const weekday = date.getUTCDay() || 7;
  return { startDate: shiftDateKey(today, 1 - weekday), endDate: today };
}

function dayDiff(startKey, endKey) {
  const start = dateParts(startKey);
  const end = dateParts(endKey);
  if (!start || !end) return NaN;
  return Math.round((
    Date.UTC(end.year, end.month - 1, end.day) -
    Date.UTC(start.year, start.month - 1, start.day)
  ) / 86400000);
}

function toChinaBoundary(key, endOfDay = false) {
  return new Date(`${key}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+08:00`);
}

function buildRanges(query = {}, now = new Date()) {
  const defaults = defaultWeekRange(now);
  const startDate = query.startDate || defaults.startDate;
  const endDate = query.endDate || defaults.endDate;
  if (!dateParts(startDate) || !dateParts(endDate) || dayDiff(startDate, endDate) < 0) {
    const error = new Error('日期范围格式不正确');
    error.status = 400;
    throw error;
  }
  const durationDays = dayDiff(startDate, endDate) + 1;
  const previousEnd = shiftDateKey(startDate, -1);
  const previousStart = shiftDateKey(previousEnd, -(durationDays - 1));
  const yoyStart = shiftYearKey(startDate, -1);
  const yoyEnd = shiftYearKey(endDate, -1);
  const wrap = (start, end) => ({
    startDate: start,
    endDate: end,
    startAt: toChinaBoundary(start, false),
    endAt: toChinaBoundary(end, true)
  });
  return {
    current: wrap(startDate, endDate),
    previous: wrap(previousStart, previousEnd),
    yoy: wrap(yoyStart, yoyEnd)
  };
}

function comparisonRate(current, comparison) {
  const base = toNumber(comparison);
  if (base === 0) return null;
  return Number((((toNumber(current) - base) / Math.abs(base)) * 100).toFixed(2));
}

function summarizeTrend(rows = []) {
  const summary = rows.reduce((result, row) => {
    result.salesAmount += toNumber(row.salesAmount);
    result.grossProfit += toNumber(row.grossProfit);
    result.orderCount += Number(row.orderCount || 0);
    return result;
  }, { salesAmount: 0, grossProfit: 0, orderCount: 0 });
  summary.salesAmount = roundMoney(summary.salesAmount);
  summary.grossProfit = roundMoney(summary.grossProfit);
  summary.averageOrderValue = summary.orderCount
    ? roundMoney(summary.salesAmount / summary.orderCount)
    : 0;
  summary.grossMargin = summary.salesAmount
    ? Number(((summary.grossProfit / summary.salesAmount) * 100).toFixed(2))
    : null;
  return summary;
}

function metric(current, yoy, previous, options = {}) {
  return {
    value: current,
    yoy: options.historyUnavailable ? null : comparisonRate(current, yoy),
    periodCompare: options.historyUnavailable ? null : comparisonRate(current, previous),
    unavailableReason: options.historyUnavailable ? options.unavailableReason : null
  };
}

function buildKpis(current, yoy, previous, inventory, canViewProfit) {
  return {
    salesAmount: metric(current.salesAmount, yoy.salesAmount, previous.salesAmount),
    grossProfit: canViewProfit
      ? metric(current.grossProfit, yoy.grossProfit, previous.grossProfit)
      : { value: null, yoy: null, periodCompare: null, unavailableReason: '无毛利查看权限' },
    grossMargin: canViewProfit
      ? metric(current.grossMargin, yoy.grossMargin, previous.grossMargin)
      : { value: null, yoy: null, periodCompare: null, unavailableReason: '无毛利查看权限' },
    orderCount: metric(current.orderCount, yoy.orderCount, previous.orderCount),
    averageOrderValue: metric(current.averageOrderValue, yoy.averageOrderValue, previous.averageOrderValue),
    inventoryAmount: canViewProfit
      ? metric(inventory.inventoryAmount, null, null, {
          historyUnavailable: true,
          unavailableReason: '当前无库存历史快照'
        })
      : { value: null, yoy: null, periodCompare: null, unavailableReason: '无库存金额查看权限' }
  };
}

function alignTrend(currentRows, yoyRows, previousRows, canViewProfit) {
  return currentRows.map((row, index) => {
    const yoy = yoyRows[index] || {};
    const previous = previousRows[index] || {};
    return {
      bucket: row.bucket,
      salesAmount: roundMoney(row.salesAmount),
      grossProfit: canViewProfit ? roundMoney(row.grossProfit) : null,
      orderCount: Number(row.orderCount || 0),
      salesYoy: comparisonRate(row.salesAmount, yoy.salesAmount),
      salesPeriodCompare: comparisonRate(row.salesAmount, previous.salesAmount),
      grossYoy: canViewProfit ? comparisonRate(row.grossProfit, yoy.grossProfit) : null,
      grossPeriodCompare: canViewProfit ? comparisonRate(row.grossProfit, previous.grossProfit) : null
    };
  });
}

function buildEmployeePerformance(orderRows, adjustmentRows, selectedEmployeeId, canViewProfit) {
  const adjustmentMap = new Map();
  adjustmentRows.forEach(row => {
    const orderId = String(row.orderId);
    if (!adjustmentMap.has(orderId)) adjustmentMap.set(orderId, []);
    adjustmentMap.get(orderId).push({
      signedAmount: roundMoney(row.signedAmount),
      reason: row.reason || '',
      adjustmentType: row.adjustmentType,
      adjustmentNo: row.adjustmentNo,
      participantKey: row.participantKey ? String(row.participantKey) : ''
    });
  });

  const rankMap = new Map();
  const details = [];
  orderRows.forEach(order => {
    const participants = normalizeParticipants(order);
    if (!participants.length) return;
    const participantCount = participants.length;
    const adjustments = adjustmentMap.get(String(order.order_id)) || [];
    const sharedAdjustments = adjustments.filter(row => !row.participantKey);
    const totalAdjustment = roundMoney(sharedAdjustments.reduce((sum, row) => sum + row.signedAmount, 0));
    const salesShare = roundMoney(toNumber(order.sales_amount) / participantCount);
    const baseProfitShare = roundMoney(toNumber(order.base_gross_profit) / participantCount);

    participants.forEach(participant => {
      if (selectedEmployeeId && String(participant.staffId || '') !== String(selectedEmployeeId)) return;
      if (!rankMap.has(participant.key)) {
        rankMap.set(participant.key, {
          staffId: participant.staffId,
          employeeName: participant.name,
          salesAmount: 0,
          baseGrossProfit: 0,
          approvedAdjustment: 0,
          grossProfit: 0,
          participatedOrderCount: 0
        });
      }
      const participantAdjustments = adjustments.filter(row => (
        !row.participantKey || row.participantKey === participant.key
      ));
      const directAdjustment = roundMoney(participantAdjustments
        .filter(row => row.participantKey)
        .reduce((sum, row) => sum + row.signedAmount, 0));
      const participantAdjustment = roundMoney(directAdjustment + totalAdjustment / participantCount);
      const participantGrossProfitShare = roundMoney(baseProfitShare + participantAdjustment);
      const rank = rankMap.get(participant.key);
      rank.salesAmount += salesShare;
      rank.baseGrossProfit += baseProfitShare;
      rank.approvedAdjustment += participantAdjustment;
      rank.grossProfit += participantGrossProfitShare;
      rank.participatedOrderCount += 1;

      details.push({
        orderId: order.order_id,
        orderNo: order.order_no,
        orderTime: order.create_time,
        storeName: order.store_name,
        staffId: participant.staffId,
        employeeName: participant.name,
        role: participant.role,
        participantCount,
        orderSalesAmount: roundMoney(order.sales_amount),
        allocatedSalesAmount: salesShare,
        orderBaseGrossProfit: canViewProfit ? roundMoney(order.base_gross_profit) : null,
        allocatedBaseGrossProfit: canViewProfit ? baseProfitShare : null,
        allocatedAdjustment: canViewProfit ? participantAdjustment : null,
        allocatedGrossProfit: canViewProfit ? participantGrossProfitShare : null,
        reasons: canViewProfit ? participantAdjustments : [],
        allocationReason: `主销售与${Math.max(0, participantCount - 1)}名辅助销售平均分摊`
      });
    });
  });

  const ranking = [...rankMap.values()].map(row => ({
    ...row,
    salesAmount: roundMoney(row.salesAmount),
    baseGrossProfit: canViewProfit ? roundMoney(row.baseGrossProfit) : null,
    approvedAdjustment: canViewProfit ? roundMoney(row.approvedAdjustment) : null,
    grossProfit: canViewProfit ? roundMoney(row.grossProfit) : null
  })).sort((a, b) => (
    canViewProfit ? b.grossProfit - a.grossProfit : b.salesAmount - a.salesAmount
  ));

  return {
    ranking: ranking.slice(0, 20),
    details: details.slice(0, 100)
  };
}

function mapProductRows(rows, canViewProfit) {
  const normalized = rows.map(row => {
    const salesAmount = roundMoney(row.salesAmount);
    const grossProfit = roundMoney(row.grossProfit);
    return {
      productId: row.productId,
      productName: row.productName || '未命名商品',
      productCode: row.productCode || '',
      isFocusProduct: Number(row.isFocusProduct || 0) === 1,
      salesAmount,
      grossProfit: canViewProfit ? grossProfit : null,
      quantity: toNumber(row.quantity),
      grossMargin: canViewProfit && salesAmount
        ? Number(((grossProfit / salesAmount) * 100).toFixed(2))
        : null
    };
  });
  return {
    salesTop10: [...normalized].sort((a, b) => b.salesAmount - a.salesAmount).slice(0, 10),
    grossProfitTop10: canViewProfit
      ? [...normalized].sort((a, b) => b.grossProfit - a.grossProfit).slice(0, 10)
      : [],
    quantityTop10: [...normalized].sort((a, b) => b.quantity - a.quantity).slice(0, 10),
    highMarginTop10: canViewProfit
      ? normalized.filter(row => row.salesAmount > 0).sort((a, b) => b.grossMargin - a.grossMargin).slice(0, 10)
      : [],
    focusProducts: normalized.filter(row => row.isFocusProduct).sort((a, b) => b.salesAmount - a.salesAmount).slice(0, 20)
  };
}

function getRoles(user) {
  if (Array.isArray(user?.roles) && user.roles.length) return user.roles;
  return String(user?.roleCode || '').split(',').map(role => role.trim()).filter(Boolean);
}

function canViewProfit(user) {
  // 所有已登录账号均可查看自己数据权限范围内的毛利；门店范围仍由 accessibleStoreIds 控制。
  return Boolean(user && user.staffId);
}

function normalizeStoreIds(userStoreIds, allStoreIds = []) {
  if ((userStoreIds || []).includes('*')) return allStoreIds;
  return [...new Set((userStoreIds || []).map(String).filter(Boolean))];
}

class DashboardService {
  constructor(dataSource = new RealtimeSqlDashboardDataSource()) {
    this.dataSource = dataSource;
  }

  async buildFilters(user) {
    let storeIds = user.accessibleStoreIds || [];
    if (storeIds.includes('*')) {
      const rows = await this.dataSource.query(
        'SELECT STORE_ID AS storeId FROM T_STORE WHERE IS_DELETED = 0 AND STATUS = 1'
      );
      storeIds = rows.map(row => String(row.storeId));
    }
    if (!storeIds.length) return { stores: [], employees: [], productLines: [] };
    return this.dataSource.getFilters({ storeIds });
  }

  async buildOverview(user, query = {}) {
    const ranges = buildRanges(query);
    const granularity = ['day', 'week', 'month'].includes(query.granularity)
      ? query.granularity
      : 'day';
    let storeIds = user.accessibleStoreIds || [];
    if (storeIds.includes('*')) {
      const rows = await this.dataSource.query(
        'SELECT STORE_ID AS storeId FROM T_STORE WHERE IS_DELETED = 0 AND STATUS = 1'
      );
      storeIds = rows.map(row => String(row.storeId));
    }
    if (!storeIds.length) {
      const error = new Error('当前账号尚未分配门店');
      error.status = 403;
      throw error;
    }
    if (query.storeId && !storeIds.includes(String(query.storeId))) {
      const error = new Error('无权访问该门店');
      error.status = 403;
      throw error;
    }

    const filters = {
      storeIds,
      storeId: query.storeId || '',
      employeeId: query.employeeId || '',
      productLine: query.productLine || ''
    };
    const profitVisible = canViewProfit(user);
    const [
      currentTrend,
      yoyTrend,
      previousTrend,
      storeRanking,
      productRows,
      productLineRows,
      employeeOrderRows,
      approvedAdjustments,
      inventory
    ] = await Promise.all([
      this.dataSource.getTrend(filters, ranges.current, granularity),
      this.dataSource.getTrend(filters, ranges.yoy, granularity),
      this.dataSource.getTrend(filters, ranges.previous, granularity),
      this.dataSource.getStoreRanking(filters, ranges.current),
      this.dataSource.getProductRows(filters, ranges.current),
      this.dataSource.getProductLineRows(filters, ranges.current),
      this.dataSource.getEmployeeOrderRows(filters, ranges.current),
      this.dataSource.getApprovedAdjustments(filters, ranges.current),
      this.dataSource.getInventory(filters)
    ]);

    const current = summarizeTrend(currentTrend);
    const yoy = summarizeTrend(yoyTrend);
    const previous = summarizeTrend(previousTrend);
    const employeePerformance = buildEmployeePerformance(
      employeeOrderRows,
      approvedAdjustments,
      query.employeeId,
      profitVisible
    );
    const productAnalysis = mapProductRows(productRows, profitVisible);
    const inventoryView = {
      ...inventory,
      inventoryAmount: profitVisible ? inventory.inventoryAmount : null,
      ageStructure: inventory.ageStructure
        .sort((a, b) => AGE_BUCKET_ORDER.indexOf(a.ageBucket) - AGE_BUCKET_ORDER.indexOf(b.ageBucket))
        .map(row => ({
          ...row,
          inventoryAmount: profitVisible ? row.inventoryAmount : null
        })),
      staleProducts: inventory.staleProducts.map(row => ({
        ...row,
        inventoryAmount: profitVisible ? row.inventoryAmount : null
      }))
    };

    return {
      meta: {
        source: 'realtime_sql',
        startDate: ranges.current.startDate,
        endDate: ranges.current.endDate,
        granularity,
        timezone: 'Asia/Shanghai',
        canViewProfit: profitVisible,
        allocationRule: '主销售人与辅助销售人平均拆分销售额和业绩毛利',
        generatedAt: new Date().toISOString()
      },
      kpis: buildKpis(current, yoy, previous, inventory, profitVisible),
      trend: alignTrend(currentTrend, yoyTrend, previousTrend, profitVisible),
      storeRanking: storeRanking.map(row => ({
        ...row,
        salesAmount: roundMoney(row.salesAmount),
        grossProfit: profitVisible ? roundMoney(row.grossProfit) : null,
        orderCount: Number(row.orderCount || 0)
      })),
      employeeRanking: employeePerformance.ranking,
      employeePerformanceDetails: employeePerformance.details,
      productLineAnalysis: productLineRows.map(row => ({
        productLine: row.productLine,
        salesAmount: roundMoney(row.salesAmount),
        grossProfit: profitVisible ? roundMoney(row.grossProfit) : null
      })),
      productAnalysis,
      inventory: inventoryView
    };
  }
}

module.exports = {
  DashboardService,
  buildRanges,
  comparisonRate,
  summarizeTrend,
  buildEmployeePerformance,
  canViewProfit,
  _test: {
    defaultWeekRange,
    shiftDateKey,
    shiftYearKey,
    normalizeStoreIds
  }
};
