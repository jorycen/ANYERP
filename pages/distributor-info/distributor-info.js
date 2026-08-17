// pages/distributor-info/distributor-info.js
const userUtils = require('../profile/user-utils.js');
const DataStorage = require('../../utils/storage.js');

Page({
  /**
   * 页面的初始数据
   */
  data: {
    distributorInfo: {
      name: '成都艾诺云科技有限公司',
      address: '四川省成都市力宝大厦南楼1013',
      phone: '',
      staffList: []
    },
    canManage: false, // 是否有权限管理经销商信息
    showEditModal: false, // 是否显示编辑弹窗
    editingStaff: false, // 是否正在编辑员工
    editIndex: -1, // 正在编辑的员工索引
    editStaff: {
      name: '',
      position: '',
      phone: ''
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
    const canManage = userUtils.isDistributor() || userUtils.isStoreAdmin();
    
    this.setData({
      canManage: canManage
    });
    
    // 加载经销商信息
    this.loadDistributorInfo();
  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow: function () {
    // 页面显示时重新加载数据
    this.loadDistributorInfo();
  },

  /**
   * 加载经销商信息
   */
  loadDistributorInfo: function () {
    wx.showLoading({
      title: '加载中...',
    });
    
    // 使用 DataStorage 加载经销商信息
    DataStorage.getDistributorInfo(
      (distributorInfo) => {
        // 确保staffList存在
        if (!distributorInfo.staffList) {
          distributorInfo.staffList = [];
        }
        
        console.log('加载到的经销商信息:', distributorInfo);
        
        this.setData({
          distributorInfo: distributorInfo
        });
        
        wx.hideLoading();
      },
      (err) => {
        console.error('加载经销商信息失败', err);
        
        // 加载失败时使用默认值
        const defaultDistributorInfo = {
          id: 'DISTRIBUTOR_1',
          name: '成都艾诺云科技有限公司',
          address: '四川省成都市力宝大厦南楼1013',
          phone: '',
          staffList: []
        };
        
        this.setData({
          distributorInfo: defaultDistributorInfo
        });
        
        wx.hideLoading();
        wx.showToast({
          title: '加载失败，使用默认信息',
          icon: 'none'
        });
      }
    );
  },

  /**
   * 添加员工
   */
  addStaff: function () {
    this.setData({
      showEditModal: true,
      editingStaff: false,
      editIndex: -1,
      editStaff: {
        name: '',
        position: '',
        phone: ''
      }
    });
  },

  /**
   * 编辑员工
   */
  editStaff: function (e) {
    const index = e.currentTarget.dataset.index;
    const staff = e.currentTarget.dataset.staff;
    
    this.setData({
      showEditModal: true,
      editingStaff: true,
      editIndex: index,
      editStaff: {
        name: staff.name,
        position: staff.position,
        phone: staff.phone
      }
    });
  },

  /**
   * 删除员工
   */
  deleteStaff: function (e) {
    const index = e.currentTarget.dataset.index;
    const distributorInfo = this.data.distributorInfo;
    const staffName = distributorInfo.staffList[index].name;
    
    wx.showModal({
      title: '确认删除',
      content: '确定要删除员工"' + staffName + '"吗？',
      success: (res) => {
        if (res.confirm) {
          // 删除员工
          distributorInfo.staffList.splice(index, 1);
          
          // 保存经销商信息
          this.saveDistributorInfo(distributorInfo);
        }
      }
    });
  },

  /**
   * 关闭编辑弹窗
   */
  closeEditModal: function () {
    this.setData({
      showEditModal: false
    });
  },

  /**
   * 员工姓名输入
   */
  onStaffNameInput: function (e) {
    const value = e.detail.value;
    this.setData({
      'editStaff.name': value
    });
  },

  /**
   * 员工职位输入
   */
  onStaffPositionInput: function (e) {
    const value = e.detail.value;
    this.setData({
      'editStaff.position': value
    });
  },

  /**
   * 员工电话输入
   */
  onStaffPhoneInput: function (e) {
    const value = e.detail.value;
    this.setData({
      'editStaff.phone': value
    });
  },

  onStaffPasswordInput: function (e) {
    const value = e.detail.value;
    this.setData({
      'editStaff.password': value
    });
  },

  /**
   * 保存员工信息
   */
  saveStaff: function (e) {
    const editStaff = this.data.editStaff;
    
    // 验证表单
    if (!editStaff.name || !editStaff.position || !editStaff.phone) {
      wx.showToast({
        title: '请填写完整的员工信息',
        icon: 'none'
      });
      return;
    }
    
    // 验证手机号格式
    const phoneRegex = /^1[3-9]\d{9}$/;
    if (!phoneRegex.test(editStaff.phone)) {
      wx.showToast({
        title: '请输入正确的手机号码',
        icon: 'none'
      });
      return;
    }
    
    const distributorInfo = this.data.distributorInfo;
    
    if (this.data.editingStaff) {
      // 更新现有员工
      distributorInfo.staffList[this.data.editIndex] = editStaff;
    } else {
      // 添加新员工
      distributorInfo.staffList.push(editStaff);
    }
    
    // 保存经销商信息
    this.saveDistributorInfo(distributorInfo);
    
    // 关闭弹窗
    this.setData({
      showEditModal: false
    });
  },

  /**
   * 保存经销商信息
   */
  saveDistributorInfo: function (distributorInfo) {
    wx.showLoading({
      title: '保存中...',
    });
    
    // 使用 DataStorage 保存经销商信息
    DataStorage.saveDistributorInfo(distributorInfo, 
      (res) => {
        // 更新页面数据
        this.setData({
          distributorInfo: distributorInfo
        });
        
        wx.hideLoading();
        wx.showToast({
          title: '保存成功',
          icon: 'success'
        });
      },
      (err) => {
        console.error('保存经销商信息失败', err);
        wx.hideLoading();
        wx.showToast({
          title: '保存失败',
          icon: 'none'
        });
      }
    );
  },

  noop: function () {}
});
