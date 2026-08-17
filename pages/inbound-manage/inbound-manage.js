const api = require('../../utils/api.js');
const userUtils = require('../profile/user-utils.js');

const STATUS_OPTIONS = [
  { label: '全部状态', value: '' },
  { label: '待入库', value: 'pending' },
  { label: '部分入库', value: 'partial' },
  { label: '已完成', value: 'completed' },
  { label: '已退库', value: 'returned' }
];

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).replace('T', ' ').slice(0, 16);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function statusInfo(status) {
  const map = {
    pending: { text: '待入库', className: 'pending' },
    partial: { text: '部分入库', className: 'partial' },
    partially_received: { text: '部分入库', className: 'partial' },
    completed: { text: '已完成', className: 'completed' },
    returned: { text: '已退库', className: 'returned' }
  };
  return map[status] || { text: status || '-', className: 'default' };
}

function isDistributorOrAbove(userInfo) {
  const values = [
    userInfo && userInfo.userRole,
    userInfo && userInfo.role,
    userInfo && userInfo.roleCode,
    ...(userInfo && Array.isArray(userInfo.roles) ? userInfo.roles : [])
  ].map(value => String(value || '').toLowerCase());
  return values.some(value => ['admin', 'boss', 'system_admin', 'super_admin', 'superadmin', 'root', 'distributor'].includes(value));
}

function enrichPurchaseInitiators(rows) {
  const pendingNos = Array.from(new Set((rows || [])
    .filter(row => !row.purchaseInitiatorName && row.sourceNo)
    .map(row => String(row.sourceNo).trim())
    .filter(Boolean)));
  if (!pendingNos.length) return Promise.resolve(rows);

  return Promise.all(pendingNos.map(requestNo => api.purchase.findByRequestNo(requestNo)
    .then(request => ({ requestNo, name: request && (
      request.purchase_initiator_name || request.purchaseInitiatorName || request.apply_user_name ||
      request.applyUserName || request.applicant_name || request.applicantName || request.apply_user ||
      request.applyUser || request.applicant || ''
    ) || '' }))
    .catch(() => ({ requestNo, name: '' }))))
    .then(matches => {
      const nameMap = matches.reduce((result, item) => {
        if (item.name) result[item.requestNo] = item.name;
        return result;
      }, {});
      return (rows || []).map(row => Object.assign({}, row, {
        purchaseInitiatorName: row.purchaseInitiatorName || nameMap[String(row.sourceNo || '').trim()] || ''
      }));
    });
}

Page({
  data: {
    statusOptions: STATUS_OPTIONS,
    statusIndex: 0,
    stores: [],
    storeIndex: 0,
    storeId: '',
    storeName: '',
    canSelectStore: false,
    inbounds: [],
    loading: false,
    loadingMore: false,
    page: 1,
    pageSize: 20,
    hasMore: true
  },

  onLoad() {
    const userInfo = userUtils.getUserInfo();
    if (!['distributor', 'store_admin', 'staff'].includes(userInfo.userRole)) {
      wx.showModal({
        title: '无操作权限',
        content: '仅门店账号和经销商账号可以进行入库操作。',
        showCancel: false,
        success: () => wx.navigateBack()
      });
      return;
    }

    this.setData({ canSelectStore: userInfo.userRole === 'distributor' });
    this.loadStores();
  },

  onShow() {
    if (this._loadedOnce) this.loadInboundList(true);
  },

  onPullDownRefresh() {
    this.loadInboundList(true).finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    this.loadMore();
  },

  loadStores() {
    const userInfo = userUtils.getUserInfo();
    const currentStore = wx.getStorageSync('tempStoreInfo') || {};
    const canSelectStore = isDistributorOrAbove(userInfo);
    this.setData({ canSelectStore, loading: true });

    api.store.getStores(userInfo.distributorId || '')
      .then(result => {
        const storeOptions = (result.data || []).map(store => ({
          storeId: store.storeId || store.store_id || store.id || '',
          name: store.name || store.storeName || ''
        }));
        const stores = canSelectStore
          ? [{ storeId: '', name: '全部门店', isAll: true }].concat(storeOptions)
          : storeOptions;

        if (!stores.length) throw new Error('当前账号未分配可操作门店');

        const preferredId = currentStore.storeId || userInfo.storeId || '';
        let selectedIndex = stores.findIndex(store => !store.isAll && String(store.storeId) === String(preferredId));
        if (selectedIndex < 0) selectedIndex = 0;
        const selected = stores[selectedIndex];

        this.setData({
          stores,
          storeIndex: selectedIndex,
          storeId: selected.storeId,
          storeName: selected.name,
          loading: false
        });
        return this.loadInboundList(true);
      })
      .catch(err => {
        console.error('加载入库门店失败:', err);
        this.setData({ loading: false });
        wx.showToast({ title: err.message || '门店加载失败', icon: 'none' });
      });
  },

  onStoreChange(e) {
    const index = Number(e.detail.value) || 0;
    const store = this.data.stores[index] || {};
    this.setData({
      storeIndex: index,
      storeId: store.storeId || '',
      storeName: store.name || ''
    });
    this.loadInboundList(true);
  },

  onStatusChange(e) {
    this.setData({ statusIndex: Number(e.detail.value) || 0 });
    this.loadInboundList(true);
  },

  loadInboundList(reset) {
    if ((!this.data.storeId && !this.data.canSelectStore) || this.data.loadingMore) return Promise.resolve();
    const page = reset ? 1 : this.data.page;
    const status = STATUS_OPTIONS[this.data.statusIndex]?.value || '';
    this.setData(reset ? { loading: true } : { loadingMore: true });

    return api.inventory.inboundList({
      storeId: this.data.storeId,
      status,
      page,
      pageSize: this.data.pageSize
    })
      .then(result => {
        const rows = (result.data || []).map(row => {
          const state = statusInfo(row.status);
          return Object.assign({}, row, {
            statusText: state.text,
            statusClass: state.className,
            amountText: Number(row.totalAmount || 0).toFixed(2),
            createTimeText: formatDate(row.createTime)
          });
        });
        return enrichPurchaseInitiators(rows).then(enrichedRows => {
          const total = Number(result.pagination && result.pagination.total || 0);
          const list = reset ? enrichedRows : this.data.inbounds.concat(enrichedRows);
          this._loadedOnce = true;
          this.setData({
            inbounds: list,
            page: page + 1,
            hasMore: total ? list.length < total : enrichedRows.length >= this.data.pageSize
          });
        });
      })
      .catch(err => {
        console.error('加载入库单失败:', err);
        wx.showToast({ title: err.message || '入库单加载失败', icon: 'none' });
      })
      .finally(() => {
        this.setData({ loading: false, loadingMore: false });
      });
  },

  loadMore() {
    if (!this.data.hasMore || this.data.loading || this.data.loadingMore) return;
    this.loadInboundList(false);
  },

  openInbound(e) {
    const inboundId = e.currentTarget.dataset.id;
    if (!inboundId) return;
    wx.navigateTo({
      url: '/pages/inbound-execute/inbound-execute?inboundId=' + encodeURIComponent(inboundId)
    });
  }
});
