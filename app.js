// app.js
App({
  onLaunch() {
    // 初始化云开发环境
    this.globalData.cloudInitFailed = true;
    this.globalData.cloudInitError = null;
    if (!wx.cloud) {
      const errorMsg = '请使用 2.2.3 或以上的基础库以使用云能力';
      console.error(errorMsg);
      this.globalData.cloudInitError = errorMsg;
    } else {
      try {
        wx.cloud.init({
          env: 'cloud1-8glwjlnq4c74f7f1',
          traceUser: true,
        });
        this.globalData.cloudInitFailed = false;
        this.globalData.cloudInitError = null;
      } catch (e) {
        const errorMsg = '云开发初始化失败: ' + (e.message || JSON.stringify(e));
        console.error(errorMsg);
        this.globalData.cloudInitFailed = true;
        this.globalData.cloudInitError = errorMsg;
      }
    }

    try {
      require('./utils/cloud-adapter.js').install();
    } catch (e) {
      console.error('ANY-ERP MySQL adapter install failed:', e);
    }

    // 初始化本地存储
    this.initStorage();

    // 获取用户信息并验证授权
    this.checkUserAuthorization();
  },

  onShow() {
    // 仅在用户已经进入系统后刷新。首次启动由“进入门店”显式激活数据库，
    // 避免启动阶段多个查询争抢尚未就绪的云托管/MySQL连接。
    if (this.globalData.databaseReady) {
      this.activateDatabase({ force: true })
        .then(() => this.refreshUserInfo())
        .catch(err => console.error('小程序恢复时数据库激活失败:', err));
    }
  },

  /**
   * 激活云托管服务和 MySQL 连接。
   * 同一时间只允许一个激活请求，避免页面重复进入时并发冷启动。
   */
  activateDatabase(options = {}) {
    const force = !!options.force;
    if (this.globalData.databaseReady && !force) {
      return Promise.resolve({ ready: true });
    }
    if (this._databaseActivationPromise) {
      return this._databaseActivationPromise;
    }

    const api = require('./utils/api.js');
    this.globalData.databaseReady = false;
    this._databaseActivationPromise = api.system.activateDatabase()
      .then(result => {
        this.globalData.databaseReady = true;
        this.globalData.databaseReadyAt = Date.now();
        return result;
      })
      .catch(err => {
        this.globalData.databaseReady = false;
        throw err;
      })
      .then(result => {
        this._databaseActivationPromise = null;
        return result;
      }, err => {
        this._databaseActivationPromise = null;
        throw err;
      });

    return this._databaseActivationPromise;
  },

  /**
   * 刷新用户信息（从数据库获取最新的用户名）
   */
  refreshUserInfo() {
    const cachedUserInfo = wx.getStorageSync('userInfo');
    if (!cachedUserInfo || !cachedUserInfo.phoneNumber) {
      console.log('refreshUserInfo: 无用户信息，跳过刷新');
      return Promise.resolve(null);
    }

    console.log('refreshUserInfo: 开始刷新当前登录用户');

    // /system/users 是用户管理接口，普通员工无权访问。刷新当前用户应使用个人资料接口。
    const api = require('./utils/api.js');
    return api.auth.getProfile()
      .then(userInfo => {
        if (!userInfo) return null;
        const updatedUserInfo = {
          ...cachedUserInfo,
          ...userInfo,
          userName: userInfo.name || userInfo.userName || cachedUserInfo.userName,
          phoneNumber: userInfo.phoneNumber || userInfo.phone || cachedUserInfo.phoneNumber,
          userRole: userInfo.role || userInfo.userRole || cachedUserInfo.userRole,
          storeId: userInfo.storeId || '',
          storeName: userInfo.storeName || '',
          distributorId: userInfo.distributorId || cachedUserInfo.distributorId
        };
        const roleValues = [updatedUserInfo.userRole, updatedUserInfo.roleCode]
          .concat(Array.isArray(updatedUserInfo.roles) ? updatedUserInfo.roles : [])
          .map(value => String(value || '').trim().toLowerCase())
          .filter(Boolean);
        if (roleValues.some(role => !['clerk', 'staff', 'manager', 'store_manager', 'store_admin'].includes(role))) {
          wx.removeStorageSync('tempStoreInfo');
          updatedUserInfo.storeId = '';
          updatedUserInfo.storeName = '';
        }
        wx.setStorageSync('userInfo', updatedUserInfo);
        this.globalData.userInfo = updatedUserInfo;
        console.log('refreshUserInfo: 当前用户信息已更新');
        return updatedUserInfo;
      })
      .catch(err => {
        // 刷新失败不影响照片选择/上传及当前登录会话，继续使用缓存资料。
        console.warn('refreshUserInfo: 当前用户资料刷新失败，继续使用缓存:', err && err.message ? err.message : err);
        return cachedUserInfo;
      });
  },

  /**
   * 检查云开发环境是否可用
   */
  isCloudAvailable() {
    return !this.globalData.cloudInitFailed;
  },

  /**
   * 获取云开发状态
   */
  getCloudStatus() {
    return {
      available: !this.globalData.cloudInitFailed,
      error: this.globalData.cloudInitError
    };
  },

  initStorage() {
    // 引入数据存储工具
    const DataStorage = require('./utils/storage.js');
    
    // 初始化数据库
    DataStorage.init();

    // 启动时只恢复缓存，不访问数据库。数据库由用户点击“进入门店”后激活。
    const userInfo = wx.getStorageSync('userInfo') || {};
    const tempStoreInfo = wx.getStorageSync('tempStoreInfo') || {};
    const roleValues = [userInfo.userRole, userInfo.roleCode]
      .concat(Array.isArray(userInfo.roles) ? userInfo.roles : [])
      .map(value => String(value || '').trim().toLowerCase())
      .filter(Boolean);
    const isStoreScoped = roleValues.length > 0 && roleValues.every(role => ['clerk', 'staff', 'manager', 'store_manager', 'store_admin'].includes(role));
    if (!isStoreScoped) wx.removeStorageSync('storeInfo');
    this.globalData.storeInfo = isStoreScoped ? (wx.getStorageSync('storeInfo') || {
      storeId: isStoreScoped ? (tempStoreInfo.storeId || userInfo.storeId || '') : '',
      name: isStoreScoped ? (tempStoreInfo.storeName || userInfo.storeName || '') : (userInfo.distributorName || ''),
      address: '',
      phone: '',
      managerName: '',
      managerPhone: '',
      staffList: []
    }) : {
      storeId: '',
      name: userInfo.distributorName || '',
      address: '',
      phone: '',
      managerName: '',
      managerPhone: '',
      staffList: []
    };
  },

  /**
   * 检查用户授权状态
   */
  checkUserAuthorization() {
    // 先检查本地缓存的用户信息
    const cachedUserInfo = wx.getStorageSync('userInfo');
    if (cachedUserInfo && cachedUserInfo.phoneNumber) {
      console.log('使用本地缓存的用户信息:', cachedUserInfo);
      this.globalData.userInfo = cachedUserInfo;
      
      // 如果用户已授权，直接使用缓存信息
      if (cachedUserInfo.userRole && cachedUserInfo.userRole !== 'unauthorized') {
        console.log('用户已授权，跳过验证');
        this.globalData.authorized = true;
        return;
      }
    }
    
    // 获取用户信息
    wx.getSetting({
      success: res => {
        if (res.authSetting['scope.userInfo']) {
          // 已经授权，可以直接调用 getUserInfo 获取头像昵称，不会弹框
          wx.getUserInfo({
            success: res => {
              // 可以将 res 发送给后台解码出 unionId
              this.globalData.userInfo = res.userInfo;
              
              // 验证手机号码
              this.verifyPhoneNumber();
            }
          });
        } else {
          // 未授权，跳转到授权页面
          wx.showModal({
            title: '授权提示',
            content: '需要获取您的授权才能使用小程序功能',
            success: (modalRes) => {
              if (modalRes.confirm) {
                wx.navigateTo({
                  url: '/pages/profile/profile'
                });
              }
            }
          });
        }
      }
    });
  },

  /**
   * 验证手机号码
   * 降级方案：使用本地缓存，不依赖 getPhoneNumber 云函数
   */
  verifyPhoneNumber() {
    // 使用本地缓存的用户信息
    const cachedUserInfo = wx.getStorageSync('userInfo');
    if (cachedUserInfo && cachedUserInfo.phoneNumber) {
      console.log('verifyPhoneNumber: 使用本地缓存的手机号');
      this.globalData.userInfo.phoneNumber = cachedUserInfo.phoneNumber;
      
      // 如果已有授权，直接返回
      if (cachedUserInfo.userRole && cachedUserInfo.userRole !== 'unauthorized') {
        console.log('verifyPhoneNumber: 用户已授权，跳过验证');
        this.globalData.authorized = true;
        return;
      }
      
      // 如果没有授权，尝试验证
      console.log('verifyPhoneNumber: 尝试验证授权');
      this.checkUserInAuthorizationList(cachedUserInfo.phoneNumber);
      return;
    }
    
    // 没有缓存，静默等待用户登录
    console.log('verifyPhoneNumber: 无缓存，等待用户登录');
  },

  /**
   * 检查用户是否在授权列表中
   */
  checkUserInAuthorizationList(phoneNumber) {
    try {
      // 引入数据存储工具
      const DataStorage = require('./utils/storage.js');
      
      // 从数据库获取门店信息
      DataStorage.getStoreInfo((storeInfo) => {
        // 从门店信息中获取员工列表
        const staffList = storeInfo.staffList || [];
        
        // 查找员工信息
        const authorizedStaff = staffList.find(staff => staff.phone === phoneNumber);
        
        if (authorizedStaff) {
          // 用户在授权列表中
          this.globalData.authorized = true;
          this.globalData.authorizedUser = authorizedStaff;
          
          // 保存用户信息到本地
          wx.setStorageSync('userInfo', {
            ...this.globalData.userInfo,
            userName: authorizedStaff.name,
            userRole: this.getUserRole(authorizedStaff.position),
            phoneNumber: phoneNumber
          });
        } else {
          // 用户不在授权列表中
          this.globalData.authorized = false;
          this.globalData.authorizedUser = null;
          
          // 保存未授权用户信息
          wx.setStorageSync('userInfo', {
            ...this.globalData.userInfo,
            userName: '未授权用户',
            userRole: 'unauthorized',
            phoneNumber: phoneNumber
          });
          
          // 显示未授权提示
          wx.showModal({
            title: '未授权',
            content: '您的手机号码未在授权列表中，请联系管理员添加授权',
            showCancel: false
          });
        }
      }, (err) => {
        console.error('获取门店信息失败', err);
        // 用户不在授权列表中
        this.globalData.authorized = false;
        this.globalData.authorizedUser = null;
        
        // 保存未授权用户信息
        wx.setStorageSync('userInfo', {
          ...this.globalData.userInfo,
          userName: '未授权用户',
          userRole: 'unauthorized',
          phoneNumber: phoneNumber
        });
        
        // 显示未授权提示
        wx.showModal({
          title: '未授权',
          content: '无法验证您的授权信息，请联系管理员',
          showCancel: false
        });
      });
    } catch (error) {
      console.error('检查用户授权失败', error);
      this.globalData.authorized = false;
      this.globalData.authorizedUser = null;
      
      // 显示未授权提示
      wx.showModal({
        title: '未授权',
        content: '无法验证您的授权信息，请联系管理员',
        showCancel: false
      });
    }
  },

  /**
   * 根据职位获取用户角色
   */
  getUserRole(position) {
    if (position.includes('经销商') || position.includes('总')) {
      return 'distributor';
    } else if (position.includes('店长') || position.includes('经理')) {
      return 'store_admin';
    } else {
      return 'staff';
    }
  },

  globalData: {
    userInfo: null,
    storeInfo: null,
    printerInfo: null,
    cloudInitFailed: false,
    cloudInitError: null,
    authorized: false, // 用户是否已授权
    authorizedUser: null, // 授权用户信息
    databaseReady: false,
    databaseReadyAt: 0
  }
})
