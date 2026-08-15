// pages/store-list/store-list.js
const userUtils = require('../profile/user-utils.js');
const DataStorage = require('../../utils/storage.js');

Page({
  /**
   * 页面的初始数据
   */
  data: {
    stores: [], // 门店列表
    userInfo: {}, // 用户信息
    canManageStores: false // 是否有权限管理门店
  },

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
    
    // 检查用户权限
    const canManageStores = userUtils.isDistributor() || userUtils.isStoreAdmin();
    
    this.setData({
      userInfo: userInfo,
      canManageStores: canManageStores
    });
    
    // 如果没有权限管理门店，返回上一页
    if (!canManageStores) {
      wx.showToast({
        title: '您没有权限管理门店',
        icon: 'none'
      });
      setTimeout(() => {
        wx.navigateBack();
      }, 1500);
      return;
    }
    
    // 加载门店列表
    this.loadStores();
  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow: function () {
    // 页面显示时重新加载门店列表
    this.loadStores();
  },

  /**
   * 加载门店列表
   */
  loadStores: function () {
    wx.showLoading({
      title: '加载中...',
    });
    
    // 从数据存储获取门店列表
    DataStorage.getStores(
      (stores) => {
        // 确保 stores 是数组
        if (!Array.isArray(stores)) {
          stores = [];
        }
        
        this.setData({
          stores: stores
        });
        
        wx.hideLoading();
      },
      (err) => {
        console.error('获取门店列表失败:', err);
        // 失败时设置为空数组
        this.setData({
          stores: []
        });
        
        wx.hideLoading();
      }
    );
  },

  /**
   * 新增门店
   */
  addStore: function () {
    wx.navigateTo({
      url: '/pages/store-add/store-add'
    });
  },

  /**
   * 编辑门店
   */
  editStore: function (e) {
    const store = e.currentTarget.dataset.store;
    wx.navigateTo({
      url: '/pages/store-edit/store-edit?storeInfo=' + JSON.stringify(store)
    });
  },

  /**
   * 删除门店
   */
  deleteStore: function (e) {
    const storeId = e.currentTarget.dataset.storeid;
    const storeName = e.currentTarget.dataset.storename;
    
    wx.showModal({
      title: '确认删除',
      content: '确定要删除门店"' + storeName + '"吗？',
      success: (res) => {
        if (res.confirm) {
          // 删除门店
          DataStorage.deleteStore(storeId, 
            (res) => {
              wx.showToast({
                title: '删除成功',
                icon: 'success'
              });
              // 重新加载门店列表
              this.loadStores();
            },
            (err) => {
              wx.showToast({
                title: '删除失败: ' + err,
                icon: 'none'
              });
            }
          );
        }
      }
    });
  },

  /**
   * 返回上一页
   */
  goBack: function () {
    wx.navigateBack();
  }
})