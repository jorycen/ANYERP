const api = require('../../utils/api.js');
const userUtils = require('../profile/user-utils.js');

const CATEGORY_ORDER = [
  { key: 'computer', name: '电脑' },
  { key: 'phone', name: '手机' },
  { key: 'tablet', name: '平板' },
  { key: 'accessory', name: '配件' },
  { key: 'other', name: '其他' }
];

const CATEGORY_KEYWORDS = {
  computer: [
    '电脑', '笔记本', '台式', '一体机', '主机', '拯救者', 'thinkpad',
    'thinkbook', 'yoga', '小新', 'legion', 'ideapad', '昭阳', '工作站'
  ],
  phone: [
    '手机', 'iphone', 'moto', 'motorola', 'edge', 'razr', '拯救者电竞手机'
  ],
  tablet: [
    '平板', 'tablet', 'ipad', '小新pad', 'yoga pad', '拯救者平板'
  ],
  accessory: [
    '配件', '鼠标', '键盘', '手柄', '支架', '摄像头', '保护', '贴膜',
    '充电', '耳机', '数据线', 'u盘', '杯', '包', '硬盘', '打印机',
    '内存', '膜', '电源', '适配器', '拓展坞'
  ]
};

const PRODUCT_TYPE_OPTIONS = [
  { value: 'computer', label: '电脑' },
  { value: 'phone', label: '手机' },
  { value: 'tablet', label: '平板' }
];

const MODEL_FILTER_OPTIONS = [
  { value: 'focus', label: '重点机型' },
  { value: 'special', label: '特价机型' },
  { value: 'hot7', label: '热卖机型（近7天）' },
  { value: 'highMargin7', label: '高毛利机型（近7天）' }
];

