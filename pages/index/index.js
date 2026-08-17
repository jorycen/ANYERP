// pages/index/index.js
Page({
  data: {
    userInfo: null,
    storeInfo: null,
    showCreateOrder: true,
    showInbound: true,
    showTransfer: true,
    purchaseQueryOnly: false,
    appVersion: 'v2.0.1'
  },

  onLoad: function () {
    const app = getApp();

    if (app.globalData.userInfo) {
      this.setData({
        userInfo: app.globalData.userInfo
      });
    }

    const storeInfo = wx.getStorageSync('storeInfo');
    if (storeInfo) {
      this.setData({
        storeInfo: storeInfo
      });
    }

    this.checkCreateOrderPermission();
  },

  onShow: function () {
    this.onLoad();
  },

  checkCreateOrderPermission: function () {
    const userUtils = require('../profile/user-utils.js');
    const userInfo = userUtils.getUserInfo();
    const blockedAccounts = ['18888888888'];
    const phoneNumber = userInfo && userInfo.phoneNumber ? userInfo.phoneNumber : '';

    this.setData({
      purchaseQueryOnly: userUtils.isPurchaseQueryOnly(userInfo),
      showCreateOrder: !blockedAccounts.includes(phoneNumber),
      showInbound: ['distributor', 'store_admin', 'staff'].includes(userInfo.userRole),
      showTransfer: ['distributor', 'store_admin', 'staff'].includes(userInfo.userRole)
    });
  },

  navigateToOrderCreate: function () {
    wx.navigateTo({
      url: '/pages/order-create/order-create'
    });
  },

  navigateToDepositManage: function () {
    wx.navigateTo({
      url: '/pages/deposit-manage/deposit-manage'
    });
  },

  navigateToInventoryQuery: function () {
    wx.navigateTo({
      url: '/pages/inventory-query/inventory-query'
    });
  },

  navigateToTransferManage: function () {
    wx.navigateTo({
      url: '/pages/transfer-manage/transfer-manage'
    });
  },

  navigateToInboundManage: function () {
    wx.navigateTo({
      url: '/pages/inbound-manage/inbound-manage'
    });
  },

  navigateToApprovalCenter: function () {
    wx.navigateTo({
      url: '/pages/approval-center/approval-center'
    });
  },

  navigateToReports: function () {
    wx.navigateTo({
      url: '/pages/reports/reports'
    });
  },

  navigateToFinanceManagement: function () {
    wx.navigateTo({
      url: '/pages/finance-management/finance-management'
    });
  },

  navigateToPurchaseApplication: function () {
    wx.navigateTo({
      url: '/pages/purchase-application/purchase-application'
    });
  },

});
