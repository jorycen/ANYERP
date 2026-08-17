// pages/order-list/order-list.js
const userUtils = require('../profile/user-utils.js');
const api = require('../../utils/api.js');
const { calculateOrderProfit } = require('../../utils/order-profit.js');
const { normalizeOrderItem, normalizeSnCode, normalizeId, isEmptyOrderItem } = require('../../utils/model.js');
require('../../utils/cloud-adapter.js').install();
Page({
  /**
   * 页面的初始数据
   */
  data: {
    orders: [],
    filteredOrders: [],
    searchParams: {
      orderNo: '',
      createUser: '',
      searchDate: '',
      status: '',
      snCode: '',
      pnCode: '',
      invoiceInfo: '',
      resourceType: ''
    },
    searchOrderNo: '', // 订单编号搜索输入
    searchPn: '', // PN码搜索输入
    searchSn: '', // SN码搜索输入
    searchInvoiceInfo: '', // 开票人/开票信息搜索输入
    searchDate: '',
    startDate: '', // 开始日期
    endDate: '', // 结束日期
    isTimeDisabled: false, // 时间选择是否禁用
    dateFilterTouched: false,
    currentDate: '',
    statusOptions: ['全部', '未归档', '已归档', '已作废'],
    statusIndex: 0,
    resourceTypeOptions: ['全部'],
    resourceTypeIndex: 0,
    // 提交人下拉列表
    submitterOptions: ['全部'],
    submitterIndex: 0,
    loading: false,
    canLoadMore: false,
    userInfo: {}, // 当前用户信息
    // 分页相关
    page: 1,
    pageSize: 10,
    total: 0,
    hasMore: false,
    // 金额补录弹窗相关
    showSupplementModal: false,
    currentOrder: {},
    supplementItems: [],
    supplementItemNames: [],
    // 多个补录项目列表
    supplementRecords: [],
    isEditMode: false, // 是否为编辑模式
    // 页面状态
    isFirstLoad: true, // 是否首次加载
    scrollTop: 0, // 滚动位置
    // 提货运费弹窗相关
    showFreightModal: false,
    freightAmount: '',
    // 订单备注弹窗相关
    showRemarkModal: false,
    remarkText: '',
    // 我的导出任务弹窗相关
    showExportTasksModal: false,
    exportTasks: [],
    loadingExportTasks: false,
    showResourceModal: false,
    resourceModalLoading: false,
    resourceModalOrder: {},
    resourceRows: [],
    showGrossProfitModal: false,
    grossProfitModalLoading: false,
    grossProfitModalOrder: {},
    grossProfitDetail: {
      receivableText: '-',
      productPricingText: '-',
      paymentFeeText: '-',
      invoiceText: '-',
      vatText: '-',
      supplementText: '-',
      externalAdjustmentText: '-',
      externalAdjustmentFee: 0,
      grossProfitText: '-',
      grossProfitTone: 'unknown',
      productPricingDetails: [],
      paymentDetails: [],
      supplementDetails: [],
      formula: ''
    }
  },

  // 标记是否从详情页返回
  isFromDetail: false,
  // 当前查看的订单编号
  currentViewOrderNo: '',

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: function (options) {
    if (userUtils.isPurchaseQueryOnly()) {
      wx.reLaunch({ url: '/pages/purchase-application/purchase-application' });
      return;
    }
    // 检查用户授权
    const userInfo = userUtils.getUserInfo();
    if (!userUtils.isAuthorized()) {
      wx.showToast({
        title: '您未授权使用此功能',
        icon: 'none'
      });
      // 返回上一页
      setTimeout(() => {
        wx.navigateBack();
      }, 1500);
      return;
    }
    
    // 设置当前日期（使用本地时间，避免 UTC 时间差问题）
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const currentDate = `${year}-${month}-${day}`;
    
    // 设置默认查询日期为当天
    const defaultStartDate = userUtils.isDistributor() ? '' : currentDate;
    const defaultEndDate = userUtils.isDistributor() ? '' : currentDate;
    const searchParams = this.data.searchParams;
    searchParams.searchDate = defaultStartDate;
    
    this.setData({
      currentDate: currentDate,
      startDate: defaultStartDate,
      endDate: defaultEndDate,
      searchDate: defaultStartDate,
      searchParams: searchParams
    });
    
    // 加载用户信息
    this.loadUserInfo();
    this.loadResourceTypes();
    // 加载订单数据
    this.loadOrders();
  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow: function () {
    // 页面显示时重新加载数据
    this.loadUserInfo();

    if (this.data.isFirstLoad) {
      // 首次加载，加载订单数据
      this.loadOrders();
      this.setData({ isFirstLoad: false });
    } else if (this.isFromDetail && this.currentViewOrderNo) {
      // 从详情页返回，刷新当前订单数据
      this.refreshCurrentOrder();
    } else {
      // 其他情况，重新加载订单数据
      this.loadOrders();
    }
  },

  /**
   * 刷新当前订单数据（从详情页返回时使用）
   */
  refreshCurrentOrder: function () {
    const orderNo = this.currentViewOrderNo;
    if (!orderNo) return;

    // 显示加载中，但不使用 wx.showLoading 避免页面跳动
    this.setData({ loading: true });

    // 使用云函数查询单个订单
    api.order.queryList({ orderNo, page: 1, pageSize: 1 }).then(result => {
      this.setData({ loading: false });

      const updatedOrder = result && result.data && result.data[0]
        ? this.applyLocalOrderOverride(result.data[0])
        : null;
      if (updatedOrder) {

        const actualAmount = this.calculateListActualAmount(updatedOrder);
        const paymentTotal = this.resolveListPaymentTotal(updatedOrder, actualAmount);
        updatedOrder.paymentTotal = paymentTotal.toFixed(2);
        updatedOrder.actualAmount = actualAmount.toFixed(2);

        // 兼容处理：discount (旧) / discountAmount (新)
        let discount = updatedOrder.discount || updatedOrder.discountAmount || 0;
        updatedOrder.discount = parseFloat(discount).toFixed(2);

        // 格式化其他金额字段
        updatedOrder.nationalSubsidy = parseFloat(updatedOrder.nationalSubsidy || 0).toFixed(2);
        updatedOrder.educationSubsidy = parseFloat(updatedOrder.educationSubsidy || 0).toFixed(2);
        updatedOrder.totalAmount = parseFloat(updatedOrder.totalAmount || 0).toFixed(2);

        // 兼容处理：客户来源字段
        updatedOrder.customerSource = updatedOrder.customerSource || updatedOrder.source || '';

        // 兼容处理：将 items 数组映射为 goods 数组（用于页面显示）
        let goods = [];
          if (updatedOrder.items && updatedOrder.items.length > 0) {
            goods = updatedOrder.items.map(item => this.normalizeOrderGoodsItem(item));
          } else if (updatedOrder.goods && updatedOrder.goods.length > 0) {
            goods = updatedOrder.goods.map(item => this.normalizeOrderGoodsItem(item));
          }
        updatedOrder.goods = goods;

        // 更新订单列表中的对应订单
        const orders = this.data.orders.map(order => {
          if (order.orderNo === orderNo) {
            return { ...order, ...updatedOrder };
          }
          return order;
        });

        const filteredOrders = this.data.filteredOrders.map(order => {
          if (order.orderNo === orderNo) {
            return { ...order, ...updatedOrder };
          }
          return order;
        });

        this.setData({
          orders: orders,
          filteredOrders: filteredOrders,
          loading: false
        });

        console.log('订单刷新成功:', updatedOrder);
      } else {
        // 订单未找到，也要关闭加载状态
        this.setData({ loading: false });
      }

      // 重置标记
      this.isFromDetail = false;
      this.currentViewOrderNo = '';
    }).catch(err => {
      this.setData({ loading: false });
      console.error('刷新订单失败:', err);

      // 重置标记
      this.isFromDetail = false;
      this.currentViewOrderNo = '';
    });
  },

  // 页面展示可以保留 name/price 两个显示字段，但订单业务对象只使用
  // productName/unitPrice/itemId/productId/inventoryId/pnCode/snCode 等标准字段。
  normalizeOrderGoodsItem: function (item) {
    const normalized = normalizeOrderItem(item || {});
    return Object.assign({}, normalized, {
      name: normalized.productName,
      price: normalized.unitPrice,
      inventoryStatus: normalized.inventoryStatus || '',
      resourceSummary: item && (item.resourceSummary || item.resource_summary) || normalized.resourceSummary || null,
      selectedResourceTypes: normalized.selectedResourceTypes || []
    });
  },

  /**
   * 查看订单商品当前可用资源。
   * 订单详情接口会返回 resource_summary；旧订单或非 SN 商品则保留本地字段并按 SN 资源接口补查。
   */
  showAvailableResources: function (e) {
    const order = (e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.order) || {};
    this.setData({
      showResourceModal: true,
      resourceModalLoading: true,
      resourceModalOrder: order,
      resourceRows: []
    });

    const loadDetail = () => {
      const orderId = order.orderId || order._id || order.order_id;
      if (orderId) return api.order.getDetails(orderId);
      if (order.orderNo) {
        return api.order.queryList({ orderNo: order.orderNo, page: 1, pageSize: 1 })
          .then(result => {
            const row = result.data && result.data[0];
            if (!row) throw new Error('未找到订单详情');
            return api.order.getDetails(row.orderId || row._id || row.order_id);
          });
      }
      return Promise.resolve(order);
    };

    Promise.all([
      loadDetail().catch(() => order),
      api.purchase.resourceCategories().catch(() => [])
    ]).then(([detail, categoryResult]) => {
      const categories = Array.isArray(categoryResult)
        ? categoryResult
        : (categoryResult && (categoryResult.data || categoryResult.list)) || [];
      const categoryNames = {
        GOV_SUBSIDY: '国补资格',
        EDU_SUBSIDY: '教育优惠资格',
        SALES_RED_PACKET: '销售红包',
        SALES_REPORT: '销售报号资格'
      };
      categories.forEach(category => {
        const code = category.category_code || category.categoryCode || category.code;
        if (code) categoryNames[code] = category.short_name || category.name || code;
      });
      const items = (detail && (detail.goods || detail.items || detail.OrderItems)) || order.goods || order.items || [];
      const normalizedItems = items.length ? items : [{ productName: '订单商品', quantity: 1 }];
      const rightsPromises = normalizedItems.map(item => {
        const normalized = this.normalizeOrderGoodsItem(item);
        const summary = normalized.resourceSummary || {};
        if (summary.rights || normalized.resourceRights && normalized.resourceRights.length || (!normalized.inventoryId && !normalized.snCode && !normalized.productId)) {
          return Promise.resolve({ item: normalized, summary });
        }
        const rightsRequest = normalized.inventoryId
          ? api.inventory.snResourceRights(normalized.inventoryId)
          : api.inventory.resourceRights({
            snCode: normalized.snCode,
            productId: normalized.productId,
            status: 'AVAILABLE',
            page: 1,
            pageSize: 100
          }).then(result => ({ rights: result.data || [] }));
        return rightsRequest
          .then(snSummary => ({ item: normalized, summary: snSummary || {} }))
          .catch(() => ({ item: normalized, summary }));
      });
      return Promise.all(rightsPromises).then(rows => rows.map(({ item, summary }) => {
        const rights = Array.isArray(summary.rights)
          ? summary.rights
          : (Array.isArray(item.resourceRights) ? item.resourceRights : []);
        const availableResources = rights.filter(right => String(right.current_status || right.status || '').toUpperCase() === 'AVAILABLE')
          .map(right => categoryNames[right.resource_type || right.resourceType] || right.resource_name || right.resource_type || right.resourceType)
          .filter(Boolean);
        const unavailableResources = rights.filter(right => String(right.current_status || right.status || '').toUpperCase() !== 'AVAILABLE' && String(right.current_status || right.status || '').toUpperCase() !== 'NOT_APPLICABLE')
          .map(right => {
            const code = right.resource_type || right.resourceType;
            const status = right.current_status || right.status || '未知';
            const statusText = { LOCKED: '已锁定', USED: '已核销', CLAIMED_BACK: '已套回', EXCEPTION: '异常' }[String(status).toUpperCase()] || status;
            return `${categoryNames[code] || right.resource_name || code}: ${statusText}`;
          });
        return {
          productName: item.productName || item.name || '未命名商品',
          pnCode: item.pnCode || '',
          snCode: item.snCode || '',
          quantity: item.quantity || 1,
          availableResources,
          unavailableResources,
          hasAvailable: availableResources.length > 0
        };
      }));
    }).then(resourceRows => {
      this.setData({ resourceRows, resourceModalLoading: false });
    }).catch(error => {
      console.error('加载订单可用资源失败:', error);
      this.setData({ resourceRows: [], resourceModalLoading: false });
      wx.showToast({ title: '资源加载失败', icon: 'none' });
    });
  },

  closeResourceModal: function () {
    this.setData({ showResourceModal: false, resourceRows: [] });
  },

  getLocalOrderOverrides: function () {
    return wx.getStorageSync('orderLocalOverrides') || {};
  },

  applyLocalOrderOverride: function (order) {
    if (!order || !order.orderNo) return order;
    const overrides = this.getLocalOrderOverrides();
    return Object.assign({}, order, overrides[order.orderNo] || {});
  },

  /**
   * 加载用户信息
   */
  loadUserInfo: function () {
    const userInfo = userUtils.getUserInfo();
    this.setData({
      userInfo: userInfo
    });
  },

  getOrderQueryUserContext: function () {
    const storedUserInfo = wx.getStorageSync('userInfo') || {};
    const currentUserInfo = this.data.userInfo || {};
    const userInfo = Object.assign({}, currentUserInfo, storedUserInfo);
    const tempStoreInfo = wx.getStorageSync('tempStoreInfo') || {};
    const hasRealUser = !!(
      storedUserInfo.phoneNumber ||
      storedUserInfo.phone ||
      storedUserInfo.userName ||
      storedUserInfo.name ||
      storedUserInfo.user_name ||
      storedUserInfo.staffName ||
      storedUserInfo.staffId ||
      storedUserInfo.userId ||
      storedUserInfo.user_id
    );
    const rawRole = userInfo.userRole || userInfo.role || userInfo.roleCode || userInfo.role_code || '';
    let userRole = 'staff';

    if (rawRole === 'distributor' || rawRole === 'admin') {
      userRole = 'distributor';
    } else if (rawRole === 'store_admin' || rawRole === 'manager') {
      userRole = 'store_admin';
    }

    const selectedStoreId = tempStoreInfo.storeId || tempStoreInfo.store_id || tempStoreInfo.id || tempStoreInfo._id || '';
    const ownStoreId = userInfo.storeId || '';
    const storeId = userRole === 'distributor' ? '' : (selectedStoreId || ownStoreId);

    return {
      hasRealUser: hasRealUser,
      userRole: hasRealUser ? userRole : '',
      userName: hasRealUser ? (userInfo.userName || userInfo.name || userInfo.user_name || userInfo.staffName || '') : '',
      userId: hasRealUser ? (userInfo.userId || userInfo.user_id || userInfo.staffId || '') : '',
      storeId: hasRealUser ? storeId : '',
      rawUserInfo: userInfo
    };
  },

  getOrderDateValue: function (order) {
    if (!order) return '';
    const directDate = order.createDate || order.create_date || '';
    if (directDate) {
      const directMatch = String(directDate).match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
      if (directMatch) {
        return `${directMatch[1]}-${directMatch[2].padStart(2, '0')}-${directMatch[3].padStart(2, '0')}`;
      }
    }

    const rawTime = order.createTime || order.create_time || order.createTimeFormat || '';
    if (typeof rawTime === 'number' && rawTime > 0) {
      const millis = rawTime < 10000000000 ? rawTime * 1000 : rawTime;
      const date = new Date(millis);
      if (!isNaN(date.getTime())) {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      }
    }

    const timeText = String(rawTime || '');
    const timeMatch = timeText.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (timeMatch) {
      return `${timeMatch[1]}-${timeMatch[2].padStart(2, '0')}-${timeMatch[3].padStart(2, '0')}`;
    }

    return '';
  },

  filterOrdersByDateRange: function (orders) {
    if (!this.shouldUseDateFilter()) return orders;

    const startDate = this.data.startDate || '';
    const endDate = this.data.endDate || '';
    if (!startDate && !endDate) return orders;

    return (orders || []).filter(order => {
      const orderDate = this.getOrderDateValue(order);
      if (!orderDate) return true;
      if (startDate && orderDate < startDate) return false;
      if (endDate && orderDate > endDate) return false;
      return true;
    });
  },

  shouldUseDateFilter: function () {
    if (this.data.isTimeDisabled) return false;
    if (userUtils.isDistributor() && !this.data.dateFilterTouched) return false;
    return !!(this.data.startDate || this.data.endDate);
  },

  normalizeDateFilterForRole: function () {
    if (!userUtils.isDistributor() || this.data.dateFilterTouched) return;
    if (!this.data.startDate && !this.data.endDate && !this.data.searchDate) return;

    this.setData({
      startDate: '',
      endDate: '',
      searchDate: '',
      'searchParams.searchDate': ''
    });
  },

  /**
   * 加载店员信息（所有角色都加载全部人员，包括店员、店长、经销商）
   */
  loadStaffInfo: function () {
    const DataStorage = require('../../utils/storage.js');
    const userInfo = this.data.userInfo || userUtils.getUserInfo() || {};
    const distributorId = userInfo.distributorId || userInfo.distributor_id || '';
    const names = new Set();
    const currentName = userInfo.userName || userInfo.name || userInfo.user_name || userInfo.staffName || '';
    if (currentName) names.add(String(currentName).trim());

    const updateOptions = () => {
      const options = ['全部', ...Array.from(names).filter(Boolean).sort()];
      const currentSubmitter = this.data.submitterOptions[this.data.submitterIndex];
      const selectedIndex = options.indexOf(currentSubmitter);
      this.setData({
        submitterOptions: options,
        submitterIndex: selectedIndex >= 0 ? selectedIndex : 0
      });
    };

    // 统一使用“经销商全部人员”接口；旧的 getStores 需要 phoneNumber 和 token，
    // 店员账号常常只有 phone/staffId，因此会误回调空数组导致下拉框只有空值。
    if (typeof DataStorage.getAllStaffByDistributor === 'function') {
      DataStorage.getAllStaffByDistributor(distributorId, staffList => {
        (staffList || []).forEach(staff => {
          const name = staff && (staff.name || staff.userName || staff.managerName);
          if (name) names.add(String(name).trim());
        });
        updateOptions();
      }, error => {
        console.warn('获取提交人列表失败，使用当前账号:', error);
        updateOptions();
      });
      return;
    }

    updateOptions();
  },

  /**
   * 加载订单数据（使用云函数，支持分页）
   * @param {boolean} isLoadMore - 是否加载更多
   * @param {boolean} searchAll - 是否查询全部（不分页）
   */
  parseOrderAmount: function (value) {
    const num = parseFloat(String(value === undefined || value === null ? '' : value).replace(/[^\d.-]/g, ''));
    return isNaN(num) ? null : num;
  },

  pickOrderAmount: function () {
    for (let i = 0; i < arguments.length; i++) {
      const value = arguments[i];
      if (value === undefined || value === null || value === '') continue;
      const num = this.parseOrderAmount(value);
      if (num !== null) return num;
    }
    return 0;
  },

  calculateListPaymentTotal: function (order) {
    const payments = order.payments || order.paymentMethods || order.OrderPayments || [];
    if (!payments || payments.length === 0) return null;

    return payments.reduce((total, payment) => {
      const amount = this.parseOrderAmount(payment.amount) || 0;
      const type = String(payment.type || payment.paymentType || payment.method || payment.payment_method || '');
      if (type.indexOf('政策补贴应收') >= 0) {
        return total;
      }
      if (type === '国补POS（手机平板）') {
        return total + (amount - Math.min(amount * 0.15, 500));
      }
      if (type === '国补POS（电脑）') {
        return total + (amount - Math.min(amount * 0.15, 1500));
      }
      return total + amount;
    }, 0);
  },

  calculateListActualAmount: function (order) {
    const storedActualAmount = this.pickOrderAmount(
      order.actualPayment,
      order.actual_payment,
      order.actualAmount,
      order.actual_amount
    );
    const hasStoredActualAmount = [
      order.actualPayment,
      order.actual_payment,
      order.actualAmount,
      order.actual_amount
    ].some(value => value !== undefined && value !== null && value !== '');
    if (hasStoredActualAmount) {
      return Math.max(0, storedActualAmount);
    }

    const totalAmount = this.pickOrderAmount(order.totalAmount, order.total_amount);
    const discount = this.pickOrderAmount(order.discount, order.discountAmount, order.discount_amount);
    const nationalSubsidy = this.pickOrderAmount(order.nationalSubsidy, order.national_subsidy);
    const educationSubsidy = this.pickOrderAmount(order.educationSubsidy, order.education_subsidy);
    // 定金作为收款方式计入收款汇总，不再从应收金额中重复扣减。
    const computed = totalAmount - discount - nationalSubsidy - educationSubsidy;

    return Math.max(0, computed);
  },

  resolveListPaymentTotal: function (order, actualAmount) {
    const storedPaymentTotal = this.pickOrderAmount(order.paymentTotal, order.payment_total);
    const hasStoredPaymentTotal = [order.paymentTotal, order.payment_total]
      .some(value => value !== undefined && value !== null && value !== '');
    if (hasStoredPaymentTotal && (storedPaymentTotal > 0 || actualAmount <= 0)) {
      return Math.max(0, storedPaymentTotal);
    }

    const calculatedPaymentTotal = this.calculateListPaymentTotal(order);
    if (calculatedPaymentTotal !== null) {
      return Math.max(0, calculatedPaymentTotal);
    }
    return Math.max(0, actualAmount);
  },

  // 订单列表接口不返回完整的产品定价/库存成本，毛利沿用原有毛利接口计算。
  resolveGrossProfitAmount: function (result) {
    const payload = result && result.data !== undefined ? result.data : result;
    const values = payload && typeof payload === 'object'
      ? [payload.grossProfitAmount, payload.gross_profit_amount, payload.grossProfit, payload.gross_profit]
      : [payload];
    for (let i = 0; i < values.length; i += 1) {
      if (values[i] === undefined || values[i] === null || values[i] === '') continue;
      const value = Number(values[i]);
      if (Number.isFinite(value)) return value;
    }
    return null;
  },

  loadListGrossProfit: function (order) {
    const orderId = order && (order.orderId || order.order_id || order._id);
    if (!orderId) return Promise.resolve(order);

    return api.order.getGrossProfit(orderId).then(result => {
      const grossProfit = this.resolveGrossProfitAmount(result);
      if (grossProfit === null) return order;
      return {
        ...order,
        grossProfit,
        grossProfitText: `¥${grossProfit.toFixed(2)}`,
        grossProfitTone: grossProfit >= 0 ? 'positive' : 'negative'
      };
    }).catch(error => {
      console.warn('查询订单毛利失败，保留前端计算结果:', order.orderNo, error && error.message);
      return order;
    });
  },

  formatGrossProfitMoney: function (value) {
    if (value === undefined || value === null || value === '') return '-';
    const number = Number(value);
    return Number.isFinite(number) ? `¥${number.toFixed(2)}` : '-';
  },

  pickGrossProfitValue: function (source, keys) {
    for (let i = 0; i < keys.length; i += 1) {
      const value = source && source[keys[i]];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return null;
  },

  normalizeGrossProfitDetail: function (result, order) {
    const payload = result && result.data !== undefined ? result.data : (result || {});
    const grossProfit = this.resolveGrossProfitAmount(payload);
    const productPricingDetails = Array.isArray(payload.productPricingDetails)
      ? payload.productPricingDetails
      : (Array.isArray(payload.product_pricing_details) ? payload.product_pricing_details : []);
    const paymentDetails = Array.isArray(payload.paymentDetails)
      ? payload.paymentDetails
      : (Array.isArray(payload.payment_fee_details) ? payload.payment_fee_details : []);
    const supplementDetails = Array.isArray(payload.supplementDetails)
      ? payload.supplementDetails
      : (Array.isArray(payload.supplement_details) ? payload.supplement_details : []);
    const detail = {
      receivableText: this.formatGrossProfitMoney(this.pickGrossProfitValue(payload, ['receivableAmount', 'received_amount'])),
      productPricingText: this.formatGrossProfitMoney(this.pickGrossProfitValue(payload, ['productPricingAmount', 'product_pricing_amount', 'settlementCostAmount'])),
      paymentFeeText: this.formatGrossProfitMoney(this.pickGrossProfitValue(payload, ['paymentFeeAmount', 'payment_fee_amount'])),
      invoiceText: this.formatGrossProfitMoney(this.pickGrossProfitValue(payload, ['invoiceAmount', 'invoice_amount'])),
      vatText: this.formatGrossProfitMoney(this.pickGrossProfitValue(payload, ['vatAmount', 'vat_amount'])),
      supplementText: this.formatGrossProfitMoney(this.pickGrossProfitValue(payload, ['supplementAmount', 'supplement_amount'])),
      externalAdjustmentText: this.formatGrossProfitMoney(this.pickGrossProfitValue(payload, ['externalAdjustmentFee', 'external_adjustment_fee']) || 0),
      externalAdjustmentFee: Number(this.pickGrossProfitValue(payload, ['externalAdjustmentFee', 'external_adjustment_fee']) || 0),
      grossProfitText: this.formatGrossProfitMoney(grossProfit),
      grossProfitTone: grossProfit === null ? 'unknown' : (grossProfit >= 0 ? 'positive' : 'negative'),
      productPricingDetails: productPricingDetails.map(item => ({
        ...item,
        displayName: `${item.productName || item.itemName || '商品'} × ${item.quantity || 1}`,
        amountText: item.pricingAmount !== undefined
          ? this.formatGrossProfitMoney(item.pricingAmount)
          : (item.unitPricing !== undefined ? `${this.formatGrossProfitMoney(item.unitPricing)}/件` : '-')
      })),
      paymentDetails: paymentDetails.map(item => ({
        ...item,
        displayName: `${item.method || item.paymentMethod || '支付'}（${item.taxRate || 0}%）`,
        feeText: item.fee !== undefined ? this.formatGrossProfitMoney(item.fee) : '-'
      })),
      supplementDetails: supplementDetails.map(item => ({
        ...item,
        displayName: item.itemName || item.content || '补录',
        amountText: `${item.amountType === 'decrease' ? '-' : '+'} ${this.formatGrossProfitMoney(item.amount || 0)}`
      })),
      formula: payload.formula || '',
      snapshotStatus: payload.snapshotStatus || payload.snapshot_status || '',
      calculatedAt: payload.calculatedAt || payload.calculated_at || '',
      orderNo: order && order.orderNo || ''
    };
    return detail;
  },

  showGrossProfitDetail: function (e) {
    const order = (e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.order) || {};
    const orderId = order.orderId || order.order_id || order._id;
    this.setData({
      showGrossProfitModal: true,
      grossProfitModalLoading: true,
      grossProfitModalOrder: order,
      grossProfitDetail: Object.assign({}, this.data.grossProfitDetail, {
        grossProfitText: order.grossProfitText || '-',
        grossProfitTone: order.grossProfitTone || 'unknown',
        productPricingDetails: [],
        paymentDetails: [],
        supplementDetails: []
      })
    });

    if (!orderId) {
      this.setData({ grossProfitModalLoading: false });
      return;
    }

    api.order.getGrossProfit(orderId).then(result => {
      this.setData({
        grossProfitModalLoading: false,
        grossProfitDetail: this.normalizeGrossProfitDetail(result, order)
      });
    }).catch(error => {
      console.error('加载毛利明细失败:', error);
      this.setData({ grossProfitModalLoading: false });
      wx.showToast({ title: '毛利明细加载失败', icon: 'none' });
    });
  },

  closeGrossProfitModal: function () {
    this.setData({
      showGrossProfitModal: false,
      grossProfitModalLoading: false,
      grossProfitModalOrder: {},
      grossProfitDetail: Object.assign({}, this.data.grossProfitDetail, {
        productPricingDetails: [],
        paymentDetails: [],
        supplementDetails: []
      })
    });
  },

  loadOrders: function (isLoadMore = false, searchAll = false) {
    this.normalizeDateFilterForRole();
    const queryUser = this.getOrderQueryUserContext();
    const userInfo = queryUser.rawUserInfo || {};
    const userRole = queryUser.userRole || 'staff';

    wx.showLoading({
      title: searchAll ? '查询全部记录...' : (isLoadMore ? '加载更多...' : '加载中...'),
    });

    // 加载店员信息
    this.loadStaffInfo();

    const hasDateFilter = this.shouldUseDateFilter();

    // 构建查询参数
    const params = {
      page: isLoadMore ? this.data.page + 1 : 1,
      pageSize: (searchAll || hasDateFilter) ? 1000 : this.data.pageSize, // 查询全部时使用较大的pageSize
      userRole: queryUser.userRole,
      userName: queryUser.userName,
      storeId: queryUser.storeId,
      createUser: this.data.searchParams.createUser,
      orderNo: this.data.searchParams.orderNo,
      status: this.data.searchParams.status,
      snCode: this.data.searchParams.snCode,
      pnCode: this.data.searchParams.pnCode,
      invoiceInfo: this.data.searchParams.invoiceInfo,
      resourceType: this.data.searchParams.resourceType,
      startDate: hasDateFilter ? this.data.startDate : '',
      endDate: hasDateFilter ? this.data.endDate : '',
      searchAll: searchAll // 标记是否为查询全部
    };

    console.log('查询订单参数:', params);

    // 使用后台 API 查询订单，照片字段由 /sales/list 一并返回
    api.order.queryList(params).then(async apiResult => {

      const list = apiResult.data || [];
      const rawPagination = apiResult.raw && (apiResult.raw.pagination || (apiResult.raw.data && apiResult.raw.data.pagination)) || {};
      const res = {
        result: {
          code: 0,
          data: {
            list,
            total: Number(rawPagination.total || rawPagination.count || list.length),
            hasMore: rawPagination.hasMore !== undefined
              ? Boolean(rawPagination.hasMore)
              : list.length >= Number(params.pageSize || this.data.pageSize)
          }
        }
      };

      if (res.result && res.result.code === 0) {
        const { list, total, hasMore } = res.result.data;

        // 调试：打印第一条订单数据，检查照片字段
        if (list.length > 0) {
          console.log('订单列表 - 第一条订单数据:', list[0]);
          console.log('订单列表 - 照片字段检查:');
          console.log('  subsidyPhotos:', list[0].subsidyPhotos);
          console.log('  productPhotoUrls:', list[0].productPhotoUrls);
        }

        // 格式化订单数据
        const formattedOrders = list.map(rawOrder => {
          const order = this.applyLocalOrderOverride(rawOrder);
          let createTimeFormat = '未知时间';
          let createDate = '';

          try {
            let timestamp = order.createTime;

            // 处理各种时间格式
            if (typeof timestamp === 'string') {
              // 如果是纯数字字符串，转换为数字
              if (/^\d+$/.test(timestamp)) {
                timestamp = parseInt(timestamp);
              } else {
                // 如果是日期字符串，尝试解析
                const parsedDate = new Date(timestamp);
                if (!isNaN(parsedDate.getTime())) {
                  createTimeFormat = `${parsedDate.getFullYear()}-${(parsedDate.getMonth() + 1).toString().padStart(2, '0')}-${parsedDate.getDate().toString().padStart(2, '0')} ${parsedDate.getHours().toString().padStart(2, '0')}:${parsedDate.getMinutes().toString().padStart(2, '0')}`;
                  createDate = `${parsedDate.getFullYear()}-${(parsedDate.getMonth() + 1).toString().padStart(2, '0')}-${parsedDate.getDate().toString().padStart(2, '0')}`;
                }
                // 不提前返回，继续执行后续的 paymentTotal 计算
              }
            }

            // 确保时间戳是数字且有效
            if (typeof timestamp === 'number' && timestamp > 0) {
              // 处理秒级时间戳（小于 10000000000 的是秒级）
              if (timestamp < 10000000000) {
                timestamp = timestamp * 1000;
              }

              const createTime = new Date(timestamp);

              if (!isNaN(createTime.getTime()) && createTime.getFullYear() > 1970) {
                createTimeFormat = `${createTime.getFullYear()}-${(createTime.getMonth() + 1).toString().padStart(2, '0')}-${createTime.getDate().toString().padStart(2, '0')} ${createTime.getHours().toString().padStart(2, '0')}:${createTime.getMinutes().toString().padStart(2, '0')}`;
                createDate = `${createTime.getFullYear()}-${(createTime.getMonth() + 1).toString().padStart(2, '0')}-${createTime.getDate().toString().padStart(2, '0')}`;
              }
            }
          } catch (error) {
            console.warn('日期格式化错误:', error, '订单:', order.orderNo, '时间戳:', order.createTime);
          }

          // 兼容处理：处理字段名差异，并统一按订单创建页口径计算国补后金额
          const actualAmount = this.calculateListActualAmount(order);
          const paymentTotal = this.resolveListPaymentTotal(order, actualAmount);

          // 格式化金额字段，确保显示为保留2位小数的字符串
          const formattedPaymentTotal = parseFloat(paymentTotal || 0).toFixed(2);
          const formattedActualAmount = parseFloat(actualAmount || 0).toFixed(2);

          // 计算是否有操作权限
          let canOperate = false;
          const orderCreator = String(
            order.createUser || order.create_user || order.creatorName || order.creator_name ||
            order.createdByName || order.created_by_name || order.userName || order.user_name || ''
          ).trim();
          const orderCreatorId = String(
            order.createUserId || order.create_user_id || order.creatorId || order.creator_id ||
            order.userId || order.user_id || ''
          ).trim();
          const sameCreator = orderCreator && queryUser.userName && orderCreator === String(queryUser.userName).trim();
          const sameCreatorId = orderCreatorId && queryUser.userId && orderCreatorId === String(queryUser.userId).trim();
          if (!queryUser.hasRealUser || userRole === 'distributor') {
            canOperate = true;
          } else if (userRole === 'store_admin') {
            const orderStoreId = order.storeId || order.store_id || order.storeId || '';
            canOperate = !orderStoreId || String(orderStoreId) === String(queryUser.storeId || '');
          } else {
            // 列表接口已经按当前账号权限返回订单；当旧订单缺少创建人字段时，
            // 不应因为前端二次校验失败而隐藏操作区。
            canOperate = Boolean(sameCreator || sameCreatorId || !orderCreator && !orderCreatorId);
          }

          // 兼容处理：客户来源字段
          let customerSource = order.customerSource || order.source || '';

          // 兼容处理：将 items 数组映射为 goods 数组（用于页面显示）
          // 优先使用 items 数组（数据库中的最新数据），如果没有则使用 goods 数组
          let goods = [];
          if (order.items && order.items.length > 0) {
            goods = order.items.map(item => this.normalizeOrderGoodsItem(item));
          } else if (order.goods && order.goods.length > 0) {
            goods = order.goods.map(item => this.normalizeOrderGoodsItem(item));
          }

          // 恢复订单原有的毛利预估口径，统一复用现有计算函数。
          const orderProfit = calculateOrderProfit(Object.assign({}, order, { actualAmount }), goods);
          const grossProfit = orderProfit.grossProfit;
          const grossProfitText = grossProfit === null
            ? '暂无'
            : `¥${Number(grossProfit).toFixed(2)}`;
          const grossProfitTone = grossProfit === null
            ? 'unknown'
            : (grossProfit >= 0 ? 'positive' : 'negative');

          return {
            ...order,
            customerSource: customerSource,
            invoiceStatus: order.invoiceStatus || order.invoice_status || '不开票',
            invoiceInfo: order.invoiceInfo || order.invoice_info || '',
            invoiceAmount: order.invoiceAmount || order.invoice_amount || '',
            goods: goods,
            createTimeFormat: createTimeFormat,
            createDate: createDate,
            paymentTotal: formattedPaymentTotal,
            actualAmount: formattedActualAmount,
            grossProfit,
            grossProfitText,
            grossProfitTone,
            pricingTotal: orderProfit.pricingTotal,
            minimumSalePriceTotal: orderProfit.minimumSalePriceTotal,
            canOperate: canOperate,
            canVoid: canOperate && order.status !== 'pending_approval' && !this.isArchivedOrder(order) && !this.isReturnPending(order),
            canRequestReturn: canOperate && this.isArchivedOrder(order) && !this.isReturnPending(order)
          };
        });

        const ordersWithGrossProfit = await Promise.all(
          formattedOrders.map(order => this.loadListGrossProfit(order))
        );
        const visibleOrders = this.filterOrdersByDateRange(ordersWithGrossProfit);

        // 更新数据
        const newOrders = isLoadMore ? [...this.data.orders, ...visibleOrders] : visibleOrders;
        const newPage = isLoadMore ? this.data.page + 1 : 1;

        wx.hideLoading();
        this.setData({
          orders: newOrders,
          filteredOrders: newOrders,
          page: newPage,
          total: hasDateFilter ? newOrders.length : total,
          loading: false,
          hasMore: (searchAll || hasDateFilter) ? false : hasMore
        });

        console.log(`加载订单成功，共 ${total} 条，当前显示 ${newOrders.length} 条`);
      } else {
        wx.hideLoading();
        console.error('查询订单失败:', res.result);
        this.setData({ loading: false });
        wx.showToast({
          title: '查询失败',
          icon: 'none'
        });
      }
    }).catch(err => {
      wx.hideLoading();
      this.setData({ loading: false });
      console.error('后台 API 调用失败:', err);
      wx.showToast({
        title: '查询失败',
        icon: 'none'
      });
    });
  },

  /**
   * 加载更多订单
   */
  loadMoreOrders: function () {
    if (this.data.loading || !this.data.hasMore) {
      return;
    }

    this.setData({ loading: true });
    this.loadOrders(true);
  },

  /**
   * 提交人选择变更处理
   */
  /**
   * 订单编号输入处理
   */
  onOrderNoInput: function (e) {
    const orderNo = e.detail.value;

    this.setData({
      searchOrderNo: orderNo,
      searchParams: {
        ...this.data.searchParams,
        orderNo: orderNo
      }
    });
  },

  onSubmitterChange: function (e) {
    const index = e.detail.value;
    const submitter = this.data.submitterOptions[index];

    this.setData({
      submitterIndex: index,
      searchParams: {
        ...this.data.searchParams,
        createUser: submitter === '全部' ? '' : submitter
      }
    });
  },

  /**
   * PN码输入处理
   */
  onPnInput: function (e) {
    const pnCode = e.detail.value;

    // 如果输入了PN码，禁用时间选择（与SN码逻辑一致）
    const isTimeDisabled = pnCode && pnCode.trim().length > 0;

    this.setData({
      searchPn: pnCode,
      searchParams: {
        ...this.data.searchParams,
        pnCode: pnCode
      },
      isTimeDisabled: isTimeDisabled
    });
  },

  /**
   * SN码输入处理
   */
  onSnInput: function (e) {
    const snCode = e.detail.value;

    // 如果输入了SN码，禁用时间选择
    const isTimeDisabled = snCode && snCode.trim().length > 0;

    this.setData({
      searchSn: snCode,
      searchParams: {
        ...this.data.searchParams,
        snCode: snCode
      },
      isTimeDisabled: isTimeDisabled
    });
  },

  /**
   * 国补人/开票信息输入处理
   */
  onInvoiceInfoInput: function (e) {
    const invoiceInfo = e.detail.value;

    this.setData({
      searchInvoiceInfo: invoiceInfo,
      searchParams: {
        ...this.data.searchParams,
        invoiceInfo: invoiceInfo
      }
    });
  },

  loadResourceTypes: function () {
    api.purchase.resourceCategories().then(result => {
      const categories = Array.isArray(result) ? result : ((result && result.data) || []);
      const fallback = [
        { label: '国补资格', value: 'GOV_SUBSIDY' },
        { label: '教育优惠资格', value: 'EDU_SUBSIDY' },
        { label: '销售红包', value: 'SALES_RED_PACKET' },
        { label: '销售报号资格', value: 'SALES_REPORT' }
      ];
      const source = categories.length ? categories : fallback;
      const options = ['全部'].concat(source
        .filter(item => item.status === undefined || Number(item.status) !== 0)
        .map(item => ({ label: item.name || item.short_name || item.category_code, value: item.category_code }))
        .filter(item => item.label && item.value));
      this.setData({ resourceTypeOptions: options, resourceTypeIndex: 0 });
    }).catch(() => {});
  },

  onResourceTypeChange: function (e) {
    const index = Number(e.detail.value);
    const option = this.data.resourceTypeOptions[index];
    this.setData({
      resourceTypeIndex: index,
      searchParams: Object.assign({}, this.data.searchParams, { resourceType: option && option.value || '' })
    });
  },

  /**
   * 开始日期选择处理
   */
  onStartDateChange: function (e) {
    const startDate = e.detail.value;
    
    this.setData({
      startDate: startDate,
      dateFilterTouched: true
    });
  },

  /**
   * 结束日期选择处理
   */
  onEndDateChange: function (e) {
    const endDate = e.detail.value;
    
    this.setData({
      endDate: endDate,
      dateFilterTouched: true
    });
  },

  /**
   * 状态选择处理
   */
  onStatusChange: function (e) {
    const statusIndex = e.detail.value;
    const status = this.data.statusOptions[statusIndex] === '全部' ? '' : this.data.statusOptions[statusIndex];
    
    this.setData({
      statusIndex: statusIndex,
      searchParams: {
        ...this.data.searchParams,
        status: status
      }
    });
  },

  /**
   * 查询订单 - 调用云函数重新查询
   */
  searchOrders: function () {
    // 重置分页并重新加载订单
    this.setData({
      page: 1,
      orders: [],
      filteredOrders: []
    });
    
    // 调用云函数查询
    this.loadOrders();
  },

  /**
   * 查询全部订单 - 不分页显示当前条件下的所有记录
   */
  searchAllOrders: function () {
    // 重置分页并设置较大的pageSize以查询全部
    this.setData({
      page: 1,
      orders: [],
      filteredOrders: []
    });
    
    // 调用云函数查询全部（使用较大pageSize）
    this.loadOrders(false, true);
  },

  /**
   * 重置搜索条件
   */
  resetSearch: function () {
    const currentDate = this.data.currentDate;
    const defaultStartDate = userUtils.isDistributor() ? '' : currentDate;
    const defaultEndDate = userUtils.isDistributor() ? '' : currentDate;

    this.setData({
      searchParams: {
        orderNo: '',
        createUser: '',
        searchDate: defaultStartDate,
        status: '',
        snCode: '',
        pnCode: '',
        invoiceInfo: '',
        resourceType: ''
      },
      searchOrderNo: '',
      searchPn: '',
      searchSn: '',
      searchInvoiceInfo: '',
      resourceTypeIndex: 0,
      searchDate: defaultStartDate,
      startDate: defaultStartDate,
      endDate: defaultEndDate,
      isTimeDisabled: false,
      dateFilterTouched: false,
      statusIndex: 0,
      submitterIndex: 0,
      page: 1,
      orders: [],
      filteredOrders: []
    });

    // 重新加载所有订单
    this.loadOrders();
  },

  /**
   * 查看订单详情
   */
  viewOrderDetail: function (e) {
    const orderNo = e.currentTarget.dataset.orderno;
    // 从订单列表中查找订单
    const order = this.data.orders.find(o => o.orderNo === orderNo);
    
    if (!order) {
      wx.showToast({ title: '订单不存在', icon: 'none' });
      return;
    }
    
    // 记录当前查看的订单编号
    this.isFromDetail = true;
    this.currentViewOrderNo = orderNo;
    // 跳转到订单详情页，只传递订单号（避免URL长度限制问题）
    wx.navigateTo({
      url: '/pages/order-detail/order-detail?orderNo=' + orderNo
    });
  },

  /**
   * 跳转到新建订单页面
   */
  navigateToCreateOrder: function () {
    wx.navigateTo({
      url: '/pages/order-create/order-create'
    });
  },

  /**
   * 页面相关事件处理函数--监听用户下拉动作
   */
  onPullDownRefresh: function () {
    // 重新加载订单数据
    this.loadOrders();
    // 停止下拉刷新
    wx.stopPullDownRefresh();
  },

  /**
   * 页面上拉触底事件的处理函数
   */
  onReachBottom: function () {
    // 上拉加载更多（实际项目中应实现分页加载）
    if (!this.data.loading && this.data.canLoadMore) {
      this.setData({
        loading: true
      });
      
      // 模拟加载更多延迟
      setTimeout(() => {
        this.setData({
          loading: false
        });
      }, 1000);
    }
  },

  /**
   * 导出订单数据（异步版本）
   */
  exportOrders: function () {
    // 确定用户角色
    const queryUser = this.getOrderQueryUserContext();

    // 构建查询参数（使用当前搜索条件）
    const hasDateFilter = this.shouldUseDateFilter();
    const params = {
      userRole: queryUser.userRole,
      userName: queryUser.userName,
      storeId: queryUser.storeId,
      createUser: this.data.searchParams.createUser,
      orderNo: this.data.searchParams.orderNo,
      status: this.data.searchParams.status,
      snCode: this.data.searchParams.snCode,
      pnCode: this.data.searchParams.pnCode,
      invoiceInfo: this.data.searchParams.invoiceInfo,
      resourceType: this.data.searchParams.resourceType,
      startDate: hasDateFilter ? this.data.startDate : '',
      endDate: hasDateFilter ? this.data.endDate : ''
    };

    wx.showLoading({
      title: '正在创建导出任务...',
    });

    // 调用云函数创建导出任务
    wx.cloud.callFunction({
      name: 'exportOrders',
      data: {
        action: 'createExportTask',
        data: params
      }
    }).then(res => {
      wx.hideLoading();

      if (res.result && res.result.code === 0) {
        const { taskId, totalOrders, status } = res.result.data;

        wx.showModal({
          title: '导出任务已创建',
          content: `共 ${totalOrders} 条订单待导出，系统将自动处理，请稍后在弹窗中查看进度。`,
          confirmText: '查看进度',
          cancelText: '稍后查看',
          success: (modalRes) => {
            if (modalRes.confirm) {
              // 显示导出进度弹窗
              this.showExportProgressModal(taskId, totalOrders);
            }
          }
        });
      } else {
        console.error('创建导出任务失败:', res.result);
        wx.showToast({
          title: res.result?.message || '创建导出任务失败',
          icon: 'none'
        });
      }
    }).catch(err => {
      wx.hideLoading();
      console.error('云函数调用失败:', err);
      wx.showToast({
        title: '创建导出任务失败，请重试',
        icon: 'none'
      });
    });
  },

  /**
   * 显示导出进度弹窗
   */
  showExportProgressModal: function (taskId, totalOrders) {
    // 存储当前任务信息
    this.setData({
      currentExportTask: {
        taskId: taskId,
        totalOrders: totalOrders,
        status: 'pending',
        processedOrders: 0,
        progress: 0
      }
    });

    // 显示进度弹窗
    wx.showLoading({
      title: '正在导出...',
      mask: true
    });

    // 开始轮询查询导出状态
    this.startExportStatusPolling(taskId);
  },

  /**
   * 开始轮询查询导出状态
   */
  startExportStatusPolling: function (taskId) {
    let pollingCount = 0;
    const maxPollingCount = 300; // 最多轮询300次（约5分钟）
    const pollingInterval = 1000; // 每秒查询一次

    const pollStatus = () => {
      pollingCount++;

      // 查询导出状态
      wx.cloud.callFunction({
        name: 'exportOrders',
        data: {
          action: 'getExportStatus',
          data: { taskId: taskId }
        }
      }).then(res => {
        if (res.result && res.result.code === 0) {
          const taskData = res.result.data;
          const { status, processedOrders, totalOrders, downloadUrl, fileName, errorMessage } = taskData;

          // 计算进度
          const progress = totalOrders > 0 ? Math.round((processedOrders / totalOrders) * 100) : 0;

          // 更新进度显示
          if (status === 'pending') {
            wx.showLoading({
              title: `等待处理...`,
              mask: true
            });
          } else if (status === 'processing') {
            wx.showLoading({
              title: `导出中 ${progress}%`,
              mask: true
            });
          } else if (status === 'completed') {
            wx.hideLoading();
            this.setData({
              currentExportTask: null
            });

            // 导出完成，显示下载弹窗
            wx.showModal({
              title: '导出成功',
              content: `共导出 ${totalOrders} 条订单数据，文件名：${fileName}`,
              confirmText: '下载文件',
              success: (modalRes) => {
                if (modalRes.confirm) {
                  this.downloadExportFile(downloadUrl, fileName);
                }
              }
            });
            return; // 停止轮询
          } else if (status === 'failed') {
            wx.hideLoading();
            this.setData({
              currentExportTask: null
            });

            wx.showModal({
              title: '导出失败',
              content: errorMessage || '导出过程中发生错误，请重试',
              showCancel: false,
              confirmText: '知道了'
            });
            return; // 停止轮询
          }

          // 继续轮询
          if (pollingCount < maxPollingCount && (status === 'pending' || status === 'processing')) {
            setTimeout(pollStatus, pollingInterval);
          } else if (pollingCount >= maxPollingCount) {
            wx.hideLoading();
            this.setData({
              currentExportTask: null
            });

            wx.showModal({
              title: '导出超时',
              content: '导出任务处理时间过长，请稍后到订单列表查看导出结果',
              showCancel: false,
              confirmText: '知道了'
            });
          }
        } else {
          console.error('查询导出状态失败:', res.result);
          // 继续轮询，除非达到最大次数
          if (pollingCount < maxPollingCount) {
            setTimeout(pollStatus, pollingInterval);
          }
        }
      }).catch(err => {
        console.error('查询导出状态失败:', err);
        // 继续轮询，除非达到最大次数
        if (pollingCount < maxPollingCount) {
          setTimeout(pollStatus, pollingInterval);
        }
      });
    };

    // 开始第一次查询
    pollStatus();
  },

  /**
   * 下载导出的文件
   */
  downloadExportFile: function (e) {
    const downloadUrl = e.currentTarget.dataset.url;
    const fileName = e.currentTarget.dataset.filename;

    if (!downloadUrl) {
      wx.showToast({
        title: '下载链接无效',
        icon: 'none'
      });
      return;
    }

    wx.getSystemInfo({
      success: (sysInfo) => {
        const platform = sysInfo.platform;
        console.log('当前平台:', platform);

        if (platform === 'ios') {
          this.showDownloadLinkForiOS(downloadUrl, fileName);
        } else {
          this.downloadAndOpenFile(downloadUrl, fileName);
        }
      },
      fail: () => {
        this.downloadAndOpenFile(downloadUrl, fileName);
      }
    });
  },

  downloadAndOpenFile: function (downloadUrl, fileName) {
    wx.showLoading({
      title: '正在下载...',
    });

    wx.downloadFile({
      url: downloadUrl,
      success: (downloadRes) => {
        wx.hideLoading();

        if (downloadRes.statusCode === 200) {
          const tempFilePath = downloadRes.tempFilePath;
          const fileExt = fileName ? fileName.split('.').pop().toLowerCase() : 'csv';
          let fileType = '';

          if (fileExt === 'xlsx' || fileExt === 'xls') {
            fileType = 'xlsx';
          } else if (fileExt === 'docx' || fileExt === 'doc') {
            fileType = 'docx';
          } else if (fileExt === 'pdf') {
            fileType = 'pdf';
          } else if (fileExt === 'pptx' || fileExt === 'ppt') {
            fileType = 'pptx';
          }

          this.openDocumentOnAndroid(tempFilePath, fileType, fileName);
        } else {
          wx.showToast({
            title: '文件下载失败',
            icon: 'none'
          });
        }
      },
      fail: (err) => {
        wx.hideLoading();
        console.error('文件下载失败:', err);
        wx.showToast({
          title: '文件下载失败',
          icon: 'none'
        });
      }
    });
  },

  showDownloadLinkForiOS: function (downloadUrl, fileName) {
    wx.showModal({
      title: '复制下载链接',
      content: '请点击下方「复制链接」按钮，粘贴到浏览器地址栏下载',
      confirmText: '复制链接',
      cancelText: '取消',
      success: (modalRes) => {
        if (modalRes.confirm) {
          wx.setClipboardData({
            data: downloadUrl,
            success: () => {
              wx.showToast({
                title: '链接已复制',
                icon: 'success'
              });
            },
            fail: () => {
              wx.showModal({
                title: '下载链接',
                content: downloadUrl,
                showCancel: false,
                confirmText: '知道了'
              });
            }
          });
        }
      }
    });
  },

  openDocumentOnAndroid: function (filePath, fileType, fileName) {
    const openOptions = {
      filePath: filePath,
      showMenu: true,
      success: (openRes) => {
        console.log('文件打开成功', openRes);
      },
      fail: (openErr) => {
        console.error('文件打开失败:', openErr);
        wx.showModal({
          title: '文件已下载',
          content: '文件已保存到手机，请在文件管理中查找，或点击右上角分享使用其他应用打开',
          showCancel: false,
          confirmText: '知道了'
        });
      }
    };

    if (fileType) {
      openOptions.fileType = fileType;
    }

    wx.openDocument(openOptions);
  },

  openDocumentOniOS: function (filePath, fileType, fileName) {
    wx.showLoading({
      title: '正在保存...',
    });

    wx.saveFile({
      tempFilePath: filePath,
      success: (saveRes) => {
        wx.hideLoading();
        console.log('iOS文件保存成功', saveRes);
        const savedFilePath = saveRes.savedFilePath;
        wx.showModal({
          title: '保存成功',
          content: `文件已保存到「文件」App\n\n打开方式：\n1. 打开WPS → 点击「打开」→ 选择「浏览」\n2. 找到「微信文件」或「小程序缓存」\n3. 选择"${fileName || '导出文件'}"打开`,
          showCancel: false,
          confirmText: '知道了'
        });
      },
      fail: (saveErr) => {
        wx.hideLoading();
        console.error('iOS文件保存失败:', saveErr);
        this.openDocumentFallback(filePath, fileType, fileName);
      }
    });
  },

  openDocumentFallback: function (filePath, fileType, fileName) {
    const openOptions = {
      filePath: filePath,
      showMenu: true,
      success: (openRes) => {
        console.log('iOS文件打开成功', openRes);
        wx.showModal({
          title: '提示',
          content: '文件已准备好，请在预览界面点击右上角菜单选择「存储到文件」后再用WPS打开',
          showCancel: false,
          confirmText: '知道了'
        });
      },
      fail: (openErr) => {
        console.error('iOS文件打开失败:', openErr);
        wx.showModal({
          title: '导出失败',
          content: '文件保存失败，请尝试点击右上角菜单选择「存储到文件」',
          showCancel: false,
          confirmText: '知道了'
        });
      }
    };

    if (fileType) {
      openOptions.fileType = fileType;
    }

    wx.openDocument(openOptions);
  },

  /**
   * 作废订单
   */
  isArchivedOrder: function (order) {
    const status = String(order && (order.status || order.orderStatus || order.order_status) || '').trim();
    // “未归档”也包含“归档”二字，不能使用笼统的包含判断。
    if (status === '未归档' || status === 'unarchived' || status === 'UNARCHIVED' || status.indexOf('未归档') >= 0 || status.indexOf('鏈綊') >= 0) {
      return false;
    }
    return status === '已归档' || status === 'archived' || status === 'ARCHIVED' || status.indexOf('已归档') >= 0 || status.indexOf('宸插綊') >= 0;
  },

  isReturnPending: function (order) {
    const status = String(order && (order.status || order.orderStatus || order.order_status) || '').trim();
    return status === '已发起退单申请' || status === '退单审批中' || status === 'return_pending' || status === 'returning' || status.indexOf('退单审批') >= 0;
  },

  chooseReturnGovSubsidy: function (callback) {
    wx.showModal({
      title: '退回国补资格',
      content: '是否退回本单已核销的国补资格？选择“是”会冲减国补政策应收，并恢复商品可国补；选择“否”则保留已核销状态，商品不可再次享受国补。',
      confirmText: '是，退回',
      cancelText: '否，保留',
      success: result => callback(Boolean(result.confirm))
    });
  },

  requestReturnOrder: function (order) {
    if (!order || !this.isArchivedOrder(order)) return;
    if (!this.canOperateOrder(order)) {
      wx.showToast({ title: '无权操作此订单', icon: 'none' });
      return;
    }
    const queryUser = this.getOrderQueryUserContext();
    const orderId = order.orderId || order._id || order.order_id;
    if (!orderId) {
      wx.showToast({ title: '缺少订单ID，无法发起退单', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '退单流程',
      content: `已归档订单 ${order.orderNo} 不能直接作废，将提交店长和经销商总权限审批。`,
      confirmText: '提交申请',
      cancelText: '取消',
      success: modalRes => {
        if (!modalRes.confirm) return;
        this.chooseReturnGovSubsidy(returnGovSubsidy => {
          wx.showLoading({ title: '提交退单申请...' });
          api.order.requestReturn(orderId, {
            orderNo: order.orderNo,
            storeId: order.storeId || order.store_id || queryUser.storeId || '',
            reason: '客户退单',
            items: order.items || order.goods || [],
            refundAmount: Number(order.paymentTotal || order.payment_total || order.actualAmount || order.actual_payment || 0),
            returnGovSubsidy: returnGovSubsidy ? 1 : 0,
            return_gov_subsidy: returnGovSubsidy ? 1 : 0,
            originalPayments: order.paymentMethods || order.payments || [],
            userRole: queryUser.userRole,
            userName: queryUser.userName
          }).then(() => {
            const returnRequestStatus = '已发起退单申请';
            return api.order.update(orderId, {
              orderNo: order.orderNo,
              status: returnRequestStatus,
              orderStatus: returnRequestStatus,
              userRole: queryUser.userRole,
              userName: queryUser.userName,
              storeId: order.storeId || order.store_id || queryUser.storeId || ''
            }).then(() => ({ statusSyncFailed: false }))
              .catch(error => {
                console.error('退单申请已提交，但订单状态同步失败:', error);
                return { statusSyncFailed: true };
              });
          }).then(result => {
            this.updateOrderStatusInList(order.orderNo, '已发起退单申请');
            wx.showToast({
              title: result.statusSyncFailed ? '申请已提交，状态同步失败' : '退单申请已提交',
              icon: result.statusSyncFailed ? 'none' : 'success'
            });
          }).catch(err => {
            console.error('提交退单申请失败:', err);
            wx.showToast({ title: err.message || '提交退单申请失败', icon: 'none' });
          }).finally(() => wx.hideLoading());
        });
      }
    });
  },

  voidOrder: function (e) {
    const order = e.currentTarget.dataset.order;

    if (this.isReturnPending(order)) {
      wx.showToast({ title: '退单申请正在审批中', icon: 'none' });
      return;
    }
    if (this.isArchivedOrder(order)) {
      wx.navigateTo({
        url: '/pages/order-detail/order-detail?orderNo=' + encodeURIComponent(order.orderNo || '') + '&returnMode=1'
      });
      return;
    }

    // 检查权限
    if (!this.canOperateOrder(order)) {
      wx.showToast({
        title: '无权操作此订单',
        icon: 'none'
      });
      return;
    }

    const queryUser = this.getOrderQueryUserContext();
    const userInfo = queryUser.rawUserInfo || {};
    const userRole = queryUser.userRole || 'staff';

    // 门店店长及员工账号，对已归档订单的作废限制：
    // 1. 员工当日可以作废自己创建的已归档订单
    // 2. 店长当日可以作废同门店下店员创建的已归档订单
    // 3. 前一天及以前的订单不能作废
    if ((userRole === 'staff' || userRole === 'store_admin') && order.status === '已归档') {
      // 获取订单创建日期和当前日期
      const orderDate = order.createDate || '';
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      const today = `${year}-${month}-${day}`;

      // 如果订单日期不是今天，则不允许作废
      if (orderDate !== today) {
        wx.showModal({
          title: '提示',
          content: '不允许作废今日以前已归档订单，如有特殊情况，请在企业微信发起退单申请',
          showCancel: false,
          confirmText: '知道了'
        });
        return;
      }

      // 检查订单创建人权限：
      // - 员工只能作废自己创建的订单
      // - 店长可以作废同门店下任何店员创建的订单
      if (userRole === 'staff') {
        // 员工：只能作废自己创建的订单
        if (order.createUser !== userInfo.userName) {
          wx.showModal({
            title: '提示',
            content: '您只能作废自己创建的订单',
            showCancel: false,
            confirmText: '知道了'
          });
          return;
        }
      } else if (userRole === 'store_admin') {
        // 店长：可以作废同门店下的订单（包括店员创建的）
        if (String(order.storeId || order.store_id || '') !== String(queryUser.storeId || '')) {
          wx.showModal({
            title: '提示',
            content: '您只能作废同门店下的订单',
            showCancel: false,
            confirmText: '知道了'
          });
          return;
        }
      }
    }

    wx.showModal({
      title: '作废订单',
      content: `确定要作废订单 ${order.orderNo} 吗？作废后不可恢复。`,
      confirmText: '确定作废',
      cancelText: '取消',
      success: (modalRes) => {
        if (modalRes.confirm) {
          wx.showLoading({
            title: '处理中...',
          });

          // 使用云函数更新订单状态
          wx.cloud.callFunction({
            name: 'queryOrders',
            data: {
              action: 'updateOrderStatus',
              data: {
                orderNo: order.orderNo,
                orderId: order.orderId || order._id || order.order_id || '',
                status: '已作废',
                snStatusAction: 'restore',
                restorePreviousSnStatus: true,
                previousSnStatus: order.status === '已归档' ? '已占用' : '在库',
                inventoryStatusAction: 'restore',
                restoreOriginalInventory: true,
                voidReason: '未归档订单作废',
                previousInventoryStatus: order.status === '已归档' ? '已占用' : '在库',
                items: order.items || order.goods || [],
                goods: order.goods || order.items || [],
                depositItems: order.depositItems || order.deposit_items || order.deposits || [],
                deposits: order.depositItems || order.deposit_items || order.deposits || [],
                userRole: queryUser.userRole,
                userName: queryUser.userName,
                storeId: queryUser.storeId
              }
            }
          }).then(res => {
            wx.hideLoading();
            if (res.result && res.result.code === 0) {
              wx.showToast({
                title: '订单作废成功',
                icon: 'success'
              });
              // 只更新当前订单状态，不刷新整个列表
              this.updateOrderStatusInList(order.orderNo, '已作废');
            } else {
              console.error('订单作废失败:', res.result);
              wx.showToast({
                title: res.result?.message || '订单作废失败',
                icon: 'none'
              });
            }
          }).catch(err => {
            wx.hideLoading();
            console.error('订单作废失败:', err);
            wx.showToast({
              title: '订单作废失败，请重试',
              icon: 'none'
            });
          });
        }
      }
    });
  },

  /**
   * 上报订单到商场
   */
  reportOrderToMall: function (e) {
    const order = e.currentTarget.dataset.order;

    // 检查权限
    const userInfo = this.data.userInfo;
    if (userInfo.userRole !== 'store_admin') {
      wx.showToast({
        title: '只有店长才能上报商场',
        icon: 'none'
      });
      return;
    }

    // 检查订单状态
    if (order.status !== '已归档') {
      wx.showToast({
        title: '只有已归档订单才能上报',
        icon: 'none'
      });
      return;
    }

    // 检查是否已经上报过
    if (order.reportToMall && order.reportToMall.status === 'reported') {
      wx.showToast({
        title: '该订单已经上报过商场',
        icon: 'none'
      });
      return;
    }

    wx.showModal({
      title: '上报商场',
      content: `确定要将订单 ${order.orderNo} 上报到商场吗？`,
      confirmText: '确定上报',
      cancelText: '取消',
      success: (modalRes) => {
        if (modalRes.confirm) {
          wx.showLoading({
            title: '处理中...',
          });

          // 调用云函数上报订单
          wx.cloud.callFunction({
            name: 'queryOrders',
            data: {
              action: 'reportOrderToMall',
              data: {
                orderNo: order.orderNo,
                userRole: userInfo.userRole,
                userName: userInfo.userName || '',
                storeId: this.getOrderQueryUserContext().storeId
              }
            }
          }).then(res => {
            wx.hideLoading();
            if (res.result && res.result.code === 0) {
              wx.showToast({
                title: '上报成功',
                icon: 'success'
              });
              // 更新本地订单状态
              this.updateOrderReportStatus(order.orderNo, res.result.data.reportToMall);
            } else {
              wx.showToast({
                title: res.result?.message || '上报失败',
                icon: 'none'
              });
            }
          }).catch(err => {
            wx.hideLoading();
            console.error('订单上报失败:', err);
            wx.showToast({
              title: '上报失败，请重试',
              icon: 'none'
            });
          });
        }
      }
    });
  },

  /**
   * 更新订单上报状态到本地列表
   */
  updateOrderReportStatus: function (orderNo, reportData) {
    const orders = this.data.orders.map(order => {
      if (order.orderNo === orderNo) {
        return { ...order, reportToMall: reportData };
      }
      return order;
    });

    const filteredOrders = this.data.filteredOrders.map(order => {
      if (order.orderNo === orderNo) {
        return { ...order, reportToMall: reportData };
      }
      return order;
    });

    this.setData({
      orders: orders,
      filteredOrders: filteredOrders
    });
  },

  getErrorMessage: function (error, fallback) {
    if (!error) return fallback;

    const candidates = [
      error.message,
      error.error,
      error.errMsg,
      error.result && error.result.message,
      error.result && error.result.error,
      error.data && error.data.message,
      error.data && error.data.error
    ];

    for (let i = 0; i < candidates.length; i++) {
      if (candidates[i]) return String(candidates[i]);
    }

    if (typeof error === 'string') return error;

    try {
      return JSON.stringify(error);
    } catch (e) {
      return fallback;
    }
  },

  showArchiveError: function (error) {
    const message = this.getErrorMessage(error, '订单归档失败，请重试').replace(/^Error:\s*/, '');
    const content = message.indexOf('订单归档失败') === 0 ? message : '订单归档失败：' + message;

    if (content.length > 18) {
      wx.showModal({
        title: '归档失败',
        content: content,
        showCancel: false,
        confirmText: '知道了'
      });
      return;
    }

    wx.showToast({
      title: content,
      icon: 'none',
      duration: 3000
    });
  },

  getArchiveStoreId: function (order) {
    const queryUser = this.getOrderQueryUserContext();
    return order.storeId || order.store_id || (userUtils.isStoreScoped(queryUser) ? queryUser.storeId || '' : '');
  },

  getArchiveSnCode: function (item) {
    return normalizeSnCode(item && item.snCode);
  },

  getArchivePnCode: function (item) {
    const pnCode = item.pnCode || '';
    return typeof pnCode === 'string' ? pnCode.trim() : String(pnCode || '').trim();
  },

  getArchiveInventoryId: function (item) {
    return normalizeId(item && item.inventoryId);
  },

  getArchiveSnDebugRows: function (goods) {
    return (goods || []).map((item, index) => ({
      index: index + 1,
      productName: item.productName || item.name || '',
      pnCode: item.pnCode || '',
      snCode: item.snCode || '',
      inventoryId: item.inventoryId || ''
    }));
  },

  logArchiveSnDebug: function (label, goods) {
    console.log(label, this.getArchiveSnDebugRows(goods));
  },

  getArchiveNumber: function (value) {
    const text = String(value === undefined || value === null ? '' : value).replace(/[^\d.-]/g, '');
    const num = parseFloat(text);
    return isNaN(num) ? 0 : num;
  },

  getArchiveInvoiceInfo: function (orderNo, order) {
    const listOrder = (this.data.orders || []).find(item => item.orderNo === orderNo) || {};
    const filteredOrder = (this.data.filteredOrders || []).find(item => item.orderNo === orderNo) || {};
    const overrideOrder = (this.getLocalOrderOverrides() || {})[orderNo] || {};
    const source = order || {};
    const invoiceStatus = this.pickArchiveValue(
      source.invoiceStatus, source.invoice_status,
      listOrder.invoiceStatus, listOrder.invoice_status,
      filteredOrder.invoiceStatus, filteredOrder.invoice_status,
      overrideOrder.invoiceStatus, overrideOrder.invoice_status,
      '不开票'
    );
    const invoiceAmount = this.pickArchiveValue(
      source.invoiceAmount, source.invoice_amount,
      listOrder.invoiceAmount, listOrder.invoice_amount,
      filteredOrder.invoiceAmount, filteredOrder.invoice_amount,
      overrideOrder.invoiceAmount, overrideOrder.invoice_amount
    );
    const fallbackAmount = this.pickArchiveValue(
      source.actualAmount, source.actualPayment, source.paymentTotal, source.totalAmount,
      listOrder.actualAmount, listOrder.actualPayment, listOrder.paymentTotal, listOrder.totalAmount,
      filteredOrder.actualAmount, filteredOrder.actualPayment, filteredOrder.paymentTotal, filteredOrder.totalAmount,
      overrideOrder.actualAmount, overrideOrder.actualPayment, overrideOrder.paymentTotal, overrideOrder.totalAmount
    );
    const invoiceInfo = this.pickArchiveValue(
      source.invoiceInfo, source.invoice_info,
      listOrder.invoiceInfo, listOrder.invoice_info,
      filteredOrder.invoiceInfo, filteredOrder.invoice_info,
      overrideOrder.invoiceInfo, overrideOrder.invoice_info
    );
    const amountNum = this.getArchiveNumber(invoiceAmount);
    const finalAmount = amountNum > 0 ? invoiceAmount : fallbackAmount;

    return {
      invoiceStatus: String(invoiceStatus || '不开票').trim(),
      invoiceAmount: finalAmount,
      invoiceAmountNum: this.getArchiveNumber(finalAmount),
      invoiceInfo: invoiceInfo || ''
    };
  },

  isArchiveSellableStock: function (stockItem) {
    const status = stockItem.status !== undefined && stockItem.status !== ''
      ? stockItem.status
      : (stockItem.inventoryStatus !== undefined && stockItem.inventoryStatus !== ''
        ? stockItem.inventoryStatus
        : stockItem.inventory_status);

    if (status === undefined || status === null || status === '') {
      return true;
    }
    if (status === true || status === 1) {
      return true;
    }

    const normalized = String(status).trim().toLowerCase();
    if (['occupied', 'reserved', '占用中', '已占用'].indexOf(normalized) >= 0) {
      return true;
    }
    return ['1', 'in_stock', 'instock', 'available', 'normal', 'sellable', 'on_hand', '在库', '可售'].indexOf(normalized) >= 0;
  },

  pickArchiveValue: function () {
    for (let i = 0; i < arguments.length; i++) {
      const value = arguments[i];
      if (value === undefined || value === null) continue;
      if (typeof value === 'string' && value.trim() === '') continue;
      return value;
    }
    return '';
  },

  normalizeArchiveGoodsItem: function (primary, fallback) {
    const merged = Object.assign({}, fallback || {}, primary || {});
    const normalized = normalizeOrderItem(merged);
    return Object.assign({}, normalized, {
      // 仅供历史模板显示，提交和校验仍只读取标准字段。
      name: normalized.productName,
      price: normalized.unitPrice
    });
  },

  getArchiveGoods: function (order) {
    const latestOrder = this.applyLocalOrderOverride(order);
    const goodsRows = latestOrder.goods || [];
    const itemRows = latestOrder.items || [];
    const rowCount = Math.max(goodsRows.length, itemRows.length);

    if (!rowCount) return [];

    return Array.from({ length: rowCount }).map((_, index) => {
      const goodsItem = goodsRows[index] || {};
      const orderItem = itemRows[index] || {};
      const primary = this.getArchiveSnCode(goodsItem) || this.getArchivePnCode(goodsItem) ? goodsItem : orderItem;
      const fallback = primary === goodsItem ? orderItem : goodsItem;
      return this.normalizeArchiveGoodsItem(primary, fallback);
    }).filter(item => !isEmptyOrderItem(item));
  },

  fetchLatestArchiveOrder: function (orderNo, fallbackOrder) {
    const listOrder = this.data.orders.find(o => o.orderNo === orderNo) || {};
    const filteredOrder = this.data.filteredOrders.find(o => o.orderNo === orderNo) || {};
    const overrideOrder = (this.getLocalOrderOverrides() || {})[orderNo] || {};
    const localOrder = Object.assign({}, listOrder, filteredOrder, fallbackOrder || {}, overrideOrder);

    return wx.cloud.callFunction({
      name: 'queryOrders',
      data: {
        action: 'getOrderByNo',
        data: { orderNo: orderNo }
      }
    }).then(res => {
      if (res.result && res.result.code === 0 && res.result.data) {
        const remoteOrder = res.result.data || {};
        const latestOrder = Object.assign({}, localOrder || {}, remoteOrder);
        const remoteGoods = remoteOrder.goods || [];
        const remoteItems = remoteOrder.items || [];
        const localGoods = localOrder && localOrder.goods ? localOrder.goods : [];
        const localItems = localOrder && localOrder.items ? localOrder.items : [];
        const goodsCount = Math.max(remoteGoods.length, localGoods.length);
        const itemsCount = Math.max(remoteItems.length, localItems.length);

        if (goodsCount) {
          latestOrder.goods = Array.from({ length: goodsCount }).map((_, index) => {
            return this.normalizeArchiveGoodsItem(remoteGoods[index] || {}, localGoods[index] || {});
          });
        }
        if (itemsCount) {
          latestOrder.items = Array.from({ length: itemsCount }).map((_, index) => {
            return this.normalizeArchiveGoodsItem(remoteItems[index] || {}, localItems[index] || {});
          });
        }

        const orders = this.data.orders.map(order => {
          if (order.orderNo === orderNo) {
            return Object.assign({}, order, latestOrder);
          }
          return order;
        });

        const filteredOrders = this.data.filteredOrders.map(order => {
          if (order.orderNo === orderNo) {
            return Object.assign({}, order, latestOrder);
          }
          return order;
        });

        this.setData({
          orders: orders,
          filteredOrders: filteredOrders
        });

        return latestOrder;
      }

      return localOrder;
    }).catch(err => {
      console.warn('归档前刷新订单失败，使用当前列表数据:', err);
      return localOrder;
    });
  },

  validateArchiveSellableInventory: function (order, goods) {
    const storeId = this.getArchiveStoreId(order);
    const seenSn = {};

    // 历史订单可能只有 productId，没有保存商品主表的 PN 快照。
    // 归档前按 productId 回查 PN，并回填当前订单对象，避免把“主表有 PN、订单明细无 PN”误判为缺少 PN。
    const prepareGoods = Promise.all((goods || []).map(goodsItem => {
      if (this.getArchivePnCode(goodsItem) || !goodsItem.productId) return Promise.resolve(goodsItem);
      return api.product.getPns(goodsItem.productId, storeId)
        .then(rows => {
          const pnCode = (rows || []).map(row => this.getArchivePnCode(row)).find(Boolean) || '';
          if (pnCode) goodsItem.pnCode = pnCode;
          return goodsItem;
        })
        .catch(() => goodsItem);
    }));

    return prepareGoods.then(preparedGoods => {
    const checks = preparedGoods.map((goodsItem, index) => {
      goodsItem = goodsItem || {};
      const pnCode = this.getArchivePnCode(goodsItem);
      const snCode = this.getArchiveSnCode(goodsItem);
      if (!pnCode) {
        const label = goodsItem.productName || goodsItem.name || goodsItem.productId || '';
        return Promise.reject(new Error(label
          ? `商品${index + 1}（${label}）缺少PN码，不能归档`
          : `商品${index + 1}没有商品ID和PN码，不能归档`));
      }

      if (snCode) {
        const normalizedSn = snCode.toLowerCase();
        if (seenSn[normalizedSn]) {
          return Promise.reject(new Error(`商品${index + 1}的SN码与其他商品重复`));
        }
        seenSn[normalizedSn] = true;
      }

      return api.inventory.getGoodsByPNDetailed(pnCode, storeId)
        .then(lookup => {
          const lookupProduct = lookup && lookup.product;
          const lookupProductId = lookupProduct && lookupProduct.productId;
          const searchProductPromise = (!lookupProduct || !lookupProductId)
            ? api.product.search(pnCode, { storeId, page: 1, pageSize: 20 })
              .then(rows => (rows || []).find(row => {
                const rowPn = this.getArchivePnCode(row);
                return rowPn && rowPn.toLowerCase() === pnCode.toLowerCase();
              }) || null)
              .catch(() => null)
            : Promise.resolve(null);

          return searchProductPromise.then(searchProduct => {
          const product = searchProduct || lookupProduct;
          const productPnCode = this.getArchivePnCode(product || {});
          if (!product) {
            const diagnostics = lookup && lookup.diagnostics || {};
            const attempts = diagnostics.attempts || [];
            const errors = attempts.filter(item => item.error).map(item => item.source + ': ' + item.error);
            const candidatePns = (diagnostics.candidatePns || []).slice(0, 8);
            const reason = errors.length
              ? `商品${index + 1}的PN查询接口异常：${errors.join('；')}`
              : (candidatePns.length
                ? `商品${index + 1}的PN未精确匹配：请求PN=${pnCode}，接口返回候选PN=${candidatePns.join('、')}`
                : `商品${index + 1}的PN未查询到：PN=${pnCode}，门店=${diagnostics.storeId || '未指定'}；已查询门店和商品主表`);
            const error = new Error(reason);
            error.archiveLookup = diagnostics;
            console.error('归档PN查询诊断:', { pnCode, snCode, storeId, diagnostics });
            throw error;
          }
          if (!product || !productPnCode || productPnCode.toLowerCase() !== pnCode.toLowerCase()) {
            throw new Error(`商品${index + 1}的PN码不存在`);
          }

          goodsItem.pnCode = productPnCode;
          goodsItem.productId = goodsItem.productId || product.productId || '';
          if (product.needSn !== undefined) {
            goodsItem.needSn = product.needSn;
          }

          const needSnValue = goodsItem.needSn;
          const needSn = needSnValue === true || needSnValue === 1 ||
            ['1', 'true', 'yes'].indexOf(String(needSnValue || '').trim().toLowerCase()) >= 0;
          if (!snCode) {
            if (needSn) {
              throw new Error(`请先填写商品${index + 1}的SN码`);
            }
            return null;
          }

          const productId = goodsItem.productId || product.productId || '';
          return api.inventory.getGoodsBySNDetailed(snCode, storeId, productId)
            .then(lookup => {
              const stockItem = lookup && lookup.product;
              if (!stockItem) {
                const diagnostics = lookup && lookup.diagnostics || {};
                const attempts = diagnostics.attempts || [];
                const errors = attempts.filter(item => item.error).map(item => item.source + ': ' + item.error);
                const candidates = diagnostics.candidates || [];
                const reason = errors.length
                  ? `商品${index + 1}的SN查询接口异常：${errors.join('；')}`
                  : (candidates.length
                    ? `商品${index + 1}的SN未匹配：请求SN=${snCode}，接口返回${candidates.length}条候选记录但没有精确匹配`
                    : `商品${index + 1}的SN未查询到：SN=${snCode}，当前门店=${storeId || '未指定'}；已查询门店和全局库存`);
                const error = new Error(reason);
                error.archiveLookup = diagnostics;
                console.error('归档SN查询诊断:', { pnCode, snCode, storeId, productId, diagnostics });
                throw error;
              }
              return stockItem;
              // 当前门店未找到时再做全门店精确查询，以便区分“不存在”和“门店不匹配”。
                return api.inventory.getGoodsBySN(snCode, '', productId);
            });
          });
        })
        .then(stockItem => {
          if (!snCode) return stockItem;
          const stockSnCode = this.getArchiveSnCode(stockItem || {});
          const stockPnCode = this.getArchivePnCode(stockItem || {});
          if (!stockItem || !stockSnCode || stockSnCode.toLowerCase() !== snCode.toLowerCase()) {
            throw new Error(`商品${index + 1}的SN码不存在`);
          }
          if (stockPnCode && stockPnCode.toLowerCase() !== this.getArchivePnCode(goodsItem).toLowerCase()) {
            throw new Error(`商品${index + 1}的SN与PN不匹配：SN=${stockSnCode}对应PN=${stockPnCode}，订单PN=${this.getArchivePnCode(goodsItem)}`);
          }
          const stockStoreId = stockItem.storeId || '';
          if (stockStoreId && storeId && String(stockStoreId) !== String(storeId)) {
            throw new Error(`商品${index + 1}的SN不属于当前门店：库存门店=${stockStoreId}，订单门店=${storeId}`);
          }
          if (!this.isArchiveSellableStock(stockItem)) {
            const currentStatus = stockItem.status || stockItem.inventoryStatus || stockItem.inventory_status || '未知';
            throw new Error(`商品${index + 1}的SN当前不可归档：库存状态=${currentStatus}`);
          }
          const inventoryId = this.getArchiveInventoryId(stockItem) || stockSnCode || snCode;
          if (inventoryId && goods[index]) {
            goods[index].inventoryId = inventoryId;
            goods[index].snCode = stockSnCode;
            goods[index].productId = goods[index].productId || stockItem.productId || '';
          }
          return stockItem;
        })
        .catch(err => {
          console.error('归档PN/SN校验失败:', { pnCode, snCode }, err);
          throw err;
        });
    });

    return Promise.all(checks);
    });
  },

  confirmArchiveOrder: function (orderNo, goods, order) {
    const profit = calculateOrderProfit(order, goods);
    const needsApproval = profit.isBelowMinimum;
    wx.showModal({
      title: '归档订单',
      content: needsApproval
        ? `请注意，该单国补、教育优惠前应收 ¥${profit.receivable.toFixed(2)} 低于所有商品最低销售价合计 ¥${profit.minimumSalePriceTotal.toFixed(2)}，归档时将触发审核流程，需店长或经销商老板账号审批。确定提交审批吗？`
        : `确定要归档订单 ${orderNo} 吗？`,
      confirmText: needsApproval ? '提交审批' : '确定归档',
      cancelText: '取消',
      success: (modalRes) => {
        if (modalRes.confirm) {
          wx.showLoading({
            title: '处理中...',
          });

          const queryUser = this.getOrderQueryUserContext();
          const archiveStoreId = this.getArchiveStoreId(order);
          const invoice = this.getArchiveInvoiceInfo(orderNo, order);
          this.logArchiveSnDebug('归档提交 - SN字段:', goods);
          console.log('归档提交 - items:', JSON.stringify(goods));
          console.log('归档提交 - invoice:', invoice);
          // 使用云函数更新订单状态
          wx.cloud.callFunction({
            name: 'queryOrders',
            data: {
              action: 'updateOrderStatus',
              data: {
                orderNo: orderNo,
                orderId: order.orderId || order._id || order.order_id || '',
                status: needsApproval ? 'pending_approval' : '已归档',
                snStatusAction: needsApproval ? '' : 'sell',
                targetSnStatus: needsApproval ? '' : '已销售',
                inventoryStatusAction: needsApproval ? '' : 'sell',
                targetInventoryStatus: needsApproval ? '' : '已销售',
                items: goods,
                goods: goods,
                depositItems: order.depositItems || order.deposit_items || order.deposits || [],
                deposits: order.depositItems || order.deposit_items || order.deposits || [],
                invoiceStatus: invoice.invoiceStatus,
                invoice_status: invoice.invoiceStatus,
                invoiceAmount: invoice.invoiceAmount,
                invoice_amount: invoice.invoiceAmount,
                invoiceInfo: invoice.invoiceInfo,
                invoice_info: invoice.invoiceInfo,
                actualAmount: order.actualAmount || order.actualPayment || order.actual_payment || order.actual_amount,
                totalAmount: order.totalAmount || order.total_amount,
                discount: order.discount || order.discountAmount || order.discount_amount,
                receivableBeforeSubsidy: profit.receivable,
                grossProfit: profit.grossProfit,
                pricingTotal: profit.pricingTotal,
                pricing_total: profit.pricingTotal,
                costTotal: profit.costTotal,
                cost_total: profit.costTotal,
                minimumSalePriceTotal: profit.minimumSalePriceTotal,
                minimum_sale_price_total: profit.minimumSalePriceTotal,
                requiresGrossProfitApproval: needsApproval,
                requires_gross_profit_approval: needsApproval,
                approvalType: needsApproval ? 'below_min_sale_price' : '',
                approval_type: needsApproval ? 'below_min_sale_price' : '',
                userRole: queryUser.userRole,
                userName: queryUser.userName,
                storeId: archiveStoreId
              }
            }
          }).then(res => {
            wx.hideLoading();
            if (res.result && res.result.code === 0) {
              wx.showToast({
                title: needsApproval ? '已提交审批' : '订单归档成功',
                icon: needsApproval ? 'none' : 'success'
              });
              // 只更新当前订单状态，不刷新整个列表
              const nextStatus = res.result.data && res.result.data.status || '已归档';
              this.updateOrderStatusInList(orderNo, nextStatus);
            } else {
              console.error('订单归档失败:', res.result);
              this.showArchiveError(res.result || res);
            }
          }).catch(err => {
            wx.hideLoading();
            console.error('订单归档失败:', err);
            this.showArchiveError(err);
          });
        }
      }
    });
  },

  /**
   * 归档订单
   */
  archiveOrder: function (e) {
    const orderNo = e.currentTarget.dataset.orderno;
    const clickedOrder = e.currentTarget.dataset.order || {};
    if (clickedOrder.record_type === 'deposit' || clickedOrder.recordType === 'deposit' || clickedOrder.status === 'deposit_receipt') {
      return;
    }
    this.logArchiveSnDebug('归档点击订单 - SN字段:', clickedOrder.goods || clickedOrder.items || []);

    wx.showLoading({ title: '加载订单...' });
    this.fetchLatestArchiveOrder(orderNo, clickedOrder)
      .then(order => {
        wx.hideLoading();
        this.archiveOrderWithData(orderNo, order);
      })
      .catch(err => {
        wx.hideLoading();
        console.error('归档前加载订单失败:', err);
        this.showArchiveError(err);
      });
  },

  archiveOrderWithData: function (orderNo, order) {
    if (!order) {
      wx.showToast({ title: '订单数据不存在', icon: 'none' });
      return;
    }

    // 调试日志
    console.log('归档验证 - 订单号:', orderNo);
    console.log('归档验证 - 客户来源:', order.customerSource);
    console.log('归档验证 - goods:', order.goods);
    console.log('归档验证 - items:', order.items);

    // 验证客户来源
    if (!order.customerSource || !order.customerSource.trim()) {
      wx.showToast({ title: '请先补充客户来源后再归档', icon: 'none', duration: 2000 });
      return;
    }

    // 验证PN码 - 优先使用 items 数组（数据库原始数据），其次使用 goods 数组
    const goods = this.getArchiveGoods(order);
    console.log('归档验证 - 检查商品列表:', goods);
    this.logArchiveSnDebug('归档验证 - SN字段:', goods);
    if (goods.length === 0) {
      wx.showToast({ title: '订单中没有商品，无法归档', icon: 'none', duration: 2000 });
      return;
    }
    for (let i = 0; i < goods.length; i++) {
      const item = goods[i];
      // 确保 pnCode 是字符串类型
      let pnCode = this.getArchivePnCode(item);
      // 如果不是字符串，转换为字符串
      if (typeof pnCode !== 'string') {
        pnCode = String(pnCode);
      }
      console.log(`归档验证 - 商品${i + 1} PN码:`, pnCode);
      if ((!pnCode || !pnCode.trim()) && !item.productId) {
        wx.showToast({ title: `请先补充商品${i + 1}的PN码后再归档`, icon: 'none', duration: 2000 });
        return;
      }
    }

    // 验证开票信息（如果需要开票）
    const invoice = this.getArchiveInvoiceInfo(orderNo, order);
    console.log('归档验证 - 开票信息:', invoice);
    if (invoice.invoiceStatus === '开专票' || invoice.invoiceStatus === '开普票') {
      if (invoice.invoiceAmountNum <= 0) {
        wx.showToast({ title: '请先填写开票金额后再归档', icon: 'none', duration: 2000 });
        return;
      }
    }

    wx.showLoading({ title: '检查库存...' });
    this.validateArchiveSellableInventory(order, goods)
      .then(() => {
        wx.hideLoading();
        this.logArchiveSnDebug('归档库存校验后 - SN字段:', goods);
        this.confirmArchiveOrder(orderNo, goods, order);
      })
      .catch(err => {
        wx.hideLoading();
        console.error('归档库存校验失败:', err);
        wx.showModal({
          title: '归档失败',
          content: err.message || '当前SN不可售，请确认是否采购已完成。',
          showCancel: false,
          confirmText: '知道了'
        });
      });
  },

  /**
   * 更新订单列表中指定订单的状态（不刷新整个列表）
   * @param {string} orderNo - 订单编号
   * @param {string} newStatus - 新状态
   */
  updateOrderStatusInList: function (orderNo, newStatus) {
    const orders = this.data.orders;
    const filteredOrders = this.data.filteredOrders;
    const refreshDisplayAmounts = (order) => {
      if (!order) return;
      const actualAmount = this.calculateListActualAmount(order);
      const paymentTotal = this.resolveListPaymentTotal(order, actualAmount);
      order.actualAmount = actualAmount.toFixed(2);
      order.actualPayment = actualAmount.toFixed(2);
      order.paymentTotal = paymentTotal.toFixed(2);
    };

    // 更新主订单列表
    const orderIndex = orders.findIndex(item => item.orderNo === orderNo);
    if (orderIndex !== -1) {
      orders[orderIndex].status = newStatus;
      refreshDisplayAmounts(orders[orderIndex]);
      // 如果订单已作废或已归档，根据当前筛选条件可能需要隐藏
      const currentStatus = this.data.searchParams.status;
      if (currentStatus && currentStatus !== '全部' && currentStatus !== newStatus) {
        // 当前筛选条件不匹配新状态，从列表中移除
        orders.splice(orderIndex, 1);
      }
    }

    // 更新筛选后的订单列表
    const filteredIndex = filteredOrders.findIndex(item => item.orderNo === orderNo);
    if (filteredIndex !== -1) {
      filteredOrders[filteredIndex].status = newStatus;
      refreshDisplayAmounts(filteredOrders[filteredIndex]);
      const currentStatus = this.data.searchParams.status;
      if (currentStatus && currentStatus !== '全部' && currentStatus !== newStatus) {
        // 当前筛选条件不匹配新状态，从列表中移除
        filteredOrders.splice(filteredIndex, 1);
      }
    }

    // 更新数据
    this.setData({
      orders: orders,
      filteredOrders: filteredOrders
    });
  },

  /**
   * 更新订单列表中指定订单的补录信息（不刷新整个列表）
   * @param {string} orderNo - 订单编号
   * @param {Object} supplementRecord - 补录记录
   */
  updateOrderSupplementInList: function (orderNo, supplementRecord) {
    const orders = this.data.orders;
    const filteredOrders = this.data.filteredOrders;

    // 更新主订单列表
    const orderIndex = orders.findIndex(item => item.orderNo === orderNo);
    if (orderIndex !== -1) {
      const order = orders[orderIndex];
      // 初始化 supplements 数组
      if (!order.supplements) {
        order.supplements = [];
      }
      // 添加新的补录记录
      order.supplements.push(supplementRecord);
      // 计算补录总金额
      order.supplementTotal = order.supplements.reduce((sum, item) => sum + (item.amount || 0), 0);
    }

    // 更新筛选后的订单列表
    const filteredIndex = filteredOrders.findIndex(item => item.orderNo === orderNo);
    if (filteredIndex !== -1) {
      const order = filteredOrders[filteredIndex];
      // 初始化 supplements 数组
      if (!order.supplements) {
        order.supplements = [];
      }
      // 添加新的补录记录
      order.supplements.push(supplementRecord);
      // 计算补录总金额
      order.supplementTotal = order.supplements.reduce((sum, item) => sum + (item.amount || 0), 0);
    }

    // 更新数据
    this.setData({
      orders: orders,
      filteredOrders: filteredOrders
    });
  },

  /**
   * 检查用户是否有权限操作订单
   * @param {Object} order - 订单对象
   * @returns {boolean} - 是否有权限
   */
  canOperateOrder: function (order) {
    // 与列表加载使用同一套规范化权限判断，兼容 MySQL API 的创建人/创建人ID字段。
    const queryUser = this.getOrderQueryUserContext();
    if (!queryUser.hasRealUser || queryUser.userRole === 'distributor') return true;
    const orderStoreId = order && (order.storeId || order.store_id || '');
    if (queryUser.userRole === 'store_admin') {
      return !orderStoreId || String(orderStoreId) === String(queryUser.storeId || '');
    }
    const orderCreator = String(order && (
      order.createUser || order.create_user || order.creatorName || order.creator_name ||
      order.createdByName || order.created_by_name || order.userName || order.user_name || ''
    )).trim();
    const orderCreatorId = String(order && (
      order.createUserId || order.create_user_id || order.creatorId || order.creator_id ||
      order.userId || order.user_id || ''
    )).trim();
    if ((orderCreator && queryUser.userName && orderCreator === String(queryUser.userName).trim()) ||
      (orderCreatorId && queryUser.userId && orderCreatorId === String(queryUser.userId).trim()) ||
      (!orderCreator && !orderCreatorId)) return true;
    // 使用 userUtils 检查权限，确保一致性
    if (userUtils.isDistributor()) {
      return true;
    }

    const userInfo = this.data.userInfo;

    // 店长可以操作自己门店的所有订单
    if (userUtils.isStoreAdmin()) {
      return String(order.storeId || order.store_id || '') === String(this.getOrderQueryUserContext().storeId || '');
    }

    // 普通员工只能操作自己的订单
    return order.createUser === userInfo.userName;
  },

  /**
   * 显示金额补录弹窗
   */
  showSupplementModal: function (e) {
    const order = e.currentTarget.dataset.order;

    // 检查权限
    if (!this.canOperateOrder(order)) {
      wx.showToast({
        title: '无权操作此订单',
        icon: 'none'
      });
      return;
    }

    // 已归档和未归档的订单都允许金额补录
    // 先加载补录项目列表，然后再初始化补录记录
    this.loadSupplementItems(() => {
      // 检查是否已有补录记录
      const hasSupplements = order.supplements && order.supplements.length > 0;
      
      // 初始化补录记录列表
      let supplementRecords = [];
      if (hasSupplements) {
        // 加载已有的补录记录
        supplementRecords = order.supplements.map(sup => {
          // 查找对应项目的amountType
          const supplementItems = this.data.supplementItems;
          const matchedItem = supplementItems.find(item => item.name === sup.itemName);
          const amountType = matchedItem ? (matchedItem.amountType || 'increase') : 'increase';

          return {
            selectedSupplementIndex: 0,
            selectedSupplementItem: sup.itemName || '',
            supplementAmount: String(sup.amount || ''),
            supplementContent: sup.content || '',
            supplementPhotoUrl: sup.proofPhotoUrl || '',
            amountType: amountType
          };
        });
      } else {
        // 新建时添加一个空的补录记录
        const supplementItems = this.data.supplementItems;
        const defaultType = (supplementItems && supplementItems.length > 0) ?
          (supplementItems[0].amountType || 'increase') : 'increase';

        supplementRecords = [{
          selectedSupplementIndex: 0,
          selectedSupplementItem: '',
          supplementAmount: '',
          supplementContent: '',
          supplementPhotoUrl: '',
          amountType: defaultType
        }];
      }

      this.setData({
        showSupplementModal: true,
        currentOrder: order,
        supplementRecords: supplementRecords,
        isEditMode: hasSupplements // 标记是否为编辑模式
      });
    });
  },

  /**
   * 关闭金额补录弹窗
   */
  closeSupplementModal: function () {
    this.setData({
      showSupplementModal: false,
      currentOrder: {},
      supplementRecords: [],
      isEditMode: false
    });
  },

  /**
   * 添加新的补录记录
   */
  addSupplementRecord: function () {
    const supplementRecords = this.data.supplementRecords;
    // 获取第一个补录项目的类型作为默认值
    const supplementItems = this.data.supplementItems;
    const defaultType = (supplementItems && supplementItems.length > 0) ? 
      (supplementItems[0].amountType || 'increase') : 'increase';
    
    supplementRecords.push({
      selectedSupplementIndex: 0,
      selectedSupplementItem: '',
      supplementAmount: '',
      supplementPhotoUrl: '',
      amountType: defaultType
    });
    this.setData({
      supplementRecords: supplementRecords
    });
  },

  /**
   * 删除补录记录
   */
  deleteSupplementRecord: function (e) {
    const index = e.currentTarget.dataset.index;
    const supplementRecords = this.data.supplementRecords;
    
    if (supplementRecords.length > 1) {
      supplementRecords.splice(index, 1);
      this.setData({
        supplementRecords: supplementRecords
      });
    } else {
      wx.showToast({
        title: '至少保留一条补录记录',
        icon: 'none'
      });
    }
  },

  /**
   * 补录项目选择变化
   */
  onSupplementItemChange: function (e) {
    const index = e.currentTarget.dataset.index;
    const selectedIndex = e.detail.value;
    const supplementItems = this.data.supplementItems;
    
    console.log('选择补录项目:', selectedIndex, supplementItems[selectedIndex]);
    
    // 创建新的数组引用，确保页面实时更新
    const supplementRecords = [...this.data.supplementRecords];
    supplementRecords[index].selectedSupplementIndex = selectedIndex;
    supplementRecords[index].selectedSupplementItem = supplementItems[selectedIndex].name;
    // 记录项目的金额类型（增加/减少）
    const amountType = supplementItems[selectedIndex].amountType || 'increase';
    supplementRecords[index].amountType = amountType;
    
    console.log('设置amountType:', amountType);
    
    this.setData({
      supplementRecords: supplementRecords
    });
  },

  /**
   * 补录金额输入
   */
  onSupplementAmountInput: function (e) {
    const index = e.currentTarget.dataset.index;
    const value = e.detail.value;

    const supplementRecords = this.data.supplementRecords;
    supplementRecords[index].supplementAmount = value;

    this.setData({
      supplementRecords: supplementRecords
    });
  },

  /**
   * 补录内容输入
   */
  onSupplementContentInput: function (e) {
    const index = e.currentTarget.dataset.index;
    const value = e.detail.value;

    const supplementRecords = this.data.supplementRecords;
    supplementRecords[index].supplementContent = value;

    this.setData({
      supplementRecords: supplementRecords
    });
  },

  /**
   * 上传补录证明材料
   */
  uploadSupplementPhoto: function (e) {
    const index = e.currentTarget.dataset.index;
    const that = this;

    wx.chooseImage({
      count: 1,
      sizeType: ['original'],
      sourceType: ['album', 'camera'],
      success: function (res) {
        const tempFilePath = res.tempFilePaths[0];
        
        // 获取当前时间和客户名称
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hour = String(now.getHours()).padStart(2, '0');
        const minute = String(now.getMinutes()).padStart(2, '0');
        const second = String(now.getSeconds()).padStart(2, '0');
        const dateTimeStr = `${year}${month}${day}${hour}${minute}${second}`;
        
        // 获取客户名称和补录项目
        const currentOrder = that.data.currentOrder || {};
        const customerName = currentOrder.contactName || currentOrder.customerName || '未知客户';
        const supplementRecords = that.data.supplementRecords;
        const supplementItem = supplementRecords[index].selectedSupplementItem || '补录凭证';
        
        // 过滤文件名中的特殊字符（移除空格和+号避免URL编码问题）
        const sanitizeFileName = (str) => {
          return str.replace(/[\\/:*?"<>|、，,\s+]/g, '');
        };
        
        // 构建文件名：YYYYMMDDHHmmSS_姓名_补录项目.jpg
        const photoName = `${dateTimeStr}_${sanitizeFileName(customerName)}_${sanitizeFileName(supplementItem)}.jpg`;
        const cloudPath = `supplement-proofs/${photoName}`;
        
        wx.cloud.uploadFile({
          cloudPath: cloudPath,
          filePath: tempFilePath,
          success: function (uploadRes) {
            supplementRecords[index].supplementPhotoUrl = uploadRes.fileID;
            
            that.setData({
              supplementRecords: supplementRecords
            });
            
            wx.showToast({
              title: '上传成功',
              icon: 'success'
            });
          },
          fail: function (err) {
            console.error('上传失败:', err);
            wx.showToast({
              title: '上传失败',
              icon: 'none'
            });
          }
        });
      }
    });
  },

  /**
   * 删除补录证明材料
   */
  deleteSupplementPhoto: function (e) {
    const index = e.currentTarget.dataset.index;
    
    const supplementRecords = this.data.supplementRecords;
    supplementRecords[index].supplementPhotoUrl = '';
    
    this.setData({
      supplementRecords: supplementRecords
    });
  },

  /**
   * 加载补录项目列表（直接查询数据库）
   * @param {Function} callback - 加载完成后的回调函数
   */
  loadSupplementItems: function (callback) {
    const db = wx.cloud.database();

    console.log('开始查询补录项目...');

    // 先尝试不加条件查询所有数据，按sortOrder排序
    db.collection('supplementItems')
      .orderBy('sortOrder', 'asc')
      .get()
      .then(res => {
        console.log('补录项目原始查询结果:', res);
        let items = res.data || [];

        // 如果数据库中没有 isActive 字段，不过滤
        const activeItems = items.filter(item => item.isActive !== false);

        const itemNames = activeItems.map(item => item.name);

        console.log('处理后的补录项目:', activeItems);
        console.log('补录项目名称列表:', itemNames);

        this.setData({
          supplementItems: activeItems,
          supplementItemNames: itemNames
        }, () => {
          // 数据设置完成后执行回调
          if (typeof callback === 'function') {
            callback();
          }
        });

        if (activeItems.length === 0) {
          wx.showToast({
            title: '未找到补录项目，请先添加',
            icon: 'none',
            duration: 2000
          });
        }
      })
      .catch(err => {
        console.error('获取补录项目失败:', err);
        wx.showToast({
          title: '获取补录项目失败: ' + (err.message || '未知错误'),
          icon: 'none'
        });
      });
  },

  /**
   * 补录项目选择变化
   */
  onSupplementItemChange: function (e) {
    const recordIndex = e.currentTarget.dataset.index;
    const selectedIndex = e.detail.value;
    const itemName = this.data.supplementItemNames[selectedIndex];

    const supplementRecords = this.data.supplementRecords;
    supplementRecords[recordIndex].selectedSupplementIndex = selectedIndex;
    supplementRecords[recordIndex].selectedSupplementItem = itemName;

    this.setData({
      supplementRecords: supplementRecords
    });
  },

  /**
   * 补录金额输入
   */
  onSupplementAmountInput: function (e) {
    const index = e.currentTarget.dataset.index;
    const value = e.detail.value;

    const supplementRecords = this.data.supplementRecords;
    supplementRecords[index].supplementAmount = value;

    this.setData({
      supplementRecords: supplementRecords
    });
  },

  /**
   * 预览补录证明材料
   */
  previewSupplementPhoto: function (e) {
    const index = e.currentTarget.dataset.index;
    const supplementRecords = this.data.supplementRecords;
    const photoUrl = supplementRecords[index].supplementPhotoUrl;

    if (photoUrl) {
      wx.previewImage({
        urls: [photoUrl],
        current: photoUrl
      });
    }
  },

  /**
   * 提交金额补录（直接操作数据库）
   */
  submitSupplement: function () {
    const { currentOrder, supplementRecords, userInfo, isEditMode } = this.data;

    // 验证所有补录记录
    for (let i = 0; i < supplementRecords.length; i++) {
      const record = supplementRecords[i];
      if (!record.selectedSupplementItem) {
        wx.showToast({
          title: `补录项目${i + 1}：请选择补录项目`,
          icon: 'none'
        });
        return;
      }

      if (!record.supplementAmount || parseFloat(record.supplementAmount) <= 0) {
        wx.showToast({
          title: `补录项目${i + 1}：请输入有效的补录金额`,
          icon: 'none'
        });
        return;
      }
    }

    wx.showLoading({
      title: isEditMode ? '修改中...' : '提交中...',
    });

    const db = wx.cloud.database();
    const now = new Date();

    // 构建补录记录数组
    const newSupplementRecords = supplementRecords.map(record => ({
      itemName: record.selectedSupplementItem,
      amount: parseFloat(record.supplementAmount),
      content: record.supplementContent || '',
      proofPhotoUrl: record.supplementPhotoUrl || '',
      createUser: userInfo.userName || '未知用户',
      createTime: now.getTime(),
      createDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    }));

    // 先查询订单获取现有的补录记录
    db.collection('orders')
      .where({ orderNo: currentOrder.orderNo })
      .limit(1)
      .get()
      .then(res => {
        if (!res.data || res.data.length === 0) {
          wx.hideLoading();
          wx.showToast({
            title: '订单不存在',
            icon: 'none'
          });
          return;
        }

        const order = res.data[0];
        const orderDocId = order._id;

        let allSupplements;
        if (isEditMode) {
          // 编辑模式：直接替换所有补录记录
          allSupplements = newSupplementRecords;
        } else {
          // 新增模式：追加到现有记录
          const existingSupplements = order.supplements || [];
          allSupplements = [...existingSupplements, ...newSupplementRecords];
        }

        // 计算补录总金额
        const supplementTotal = allSupplements.reduce((sum, item) => sum + (item.amount || 0), 0);

        // 更新订单
        return db.collection('orders').doc(orderDocId).update({
          data: {
            supplements: allSupplements,
            supplementTotal: supplementTotal,
            updateTime: now.getTime()
          }
        });
      })
      .then(() => {
        wx.hideLoading();
        wx.showToast({
          title: isEditMode ? '修改成功' : `成功补录${newSupplementRecords.length}个项目`,
          icon: 'success'
        });

        // 关闭弹窗
        this.closeSupplementModal();

        // 更新列表中的订单数据
        if (isEditMode) {
          // 编辑模式：替换所有补录记录
          this.replaceOrderSupplementsInList(currentOrder.orderNo, newSupplementRecords);
        } else {
          // 新增模式：追加到现有记录
          this.updateOrderSupplementsInList(currentOrder.orderNo, newSupplementRecords);
        }
      })
      .catch(err => {
        wx.hideLoading();
        console.error(isEditMode ? '修改失败:' : '补录失败:', err);
        wx.showToast({
          title: isEditMode ? '修改失败，请重试' : '补录失败，请重试',
          icon: 'none'
        });
      });
  },

  /**
   * 更新列表中订单的补录信息（多个记录）
   */
  updateOrderSupplementsInList: function (orderNo, newSupplements) {
    const orders = this.data.orders;
    const orderIndex = orders.findIndex(order => order.orderNo === orderNo);

    if (orderIndex !== -1) {
      const order = orders[orderIndex];

      // 更新补录信息
      const existingSupplements = order.supplements || [];
      order.supplements = [...existingSupplements, ...newSupplements];

      // 重新计算补录总金额
      order.supplementTotal = order.supplements.reduce((sum, item) => sum + (item.amount || 0), 0);

      // 更新订单列表
      this.setData({
        orders: orders
      });
    }
  },

  /**
   * 替换列表中订单的所有补录信息（编辑模式）
   */
  replaceOrderSupplementsInList: function (orderNo, newSupplements) {
    const orders = this.data.orders;
    const orderIndex = orders.findIndex(order => order.orderNo === orderNo);

    if (orderIndex !== -1) {
      const order = orders[orderIndex];

      // 直接替换所有补录记录
      order.supplements = newSupplements;

      // 重新计算补录总金额
      order.supplementTotal = order.supplements.reduce((sum, item) => sum + (item.amount || 0), 0);

      // 更新订单列表
      this.setData({
        orders: orders
      });
    }
  },

  // ==================== 提货运费相关方法 ====================

  /**
   * 显示提货运费弹窗
   */
  showFreightModal: function (e) {
    const order = e.currentTarget.dataset.order;

    // 检查权限
    if (!order.canOperate) {
      wx.showToast({
        title: '无权操作此订单',
        icon: 'none'
      });
      return;
    }

    // 检查订单是否已归档
    if (order.status !== '未归档') {
      wx.showToast({
        title: '已归档订单不能修改提货运费',
        icon: 'none'
      });
      return;
    }

    this.setData({
      showFreightModal: true,
      currentOrder: order,
      freightAmount: order.freightAmount !== undefined && order.freightAmount !== null ? String(order.freightAmount) : ''
    });
  },

  /**
   * 关闭提货运费弹窗
   */
  closeFreightModal: function () {
    this.setData({
      showFreightModal: false,
      freightAmount: ''
    });
  },

  /**
   * 提货运费金额输入处理
   */
  onFreightAmountInput: function (e) {
    this.setData({
      freightAmount: e.detail.value
    });
  },

  /**
   * 提交提货运费
   */
  submitFreight: function () {
    const { currentOrder, freightAmount } = this.data;

    // 验证输入
    if (!freightAmount || parseFloat(freightAmount) <= 0) {
      wx.showToast({
        title: '请输入有效的运费金额',
        icon: 'none'
      });
      return;
    }

    wx.showLoading({
      title: '提交中...',
    });

    const db = wx.cloud.database();
    const now = new Date();

    // 查询订单
    db.collection('orders')
      .where({ orderNo: currentOrder.orderNo })
      .limit(1)
      .get()
      .then(res => {
        if (!res.data || res.data.length === 0) {
          wx.hideLoading();
          wx.showToast({
            title: '订单不存在',
            icon: 'none'
          });
          return;
        }

        const order = res.data[0];
        const orderDocId = order._id;

        // 更新订单提货运费
        return db.collection('orders').doc(orderDocId).update({
          data: {
            freightAmount: parseFloat(freightAmount),
            updateTime: now.getTime()
          }
        });
      })
      .then(() => {
        wx.hideLoading();
        wx.showToast({
          title: '提货运费设置成功',
          icon: 'success'
        });

        // 关闭弹窗
        this.closeFreightModal();

        // 更新列表中的订单数据
        this.updateOrderFreightInList(currentOrder.orderNo, parseFloat(freightAmount));
      })
      .catch(err => {
        wx.hideLoading();
        console.error('提货运费设置失败:', err);
        wx.showToast({
          title: '设置失败，请重试',
          icon: 'none'
        });
      });
  },

  /**
   * 更新列表中订单的提货运费
   */
  updateOrderFreightInList: function (orderNo, freightAmount) {
    const orders = this.data.orders;
    const orderIndex = orders.findIndex(order => order.orderNo === orderNo);

    if (orderIndex !== -1) {
      orders[orderIndex].freightAmount = freightAmount;
      this.setData({
        orders: orders
      });
    }
  },

  /**
   * 显示订单备注弹窗
   */
  showRemarkModal: function (e) {
    const order = e.currentTarget.dataset.order;

    // 检查权限
    if (!this.canOperateOrder(order)) {
      wx.showToast({
        title: '您没有权限操作此订单',
        icon: 'none'
      });
      return;
    }

    this.setData({
      showRemarkModal: true,
      currentOrder: order,
      remarkText: order.remark || ''
    });
  },

  /**
   * 关闭订单备注弹窗
   */
  closeRemarkModal: function () {
    this.setData({
      showRemarkModal: false,
      currentOrder: {},
      remarkText: ''
    });
  },

  /**
   * 备注输入
   */
  onRemarkInput: function (e) {
    this.setData({
      remarkText: e.detail.value
    });
  },

  /**
   * 提交订单备注
   */
  submitRemark: function () {
    const { currentOrder, remarkText } = this.data;

    wx.showLoading({ title: '保存中...' });

    // 调用云函数更新订单备注
    wx.cloud.callFunction({
      name: 'updateOrderRemark',
      data: {
        orderNo: currentOrder.orderNo,
        remark: remarkText.trim()
      }
    })
      .then(res => {
        wx.hideLoading();

        if (res.result && res.result.success) {
          wx.showToast({
            title: '备注保存成功',
            icon: 'success'
          });

          // 关闭弹窗
          this.closeRemarkModal();

          // 更新列表中的订单数据
          this.updateOrderRemarkInList(currentOrder.orderNo, remarkText.trim());
        } else {
          wx.showToast({
            title: res.result ? res.result.error : '保存失败',
            icon: 'none'
          });
        }
      })
      .catch(err => {
        wx.hideLoading();
        console.error('保存备注失败:', err);
        wx.showToast({
          title: '保存失败，请重试',
          icon: 'none'
        });
      });
  },

  /**
   * 更新列表中订单的备注
   */
  updateOrderRemarkInList: function (orderNo, remark) {
    const orders = this.data.orders;
    const orderIndex = orders.findIndex(order => order.orderNo === orderNo);

    if (orderIndex !== -1) {
      orders[orderIndex].remark = remark;
      this.setData({
        orders: orders
      });
    }
  },

  // ==================== 我的导出任务相关方法 ====================

  /**
   * 显示我的导出任务弹窗
   */
  showMyExportTasks: function () {
    this.setData({
      showExportTasksModal: true
    });

    // 加载导出任务列表
    this.loadExportTasks();
  },

  /**
   * 关闭我的导出任务弹窗
   */
  closeExportTasksModal: function () {
    this.setData({
      showExportTasksModal: false,
      exportTasks: []
    });
  },

  /**
   * 加载导出任务列表
   */
  loadExportTasks: function () {
    this.setData({
      loadingExportTasks: true
    });

    // 获取用户信息
    const userInfo = this.data.userInfo;

    wx.cloud.callFunction({
      name: 'exportOrders',
      data: {
        action: 'getMyExportTasks',
        data: {
          userName: userInfo.userName || ''
        }
      }
    }).then(res => {
      this.setData({
        loadingExportTasks: false
      });

      if (res.result && res.result.code === 0) {
        const tasks = res.result.data || [];

        // 格式化任务数据
        const formattedTasks = tasks.map(task => {
          // 格式化时间
          let createTimeFormat = '未知时间';
          if (task.createTime) {
            const date = new Date(task.createTime);
            if (!isNaN(date.getTime())) {
              const year = date.getFullYear();
              const month = String(date.getMonth() + 1).padStart(2, '0');
              const day = String(date.getDate()).padStart(2, '0');
              const hour = String(date.getHours()).padStart(2, '0');
              const minute = String(date.getMinutes()).padStart(2, '0');
              createTimeFormat = `${year}-${month}-${day} ${hour}:${minute}`;
            }
          }

          // 计算进度
          const progress = task.totalOrders > 0
            ? Math.round((task.processedOrders / task.totalOrders) * 100)
            : 0;

          // 状态文本
          const statusMap = {
            'pending': '等待中',
            'processing': '处理中',
            'completed': '已完成',
            'failed': '失败'
          };

          return {
            ...task,
            createTimeFormat,
            progress,
            statusText: statusMap[task.status] || task.status
          };
        });

        this.setData({
          exportTasks: formattedTasks
        });
      } else {
        console.error('加载导出任务失败:', res.result);
        wx.showToast({
          title: res.result?.message || '加载失败',
          icon: 'none'
        });
      }
    }).catch(err => {
      this.setData({
        loadingExportTasks: false
      });
      console.error('加载导出任务失败:', err);
      wx.showToast({
        title: '加载失败，请重试',
        icon: 'none'
      });
    });
  },

  /**
   * 刷新导出任务列表
   */
  refreshExportTasks: function () {
    this.loadExportTasks();
  },

  noop: function () {}
})
