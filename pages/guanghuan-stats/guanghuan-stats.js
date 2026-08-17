// pages/guanghuan-stats/guanghuan-stats.js
const userUtils = require('../profile/user-utils.js');

Page({
  data: {
    hasPermission: false,
    isLoading: false,
    showStats: false,

    startDate: '',
    endDate: '',

    statsData: {
      orderCount: 0,
      totalAmount: '0.00',
      successCount: 0,
      failCount: 0
    },

    orderList: []
  },

  onLoad: function (options) {
    const userInfo = userUtils.getUserInfo();
    const userRole = userInfo.userRole || 'staff';

    // 经销商和所有店长都可以查看
    const hasPermission = userUtils.isDistributor() || userUtils.isStoreAdmin();

    this.setData({ hasPermission });

    if (!hasPermission) {
      return;
    }

    this.initDates();
  },

  initDates: function () {
    const today = new Date();

    const formatDate = (date) => {
      const year = date.getFullYear();
      const month = (date.getMonth() + 1).toString().padStart(2, '0');
      const day = date.getDate().toString().padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    this.setData({
      startDate: formatDate(today),
      endDate: formatDate(today)
    });
  },

  onStartDateChange: function (e) {
    this.setData({
      startDate: e.detail.value,
      showStats: false
    });
  },

  onEndDateChange: function (e) {
    this.setData({
      endDate: e.detail.value,
      showStats: false
    });
  },

  queryStats: function () {
    if (this.data.isLoading) return;

    const { startDate, endDate } = this.data;
    console.log('前端开始查询，日期:', startDate, '到', endDate);

    if (!startDate || !endDate) {
      wx.showToast({ title: '请选择日期范围', icon: 'none' });
      return;
    }

    this.setData({ isLoading: true });

    const userInfo = userUtils.getUserInfo();
    const tempStoreInfo = wx.getStorageSync('tempStoreInfo') || {};
    const storeId = userUtils.isStoreScoped(userInfo)
      ? (tempStoreInfo.storeId || tempStoreInfo.store_id || tempStoreInfo.id || tempStoreInfo._id || userInfo.storeId || '')
      : '';
    console.log('准备调用云函数，用户信息:', userInfo);
    
    wx.cloud.callFunction({
      name: 'queryOrders',
      data: {
        action: 'getGuanghuanStats',
        data: {
          startDate: startDate,
          endDate: endDate,
          storeId: storeId
        }
      }
    }).then(res => {
      console.log('云函数返回:', res);
      this.setData({ isLoading: false });

      if (res.result && res.result.code === 0) {
        const data = res.result.data;
        this.setData({
          showStats: true,
          statsData: data.stats,
          orderList: data.orders
        });
      } else {
        wx.showToast({
          title: res.result?.message || '查询失败',
          icon: 'none'
        });
      }
    }).catch(err => {
      console.error('云函数调用出错:', err);
      this.setData({ isLoading: false });
      wx.showToast({ title: '查询失败', icon: 'none' });
    });
  }
});
