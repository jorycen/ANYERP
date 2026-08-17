// pages/store-add/store-add.js
const userUtils = require('../profile/user-utils.js');
const DataStorage = require('../../utils/storage.js');

Page({
  /**
   * 页面的初始数据
   */
  data: {
    storeInfo: {
      name: '',
      address: '',
      phone: '',
      managerName: '',
      managerPhone: '',
      staffList: [
        {
          name: '',
          phone: ''
        }
      ]
    }
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
    if (!userUtils.canManageStore()) {
      wx.showToast({
        title: '您没有权限新增门店信息',
        icon: 'none'
      });
      setTimeout(() => {
        wx.navigateBack();
      }, 1500);
      return;
    }
  },

  /**
   * 门店名称输入
   */
  onStoreNameInput: function (e) {
    this.setData({
      'storeInfo.name': e.detail.value
    });
  },

  /**
   * 门店地址输入
   */
  onStoreAddressInput: function (e) {
    this.setData({
      'storeInfo.address': e.detail.value
    });
  },

  /**
   * 门店电话输入
   */
  onStorePhoneInput: function (e) {
    this.setData({
      'storeInfo.phone': e.detail.value
    });
  },

  /**
   * 店长姓名输入
   */
  onManagerNameInput: function (e) {
    this.setData({
      'storeInfo.managerName': e.detail.value
    });
  },

  /**
   * 店长电话输入
   */
  onManagerPhoneInput: function (e) {
    this.setData({
      'storeInfo.managerPhone': e.detail.value
    });
  },

  /**
   * 店员姓名输入
   */
  onStaffNameInput: function (e) {
    const index = e.currentTarget.dataset.index;
    const value = e.detail.value;
    const staffList = this.data.storeInfo.staffList;
    staffList[index].name = value;
    this.setData({
      'storeInfo.staffList': staffList
    });
  },

  /**
   * 店员电话输入
   */
  onStaffPhoneInput: function (e) {
    const index = e.currentTarget.dataset.index;
    const value = e.detail.value;
    const staffList = this.data.storeInfo.staffList;
    staffList[index].phone = value;
    this.setData({
      'storeInfo.staffList': staffList
    });
  },

  /**
   * 添加店员
   */
  addStaff: function () {
    const staffList = this.data.storeInfo.staffList;
    staffList.push({
      name: '',
      phone: ''
    });
    this.setData({
      'storeInfo.staffList': staffList
    });
  },

  /**
   * 删除店员
   */
  deleteStaff: function (e) {
    const index = e.currentTarget.dataset.index;
    const staffList = this.data.storeInfo.staffList;
    if (staffList.length > 1) {
      staffList.splice(index, 1);
      this.setData({
        'storeInfo.staffList': staffList
      });
    }
  },

  /**
   * 取消编辑
   */
  cancelEdit: function () {
    wx.navigateBack();
  },

  /**
   * 表单提交
   */
  onSubmit: function (e) {
    const storeInfo = this.data.storeInfo;
    
    // 验证表单
    if (!storeInfo.name || !storeInfo.address || !storeInfo.phone) {
      wx.showToast({
        title: '请填写完整的门店基础信息',
        icon: 'none'
      });
      return;
    }
    
    // 保存门店信息
    DataStorage.saveStore(storeInfo, 
      (res) => {
        wx.showToast({
          title: '门店新增成功',
          icon: 'success'
        });
        
        setTimeout(() => {
          wx.navigateTo({
            url: '/pages/store-list/store-list'
          });
        }, 1500);
      },
      (err) => {
        wx.showToast({
          title: '门店新增失败: ' + err,
          icon: 'none'
        });
      }
    );
  }
})