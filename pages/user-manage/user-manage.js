// pages/user-manage/user-manage.js
const userUtils = require('../profile/user-utils.js');
const DataStorage = require('../../utils/storage.js');

Page({
  data: {
    userList: [],
    loading: true,
    showResetModal: false,
    selectedUser: null,
    newPassword: '',
    confirmPassword: ''
  },

  onLoad: function () {
    this.loadUsers();
  },

  onShow: function () {
    this.loadUsers();
  },

  loadUsers: function () {
    const userInfo = userUtils.getUserInfo();
    
    if (userInfo.userRole !== userUtils.USER_ROLES.DISTRIBUTOR) {
      wx.showToast({
        title: '您没有权限访问此页面',
        icon: 'none'
      });
      setTimeout(() => {
        wx.navigateBack();
      }, 1500);
      return;
    }
    
    const distributorId = userInfo.distributorId;
    
    DataStorage.getAllStaffByDistributor(distributorId, 
      (staffList) => {
        DataStorage.getUsersByDistributor(distributorId, 
          (users) => {
            const mergedList = this.mergeStaffAndUsers(staffList, users);
            this.setData({
              userList: mergedList,
              loading: false
            });
          },
          (err) => {
            console.error('获取用户列表失败:', err);
            this.setData({
              userList: staffList.map(s => ({ ...s, hasPassword: false })),
              loading: false
            });
          }
        );
      },
      (err) => {
        console.error('获取员工列表失败:', err);
        this.setData({
          loading: false
        });
        wx.showToast({
          title: '获取员工列表失败',
          icon: 'none'
        });
      }
    );
  },

  mergeStaffAndUsers: function (staffList, users) {
    return staffList.map(staff => {
      const user = users.find(u => u.phone === staff.phone);
      // 优先从staff对象中获取password（存储在stores/distributors集合中）
      // 如果没有，则尝试从users集合中获取
      const password = staff.password || (user ? user.password : null);
      return {
        ...staff,
        _id: user ? user._id : null,
        hasPassword: !!password,
        password: password || ''
      };
    });
  },

  showResetPassword: function (e) {
    const user = e.currentTarget.dataset.user;
    this.setData({
      showResetModal: true,
      selectedUser: user,
      newPassword: '',
      confirmPassword: ''
    });
  },

  hideResetModal: function () {
    this.setData({
      showResetModal: false,
      selectedUser: null
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

  confirmResetPassword: function () {
    const { selectedUser, newPassword, confirmPassword } = this.data;
    
    if (!newPassword) {
      wx.showToast({
        title: '请输入新密码',
        icon: 'none'
      });
      return;
    }
    
    if (newPassword.length < 6) {
      wx.showToast({
        title: '密码至少6位',
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
    
    wx.showLoading({ title: '重置中...' });
    
    DataStorage.resetUserPassword(selectedUser.phone, newPassword,
      (res) => {
        wx.hideLoading();
        wx.showToast({
          title: '密码重置成功',
          icon: 'success'
        });
        this.hideResetModal();
        this.loadUsers();
      },
      (err) => {
        wx.hideLoading();
        wx.showToast({
          title: '重置失败',
          icon: 'none'
        });
      }
    );
  },

  resetToDefault: function () {
    const { selectedUser } = this.data;
    const defaultPassword = selectedUser.phone.slice(-6);
    
    this.setData({
      newPassword: defaultPassword,
      confirmPassword: defaultPassword
    });
  }
});
