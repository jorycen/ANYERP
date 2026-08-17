// pages/customer-source-manage/customer-source-manage.js
const DataStorage = require('../../utils/storage.js');

Page({
  data: {
    level1Sources: [],
    level2SourcesMap: {},
    expandedLevels: {},
    showAddModal: false,
    addLevel: 1,
    newName: '',
    newSortOrder: 0,
    newParentId: '',
    newParentName: '',
    showEditModal: false,
    editId: '',
    editName: '',
    editSortOrder: 0,
    editLevel: 1,
    editParentId: '',
    editParentName: ''
  },

  onLoad: function (options) {
    console.log('客户来源管理页面加载');
    this.loadData();
  },

  onShow: function () {
    console.log('客户来源管理页面显示');
    this.loadData();
  },

  loadData: function () {
    wx.showLoading({ title: '加载中...' });
    const that = this;
    const previousExpandedLevels = this.data.expandedLevels || {};
    DataStorage.getCustomerSources((sources) => {
      const level1Sources = sources.filter(s => s.level === 1 || !s.level);
      const level2Sources = sources.filter(s => s.level === 2);

      const level2SourcesMap = {};

      level1Sources.forEach(l1 => {
        const l1Id = String(l1._id || '').trim();
        const l1Name = String(l1.name || '').trim();

        const matchedLevel2 = level2Sources.filter(l2 => {
          const l2ParentId = String(l2.parentId || '').trim();
          const l2ParentName = String(l2.parentName || '').trim();

          return l2ParentId === l1Id || 
                 l2ParentName === l1Name ||
                 l2ParentId.replace(/\s/g, '') === l1Id.replace(/\s/g, '') ||
                 l2ParentName.replace(/\s/g, '') === l1Name.replace(/\s/g, '');
        });

        matchedLevel2.sort((a, b) => a.sortOrder - b.sortOrder);
        level2SourcesMap[l1._id] = matchedLevel2;
      });

      level1Sources.sort((a, b) => a.sortOrder - b.sortOrder);

      const expandedLevels = {};
      level1Sources.forEach(s => {
        expandedLevels[s._id] = previousExpandedLevels[s._id] !== undefined ? previousExpandedLevels[s._id] : true;
      });

      that.setData({
        level1Sources: level1Sources,
        level2SourcesMap: level2SourcesMap,
        expandedLevels: expandedLevels
      });
      wx.hideLoading();
    }, (err) => {
      that.setData({
        level1Sources: [],
        level2SourcesMap: {}
      });
      wx.hideLoading();
    });
  },

  toggleExpand: function (e) {
    const id = e.currentTarget.dataset.id;
    const expandedLevels = this.data.expandedLevels;
    expandedLevels[id] = !expandedLevels[id];
    this.setData({ expandedLevels: expandedLevels });
  },

  addLevel1: function () {
    this.setData({
      showAddModal: true,
      addLevel: 1,
      newName: '',
      newSortOrder: 0,
      newParentId: '',
      newParentName: ''
    });
  },

  addLevel2: function (e) {
    console.log('addLevel2 called', e.currentTarget.dataset);
    const parentId = e.currentTarget.dataset.parentid;
    const parentName = e.currentTarget.dataset.parentname;
    console.log('parentId:', parentId, 'parentName:', parentName);
    this.setData({
      showAddModal: true,
      addLevel: 2,
      newName: '',
      newSortOrder: 0,
      newParentId: parentId,
      newParentName: parentName
    });
    console.log('showAddModal set to true, current data:', this.data.showAddModal, this.data.addLevel);
  },

  closeAddModal: function () {
    this.setData({
      showAddModal: false,
      newName: '',
      newSortOrder: 0,
      newParentId: '',
      newParentName: ''
    });
  },

  onNewNameInput: function (e) {
    this.setData({ newName: e.detail.value });
  },

  onNewSortInput: function (e) {
    const value = parseInt(e.detail.value) || 0;
    this.setData({ newSortOrder: value });
  },

  saveNewItem: function () {
    const { newName, newSortOrder, addLevel, newParentId, newParentName } = this.data;

    if (!newName.trim()) {
      wx.showToast({ title: '请输入名称', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '保存中...' });

    const saveData = {
      name: newName.trim(),
      level: addLevel,
      parentId: addLevel === 2 ? newParentId : null,
      parentName: addLevel === 2 ? newParentName : null,
      sortOrder: newSortOrder
    };

    DataStorage.saveCustomerSource(saveData, (res) => {
      wx.hideLoading();
      wx.showToast({ title: '保存成功', icon: 'success' });
      this.closeAddModal();
      this.loadData();
    }, (err) => {
      wx.hideLoading();
      wx.showToast({ title: '保存失败: ' + err, icon: 'none' });
    });
  },

  startEditLevel1: function (e) {
    const index = e.currentTarget.dataset.index;
    const item = this.data.level1Sources[index];
    this.setData({
      showEditModal: true,
      editId: item._id,
      editName: item.name,
      editSortOrder: item.sortOrder || 0,
      editLevel: 1,
      editParentId: '',
      editParentName: ''
    });
  },

  startEditLevel2: function (e) {
    const parentId = e.currentTarget.dataset.parentid;
    const index = e.currentTarget.dataset.index;
    const item = this.data.level2SourcesMap[parentId][index];
    this.setData({
      showEditModal: true,
      editId: item._id,
      editName: item.name,
      editSortOrder: item.sortOrder || 0,
      editLevel: 2,
      editParentId: item.parentId,
      editParentName: item.parentName || ''
    });
  },

  closeEditModal: function () {
    this.setData({
      showEditModal: false,
      editId: '',
      editName: '',
      editSortOrder: 0
    });
  },

  onEditNameInput: function (e) {
    this.setData({ editName: e.detail.value });
  },

  onEditSortInput: function (e) {
    const value = parseInt(e.detail.value) || 0;
    this.setData({ editSortOrder: value });
  },

  saveEditItem: function () {
    const { editId, editName, editSortOrder } = this.data;

    if (!editName.trim()) {
      wx.showToast({ title: '请输入名称', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '保存中...' });

    const saveData = {
      id: editId,
      name: editName.trim(),
      sortOrder: editSortOrder
    };

    DataStorage.saveCustomerSource(saveData, (res) => {
      wx.hideLoading();
      wx.showToast({ title: '保存成功', icon: 'success' });
      this.closeEditModal();
      this.loadData();
    }, (err) => {
      wx.hideLoading();
      wx.showToast({ title: '保存失败: ' + err, icon: 'none' });
    });
  },

  deleteLevel1: function (e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    const hasChildren = this.data.level2SourcesMap[id] && this.data.level2SourcesMap[id].length > 0;

    wx.showModal({
      title: '确认删除',
      content: hasChildren
        ? `确定要删除"${name}"及其下的所有二级来源吗？`
        : `确定要删除"${name}"吗？`,
      success: (res) => {
        if (res.confirm) {
          DataStorage.deleteCustomerSource(id, (res) => {
            wx.showToast({ title: '删除成功', icon: 'success' });
            this.loadData();
          }, (err) => {
            wx.showToast({ title: '删除失败: ' + err, icon: 'none' });
          });
        }
      }
    });
  },

  deleteLevel2: function (e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;

    wx.showModal({
      title: '确认删除',
      content: `确定要删除"${name}"吗？`,
      success: (res) => {
        if (res.confirm) {
          DataStorage.deleteCustomerSource(id, (res) => {
            wx.showToast({ title: '删除成功', icon: 'success' });
            this.loadData();
          }, (err) => {
            wx.showToast({ title: '删除失败: ' + err, icon: 'none' });
          });
        }
      }
    });
  }
});