Page({
  data: {
    keyword: '',
    storeId: '',
    storeName: '',
    loading: false,
    refreshing: false,
    hasQueried: false,
    isSearchMode: false,
    resultTitle: '请输入条件查询',
    groupedResults: [],
    productTypeOptions: PRODUCT_TYPE_OPTIONS,
    modelFilterOptions: MODEL_FILTER_OPTIONS,
    productType: '',
    modelFilter: '',
    modelFilterPaged: false,
    modelPage: 1,
    modelTotal: 0,
    modelHasMore: false,
    modelLoadingMore: false,
    modelRows: [],
    orderDialogVisible: false,
    orderDialogLoading: false,
    orderDialogProductName: '',
    orderDialogOrders: [],
    snDialogVisible: false,
    snDialogLoading: false,
    snDialogProductName: '',
    snDialogRows: [],
    specialTableRows: []
  },

  onLoad() {
    const storeInfo = wx.getStorageSync('tempStoreInfo') || wx.getStorageSync('storeInfo') || {};
    const userInfo = userUtils.getUserInfo() || wx.getStorageSync('userInfo') || {};
    const storeScoped = userUtils.isStoreScoped(userInfo);
    const storeId = storeScoped ? (storeInfo.storeId || storeInfo.store_id || storeInfo.id || storeInfo._id || userInfo.storeId || '') : '';
    const storeName = storeScoped
      ? (storeInfo.storeName || storeInfo.store_name || storeInfo.name || userInfo.storeName || '')
      : '全部已分配门店';

    this.setData({ storeId, storeName });
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value });
  },

  onSearchConfirm() {
    this.searchInventory();
  },

  onProductTypeTap(e) {
    const productType = e.currentTarget.dataset.value || '';
    const nextProductType = this.data.productType === productType ? '' : productType;
    this.setData({
      productType: nextProductType,
      modelFilter: nextProductType ? this.data.modelFilter : '',
      modelFilterPaged: nextProductType && this.isPagedModelFilter(this.data.modelFilter),
      modelPage: 1,
      modelTotal: 0,
      modelHasMore: false,
      modelRows: []
    }, () => {
      if (nextProductType) this.queryInventoryList();
      else this.clearQueryResults();
    });
  },

  onModelFilterTap(e) {
    if (!this.data.productType) return;
    const modelFilter = e.currentTarget.dataset.value || '';
    const nextModelFilter = this.data.modelFilter === modelFilter ? '' : modelFilter;
    this.setData({
      modelFilter: nextModelFilter,
      modelFilterPaged: this.isPagedModelFilter(nextModelFilter),
      modelPage: 1,
      modelTotal: 0,
      modelHasMore: false,
      modelRows: []
    }, () => this.queryInventoryList());
  },

  isPagedModelFilter(modelFilter) {
    return modelFilter === 'hot7' || modelFilter === 'highMargin7';
  },

  clearQueryResults() {
    this.setData({
      hasQueried: false,
      loading: false,
      groupedResults: [],
      specialTableRows: [],
      modelRows: [],
      modelPage: 1,
      modelTotal: 0,
      modelHasMore: false,
      resultTitle: '请输入条件查询'
    });
  },

  viewProductOrders(e) {
    const productId = e.currentTarget.dataset.productId || '';
    const productName = e.currentTarget.dataset.productName || '商品订单';
    if (!productId) {
      wx.showToast({ title: '商品ID缺失', icon: 'none' });
      return;
    }

    this.setData({
      orderDialogVisible: true,
      orderDialogLoading: true,
      orderDialogProductName: productName,
      orderDialogOrders: []
    });
    api.inventory.productOrders(productId)
      .then(res => {
        const orderRows = Array.isArray(res.data)
          ? res.data
          : (Array.isArray(res.orders) ? res.orders : []);
        const orders = orderRows.map(order => ({
          ...order,
          createTimeText: this.formatOrderTime(order.createTime),
          salesAmountText: Number(order.salesAmount || 0).toFixed(2),
          grossProfitText: Number(order.grossProfit || 0).toFixed(2)
        }));
        this.setData({
          orderDialogProductName: res.product?.productName || productName,
          orderDialogOrders: orders
        });
      })
      .catch(err => {
        console.error('查询商品订单失败:', err);
        wx.showToast({ title: err.message || '查询订单失败', icon: 'none' });
        this.setData({ orderDialogVisible: false });
      })
      .finally(() => {
        this.setData({ orderDialogLoading: false });
      });
  },

  closeProductOrders() {
    this.setData({ orderDialogVisible: false });
  },

  viewProductSns(e) {
    const productId = e.currentTarget.dataset.productId || '';
    const productName = e.currentTarget.dataset.productName || '商品 SN';
    if (!productId) {
      wx.showToast({ title: '商品ID缺失', icon: 'none' });
      return;
    }

    this.setData({
      snDialogVisible: true,
      snDialogLoading: true,
      snDialogProductName: productName,
      snDialogRows: []
    });

    api.inventory.getProductSns(productId)
      .then(res => {
        const rows = Array.isArray(res.data) ? res.data : [];
        this.setData({
          snDialogRows: rows.map(row => this.formatSnRow(row)),
          snDialogProductName: productName
        });
      })
      .catch(err => {
        console.error('查询商品SN失败:', err);
        wx.showToast({ title: err.message || '查询SN失败', icon: 'none' });
        this.setData({ snDialogVisible: false });
      })
      .finally(() => {
        this.setData({ snDialogLoading: false });
      });
  },

  closeProductSns() {
    this.setData({ snDialogVisible: false });
  },

  formatSnRow(row = {}) {
    const statusTime = row.statusChangeTime || row.status_change_time || row.updateTime || row.update_time || '';
    const inboundTime = row.inboundTime || row.inbound_time || '';
    const rawStockAgeDays = row.stockAgeDays !== undefined ? row.stockAgeDays : row.stock_age_days;
    const stockAgeDays = rawStockAgeDays !== undefined && rawStockAgeDays !== null && rawStockAgeDays !== ''
      ? Number(rawStockAgeDays)
      : null;
    return {
      snCode: row.snCode || row.sn_code || '未知SN',
      pnCode: row.pnCode || row.pn_code || '',
      storeName: row.storeName || row.store_name || '未知门店',
      locationName: row.locationName || row.location_name || '未指定库位',
      statusLabel: row.statusLabel || row.status_label || row.statusText || row.status || '未知状态',
      statusTimeText: this.formatOrderTime(statusTime),
      statusAgeText: this.formatElapsed(statusTime),
      inboundTimeText: this.formatOrderTime(inboundTime),
      stockAgeText: stockAgeDays === null ? this.formatElapsed(inboundTime) : `${Math.max(0, stockAgeDays)}天`
    };
  },

  formatElapsed(value) {
    if (!value) return '时间未知';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '时间未知';
    const diff = Math.max(0, Date.now() - date.getTime());
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes}分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}天前`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}个月前`;
    return `${Math.floor(months / 12)}年前`;
  },

  stopOrderDialogTap() {},

  formatOrderTime(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const pad = number => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  },

  getInventoryListParams(page) {
    const pagedModelFilter = this.isPagedModelFilter(this.data.modelFilter);
    const params = {
      storeId: this.data.storeId,
      page: pagedModelFilter ? (page || this.data.modelPage || 1) : 1,
      pageSize: pagedModelFilter ? 10 : 500
    };
    const keyword = String(this.data.keyword || '').trim();
    if (keyword) params.keyword = keyword;
    if (this.data.productType) params.productType = this.data.productType;
    if (this.data.modelFilter) params.modelFilter = this.data.modelFilter;
    return params;
  },

  queryInventoryList() {
    const keyword = String(this.data.keyword || '').trim();
    const pagedModelFilter = this.isPagedModelFilter(this.data.modelFilter);
    const page = pagedModelFilter ? (this.data.modelPage || 1) : 1;
    this.setData({
      loading: true,
      modelLoadingMore: pagedModelFilter && page > 1,
      isSearchMode: Boolean(keyword),
      resultTitle: keyword ? '搜索结果' : '库存筛选'
    });

    const params = this.getInventoryListParams(page);
    const inventoryRequest = api.inventory.list(params);
    const specialRequest = this.data.modelFilter === 'special'
      ? api.inventory.getSnInventoryList({
        storeId: this.data.storeId,
        specialOnly: 1,
        page: 1,
        pageSize: 100
      }).catch(() => ({ data: [] }))
      : Promise.resolve({ data: [] });

    return Promise.all([inventoryRequest, specialRequest])
      .then(([res, specialRes]) => {
        const inventoryRows = (res.data || [])
          .map(item => this.formatInventoryItem(item, false))
          .filter(item => item.currentStoreStockQty > 0);
        const specialRows = this.data.modelFilter === 'special'
          ? this.buildSpecialInventoryRows(specialRes.data || [])
          : [];
        const specialTableRows = this.data.modelFilter === 'special'
          ? this.formatSpecialTableRows(specialRes.data || [])
          : [];
        const pageRows = specialRows.length ? specialRows : inventoryRows;
        const rows = pagedModelFilter && page > 1
          ? this.data.modelRows.concat(pageRows)
          : pageRows;
        const pagination = res.pagination || {};
        const total = Number(pagination.total || res.total || rows.length);
        const pageSize = Number(pagination.pageSize || params.pageSize || 10);
        this.setData({
          hasQueried: true,
          specialTableRows,
          modelRows: pagedModelFilter ? rows : [],
          modelTotal: pagedModelFilter ? total : 0,
          modelHasMore: pagedModelFilter ? page * pageSize < total : false,
          modelPage: pagedModelFilter ? page : 1
        });
        this.setGroupedResults(
          rows,
          `${keyword ? '搜索结果' : '库存筛选'} ${this.data.modelFilter === 'special' ? specialTableRows.length : rows.length} 项`,
          specialTableRows
        );
      })
      .catch(err => {
        console.error('加载库存筛选失败:', err);
        wx.showToast({ title: '加载库存筛选失败', icon: 'none' });
      })
      .finally(() => {
        this.setData({ loading: false, modelLoadingMore: false });
      });
  },

  loadMoreModelResults() {
    if (!this.isPagedModelFilter(this.data.modelFilter) || !this.data.modelHasMore || this.data.loading || this.data.modelLoadingMore) return;
    this.setData({ modelPage: (this.data.modelPage || 1) + 1 }, () => this.queryInventoryList());
  },

  refreshDefaultList() {
    this.setData({ refreshing: true });
    const task = this.data.isSearchMode && this.data.keyword.trim()
      ? this.searchInventory()
      : this.loadDefaultInventory();
    Promise.resolve(task).finally(() => {
      this.setData({ refreshing: false });
    });
  },

  loadDefaultInventory() {
    if (this.data.productType || this.data.modelFilter || String(this.data.keyword || '').trim()) {
      return this.queryInventoryList();
    }
    this.clearQueryResults();
    return Promise.resolve();
  },

  searchInventory() {
    const keyword = this.data.keyword.trim();
    if (!keyword) {
      return this.loadDefaultInventory();
    }

    if (this.data.productType || this.data.modelFilter) {
      return this.queryInventoryList();
    }

    const { storeId } = this.data;
    this.setData({ loading: true, isSearchMode: true, resultTitle: '搜索中' });

    const tasks = [
      api.product.search(keyword, { storeId, page: 1, pageSize: 100 }).catch(() => []),
      api.inventory.getGoodsByPN(keyword, storeId).then(item => item ? [item] : []).catch(() => []),
      api.inventory.getGoodsBySN(keyword, storeId).then(item => item ? [item] : []).catch(() => [])
    ];

    return Promise.all(tasks)
      .then(results => {
        const rows = this.mergeInventoryResults([].concat(...results).map(item => this.formatInventoryItem(item, false)));
        this.setData({ hasQueried: true });
        this.setGroupedResults(rows, `搜索结果 ${rows.length} 项`);
      })
      .catch(err => {
        console.error('查询库存失败:', err);
        wx.showToast({ title: '查询失败', icon: 'none' });
      })
      .finally(() => {
        this.setData({ loading: false });
      });
  },

  formatInventoryItem(item, defaultCurrentOnly) {
    const currentQty = Number(item.currentStoreStockQty || item.current_store_stock_qty || item.normal_qty || item.stock || 0);
    const otherQty = Number(item.otherStoreStockQty || item.other_store_stock_qty || 0);
    const totalQty = Number(item.totalStockQty || item.total_stock_qty || item.stock_qty || item.stock || currentQty || 0);
    const standardPrice = Number(item.standardPrice || item.standard_price || item.productStandardPrice || item.product_standard_price || item.price || 0);
    const salePrice = Number(item.retailPrice || item.retail_price || item.salePrice || item.sale_price || item.settlementPrice || item.settlement_price || item.price || standardPrice || 0);
    const pnOptions = item.pnOptions || [];
    const storeStockInfo = item.storeStockInfo || item.store_stock_info || item.otherStoreStockInfo || item.other_store_stock_info || [];
    const spec = item.spec || item.config || [item.brand, item.series, item.model].filter(Boolean).join(' ');
    const currentStoreName = item.currentStoreName || item.current_store_name || this.data.storeName || '当前门店';
    const storeChips = this.formatStoreChips(storeStockInfo, currentStoreName);
    const needSnValue = item.needSn !== undefined ? item.needSn : item.need_sn;
    const otherStoreChips = storeChips.filter(stock => !stock.isCurrent);
    if (!defaultCurrentOnly && otherQty > 0 && otherStoreChips.length === 0) {
      otherStoreChips.push({
        key: 'other-total',
        storeName: '其他门店合计',
        qty: otherQty,
        isCurrent: false
      });
    }

    return {
      uniqueKey: [item.product_id || item.productId || '', item.pnCode || '', item.snCode || item.sn_code || ''].join('|'),
      productId: item.product_id || item.productId || '',
      name: item.name || item.product_name || '未命名商品',
      pnCode: item.pnCode || item.pn_code || pnOptions[0] || '',
      snCode: item.snCode || item.sn_code || '',
      status: item.status || '',
      statusLabel: item.statusLabel || item.status_label || item.statusText || '',
      needSn: needSnValue === true || Number(needSnValue || 0) === 1,
      spec: spec || item.category || '',
      category: item.category || '',
      standardPriceText: standardPrice.toFixed(2),
      salePriceText: salePrice.toFixed(2),
      sales7Qty: Number(item.sales7Qty || item.sales_7_qty || 0),
      sales30Qty: Number(item.sales30Qty || item.sales_30_qty || 0),
      avgGrossProfit7Text: Number(item.avgGrossProfit7 || item.avg_gross_profit_7 || 0).toFixed(2),
      maxGrossProfit7Text: Number(item.maxGrossProfit7 || item.max_gross_profit_7 || 0).toFixed(2),
      currentStoreName,
      currentStoreStockQty: currentQty,
      otherStoreStockQty: defaultCurrentOnly ? 0 : otherQty,
      totalStockQty: defaultCurrentOnly && !item.total_stock_qty ? currentQty : totalQty,
      storeChips,
      otherStoreChips,
      showOtherStockDetail: false,
      categoryKey: this.getCategoryKey(item)
    };
  },

  buildSpecialInventoryRows(rows) {
    const groups = new Map();
    (rows || []).forEach(row => {
      const rawStatus = String(row.status || '').trim().toLowerCase();
      if (rawStatus && rawStatus !== 'in_stock') return;
      const productId = row.productId || row.product_id || row.productCode || row.product_code || row.name || row.productName;
      if (!productId) return;
      const storeId = row.storeId || row.store_id || '';
      const storeName = row.storeName || row.store_name || '未知门店';
      const key = String(productId);
      let group = groups.get(key);
      if (!group) {
        group = {
          product_id: row.productId || row.product_id || '',
          product_code: row.productCode || row.product_code || '',
          product_name: row.productName || row.product_name || row.name || '未命名商品',
          category: row.category || '',
          spec: row.spec || row.config || '',
          pn_code: row.pnCode || row.pn_code || '',
          standard_price: row.unifiedSalePrice || row.unified_sale_price || row.standardPrice || row.standard_price || 0,
          retail_price: row.effectiveSalePrice || row.effective_sale_price || row.retailPrice || row.retail_price || 0,
          need_sn: 1,
          current_store_stock_qty: 0,
          other_store_stock_qty: 0,
          total_stock_qty: 0,
          store_stock_info: [],
          storeMap: new Map()
        };
        groups.set(key, group);
      }
      group.total_stock_qty += 1;
      if (!this.data.storeId || String(storeId) === String(this.data.storeId)) {
        group.current_store_stock_qty += 1;
      } else {
        group.other_store_stock_qty += 1;
      }
      const storeKey = String(storeId || storeName);
      const storeRow = group.storeMap.get(storeKey) || {
        store_id: storeId,
        store_name: storeName,
        normal_qty: 0,
        is_current: !this.data.storeId || String(storeId) === String(this.data.storeId)
      };
      storeRow.normal_qty += 1;
      group.storeMap.set(storeKey, storeRow);
    });

    return Array.from(groups.values())
      .map(group => {
        group.store_stock_info = Array.from(group.storeMap.values());
        delete group.storeMap;
        return this.formatInventoryItem(group, false);
      })
      .filter(item => !this.data.productType || item.categoryKey === this.data.productType)
      .filter(item => item.currentStoreStockQty > 0 || !this.data.storeId);
  },

  formatSpecialTableRows(rows) {
    return (rows || [])
      .filter(row => {
        const status = String(row.status || '').trim().toLowerCase();
        return !status || status === 'in_stock';
      })
      .map((row, index) => {
        const rawSpecialPrice = row.specialPrice !== undefined ? row.specialPrice : row.special_price;
        const specialPrice = rawSpecialPrice !== null && rawSpecialPrice !== undefined
          ? Number(rawSpecialPrice || 0)
          : Number(row.effectiveSalePrice || row.effective_sale_price || 0);
        const unifiedPrice = Number(row.unifiedSalePrice || row.unified_sale_price || row.standardPrice || row.standard_price || 0);
        return {
          pnCode: row.pnCode || row.pn_code || '无',
          snCode: row.snCode || row.sn_code || '未知SN',
          name: row.productName || row.product_name || row.name || '未命名商品',
          storeName: row.storeName || row.store_name || '未知门店',
          specialPriceText: specialPrice.toFixed(2),
          unifiedPriceText: unifiedPrice.toFixed(2),
          reason: row.specialPriceRemark || row.special_price_remark || row.remark || '未填写',
          stripeClass: index % 2 === 0 ? 'special-row-white' : 'special-row-blue'
        };
      })
      .filter(row => !this.data.productType || this.getCategoryKey({ name: row.name }) === this.data.productType);
  },

  mergeInventoryResults(rows) {
    const map = new Map();
    rows.forEach(item => {
      const key = item.uniqueKey || item.productId || item.name;
      if (!key) return;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, item);
        return;
      }
      existing.currentStoreStockQty = Math.max(existing.currentStoreStockQty || 0, item.currentStoreStockQty || 0);
      existing.otherStoreStockQty = Math.max(existing.otherStoreStockQty || 0, item.otherStoreStockQty || 0);
      existing.totalStockQty = Math.max(existing.totalStockQty || 0, item.totalStockQty || 0);
      existing.sales7Qty = Math.max(existing.sales7Qty || 0, item.sales7Qty || 0);
      existing.sales30Qty = Math.max(existing.sales30Qty || 0, item.sales30Qty || 0);
      if (!existing.pnCode && item.pnCode) existing.pnCode = item.pnCode;
      if (!existing.snCode && item.snCode) existing.snCode = item.snCode;
      existing.needSn = existing.needSn || item.needSn;
      if (!existing.statusLabel && item.statusLabel) existing.statusLabel = item.statusLabel;
      if (!existing.spec && item.spec) existing.spec = item.spec;
      if (existing.standardPriceText === '0.00' && item.standardPriceText !== '0.00') {
        existing.standardPriceText = item.standardPriceText;
      }
      if (existing.salePriceText === '0.00' && item.salePriceText !== '0.00') {
        existing.salePriceText = item.salePriceText;
      }
      if ((!existing.storeChips || existing.storeChips.length === 0) && item.storeChips && item.storeChips.length > 0) {
        existing.storeChips = item.storeChips;
      }
      if ((!existing.otherStoreChips || existing.otherStoreChips.length === 0) && item.otherStoreChips && item.otherStoreChips.length > 0) {
        existing.otherStoreChips = item.otherStoreChips;
      }
    });
    return Array.from(map.values());
  },

  setGroupedResults(rows, title, specialTableRows) {
    const groupedResults = CATEGORY_ORDER
      .map(category => ({
        ...category,
        items: rows
          .filter(item => item.categoryKey === category.key)
          .sort((a, b) => {
            const currentDiff = (b.currentStoreStockQty || 0) - (a.currentStoreStockQty || 0);
            if (currentDiff !== 0) return currentDiff;
            const totalDiff = (b.totalStockQty || 0) - (a.totalStockQty || 0);
            if (totalDiff !== 0) return totalDiff;
            return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN');
          })
      }))
      .filter(group => group.items.length > 0);

    const nextData = {
      groupedResults,
      resultTitle: title
    };
    if (specialTableRows !== undefined) {
      nextData.specialTableRows = specialTableRows;
    } else if (this.data.modelFilter !== 'special') {
      nextData.specialTableRows = [];
    }
    this.setData(nextData);
  },

  getCategoryKey(item) {
    const text = [
      item.category,
      item.name,
      item.product_name,
      item.spec,
      item.config,
      item.brand,
      item.series,
      item.model
    ]
      .map(value => String(value || '').toLowerCase())
      .join(' ');

    for (const key of ['phone', 'tablet', 'computer', 'accessory']) {
      if (CATEGORY_KEYWORDS[key].some(keyword => text.includes(keyword))) {
        return key;
      }
    }
    return 'other';
  },

  formatStoreChips(storeStockInfo, currentStoreName) {
    if (!Array.isArray(storeStockInfo) || storeStockInfo.length === 0) return [];
    return storeStockInfo
      .filter(item => Number(item.normal_qty || 0) > 0)
      .map((item, index) => ({
        key: `${item.store_id || item.store_name || index}`,
        storeName: item.is_current ? (item.store_name || currentStoreName || '当前门店') : (item.store_name || item.store_id || '其他门店'),
        qty: Number(item.normal_qty || 0),
        isCurrent: Boolean(item.is_current)
      }));
  }
});
