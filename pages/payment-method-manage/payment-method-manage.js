// pages/payment-method-manage/payment-method-manage.js
const DataStorage = require('../../utils/storage.js');

Page({
  /**
   * 页面的初始数据
   */
  data: {
    paymentMethods: [], // 收款方式列表
    showAddModal: false, // 新增弹窗显示状态
    newName: '', // 新增名称
    newSortOrder: 0 // 新增排序号
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: function (options) {
    console.log('收款方式管理页面加载');
    this.loadData();
  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow: function () {
    console.log('收款方式管理页面显示');
    this.loadData();
  },

  /**
   * 加载收款方式数据
   */
  loadData: function () {
    wx.showLoading({
      title: '加载中...',
    });

    // 加载收款方式
    DataStorage.getPaymentMethods(
      (methods) => {
        // 为每个项目添加编辑状态
        const methodsWithEditState = methods.map(item => ({
          ...item,
          isEditing: false,
          editName: item.name,
          editSortOrder: item.sortOrder || 0
        }));

        this.setData({
          paymentMethods: methodsWithEditState
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

  /**
   * 开始编辑
   */
  startEdit: function (e) {
    const index = e.currentTarget.dataset.index;
    const paymentMethods = this.data.paymentMethods;

    // 先取消其他项的编辑状态
    paymentMethods.forEach((item, i) => {
      if (i !== index) {
        item.isEditing = false;
        item.editName = item.name;
        item.editSortOrder = item.sortOrder || 0;
      }
    });

    // 设置当前项为编辑状态
    paymentMethods[index].isEditing = true;
    paymentMethods[index].editName = paymentMethods[index].name;
    paymentMethods[index].editSortOrder = paymentMethods[index].sortOrder || 0;

    this.setData({
      paymentMethods: paymentMethods
    });
  },

  /**
   * 取消编辑
   */
  cancelEdit: function (e) {
    const index = e.currentTarget.dataset.index;
    const paymentMethods = this.data.paymentMethods;

    paymentMethods[index].isEditing = false;
    paymentMethods[index].editName = paymentMethods[index].name;
    paymentMethods[index].editSortOrder = paymentMethods[index].sortOrder || 0;

    this.setData({
      paymentMethods: paymentMethods
    });
  },

  /**
   * 名称输入
   */
  onNameInput: function (e) {
    const index = e.currentTarget.dataset.index;
    const value = e.detail.value;
    const paymentMethods = this.data.paymentMethods;

    paymentMethods[index].editName = value;

    this.setData({
      paymentMethods: paymentMethods
    });
  },

  /**
   * 排序号输入
   */
  onSortInput: function (e) {
    const index = e.currentTarget.dataset.index;
    const value = parseInt(e.detail.value) || 0;
    const paymentMethods = this.data.paymentMethods;

    paymentMethods[index].editSortOrder = value;

    this.setData({
      paymentMethods: paymentMethods
    });
  },

  /**
   * 保存编辑项
   */
  saveItem: function (e) {
    const index = e.currentTarget.dataset.index;
    const item = this.data.paymentMethods[index];

    // 验证输入
    if (!item.editName.trim()) {
      wx.showToast({
        title: '请输入名称',
        icon: 'none'
      });
      return;
    }

    wx.showLoading({ title: '保存中...' });

    // 准备保存的数据
    const saveData = {
      id: item._id,
      name: item.editName.trim(),
      sortOrder: item.editSortOrder
    };

    // 保存收款方式
    DataStorage.savePaymentMethod(saveData,
      (res) => {
        wx.hideLoading();
        wx.showToast({
          title: '保存成功',
          icon: 'success'
        });
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
  },

  /**
   * 新增收款方式
   */
  addPaymentMethod: function () {
    this.setData({
      showAddModal: true,
      newName: '',
      newSortOrder: 0
    });
  },

  /**
   * 关闭新增弹窗
   */
  closeAddModal: function () {
    this.setData({
      showAddModal: false,
      newName: '',
      newSortOrder: 0
    });
  },

  /**
   * 新增名称输入
   */
  onNewNameInput: function (e) {
    this.setData({
      newName: e.detail.value
    });
  },

  /**
   * 新增排序号输入
   */
  onNewSortOrderInput: function (e) {
    const value = parseInt(e.detail.value) || 0;
    this.setData({
      newSortOrder: value
    });
  },

  /**
   * 保存新增项
   */
  saveNewItem: function () {
    const { newName, newSortOrder } = this.data;

    // 验证输入
    if (!newName.trim()) {
      wx.showToast({
        title: '请输入名称',
        icon: 'none'
      });
      return;
    }

    wx.showLoading({ title: '保存中...' });

    // 准备保存的数据
    const saveData = {
      name: newName.trim(),
      sortOrder: newSortOrder
    };

    // 保存收款方式
    DataStorage.savePaymentMethod(saveData,
      (res) => {
        wx.hideLoading();
        wx.showToast({
          title: '保存成功',
          icon: 'success'
        });
        this.closeAddModal();
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
  }
});
