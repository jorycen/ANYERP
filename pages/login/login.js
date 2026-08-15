// pages/login/login.js
const userUtils = require('../profile/user-utils.js');
const DataStorage = require('../../utils/storage.js');
const http = require('../../utils/request.js');

function isCredentialError(err) {
  const statusCode = Number(err && err.statusCode);
  const message = String(err && (err.message || err.errMsg) || '');
  return statusCode === 400 ||
    statusCode === 401 ||
    statusCode === 403 ||
    statusCode === 404 ||
    /密码|账号|用户不存在|账号不存在|credential|password|unauthorized|not found|invalid/i.test(message);
}

Page({
  data: {
    loading: false,
    hasPhoneAuth: false,
    phoneNumber: '',
    inputPhone: '',
    inputPassword: '',
    showPassword: false,
    userInfo: null,
    authStatus: 'pending',
    message: '请输入账号和密码登录',
    currentStoreName: '',
    isDistributor: false
  },

  onLoad: function(options) {
    this.checkPhoneAuthStatus();
  },

  onShow: function() {
    this.checkPhoneAuthStatus();
  },

  checkPhoneAuthStatus: function() {
    const userInfo = userUtils.getUserInfo();
    const hasValidSession = !!http.getToken();
    if (userInfo && userInfo.phoneNumber && userInfo.userRole !== 'unauthorized' && hasValidSession) {
      this.setData({
        hasPhoneAuth: true,
        phoneNumber: userInfo.phoneNumber,
        userInfo: userInfo,
        authStatus: 'authorized',
        currentStoreName: this.getCurrentStoreName(userInfo),
        isDistributor: userUtils.isDistributor(userInfo),
        message: '点击进入系统，系统将自动连接数据库'
      });
      return;
    }

    if (!hasValidSession) {
      this.setData({
        hasPhoneAuth: false,
        authStatus: 'pending',
        message: '登录已过期，请重新登录'
      });
    }
  },

  getCurrentStoreName: function(userInfo) {
    const tempStoreInfo = wx.getStorageSync('tempStoreInfo') || {};
    if (userUtils.isDistributor(userInfo)) {
      return userInfo.distributorName || '所属经销商';
    }
    return tempStoreInfo.storeName || (userInfo && userInfo.storeName) || '账号所属门店';
  },

  onPhoneInput: function(e) {
    this.setData({
      inputPhone: e.detail.value
    });
  },

  onPasswordInput: function(e) {
    this.setData({
      inputPassword: e.detail.value
    });
  },

  togglePassword: function() {
    console.log('切换密码显示，当前状态:', this.data.showPassword);
    this.setData({
      showPassword: !this.data.showPassword
    }, () => {
      console.log('切换后状态:', this.data.showPassword);
    });
  },

  loginWithPassword: function() {
    console.log('点击登录按钮');
    const phone = this.data.inputPhone;
    const password = this.data.inputPassword;
    
    console.log('输入的账号:', phone);
    
    // 兼容该后台账号；普通手机号仍要求 11 位。
    const isPurchaseQueryOnlyAccount = phone === '13800138001';
    if (!phone || (!isPurchaseQueryOnlyAccount && phone.length !== 11)) {
      wx.showToast({
        title: '请输入正确的账号',
        icon: 'none'
      });
      return;
    }
    
    if (!password) {
      wx.showToast({
        title: '请输入密码',
        icon: 'none'
      });
      return;
    }
    
    this.setData({ loading: true, message: '正在验证...' });
    console.log('开始调用 verifyUserPassword');
    
    DataStorage.verifyUserPassword(phone, password, 
      (userInfo) => {
        this.setData({ loading: false });
        
        if (userInfo) {
          console.log('登录成功:', userInfo);
          
          const userData = {
            userId: userInfo._id || userInfo.id,
            staffId: userInfo.staffId || userInfo._id || userInfo.id,
            userName: userInfo.name,
            userRole: userInfo.role,
            roleCode: userInfo.roleCode || '',
            roleName: userInfo.roleName || '',
            roleNames: userInfo.roleNames || [],
            roles: userInfo.roles || [],
            scopeType: userInfo.scopeType || userInfo.scope_type || '',
            phoneNumber: phone,
            distributorId: userInfo.distributorId || userInfo.distributor_id || '',
            distributorName: userInfo.distributorName || userInfo.distributor_name || '',
            storeId: userInfo.storeId || userInfo.store_id || '',
            storeName: userInfo.storeName || userInfo.store_name || '',
            storeIds: userInfo.storeIds || userInfo.store_ids || [],
            regionId: userInfo.regionId || userInfo.region_id || '',
            regionCode: userInfo.regionCode || userInfo.region_code || '',
            regionName: userInfo.regionName || userInfo.region_name || '',
            regionCodes: userInfo.regionCodes || userInfo.region_codes || [],
            menus: userInfo.menus || []
          };
          
          console.log('登录成功，保存的用户信息:', userData);
          
          userUtils.setUserInfo(userData);
          
          this.setData({
            hasPhoneAuth: true,
            phoneNumber: phone,
            userInfo: userData,
            authStatus: 'authorized',
            currentStoreName: this.getCurrentStoreName(userData),
            isDistributor: userUtils.isDistributor(userData),
            message: '登录成功，点击进入系统'
          });
          
          wx.showToast({
            title: '登录成功',
            icon: 'success'
          });
          
          this.saveCurrentStore(userData);
        } else {
          this.setData({
            authStatus: 'unauthorized',
            message: '账号或密码错误'
          });
          wx.showToast({
            title: '账号或密码错误',
            icon: 'none'
          });
        }
      },
      (err) => {
        console.error('登录验证失败:', err);
        const credentialError = isCredentialError(err);
        this.setData({ 
          loading: false,
          authStatus: 'unauthorized',
          message: credentialError
            ? '账号或密码错误'
            : '登录服务仍在启动，请稍后重试'
        });
        wx.showToast({
          title: credentialError ? '账号或密码错误' : '服务启动中',
          icon: 'none'
        });
      }
    );
  },

  goToHome: function() {
    const currentUserInfo = userUtils.getUserInfo();
    if (this._navigatingToHome || !currentUserInfo) return;

    this._navigatingToHome = true;
    this.saveCurrentStore(currentUserInfo);
    const app = getApp();
    app.globalData.userInfo = userUtils.getUserInfo();
    wx.switchTab({
      url: '/pages/index/index',
      success: () => {
        // 页面先进入，数据库在后台激活；失败只记录日志，后续实际查询会自行重试。
        app.activateDatabase({ force: true })
          .catch(err => console.error('后台激活数据库失败，等待业务查询重试:', err));
      },
      fail: err => {
        console.error('进入首页失败:', err);
        wx.showToast({ title: '进入失败，请重试', icon: 'none' });
      },
      complete: () => {
        this._navigatingToHome = false;
      }
    });
  },

  saveCurrentStore: function(userInfo) {
    if (userUtils.isDistributor(userInfo)) {
      const currentUserInfo = Object.assign({}, userUtils.getUserInfo(), { storeId: '', storeName: '' });
      userUtils.setUserInfo(currentUserInfo);
      wx.removeStorageSync('tempStoreInfo');
      this.setData({ userInfo: currentUserInfo, currentStoreName: this.getCurrentStoreName(currentUserInfo) });
      return;
    }
    const tempStoreInfo = wx.getStorageSync('tempStoreInfo') || {};
    const store = userInfo || {};
    const currentUserInfo = userUtils.getUserInfo();
    const storeId = store.storeId || store.store_id || tempStoreInfo.storeId || currentUserInfo.storeId || '';
    const storeName = store.storeName || store.store_name || store.name || tempStoreInfo.storeName || currentUserInfo.storeName || '';
    const nextUserInfo = Object.assign({}, currentUserInfo, {
      storeId: storeId,
      storeName: storeName
    });

    userUtils.setUserInfo(nextUserInfo);
    wx.setStorageSync('tempStoreInfo', {
      storeId: storeId,
      storeName: storeName
    });

    this.setData({
      userInfo: nextUserInfo,
      currentStoreName: this.getCurrentStoreName(nextUserInfo)
    });
  }
});
