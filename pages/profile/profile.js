// pages/profile/profile.js
const userUtils = require('./user-utils.js');
const DataStorage = require('../../utils/storage.js');

Page({
  data: {
    storeInfo: {
      name: '联想授权经销商',
      address: '请在个人中心设置',
      phone: '请在个人中心设置'
    },
    userInfo: {
      userName: '测试用户',
      userRole: '普通员工',
      phoneNumber: ''
    },
    canEditStore: false,
    isLoggedIn: false,
    canUseTransfer: false,
    isDistributor: false,
    showGuanghuanStats: false,
    showPasswordModal: false,
    oldPassword: '',
    newPassword: '',
    confirmPassword: '',
    appVersion: 'v2.0.1',
    storeList: [],
    selectedStoreIndex: 0,
    selectedStoreId: '',
    showStorePicker: false,
    tempStoreName: '',
    accessibleStoreCount: 0
  },

  onLoad: function (options) {
    this.loadUserInfo();
    this.loadStoreInfo();
  },

  onShow: function () {
    this.loadUserInfo();
    this.loadStoreInfo();
    if (this.data.isLoggedIn && !this.data.isDistributor) {
      this.loadStoreList();
    }
  },

  loadUserInfo: function () {
    const userInfo = userUtils.getUserInfo();
    
    let roleName;
    switch (userInfo.userRole) {
      case userUtils.USER_ROLES.DISTRIBUTOR:
        roleName = '经销商';
        break;
      case userUtils.USER_ROLES.STORE_ADMIN:
        roleName = '店长';
        break;
      case userUtils.USER_ROLES.STAFF:
        roleName = '店员';
        break;
      case 'unauthorized':
        roleName = '未授权';
        break;
      default:
        roleName = '未知角色';
    }
    
    const isLoggedIn = userInfo && userInfo.phoneNumber && userInfo.userRole !== 'unauthorized';
    const isDistributor = userUtils.isDistributor(userInfo);
    const isStoreAdmin = userInfo.userRole === 'store_admin';
    
    console.log('loadUserInfo - userRole:', userInfo.userRole);
    console.log('loadUserInfo - isDistributor:', isDistributor);
    
    this.setData({
      userInfo: {
        userName: userInfo.userName || '未登录',
        userRole: roleName,
        phoneNumber: userInfo.phoneNumber || '',
        storeName: isDistributor ? '' : (userInfo.storeName || ''),
        distributorName: userInfo.distributorName || '',
        userId: userInfo.userId || ''
      },
      canEditStore: userUtils.canManageStore(),
      isLoggedIn: isLoggedIn,
      canUseTransfer: ['distributor', 'store_admin', 'staff'].includes(userInfo.userRole),
      isDistributor: isDistributor,
      accessibleStoreCount: Array.isArray(userInfo.storeIds) ? userInfo.storeIds.length : 0,
      showGuanghuanStats: isDistributor || isStoreAdmin
    });
  },

  loadStoreInfo: function () {
    const storeInfo = wx.getStorageSync('storeInfo') || {
      name: '联想授权经销商',
      address: '请在个人中心设置',
      phone: '请在个人中心设置'
    };
    
    this.setData({
      storeInfo: storeInfo
    });
  },

  loadStoreList: function () {
    if (this.data.isDistributor) {
      wx.removeStorageSync('tempStoreInfo');
      this.setData({ storeList: [], selectedStoreId: '', selectedStoreIndex: 0, tempStoreName: '' });
      return;
    }
    if (!this.data.isLoggedIn) {
      this.setData({
        storeList: [],
        selectedStoreId: '',
        selectedStoreIndex: 0,
        tempStoreName: ''
      });
      return;
    }
    const that = this;
    const DataStorage = require('../../utils/storage.js');
    DataStorage.getStores((stores) => {
      if (stores && stores.length > 0) {
        that.initStoreSelection(stores);
      } else {
        wx.removeStorageSync('tempStoreInfo');
        that.setData({ storeList: [], selectedStoreId: '', selectedStoreIndex: 0, tempStoreName: '' });
      }
    }, (err) => {
      that.setData({ storeList: [] });
    });
  },

  loadStoresFromApiWithoutLoading: function() {
    const that = this;
    const api = require('../../utils/api.js');
    api.store.getStores('').then(result => {
      const stores = (result && result.data) || result || [];
      if (stores && stores.length > 0) {
        that.initStoreSelection(stores);
      }
    }).catch(err => {
      console.error('API获取门店列表失败:', err);
    });
  },

  switchStore: function () {
    wx.showLoading({ title: '加载中...' });
    const that = this;
    const DataStorage = require('../../utils/storage.js');
    DataStorage.getStores((stores) => {
      wx.hideLoading();
      if (stores && stores.length > 0) {
        that.initStoreSelection(stores);
        that.setData({ showStorePicker: true });
      } else {
        that.loadStoresFromApi(true);
      }
    }, (err) => {
      wx.hideLoading();
      that.loadStoresFromApi(true);
    });
  },

  loadStoresFromApi: function(showPicker) {
    const that = this;
    const api = require('../../utils/api.js');
    if (showPicker) {
      wx.showLoading({ title: '加载中...' });
    }
    api.store.getStores('').then(result => {
      if (showPicker) wx.hideLoading();
      const stores = (result && result.data) || result || [];
      if (stores && stores.length > 0) {
        that.initStoreSelection(stores);
        if (showPicker) {
          that.setData({ showStorePicker: true });
        }
      } else {
        wx.removeStorageSync('tempStoreInfo');
        that.setData({ storeList: [], selectedStoreId: '', selectedStoreIndex: 0, tempStoreName: '' });
        if (showPicker) {
          wx.showToast({
            title: '暂无可选门店',
            icon: 'none'
          });
        }
      }
    }).catch(err => {
      if (showPicker) wx.hideLoading();
      wx.showToast({
        title: '加载门店失败',
        icon: 'none'
      });
    });
  },

  initStoreSelection: function(stores) {
    const tempStoreInfo = wx.getStorageSync('tempStoreInfo') || {};
    const storeId = tempStoreInfo.storeId || tempStoreInfo.store_id || tempStoreInfo.id || tempStoreInfo._id || '';
    const storeName = tempStoreInfo.storeName || tempStoreInfo.store_name || tempStoreInfo.name || '';
    const normalizedStores = (stores || []).map(store => Object.assign({}, store, {
      storeId: store.storeId || store.store_id || store.id || store._id || '',
      name: store.name || store.storeName || store.store_name || ''
    }));
    const storeIndex = normalizedStores.findIndex(s => String(s.storeId || '') === String(storeId));
    const hasValidSelection = storeIndex >= 0;
    if (storeId && !hasValidSelection) {
      wx.removeStorageSync('tempStoreInfo');
      wx.showToast({ title: '原门店权限已失效，请重新选择', icon: 'none' });
    }

    this.setData({
      storeList: normalizedStores,
      selectedStoreId: hasValidSelection ? storeId : '',
      selectedStoreIndex: hasValidSelection ? storeIndex : 0,
      tempStoreName: hasValidSelection ? storeName : ''
    });
  },

  onStoreChange: function (e) {
    const index = e.currentTarget.dataset.index;
    const { storeList } = this.data;
    if (storeList && storeList.length > 0) {
      const selectedStore = storeList[index];
      const storeId = selectedStore.storeId || selectedStore.store_id || selectedStore.id || selectedStore._id || '';
      const storeName = selectedStore.name || selectedStore.storeName || selectedStore.store_name || '';
      wx.setStorageSync('tempStoreInfo', {
        storeId: storeId,
        storeName: storeName
      });
      this.setData({
        selectedStoreId: storeId,
        selectedStoreIndex: index,
        tempStoreName: storeName,
        showStorePicker: false
      });
      wx.showToast({
        title: '门店已切换',
        icon: 'success'
      });
    }
  },

  hideStorePicker: function () {
    this.setData({ showStorePicker: false });
  },

  manageStoreInfo: function () {
    if (!this.data.canEditStore) {
      wx.showToast({
        title: '您没有权限管理门店信息',
        icon: 'none'
      });
      return;
    }
    
    wx.navigateTo({
      url: '/pages/store-list/store-list'
    });
  },

  manageDistributorInfo: function () {
    wx.navigateTo({
      url: '/pages/distributor-info/distributor-info'
    });
  },

  manageCustomerSources: function () {
    wx.navigateTo({
      url: '/pages/customer-source-manage/customer-source-manage'
    });
  },

  managePaymentMethods: function () {
    wx.navigateTo({
      url: '/pages/payment-method-manage/payment-method-manage'
    });
  },

  manageSupplementItems: function () {
    wx.navigateTo({
      url: '/pages/supplement-item-manage/supplement-item-manage'
    });
  },

  manageGoods: function () {
    wx.navigateTo({
      url: '/pages/goods-manage/goods-manage'
    });
  },

  manageTransfer: function () {
    wx.navigateTo({
      url: '/pages/transfer-manage/transfer-manage'
    });
  },

  uploadBaseTable: function () {
    console.log('开始跳转到基础表上传页面');
    try {
      wx.navigateTo({
        url: '/pages/base-table-upload/base-table-upload',
        success: function(res) {
          console.log('页面跳转成功:', res);
        },
        fail: function(err) {
          console.error('页面跳转失败:', err);
          wx.showToast({
            title: '跳转失败: ' + err.errMsg,
            icon: 'none'
          });
        }
      });
    } catch (error) {
      console.error('跳转过程中发生错误:', error);
      wx.showToast({
        title: '发生错误: ' + error.message,
        icon: 'none'
      });
    }
  },

  goToPhotoDownload: function () {
    wx.navigateTo({
      url: '/pages/photo-download/photo-download'
    });
  },

  goToMallSalesQuery: function () {
    wx.navigateTo({
      url: '/pages/mall-sales-query/mall-sales-query'
    });
  },

  goToPrinter: function () {
    wx.navigateTo({
      url: '/pages/printer/printer'
    });
  },

  goToGuanghuanStats: function () {
    wx.navigateTo({
      url: '/pages/guanghuan-stats/guanghuan-stats'
    });
  },

  clearCache: function () {
    wx.showModal({
      title: '确认清除',
      content: '确定要清除缓存吗？',
      success: (res) => {
        if (res.confirm) {
          wx.clearStorageSync();
          wx.showToast({
            title: '缓存清除成功',
            icon: 'success'
          });
          setTimeout(() => {
            wx.redirectTo({
              url: '/pages/login/login'
            });
          }, 1500);
        }
      }
    });
  },

  logout: function () {
    wx.showModal({
      title: '退出登录',
      content: '确定要退出登录吗？',
      success: (res) => {
        if (res.confirm) {
          wx.removeStorageSync('userInfo');
          wx.showToast({
            title: '已退出登录',
            icon: 'success'
          });
          setTimeout(() => {
            wx.redirectTo({
              url: '/pages/login/login'
            });
          }, 1500);
        }
      }
    });
  },

  aboutUs: function () {
    wx.showModal({
      title: '关于我们',
      content: '联想经销商助手小程序\n版本：v2.0.1\n开发者：联想科技',
      showCancel: false
    });
  },

  goToLogin: function () {
    wx.navigateTo({
      url: '/pages/login/login'
    });
  },

  changePassword: function () {
    this.setData({
      showPasswordModal: true,
      oldPassword: '',
      newPassword: '',
      confirmPassword: ''
    });
  },

  hidePasswordModal: function () {
    this.setData({
      showPasswordModal: false
    });
  },

  onOldPasswordInput: function (e) {
    this.setData({
      oldPassword: e.detail.value
    });
  },

  onNewPasswordInput: function (e) {
    this.setData({
      newPassword: e.detail.value
    });
  },

  onConfirmPasswordInput: function (e) {
    this.setData({
      confirmPassword: e.detail.value
    });
  },

  confirmChangePassword: function () {
    const { oldPassword, newPassword, confirmPassword } = this.data;
    const userInfo = userUtils.getUserInfo();
    
    if (!oldPassword) {
      wx.showToast({
        title: '请输入旧密码',
        icon: 'none'
      });
      return;
    }
    
    if (!newPassword) {
      wx.showToast({
        title: '请输入新密码',
        icon: 'none'
      });
      return;
    }
    
    if (newPassword.length < 6) {
      wx.showToast({
        title: '新密码至少6位',
        icon: 'none'
      });
      return;
    }
    
    if (newPassword !== confirmPassword) {
      wx.showToast({
        title: '两次密码不一致',
        icon: 'none'
      });
      return;
    }
    
    wx.showLoading({ title: '修改中...' });
    
    DataStorage.changeUserPassword(userInfo.userId, oldPassword, newPassword,
      (res) => {
        wx.hideLoading();
        wx.showToast({
          title: '密码修改成功',
          icon: 'success'
        });
        this.hidePasswordModal();
      },
      (err) => {
        wx.hideLoading();
        wx.showToast({
          title: err.errMsg || '修改失败',
          icon: 'none'
        });
      }
    );
  },

  manageUsers: function () {
    wx.navigateTo({
      url: '/pages/user-manage/user-manage'
    });
  },

  /**
   * 初始化所有用户密码
   */
  initPasswords: function () {
    wx.showModal({
      title: '确认初始化',
      content: '这将把所有用户的密码初始化为手机号后6位，是否继续？',
      success: (res) => {
        if (res.confirm) {
          this.doInitPasswords();
        }
      }
    });
  },

  doInitPasswords: function () {
    wx.showLoading({ title: '初始化中...' });
    
    const db = wx.cloud.database();
    
    // 1. 初始化经销商密码
    db.collection('distributors').get().then(res => {
      const distributors = res.data;
      const updatePromises = [];
      
      distributors.forEach(distributor => {
        const updateData = {};
        
        // 经销商主账号密码
        if (distributor.phone) {
          updateData.password = distributor.phone.slice(-6);
        }
        
        // 经销商员工密码
        if (distributor.staffList && distributor.staffList.length > 0) {
          distributor.staffList.forEach((staff, index) => {
            if (staff.phone) {
              updateData[`staffList.${index}.password`] = staff.phone.slice(-6);
            }
          });
        }
        
        if (Object.keys(updateData).length > 0) {
          updatePromises.push(
            db.collection('distributors').doc(distributor._id).update({
              data: updateData
            })
          );
        }
      });
      
      // 2. 初始化门店密码
      return db.collection('stores').get();
    }).then(res => {
      const stores = res.data;
      const updatePromises = [];
      
      stores.forEach(store => {
        const updateData = {};
        
        // 门店主账号密码
        if (store.phone) {
          updateData.password = store.phone.slice(-6);
        }
        
        // 店长密码
        if (store.managerPhone) {
          updateData.managerPassword = store.managerPhone.slice(-6);
        }
        
        // 店员密码
        if (store.staffList && store.staffList.length > 0) {
          store.staffList.forEach((staff, index) => {
            if (staff.phone) {
              updateData[`staffList.${index}.password`] = staff.phone.slice(-6);
            }
          });
        }
        
        if (Object.keys(updateData).length > 0) {
          updatePromises.push(
            db.collection('stores').doc(store._id).update({
              data: updateData
            })
          );
        }
      });
      
      return Promise.all(updatePromises);
    }).then(() => {
      wx.hideLoading();
      wx.showToast({
        title: '密码初始化成功',
        icon: 'success'
      });
    }).catch(err => {
      wx.hideLoading();
      console.error('初始化密码失败:', err);
      wx.showToast({
        title: '初始化失败',
        icon: 'none'
      });
    });
  },

  noop: function () {}
})
