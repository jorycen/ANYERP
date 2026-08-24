const api = require('../../utils/api.js');
const userUtils = require('../profile/user-utils.js');
const imageUpload = require('../../utils/image-upload.js');
const { normalizePnCode } = require('../../utils/pn.js');

const INVOICE_TYPES = ['收据', '专票6%', '专票13%'];
const PAYMENT_METHODS = [
  { label: '公司账期', value: 'COMPANY_CREDIT' },
  { label: '个人垫付', value: 'PERSONAL_ADVANCE' }
];

function listOf(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.list)) return result.list;
  if (Array.isArray(result.data)) return result.data;
  if (result.data && Array.isArray(result.data.list)) return result.data.list;
  return [];
}

function resourceMap(types) {
  return (types || []).reduce((result, type) => {
    result[type] = true;
    return result;
  }, {});
}

function defaultLocation(locations) {
  return (locations || []).find(location => String(location.type || '') === 'normal_qty') || null;
}

function getDefaultPurchaseStore(userInfo, stores) {
  if (userUtils.isDistributorAccount(userInfo)) {
    return { storeIndex: -1, store: {} };
  }
  const preferredId = String(userInfo?.storeId || '');
  const storeIndex = (stores || []).findIndex(store => String(store.storeId || '') === preferredId);
  return { storeIndex, store: (stores || [])[storeIndex] || {} };
}

function normalizeProduct(item) {
  return {
    productId: item.productId || item.product_id || item._id || '',
    name: item.name || item.product_name || item.NAME || '',
    productCode: item.product_code || item.productCode || '',
    pnCode: item.pnCode || '',
    price: Number(item.min_sale_price || item.settlementPrice || item.price || item.standard_price || 0)
  };
}

function emptyNewProduct() {
  return {
    categoryId: '',
    categoryName: '',
    manualName: '',
    config: '',
    unit: '台',
    needSn: true,
    needImei: false,
    remark: '',
    pnCode: '',
    attributes: {},
    labelPhotoIds: [],
    labelPhotoUrls: []
  };
}

function emptyUsedProduct() {
  return {
    name: '',
    pnCode: '',
    price: '',
    quantity: 1,
    directInbound: false,
    snCode: ''
  };
}

const RECORD_FILTERS = [
  { label: '全部', value: 'all' },
  { label: '采购申请', value: 'purchase' },
  { label: '新建商品', value: 'product' },
  { label: '报销', value: 'expense' }
];

function firstValue(item, keys) {
  for (const key of keys) {
    if (item && item[key] !== undefined && item[key] !== null && String(item[key]).trim() !== '') {
      return item[key];
    }
  }
  return '';
}

function parseDateValue(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (!value) return NaN;

  const text = String(value).trim();
  let normalized = text;
  const localDateTime = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (localDateTime) {
    normalized = `${localDateTime[1]}/${localDateTime[2]}/${localDateTime[3]} ${localDateTime[4]}:${localDateTime[5]}:${localDateTime[6] || '00'}`;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    normalized = text.replace(/-/g, '/');
  }

  const timestamp = new Date(normalized).getTime();
  return Number.isNaN(timestamp) ? NaN : timestamp;
}

