const api = require('../../utils/api.js');

function locationIndex(locations, locationId) {
  const target = String(locationId || '');
  const index = (locations || []).findIndex(item => String(item.locationId || '') === target);
  return index < 0 ? -1 : index;
}

function normalizedLocationId(locations, locationId) {
  const index = locationIndex(locations, locationId);
  if (index >= 0) return locations[index].locationId;
  return locations.length === 1 ? locations[0].locationId : '';
}

function pnCodeOf(pn) {
  if (!pn) return '';
  return String(pn.pnCode || pn.pn_code || pn.PN_CODE || pn.code || '').trim();
}

function statusText(status) {
  return {
    pending: '待入库',
    partial: '部分入库',
    partially_received: '部分入库',
    completed: '已完成',
    returned: '已退库'
  }[status] || status || '-';
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).replace('T', ' ').slice(0, 16);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

Page({
  data: {
    inboundId: '',
    inbound: null,
    products: [],
    locations: [],
    loading: true,
    submitting: false,
    editable: false
  },

  onLoad(options) {
    const inboundId = decodeURIComponent(options.inboundId || '');
    if (!inboundId) {
      wx.showToast({ title: '缺少入库单编号', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    this.setData({ inboundId });
    this.loadDetail();
  },

  draftKey() {
    return 'inventory-inbound-execute:' + this.data.inboundId;
  },

  loadDetail() {
    this.setData({ loading: true });
    api.inventory.inboundDetail(this.data.inboundId)
      .then(inbound => {
        const initiatorRequest = !inbound.purchaseInitiatorName && inbound.sourceNo
          ? api.purchase.findByRequestNo(inbound.sourceNo).catch(() => null)
          : Promise.resolve(null);
        return initiatorRequest.then(request => ({
          inbound: Object.assign({}, inbound, {
            purchaseInitiatorName: inbound.purchaseInitiatorName || request && (
              request.purchase_initiator_name || request.purchaseInitiatorName || request.apply_user_name ||
              request.applyUserName || request.applicant_name || request.applicantName || request.apply_user ||
              request.applyUser || request.applicant || ''
            ) || ''
          }),
          locations: null
        }));
      })
      .then(({ inbound }) => this.loadLocations(inbound.storeId).then(locations => ({ inbound, locations })))
      .then(({ inbound, locations }) => {
        const products = this.buildProducts(inbound, locations);
        const draft = wx.getStorageSync(this.draftKey());
        const restored = this.isValidDraft(draft, products)
          ? this.normalizeDraft(draft, locations)
          : products;
        const viewData = Object.assign({}, inbound, {
          statusText: statusText(inbound.status),
          amountText: Number(inbound.totalAmount || 0).toFixed(2),
          createTimeText: formatDate(inbound.createTime),
          receiveTimeText: formatDate(inbound.receiveTime || inbound.updateTime)
        });
        this.setData({
          inbound: viewData,
          locations,
          products: restored,
          editable: ['pending', 'partial', 'partially_received'].includes(inbound.status),
          loading: false
        });
        if (restored !== products) {
          wx.showToast({ title: '已恢复上次草稿', icon: 'none' });
        }
      })
      .catch(err => {
        console.error('加载入库单详情失败:', err);
        this.setData({ loading: false });
        wx.showModal({
          title: '加载失败',
          content: err.message || '无法获取入库单详情',
          showCancel: false,
          success: () => wx.navigateBack()
        });
      });
  },

  loadLocations(storeId) {
    if (!storeId) return Promise.resolve([]);
    return api.inventory.getLocations(storeId)
      .then(result => (result && result.data) || [])
      .catch(err => {
        console.error('加载库位失败:', err);
        wx.showToast({ title: '库位加载失败，请稍后重试', icon: 'none' });
        return [];
      });
  },

  buildProducts(inbound, locations = this.data.locations) {
    const editable = ['pending', 'partial', 'partially_received'].includes(inbound.status);
    return (inbound.items || []).map((item, itemIndex) => {
      const originalQuantity = Math.max(0, Number(item.originalQuantity ?? item.original_quantity ?? item.quantity) || 0);
      const receivedQuantity = Math.max(0, Number(item.receivedQuantity ?? item.received_quantity) || 0);
      const remainingQuantity = Math.max(0, Number(item.remainingQuantity ?? item.remaining_quantity ?? item.quantity) || 0);
      const quantity = editable ? remainingQuantity : originalQuantity;
      const itemPns = Array.isArray(item.pns) && item.pns.length > 0
        ? item.pns
        : (Array.isArray(item.PNs) && item.PNs.length > 0 ? item.PNs : []);
      const legacyProductPns = inbound.productPns && Array.isArray(inbound.productPns[item.productId])
        ? inbound.productPns[item.productId]
        : [];
      const rawPns = itemPns.length > 0 ? itemPns : legacyProductPns;
      const pns = rawPns.map(pn => ({
        pnId: pn.pn_id || pn.pnId || '',
        pnCode: pnCodeOf(pn)
      })).filter(pn => pn.pnCode);
      // PN belongs to this purchase item. Never fall back to a product-level primary PN.
      const pnCode = pnCodeOf(item);
      if (pnCode && !pns.some(pn => pn.pnCode === pnCode)) {
        pns.unshift({ pnId: item.pnId || item.pn_id || '', pnCode });
      }
      const itemLocationId = item.locationId || item.location_id || '';
      const defaultLocationId = normalizedLocationId(locations, itemLocationId);
      const product = {
        groupKey: item.itemId || `${item.productId}-${itemIndex}`,
        inboundItemId: item.itemId || '',
        productId: item.productId,
        productName: item.productName || '未命名商品',
        needSn: !!item.needSn,
        quantity,
        originalQuantity,
        receivedQuantity,
        receivedSnCodes: Array.isArray(item.snCodes || item.sn_codes) ? (item.snCodes || item.sn_codes) : [],
        receiveUser: item.receiveUser || item.receive_user || '',
        receiveTime: item.receiveTime || item.receive_time || '',
        receiveTimeText: formatDate(item.receiveTime || item.receive_time),
        receiveEnabled: quantity > 0,
        pnCode,
        pns,
        snRows: [],
        qtyRows: [],
        allocatedQuantity: quantity,
        allocationMatched: true
      };

      if (product.needSn) {
        for (let index = 0; index < quantity; index += 1) {
          product.snRows.push({
            snCode: quantity > 0 && Number(item.receivedQuantity || item.received_quantity || 0) === 0
              ? ''
              : (item.snCode || ''),
            locationId: defaultLocationId,
            locationIndex: locationIndex(locations, defaultLocationId),
            remark: ''
          });
        }
      } else {
        product.qtyRows.push({
          quantity,
          locationId: defaultLocationId,
          locationIndex: locationIndex(locations, defaultLocationId),
          remark: ''
        });
      }
      return product;
    });
  },

  isValidDraft(draft, products) {
    return Array.isArray(draft) &&
      draft.length === products.length &&
      draft.every((item, index) =>
        item &&
        item.productId === products[index].productId &&
        Number(item.quantity) === Number(products[index].quantity) &&
        (
          products[index].needSn
            ? Array.isArray(item.snRows) && item.snRows.length === products[index].quantity
            : Array.isArray(item.qtyRows) && item.qtyRows.length > 0
        )
      );
  },

  normalizeDraft(draft, locations = this.data.locations) {
    return draft.map(product => Object.assign({}, product, {
      receiveEnabled: product.receiveEnabled !== false,
      pns: product.pns || [],
      snRows: (product.snRows || []).map(row => Object.assign({}, row, {
        locationId: normalizedLocationId(locations, row.locationId),
        locationIndex: locationIndex(locations, normalizedLocationId(locations, row.locationId))
      })),
      qtyRows: (product.qtyRows || []).map(row => Object.assign({}, row, {
        locationId: normalizedLocationId(locations, row.locationId),
        locationIndex: locationIndex(locations, normalizedLocationId(locations, row.locationId))
      }))
    }));
  },

  setProductField(productIndex, field, value) {
    this.setData({ [`products[${productIndex}].${field}`]: value });
  },

  setRowField(productIndex, rowType, rowIndex, field, value) {
    this.setData({ [`products[${productIndex}].${rowType}[${rowIndex}].${field}`]: value });
  },

  onPnInput(e) {
    this.setProductField(e.currentTarget.dataset.productIndex, 'pnCode', e.detail.value);
  },

  onPnPickerChange(e) {
    const productIndex = Number(e.currentTarget.dataset.productIndex);
    const pnIndex = Number(e.detail.value);
    const product = this.data.products[productIndex] || {};
    const pn = (product.pns || [])[pnIndex] || {};
    this.setProductField(productIndex, 'pnCode', pnCodeOf(pn));
  },

  onSnInput(e) {
    const data = e.currentTarget.dataset;
    this.setRowField(data.productIndex, 'snRows', data.rowIndex, 'snCode', e.detail.value);
    this.refreshSnAllocation(Number(data.productIndex));
  },

  deferSnRow(e) {
    const productIndex = Number(e.currentTarget.dataset.productIndex);
    const rowIndex = Number(e.currentTarget.dataset.rowIndex);
    const product = this.data.products[productIndex];
    if (!product || !Array.isArray(product.snRows)) return;
    this.setProductField(productIndex, 'snRows', product.snRows.filter((row, index) => index !== rowIndex));
    this.refreshSnAllocation(productIndex);
  },

  addSnRow(e) {
    const productIndex = Number(e.currentTarget.dataset.productIndex);
    const product = this.data.products[productIndex];
    if (!product || product.snRows.length >= Number(product.quantity)) return;
    const first = product.snRows[0] || {};
    const locationId = normalizedLocationId(this.data.locations, first.locationId);
    this.setProductField(productIndex, 'snRows', product.snRows.concat([{
      snCode: '',
      locationId,
      locationIndex: locationIndex(this.data.locations, locationId),
      remark: ''
    }]));
    this.refreshSnAllocation(productIndex);
  },

  toggleProduct(e) {
    const productIndex = Number(e.currentTarget.dataset.productIndex);
    const product = this.data.products[productIndex];
    if (!product) return;
    const receiveEnabled = !product.receiveEnabled;
    this.setProductField(productIndex, 'receiveEnabled', receiveEnabled);
    if (receiveEnabled && product.needSn && !product.snRows.length) {
      this.addSnRow({ currentTarget: { dataset: { productIndex } } });
    }
  },

  scanSn(e) {
    const data = e.currentTarget.dataset;
    wx.scanCode({
      success: result => {
        this.setRowField(data.productIndex, 'snRows', data.rowIndex, 'snCode', result.result || '');
        this.refreshSnAllocation(Number(data.productIndex));
      },
      fail: err => {
        if (String(err.errMsg || '').indexOf('cancel') < 0) {
          wx.showToast({ title: '扫码失败，请手动输入', icon: 'none' });
        }
      }
    });
  },

  onLocationChange(e) {
    const data = e.currentTarget.dataset;
    const index = Number(e.detail.value);
    const location = this.data.locations[index];
    if (!location) return;
    const rowType = data.rowType;
    this.setRowField(data.productIndex, rowType, data.rowIndex, 'locationIndex', index);
    this.setRowField(data.productIndex, rowType, data.rowIndex, 'locationId', location.locationId);
  },

  onRemarkInput(e) {
    const data = e.currentTarget.dataset;
    this.setRowField(data.productIndex, data.rowType, data.rowIndex, 'remark', e.detail.value);
  },

  onQuantityInput(e) {
    const data = e.currentTarget.dataset;
    this.setRowField(data.productIndex, 'qtyRows', data.rowIndex, 'quantity', e.detail.value);
    this.refreshAllocation(data.productIndex);
  },

  addQtyRow(e) {
    const productIndex = Number(e.currentTarget.dataset.productIndex);
    const product = this.data.products[productIndex];
    const remaining = product.quantity - this.allocatedQty(product);
    const qtyRows = product.qtyRows.concat([{
      locationId: normalizedLocationId(this.data.locations, product.qtyRows[0]?.locationId),
      locationIndex: locationIndex(this.data.locations, normalizedLocationId(this.data.locations, product.qtyRows[0]?.locationId)),
      quantity: Math.max(1, remaining),
      remark: ''
    }]);
    this.setProductField(productIndex, 'qtyRows', qtyRows);
    this.refreshAllocation(productIndex);
  },

  removeQtyRow(e) {
    const productIndex = Number(e.currentTarget.dataset.productIndex);
    const rowIndex = Number(e.currentTarget.dataset.rowIndex);
    const product = this.data.products[productIndex];
    if (product.qtyRows.length <= 1) return;
    const qtyRows = product.qtyRows.filter((row, index) => index !== rowIndex);
    this.setProductField(productIndex, 'qtyRows', qtyRows);
    this.refreshAllocation(productIndex);
  },

  allocatedQty(product) {
    return (product.qtyRows || []).reduce((sum, row) => sum + (parseInt(row.quantity, 10) || 0), 0);
  },

  allocatedSnQty(product) {
    return (product.snRows || []).filter(row => String(row.snCode || '').trim()).length;
  },

  refreshSnAllocation(productIndex) {
    const product = this.data.products[productIndex];
    const allocated = this.allocatedSnQty(product);
    this.setData({
      [`products[${productIndex}].allocatedQuantity`]: allocated,
      [`products[${productIndex}].receivedQuantity`]: allocated,
      [`products[${productIndex}].allocationMatched`]: allocated <= Number(product.quantity)
    });
  },

  refreshAllocation(productIndex) {
    const product = this.data.products[productIndex];
    const allocated = this.allocatedQty(product);
    this.setData({
      [`products[${productIndex}].allocatedQuantity`]: allocated,
      [`products[${productIndex}].allocationMatched`]: allocated > 0 && allocated <= Number(product.quantity)
    });
  },

  saveDraft() {
    wx.setStorageSync(this.draftKey(), this.data.products);
    wx.showToast({ title: '草稿已保存', icon: 'success' });
  },

  buildSubmitItems() {
    const items = [];
    const seenSn = new Set();

    for (const product of this.data.products) {
      if (!product.receiveEnabled) continue;
      const pnCode = String(product.pnCode || '').trim();
      if (product.needSn) {
        for (const row of product.snRows) {
          const snCode = String(row.snCode || '').trim();
          if (!snCode) continue;
          if (!row.locationId) throw new Error(`商品“${product.productName}”第 ${product.snRows.indexOf(row) + 1} 项请选择库位`);
          const uniqueKey = `${product.productId}|${pnCode}|${snCode}`.toLowerCase();
          if (seenSn.has(uniqueKey)) throw new Error(`SN 码“${snCode}”重复，请检查`);
          seenSn.add(uniqueKey);
          items.push({
            inboundItemId: product.inboundItemId,
            productId: product.productId,
            pnCode,
            snCode,
            quantity: 1,
            locationId: row.locationId,
            remark: String(row.remark || '').trim()
          });
        }
      } else {
        for (const row of product.qtyRows) {
          const rawQuantity = String(row.quantity === undefined ? '' : row.quantity).trim();
          if (rawQuantity === '') continue;
          if (!/^[1-9]\d*$/.test(rawQuantity)) {
            throw new Error(`商品“${product.productName}”的入库数量必须为正整数`);
          }
        }
        const allocated = this.allocatedQty(product);
        if (allocated <= 0 || allocated > Number(product.quantity)) {
          throw new Error(`商品“${product.productName}”本次入库 ${allocated} 件，必须为 1-${product.quantity} 件`);
        }
        for (const row of product.qtyRows) {
          const quantity = parseInt(row.quantity, 10) || 0;
          if (quantity <= 0) continue;
          if (!row.locationId) throw new Error(`商品“${product.productName}”的库存分配请选择库位`);
          items.push({
            inboundItemId: product.inboundItemId,
            productId: product.productId,
            pnCode,
            snCode: '',
            quantity,
            locationId: row.locationId,
            remark: String(row.remark || '').trim()
          });
        }
      }
    }
    if (!items.length) throw new Error('没有可入库的商品');
    return items;
  },

  submitInbound() {
    if (this.data.submitting || !this.data.editable) return;
    let items;
    try {
      items = this.buildSubmitItems();
    } catch (err) {
      wx.showToast({ title: err.message, icon: 'none', duration: 2600 });
      return;
    }

    const inboundQuantity = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    wx.showModal({
      title: '确认入库',
      content: `确认将本次 ${inboundQuantity} 件商品入库到“${this.data.inbound.storeName}”吗？未到货商品将保留在待入库数量中。`,
      confirmText: '确认入库',
      success: result => {
        if (!result.confirm) return;
        this.setData({ submitting: true });
        api.inventory.executeInbound({
          inboundId: this.data.inboundId,
          storeId: this.data.inbound.storeId,
          items
        })
          .then(() => {
            wx.removeStorageSync(this.draftKey());
            wx.showToast({ title: '入库提交成功', icon: 'success' });
            setTimeout(() => wx.navigateBack(), 900);
          })
          .catch(err => {
            console.error('执行入库失败:', err);
            wx.showToast({ title: err.message || '入库失败', icon: 'none', duration: 2800 });
          })
          .finally(() => this.setData({ submitting: false }));
      }
    });
  }
});
