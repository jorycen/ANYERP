const userUtils = require('../profile/user-utils.js');
const api = require('../../utils/api.js');
const { normalizePnCode } = require('../../utils/pn.js');

function emptyForm() {
  return {
    name: '',
    price: '',
    pnCode: '',
    snCode: '',
    mtmCode: '',
    category: ''
  };
}

function normalizeGoods(item) {
  return {
    productId: item.productId || item.product_id || item._id || '',
    name: item.name || item.product_name || '',
    pnCode: item.pnCode || '',
    snCode: item.snCode || item.sn_code || item.sn || '',
    status: item.status,
    statusLabel: item.statusLabel || item.status_label || item.statusText || '',
    mtmCode: item.mtmCode || item.mtm || item.config || '',
    category: item.category || '',
    price: item.price || item.standard_price || 0
  };
}

Page({
  data: {
    searchKeyword: '',
    searchType: 'name',
    goodsList: [],
    isLoading: false,
    showEditModal: false,
    showAddModal: false,
    editingGoods: null,
    editForm: emptyForm(),
    addForm: emptyForm()
  },

  onLoad: function () {
    if (!userUtils.isDistributor()) {
      wx.showToast({
        title: '您没有权限访问此页面',
        icon: 'none',
        duration: 2000
      });
      setTimeout(() => wx.navigateBack(), 2000);
      return;
    }

    this.queryGoods();
  },

  onShow: function () {
    if (userUtils.isDistributor()) this.queryGoods();
  },

  onSearchTypeChange: function (e) {
    this.setData({
      searchType: e.currentTarget.dataset.type,
      searchKeyword: '',
      goodsList: []
    });
    this.queryGoods();
  },

  onSearchInput: function (e) {
    this.setData({ searchKeyword: e.detail.value });
  },

  onSearch: function () {
    this.queryGoods();
  },

  queryGoods: function () {
    const keyword = (this.data.searchKeyword || '').trim();
    const searchType = this.data.searchType;

    this.setData({ isLoading: true });
    wx.showLoading({ title: '查询中...' });

    const request = keyword
      ? (searchType === 'sn'
        ? api.inventory.getGoodsBySN(keyword).then(item => item ? [item] : [])
        : api.product.search(keyword, { page: 1, pageSize: 200 }))
      : api.product.list({ page: 1, pageSize: 200 });

    request
      .then(list => {
        const uniqueMap = new Map();
        (list || []).map(normalizeGoods).forEach(item => {
      const key = `${item.productId}_${item.pnCode}_${item.snCode}`;
          if (!uniqueMap.has(key)) uniqueMap.set(key, item);
        });

        const goodsList = Array.from(uniqueMap.values());
        this.setData({ goodsList, isLoading: false });
        wx.hideLoading();

        if (goodsList.length === 0 && keyword) {
          wx.showToast({ title: '未找到匹配的商品', icon: 'none' });
        }
      })
      .catch(err => {
        console.error('query goods failed:', err);
        this.setData({ goodsList: [], isLoading: false });
        wx.hideLoading();
        wx.showToast({ title: '查询失败', icon: 'none' });
      });
  },

  onEditGoods: function (e) {
    const goods = this.data.goodsList[e.currentTarget.dataset.index];
    this.setData({
      showEditModal: true,
      editingGoods: goods,
      editForm: {
        name: goods.name || '',
        price: goods.price ? String(goods.price) : '',
        pnCode: goods.pnCode || '',
        snCode: goods.snCode || '',
        mtmCode: goods.mtmCode || '',
        category: goods.category || ''
      }
    });
  },

  closeEditModal: function () {
    this.setData({
      showEditModal: false,
      editingGoods: null,
      editForm: emptyForm()
    });
  },

  onNameInput: function (e) {
    this.setData({ 'editForm.name': e.detail.value });
  },

  onPriceInput: function (e) {
    this.setData({ 'editForm.price': e.detail.value });
  },

  onCategoryInput: function (e) {
    this.setData({ 'editForm.category': e.detail.value });
  },

  onSaveGoods: function () {
    const { editingGoods, editForm } = this.data;
    if (!editingGoods) return;

    const name = (editForm.name || '').trim();
    const price = parseFloat(editForm.price);
    if (!name) {
      wx.showToast({ title: '商品名称不能为空', icon: 'none' });
      return;
    }
    if (isNaN(price) || price < 0) {
      wx.showToast({ title: '请输入有效的价格', icon: 'none' });
      return;
    }
    if (!editingGoods.productId) {
      wx.showToast({ title: '缺少商品ID', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '保存中...' });
    api.product.saveLegacyGoods({
      productId: editingGoods.productId,
      name,
      price,
      pnCode: editingGoods.pnCode || '',
      snCode: editingGoods.snCode || '',
      mtmCode: editingGoods.mtmCode || '',
      category: editForm.category || ''
    })
      .then(() => {
        wx.hideLoading();
        wx.showToast({ title: '保存成功', icon: 'success' });
        this.closeEditModal();
        this.queryGoods();
      })
      .catch(err => {
        console.error('save goods failed:', err);
        wx.hideLoading();
        wx.showToast({ title: '保存失败', icon: 'none' });
      });
  },

  openAddModal: function () {
    this.setData({ showAddModal: true, addForm: emptyForm() });
  },

  closeAddModal: function () {
    this.setData({ showAddModal: false, addForm: emptyForm() });
  },

  onAddNameInput: function (e) {
    this.setData({ 'addForm.name': e.detail.value });
  },

  onAddPriceInput: function (e) {
    this.setData({ 'addForm.price': e.detail.value });
  },

  onAddPnInput: function (e) {
    this.setData({ 'addForm.pnCode': normalizePnCode(e.detail.value) });
  },

  onAddSnInput: function (e) {
    this.setData({ 'addForm.snCode': e.detail.value });
  },

  onAddMtmInput: function (e) {
    this.setData({ 'addForm.mtmCode': e.detail.value });
  },

  onAddCategoryInput: function (e) {
    this.setData({ 'addForm.category': e.detail.value });
  },

  onAddGoods: function () {
    const addForm = this.data.addForm;
    const name = (addForm.name || '').trim();
    const price = parseFloat(addForm.price);

    if (!name) {
      wx.showToast({ title: '商品名称不能为空', icon: 'none' });
      return;
    }
    if (isNaN(price) || price < 0) {
      wx.showToast({ title: '请输入有效的价格', icon: 'none' });
      return;
    }
    if (!(addForm.pnCode || '').trim()) {
      wx.showToast({ title: 'PN码不能为空', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '添加中...' });
    api.product.saveLegacyGoods({
      name,
      price,
      pnCode: (addForm.pnCode || '').trim(),
      snCode: (addForm.snCode || '').trim(),
      mtmCode: (addForm.mtmCode || '').trim(),
      category: (addForm.category || '').trim()
    })
      .then(() => {
        wx.hideLoading();
        wx.showToast({ title: '添加成功', icon: 'success' });
        this.closeAddModal();
        this.queryGoods();
      })
      .catch(err => {
        console.error('add goods failed:', err);
        wx.hideLoading();
        wx.showToast({ title: '添加失败', icon: 'none' });
      });
  },

  goToBatchUpload: function () {
    wx.navigateTo({ url: '/pages/base-table-upload/base-table-upload' });
  },

  onBack: function () {
    wx.navigateBack();
  },

  noop: function () {}
});
