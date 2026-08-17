// pages/mall-sales-query/mall-sales-query.js
const userUtils = require('../profile/user-utils.js');
const api = require('../../utils/api.js');
const { normalizeOrderItem } = require('../../utils/model.js');
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
    // 页面状态
    isFirstLoad: true, // 是否首次加载
    scrollTop: 0, // 滚动位置
    // 我的导出任务弹窗相关
    showExportTasksModal: false,
    exportTasks: [],
    loadingExportTasks: false,
    showResourceModal: false,
    resourceModalLoading: false,
    resourceModalOrder: {},
    resourceRows: []
  },

  // 标记是否从详情页返回
  isFromDetail: false,
  // 当前查看的订单编号
  currentViewOrderNo: '',

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: function (options) {
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
    const searchParams = this.data.searchParams;
    const defaultStartDate = userUtils.isDistributor() ? '' : currentDate;
    const defaultEndDate = userUtils.isDistributor() ? '' : currentDate;
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
    // 加载订单数据（只查询已上报商场的订单）
    this.loadOrders();
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

  showAvailableResources: function (e) {
    const order = e.currentTarget.dataset.order || {};
    this.setData({ showResourceModal: true, resourceModalLoading: true, resourceModalOrder: order, resourceRows: [] });
    const loadDetail = () => {
      const orderId = order.orderId || order._id || order.order_id;
      if (orderId) return api.order.getDetails(orderId);
      return api.order.queryList({ orderNo: order.orderNo, page: 1, pageSize: 1 }).then(result => {
        const row = result.data && result.data[0];
        if (!row) throw new Error('未找到订单详情');
        return api.order.getDetails(row.orderId || row._id || row.order_id);
      });
    };
    Promise.all([loadDetail().catch(() => order), api.purchase.resourceCategories().catch(() => [])])
      .then(([detail, categoryResult]) => {
        const categories = Array.isArray(categoryResult) ? categoryResult : ((categoryResult && categoryResult.data) || []);
        const names = { GOV_SUBSIDY: '国补资格', EDU_SUBSIDY: '教育优惠资格', SALES_RED_PACKET: '销售红包', SALES_REPORT: '销售报号资格' };
        categories.forEach(category => {
          const code = category.category_code || category.categoryCode || category.code;
          if (code) names[code] = category.short_name || category.name || code;
        });
        const items = (detail && (detail.goods || detail.items || detail.OrderItems)) || order.goods || order.items || [];
        return Promise.all(items.map(rawItem => {
          const normalized = normalizeOrderItem(rawItem);
          const summary = normalized.resourceSummary || {};
          const getSummary = summary.rights || normalized.resourceRights.length || (!normalized.inventoryId && !normalized.snCode && !normalized.productId)
            ? Promise.resolve(summary)
            : (normalized.inventoryId
              ? api.inventory.snResourceRights(normalized.inventoryId)
              : api.inventory.resourceRights({ snCode: normalized.snCode, productId: normalized.productId, status: 'AVAILABLE', page: 1, pageSize: 100 })
                .then(result => ({ rights: result.data || [] }))).catch(() => summary);
          return getSummary.then(result => {
            const rights = Array.isArray(result.rights) ? result.rights : normalized.resourceRights;
            const available = rights.filter(right => String(right.current_status || right.status || '').toUpperCase() === 'AVAILABLE');
            const unavailable = rights.filter(right => !['AVAILABLE', 'NOT_APPLICABLE'].includes(String(right.current_status || right.status || '').toUpperCase()));
            return {
              productName: normalized.productName || '未命名商品', pnCode: normalized.pnCode || '', snCode: normalized.snCode || '', quantity: normalized.quantity,
              availableResources: available.map(right => names[right.resource_type] || right.resource_name || right.resource_type).filter(Boolean),
              unavailableResources: unavailable.map(right => `${names[right.resource_type] || right.resource_type}: ${right.current_status || right.status}`),
              hasAvailable: available.length > 0
            };
          });
        }));
      })
      .then(resourceRows => this.setData({ resourceRows, resourceModalLoading: false }))
      .catch(error => {
        console.error('加载订单可用资源失败:', error);
        this.setData({ resourceRows: [], resourceModalLoading: false });
        wx.showToast({ title: '资源加载失败', icon: 'none' });
      });
  },

  closeResourceModal: function () {
    this.setData({ showResourceModal: false, resourceRows: [] });
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
    wx.cloud.callFunction({
      name: 'queryOrders',
      data: {
        action: 'getOrderByNo',
        data: { orderNo: orderNo }
      }
    }).then(res => {
      this.setData({ loading: false });

      if (res.result && res.result.code === 0 && res.result.data) {
        const updatedOrder = res.result.data;

        // 格式化金额字段
        let paymentTotal = updatedOrder.paymentTotal;
        if (!paymentTotal && updatedOrder.paymentMethods && updatedOrder.paymentMethods.length > 0) {
          paymentTotal = updatedOrder.paymentMethods.reduce((total, method) => {
            return total + (parseFloat(method.amount) || 0);
          }, 0);
        }
        updatedOrder.paymentTotal = parseFloat(paymentTotal || 0).toFixed(2);

        // 兼容处理：actualAmount (旧) / actualPayment (新)
        let actualAmount = updatedOrder.actualAmount || updatedOrder.actualPayment || 0;
        updatedOrder.actualAmount = parseFloat(actualAmount).toFixed(2);

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
          goods = updatedOrder.items.map(item => ({
            name: item.productName || item.name || '',
            price: item.unitPrice || item.price || 0,
            quantity: item.quantity || 1,
            pnCode: item.pnCode || '',
            snCode: item.snCode || ''
          }));
        } else if (updatedOrder.goods && updatedOrder.goods.length > 0) {
          goods = updatedOrder.goods.map(item => ({
            name: item.name || item.productName || '',
            price: item.price || item.unitPrice || 0,
            quantity: item.quantity || 1,
            pnCode: item.pnCode || '',
            snCode: item.snCode || ''
          }));
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
    const rawRole = userInfo.userRole || userInfo.role || '';
    let userRole = 'staff';

    if (rawRole === 'distributor' || rawRole === 'admin') {
      userRole = 'distributor';
    } else if (rawRole === 'store_admin' || rawRole === 'manager') {
      userRole = 'store_admin';
    }

    const selectedStoreId = tempStoreInfo.storeId || tempStoreInfo.store_id || tempStoreInfo.id || tempStoreInfo._id || '';
    const ownStoreId = userInfo.storeId || '';

    return {
      userRole: userRole,
      userName: userInfo.userName || userInfo.name || '',
      storeId: userRole === 'distributor' ? '' : (selectedStoreId || ownStoreId),
      rawUserInfo: userInfo
    };
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

    // 加载所有门店的所有人员（包含店员、店长、经销商）
    this.loadAllStoresStaff(DataStorage);
  },

  /**
   * 加载所有门店的人员（包含店员、店长、经销商人员）
   */
  loadAllStoresStaff: function (DataStorage) {
    let allStaffNames = new Set();

    // 1. 获取所有门店信息
    DataStorage.getStores((stores) => {
      if (stores && stores.length > 0) {
        stores.forEach(store => {
          // 添加店长
          if (store.managerName) {
            allStaffNames.add(store.managerName);
          }
          // 添加店员
          if (store.staffList && store.staffList.length > 0) {
            store.staffList.forEach(staff => {
              if (staff.name) {
                allStaffNames.add(staff.name);
              }
            });
          }
        });
      }

      // 2. 获取经销商人员信息
      DataStorage.getDistributorInfo((distributorInfo) => {
        if (distributorInfo && distributorInfo.staffList && distributorInfo.staffList.length > 0) {
          distributorInfo.staffList.forEach(staff => {
            if (staff.name) {
              allStaffNames.add(staff.name);
            }
          });
        }

        // 3. 设置提交人选项
        let staffList = ['全部'];
        if (allStaffNames.size > 0) {
          staffList = ['全部', ...Array.from(allStaffNames).sort()];
        }

        // 保留用户当前选择的提交人索引
        const currentSubmitter = this.data.submitterOptions[this.data.submitterIndex];
        let newIndex = 0;
        if (currentSubmitter && currentSubmitter !== '全部') {
          newIndex = staffList.indexOf(currentSubmitter);
          if (newIndex === -1) newIndex = 0;
        }

        this.setData({
          submitterOptions: staffList,
          submitterIndex: newIndex
        });
      }, (err) => {
        console.error('获取经销商人员失败:', err);
        // 经销商获取失败，仍然显示门店人员
        let staffList = ['全部'];
        if (allStaffNames.size > 0) {
          staffList = ['全部', ...Array.from(allStaffNames).sort()];
        }

        // 保留用户当前选择的提交人索引
        const currentSubmitter = this.data.submitterOptions[this.data.submitterIndex];
        let newIndex = 0;
        if (currentSubmitter && currentSubmitter !== '全部') {
          newIndex = staffList.indexOf(currentSubmitter);
          if (newIndex === -1) newIndex = 0;
        }

        this.setData({
          submitterOptions: staffList,
          submitterIndex: newIndex
        });
      });
    }, (err) => {
      console.error('获取所有门店人员失败:', err);
      // 门店获取失败，尝试获取经销商人员
      DataStorage.getDistributorInfo((distributorInfo) => {
        if (distributorInfo && distributorInfo.staffList && distributorInfo.staffList.length > 0) {
          distributorInfo.staffList.forEach(staff => {
            if (staff.name) {
              allStaffNames.add(staff.name);
            }
          });
        }

        let staffList = ['全部'];
        if (allStaffNames.size > 0) {
          staffList = ['全部', ...Array.from(allStaffNames).sort()];
        } else if (this.data.userInfo && this.data.userInfo.userName) {
          staffList.push(this.data.userInfo.userName);
        }

        // 保留用户当前选择的提交人索引
        const currentSubmitter = this.data.submitterOptions[this.data.submitterIndex];
        let newIndex = 0;
        if (currentSubmitter && currentSubmitter !== '全部') {
          newIndex = staffList.indexOf(currentSubmitter);
          if (newIndex === -1) newIndex = 0;
        }

        this.setData({
          submitterOptions: staffList,
          submitterIndex: newIndex
        });
      }, (err) => {
        // 全部失败，只显示当前用户
        let staffList = ['全部'];
        if (this.data.userInfo && this.data.userInfo.userName) {
          staffList.push(this.data.userInfo.userName);
        }

        // 保留用户当前选择的提交人索引
        const currentSubmitter = this.data.submitterOptions[this.data.submitterIndex];
        let newIndex = 0;
        if (currentSubmitter && currentSubmitter !== '全部') {
          newIndex = staffList.indexOf(currentSubmitter);
          if (newIndex === -1) newIndex = 0;
        }

        this.setData({
          submitterOptions: staffList,
          submitterIndex: newIndex
        });
      });
    });
  },

  /**
   * 加载订单数据（使用云函数，支持分页）- 只查询已上报商场的订单
   * @param {boolean} isLoadMore - 是否加载更多
   * @param {boolean} searchAll - 是否查询全部
   */
  loadOrders: function (isLoadMore = false, searchAll = false) {
    this.normalizeDateFilterForRole();
    const queryUser = this.getOrderQueryUserContext();
    const userInfo = queryUser.rawUserInfo || {};
    const userRole = queryUser.userRole || 'staff';
    const hasDateFilter = this.shouldUseDateFilter();

    wx.showLoading({
      title: searchAll ? '查询全部记录...' : (isLoadMore ? '加载更多...' : '加载中...'),
    });

    // 加载店员信息
    this.loadStaffInfo();

    // 构建查询参数
    const params = {
      page: isLoadMore ? this.data.page + 1 : 1,
      pageSize: searchAll ? 1000 : this.data.pageSize, // 查询全部时使用较大的pageSize
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
      searchAll: searchAll, // 标记是否为查询全部
      onlyReportedToMall: true // 只查询已上报商场的订单
    };

    console.log('查询商场销量参数:', params);

    // 使用云函数查询订单
    wx.cloud.callFunction({
      name: 'queryOrders',
      data: {
        action: 'getOrders',
        data: params
      }
    }).then(res => {
      wx.hideLoading();

      if (res.result && res.result.code === 0) {
        const { list, total, hasMore } = res.result.data;

        // 调试：打印第一条订单数据，检查照片字段
        if (list.length > 0) {
          console.log('商场销量列表 - 第一条订单数据:', list[0]);
        }

        // 格式化订单数据
        const formattedOrders = list.map(order => {
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

          // 兼容处理：处理字段名差异
          // 应收金额：actualAmount (旧) / actualPayment (新)
          let actualAmount = order.actualAmount || order.actualPayment || 0;

          // 实付金额：paymentTotal (旧) / 从 payments 计算 (新)
          let paymentTotal = order.paymentTotal;
          if (!paymentTotal && order.payments && order.payments.length > 0) {
            paymentTotal = order.payments.reduce((total, p) => {
              return total + (parseFloat(p.amount) || 0);
            }, 0);
          }
          // 如果还没有，尝试从 paymentMethods 计算（旧格式）
          if (!paymentTotal && order.paymentMethods && order.paymentMethods.length > 0) {
            paymentTotal = order.paymentMethods.reduce((total, method) => {
              return total + (parseFloat(method.amount) || 0);
            }, 0);
          }

          // 格式化金额字段，确保显示为保留2位小数的字符串
          const formattedPaymentTotal = parseFloat(paymentTotal || 0).toFixed(2);
          const formattedActualAmount = parseFloat(actualAmount || 0).toFixed(2);

          // 计算是否有操作权限
          let canOperate = false;
          if (userRole === 'distributor') {
            canOperate = true;
          } else if (userRole === 'store_admin') {
            canOperate = String(order.storeId || order.store_id || '') === String(queryUser.storeId || '');
          } else {
            canOperate = order.createUser === queryUser.userName;
          }

          // 兼容处理：客户来源字段
          let customerSource = order.customerSource || order.source || '';

          // 兼容处理：将 items 数组映射为 goods 数组（用于页面显示）
          // 优先使用 items 数组（数据库中的最新数据），如果没有则使用 goods 数组
          let goods = [];
          if (order.items && order.items.length > 0) {
            goods = order.items.map(item => ({
              name: item.productName || item.name || '',
              price: item.unitPrice || item.price || 0,
              quantity: item.quantity || 1,
              pnCode: item.pnCode || '',
              snCode: item.snCode || ''
            }));
          } else if (order.goods && order.goods.length > 0) {
            goods = order.goods.map(item => ({
              name: item.name || item.productName || '',
              price: item.price || item.unitPrice || 0,
              quantity: item.quantity || 1,
              pnCode: item.pnCode || '',
              snCode: item.snCode || ''
            }));
          }

          return {
            ...order,
            customerSource: customerSource,
            goods: goods,
            createTimeFormat: createTimeFormat,
            createDate: createDate,
            paymentTotal: formattedPaymentTotal,
            actualAmount: formattedActualAmount,
            canOperate: canOperate
          };
        });

        // 更新数据
        const newOrders = isLoadMore ? [...this.data.orders, ...formattedOrders] : formattedOrders;
        const newPage = isLoadMore ? this.data.page + 1 : 1;

        this.setData({
          orders: newOrders,
          filteredOrders: newOrders,
          page: newPage,
          total: total,
          hasMore: searchAll ? false : hasMore, // 查询全部时隐藏加载更多按钮
          loading: false
        });

        console.log(`加载商场销量成功，共 ${total} 条，当前显示 ${newOrders.length} 条`);
      } else {
        console.error('查询商场销量失败:', res.result);
        this.setData({ loading: false });
        wx.showToast({
          title: '查询失败',
          icon: 'none'
        });
      }
    }).catch(err => {
      wx.hideLoading();
      this.setData({ loading: false });
      console.error('云函数调用失败:', err);
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
   * 导出商场销量数据（异步版本）
   */
  exportOrders: function () {
    const queryUser = this.getOrderQueryUserContext();
    const hasDateFilter = this.shouldUseDateFilter();

    // 构建查询参数（使用当前搜索条件）
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
      endDate: hasDateFilter ? this.data.endDate : '',
      onlyReportedToMall: true
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
          content: `共 ${totalOrders} 条商场销量记录待导出，系统将自动处理，请稍后在弹窗中查看进度。`,
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
              content: `共导出 ${totalOrders} 条商场销量数据，文件名：${fileName}`,
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
              content: '导出任务处理时间过长，请稍后到商场销量列表查看导出结果',
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

    wx.showLoading({
      title: '正在下载...',
    });

    wx.downloadFile({
      url: downloadUrl,
      success: (downloadRes) => {
        wx.hideLoading();

        if (downloadRes.statusCode === 200) {
          // 获取文件类型
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

          // 打开文件
          const openOptions = {
            filePath: downloadRes.tempFilePath,
            showMenu: true,
            success: (openRes) => {
              console.log('文件打开成功', openRes);
            },
            fail: (openErr) => {
              console.error('文件打开失败:', openErr);
              wx.showModal({
                title: '文件已下载',
                content: '文件已保存到本地，请在手机端查看或使用其他应用打开',
                showCancel: false,
                confirmText: '知道了'
              });
            }
          };

          if (fileType) {
            openOptions.fileType = fileType;
          }

          wx.openDocument(openOptions);
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
  }
})
