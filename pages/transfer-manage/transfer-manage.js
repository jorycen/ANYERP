const api = require('../../utils/api.js');
const userUtils = require('../profile/user-utils.js');
const imageUpload = require('../../utils/image-upload.js');
const { normalizePnCode } = require('../../utils/pn.js');

function valueOf(source, keys, fallback = '') {
  for (const key of keys) {
    if (source && source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
  }
  return fallback;
}

function isSnProduct(item) {
  return Boolean(item) && (
    item.needSn === true ||
    item.need_sn === true ||
    Number(item.needSn) === 1 ||
    Number(item.need_sn) === 1 ||
    Boolean(item.inventoryId || item.inventory_id || item.snCode || item.sn_code)
  );
}

function storeIdOf(store) {
  return String(valueOf(store, ['storeId', 'store_id', 'id', '_id'], '') || '');
}

function distributorIdOf(source) {
  return String(valueOf(source, ['distributorId', 'distributor_id'], '') || '');
}

function regionKeysOf(source) {
  return [
    valueOf(source, ['regionId', 'region_id'], ''),
    valueOf(source, ['regionCode', 'region_code'], ''),
    valueOf(source, ['regionName', 'region_name'], '')
  ].filter(value => value !== undefined && value !== null && value !== '').map(String);
}

function isDistributorRole(userInfo) {
  return userUtils.isDistributorAccount(userInfo);
}

function currentStoreIdOf(userInfo) {
  if (!userUtils.isStoreScoped(userInfo)) return '';
  const storeInfo = wx.getStorageSync('storeInfo') || {};
  const tempStoreInfo = wx.getStorageSync('tempStoreInfo') || {};
  return String(valueOf(userInfo, ['storeId', 'store_id'], '') ||
    valueOf(storeInfo, ['storeId', 'store_id'], '') ||
    valueOf(tempStoreInfo, ['storeId', 'store_id'], '') || '');
}

function currentUserIdOf(userInfo) {
  return String(valueOf(userInfo, ['staffId', 'staff_id', 'userId', 'user_id', '_id', 'id'], '') || '');
}

function currentUserNameOf(userInfo) {
  return String(valueOf(userInfo, ['userName', 'user_name', 'name', 'nickname'], '') || '').trim();
}

function getStoreStock(item, storeId) {
  const targetStoreId = String(storeId || '');
  if (!targetStoreId) return 0;
  const rows = item && (item.store_stock_info || item.storeStockInfo || item.other_store_stock_info || item.otherStoreStockInfo);
  if (!Array.isArray(rows)) return 0;
  return rows
    .filter(row => String(valueOf(row, ['storeId', 'store_id'], '')) === targetStoreId)
    .reduce((sum, row) => sum + Number(valueOf(row, ['normal_qty', 'normalQty', 'stock_qty', 'stock', 'quantity'], 0) || 0), 0);
}

function normalizeProduct(item, sourceStoreId = '') {
  const sourceStock = getStoreStock(item, sourceStoreId);
  return {
    productId: valueOf(item, ['productId', 'product_id', '_id', 'id']),
    productCode: valueOf(item, ['productCode', 'product_code', 'code']),
    productName: valueOf(item, ['productName', 'product_name', 'name', 'NAME'], '未命名商品'),
    pnCode: normalizePnCode(item.pnCode || item.pn_code || item.pn || ''),
    pnOptions: item.pnOptions || item.pn_options || [],
    inventoryId: valueOf(item, ['inventoryId', 'inventory_id', 'snId', 'sn_id', 'inventorySnId', 'inventory_sn_id']),
    snCode: valueOf(item, ['snCode', 'sn_code', 'SN']),
    needSn: isSnProduct(item),
    stock: sourceStock || Number(valueOf(item, ['currentStoreStockQty', 'current_store_stock_qty', 'normal_qty', 'stock', 'stock_qty'], 0)) || 0
  };
}

function statusText(status) {
  const map = {
    pending: '待调出门店确认',
    requested: '待调出门店确认',
    applied: '待调出门店确认',
    shipping: '待调出门店确认',
    out_confirmed: '运输中，待收货',
    received: '已收货',
    completed: '已完成',
    cancelled: '已取消',
    canceled: '已取消',
    revoked: '已撤销',
    rejected: '已拒绝',
    returned: '已退回'
  };
  return map[status] || status || '-';
}

function isPendingOut(status) {
  return ['pending', 'requested', 'applied', 'shipping'].includes(status);
}

function isTransferRequestOpen(status) {
  return isPendingOut(status);
}

function isPendingIn(status) {
  return ['out_confirmed', 'shipping_out', 'in_transit'].includes(status);
}

function chooseImageFiles(success, fail) {
  const options = { count: 9, sizeType: ['compressed'], sourceType: ['camera', 'album'] };
  if (wx.chooseMedia) {
    wx.chooseMedia(Object.assign({}, options, {
      mediaType: ['image'],
      success: res => success((res.tempFiles || []).map(item => item.tempFilePath).filter(Boolean)),
      fail
    }));
    return;
  }
  wx.chooseImage(Object.assign({}, options, { success: res => success(res.tempFilePaths || []), fail }));
}

function resolvePhotoUrls(photos) {
  return imageUpload.resolveImageUrls(photos);
}

Page({
  data: {
    userInfo: {},
    stores: [],
    sourceStores: [],
    fromStoreIndex: -1,
    toStoreIndex: -1,
    regionWarning: '',
    transfers: [],
    productList: [],
    transferItems: [],
    selectedProduct: null,
    showProductModal: false,
    fromStoreName: '',
    toStoreName: '',
    freightPlatforms: [],
    isLoading: false,
    isSearching: false,
    submitting: false,
    activeTransferId: '',
    shippingTransfer: null,
    receivingTransfer: null,
    shipping: {
      items: [],
      pnOptions: [],
      snOptions: [],
      allSnOptions: [],
      pnIndex: -1,
      snIndex: -1,
      selectedSnIds: [],
      selectedSnOptions: [],
      requestedQuantity: 1,
      requestedSnQuantity: 1,
      remainingAction: 'reject',
      needSn: false,
      quantity: 1,
      pnCode: '',
      snCode: '',
      photos: [],
      photoUrls: []
    },
    receiving: {
      photos: [],
      photoUrls: [],
      locations: [],
      items: []
    },
    form: {
      fromStoreId: '',
      toStoreId: '',
      freightPlatformId: '',
      freightPlatformName: '',
      freightAmount: '',
      keyword: '',
      quantity: 1,
      items: []
    }
  },

  onLoad() {
    const userInfo = userUtils.getUserInfo();
    this.setData({ userInfo });
    api.freight.platforms().then(platforms => this.setData({ freightPlatforms: Array.isArray(platforms) ? platforms : [] })).catch(() => {});
    this.loadStores(userInfo).then(() => this.loadTransfers());
  },

  onShow() {
    if (this.data.stores.length) this.loadTransfers();
  },

  onPullDownRefresh() {
    this.loadTransfers().finally(() => wx.stopPullDownRefresh());
  },

  loadStores(userInfo = this.data.userInfo) {
    const requestedDistributorId = distributorIdOf(userInfo);
    const requestedRegionId = valueOf(userInfo, ['regionId', 'region_id'], '');
    const load = api.store.getTransferStores
      ? api.store.getTransferStores(requestedDistributorId, requestedRegionId)
      : api.store.getStores(requestedDistributorId);
    return load
      .then(res => {
        const allStores = (res && res.data) || [];
        const currentStoreId = currentStoreIdOf(userInfo);
        const currentStore = allStores.find(store => storeIdOf(store) === currentStoreId) || {};
        const effectiveUserInfo = Object.assign({}, userInfo, {
          distributorId: requestedDistributorId || distributorIdOf(currentStore),
          regionId: requestedRegionId || valueOf(currentStore, ['regionId', 'region_id'], ''),
          regionCode: valueOf(userInfo, ['regionCode', 'region_code'], '') || valueOf(currentStore, ['regionCode', 'region_code'], ''),
          regionName: valueOf(userInfo, ['regionName', 'region_name'], '') || valueOf(currentStore, ['regionName', 'region_name'], '')
        });
        const availableStores = this.filterSameRegionStores(allStores, effectiveUserInfo);
        // 调出门店与调入门店使用同一批同区域门店，普通账号也可以选择其他门店作为调出门店。
        const sourceStores = availableStores;
        const currentIndex = sourceStores.findIndex(store => storeIdOf(store) === currentStoreId);
        const targetIndex = availableStores.findIndex(store => storeIdOf(store) !== currentStoreId);
        const fromStoreId = this.data.form.fromStoreId && sourceStores.some(store => storeIdOf(store) === String(this.data.form.fromStoreId))
          ? this.data.form.fromStoreId
          : (currentIndex >= 0 ? storeIdOf(sourceStores[currentIndex]) : '');
        const toStoreId = this.data.form.toStoreId && availableStores.some(store => storeIdOf(store) === String(this.data.form.toStoreId))
          ? this.data.form.toStoreId
          : (targetIndex >= 0 ? storeIdOf(availableStores[targetIndex]) : '');
        this.setData({
          userInfo: effectiveUserInfo,
          stores: availableStores,
          sourceStores,
          fromStoreIndex: sourceStores.findIndex(store => storeIdOf(store) === String(fromStoreId)),
          toStoreIndex: availableStores.findIndex(store => String(store.storeId) === String(toStoreId)),
          fromStoreName: this.resolveStoreName(availableStores, fromStoreId),
          toStoreName: this.resolveStoreName(availableStores, toStoreId),
          'form.fromStoreId': fromStoreId,
          'form.toStoreId': toStoreId
        });
      })
      .catch(err => {
        console.error('load stores failed:', err);
        wx.showToast({ title: '门店加载失败', icon: 'none' });
      });
  },

  filterSameRegionStores(stores, userInfo) {
    if (!userUtils.isStoreScoped(userInfo)) {
      this.setData({ regionWarning: '只能在同一区域门店之间调拨，提交时由系统校验' });
      return stores || [];
    }
    const currentStoreId = currentStoreIdOf(userInfo);
    const currentStore = stores.find(store => storeIdOf(store) === currentStoreId) || {};
    const currentDistributorId = distributorIdOf(userInfo) || distributorIdOf(currentStore);
    const currentRegionKeys = regionKeysOf(currentStore).length ? regionKeysOf(currentStore) : regionKeysOf(userInfo);
    const filtered = stores.filter(store => {
      const storeDistributorId = distributorIdOf(store);
      const storeRegionKeys = regionKeysOf(store);
      const sameDistributor = currentDistributorId && storeDistributorId
        ? storeDistributorId === currentDistributorId
        : !currentDistributorId && !storeDistributorId;
      const sameRegion = currentRegionKeys.length > 0 && storeRegionKeys.length > 0 &&
        storeRegionKeys.some(key => currentRegionKeys.includes(key));
      return sameDistributor && sameRegion;
    });
    const hasRegion = Boolean(
      currentRegionKeys.length
    );
    if (!hasRegion) {
      this.setData({ regionWarning: '暂未获取到区域信息，系统仍会在提交时校验同区域门店' });
    } else if (!filtered.length) {
      this.setData({ regionWarning: '当前区域暂无可调拨门店' });
    } else {
      this.setData({ regionWarning: '' });
    }
    return filtered;
  },

  loadTransfers() {
    this.setData({ isLoading: true });
    const user = this.data.userInfo || userUtils.getUserInfo();
    return api.inventory.transferList({
      page: 1,
      pageSize: 100,
      scope: 'visible',
      distributorId: distributorIdOf(user)
    })
      .then(res => {
        const transfers = (res.data || []).map(item => this.decorateTransfer(item));
        return Promise.all(transfers.map(item => this.resolveTransferPhotos(item)))
          .then(resolvedTransfers => this.setData({ transfers: resolvedTransfers, isLoading: false }));
      })
      .catch(err => {
        console.error('load transfers failed:', err);
        this.setData({ transfers: [], isLoading: false });
        wx.showToast({ title: '调拨单加载失败', icon: 'none' });
      });
  },

  decorateTransfer(item) {
    const status = item.status || 'pending';
    const fromStoreId = item.fromStoreId || item.from_store_id || '';
    const toStoreId = item.toStoreId || item.to_store_id || '';
    const currentStoreId = currentStoreIdOf(this.data.userInfo);
    const canManageAll = isDistributorRole(this.data.userInfo);
    const applicantId = String(valueOf(item, ['applyUserId', 'apply_user_id', 'applyUser', 'apply_user'], '') || '');
    const applicantName = String(valueOf(item, ['applyUserName', 'apply_user_name'], '') || '').trim();
    const currentUserId = currentUserIdOf(this.data.userInfo);
    const currentUserName = currentUserNameOf(this.data.userInfo);
    const isApplicant = Boolean(applicantId && currentUserId && applicantId === currentUserId) ||
      Boolean(applicantName && currentUserName && applicantName === currentUserName);
    return Object.assign({}, item, {
      status,
      statusText: statusText(status),
      fromStoreId,
      toStoreId,
      fromStoreName: item.fromStoreName || this.resolveStoreName(this.data.stores, fromStoreId),
      toStoreName: item.toStoreName || this.resolveStoreName(this.data.stores, toStoreId),
      canConfirmOut: isPendingOut(status) && (canManageAll || String(currentStoreId) === String(fromStoreId)),
      canConfirmIn: isPendingIn(status) && (canManageAll || String(currentStoreId) === String(toStoreId)),
      canRevoke: isTransferRequestOpen(status) && isApplicant,
      canReject: isTransferRequestOpen(status) && (canManageAll || String(currentStoreId) === String(fromStoreId)),
      canReturn: isPendingIn(status) && (canManageAll || String(currentStoreId) === String(toStoreId)),
      items: item.items || [],
      shippingPhotos: Array.isArray(item.shippingPhotos) ? item.shippingPhotos : [],
      receivingPhotos: Array.isArray(item.receivingPhotos) ? item.receivingPhotos : [],
      shippingPhotoUrls: [],
      receivingPhotoUrls: []
    });
  },

  resolveTransferPhotos(item) {
    return Promise.all([
      resolvePhotoUrls(item.shippingPhotos),
      resolvePhotoUrls(item.receivingPhotos)
    ]).then(([shippingPhotoUrls, receivingPhotoUrls]) => {
      return Object.assign({}, item, {
        shippingPhotoUrls,
        receivingPhotoUrls
      });
    });
  },

  onFromStoreChange(e) {
    const index = Number(e.detail.value);
    const store = this.data.sourceStores[index] || {};
    this.setData({
      fromStoreIndex: index,
      fromStoreName: store.name || '',
      'form.fromStoreId': storeIdOf(store),
      productList: [],
      transferItems: [],
      selectedProduct: null,
      'form.keyword': '',
      'form.quantity': 1,
      'form.items': []
    });
  },

  onToStoreChange(e) {
    const index = Number(e.detail.value);
    const store = this.data.stores[index] || {};
    this.setData({
      toStoreIndex: index,
      toStoreName: store.name || '',
      'form.toStoreId': storeIdOf(store)
    });
  },

  onFreightPlatformChange(e) {
    const index = Number(e.detail.value);
    const platform = this.data.freightPlatforms[index];
    this.setData({
      'form.freightPlatformId': platform ? platform.platform_id : '',
      'form.freightPlatformName': platform ? platform.platform_name : ''
    });
  },

  onFreightAmountInput(e) {
    this.setData({ 'form.freightAmount': e.detail.value });
  },

  onKeywordInput(e) {
    this.setData({ 'form.keyword': e.detail.value });
  },

  openProductModal() {
    if (!this.data.form.fromStoreId) {
      wx.showToast({ title: '请先选择调出门店', icon: 'none' });
      return;
    }
    this.setData({ showProductModal: true });
  },

  closeProductModal() {
    this.setData({ showProductModal: false, productList: [] });
  },

  noop() {},

  onQuantityInput(e) {
    this.setData({ 'form.quantity': e.detail.value });
  },

  searchProduct() {
    const keyword = String(this.data.form.keyword || '').trim();
    if (!this.data.form.fromStoreId) {
      wx.showToast({ title: '请先选择调出门店', icon: 'none' });
      return;
    }
    if (!keyword) {
      wx.showToast({ title: '请输入商品名称、PN或SN', icon: 'none' });
      return;
    }
    this.setData({ isSearching: true, productList: [] });
    const catalogSearch = api.product.search(keyword, { page: 1, pageSize: 30 }).catch(() => []);
    const inventorySearch = api.inventory.list({ storeId: this.data.form.fromStoreId, keyword, scope: 'transfer', page: 1, pageSize: 30 });
    const snSearch = api.inventory.getGoodsBySN(keyword, this.data.form.fromStoreId, '', { scope: 'transfer' }).catch(() => null);
    Promise.all([catalogSearch, inventorySearch, snSearch])
      .then(([catalogRows, inventoryResult, snItem]) => {
        const rows = (catalogRows || []).concat((inventoryResult && inventoryResult.data) || []);
        const products = rows.concat(snItem ? [snItem] : []).map(item => normalizeProduct(item, this.data.form.fromStoreId));
        const map = new Map();
        products.forEach(item => {
          const key = [item.productId, item.pnCode, item.snCode].join('|');
          if (item.productId && !map.has(key)) map.set(key, item);
        });
        const productList = Array.from(map.values());
        this.setData({ productList, isSearching: false });
        if (!productList.length) wx.showToast({ title: '未找到商品信息', icon: 'none' });
      })
      .catch(err => {
        console.error('search product failed:', err);
        this.setData({ isSearching: false });
        wx.showToast({ title: '商品查询失败', icon: 'none' });
      });
  },

  selectProduct(e) {
    const item = this.data.productList[Number(e.currentTarget.dataset.index)];
    if (!item) return;
    const needSn = isSnProduct(item);
    const items = this.data.form.items || [];
    const duplicate = items.some(selected => [selected.productId, selected.pnCode, selected.snCode].join('|') === [item.productId, item.pnCode, item.snCode].join('|'));
    if (duplicate) {
      wx.showToast({ title: '该商品已添加，不能重复选择', icon: 'none' });
      return;
    }
    const transferItem = {
      productId: item.productId,
      productCode: item.productCode || '',
      productName: item.productName,
      pnCode: item.pnCode || '',
      snCode: item.snCode || '',
      quantity: Math.max(1, parseInt(this.data.form.quantity, 10) || 1),
      needSn: needSn ? 1 : 0,
      requested: true
    };
    this.setData({
      selectedProduct: item,
      'form.items': items.concat([transferItem]),
      transferItems: items.concat([transferItem]),
      productList: [],
      showProductModal: false,
      'form.quantity': Math.max(1, parseInt(this.data.form.quantity, 10) || 1)
    });
  },

  onTransferItemQuantityInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = (this.data.form.items || [])[index];
    const enteredValue = e.detail.value;
    const value = enteredValue === '' ? '' : Math.max(1, parseInt(enteredValue, 10) || 1);
    this.setData({
      [`form.items[${index}].quantity`]: value,
      [`transferItems[${index}].quantity`]: value
    });
  },

  removeTransferItem(e) {
    const index = Number(e.currentTarget.dataset.index);
    const items = (this.data.form.items || []).slice();
    items.splice(index, 1);
    this.setData({
      'form.items': items,
      transferItems: items,
      selectedProduct: items.length ? items[items.length - 1] : null
    });
  },

  createTransfer() {
    if (this._transferSubmissionLocked || this.data.submitting) return;
    const form = this.data.form;
    const items = form.items || [];
    const fromStore = this.data.stores.find(store => String(store.storeId) === String(form.fromStoreId));
    const toStore = this.data.stores.find(store => String(store.storeId) === String(form.toStoreId));
    if (!form.fromStoreId || !form.toStoreId) {
      wx.showToast({ title: '请选择调出和接收门店', icon: 'none' });
      return;
    }
    if (form.fromStoreId === form.toStoreId) {
      wx.showToast({ title: '调出和接收门店不能相同', icon: 'none' });
      return;
    }
    if (!fromStore || !toStore) {
      wx.showToast({ title: '请选择有效的同区域门店', icon: 'none' });
      return;
    }
    const fromDistributorId = distributorIdOf(fromStore);
    const toDistributorId = distributorIdOf(toStore);
    if (fromDistributorId && toDistributorId && fromDistributorId !== toDistributorId) {
      wx.showToast({ title: '调出和接收门店必须属于同一经销商', icon: 'none' });
      return;
    }
    const fromRegionKeys = [fromStore.regionId, fromStore.regionCode, fromStore.regionName].filter(Boolean).map(String);
    const toRegionKeys = [toStore.regionId, toStore.regionCode, toStore.regionName].filter(Boolean).map(String);
    const fromRegion = fromRegionKeys[0] || '';
    const toRegion = toRegionKeys[0] || '';
    if (fromRegionKeys.length && toRegionKeys.length && !toRegionKeys.some(key => fromRegionKeys.includes(key))) {
      wx.showToast({ title: '只能调拨同一区域门店', icon: 'none' });
      return;
    }
    if (!items.length) {
      wx.showToast({ title: '请选择申请商品', icon: 'none' });
      return;
    }
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const quantity = parseInt(item.quantity, 10) || 0;
      if (quantity <= 0) {
        wx.showToast({ title: `请输入第${index + 1}项调拨数量`, icon: 'none' });
        return;
      }
    }
    this._transferSubmissionLocked = true;
    this.setData({ submitting: true });
    wx.showLoading({ title: '提交中' });
    // 以本次调拨所选门店的归属经销商为准，避免缓存中的用户资料过期导致权限校验失败。
    const distributorId = fromDistributorId || toDistributorId || distributorIdOf(this.data.userInfo);
    const regionId = fromRegion || toRegion;
    api.inventory.transfer({
      fromStoreId: form.fromStoreId,
      from_store_id: form.fromStoreId,
      toStoreId: form.toStoreId,
      to_store_id: form.toStoreId,
      deliveryPlatformId: form.freightPlatformId || '',
      deliveryPlatformName: form.freightPlatformName || '',
      freightAmount: Number(form.freightAmount || 0),
      distributorId,
      distributor_id: distributorId,
      regionId,
      region_id: regionId,
      items,
      requestedItems: items
    })
      .then(() => {
        wx.hideLoading();
        wx.showToast({ title: '调拨申请已提交', icon: 'success' });
        this.setData({
          selectedProduct: null,
          transferItems: [],
          productList: [],
          'form.keyword': '',
          'form.quantity': 1,
          'form.freightPlatformId': '',
          'form.freightPlatformName': '',
          'form.freightAmount': '',
          'form.items': []
        });
        this.loadTransfers();
      })
      .catch(err => {
        console.error('create transfer failed:', err);
        wx.hideLoading();
        this._transferSubmissionLocked = false;
        this.setData({ submitting: false });
        wx.showToast({ title: err.message || '提交失败', icon: 'none' });
      })
      .finally(() => {
        this._transferSubmissionLocked = false;
        this.setData({ submitting: false });
      });
  },

  startShipping(e) {
    const transfer = this.data.transfers.find(item => item.transferId === e.currentTarget.dataset.id);
    if (!transfer) return;
    const detailRequest = api.inventory.transferDetail
      ? api.inventory.transferDetail(transfer.transferId).then(result => {
        const raw = result && (result.transfer || result.Transfer || result.data || result);
        const normalized = api._helpers && api._helpers.normalizeTransfer && raw
          ? api._helpers.normalizeTransfer(raw)
          : null;
        return normalized && normalized.transferId ? this.decorateTransfer(normalized) : transfer;
      })
      : Promise.resolve(transfer);
    detailRequest.catch(() => transfer).then(freshTransfer => this.openShippingPanel(freshTransfer));
  },

  openShippingPanel(transfer) {
    const requestedItems = transfer.items || [];
    const requestedItem = requestedItems.find(item => Number(item.quantity || 0) > 0) || requestedItems[0] || {};
    const requestedQuantity = Number(requestedItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0) || transfer.remainingQuantity || requestedItem.quantity || 1);
    const requestedSnQuantity = requestedItems
      .filter(item => isSnProduct(item))
      .reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const shippingItems = requestedItems.map((item, index) => ({
      itemId: item.itemId || item.item_id || item.transferItemId || item.transfer_item_id || item.lineId || item.line_id || item._id || item.id || '',
      productId: item.productId || item.product_id || '',
      productCode: item.productCode || item.product_code || '',
      productName: item.productName || item.product_name || '商品',
      requestedQuantity: Math.max(1, Number(item.quantity || 1)),
      quantity: Math.max(1, Number(item.quantity || 1)),
      needSn: isSnProduct(item),
      pnCode: String(item.pnCode || '').trim(),
      pnIndex: -1,
      pnOptions: [],
      snOptions: [],
      selectedSnIds: [],
      selectedSnOptions: [],
      snCode: ''
    }));
    this.setData({
      activeTransferId: transfer.transferId,
      shippingTransfer: transfer,
      receivingTransfer: null,
      shipping: { items: shippingItems, pnOptions: [], snOptions: [], allSnOptions: [], pnIndex: -1, snIndex: -1, selectedSnIds: [], selectedSnOptions: [], requestedQuantity, requestedSnQuantity: requestedSnQuantity || (isSnProduct(requestedItem) ? requestedQuantity : 0), remainingAction: 'reject', needSn: requestedSnQuantity > 0 || isSnProduct(requestedItem), quantity: requestedQuantity, pnCode: '', snCode: '', photos: [], photoUrls: [] }
    });
    this.loadShippingOptions(transfer);
  },

  loadShippingOptions(transfer) {
    const requestedItems = (transfer?.items || []).map(item => Object.assign({}, item, {
      productId: item && (item.productId || item.product_id || '')
    })).filter(item => item && item.productId);
    if (!requestedItems.length) return;
    const productIds = [...new Set(requestedItems.map(item => String(item.productId)))];
    const snProductIds = [...new Set(requestedItems.filter(item => isSnProduct(item)).map(item => String(item.productId)))];
    const requestedSnQuantityByProduct = new Map();
    requestedItems.filter(item => isSnProduct(item)).forEach(item => {
      const productId = String(item.productId);
      const quantity = Math.max(1, Number(item.quantity || 1));
      requestedSnQuantityByProduct.set(productId, (requestedSnQuantityByProduct.get(productId) || 0) + quantity);
    });
    const loadSnRows = productId => {
      const requiredQuantity = Math.max(1, Number(requestedSnQuantityByProduct.get(String(productId)) || 1));
      const collectedRows = [];
      const seenRows = new Set();
      const pageSize = 100;
      const maxPages = Math.max(1, requiredQuantity + 5);
      const fetchPage = page => api.inventory.getSnList({
        productId,
        storeId: transfer.fromStoreId,
        status: 'in_stock',
        scope: 'transfer',
        page,
        pageSize
      }).then(res => {
        const rows = Array.isArray(res?.data) ? res.data : [];
        rows.forEach(row => {
          const rowKey = String(row.inventoryId || row.inventory_id || row.snId || row.sn_id || row.id || row._id || row.snCode || row.sn_code || row.SN || '');
          if (!rowKey || seenRows.has(rowKey)) return;
          seenRows.add(rowKey);
          collectedRows.push(row);
        });
        const pagination = res.pagination || res.raw?.pagination || res.raw?.pageInfo || {};
        const totalPages = Number(pagination.totalPages || pagination.total_pages || 0);
        if (collectedRows.length >= requiredQuantity || (totalPages && page >= totalPages) || !rows.length || page >= maxPages) {
          return { productId, rows: collectedRows };
        }
        return fetchPage(page + 1);
      }).catch(() => ({ productId, rows: collectedRows }));
      return fetchPage(1);
    };
    const requestProductMap = new Map();
    requestedItems.forEach(item => {
      const key = String(item.productId);
      if (!requestProductMap.has(key)) requestProductMap.set(key, item);
    });
    this.setData({ isSearching: true });
    Promise.all([
      Promise.all(productIds.map(productId => api.product.getPns(productId, transfer.fromStoreId, { scope: 'transfer' })
        .then(rows => ({ productId, rows: rows || [] }))
        .catch(() => ({ productId, rows: [] })))),
      Promise.all(snProductIds.map(loadSnRows))
    ]).then(([pnResult, snResult]) => {
      const pnRowsByProduct = new Map();
      pnResult.forEach(result => pnRowsByProduct.set(String(result.productId), result.rows || []));
      const pnRows = pnResult.reduce((rows, result) => rows.concat(result.rows || []), []);
      const snRows = snResult.reduce((rows, result) => rows.concat((result.rows || []).map(row => Object.assign({}, row, {
        productId: row.productId || row.product_id || result.productId
      }))), []);
      const pnOptionsByProduct = new Map();
      productIds.forEach(productId => {
        const options = new Map();
        (pnRowsByProduct.get(String(productId)) || []).forEach(row => {
          const pnCode = String(row.pnCode || row.pn_code || '').trim();
          if (pnCode) options.set(pnCode, { pnCode });
        });
        (snRows || []).filter(row => String(row.productId) === String(productId)).forEach(row => {
          const pnCode = String(row.pnCode || row.pn_code || '').trim();
          if (pnCode) options.set(pnCode, { pnCode });
        });
        pnOptionsByProduct.set(String(productId), Array.from(options.values()));
      });
      const snOptions = (snRows || [])
        .map(row => normalizeProduct(row, transfer.fromStoreId))
        .map(row => {
          const requestedItem = requestProductMap.get(String(row.productId)) || {};
          return Object.assign({}, row, {
            productName: row.productName || requestedItem.productName || '',
            productCode: row.productCode || requestedItem.productCode || '',
            inventoryId: String(row.inventoryId || ''),
            selected: false
          });
        })
        .filter(row => row.inventoryId && row.snCode);
      const uniqueSnOptions = Array.from(new Map(snOptions.map(row => [String(row.inventoryId), row])).values());
      const shippingItems = (this.data.shipping.items || []).map(item => {
        const pnOptions = pnOptionsByProduct.get(String(item.productId)) || [];
        const itemSnOptions = uniqueSnOptions
          .filter(option => String(option.productId) === String(item.productId))
          .map(option => Object.assign({}, option, { selected: false }));
        const pnIndex = item.pnCode ? pnOptions.findIndex(option => String(option.pnCode) === String(item.pnCode)) : -1;
        return Object.assign({}, item, {
          pnOptions,
          pnIndex,
          snOptions: itemSnOptions
        });
      });
      const firstItem = shippingItems[0] || {};
      this.setData({
        isSearching: false,
        'shipping.items': shippingItems,
        'shipping.pnOptions': firstItem.pnOptions || [],
        'shipping.snOptions': firstItem.snOptions || [],
        'shipping.allSnOptions': uniqueSnOptions,
        'shipping.pnIndex': firstItem.pnIndex === undefined ? -1 : firstItem.pnIndex,
        'shipping.pnCode': firstItem.pnCode || ''
      });
      if (!pnRows.length && !uniqueSnOptions.some(item => item.pnCode)) wx.showToast({ title: '该商品未配置可选 PN', icon: 'none' });
    }).catch(err => {
      console.error('load transfer product options failed:', err);
      this.setData({ isSearching: false });
      wx.showToast({ title: 'PN/SN 查询失败', icon: 'none' });
    });
  },

  onShippingPnChange(e) {
    if (e.currentTarget.dataset.itemIndex !== undefined) {
      return this.onShippingItemPnChange(e);
    }
    const index = Number(e.detail.value);
    const option = this.data.shipping.pnOptions[index];
    if (!option) return;
    const allSnOptions = this.data.shipping.allSnOptions || this.data.shipping.snOptions || [];
    const selectedSnIds = (this.data.shipping.selectedSnIds || [])
      .filter(id => allSnOptions.some(item => String(item.inventoryId) === String(id)))
      .map(String);
    // 多个申请商品可能拥有不同 PN，PN 不能用来过滤掉其他商品的 SN。
    const shippingSnOptions = allSnOptions.map(item => Object.assign({}, item, { selected: selectedSnIds.includes(String(item.inventoryId)) }));
    const selectedSnOptions = shippingSnOptions.filter(item => item.selected);
    this.setData({ 'shipping.pnIndex': index, 'shipping.pnCode': option.pnCode, 'shipping.snOptions': shippingSnOptions, 'shipping.snIndex': -1, 'shipping.snCode': selectedSnOptions.map(item => item.snCode).join(', '), 'shipping.selectedSnIds': selectedSnIds, 'shipping.selectedSnOptions': selectedSnOptions });
  },

  onShippingItemPnChange(e) {
    const itemIndex = Number(e.currentTarget.dataset.itemIndex);
    const index = Number(e.detail.value);
    const items = this.data.shipping.items || [];
    const item = items[itemIndex];
    if (!item) return;
    const option = (item.pnOptions || [])[index];
    if (!option) return;
    const nextItems = items.map((current, indexValue) => indexValue === itemIndex
      ? Object.assign({}, current, { pnIndex: index, pnCode: option.pnCode })
      : current);
    this.setData({
      'shipping.items': nextItems,
      'shipping.pnIndex': itemIndex === 0 ? index : this.data.shipping.pnIndex,
      'shipping.pnCode': itemIndex === 0 ? option.pnCode : this.data.shipping.pnCode
    });
  },

  toggleShippingSn(e) {
    if (e.currentTarget.dataset.itemIndex !== undefined) {
      return this.toggleShippingItemSn(e);
    }
    const index = Number(e.currentTarget.dataset.index);
    const snOptions = this.data.shipping.snOptions || [];
    const option = snOptions[index];
    if (!option || !option.inventoryId) return;
    const selectedSnIds = new Set((this.data.shipping.selectedSnIds || []).map(String));
    const inventoryId = String(option.inventoryId);
    if (selectedSnIds.has(inventoryId)) {
      selectedSnIds.delete(inventoryId);
    } else {
      const requestedQuantity = Number(this.data.shipping.requestedSnQuantity || this.data.shipping.requestedQuantity || 0);
      if (requestedQuantity > 0 && selectedSnIds.size >= requestedQuantity) {
        wx.showToast({ title: `最多只能选择${requestedQuantity}个SN`, icon: 'none' });
        return;
      }
      selectedSnIds.add(inventoryId);
    }
    const selectedSnIdList = Array.from(selectedSnIds);
    const nextSnOptions = snOptions.map(item => Object.assign({}, item, {
      selected: selectedSnIds.has(String(item.inventoryId))
    }));
    const selectedSnOptions = nextSnOptions.filter(item => item.selected);
    const pnCodes = [...new Set(selectedSnOptions.map(item => item.pnCode).filter(Boolean).map(String))];
    this.setData({
      'shipping.snIndex': -1,
      'shipping.snOptions': nextSnOptions,
      'shipping.selectedSnIds': selectedSnIdList,
      'shipping.selectedSnOptions': selectedSnOptions,
      'shipping.snCode': selectedSnOptions.map(item => item.snCode).join(', '),
      'shipping.pnCode': pnCodes.length === 1 ? pnCodes[0] : this.data.shipping.pnCode
    });
  },

  toggleShippingItemSn(e) {
    const itemIndex = Number(e.currentTarget.dataset.itemIndex);
    const snIndex = Number(e.currentTarget.dataset.snIndex);
    const items = this.data.shipping.items || [];
    const item = items[itemIndex];
    const option = item && (item.snOptions || [])[snIndex];
    if (!item || !option || !option.inventoryId) return;
    const selectedSnIds = new Set((item.selectedSnIds || []).map(String));
    const inventoryId = String(option.inventoryId);
    if (selectedSnIds.has(inventoryId)) {
      selectedSnIds.delete(inventoryId);
    } else {
      if (selectedSnIds.size >= Number(item.requestedQuantity || 1)) {
        wx.showToast({ title: `最多只能选择${item.requestedQuantity}个SN`, icon: 'none' });
        return;
      }
      selectedSnIds.add(inventoryId);
    }
    const selectedSnIdList = Array.from(selectedSnIds);
    const nextSnOptions = (item.snOptions || []).map(sn => Object.assign({}, sn, {
      selected: selectedSnIds.has(String(sn.inventoryId))
    }));
    const selectedSnOptions = nextSnOptions.filter(sn => sn.selected);
    const nextItem = Object.assign({}, item, {
      snOptions: nextSnOptions,
      selectedSnIds: selectedSnIdList,
      selectedSnOptions,
      snCode: selectedSnOptions.map(sn => sn.snCode).join(', '),
      pnCode: selectedSnOptions.length === 1 && selectedSnOptions[0].pnCode
        ? selectedSnOptions[0].pnCode
        : item.pnCode
    });
    const nextItems = items.map((current, indexValue) => indexValue === itemIndex ? nextItem : current);
    this.setData({
      'shipping.items': nextItems,
      'shipping.selectedSnIds': itemIndex === 0 ? selectedSnIdList : this.data.shipping.selectedSnIds,
      'shipping.selectedSnOptions': itemIndex === 0 ? selectedSnOptions : this.data.shipping.selectedSnOptions,
      'shipping.snCode': itemIndex === 0 ? nextItem.snCode : this.data.shipping.snCode,
      'shipping.pnCode': itemIndex === 0 ? nextItem.pnCode : this.data.shipping.pnCode
    });
  },

  onShippingKeywordInput(e) {
    this.setData({ 'shipping.keyword': e.detail.value });
  },

  onShippingQuantityInput(e) {
    this.setData({ 'shipping.quantity': e.detail.value });
  },

  onShippingItemQuantityInput(e) {
    const itemIndex = Number(e.currentTarget.dataset.itemIndex);
    const value = Math.max(1, parseInt(e.detail.value, 10) || 1);
    const items = (this.data.shipping.items || []).map((item, index) => index === itemIndex
      ? Object.assign({}, item, { quantity: value })
      : item);
    this.setData({ 'shipping.items': items });
  },

  onShippingPnInput(e) {
    this.setData({ 'shipping.pnCode': e.detail.value });
  },

  onShippingSnInput(e) {
    this.setData({ 'shipping.snCode': e.detail.value });
  },

  searchShippingProduct() {
    const transfer = this.data.shippingTransfer;
    const keyword = String(this.data.shipping.keyword || '').trim();
    if (!transfer || !keyword) {
      wx.showToast({ title: '请输入实际库存商品的PN或SN', icon: 'none' });
      return;
    }
    this.setData({ isSearching: true, 'shipping.productList': [], 'shipping.selectedProduct': null });
    Promise.all([
      api.inventory.list({ storeId: transfer.fromStoreId, keyword, scope: 'transfer', page: 1, pageSize: 50 }),
      api.inventory.getGoodsBySN(keyword, transfer.fromStoreId, '', { scope: 'transfer' }).catch(() => null)
    ])
      .then(([result, snItem]) => {
        const rows = ((result && result.data) || []).concat(snItem ? [snItem] : []).map(item => normalizeProduct(item, transfer.fromStoreId));
        const map = new Map();
        rows.forEach(item => {
          const key = [item.productId, item.inventoryId, item.snCode].join('|');
          if (item.productId && !map.has(key)) map.set(key, item);
        });
        this.setData({ isSearching: false, 'shipping.productList': Array.from(map.values()) });
        if (!map.size) wx.showToast({ title: '未找到可出库库存', icon: 'none' });
      })
      .catch(err => {
        console.error('search shipping product failed:', err);
        this.setData({ isSearching: false });
        wx.showToast({ title: '库存查询失败', icon: 'none' });
      });
  },

  selectShippingProductLegacy(e) {
    const item = this.data.shipping.productList[Number(e.currentTarget.dataset.index)];
    if (!item) return;
    const requestedQuantity = Number(this.data.shippingTransfer?.items?.[0]?.quantity || 1);
    this.setData({
      'shipping.selectedProduct': item,
      'shipping.quantity': item.needSn ? 1 : Math.min(requestedQuantity, item.stock || requestedQuantity),
      'shipping.pnCode': item.pnCode || '',
      'shipping.snCode': item.snCode || ''
    });
  },

  selectShippingProduct(e) {
    const item = this.data.shipping.productList[Number(e.currentTarget.dataset.index)];
    if (!item) return;
    const requestedQuantity = Number(this.data.shipping.requestedQuantity || this.data.shippingTransfer?.remainingQuantity || this.data.shippingTransfer?.items?.[0]?.quantity || 1);
    const needSn = isSnProduct(item);
    this.setData({
      'shipping.selectedProduct': item,
      'shipping.quantity': needSn ? 1 : Math.min(requestedQuantity, item.stock || requestedQuantity),
      'shipping.pnCode': item.pnCode || '',
      'shipping.snCode': item.snCode || '',
      'shipping.selectedSnIds': item.inventoryId ? [String(item.inventoryId)] : [],
      'shipping.selectedSnOptions': item.inventoryId ? [item] : []
    });
  },

  chooseShippingPhotos() {
    chooseImageFiles(paths => this.uploadTransferPhotos(paths, 'shipping'), err => {
      if (err && err.errMsg && err.errMsg.indexOf('cancel') < 0) wx.showToast({ title: '选择照片失败', icon: 'none' });
    });
  },

  chooseReceivingPhotos() {
    chooseImageFiles(paths => this.uploadTransferPhotos(paths, 'receiving'), err => {
      if (err && err.errMsg && err.errMsg.indexOf('cancel') < 0) wx.showToast({ title: '选择照片失败', icon: 'none' });
    });
  },

  uploadTransferPhotos(paths, type) {
    if (!paths.length) return;
    if (!wx.cloud || !wx.cloud.uploadFile) {
      wx.showToast({ title: '当前环境不支持照片上传', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '照片上传中' });
    const folder = type === 'shipping' ? 'transfer-shipping' : 'transfer-receiving';
    const uploads = paths.map((filePath, index) => new Promise((resolve, reject) => {
      wx.cloud.uploadFile({
        cloudPath: `${folder}/${Date.now()}_${index}.jpg`,
        filePath,
        success: result => resolve(result.fileID),
        fail: reject
      });
    }));
    Promise.all(uploads)
      .then(fileIds => {
        const key = type === 'shipping' ? 'shipping.photos' : 'receiving.photos';
        const current = type === 'shipping' ? this.data.shipping.photos : this.data.receiving.photos;
        resolvePhotoUrls(fileIds).then(photoUrls => {
          const urlKey = type === 'shipping' ? 'shipping.photoUrls' : 'receiving.photoUrls';
          const currentUrls = type === 'shipping' ? this.data.shipping.photoUrls : this.data.receiving.photoUrls;
          this.setData({
            [key]: current.concat(fileIds).slice(0, 9),
            [urlKey]: currentUrls.concat(photoUrls).slice(0, 9)
          });
        });
      })
      .catch(err => {
        console.error('upload transfer photos failed:', err);
        wx.showToast({ title: '照片上传失败', icon: 'none' });
      })
      .finally(() => wx.hideLoading());
  },

  previewPhotos(e) {
    const photos = e.currentTarget.dataset.photos || [];
    const current = e.currentTarget.dataset.current || photos[0];
    if (photos.length) wx.previewImage({ current, urls: photos });
  },

  closeActionPanel() {
    this.setData({ activeTransferId: '', shippingTransfer: null, receivingTransfer: null });
  },

  confirmOutLegacy() {
    const transfer = this.data.shippingTransfer;
    const product = transfer?.items?.[0] || null;
    const selectedSn = this.data.shipping.snOptions[this.data.shipping.snIndex] || null;
    const quantity = parseInt(this.data.shipping.quantity, 10) || 0;
    if (!transfer || !product) {
      wx.showToast({ title: '请先选择实际出库商品', icon: 'none' });
      return;
    }
    const pnCode = String(this.data.shipping.pnCode || '').trim();
    const snCode = String(this.data.shipping.snCode || '').trim();
    if (!pnCode) {
      wx.showToast({ title: '出库必须填写 PN', icon: 'none' });
      return;
    }
    if (product.needSn && (!selectedSn || !selectedSn.inventoryId || !snCode)) {
      wx.showToast({ title: 'SN商品必须选择具体库存', icon: 'none' });
      return;
    }
    if (quantity <= 0) {
      wx.showToast({ title: '出库数量无效', icon: 'none' });
      return;
    }
    if (!this.data.shipping.photos.length) {
      wx.showToast({ title: '请拍照或上传出库凭证', icon: 'none' });
      return;
    }
    const item = {
      itemId: transfer.items?.[0]?.itemId || transfer.items?.[0]?.item_id || '',
      productId: product.productId,
      productCode: product.productCode || '',
      productName: product.productName,
      pnCode,
      inventoryId: selectedSn?.inventoryId || '',
      snCode,
      quantity: product.needSn ? 1 : quantity,
      needSn: product.needSn ? 1 : 0
    };
    this.confirmAction('确认已选择商品并完成出库？', () => api.inventory.confirmTransferOut(transfer.transferId, {
      items: [item],
      shippingPhotos: this.data.shipping.photos
    }));
  },

  confirmOut() {
    const transfer = this.data.shippingTransfer;
    const shippingItems = this.data.shipping.items || [];
    if (!transfer || !shippingItems.length) {
      wx.showToast({ title: '请选择实际出库商品', icon: 'none' });
      return;
    }
    if (!this.data.shipping.photos.length) {
      wx.showToast({ title: 'Please upload a shipping photo', icon: 'none' });
      return;
    }
    const items = [];
    for (let index = 0; index < shippingItems.length; index += 1) {
      const shippingItem = shippingItems[index];
      const pnCode = String(shippingItem.pnCode || '').trim();
      if (!pnCode) {
        wx.showToast({ title: `请选择第${index + 1}项商品的 PN`, icon: 'none' });
        return;
      }
      if (shippingItem.needSn) {
        const selectedSnOptions = shippingItem.selectedSnOptions || [];
        if (!selectedSnOptions.length) {
          wx.showToast({ title: `请选择第${index + 1}项商品的 SN`, icon: 'none' });
          return;
        }
        if (selectedSnOptions.length > Number(shippingItem.requestedQuantity || 1)) {
          wx.showToast({ title: `第${index + 1}项商品最多选择${shippingItem.requestedQuantity}个SN`, icon: 'none' });
          return;
        }
        selectedSnOptions.forEach(selectedSn => items.push({
          itemId: shippingItem.itemId,
          item_id: shippingItem.itemId,
          transferItemId: shippingItem.itemId,
          productId: shippingItem.productId,
          productCode: shippingItem.productCode,
          productName: shippingItem.productName,
          pnCode: selectedSn.pnCode || pnCode,
          inventoryId: selectedSn.inventoryId,
          snCode: selectedSn.snCode,
          quantity: 1,
          needSn: 1
        }));
      } else {
        const quantity = parseInt(shippingItem.quantity, 10) || 0;
        if (quantity <= 0 || quantity > Number(shippingItem.requestedQuantity || 1)) {
          wx.showToast({ title: `第${index + 1}项商品出库数量必须在1到${shippingItem.requestedQuantity}之间`, icon: 'none' });
          return;
        }
        items.push({
          itemId: shippingItem.itemId,
          item_id: shippingItem.itemId,
          transferItemId: shippingItem.itemId,
          productId: shippingItem.productId,
          productCode: shippingItem.productCode,
          productName: shippingItem.productName,
          pnCode,
          inventoryId: '',
          snCode: '',
          quantity,
          needSn: 0
        });
      }
    }
    const selectedQuantity = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const requestedQuantity = shippingItems.reduce((sum, item) => sum + Number(item.requestedQuantity || 0), 0);
    const partial = selectedQuantity < requestedQuantity;
    const message = partial
      ? `已选择${selectedQuantity}件，剩余${requestedQuantity - selectedQuantity}件将拒绝调拨，确认出库？`
      : '确认已选择商品并完成出库？';
    this.confirmAction(message, () => api.inventory.confirmTransferOut(transfer.transferId, {
      items,
      remainingAction: partial ? 'reject' : 'fulfilled',
      shippingPhotos: this.data.shipping.photos
    }));
  },

  startReceiving(e) {
    const transfer = this.data.transfers.find(item => item.transferId === e.currentTarget.dataset.id);
    if (!transfer) return;
    const receivingItems = (transfer.items || []).map(item => ({
      itemId: item.itemId || item.item_id || '',
      productId: item.productId || item.product_id || '',
      productCode: item.productCode || item.product_code || '',
      productName: item.productName || item.product_name || '商品',
      // 保留库存主键。SN 状态变更应按 inventoryId 更新，不能只依赖 SN 文本匹配。
      inventoryId: item.inventoryId || item.inventory_id || item.snId || item.sn_id || '',
      pnCode: item.pnCode || '',
      snCode: item.snCode || '',
      needSn: isSnProduct(item),
      quantity: item.quantity || 1,
      locationId: '',
      locationIndex: -1
    }));
    this.setData({
      activeTransferId: transfer.transferId,
      shippingTransfer: null,
      receivingTransfer: transfer,
      receiving: { photos: [], photoUrls: [], locations: [], items: receivingItems }
    });
    this.loadReceivingLocations(transfer);
  },

  loadReceivingLocations(transfer) {
    if (!transfer || !transfer.toStoreId) return;
    api.inventory.getLocations(transfer.toStoreId, { scope: 'transfer' })
      .then(result => {
        const locations = (result && result.data) || [];
        const defaultLocation = locations.length === 1 ? locations[0].locationId : '';
        const items = (this.data.receiving.items || []).map(item => Object.assign({}, item, {
          locationId: item.locationId || defaultLocation,
          locationIndex: item.locationId
            ? locations.findIndex(location => String(location.locationId) === String(item.locationId))
            : (locations.length === 1 ? 0 : -1)
        }));
        this.setData({ 'receiving.locations': locations, 'receiving.items': items });
      })
      .catch(err => {
        console.error('加载调拨收货库位失败:', err);
        wx.showToast({ title: '收货库位加载失败', icon: 'none' });
      });
  },

  onReceivingLocationChange(e) {
    const index = Number(e.detail.value);
    const location = this.data.receiving.locations[index];
    const itemIndex = Number(e.currentTarget.dataset.index);
    if (!location || !this.data.receiving.items[itemIndex]) return;
    this.setData({
      [`receiving.items[${itemIndex}].locationIndex`]: index,
      [`receiving.items[${itemIndex}].locationId`]: location.locationId
    });
  },

  revokeTransfer(e) {
    const transfer = this.data.transfers.find(item => item.transferId === e.currentTarget.dataset.id);
    if (!transfer) return;
    this.confirmAction('确认撤销这条调拨申请？', () => api.inventory.revokeTransfer(transfer.transferId));
  },

  rejectTransfer(e) {
    const transfer = this.data.transfers.find(item => item.transferId === e.currentTarget.dataset.id);
    if (!transfer) return;
    this.confirmAction('确认拒绝这条调拨申请？', () => api.inventory.rejectTransfer(transfer.transferId, { reason: '' }));
  },

  returnTransfer(e) {
    const transfer = this.data.transfers.find(item => item.transferId === e.currentTarget.dataset.id);
    if (!transfer) return;
    this.confirmAction('确认退回这条运输中的调拨申请？退回后申请将失效，商品恢复为调拨前状态。', () => api.inventory.returnTransfer(transfer.transferId, {
      reason: '运输中待收货退回'
    }));
  },

  confirmIn() {
    const transfer = this.data.receivingTransfer;
    if (!transfer) return;
    const receivingItems = this.data.receiving.items || [];
    const invalidIndex = receivingItems.findIndex(item => !item.locationId);
    if (invalidIndex >= 0) {
      wx.showToast({ title: `请选择第${invalidIndex + 1}项商品的入库库位`, icon: 'none' });
      return;
    }
    const missingInventoryIndex = receivingItems.findIndex(item => item.snCode && !item.inventoryId);
    if (missingInventoryIndex >= 0) {
      wx.showToast({ title: `第${missingInventoryIndex + 1}项SN缺少库存关联，请刷新调拨单后重试`, icon: 'none' });
      return;
    }
    const items = receivingItems.map(item => ({
      itemId: item.itemId,
      productId: item.productId,
      productCode: item.productCode,
      productName: item.productName,
      inventoryId: item.inventoryId,
      pnCode: item.pnCode,
      snCode: item.snCode,
      needSn: item.needSn ? 1 : 0,
      quantity: item.quantity,
      locationId: item.locationId
    }));
    this.confirmAction('确认已收到商品并完成入库？', () => api.inventory.confirmTransferIn(transfer.transferId, {
      locationId: items.length === 1 ? items[0].locationId : '',
      items,
      receivingPhotos: this.data.receiving.photos
    }));
  },

  confirmAction(content, taskFactory) {
    wx.showModal({
      title: '调拨确认',
      content,
      success: res => {
        if (!res.confirm) return;
        wx.showLoading({ title: '处理中' });
        taskFactory()
          .then(() => {
            wx.hideLoading();
            wx.showToast({ title: '处理成功', icon: 'success' });
            this.closeActionPanel();
            this.loadTransfers();
          })
          .catch(err => {
            console.error('confirm transfer failed:', err);
            wx.hideLoading();
            const errorMessage = String(err && err.message || '');
            if (/no pending item lines/i.test(errorMessage)) {
              this.closeActionPanel();
              this.loadTransfers();
              wx.showToast({ title: '该调拨单已无待出库商品，请刷新后重试', icon: 'none' });
            } else {
              wx.showToast({ title: errorMessage || '处理失败', icon: 'none' });
            }
          });
      }
    });
  },

  resolveStoreName(stores, storeId) {
    const store = (stores || []).find(item => String(item.storeId) === String(storeId));
    return store ? store.name : '';
  },

  onBack() {
    wx.navigateBack();
  }
});