function formatRecordTime(value) {
  if (!value) return '';
  const timestamp = parseDateValue(value);
  if (Number.isNaN(timestamp)) return String(value);
  const date = new Date(timestamp);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function isTruthy(value) {
  return value === true || value === 1 || ['1', 'true', 'yes', 'y'].includes(String(value || '').toLowerCase());
}

function hasCompletedInbound(item) {
  const inboundState = String(firstValue(item, ['inbound_status', 'inboundStatus', 'inbound_state', 'inboundState']) || '').toLowerCase();
  return ['completed', 'received', 'inbound_completed', '已完成', '已入库'].includes(inboundState) ||
    isTruthy(firstValue(item, ['inbound_completed', 'inboundCompleted', 'has_completed_inbound', 'hasCompletedInbound', 'is_inbound_completed']));
}

function revokeInfo(type, item, status) {
  const explicit = firstValue(item, ['can_revoke', 'canRevoke', 'allow_revoke', 'allowRevoke']);
  if (explicit !== '') {
    return { canRevoke: isTruthy(explicit), reason: '' };
  }

  if (type === 'purchase') {
    if (hasCompletedInbound(item)) return { canRevoke: false, reason: '已入库，无法撤销' };
    return { canRevoke: ['pending', 'approved', 'purchased'].includes(status), reason: '' };
  }
  if (type === 'product') {
    return { canRevoke: status === 'pending', reason: '' };
  }
  return { canRevoke: ['pending_approval', 'approved', 'pending_payment'].includes(status), reason: '' };
}

function normalizeWorkflowRecord(type, item) {
  const status = String(firstValue(item, ['status']) || '');
  const revoke = revokeInfo(type, item, status);
  const reviewComment = firstValue(item, ['approve_comment', 'approveComment', 'review_comment', 'reviewComment']);
  const reviewUserName = firstValue(item, ['approve_user', 'approveUser', 'review_user_name', 'reviewUserName']);
  const reviewTime = formatRecordTime(firstValue(item, ['approve_time', 'approveTime', 'review_time', 'reviewTime']));
  const stage = firstValue(item, [
    'current_stage_name', 'currentStageName', 'current_stage', 'currentStage',
    'workflow_stage_name', 'workflowStageName', 'approval_stage_name', 'approvalStageName',
    'stage_name', 'stageName', 'stage_text', 'stageText', 'current_node_name', 'currentNodeName',
    'next_step_name', 'nextStepName'
  ]);
  const statusMaps = {
    purchase: {
      pending: ['待审批', '采购审批'], approved: ['已通过', '采购执行'],
      purchased: ['已采购', '采购执行'], rejected: ['已拒绝', '已结束'], revoked: ['已撤销', '已结束'], cancelled: ['已取消', '已结束']
    },
    product: {
      pending: ['待审批', '商品审批'], approved: ['已通过', '已进入商品库'], rejected: ['已拒绝', '已结束'], revoked: ['已撤销', '已结束']
    },
    expense: {
      pending_approval: ['待审批', '领导审批'], approved: ['已通过', '待结算'],
      pending_payment: ['待付款', '财务付款'], paid: ['已付款', '已完成'],
      rejected: ['已拒绝', '已结束'], cancelled: ['已取消', '已结束']
    }
  };
  const fallback = statusMaps[type]?.[status] || [status || '-', stage || '-'];
  const statusText = firstValue(item, ['status_text', 'statusText']) || fallback[0];
  const currentStage = stage || fallback[1];
  const id = type === 'purchase'
    ? firstValue(item, ['request_id', 'requestId', 'id'])
    : type === 'product'
      ? firstValue(item, ['application_id', 'applicationId', 'id'])
      : firstValue(item, ['expense_id', 'expenseId', 'id']);
  const no = type === 'purchase'
    ? firstValue(item, ['request_no', 'requestNo'])
    : type === 'product'
      ? firstValue(item, ['application_no', 'applicationNo'])
      : firstValue(item, ['expense_no', 'expenseNo']);
  const rawCreateTime = firstValue(item, ['create_time', 'createTime', 'created_at', 'createdAt']);
  const createTime = formatRecordTime(rawCreateTime);
  const sortTime = parseDateValue(rawCreateTime);

  if (type === 'purchase') {
    const paymentMethod = firstValue(item, ['payment_method', 'paymentMethod']);
    return {
      type, typeLabel: '采购申请', recordId: id, recordKey: `${type}:${id}`, recordNo: no || id,
      title: firstValue(item, ['items_summary', 'itemsSummary', 'product_type', 'productType']) || '采购申请',
      summary: `${firstValue(item, ['supplier_name', 'supplierName']) || '-'} · ${paymentMethod === 'PERSONAL_ADVANCE' ? '个人垫付' : '公司账期'}`,
      status, statusText, currentStage, createTime, sortTime, reviewComment, reviewUserName, reviewTime, canRevoke: revoke.canRevoke, revokeDisabledReason: revoke.reason,
      amountText: Number(firstValue(item, ['total_amount', 'totalAmount']) || 0).toFixed(2)
    };
  }

  if (type === 'product') {
    return {
      type, typeLabel: '新建商品', recordId: id, recordKey: `${type}:${id}`, recordNo: no || id,
      title: firstValue(item, ['product_name', 'productName']) || '新建商品',
      summary: firstValue(item, ['category_name', 'categoryName']) || '未分类',
      status, statusText, currentStage, createTime, sortTime, reviewComment, reviewUserName, reviewTime, canRevoke: revoke.canRevoke, revokeDisabledReason: revoke.reason, amountText: ''
    };
  }

  return {
    type, typeLabel: '报销', recordId: id, recordKey: `${type}:${id}`, recordNo: no || id,
    title: `${firstValue(item, ['expense_type', 'expenseType']) || '费用'} · ${firstValue(item, ['expense_party', 'expenseParty']) || '-'}`,
    summary: firstValue(item, ['region_name', 'regionName']) || '-',
    status, statusText, currentStage, createTime, sortTime, reviewComment, reviewUserName, reviewTime, canRevoke: revoke.canRevoke, revokeDisabledReason: revoke.reason,
    amountText: Number(firstValue(item, ['amount']) || 0).toFixed(2)
  };
}

Page({
  data: {
    activeTab: 'create',
    purchaseQueryOnly: false,
    invoiceTypes: INVOICE_TYPES,
    paymentMethods: PAYMENT_METHODS,
    freightPlatforms: [],
    productTypes: [],
    goodsTypes: [],
    resourceOptions: [],
    suppliers: [],
    stores: [],
    productList: [],
    applications: [],
    productApplications: [],
    recordFilters: RECORD_FILTERS,
    recordFilter: 'all',
    myRecords: [],
    filteredMyRecords: [],
    pagedMyRecords: [],
    recordPage: 1,
    recordPageSize: 5,
    recordPageCount: 0,
    categoryOptions: [],
    categoryFields: [],
    computedProductName: '',
    productKeyword: '',
    supplierKeyword: '',
    showSupplierModal: false,
    supplierSearching: false,
    showProductModal: false,
    isLoading: false,
    isMyRecordsLoading: false,
    isSearching: false,
    isSubmitting: false,
    isSavingProduct: false,
    revokingRecordKey: '',
    requestTotal: '0.00',
    form: {
      supplierIndex: -1,
      supplierId: '',
      supplierName: '',
      invoiceTypeIndex: 2,
      invoiceType: INVOICE_TYPES[2],
      paymentMethodIndex: 0,
      paymentMethod: 'COMPANY_CREDIT',
      freightPlatformId: '',
      freightPlatformName: '',
      freightAmount: '',
      productTypeIndex: -1,
      productType: '',
      remark: '',
      supplierChatScreenshotIds: [],
      supplierChatScreenshotUrls: [],
      items: []
    },
    newProduct: emptyNewProduct()
    ,usedProduct: emptyUsedProduct()
  },

  onLoad() {
    const purchaseQueryOnly = userUtils.isPurchaseQueryOnly();
    this.setData({ purchaseQueryOnly, activeTab: purchaseQueryOnly ? 'list' : 'create' });
    api.freight.platforms().then(platforms => this.setData({ freightPlatforms: Array.isArray(platforms) ? platforms : [] })).catch(() => {});
    if (purchaseQueryOnly) {
      this.loadMyRecords();
      return;
    }
    Promise.all([this.loadSuppliers(), this.loadGoodsTypes(), this.loadStores(), this.loadApplications(), this.loadCategories(), this.loadProductApplications(), this.loadMyRecords()]);
  },

  onPullDownRefresh() {
    if (this.data.purchaseQueryOnly) {
      this.loadMyRecords().finally(() => wx.stopPullDownRefresh());
      return;
    }
    Promise.all([this.loadSuppliers(), this.loadApplications(), this.loadMyRecords()]).finally(() => wx.stopPullDownRefresh());
  },

  switchTab(e) {
    const activeTab = e.currentTarget.dataset.tab;
    if (this.data.purchaseQueryOnly && activeTab !== 'list') return;
    if (activeTab === 'expense') {
      wx.navigateTo({ url: '/pages/expense-manage/expense-manage' });
      return;
    }
    this.setData({ activeTab });
    if (activeTab === 'list') this.loadMyRecords();
    if (activeTab === 'product') {
      if (!this.data.categoryOptions.length) this.loadCategories();
      this.loadProductApplications();
    }
  },

  openUsedProductForm() {
    if (this.data.purchaseQueryOnly) return;
    this.setData({ activeTab: 'used-product', usedProduct: emptyUsedProduct() });
  },

  backToPurchaseForm() {
    this.setData({ activeTab: 'create' });
  },

  onUsedProductInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`usedProduct.${field}`]: e.detail.value });
  },

  onUsedProductDirectInboundChange(e) {
    const directInbound = Boolean(e.detail.value);
    this.setData({
      'usedProduct.directInbound': directInbound,
      'usedProduct.quantity': directInbound ? 1 : this.data.usedProduct.quantity,
      'usedProduct.snCode': directInbound ? this.data.usedProduct.snCode : ''
    });
  },

  addUsedProductToRequest() {
    const usedProduct = this.data.usedProduct || emptyUsedProduct();
    const name = String(usedProduct.name || '').trim();
    const quantity = Number(usedProduct.quantity);
    const price = Number(usedProduct.price);
    const snCode = String(usedProduct.snCode || '').trim();
    if (!name || !Number.isInteger(quantity) || quantity <= 0 || !Number.isFinite(price) || price < 0) {
      wx.showToast({ title: '请完善二手商品名称、单价和数量', icon: 'none' });
      return;
    }
    const pnCode = String(usedProduct.pnCode || '').trim();
    if (usedProduct.directInbound && !pnCode) {
      wx.showToast({ title: '勾选审批完成及入库时必须填写PN码', icon: 'none' });
      return;
    }
    if (usedProduct.directInbound && (quantity !== 1 || !snCode)) {
      wx.showToast({ title: '勾选审批完成及入库时，数量必须为1且必须填写SN号', icon: 'none' });
      return;
    }
    const user = userUtils.getUserInfo();
    const { storeIndex, store } = getDefaultPurchaseStore(user, this.data.stores);
    const defaultStoreId = userUtils.isDistributorAccount(user) ? '' : (store.storeId || user.storeId || '');
    const defaultStoreName = userUtils.isDistributorAccount(user) ? '' : (store.name || user.storeName || '');
    const allocation = {
      storeIndex,
      storeId: defaultStoreId,
      storeName: defaultStoreName,
      quantity,
      locationOptions: [],
      locationIndex: -1,
      locationId: '',
      locationName: ''
    };
    const item = {
      itemKey: `used-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      isUsedProduct: true,
      productId: '',
      productName: name,
      productCode: '二手商品待生成',
      pnCode,
      price,
      quantity,
      directInbound: Boolean(usedProduct.directInbound),
      directInboundSnCode: usedProduct.directInbound ? snCode : '',
      storeAllocations: [allocation],
      selectedResourceTypes: (this.data.goodsTypes[this.data.form.productTypeIndex]?.resourceTypes || []).slice(),
      selectedResourceMap: resourceMap(this.data.goodsTypes[this.data.form.productTypeIndex]?.resourceTypes || [])
    };
    const items = this.data.form.items.concat([item]);
    this.setData({ 'form.items': items, activeTab: 'create', usedProduct: emptyUsedProduct() }, () => {
      this.updateRequestTotal();
      this.loadAllocationLocations(items.length - 1, 0, allocation.storeId);
    });
  },

  onSupplierKeywordInput(e) {
    this.setData({ supplierKeyword: e.detail.value });
  },

  searchSuppliers() {
    const keyword = (this.data.supplierKeyword || '').trim();
    this.setData({ showSupplierModal: true, supplierSearching: true, suppliers: [] });
    return this.loadSuppliers(keyword).finally(() => {
      this.setData({ supplierSearching: false });
    });
  },

  loadSuppliers(keyword = '') {
    return api.purchase.suppliers({ keyword, page: 1, pageSize: 200, status: 1 })
      .then(result => {
        const suppliers = listOf(result).map(item => ({
          supplierId: item.supplier_id || item.supplierId || item.id || '',
          name: item.name || '',
          invoiceType: item.invoice_type || item.invoiceType || ''
        }));
        this.setData({ suppliers });
      })
      .catch(err => {
        console.error('load ANY-ERP suppliers failed:', err);
        wx.showToast({ title: err.message || '供应商加载失败', icon: 'none' });
      });
  },

  onSupplierChange(e) {
    const index = Number(e.detail.value);
    const supplier = this.data.suppliers[index] || {};
    const updates = {
      'form.supplierIndex': index,
      'form.supplierId': supplier.supplierId || '',
      'form.supplierName': supplier.name || ''
    };
    const invoiceIndex = INVOICE_TYPES.indexOf(supplier.invoiceType);
    if (invoiceIndex >= 0) {
      updates['form.invoiceTypeIndex'] = invoiceIndex;
      updates['form.invoiceType'] = supplier.invoiceType;
    }
    this.setData(updates);
  },

  selectSupplier(e) {
    const index = Number(e.currentTarget.dataset.index);
    const supplier = this.data.suppliers[index] || {};
    const updates = {
      supplierKeyword: supplier.name || '',
      showSupplierModal: false,
      'form.supplierIndex': index,
      'form.supplierId': supplier.supplierId || '',
      'form.supplierName': supplier.name || ''
    };
    const invoiceIndex = INVOICE_TYPES.indexOf(supplier.invoiceType);
    if (invoiceIndex >= 0) {
      updates['form.invoiceTypeIndex'] = invoiceIndex;
      updates['form.invoiceType'] = supplier.invoiceType;
    }
    this.setData(updates);
  },

  closeSupplierModal() {
    this.setData({ showSupplierModal: false });
  },

  onInvoiceTypeChange(e) {
    const index = Number(e.detail.value);
    this.setData({ 'form.invoiceTypeIndex': index, 'form.invoiceType': INVOICE_TYPES[index] });
  },

  onPaymentMethodChange(e) {
    const index = Number(e.detail.value);
    this.setData({
      'form.paymentMethodIndex': index,
      'form.paymentMethod': PAYMENT_METHODS[index]?.value || 'COMPANY_CREDIT'
    });
  },

  onProductTypeChange(e) {
    const index = Number(e.detail.value);
    const goodsType = this.data.goodsTypes[index] || {};
    const selectedResourceTypes = goodsType.resourceTypes || [];
    const items = this.data.form.items.map(item => ({
      ...item,
      selectedResourceTypes: selectedResourceTypes.slice(),
      selectedResourceMap: resourceMap(selectedResourceTypes)
    }));
    this.setData({
      'form.productTypeIndex': index,
      'form.productType': goodsType.name || '',
      'form.items': items
    });
  },

  loadGoodsTypes() {
    return Promise.all([api.purchase.goodsTypes(), api.purchase.resourceCategories()])
      .then(([goodsTypeResult, categoryResult]) => {
        const resourceOptions = listOf(categoryResult)
          .filter(item => item.status !== 0 && item.supports_purchase_select !== 0)
          .map(item => ({
            label: item.name || '',
            value: item.category_code || ''
          }));
        const goodsTypes = listOf(goodsTypeResult).map(item => ({
          goodsTypeId: item.goods_type_id || '',
          name: item.name || '',
          resourceTypes: (item.ResourceCategories || [])
            .filter(category => category.status !== 0 && category.supports_purchase_select !== 0)
            .map(category => category.category_code)
        }));
        const currentIndex = Math.max(0, goodsTypes.findIndex(item => item.name === this.data.form.productType));
        const current = goodsTypes[currentIndex] || {};
        this.setData({
          goodsTypes,
          productTypes: goodsTypes.map(item => item.name),
          resourceOptions,
          'form.productTypeIndex': goodsTypes.length ? currentIndex : -1,
          'form.productType': current.name || ''
        });
      })
      .catch(err => {
        console.error('load goods types failed:', err);
        wx.showToast({ title: err.message || '货型配置加载失败', icon: 'none' });
      });
  },

  onRemarkInput(e) {
    this.setData({ 'form.remark': e.detail.value });
  },

  loadStores() {
    const user = userUtils.getUserInfo();
    return api.store.getStores(user.distributorId || '').then(res => {
      const stores = res.data || [];
      this.setData({ stores });
    }).catch(err => {
      console.error('load stores for purchase failed:', err);
      wx.showToast({ title: '门店加载失败', icon: 'none' });
    });
  },

  loadItemLocations(itemIndex, storeId) {
    if (!storeId) {
      this.setData({
        [`form.items[${itemIndex}].locationOptions`]: [],
        [`form.items[${itemIndex}].locationIndex`]: -1,
        [`form.items[${itemIndex}].locationId`]: '',
        [`form.items[${itemIndex}].locationName`]: ''
      });
      return Promise.resolve([]);
    }

    return api.inventory.getLocations(storeId).then(result => {
      const locations = (result.data || []).filter(location => location.status !== 0);
      const preferred = defaultLocation(locations) || (locations.length === 1 ? locations[0] : null);
      const locationIndex = preferred ? locations.findIndex(location => location.locationId === preferred.locationId) : -1;
      this.setData({
        [`form.items[${itemIndex}].locationOptions`]: locations,
        [`form.items[${itemIndex}].locationIndex`]: locationIndex,
        [`form.items[${itemIndex}].locationId`]: preferred?.locationId || '',
        [`form.items[${itemIndex}].locationName`]: preferred?.name || ''
      });
      return locations;
    }).catch(err => {
      console.error('load purchase locations failed:', err);
      this.setData({
        [`form.items[${itemIndex}].locationOptions`]: [],
        [`form.items[${itemIndex}].locationIndex`]: -1,
        [`form.items[${itemIndex}].locationId`]: '',
        [`form.items[${itemIndex}].locationName`]: ''
      });
      wx.showToast({ title: err.message || '库位加载失败', icon: 'none' });
      return [];
    });
  },

  loadAllocationLocations(itemIndex, allocationIndex, storeId) {
    const base = `form.items[${itemIndex}].storeAllocations[${allocationIndex}]`;
    if (!storeId) {
      this.setData({
        [`${base}.locationOptions`]: [],
        [`${base}.locationIndex`]: -1,
        [`${base}.locationId`]: '',
        [`${base}.locationName`]: ''
      });
      return Promise.resolve([]);
    }
    return api.inventory.getLocations(storeId).then(result => {
      const locations = (result.data || []).filter(location => location.status !== 0);
      const preferred = defaultLocation(locations) || (locations.length === 1 ? locations[0] : null);
      const locationIndex = preferred ? locations.findIndex(location => location.locationId === preferred.locationId) : -1;
      this.setData({
        [`${base}.locationOptions`]: locations,
        [`${base}.locationIndex`]: locationIndex,
        [`${base}.locationId`]: preferred?.locationId || '',
        [`${base}.locationName`]: preferred?.name || ''
      });
      return locations;
    }).catch(err => {
      console.error('load purchase allocation locations failed:', err);
      this.setData({
        [`${base}.locationOptions`]: [],
        [`${base}.locationIndex`]: -1,
        [`${base}.locationId`]: '',
        [`${base}.locationName`]: ''
      });
      wx.showToast({ title: err.message || '库位加载失败', icon: 'none' });
      return [];
    });
  },

  onProductKeywordInput(e) {
    this.setData({ productKeyword: e.detail.value });
  },

  searchProduct() {
    const keyword = (this.data.productKeyword || '').trim();
    if (!keyword) {
      wx.showToast({ title: '请输入商品名称或编码', icon: 'none' });
      return;
    }
    this.setData({ showProductModal: true, isSearching: true, productList: [] });
    api.product.search(keyword, { page: 1, pageSize: 50 })
      .then(rows => {
        const productList = (rows || []).map(normalizeProduct);
        this.setData({ productList, isSearching: false });
        if (!productList.length) wx.showToast({ title: '未找到商品，可先新建商品', icon: 'none' });
      })
      .catch(err => {
        console.error('search ANY-ERP product failed:', err);
        this.setData({ isSearching: false });
        wx.showToast({ title: err.message || '商品查询失败', icon: 'none' });
      });
  },

  addProduct(e) {
    const product = this.data.productList[Number(e.currentTarget.dataset.index)];
    if (!product || !product.productId) return;
    if (this.data.form.items.some(item => item.productId === product.productId)) {
      wx.showToast({ title: '该商品已添加', icon: 'none' });
      return;
    }
    const user = userUtils.getUserInfo();
    const { storeIndex, store } = getDefaultPurchaseStore(user, this.data.stores);
    const defaultStoreId = userUtils.isDistributorAccount(user) ? '' : (store.storeId || user.storeId || '');
    const defaultStoreName = userUtils.isDistributorAccount(user) ? '' : (store.name || user.storeName || '');
    const initialAllocation = {
      storeIndex,
      storeId: defaultStoreId,
      storeName: defaultStoreName,
      quantity: 1,
      locationOptions: [],
      locationIndex: -1,
      locationId: '',
      locationName: ''
    };
    const items = this.data.form.items.concat([{
      itemKey: product.productId,
      productId: product.productId,
      productName: product.name,
      productCode: product.productCode,
      pnCode: product.pnCode,
      price: product.price || '',
      quantity: 1,
      storeIndex,
      storeId: defaultStoreId,
      storeName: defaultStoreName,
      storeAllocations: [initialAllocation],
      locationOptions: [],
      locationIndex: -1,
      locationId: '',
      locationName: '',
      selectedResourceTypes: (this.data.goodsTypes[this.data.form.productTypeIndex]?.resourceTypes || []).slice(),
      selectedResourceMap: resourceMap(this.data.goodsTypes[this.data.form.productTypeIndex]?.resourceTypes || [])
    }]);
    this.setData({
      productKeyword: product.name,
      productList: [],
      showProductModal: false,
      'form.items': items
    }, () => {
      this.updateRequestTotal();
      this.loadAllocationLocations(items.length - 1, 0, initialAllocation.storeId);
    });
  },

  closeProductModal() {
    this.setData({ showProductModal: false, productList: [] });
  },

  noop() {},

  removeItem(e) {
    const items = this.data.form.items.slice();
    items.splice(Number(e.currentTarget.dataset.index), 1);
    this.setData({ 'form.items': items }, () => this.updateRequestTotal());
  },

  onItemInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.items[${index}].${field}`]: e.detail.value }, () => {
      if (field === 'quantity' && this.data.form.items[index]?.storeAllocations?.length === 1) {
        this.setData({ [`form.items[${index}].storeAllocations[0].quantity`]: e.detail.value });
      }
      this.updateRequestTotal();
    });
  },

  addStoreAllocation(e) {
    const itemIndex = Number(e.currentTarget.dataset.index);
    const item = this.data.form.items[itemIndex];
    if (!item) return;
    const allocations = item.storeAllocations || [];
    const usedStoreIds = new Set(allocations.map(allocation => String(allocation.storeId || '')));
    const storeIndex = this.data.stores.findIndex(store => !usedStoreIds.has(String(store.storeId || '')));
    if (storeIndex < 0) {
      wx.showToast({ title: '没有可再分配的收货门店', icon: 'none' });
      return;
    }
    const store = this.data.stores[storeIndex];
    const allocation = {
      storeIndex,
      storeId: store.storeId || '',
      storeName: store.name || '',
      quantity: 0,
      locationOptions: [],
      locationIndex: -1,
      locationId: '',
      locationName: ''
    };
    this.setData({ [`form.items[${itemIndex}].storeAllocations`]: allocations.concat([allocation]) }, () => {
      this.loadAllocationLocations(itemIndex, allocations.length, allocation.storeId);
    });
  },

  removeStoreAllocation(e) {
    const itemIndex = Number(e.currentTarget.dataset.itemIndex);
    const allocationIndex = Number(e.currentTarget.dataset.allocationIndex);
    const allocations = (this.data.form.items[itemIndex]?.storeAllocations || []).slice();
    allocations.splice(allocationIndex, 1);
    this.setData({ [`form.items[${itemIndex}].storeAllocations`]: allocations });
  },

  onAllocationStoreChange(e) {
    const itemIndex = Number(e.currentTarget.dataset.itemIndex);
    const allocationIndex = Number(e.currentTarget.dataset.allocationIndex);
    const storeIndex = Number(e.detail.value);
    const store = this.data.stores[storeIndex] || {};
    const allocations = this.data.form.items[itemIndex]?.storeAllocations || [];
    const duplicated = allocations.some((allocation, index) => index !== allocationIndex && String(allocation.storeId || '') === String(store.storeId || ''));
    if (duplicated) {
      wx.showToast({ title: '同一商品不能重复选择收货门店', icon: 'none' });
      return;
    }
    this.setData({
      [`form.items[${itemIndex}].storeAllocations[${allocationIndex}].storeIndex`]: storeIndex,
      [`form.items[${itemIndex}].storeAllocations[${allocationIndex}].storeId`]: store.storeId || '',
      [`form.items[${itemIndex}].storeAllocations[${allocationIndex}].storeName`]: store.name || '',
      [`form.items[${itemIndex}].storeAllocations[${allocationIndex}].locationOptions`]: [],
      [`form.items[${itemIndex}].storeAllocations[${allocationIndex}].locationIndex`]: -1,
      [`form.items[${itemIndex}].storeAllocations[${allocationIndex}].locationId`]: '',
      [`form.items[${itemIndex}].storeAllocations[${allocationIndex}].locationName`]: ''
    });
    this.loadAllocationLocations(itemIndex, allocationIndex, store.storeId || '');
  },

  onAllocationQuantityInput(e) {
    const itemIndex = Number(e.currentTarget.dataset.itemIndex);
    const allocationIndex = Number(e.currentTarget.dataset.allocationIndex);
    this.setData({ [`form.items[${itemIndex}].storeAllocations[${allocationIndex}].quantity`]: e.detail.value });
  },

  onAllocationLocationChange(e) {
    const itemIndex = Number(e.currentTarget.dataset.itemIndex);
    const allocationIndex = Number(e.currentTarget.dataset.allocationIndex);
    const locationIndex = Number(e.detail.value);
    const location = this.data.form.items[itemIndex]?.storeAllocations?.[allocationIndex]?.locationOptions?.[locationIndex] || {};
    this.setData({
      [`form.items[${itemIndex}].storeAllocations[${allocationIndex}].locationIndex`]: locationIndex,
      [`form.items[${itemIndex}].storeAllocations[${allocationIndex}].locationId`]: location.locationId || '',
      [`form.items[${itemIndex}].storeAllocations[${allocationIndex}].locationName`]: location.name || ''
    });
  },

  onItemStoreChange(e) {
    const itemIndex = Number(e.currentTarget.dataset.index);
    const storeIndex = Number(e.detail.value);
    const store = this.data.stores[storeIndex] || {};
    this.setData({
      [`form.items[${itemIndex}].storeIndex`]: storeIndex,
      [`form.items[${itemIndex}].storeId`]: store.storeId || '',
      [`form.items[${itemIndex}].storeName`]: store.name || '',
      [`form.items[${itemIndex}].locationOptions`]: [],
      [`form.items[${itemIndex}].locationIndex`]: -1,
      [`form.items[${itemIndex}].locationId`]: '',
      [`form.items[${itemIndex}].locationName`]: ''
    });
    this.loadItemLocations(itemIndex, store.storeId || '');
  },

  onItemLocationChange(e) {
    const itemIndex = Number(e.currentTarget.dataset.index);
    const locationIndex = Number(e.detail.value);
    const location = this.data.form.items[itemIndex]?.locationOptions?.[locationIndex] || {};
    this.setData({
      [`form.items[${itemIndex}].locationIndex`]: locationIndex,
      [`form.items[${itemIndex}].locationId`]: location.locationId || '',
      [`form.items[${itemIndex}].locationName`]: location.name || ''
    });
  },

  onItemResourceChange(e) {
    const itemIndex = Number(e.currentTarget.dataset.index);
    const selectedResourceTypes = e.detail.value || [];
    this.setData({
      [`form.items[${itemIndex}].selectedResourceTypes`]: selectedResourceTypes,
      [`form.items[${itemIndex}].selectedResourceMap`]: resourceMap(selectedResourceTypes)
    });
  },

  chooseSupplierChatScreenshots() {
    const current = this.data.form.supplierChatScreenshotIds || [];
    const count = 9 - current.length;
    if (count <= 0) {
      wx.showToast({ title: '最多上传9张截图', icon: 'none' });
      return;
    }

    imageUpload.chooseImages({
      count,
      sourceType: ['album', 'camera'],
      success: paths => this.uploadSupplierChatScreenshots(paths),
      fail: err => {
        if (!err || !String(err.errMsg || '').toLowerCase().includes('cancel')) {
          wx.showToast({ title: '选择截图失败', icon: 'none' });
        }
      }
    });
  },

  uploadSupplierChatScreenshots(paths) {
    if (!paths.length) return;
    wx.showLoading({ title: '截图上传中...' });
    imageUpload.uploadImages(paths, 'purchase-supplier-chat')
      .then(fileIds => imageUpload.resolveImageUrls(fileIds).then(photoUrls => {
        const ids = [...(this.data.form.supplierChatScreenshotIds || []), ...fileIds].slice(0, 9);
        const urls = [...(this.data.form.supplierChatScreenshotUrls || []), ...photoUrls].slice(0, 9);
        this.setData({
          'form.supplierChatScreenshotIds': ids,
          'form.supplierChatScreenshotUrls': urls
        });
      }))
      .catch(err => {
        console.error('upload supplier chat screenshots failed:', err);
        wx.showToast({ title: err.message || '截图上传失败', icon: 'none' });
      })
      .finally(() => wx.hideLoading());
  },

  previewSupplierChatScreenshots(e) {
    const urls = e.currentTarget.dataset.photos || [];
    if (urls.length) wx.previewImage({ current: e.currentTarget.dataset.current || urls[0], urls });
  },

  removeSupplierChatScreenshot(e) {
    const index = Number(e.currentTarget.dataset.index);
    const ids = [...(this.data.form.supplierChatScreenshotIds || [])];
    const urls = [...(this.data.form.supplierChatScreenshotUrls || [])];
    ids.splice(index, 1);
    urls.splice(index, 1);
    this.setData({
      'form.supplierChatScreenshotIds': ids,
      'form.supplierChatScreenshotUrls': urls
    });
  },

  updateRequestTotal() {
    const total = this.data.form.items.reduce((sum, item) => {
      return sum + Number(item.price || 0) * Number(item.quantity || 0);
    }, 0);
    this.setData({ requestTotal: total.toFixed(2) });
  },

  allocationTotal(item) {
    return (item?.storeAllocations || []).reduce((sum, allocation) => sum + Number(allocation.quantity || 0), 0);
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

  submitApplication() {
    if (this.data.purchaseQueryOnly) {
      wx.showToast({ title: '当前账号仅允许查询采购申请', icon: 'none' });
      return;
    }
    // setData 是异步刷新视图的，额外使用实例锁，确保快速连点不会进入第二次提交。
    if (this._purchaseSubmissionLocked || this.data.isSubmitting) return;
    const form = this.data.form;
    if (!form.supplierId) {
      wx.showToast({ title: '请选择供应商', icon: 'none' });
      return;
    }
    if (!form.productType) {
      wx.showToast({ title: '请选择货型', icon: 'none' });
      return;
    }
    if (!form.items.length) {
      wx.showToast({ title: '请添加商品', icon: 'none' });
      return;
    }

    if (!(form.supplierChatScreenshotIds || []).length) {
      wx.showToast({ title: '请上传供应商群喊货截图', icon: 'none' });
      return;
    }

    for (let index = 0; index < form.items.length; index += 1) {
      const item = form.items[index];
      const quantity = Number(item.quantity);
      const price = Number(item.price);
      if (!Number.isInteger(quantity) || quantity <= 0) {
        wx.showToast({ title: `第${index + 1}项数量不正确`, icon: 'none' });
        return;
      }
      if (!Number.isFinite(price) || price < 0) {
        wx.showToast({ title: `第${index + 1}项采购价不正确`, icon: 'none' });
        return;
      }
      if (!item.isUsedProduct && !item.productId) {
        wx.showToast({ title: '请选择普通商品后再提交', icon: 'none' });
        return;
      }
      if (item.isUsedProduct && (!String(item.productName || '').trim() || (item.directInbound && (!String(item.pnCode || '').trim() || quantity !== 1 || !String(item.directInboundSnCode || '').trim())))) {
        const message = item.directInbound && !String(item.pnCode || '').trim()
          ? '二手商品勾选审批完成及入库时必须填写PN码'
          : '二手商品资料不完整，或SN号/数量不符合要求';
        wx.showToast({ title: message, icon: 'none' });
        return;
      }
      const allocations = Array.isArray(item.storeAllocations) ? item.storeAllocations : [];
      if (!allocations.length) {
        wx.showToast({ title: `请为第${index + 1}项添加收货门店`, icon: 'none' });
        return;
      }
      let allocatedQuantity = 0;
      for (const allocation of allocations) {
        const allocationQuantity = Number(allocation.quantity);
        if (!allocation.storeId) {
          wx.showToast({ title: `请选择第${index + 1}项的收货门店`, icon: 'none' });
          return;
        }
        if (!Number.isInteger(allocationQuantity) || allocationQuantity <= 0) {
          wx.showToast({ title: `请填写第${index + 1}项各门店的分配数量`, icon: 'none' });
          return;
        }
        if (!allocation.locationId) {
          wx.showToast({ title: `请选择第${index + 1}项各门店的收货库位`, icon: 'none' });
          return;
        }
        allocatedQuantity += allocationQuantity;
      }
      if (allocatedQuantity !== quantity) {
        wx.showToast({ title: `第${index + 1}项门店分配数量必须等于采购数量`, icon: 'none' });
        return;
      }
    }

    const payload = {
      supplierId: form.supplierId,
      invoiceType: form.invoiceType,
      paymentMethod: form.paymentMethod,
      goodsTypeId: this.data.goodsTypes[form.productTypeIndex]?.goodsTypeId || '',
      productType: form.productType,
      remark: form.remark,
      // 同时保存文件 ID 和已解析的展示地址：ID 用于后续权限/存储处理，URL 用于审批中心直接展示。
      supplierChatScreenshotIds: form.supplierChatScreenshotIds,
      supplierChatScreenshotUrls: form.supplierChatScreenshotUrls,
      supplierChatScreenshotUrl: form.supplierChatScreenshotUrls[0] || form.supplierChatScreenshotIds[0] || '',
      supplier_chat_screenshot_ids: form.supplierChatScreenshotIds,
      supplier_chat_screenshot_urls: form.supplierChatScreenshotUrls,
      supplier_chat_screenshot_url: form.supplierChatScreenshotUrls[0] || form.supplierChatScreenshotIds[0] || '',
      rebateDeduction: 0,
      freightPlatformId: form.freightPlatformId || '',
      freightPlatformName: form.freightPlatformName || '',
      freightAmount: Number(form.freightAmount || 0),
      items: form.items.map(item => ({
        productId: item.productId,
        productName: item.productName,
        pnCode: item.pnCode || '',
        isUsedProduct: Boolean(item.isUsedProduct),
        directInbound: Boolean(item.directInbound),
        directInboundSnCode: item.directInboundSnCode || '',
        price: Number(item.price),
        quantity: Number(item.quantity),
        goodsTypeId: this.data.goodsTypes[form.productTypeIndex]?.goodsTypeId || '',
        productType: form.productType,
        selectedResourceTypes: item.selectedResourceTypes || [],
        rebateDeduction: 0,
        storeAllocations: item.storeAllocations.map(allocation => ({
          storeId: allocation.storeId,
          storeName: allocation.storeName,
          quantity: Number(allocation.quantity),
          locationId: allocation.locationId,
          locationName: allocation.locationName,
          locationAllocations: [{
            locationId: allocation.locationId,
            locationName: allocation.locationName,
            quantity: Number(allocation.quantity)
          }]
        }))
      }))
    };

    this._purchaseSubmissionLocked = true;
    this.setData({ isSubmitting: true });
    wx.showLoading({ title: '提交中' });
    api.purchase.create(payload).then(() => {
      wx.showToast({ title: '已进入采购审批流程', icon: 'success' });
      this.resetPurchaseForm();
      this.setData({ activeTab: 'list' });
      return this.loadMyRecords();
    }).catch(err => {
      console.error('create ANY-ERP purchase request failed:', err);
      wx.showToast({ title: err.message || '采购申请提交失败', icon: 'none' });
    }).finally(() => {
      wx.hideLoading();
      this._purchaseSubmissionLocked = false;
      this.setData({ isSubmitting: false });
    });
  },

  resetPurchaseForm() {
    this.setData({
      productKeyword: '',
      supplierKeyword: '',
      productList: [],
      showSupplierModal: false,
      showProductModal: false,
      activeTab: 'create',
      usedProduct: emptyUsedProduct(),
      requestTotal: '0.00',
      form: {
        supplierIndex: -1,
        supplierId: '',
        supplierName: '',
        invoiceTypeIndex: 2,
        invoiceType: INVOICE_TYPES[2],
        paymentMethodIndex: 0,
        paymentMethod: 'COMPANY_CREDIT',
        freightPlatformId: '',
        freightPlatformName: '',
        freightAmount: '',
        productTypeIndex: this.data.goodsTypes.length ? 0 : -1,
        productType: this.data.goodsTypes[0]?.name || '',
        remark: '',
        supplierChatScreenshotIds: [],
        supplierChatScreenshotUrls: [],
        items: []
      }
    });
  },

  loadApplications() {
    this.setData({ isLoading: true });
    return api.purchase.list({ scope: 'my', page: 1, pageSize: 100 }).then(result => {
      const statusMap = {
        pending: '待审批', approved: '已通过', rejected: '已拒绝',
        purchased: '已采购', partial: '部分入库', partially_received: '部分入库',
        completed: '已完成', received: '已完成', revoked: '已撤销', cancelled: '已取消'
      };
      const applications = listOf(result).map(item => ({
        requestId: item.request_id || item.requestId || item.id || '',
        requestNo: item.request_no || item.requestNo || '',
        storeName: item.store_name || item.storeName || '',
        supplierName: item.supplier_name || item.supplierName || '',
        invoiceType: item.invoice_type || item.invoiceType || '',
        paymentMethod: item.payment_method || item.paymentMethod || 'COMPANY_CREDIT',
        paymentMethodText: (item.payment_method || item.paymentMethod) === 'PERSONAL_ADVANCE' ? '个人垫付' : '公司账期',
        productType: item.product_type || item.productType || item.items?.[0]?.product_type || '',
        itemsSummary: item.items_summary || item.itemsSummary || '',
        totalAmount: Number(item.total_amount || item.totalAmount || 0).toFixed(2),
        status: item.status || '',
        statusText: statusMap[item.status] || item.status || '-',
        createTime: this.formatTime(item.create_time || item.createTime)
      }));
      this.setData({ applications, isLoading: false });
    }).catch(err => {
      console.error('load ANY-ERP purchase requests failed:', err);
      this.setData({ applications: [], isLoading: false });
      wx.showToast({ title: err.message || '采购申请加载失败', icon: 'none' });
    });
  },

  switchRecordFilter(e) {
    const recordFilter = e.currentTarget.dataset.filter || 'all';
    const filteredMyRecords = recordFilter === 'all'
      ? this.data.myRecords
      : this.data.myRecords.filter(item => item.type === recordFilter);
    this.setData({ recordFilter, filteredMyRecords, recordPage: 1 }, () => this.updateRecordPage());
  },

  changeRecordPage(e) {
    const delta = Number(e.currentTarget.dataset.delta || 0);
    this.updateRecordPage(this.data.recordPage + delta);
  },

  revokeRecord(e) {
    const recordKey = e.currentTarget.dataset.key;
    const record = this.data.myRecords.find(item => item.recordKey === recordKey);
    if (!record || !record.canRevoke || this.data.revokingRecordKey) return;

    const content = record.type === 'purchase'
      ? '确认撤销这条采购申请？系统会同步处理未入库单，并对已生成的结算单做冲销。已入库的采购无法撤销。'
      : record.type === 'expense'
        ? '确认撤销这条报销申请？撤销后将停止后续审批、结算或付款处理。'
        : '确认撤销这条新建商品申请？撤销后将停止后续审批处理。';

    wx.showModal({
      title: '确认撤销申请',
      content,
      confirmText: '确认撤销',
      confirmColor: '#d93025',
      success: result => {
        if (result.confirm) this.performRevoke(record);
      }
    });
  },

  openRecordDetail(e) {
    const recordKey = e.currentTarget.dataset.key;
    const record = this.data.myRecords.find(item => item.recordKey === recordKey)
      || this.data.productApplications.find(item => item.recordKey === recordKey);
    if (!record || !record.recordId) return;
    wx.navigateTo({
      url: `/pages/application-detail/application-detail?type=${encodeURIComponent(record.type)}&id=${encodeURIComponent(record.recordId)}`
    });
  },

  performRevoke(record) {
    let request;
    const payload = { reason: '申请人撤销', source: 'mini_program', cascade: true };
    if (record.type === 'purchase') request = api.purchase.revoke(record.recordId, payload);
    if (record.type === 'product') request = api.product.revokeApplication(record.recordId, payload);
    if (record.type === 'expense') request = api.expense.revoke(record.recordId, payload);
    if (!request) return;

    this.setData({ revokingRecordKey: record.recordKey });
    wx.showLoading({ title: '撤销处理中' });
    request.then(result => {
      wx.showToast({ title: result?.message || '申请已撤销', icon: 'success' });
      return Promise.all([
        this.loadMyRecords(),
        record.type === 'product' ? this.loadProductApplications() : Promise.resolve()
      ]);
    }).catch(err => {
      const message = Number(err.statusCode) === 404 ? '后台暂未部署该类申请的撤销接口' : (err.message || '撤销失败');
      wx.showToast({ title: message, icon: 'none' });
    }).finally(() => {
      wx.hideLoading();
      this.setData({ revokingRecordKey: '' });
    });
  },

  updateRecordPage(page = this.data.recordPage) {
    const records = this.data.filteredMyRecords || [];
    const pageCount = Math.ceil(records.length / this.data.recordPageSize);
    const recordPage = pageCount ? Math.min(Math.max(1, page), pageCount) : 1;
    const start = (recordPage - 1) * this.data.recordPageSize;
    this.setData({
      pagedMyRecords: records.slice(start, start + this.data.recordPageSize),
      recordPage,
      recordPageCount: pageCount
    });
  },

  loadMyRecords() {
    this.setData({ isMyRecordsLoading: true });
    const safeRequest = (request, type) => request.catch(err => {
      console.warn(`load my ${type} records failed:`, err);
      return [];
    });
    const purchaseRequest = safeRequest(api.purchase.list({ scope: 'my', page: 1, pageSize: 100 })
      .then(result => listOf(result).map(item => normalizeWorkflowRecord('purchase', item))
        .map(record => this.data.purchaseQueryOnly ? Object.assign({}, record, { canRevoke: false }) : record)), 'purchase');
    const productRequest = this.data.purchaseQueryOnly
      ? Promise.resolve([])
      : safeRequest(api.product.getApplications({ scope: 'my', page: 1, pageSize: 100 })
        .then(result => listOf(result).map(item => normalizeWorkflowRecord('product', item))), 'product');
    const expenseRequest = this.data.purchaseQueryOnly
      ? Promise.resolve([])
      : safeRequest(api.expense.list({ scope: 'my', page: 1, pageSize: 100 })
        .then(result => listOf(result).map(item => normalizeWorkflowRecord('expense', item))), 'expense');

    return Promise.all([purchaseRequest, productRequest, expenseRequest]).then(groups => {
      const myRecords = groups.reduce((all, group) => all.concat(group), []).sort((a, b) => {
        const aTime = parseDateValue(a.sortTime || a.createTime) || 0;
        const bTime = parseDateValue(b.sortTime || b.createTime) || 0;
        return bTime - aTime;
      });
      const filteredMyRecords = this.data.recordFilter === 'all'
        ? myRecords
        : myRecords.filter(item => item.type === this.data.recordFilter);
      this.setData({ myRecords, filteredMyRecords, isMyRecordsLoading: false }, () => this.updateRecordPage(1));
    }).catch(err => {
      console.error('load my workflow records failed:', err);
      this.setData({ myRecords: [], filteredMyRecords: [], isMyRecordsLoading: false });
      wx.showToast({ title: err.message || '我的申请加载失败', icon: 'none' });
    });
  },

  loadCategories() {
    return api.product.getCategoryTree().then(result => {
      const tree = Array.isArray(result) ? result : (result.data || []);
      const categoryOptions = [];
      const walk = (nodes, level) => (nodes || []).forEach(node => {
        categoryOptions.push({
          categoryId: node.category_id || node.categoryId || node.id || '',
          name: node.name || '',
          displayName: `${level ? '　'.repeat(level) : ''}${node.name || ''}`
        });
        walk(node.children, level + 1);
      });
      walk(tree, 0);
      this.setData({ categoryOptions });
    }).catch(err => {
      console.error('load ANY-ERP product categories failed:', err);
      wx.showToast({ title: err.message || '商品分类加载失败', icon: 'none' });
    });
  },

  onCategoryChange(e) {
    const index = Number(e.detail.value);
    const category = this.data.categoryOptions[index] || {};
    this.setData({
      'newProduct.categoryIndex': index,
      'newProduct.categoryId': category.categoryId || '',
      'newProduct.categoryName': category.name || '',
      'newProduct.attributes': {},
      categoryFields: [],
      computedProductName: ''
    });
    if (!category.categoryId) return;
    api.product.getCategoryFieldConfig(category.categoryId).then(result => {
      const data = result && result.data ? result.data : result;
      const categoryFields = (data.fields || []).map(field => ({
        fieldKey: field.field_key || field.fieldKey,
        fieldLabel: field.field_label || field.fieldLabel || field.field_key,
        fieldType: field.field_type || field.fieldType || 'text',
        placeholder: field.placeholder || '',
        required: Boolean(field.required),
        options: field.options || []
      }));
      this.setData({ categoryFields });
      this.updateComputedProductName();
    }).catch(err => {
      console.error('load category fields failed:', err);
      wx.showToast({ title: '分类字段加载失败', icon: 'none' });
    });
  },

  onAttributeInput(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ [`newProduct.attributes.${key}`]: e.detail.value });
    this.updateComputedProductName();
  },

  onAttributeSelect(e) {
    const fieldIndex = Number(e.currentTarget.dataset.index);
    const field = this.data.categoryFields[fieldIndex] || {};
    const value = (field.options || [])[Number(e.detail.value)] || '';
    this.setData({ [`newProduct.attributes.${field.fieldKey}`]: value });
    this.updateComputedProductName();
  },

  updateComputedProductName() {
    const attributes = this.data.newProduct.attributes || {};
    const composedName = this.data.categoryFields
      .map(field => attributes[field.fieldKey])
      .filter(Boolean)
      .join(' ');
    const computedProductName = composedName || (this.data.newProduct.manualName || '').trim();
    this.setData({ computedProductName });
  },

  onNewProductInput(e) {
    const field = e.currentTarget.dataset.field;
    const value = field === 'pnCode' ? normalizePnCode(e.detail.value) : e.detail.value;
    this.setData({ [`newProduct.${field}`]: value }, () => {
      if (field === 'manualName') this.updateComputedProductName();
    });
  },

  onNewProductSwitch(e) {
    this.setData({ [`newProduct.${e.currentTarget.dataset.field}`]: e.detail.value });
  },

  chooseLabelPhotos() {
    const current = this.data.newProduct.labelPhotoIds || [];
    const count = 9 - current.length;
    if (count <= 0) {
      wx.showToast({ title: '最多上传9张标签照片', icon: 'none' });
      return;
    }

    imageUpload.chooseImages({
      count,
      sourceType: ['camera', 'album'],
      success: paths => this.uploadLabelPhotos(paths),
      fail: err => {
        if (!err || !String(err.errMsg || '').toLowerCase().includes('cancel')) {
          wx.showToast({ title: '选择标签照片失败', icon: 'none' });
        }
      }
    });
  },

  uploadLabelPhotos(paths) {
    if (!paths.length) return;
    wx.showLoading({ title: '标签照片上传中...' });
    imageUpload.uploadImages(paths, 'product-label-photos')
      .then(fileIds => imageUpload.resolveImageUrls(fileIds).then(photoUrls => {
        const ids = [...(this.data.newProduct.labelPhotoIds || []), ...fileIds].slice(0, 9);
        const urls = [...(this.data.newProduct.labelPhotoUrls || []), ...photoUrls].slice(0, 9);
        this.setData({
          'newProduct.labelPhotoIds': ids,
          'newProduct.labelPhotoUrls': urls
        });
      }))
      .catch(err => {
        console.error('upload product label photos failed:', err);
        wx.showToast({ title: err.message || '标签照片上传失败', icon: 'none' });
      })
      .finally(() => wx.hideLoading());
  },

  previewLabelPhotos(e) {
    const urls = e.currentTarget.dataset.photos || [];
    if (urls.length) wx.previewImage({ current: e.currentTarget.dataset.current || urls[0], urls });
  },

  removeLabelPhoto(e) {
    const index = Number(e.currentTarget.dataset.index);
    const ids = [...(this.data.newProduct.labelPhotoIds || [])];
    const urls = [...(this.data.newProduct.labelPhotoUrls || [])];
    ids.splice(index, 1);
    urls.splice(index, 1);
    this.setData({
      'newProduct.labelPhotoIds': ids,
      'newProduct.labelPhotoUrls': urls
    });
  },

  saveNewProduct() {
    if (this.data.purchaseQueryOnly) {
      wx.showToast({ title: '当前账号仅允许查询采购申请', icon: 'none' });
      return;
    }
    if (this._productSubmissionLocked || this.data.isSavingProduct) return;
    const form = this.data.newProduct;
    const name = this.data.computedProductName;
    if (!form.categoryId) {
      wx.showToast({ title: '请选择商品分类', icon: 'none' });
      return;
    }
    const missing = this.data.categoryFields.find(field => field.required && !form.attributes[field.fieldKey]);
    if (missing) {
      wx.showToast({ title: `请填写${missing.fieldLabel}`, icon: 'none' });
      return;
    }
    if (!name) {
      wx.showToast({ title: '请填写商品名称组合字段', icon: 'none' });
      return;
    }
    const pnCode = normalizePnCode(form.pnCode);
    if (!pnCode) {
      wx.showToast({ title: '请填写PN码', icon: 'none' });
      return;
    }

    if (!(form.labelPhotoIds || []).length) {
      wx.showToast({ title: '请拍照上传商品标签页面', icon: 'none' });
      return;
    }

    const attributes = {};
    Object.keys(form.attributes || {}).forEach(key => {
      if (form.attributes[key] !== '') attributes[key] = form.attributes[key];
    });
    const payload = {
      name,
      categoryId: form.categoryId,
      config: (form.config || '').trim(),
      unit: (form.unit || '台').trim(),
      needSn: form.needSn ? 1 : 0,
      needImei: form.needImei ? 1 : 0,
      remark: (form.remark || '').trim(),
      status: 1,
      pnCode,
      barcodes: [{ type: 'manufacturer', code: pnCode }],
      labelPhotoUrls: form.labelPhotoIds,
      labelPhotoUrl: form.labelPhotoIds[0] || '',
      labelPhotoIds: form.labelPhotoIds,
      attributes: Object.keys(attributes).length ? attributes : null
    };

    this._productSubmissionLocked = true;
    this.setData({ isSavingProduct: true });
    wx.showLoading({ title: '新建商品中' });
    api.product.create(payload).then(() => {
      wx.showToast({ title: '商品申请已提交', icon: 'success' });
      this.setData({
        newProduct: emptyNewProduct(),
        categoryFields: [],
        computedProductName: '',
        activeTab: 'product'
      });
      return this.loadProductApplications();
    }).catch(err => {
      console.error('create ANY-ERP product failed:', err);
      wx.showToast({ title: err.message || '新建商品失败', icon: 'none' });
    }).finally(() => {
      wx.hideLoading();
      this._productSubmissionLocked = false;
      this.setData({ isSavingProduct: false });
    });
  },

  loadProductApplications() {
    return api.product.getApplications({ scope: 'my', page: 1, pageSize: 100 }).then(result => {
      const statusMap = { pending: '待审批', approved: '已通过', rejected: '已拒绝', revoked: '已撤销' };
      const productApplications = listOf(result).map(item => ({
        applicationId: item.application_id || item.applicationId || '',
        recordKey: `product:${item.application_id || item.applicationId || ''}`,
        applicationNo: item.application_no || item.applicationNo || '',
        productName: item.product_name || item.productName || '',
        categoryName: item.category_name || item.categoryName || '',
        applicantName: item.applicant_name || item.applicantName || '',
        status: item.status || '',
        statusText: statusMap[item.status] || item.status || '-',
        currentStage: item.current_stage_name || item.currentStageName || item.current_stage || item.currentStage || item.stage_text || item.stageText || ({ pending: '商品审批', approved: '已进入商品库', rejected: '已结束', revoked: '已结束' }[item.status] || '-'),
        canRevoke: item.can_revoke !== undefined ? isTruthy(item.can_revoke) : item.status === 'pending',
        reviewUserName: item.review_user_name || item.reviewUserName || '',
        reviewComment: item.review_comment || item.reviewComment || '',
        productId: item.product_id || item.productId || '',
        createTime: this.formatTime(item.create_time || item.createTime)
      }));
      this.setData({ productApplications });
    }).catch(err => {
      console.error('load ANY-ERP product applications failed:', err);
      wx.showToast({ title: err.message || '商品申请加载失败', icon: 'none' });
    });
  },

  formatTime(value) {
    if (!value) return '';
    const timestamp = parseDateValue(value);
    if (Number.isNaN(timestamp)) return String(value);
    const date = new Date(timestamp);
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
});
