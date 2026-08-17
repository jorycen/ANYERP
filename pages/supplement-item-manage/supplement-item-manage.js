const api = require('../../utils/api.js');

Page({
  data: {
    supplementItems: [],
    showModal: false,
    isEdit: false,
    editId: '',
    formData: {
      name: '',
      code: '',
      sortOrder: 0,
      isActive: true,
      amountType: 'increase'
    }
  },

  onLoad: function () {
    this.loadSupplementItems();
  },

  onShow: function () {
    this.loadSupplementItems();
  },

  loadSupplementItems: function () {
    api.dict.getSupplementItems()
      .then(items => {
        this.setData({ supplementItems: items || [] });
      })
      .catch(err => {
        console.error('load supplement items failed:', err);
        wx.showToast({
          title: '获取失败',
          icon: 'none'
        });
      });
  },

  showAddModal: function () {
    this.setData({
      showModal: true,
      isEdit: false,
      editId: '',
      formData: {
        name: '',
        code: '',
        sortOrder: 0,
        isActive: true,
        amountType: 'increase'
      }
    });
  },

  editItem: function (e) {
    const index = e.currentTarget.dataset.index;
    const item = this.data.supplementItems[index] || {};

    this.setData({
      showModal: true,
      isEdit: true,
      editId: item._id || item.id || item.itemId || '',
      formData: {
        name: item.name || '',
        code: item.code || '',
        sortOrder: item.sortOrder || 0,
        isActive: item.isActive !== false,
        amountType: item.amountType || 'increase'
      }
    });
  },

  hideModal: function () {
    this.setData({ showModal: false });
  },

  onNameInput: function (e) {
    this.setData({ 'formData.name': e.detail.value });
  },

  onCodeInput: function (e) {
    this.setData({ 'formData.code': e.detail.value });
  },

  onSortOrderInput: function (e) {
    this.setData({ 'formData.sortOrder': parseInt(e.detail.value, 10) || 0 });
  },

  onIsActiveChange: function (e) {
    this.setData({ 'formData.isActive': e.detail.value });
  },

  onAmountTypeChange: function (e) {
    this.setData({ 'formData.amountType': e.detail.value });
  },

  saveItem: function () {
    const { formData, isEdit, editId } = this.data;
    const name = (formData.name || '').trim();
    if (!name) {
      wx.showToast({ title: '请输入项目名称', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '保存中...' });

    api.dict.saveSupplementItem({
      id: isEdit ? editId : '',
      name,
      code: (formData.code || '').trim(),
      sortOrder: formData.sortOrder || 0,
      isActive: formData.isActive !== false,
      amountType: formData.amountType || 'increase'
    })
      .then(() => {
        wx.hideLoading();
        wx.showToast({ title: isEdit ? '更新成功' : '添加成功', icon: 'success' });
        this.hideModal();
        this.loadSupplementItems();
      })
      .catch(err => {
        wx.hideLoading();
        console.error('save supplement item failed:', err);
        wx.showToast({ title: '保存失败', icon: 'none' });
      });
  },

  toggleItemStatus: function (e) {
    const id = e.currentTarget.dataset.id;
    const index = e.currentTarget.dataset.index;
    const isActive = e.detail.value;
    const item = this.data.supplementItems[index] || {};

    wx.showLoading({ title: '更新中...' });

    api.dict.saveSupplementItem(Object.assign({}, item, { id, isActive }))
      .then(() => {
        wx.hideLoading();
        const items = this.data.supplementItems;
        items[index].isActive = isActive;
        this.setData({ supplementItems: items });
        wx.showToast({ title: '更新成功', icon: 'success' });
      })
      .catch(err => {
        wx.hideLoading();
        console.error('toggle supplement item failed:', err);
        wx.showToast({ title: '更新失败', icon: 'none' });
      });
  },

  deleteItem: function (e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '确认删除',
      content: '确定要删除这个补录项目吗？',
      confirmText: '删除',
      cancelText: '取消',
      success: (res) => {
        if (!res.confirm) return;

        wx.showLoading({ title: '删除中...' });
        api.dict.deleteSupplementItem(id)
          .then(() => {
            wx.hideLoading();
            wx.showToast({ title: '删除成功', icon: 'success' });
            this.loadSupplementItems();
          })
          .catch(err => {
            wx.hideLoading();
            console.error('delete supplement item failed:', err);
            wx.showToast({ title: '删除失败', icon: 'none' });
          });
      }
    });
  }
});
