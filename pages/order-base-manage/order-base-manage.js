// pages/order-base-manage/order-base-manage.js
const DataStorage = require('../../utils/storage.js');
const userUtils = require('../profile/user-utils.js');

// 确保不会自动调用任何打开弹窗的函数
console.log('订单基础管理页面模块加载');

Page({
  /**
   * 页面的初始数据
   */
  data: {
    customerSources: [], // 客户来源列表
    paymentMethods: [], // 收款方式列表
    showEditModal: false, // 编辑弹窗显示状态
    editingType: '', // 编辑类型：customerSource 或 paymentMethod
    editingItem: null, // 正在编辑的项
    editName: '' // 编辑的名称
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: function (options) {
    console.log('订单基础管理页面加载，options:', options);
    
    // 清理可能导致问题的缓存
    try {
      const orderBaseEditingType = wx.getStorageSync('orderBaseEditingType');
      if (orderBaseEditingType) {
        console.warn('发现缓存的 editingType:', orderBaseEditingType);
        wx.removeStorageSync('orderBaseEditingType');
        console.log('已清理缓存的 editingType');
      }
    } catch (error) {
      console.error('清理缓存失败:', error);
    }
    
    // 检查是否有自动打开弹窗的参数
    if (options && (options.autoOpen || options.type)) {
      console.warn('发现可能导致自动打开弹窗的参数:', options);
      // 忽略这些参数，确保不会自动打开弹窗
    }
    
    // 强制重置所有状态，确保不会自动打开弹窗
    this.setData({
      showEditModal: false,
      editingType: '',
      editingItem: null,
      editName: ''
    });
    console.log('状态已重置，showEditModal:', this.data.showEditModal);
    console.log('状态已重置，editingType:', this.data.editingType);
    
    // 延迟加载数据，确保状态完全重置
    setTimeout(() => {
      console.log('延迟加载数据');
      this.loadData();
    }, 100);
  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow: function () {
    console.log('订单基础管理页面显示');
    // 确保弹窗状态为关闭
    if (this.data.showEditModal) {
      console.log('发现弹窗为打开状态，关闭弹窗');
      this.setData({
        showEditModal: false,
        editingType: '',
        editingItem: null,
        editName: ''
      });
    }
    // 重新加载数据
    this.loadData();
  },

  /**
   * 加载所有数据
   */
  loadData: function () {
    wx.showLoading({
      title: '加载中...',
    });
    
    // 加载客户来源
    DataStorage.getCustomerSources(
      (sources) => {
        this.setData({
          customerSources: sources
        });
        
        // 加载收款方式
        DataStorage.getPaymentMethods(
          (methods) => {
            this.setData({
              paymentMethods: methods
            });
            wx.hideLoading();
          },
          (err) => {
            console.error('获取收款方式失败:', err);
            this.setData({
              paymentMethods: []
            });
            wx.hideLoading();
          }
        );
      },
      (err) => {
        console.error('获取客户来源失败:', err);
        this.setData({
          customerSources: []
        });
        wx.hideLoading();
      }
    );
  },

  /**
   * 打开编辑弹窗
   */
  openEditModal: function (type, item = null) {
    console.log('打开编辑弹窗，类型:', type, '，项目:', item);
    
    this.setData({
      showEditModal: true,
      editingType: type,
      editingItem: item,
      editName: item ? item.name : ''
    });
  },

  /**
   * 新增客户来源
   */
  addCustomerSource: function () {
    this.openEditModal('customerSource');
  },

  /**
   * 编辑客户来源
   */
  editCustomerSource: function (e) {
    const item = e.currentTarget.dataset.item;
    this.openEditModal('customerSource', item);
  },

  /**
   * 删除客户来源
   */
  deleteCustomerSource: function (e) {
    const id = e.currentTarget.dataset.id;
    
    wx.showModal({
      title: '确认删除',
      content: '确定要删除此客户来源吗？',
      success: (res) => {
        if (res.confirm) {
          DataStorage.deleteCustomerSource(id, 
            (res) => {
              wx.showToast({
                title: '删除成功',
                icon: 'success'
              });
              // 重新加载数据
              this.loadData();
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
   * 新增收款方式
   */
  addPaymentMethod: function () {
    console.log('手动调用 addPaymentMethod 函数');
    this.openEditModal('paymentMethod');
  },

  /**
   * 编辑收款方式
   */
  editPaymentMethod: function (e) {
    const item = e.currentTarget.dataset.item;
    this.openEditModal('paymentMethod', item);
  },

  /**
   * 删除收款方式
   */
  deletePaymentMethod: function (e) {
    const id = e.currentTarget.dataset.id;
    
    wx.showModal({
      title: '确认删除',
      content: '确定要删除此收款方式吗？',
      success: (res) => {
        if (res.confirm) {
          DataStorage.deletePaymentMethod(id, 
            (res) => {
              wx.showToast({
                title: '删除成功',
                icon: 'success'
              });
              // 重新加载数据
              this.loadData();
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
   * 关闭编辑弹窗
   */
  closeEditModal: function () {
    this.setData({
      showEditModal: false,
      editingType: '',
      editingItem: null,
      editName: ''
    });
  },

  /**
   * 编辑名称输入
   */
  onEditNameInput: function (e) {
    this.setData({
      editName: e.detail.value
    });
  },

  /**
   * 保存编辑
   */
  saveEdit: function () {
    const { editingType, editingItem, editName } = this.data;
    
    // 验证输入
    if (!editName.trim()) {
      wx.showToast({
        title: '请输入名称',
        icon: 'none'
      });
      return;
    }
    
    // 准备保存的数据
    const saveData = {
      name: editName.trim()
    };
    
    if (editingItem) {
      saveData.id = editingItem.id;
    }
    
    wx.showLoading({
      title: '保存中...',
    });
    
    // 根据编辑类型保存
    if (editingType === 'customerSource') {
      // 保存客户来源
      DataStorage.saveCustomerSource(saveData, 
        (res) => {
          wx.hideLoading();
          wx.showToast({
            title: '保存成功',
            icon: 'success'
          });
          this.closeEditModal();
          this.loadData();
        },
        (err) => {
          wx.hideLoading();
          wx.showToast({
            title: '保存失败: ' + err,
            icon: 'none'
          });
        }
      );
    } else if (editingType === 'paymentMethod') {
      // 保存收款方式
      DataStorage.savePaymentMethod(saveData, 
        (res) => {
          wx.hideLoading();
          wx.showToast({
            title: '保存成功',
            icon: 'success'
          });
          this.closeEditModal();
          this.loadData();
        },
        (err) => {
          wx.hideLoading();
          wx.showToast({
            title: '保存失败: ' + err,
            icon: 'none'
          });
        }
      );
    } else {
      wx.hideLoading();
      wx.showToast({
        title: '操作异常，请重试',
        icon: 'none'
      });
    }
  }
});