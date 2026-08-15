const api = require('../../utils/api.js');

function emptyDashboard() {
  return {
    meta: { canViewProfit: false, startDate: '', endDate: '' },
    kpis: {
      salesAmount: { value: 0, yoy: null, periodCompare: null },
      grossProfit: { value: null, yoy: null, periodCompare: null },
      grossMargin: { value: null, yoy: null, periodCompare: null },
      orderCount: { value: 0, yoy: null, periodCompare: null },
      averageOrderValue: { value: 0, yoy: null, periodCompare: null },
      inventoryAmount: { value: null, yoy: null, periodCompare: null }
    },
    trend: [],
    storeRanking: [],
    employeeRanking: [],
    productLineAnalysis: [],
    productAnalysis: { salesTop10: [], quantityTop10: [], focusProducts: [] },
    inventory: { inventoryQuantity: 0, skuCount: 0, inventoryAmount: null, ageStructure: [], staleProducts: [] }
  };
}

function firstDefined(source, keys) {
  if (!source) return undefined;
  for (let i = 0; i < keys.length; i++) {
    const value = source[keys[i]];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const normalized = String(value).replace(/[^\d.-]/g, '');
  if (!normalized || normalized === '-' || normalized === '.') return fallback;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : fallback;
}

function unwrapReportData(result) {
  let source = result || {};
  if (source.data && typeof source.data === 'object' && !Array.isArray(source.data)) {
    source = source.data;
  }
  if (source.dashboard && typeof source.dashboard === 'object') {
    source = source.dashboard;
  }
  return source;
}

function normalizeMetric(raw, fallback = 0) {
  if (raw && typeof raw === 'object') {
    const value = firstDefined(raw, ['value', 'amount', 'total', 'count', 'salesAmount', 'sales_amount', 'orderCount', 'order_count']);
    return Object.assign({}, raw, { value: toNumber(value, fallback) });
  }
  return { value: toNumber(raw, fallback), yoy: null, periodCompare: null };
}

function normalizeDashboard(result) {
  const source = unwrapReportData(result);
  const summary = source.summary || source.total || {};
  const metrics = source.kpis || source.metrics || {};
  const metric = (keys, fallbackKeys, fallback = 0) => {
    const raw = firstDefined(metrics, keys);
    const sourceValue = raw === undefined ? firstDefined(source, keys) : raw;
    const fallbackValue = sourceValue === undefined
      ? (firstDefined(summary, fallbackKeys) !== undefined ? firstDefined(summary, fallbackKeys) : firstDefined(source, fallbackKeys))
      : sourceValue;
    return normalizeMetric(fallbackValue, fallback);
  };

  const rows = (keys) => {
    const value = firstDefined(source, keys);
    return Array.isArray(value) ? value : [];
  };

  const dashboard = Object.assign({}, source, {
    meta: Object.assign({}, source.meta || {}, {
      startDate: firstDefined(source.meta, ['startDate', 'start_date']) || source.startDate || '',
      endDate: firstDefined(source.meta, ['endDate', 'end_date']) || source.endDate || ''
    }),
    kpis: {
      salesAmount: metric(['salesAmount', 'sales_amount', 'sales'], ['totalSales', 'total_sales', 'totalAmount', 'total_amount', 'salesAmount', 'sales_amount']),
      grossProfit: metric(['grossProfit', 'gross_profit'], ['grossProfit', 'gross_profit'], null),
      grossMargin: metric(['grossMargin', 'gross_margin'], ['grossMargin', 'gross_margin'], null),
      orderCount: metric(['orderCount', 'order_count', 'orders'], ['totalOrders', 'total_orders', 'orderCount', 'order_count'], 0),
      averageOrderValue: metric(['averageOrderValue', 'average_order_value', '客单价'], ['averageOrderValue', 'average_order_value'], 0),
      inventoryAmount: metric(['inventoryAmount', 'inventory_amount'], ['inventoryAmount', 'inventory_amount'], null)
    },
    trend: rows(['trend', 'salesTrend', 'sales_trend', 'statsByDate', 'stats_by_date']),
    storeRanking: rows(['storeRanking', 'store_ranking', 'stores', 'statsByStore', 'stats_by_store']),
    employeeRanking: rows(['employeeRanking', 'employee_ranking', 'employees', 'statsByEmployee', 'stats_by_employee']),
    productLineAnalysis: rows(['productLineAnalysis', 'product_line_analysis', 'productLines', 'product_lines', 'statsByCategory', 'stats_by_category'])
  });

  const productAnalysis = source.productAnalysis || source.product_analysis || {};
  dashboard.productAnalysis = Object.assign({}, emptyDashboard().productAnalysis, productAnalysis, {
    salesTop10: Array.isArray(productAnalysis.salesTop10) ? productAnalysis.salesTop10 : (productAnalysis.sales_top10 || []),
    quantityTop10: Array.isArray(productAnalysis.quantityTop10) ? productAnalysis.quantityTop10 : (productAnalysis.quantity_top10 || []),
    focusProducts: Array.isArray(productAnalysis.focusProducts) ? productAnalysis.focusProducts : (productAnalysis.focus_products || [])
  });
    dashboard.inventory = Object.assign({}, emptyDashboard().inventory, source.inventory || {}, {
    inventoryQuantity: normalizeRowNumber(source.inventory || {}, ['inventoryQuantity', 'inventory_quantity', 'quantity']),
    skuCount: normalizeRowNumber(source.inventory || {}, ['skuCount', 'sku_count', 'sku']),
    ageStructure: (source.inventory && (source.inventory.ageStructure || source.inventory.age_structure)) || []
  });
  return dashboard;
}

function formatMoneyText(value) {
  if (value === null || value === undefined || value === '') return '--';
  return toNumber(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatCompactMoneyText(value) {
  return formatMoneyText(value);
}

function formatNumberText(value) {
  return toNumber(value).toLocaleString('zh-CN');
}

function formatPercentText(value) {
  if (value === null || value === undefined || value === '') return '--';
  return `${toNumber(value).toFixed(2)}%`;
}

function formatCompareText(value) {
  if (value === null || value === undefined || value === '') return '暂无对比';
  const number = toNumber(value);
  return `${number >= 0 ? '↑' : '↓'} ${Math.abs(number).toFixed(1)}%`;
}

function normalizeRowNumber(row, keys) {
  return toNumber(firstDefined(row, keys), 0);
}

Page({
  data: {
    startDate: '',
    endDate: '',
    rangeType: 'month',
    granularity: 'day',
    activeSection: 'overview',
    isLoading: false,
    errorMessage: '',
    filters: {
      stores: [{ storeId: '', name: '全部门店' }],
      employees: [{ staffId: '', name: '全部员工' }],
      productLines: [{ id: '', name: '全部品类' }]
    },
    storePickerIndex: 0,
    employeePickerIndex: 0,
    productLinePickerIndex: 0,
    selectedStoreId: '',
    selectedEmployeeId: '',
    selectedProductLine: '',
    dashboard: emptyDashboard(),
    maxStoreSales: 1,
    maxEmployeeSales: 1,
    maxProductLineSales: 1,
    maxInventoryQuantity: 1
  },

  onLoad() {
    const todayDate = new Date();
    const today = this.formatDate(todayDate);
    const monthStart = this.formatDate(new Date(todayDate.getFullYear(), todayDate.getMonth(), 1));
    this.setData({ startDate: monthStart, endDate: today, rangeType: 'month' });
    this.loadFilters().finally(() => this.loadOverview());
  },

  onPullDownRefresh() {
    this.loadOverview().finally(() => wx.stopPullDownRefresh());
  },

  setRange(e) {
    const type = e.currentTarget.dataset.type;
    const today = new Date();
    let start = new Date(today);
    let granularity = 'day';
    if (type === 'week') {
      const weekday = today.getDay() || 7;
      start.setDate(today.getDate() - weekday + 1);
    } else if (type === 'month') {
      start = new Date(today.getFullYear(), today.getMonth(), 1);
      granularity = 'day';
    }
    this.setData({
      rangeType: type,
      startDate: this.formatDate(start),
      endDate: this.formatDate(today),
      granularity
    });
    this.loadOverview();
  },

  onStartDateChange(e) {
    const startDate = e.detail.value;
    this.setData({
      startDate,
      endDate: startDate > this.data.endDate ? startDate : this.data.endDate,
      rangeType: 'custom'
    });
    this.loadOverview();
  },

  onEndDateChange(e) {
    const endDate = e.detail.value;
    this.setData({
      endDate,
      startDate: endDate < this.data.startDate ? endDate : this.data.startDate,
      rangeType: 'custom'
    });
    this.loadOverview();
  },

  async loadFilters() {
    try {
      const result = await api.report.dashboardFilters();
      const stores = (result && result.stores) || [];
      const employees = (result && result.employees) || [];
      const productLines = (result && result.productLines) || [];
      this.setData({
        'filters.stores': [{ storeId: '', name: '全部门店' }].concat(stores),
        'filters.employees': [{ staffId: '', name: '全部员工' }].concat(employees),
        'filters.productLines': [{ id: '', name: '全部品类' }].concat(productLines.map(name => ({ id: name, name })))
      });
    } catch (error) {
      console.warn('经营报表筛选项加载失败', error);
    }
  },

  async loadOverview() {
    if (!this.data.startDate || !this.data.endDate) return;
    this.setData({ isLoading: true, errorMessage: '' });
    try {
      const result = await api.report.dashboardOverview({
        startDate: this.data.startDate,
        endDate: this.data.endDate,
        granularity: this.data.granularity,
        storeId: this.data.selectedStoreId,
        employeeId: this.data.selectedEmployeeId,
        productLine: this.data.selectedProductLine
      });
      const source = unwrapReportData(result);
      if (this.hasDashboardRows(source)) {
        this.applyDashboard(source);
      } else {
        // 兼容已部署但尚未发布经营看板 SQL 的旧接口，至少展示现有销售统计表数据。
        await this.loadLegacySalesOverview();
      }
    } catch (error) {
      console.error('经营报表加载失败', error);
      try {
        await this.loadLegacySalesOverview();
      } catch (fallbackError) {
        console.error('旧版销售统计加载失败', fallbackError);
        this.setData({ errorMessage: error.message || '报表加载失败' });
      }
    } finally {
      this.setData({ isLoading: false });
    }
  },

  hasDashboardRows(result) {
    if (!result) return false;
    const kpis = result.kpis || {};
    return Boolean(
      Object.keys(kpis).length ||
      firstDefined(result, ['salesAmount', 'sales_amount', 'totalSales', 'total_sales', 'orderCount', 'order_count', 'totalOrders', 'total_orders']) !== undefined ||
      (result.trend && result.trend.length) ||
      (result.storeRanking && result.storeRanking.length) ||
      (result.employeeRanking && result.employeeRanking.length) ||
      (result.productLineAnalysis && result.productLineAnalysis.length) ||
      Number(kpis.salesAmount && kpis.salesAmount.value) > 0 ||
      Number(kpis.orderCount && kpis.orderCount.value) > 0
    );
  },

  async loadLegacySalesOverview() {
    const result = unwrapReportData(await api.report.sales({
      startDate: this.data.startDate,
      endDate: this.data.endDate,
      storeId: this.data.selectedStoreId
    }));
    const summary = result && (result.summary || result.total) || {};
    const stores = result && (result.statsByStore || result.stats_by_store || result.storeRanking || []) || [];
    const categories = result && (result.statsByCategory || result.stats_by_category || result.productLineAnalysis || []) || [];
    const dates = result && (result.statsByDate || result.stats_by_date || result.trend || []) || [];
    const totalSales = normalizeRowNumber(summary, ['totalSales', 'total_sales', 'totalAmount', 'total_amount', 'salesAmount', 'sales_amount']) || normalizeRowNumber(result, ['totalSales', 'total_sales', 'totalAmount', 'total_amount', 'salesAmount', 'sales_amount']) || stores.reduce((sum, row) => sum + normalizeRowNumber(row, ['totalAmount', 'total_amount', 'salesAmount', 'sales_amount', 'amount']), 0);
    const totalOrders = normalizeRowNumber(summary, ['totalOrders', 'total_orders', 'orderCount', 'order_count']) || normalizeRowNumber(result, ['totalOrders', 'total_orders', 'orderCount', 'order_count']) || dates.reduce((sum, row) => sum + normalizeRowNumber(row, ['orderCount', 'order_count', 'totalOrders', 'total_orders', 'count']), 0);
    const legacy = emptyDashboard();
    legacy.meta = {
      source: 'legacy_sales_report',
      startDate: this.data.startDate,
      endDate: this.data.endDate,
      canViewProfit: true
    };
    legacy.kpis.salesAmount = { value: totalSales, yoy: null, periodCompare: null };
    legacy.kpis.orderCount = { value: totalOrders, yoy: null, periodCompare: null };
    legacy.kpis.averageOrderValue = { value: totalOrders ? totalSales / totalOrders : 0, yoy: null, periodCompare: null };
    legacy.trend = dates.map(row => ({
      bucket: row.date || row.bucket || row.day || row.date_key || '',
      salesAmount: normalizeRowNumber(row, ['totalAmount', 'total_amount', 'salesAmount', 'sales_amount', 'amount']),
      orderCount: normalizeRowNumber(row, ['orderCount', 'order_count', 'totalOrders', 'total_orders', 'count'])
    }));
    legacy.storeRanking = stores.map(row => ({
      storeId: row.store_id || row.storeId || row.id || '',
      storeName: row.storeName || row.store_name || row['Store.name'] || (row.Store && row.Store.name) || '未命名门店',
      salesAmount: normalizeRowNumber(row, ['totalAmount', 'total_amount', 'salesAmount', 'sales_amount', 'amount']),
      orderCount: normalizeRowNumber(row, ['orderCount', 'order_count', 'totalOrders', 'total_orders', 'count'])
    }));
    legacy.productLineAnalysis = categories.map(row => ({
      productLine: row.category || row.productLine || row.product_line || '未分类',
      salesAmount: normalizeRowNumber(row, ['totalAmount', 'total_amount', 'salesAmount', 'sales_amount', 'amount'])
    }));
    this.applyDashboard(legacy);
  },

  applyDashboard(source) {
    const dashboard = normalizeDashboard(source);
    dashboard.meta = Object.assign(emptyDashboard().meta, dashboard.meta || {});

    dashboard.storeRanking = (dashboard.storeRanking || []).map(row => Object.assign({}, row, {
      storeId: row.storeId || row.store_id || row.id || '',
      storeName: row.storeName || row.store_name || row.name || '未命名门店',
      salesAmount: normalizeRowNumber(row, ['salesAmount', 'sales_amount', 'totalAmount', 'total_amount', 'amount']),
      orderCount: normalizeRowNumber(row, ['orderCount', 'order_count', 'totalOrders', 'total_orders', 'count'])
    }));
    dashboard.employeeRanking = (dashboard.employeeRanking || []).map(row => Object.assign({}, row, {
      employeeName: row.employeeName || row.employee_name || row.name || '未命名员工',
      salesAmount: normalizeRowNumber(row, ['salesAmount', 'sales_amount', 'totalAmount', 'total_amount', 'amount']),
      participatedOrderCount: normalizeRowNumber(row, ['participatedOrderCount', 'participated_order_count', 'orderCount', 'order_count', 'totalOrders', 'total_orders', 'count'])
    }));
    dashboard.productLineAnalysis = (dashboard.productLineAnalysis || []).map(row => Object.assign({}, row, {
      productLine: row.productLine || row.product_line || row.category || row.name || '未分类',
      salesAmount: normalizeRowNumber(row, ['salesAmount', 'sales_amount', 'totalAmount', 'total_amount', 'amount'])
    }));

    Object.keys(dashboard.kpis).forEach(key => {
      const metric = dashboard.kpis[key] || {};
      metric.display = key === 'orderCount' ? formatNumberText(metric.value) : (key === 'grossMargin' ? formatPercentText(metric.value) : formatCompactMoneyText(metric.value));
      metric.compareDisplay = formatCompareText(metric.periodCompare);
      dashboard.kpis[key] = metric;
    });

    const storeMax = Math.max.apply(null, (dashboard.storeRanking || []).map(row => Number(row.salesAmount || 0)).concat([1]));
    const employeeMax = Math.max.apply(null, (dashboard.employeeRanking || []).map(row => Number(row.salesAmount || 0)).concat([1]));
    const productLineMax = Math.max.apply(null, (dashboard.productLineAnalysis || []).map(row => Number(row.salesAmount || 0)).concat([1]));
    const inventoryMax = Math.max.apply(null, (dashboard.inventory.ageStructure || []).map(row => Number(row.quantity || 0)).concat([1]));

    dashboard.storeRanking = (dashboard.storeRanking || []).map((row, index) => Object.assign({}, row, {
      rank: index + 1,
      barWidth: `${Math.max(2, Number(row.salesAmount || 0) / storeMax * 100)}%`
    }));
    dashboard.employeeRanking = (dashboard.employeeRanking || []).map((row, index) => Object.assign({}, row, {
      rank: index + 1,
      barWidth: `${Math.max(2, Number(row.salesAmount || 0) / employeeMax * 100)}%`
    }));
    dashboard.productLineAnalysis = (dashboard.productLineAnalysis || []).map(row => Object.assign({}, row, {
      barWidth: `${Math.max(2, Number(row.salesAmount || 0) / productLineMax * 100)}%`
    }));
    dashboard.inventory.ageStructure = (dashboard.inventory.ageStructure || []).map(row => Object.assign({}, row, {
      barWidth: `${Math.max(2, Number(row.quantity || 0) / inventoryMax * 100)}%`
    }));

    if (!dashboard.kpis.averageOrderValue.value && dashboard.kpis.orderCount.value) {
      dashboard.kpis.averageOrderValue.value = dashboard.kpis.salesAmount.value / dashboard.kpis.orderCount.value;
      dashboard.kpis.averageOrderValue.display = formatCompactMoneyText(dashboard.kpis.averageOrderValue.value);
    }
    dashboard.kpis.inventoryAmount.display = formatCompactMoneyText(dashboard.kpis.inventoryAmount.value);
    dashboard.inventory.inventoryQuantityDisplay = formatNumberText(dashboard.inventory.inventoryQuantity);
    dashboard.inventory.skuCountDisplay = formatNumberText(dashboard.inventory.skuCount);

    dashboard.trend = (dashboard.trend || []).map(row => {
      const salesAmount = normalizeRowNumber(row, ['salesAmount', 'sales_amount', 'totalAmount', 'total_amount', 'amount']);
      return Object.assign({}, row, {
        salesAmount,
        amountDisplay: formatCompactMoneyText(salesAmount),
        barWidth: `${dashboard.kpis.salesAmount.value > 0 ? Math.min(100, salesAmount / dashboard.kpis.salesAmount.value * 100) : 0}%`
      });
    });
    dashboard.storeRanking = dashboard.storeRanking.map(row => Object.assign({}, row, {
      amountDisplay: formatCompactMoneyText(row.salesAmount),
      grossProfitDisplay: formatCompactMoneyText(row.grossProfit)
    }));
    dashboard.employeeRanking = dashboard.employeeRanking.map(row => Object.assign({}, row, {
      amountDisplay: formatCompactMoneyText(row.salesAmount),
      grossProfitDisplay: formatCompactMoneyText(row.grossProfit)
    }));
    dashboard.productLineAnalysis = dashboard.productLineAnalysis.map(row => Object.assign({}, row, {
      amountDisplay: formatCompactMoneyText(row.salesAmount)
    }));
    dashboard.productAnalysis.salesTop10 = (dashboard.productAnalysis.salesTop10 || []).map(row => {
      const salesAmount = normalizeRowNumber(row, ['salesAmount', 'sales_amount', 'totalAmount', 'total_amount', 'amount']);
      return Object.assign({}, row, { salesAmount, amountDisplay: formatCompactMoneyText(salesAmount) });
    });
    dashboard.productAnalysis.focusProducts = (dashboard.productAnalysis.focusProducts || []).map(row => {
      const salesAmount = normalizeRowNumber(row, ['salesAmount', 'sales_amount', 'totalAmount', 'total_amount', 'amount']);
      return Object.assign({}, row, { salesAmount, amountDisplay: formatCompactMoneyText(salesAmount) });
    });

    this.setData({
      dashboard,
      maxStoreSales: storeMax,
      maxEmployeeSales: employeeMax,
      maxProductLineSales: productLineMax,
      maxInventoryQuantity: inventoryMax
    });
  },

  onStoreChange(e) {
    const index = Number(e.detail.value);
    const item = this.data.filters.stores[index] || {};
    this.setData({ storePickerIndex: index, selectedStoreId: item.storeId || '' });
    this.loadOverview();
  },

  onEmployeeChange(e) {
    const index = Number(e.detail.value);
    const item = this.data.filters.employees[index] || {};
    this.setData({ employeePickerIndex: index, selectedEmployeeId: item.staffId || '' });
    this.loadOverview();
  },

  onProductLineChange(e) {
    const index = Number(e.detail.value);
    const item = this.data.filters.productLines[index] || {};
    this.setData({ productLinePickerIndex: index, selectedProductLine: item.id || '' });
    this.loadOverview();
  },

  switchSection(e) {
    this.setData({ activeSection: e.currentTarget.dataset.section });
  },

  clearFilters() {
    this.setData({
      storePickerIndex: 0,
      employeePickerIndex: 0,
      productLinePickerIndex: 0,
      selectedStoreId: '',
      selectedEmployeeId: '',
      selectedProductLine: ''
    });
    this.loadOverview();
  },

  openInventoryReport() {
    wx.navigateTo({ url: '/pages/inventory-query/inventory-query' });
  },

  formatDate(date) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  },

  formatMoney(value) {
    if (value === null || value === undefined || value === '') return '--';
    const amount = Number(value || 0);
    return amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },

  formatCompactMoney(value) {
    return this.formatMoney(value);
  },

  formatNumber(value) {
    return Number(value || 0).toLocaleString('zh-CN');
  },

  formatPercent(value) {
    if (value === null || value === undefined) return '--';
    return `${Number(value || 0).toFixed(2)}%`;
  },

  formatCompare(value) {
    if (value === null || value === undefined) return '暂无对比';
    return `${Number(value) >= 0 ? '↑' : '↓'} ${Math.abs(Number(value)).toFixed(1)}%`;
  }
});
