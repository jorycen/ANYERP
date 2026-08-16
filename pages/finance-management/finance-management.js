const api = require('../../utils/api.js');
const userUtils = require('../profile/user-utils.js');

const PERIODS = [
  { key: 'day', label: '日' },
  { key: 'month', label: '月' },
  { key: 'year', label: '年' }
];

const PAYMENT_STATUSES = [
  { key: 'all', label: '全部' },
  { key: 'uncreated', label: '未生成结算单' },
  { key: 'created', label: '已生成结算单' },
  { key: 'paid', label: '已支付' }
];

function listOf(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.data)) return result.data;
  if (Array.isArray(result.list)) return result.list;
  if (Array.isArray(result.rows)) return result.rows;
  if (Array.isArray(result.items)) return result.items;
  if (result.data && typeof result.data === 'object') return listOf(result.data);
  return [];
}

function firstValue(row, keys) {
  for (let i = 0; i < keys.length; i += 1) {
    const value = row && row[keys[i]];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

function numberValue(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const normalized = String(value).replace(/[^\d.-]/g, '');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : fallback;
}

function formatMoney(value) {
  return numberValue(value).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function unwrapReport(result) {
  let source = result || {};
  for (let i = 0; i < 3; i += 1) {
    if (source.dashboard && typeof source.dashboard === 'object') {
      source = source.dashboard;
      continue;
    }
    if (source.data && typeof source.data === 'object' && !Array.isArray(source.data)) {
      source = source.data;
      continue;
    }
    break;
  }
  return source || {};
}

function getPagination(result) {
  const source = result && result.raw ? result.raw : result;
  const candidates = [source, source && source.data, source && source.pagination, source && source.pageInfo];
  for (let i = 0; i < candidates.length; i += 1) {
    const item = candidates[i];
    if (!item || typeof item !== 'object') continue;
    if (item.pagination && typeof item.pagination === 'object') candidates.push(item.pagination);
    if (item.pageInfo && typeof item.pageInfo === 'object') candidates.push(item.pageInfo);
  }
  return candidates.find(item => item && (
    item.total !== undefined || item.totalPages !== undefined || item.hasMore !== undefined || item.has_more !== undefined
  )) || {};
}

function isTruthy(value) {
  return value === true || value === 1 || ['1', 'true', 'yes', 'y'].includes(String(value || '').toLowerCase());
}

function normalizeStatus(row) {
  return String(firstValue(row, [
    'payment_status', 'paymentStatus', 'settlement_status', 'settlementStatus',
    'status', 'state'
  ]) || '').trim().toLowerCase();
}

function isExcludedPayment(row) {
  const status = normalizeStatus(row);
  return ['rejected', '拒绝', 'revoked', '撤销', 'cancelled', 'canceled', '已取消', 'closed', '关闭'].some(item => status.indexOf(item) >= 0);
}

function classifyPayment(row, type) {
  if (isExcludedPayment(row)) return null;

  const amount = numberValue(firstValue(row, ['total_amount', 'totalAmount', 'amount', 'payable_amount', 'payableAmount']));
  if (amount <= 0) return null;

  const status = normalizeStatus(row);
  const paidFlag = firstValue(row, ['is_paid', 'isPaid', 'paid', 'payment_completed', 'paymentCompleted']);
  const settlementId = firstValue(row, [
    'settlement_id', 'settlementId', 'settlement_no', 'settlementNo',
    'settlement_order_id', 'settlementOrderId', 'payment_order_id', 'paymentOrderId'
  ]);
  const settlementFlag = firstValue(row, [
    'has_settlement', 'hasSettlement', 'settlement_created', 'settlementCreated',
    'is_settled', 'isSettled'
  ]);

  if (isTruthy(paidFlag) || ['paid', '已支付', '已付款', 'payment_completed', 'completed_paid'].includes(status)) {
    return { key: 'paid', amount };
  }

  const createdByStatus = type === 'expense'
    ? ['approved', 'pending_payment', 'pending_settlement', 'settlement_created', '待结算', '待付款', '应付待结算'].some(item => status.indexOf(item) >= 0)
    : ['settlement_created', 'pending_payment', 'pending_settlement', '待结算', '待付款'].some(item => status.indexOf(item) >= 0);

  if (settlementId || isTruthy(settlementFlag) || createdByStatus) {
    return { key: 'created', amount };
  }

  return { key: 'uncreated', amount };
}

Page({
  data: {
    periods: PERIODS,
    selectedPeriod: 'month',
    selectedDate: '',
    periodLabel: '本月',
    paymentStatuses: PAYMENT_STATUSES,
    selectedPaymentStatus: 'all',
    selectedPaymentLabel: '全部',
    selectedPaymentAmount: '0.00',
    revenue: '0.00',
    grossProfit: '0.00',
    grossMargin: '0.00%',
    compare: '实时数据',
    inventoryTotal: '0.00',
    accountTotal: '0.00',
    pendingPaymentTotal: '0.00',
    inventory: [],
    accounts: [],
    paymentAmounts: [],
    isLoading: false,
    errorMessage: '',
    dataSourceText: '实时数据 · ANY-ERP',
    lastUpdated: '--'
  },

  onLoad() {
    const today = formatDate(new Date());
    this.setData({ selectedDate: today }, () => this.loadDashboard());
  },

  onPullDownRefresh() {
    this.loadDashboard().finally(() => wx.stopPullDownRefresh());
  },

  selectPeriod(event) {
    const selectedPeriod = event.currentTarget.dataset.period;
    this.setData({ selectedPeriod }, () => this.loadDashboard());
  },

  selectDate(event) {
    this.setData({ selectedDate: event.detail.value }, () => this.loadDashboard());
  },

  selectPaymentStatus(event) {
    const selectedPaymentStatus = event.currentTarget.dataset.status;
    this.setData({ selectedPaymentStatus }, () => this.refreshPaymentDisplay());
  },

  getDateRange() {
    const source = String(this.data.selectedDate || formatDate(new Date())).replace(/-/g, '/');
    const selected = new Date(source);
    const safeDate = Number.isNaN(selected.getTime()) ? new Date() : selected;
    const year = safeDate.getFullYear();
    const month = safeDate.getMonth();

    if (this.data.selectedPeriod === 'day') {
      const day = formatDate(safeDate);
      return { startDate: day, endDate: day, granularity: 'day' };
    }
    if (this.data.selectedPeriod === 'year') {
      return {
        startDate: formatDate(new Date(year, 0, 1)),
        endDate: formatDate(new Date(year, 11, 31)),
        granularity: 'month'
      };
    }
    return {
      startDate: formatDate(new Date(year, month, 1)),
      endDate: formatDate(new Date(year, month + 1, 0)),
      granularity: 'day'
    };
  },

  getPeriodLabel() {
    const date = this.data.selectedDate || formatDate(new Date());
    if (this.data.selectedPeriod === 'day') return date;
    if (this.data.selectedPeriod === 'year') return `${date.slice(0, 4)}年`;
    return `${date.slice(0, 7)}月`;
  },

  getScopedStoreId() {
    const userInfo = userUtils.getUserInfo();
    if (!userUtils.isStoreScoped(userInfo)) return '';
    const storeInfo = wx.getStorageSync('tempStoreInfo') || wx.getStorageSync('storeInfo') || {};
    return storeInfo.storeId || storeInfo.store_id || storeInfo.id || storeInfo._id || userInfo.storeId || '';
  },

  ensureDatabaseReady() {
    const app = getApp();
    if (!app || typeof app.activateDatabase !== 'function') return Promise.resolve();
    if (app.globalData && app.globalData.databaseReady) return Promise.resolve();
    return app.activateDatabase().catch(error => {
      console.warn('财务管理页面数据库激活失败，继续尝试业务接口:', error && error.message ? error.message : error);
    });
  },

  async loadDashboard() {
    const range = this.getDateRange();
    this.setData({ isLoading: true, errorMessage: '', periodLabel: this.getPeriodLabel() });

    await this.ensureDatabaseReady();

    const safe = promise => promise.then(data => ({ data })).catch(error => ({ error }));
    const results = await Promise.all([
      safe(this.loadReport(range)),
      safe(this.loadInventory()),
      safe(this.loadOrders(range)),
      safe(this.loadPaymentRecords())
    ]);

    const reportResult = results[0];
    const inventoryResult = results[1];
    const ordersResult = results[2];
    const paymentsResult = results[3];
    const report = reportResult.data || {};
    const orders = ordersResult.data || [];
    const inventory = inventoryResult.data || [];
    const paymentRecords = paymentsResult.data || { purchase: [], expense: [] };

    console.info('[财务管理] 真实数据同步结果', {
      reportLoaded: !!reportResult.data,
      inventoryCount: inventory.length,
      orderCount: orders.length,
      purchaseCount: (paymentRecords.purchase || []).length,
      expenseCount: (paymentRecords.expense || []).length,
      errors: results.filter(item => item.error).map(item => item.error && item.error.message).filter(Boolean)
    });

    const fallbackSummary = this.calculateOrderSummary(orders);
    const reportRevenue = report.revenue !== null && report.revenue !== undefined ? numberValue(report.revenue) : null;
    const reportGrossProfit = report.grossProfit !== null && report.grossProfit !== undefined ? numberValue(report.grossProfit) : null;
    const revenue = reportRevenue > 0 || fallbackSummary.revenue === 0 ? reportRevenue || 0 : fallbackSummary.revenue;
    const grossProfit = reportGrossProfit > 0 || fallbackSummary.grossProfit === 0 ? reportGrossProfit || 0 : fallbackSummary.grossProfit;
    const inventorySummary = this.buildInventorySummary(inventory);
    const accountSummary = this.buildAccountSummary(orders);
    const paymentSummary = this.buildPaymentSummary(paymentRecords);
    const grossMargin = revenue > 0 ? `${(grossProfit / revenue * 100).toFixed(2)}%` : '0.00%';

    const errors = results.filter(item => item.error).map(item => item.error && item.error.message).filter(Boolean);
    this.setData({
      revenue: formatMoney(revenue),
      grossProfit: formatMoney(grossProfit),
      grossMargin,
      compare: report.compare || '实时数据',
      inventoryTotal: numberValue(report.inventoryTotal) > 0 || inventorySummary.total === 0
        ? formatMoney(report.inventoryTotal)
        : formatMoney(inventorySummary.total),
      accountTotal: formatMoney(accountSummary.total),
      pendingPaymentTotal: formatMoney(paymentSummary.uncreated + paymentSummary.created),
      inventory: inventorySummary.rows,
      accounts: accountSummary.rows,
      paymentAmounts: this.formatPaymentAmounts(paymentSummary),
      errorMessage: errors.length === results.length
        ? '真实数据加载失败，请检查登录状态和接口权限'
        : (errors.length ? '部分真实数据未加载，请下拉重试' : ''),
      lastUpdated: this.formatTime(new Date()),
      isLoading: false,
      dataSourceText: errors.length ? '部分数据加载失败，请下拉重试' : '实时数据 · ANY-ERP'
    }, () => this.refreshPaymentDisplay());
  },

  async loadReport(range) {
    const storeId = this.getScopedStoreId();
    try {
      const result = await api.report.dashboardOverview(Object.assign({}, range, { storeId }));
      return this.normalizeReport(result);
    } catch (primaryError) {
      const result = await api.report.sales(Object.assign({}, range, { storeId }));
      return this.normalizeReport(result);
    }
  },

  normalizeReport(result) {
    const source = unwrapReport(result);
    const kpis = source.kpis || source.metrics || {};
    const summary = source.summary || source.total || {};
    const read = (keys, fallback = null) => {
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        const value = kpis[key] !== undefined ? kpis[key] : (source[key] !== undefined ? source[key] : summary[key]);
        if (value !== undefined && value !== null && value !== '') {
          return typeof value === 'object' ? numberValue(firstValue(value, ['value', 'amount', 'total']), fallback) : numberValue(value, fallback);
        }
      }
      return fallback;
    };
    return {
      revenue: read(['salesAmount', 'sales_amount', 'sales', 'totalSales', 'total_sales', 'totalAmount', 'total_amount'], null),
      grossProfit: read(['grossProfit', 'gross_profit'], null),
      inventoryTotal: read(['inventoryAmount', 'inventory_amount'], null),
      compare: firstValue(source, ['periodCompareText', 'period_compare_text']) || '实时数据'
    };
  },

  async loadInventory() {
    const storeId = this.getScopedStoreId();
    return this.loadPages((page, pageSize) => api.inventory.list({ storeId, page, pageSize }), 500, 20);
  },

  async loadOrders(range) {
    const storeId = this.getScopedStoreId();
    return this.loadPages((page, pageSize) => api.order.queryList({
      storeId,
      startDate: range.startDate,
      endDate: range.endDate,
      page,
      pageSize
    }), 200, 25);
  },

  async loadPages(fetchPage, pageSize, maxPages) {
    const rows = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const result = await fetchPage(page, pageSize);
      const pageRows = listOf(result);
      rows.push(...pageRows);
      const pagination = getPagination(result);
      const total = numberValue(pagination.total || result.total, 0);
      const hasMore = pagination.hasMore !== undefined ? pagination.hasMore : pagination.has_more;
      if (!pageRows.length || hasMore === false || (total > 0 && rows.length >= total) || pageRows.length < pageSize) break;
    }
    return rows;
  },

  async loadPaymentRecords() {
    const storeId = this.getScopedStoreId();
    const load = async (request, fallbackRequest) => {
      try {
        return await this.loadPages(request, 100, 20);
      } catch (error) {
        if (!fallbackRequest) throw error;
        return this.loadPages(fallbackRequest, 100, 20);
      }
    };

    const [purchase, expense] = await Promise.all([
      load(
        (page, pageSize) => api.purchase.list({ scope: 'review', storeId, page, pageSize }),
        (page, pageSize) => api.purchase.list({ storeId, page, pageSize })
      ),
      load(
        (page, pageSize) => api.expense.list({ scope: 'review', storeId, page, pageSize }),
        (page, pageSize) => api.expense.list({ storeId, page, pageSize })
      )
    ]);
    return { purchase, expense };
  },

  calculateOrderSummary(orders) {
    return orders.reduce((summary, order) => {
      const status = String(order.status || '').toLowerCase();
      if (['已作废', 'voided', 'cancelled', 'canceled'].includes(status)) return summary;
      const revenue = numberValue(order.actualAmount || order.totalAmount || order.total_amount);
      let grossProfit = numberValue(firstValue(order, ['grossProfit', 'gross_profit']), NaN);
      if (!Number.isFinite(grossProfit)) {
        grossProfit = (order.items || order.goods || []).reduce((total, item) => {
          const quantity = numberValue(item.quantity, 1);
          const salePrice = numberValue(firstValue(item, ['unitPrice', 'unit_price', 'price', 'salePrice']));
          const costPrice = numberValue(firstValue(item, ['costPrice', 'cost_price', 'purchasePrice', 'purchase_price']));
          return total + (salePrice - costPrice) * quantity;
        }, 0);
      }
      return {
        revenue: summary.revenue + revenue,
        grossProfit: summary.grossProfit + grossProfit
      };
    }, { revenue: 0, grossProfit: 0 });
  },

  buildInventorySummary(rows) {
    const categories = [
      { name: '拯救者', quantity: 0, amount: 0 },
      { name: '小新', quantity: 0, amount: 0 },
      { name: 'Yoga', quantity: 0, amount: 0 },
      { name: '其他电脑', quantity: 0, amount: 0 },
      { name: '手机', quantity: 0, amount: 0 },
      { name: '平板', quantity: 0, amount: 0 }
    ];

    rows.forEach(item => {
      const nameText = String([
        item.name, item.productName, item.spec, item.config, item.category, item.productCode, item.pnCode
      ].filter(Boolean).join(' ')).toLowerCase();
      const categoryIndex = this.getInventoryCategoryIndex(nameText);
      if (categoryIndex < 0) return;
      const quantity = numberValue(item.totalStockQty || item.currentStoreStockQty || item.stock || item.quantity || item.normal_qty);
      const costPrice = numberValue(item.costPrice || item.cost_price || item.purchasePrice || item.purchase_price);
      categories[categoryIndex].quantity += quantity;
      categories[categoryIndex].amount += quantity * costPrice;
    });

    return {
      total: categories.reduce((sum, item) => sum + item.amount, 0),
      rows: categories.map(item => ({
        ...item,
        amount: formatMoney(item.amount)
      }))
    };
  },

  getInventoryCategoryIndex(text) {
    if (text.includes('手机') || text.includes('iphone') || text.includes('华为') || text.includes('荣耀') || text.includes('oppo') || text.includes('vivo')) return 4;
    if (text.includes('平板') || text.includes('pad') || text.includes('ipad')) return 5;
    if (text.includes('拯救者')) return 0;
    if (text.includes('小新')) return 1;
    if (text.includes('yoga')) return 2;
    if (text.includes('电脑') || text.includes('笔记本') || text.includes('台式') || text.includes('一体机') ||
      text.includes('thinkpad') || text.includes('thinkbook') || text.includes('matebook') || text.includes('magicbook') ||
      text.includes('rog') || text.includes('alienware') || text.includes('vivobook') || text.includes('laptop') ||
      text.includes('notebook')) return 3;
    return -1;
  },

  buildAccountSummary(orders) {
    const map = {};
    orders.forEach(order => {
      const payments = order.paymentMethods || order.payments || [];
      payments.forEach(payment => {
        const name = String(firstValue(payment, ['type', 'paymentType', 'method', 'payment_method']) || '其他收款方式').trim();
        if (name.indexOf('政策补贴应收') >= 0) return;
        const amount = numberValue(payment.amount);
        if (amount <= 0) return;
        map[name] = (map[name] || 0) + amount;
      });
    });
    const rows = Object.keys(map)
      .map(name => ({ name, amount: map[name] }))
      .sort((a, b) => b.amount - a.amount)
      .map(item => ({ name: item.name, amount: formatMoney(item.amount) }));
    return { total: rows.reduce((sum, item) => sum + numberValue(item.amount), 0), rows };
  },

  buildPaymentSummary(records) {
    const summary = { uncreated: 0, created: 0, paid: 0 };
    ['purchase', 'expense'].forEach(type => {
      (records[type] || []).forEach(row => {
        const item = classifyPayment(row, type);
        if (item) summary[item.key] += item.amount;
      });
    });
    summary.all = summary.uncreated + summary.created + summary.paid;
    return summary;
  },

  formatPaymentAmounts(summary) {
    return this.data.paymentStatuses.map(item => ({
      key: item.key,
      label: item.label,
      amount: formatMoney(summary[item.key] || 0)
    }));
  },

  refreshPaymentDisplay() {
    const selected = (this.data.paymentAmounts || []).find(item => item.key === this.data.selectedPaymentStatus) || {
      label: '全部',
      amount: '0.00'
    };
    this.setData({
      selectedPaymentLabel: selected.label,
      selectedPaymentAmount: selected.amount
    });
  },

  formatTime(date) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
});
