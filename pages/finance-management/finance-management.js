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

function unwrapValue(result) {
  let value = result || {};
  for (let index = 0; index < 3; index += 1) {
    if (value && value.data && !Array.isArray(value.data) && typeof value.data === 'object') {
      value = value.data;
      continue;
    }
    break;
  }
  return value || {};
}

Page({
  data: {
    periods: PERIODS,
    selectedPeriod: 'month',
    selectedDate: '',
    periodLabel: '本月',
    regions: [{ regionId: '', label: '全部' }],
    selectedRegionIndex: 0,
    selectedRegionId: '',
    selectedRegionLabel: '全部',
    paymentStatuses: PAYMENT_STATUSES,
    selectedPaymentStatus: 'all',
    selectedPaymentLabel: '全部',
    selectedPaymentAmount: '--',
    revenue: '--',
    grossProfit: '--',
    grossMargin: '--',
    compare: '实时数据',
    inventoryTotal: '--',
    accountTotal: '--',
    pendingPaymentTotal: '--',
    inventory: [],
    selectedInventoryCategory: '',
    accounts: [],
    paymentAmounts: [],
    isLoading: false,
    errorMessage: '',
    dataSourceText: '实时数据 · ANY-ERP',
    lastUpdated: '--'
  },

  onLoad() {
    if (!userUtils.isDistributorAccount(userUtils.getUserInfo())) {
      wx.showToast({ title: '店长及店员不可访问财务管理', icon: 'none' });
      setTimeout(() => wx.reLaunch({ url: '/pages/index/index' }), 350);
      return;
    }
    const today = formatDate(new Date());
    this.setData({ selectedDate: today });
    this.loadRegions();
    this.loadDashboard();
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

  selectRegion(event) {
    const index = Number(event.detail.value) || 0;
    const region = this.data.regions[index] || this.data.regions[0];
    this.setData({
      selectedRegionIndex: index,
      selectedRegionId: region.regionId || '',
      selectedRegionLabel: region.label || '全部'
    }, () => this.loadDashboard());
  },

  selectInventoryCategory(event) {
    const selectedInventoryCategory = event.currentTarget.dataset.key || '';
    this.setData({ selectedInventoryCategory });
  },

  async loadRegions() {
    try {
      const result = await api.store.getRegions();
      const source = Array.isArray(result) ? result : (result && result.data) || [];
      const rows = source.map(item => ({
        regionId: item.region_id || item.regionId || '',
        regionCode: item.region_code || item.regionCode || '',
        label: String(item.name || item.region_name || item.regionName || '').replace('区域', '')
      })).filter(item => item.regionId && (!item.regionCode || ['CD', 'CQ'].includes(String(item.regionCode).toUpperCase())));
      this.setData({ regions: [{ regionId: '', label: '全部' }].concat(rows) });
    } catch (error) {
      console.warn('[财务管理] 区域加载失败:', error && error.message ? error.message : error);
      this.setData({ regions: [{ regionId: '', label: '全部' }] });
    }
  },

  selectPaymentStatus(event) {
    const selectedPaymentStatus = event.currentTarget.dataset.status;
    this.setData({ selectedPaymentStatus }, () => this.refreshPaymentDisplay());
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

  async loadDashboard() {
    this.setData({ isLoading: true, errorMessage: '', periodLabel: this.getPeriodLabel() });
    const storeId = this.getScopedStoreId();
    const result = await api.report.financeOverview({
      periodType: this.data.selectedPeriod,
      date: this.data.selectedDate,
      regionId: this.data.selectedRegionId || '',
      storeId
    }).catch(error => ({ error }));

    if (result.error) {
      this.setData({
        revenue: '--',
        grossProfit: '--',
        grossMargin: '--',
        inventoryTotal: '--',
        accountTotal: '--',
        pendingPaymentTotal: '--',
        inventory: [],
        selectedInventoryCategory: '',
        accounts: [],
        paymentAmounts: this.formatPaymentAmounts(null),
        errorMessage: '真实数据加载失败，请检查登录状态和接口权限',
        lastUpdated: this.formatTime(new Date()),
        isLoading: false,
        dataSourceText: '数据加载失败，请重试'
      }, () => this.refreshPaymentDisplay());
      return;
    }

    const data = unwrapValue(result);
    const inventory = data.inventory || {};
    const accounts = data.accounts || {};
    const payments = data.payments || {};
    const grossProfit = data.grossProfit;
    const inventoryCategories = (inventory.categories || []).map(item => ({
      key: item.key || item.name,
      name: item.name,
      quantity: numberValue(item.quantity),
      amount: formatMoney(item.amount),
      children: (item.children || []).map(child => ({
        key: child.key || child.name,
        name: child.name,
        quantity: numberValue(child.quantity),
        amount: formatMoney(child.amount)
      }))
    }));
    const selectedInventoryCategory = inventoryCategories.some(item => item.key === this.data.selectedInventoryCategory)
      ? this.data.selectedInventoryCategory
      : (inventoryCategories[0] ? inventoryCategories[0].key : '');
    this.setData({
      revenue: data.revenue === null || data.revenue === undefined ? '--' : formatMoney(data.revenue),
      grossProfit: grossProfit === null || grossProfit === undefined ? '--' : formatMoney(grossProfit),
      grossMargin: data.grossMargin === null || data.grossMargin === undefined ? '--' : `${Number(data.grossMargin).toFixed(2)}%`,
      compare: '实时数据 · ANY-ERP',
      inventoryTotal: inventory.totalAmount === null || inventory.totalAmount === undefined ? '--' : formatMoney(inventory.totalAmount),
      accountTotal: accounts.totalAmount === null || accounts.totalAmount === undefined ? '--' : formatMoney(accounts.totalAmount),
      pendingPaymentTotal: formatMoney(Number(payments.uncreated || 0) + Number(payments.created || 0)),
      inventory: inventoryCategories,
      selectedInventoryCategory,
      accounts: (accounts.byType || []).map(item => ({ name: item.name, amount: formatMoney(item.amount) })),
      paymentAmounts: this.formatPaymentAmounts(payments),
      errorMessage: '',
      lastUpdated: this.formatTime(new Date()),
      isLoading: false,
      dataSourceText: '实时数据 · ANY-ERP'
    }, () => this.refreshPaymentDisplay());
  },

  formatPaymentAmounts(summary) {
    const unavailable = !summary;
    return this.data.paymentStatuses.map(item => ({
      key: item.key,
      label: item.label,
      amount: unavailable ? '--' : formatMoney(summary[item.key] || 0)
    }));
  },

  refreshPaymentDisplay() {
    const selected = (this.data.paymentAmounts || []).find(item => item.key === this.data.selectedPaymentStatus) || {
      label: '全部',
      amount: '--'
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
