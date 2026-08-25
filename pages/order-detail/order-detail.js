// pages/order-detail/order-detail.js
const userUtils = require('../profile/user-utils.js');
const DataStorage = require('../../utils/storage.js');
const api = require('../../utils/api.js');
const imageUpload = require('../../utils/image-upload.js');
const { normalizeEditableOrderItem, normalizeSnCode, normalizeId, getEffectiveSnSalePrice, isEmptyOrderItem } = require('../../utils/model.js');
const { calculateOrderProfit } = require('../../utils/order-profit.js');
require('../../utils/cloud-adapter.js').install();

Page({
  /**
   * 页面的初始数据
   */
  data: {
    // 订单基础信息
    order: {},
    orderNo: '',

    // 编辑权限
    canEdit: false,
    canEditSpecialFields: false,  // 特殊字段编辑权限（国补人信息、照片、开票信息归档后可编辑）
    canOperate: false,
    isSaving: false,

    // 客户信息
    customerSources: [],
    customerSourceIndex: 0,
    customerSourceLevel1List: [],
    customerSourceLevel2List: [],
    customerSourceLevel1Index: 0,
    customerSourceLevel2Index: 0,

    // 商品列表
    goodsList: [],

    // 金额信息
    totalAmount: '0.00',
    discount: '0.00',
    nationalSubsidy: '0.00',
    computerAmount: '',
    mobileAmount: '',
    educationSubsidy: '0.00',
    actualAmount: '0.00',
    differenceAmount: '0.00',
    depositItems: [],
    depositDeductionTotal: '0.00',

    // 收款信息
    paymentMethodOptions: [],
    paymentMethodIndex: [],
    paymentMethods: [],
    paymentTotal: '0.00',

    // 辅助销售人
    auxiliarySalesOptions: [],
    auxiliarySalesIndex: [],
    auxiliarySalesList: [],

    // 开票信息
    invoiceOptions: ['不开票', '开专票', '开普票'],
    invoiceStatus: '不开票',
    invoiceInfo: '',
    invoiceAmount: '',

    // 国补信息
    subsidyStatus: '非国补',
    subsidyOptions: ['国补', '非国补'],
    subsidyPerson: '',
    subsidyId: '',
    subsidyPhotos: [
      { url: '', name: '产品及包装盒' },
      { url: '', name: '包装盒+开机SN' },
      { url: '', name: '能效标识' },
      { url: '', name: '底壳包装盒' },
      { url: '', name: '国补小票' },
      { url: '', name: 'ID照片（重庆）' },
      { url: '', name: '水印合影（重庆）' }
    ],
    hasSubsidyPhotos: false,

    // 商品图片
    productPhotoUrls: [],
    productPhotoDisplayUrls: [],
    // 教育补贴核销凭证
    educationSubsidyPhotoUrl: '',
    educationSubsidyPhotoDisplayUrl: '',
    educationSubsidyCouponCode: '',
    // 个人资料照片
    personalInfoPhoto: { url: '', name: '个人资料' },

    // 补录记录
    supplements: [],
    supplementTotal: 0,

    // 归档相关
    isArchived: false,
    orderStatusLabel: '',
    showArchiveModal: false,
    archiveNeedsApproval: false,
    grossProfit: null,
    minimumSalePriceTotal: 0,

    // 原始数据（用于比较变更）
    originalData: null,

    // 商品选择弹窗
    showGoodsSelectModal: false,
    goodsSelectList: [],
    goodsSelectIndex: 0,
    goodsSelectPage: 1,
    goodsSelectPageSize: 10,
    goodsSelectHasMore: false,
    goodsSelectLoading: false,
    goodsSelectKeywords: [],
    showSnListModal: false,
    snListModalIndex: 0,
    snListModalItems: [],

    // 部分退单
    showReturnModal: false,
    returnItems: [],
    returnAmount: '0.00',
    returnCustomerAmount: '0.00',
    returnPolicyAmount: '0.00',
    returnNationalSubsidyAmount: '0.00',
    returnGovSubsidy: false,
    returnGovSubsidyAvailable: false,
    returnReason: '客户部分退单',
    returnSubmitting: false,
    returnPending: false
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: function (options) {
    // 检查用户授权
    if (!userUtils.isAuthorized()) {
      wx.showToast({
        title: '您未授权使用此功能',
        icon: 'none'
      });
      setTimeout(() => {
        wx.navigateBack();
      }, 1500);
      return;
    }

    // 获取订单号
    const orderNo = options.orderNo;
    this._openReturnAfterLoad = options.returnMode === '1' || options.returnMode === 'return';
    if (!orderNo) {
      wx.showToast({
        title: '订单号无效',
        icon: 'none'
      });
      setTimeout(() => {
        wx.navigateBack();
      }, 1500);
      return;
    }

    this.setData({ orderNo });

    const that = this;
    
    // 加载基础数据，完成后再加载订单详情
    this.loadBaseData(function() {
      that.loadOrderDetail(orderNo);
    });
  },

  /**
   * 加载基础数据（客户来源、收款方式等）
   */
  loadBaseData: function (callback) {
    const DataStorage = require('../../utils/storage.js');
    let completionCount = 0;
    const checkComplete = () => {
      completionCount++;
      if (completionCount >= 3 && callback) {
        callback();
      }
    };
    
    DataStorage.getCustomerSources(
      (sources) => {
        const level1Sources = sources.filter(s => Number(s.level || 1) === 1);
        const level2Sources = sources.filter(s => Number(s.level || 0) === 2);
        const level1Names = level1Sources.map(s => s.name);
        
        const level2SourcesMap = {};
        level2Sources.forEach(s => {
          const parentId = String(s.parentId || s.parent_id || s.parentSourceId || s.parent_source_id || '');
          if (!level2SourcesMap[parentId]) {
            level2SourcesMap[parentId] = [];
          }
          level2SourcesMap[parentId].push(s);
        });

        this.setData({
          customerSources: level1Names,
          customerSourceLevel1List: level1Names,
          level1SourcesData: level1Sources,
          level2SourcesMap: level2SourcesMap
        });
        checkComplete();
      },
      (err) => {
        console.error('获取客户来源失败:', err);
        this.setData({
          customerSources: ['线上', '线下', '老客户介绍', '其他'],
          customerSourceLevel1List: ['线上', '线下', '老客户介绍', '其他']
        });
        checkComplete();
      }
    );

    DataStorage.getPaymentMethods(
      (methods) => {
        const paymentMethodNames = methods
          .map(method => method.name)
          .filter(name => !this.isDepositPayment(name));
        this.setData({ paymentMethodOptions: paymentMethodNames });
        checkComplete();
      },
      (err) => {
        console.error('获取收款方式失败:', err);
        this.setData({
          paymentMethodOptions: ['二维码', '国补POS', '智店通POS', '现金', '对公转账', 'OMO支付']
        });
        checkComplete();
      }
    );

    this.loadStaffList(checkComplete);
  },

  /**
   * 加载门店店员信息
   */
  loadStaffList: function (callback) {
    const currentStoreId = this.getCurrentStoreContext().storeId;
    const currentUserInfo = userUtils.getUserInfo() || {};
    const localDistributorInfo = wx.getStorageSync('distributorInfo') || {};
    const tempStoreInfo = wx.getStorageSync('tempStoreInfo') || {};
    const distributorId = currentUserInfo.distributorId || localDistributorInfo.distributorId || localDistributorInfo.id || localDistributorInfo._id || '';
    const currentName = currentUserInfo.userName || currentUserInfo.name || '';
    const currentPhone = currentUserInfo.phone || currentUserInfo.phoneNumber || '';
    const currentRegionIds = new Set(
      []
        .concat(currentUserInfo.regionId || [], currentUserInfo.regionCodes || [], tempStoreInfo.regionId || tempStoreInfo.region_id || [])
        .filter(Boolean)
        .map(String)
    );
    const currentRegionNames = new Set(
      [currentUserInfo.regionName, tempStoreInfo.regionName, tempStoreInfo.region_name]
        .filter(Boolean)
        .map(String)
    );

    const applyStaffList = (sourceList) => {
      const staffList = (sourceList || []).map((staff, index) => ({
        staffId: staff.staffId || staff.staff_id || staff.id || staff._id || '',
        name: String(staff.name || staff.userName || staff.phone || '').trim(),
        phone: staff.phone || staff.phoneNumber || '',
        storeId: staff.storeId || staff.store_id || '',
        storeName: staff.storeName || staff.store_name || '',
        regionId: staff.regionId || staff.region_id || '',
        regionName: staff.regionName || staff.region_name || '',
        regionCodes: staff.regionCodes || staff.region_codes || [],
        originalIndex: index
      })).filter(staff => staff.name);

      if (currentName && !staffList.some(staff => {
        return (currentPhone && staff.phone === currentPhone) ||
          (staff.name === currentName && String(staff.storeId || '') === String(currentStoreId || ''));
      })) {
        staffList.push({
          staffId: currentUserInfo.staffId || currentUserInfo.id || currentUserInfo._id || '',
          name: currentName,
          phone: currentPhone,
          storeId: currentStoreId,
          storeName: currentUserInfo.storeName || tempStoreInfo.storeName || tempStoreInfo.name || '',
          regionId: currentUserInfo.regionId || tempStoreInfo.regionId || tempStoreInfo.region_id || '',
          regionName: currentUserInfo.regionName || tempStoreInfo.regionName || tempStoreInfo.region_name || '',
          regionCodes: currentUserInfo.regionCodes || [],
          originalIndex: staffList.length
        });
      }

      staffList.forEach(staff => {
        if (String(staff.storeId || '') === String(currentStoreId || '')) {
          if (staff.regionId) currentRegionIds.add(String(staff.regionId));
          (staff.regionCodes || []).filter(Boolean).forEach(code => currentRegionIds.add(String(code)));
          if (staff.regionName) currentRegionNames.add(String(staff.regionName));
        }
      });

      const getPriority = (staff) => {
        if (currentStoreId && String(staff.storeId || '') === String(currentStoreId)) return 0;
        const staffRegionIds = []
          .concat(staff.regionId || [], staff.regionCodes || [])
          .filter(Boolean)
          .map(String);
        if (
          staffRegionIds.some(regionId => currentRegionIds.has(regionId)) ||
          (staff.regionName && currentRegionNames.has(String(staff.regionName)))
        ) {
          return 1;
        }
        return 2;
      };

      staffList.sort((a, b) => {
        const priorityDifference = getPriority(a) - getPriority(b);
        if (priorityDifference !== 0) return priorityDifference;
        const storeDifference = String(a.storeName || '').localeCompare(String(b.storeName || ''), 'zh-CN');
        if (storeDifference !== 0) return storeDifference;
        const nameDifference = a.name.localeCompare(b.name, 'zh-CN');
        return nameDifference !== 0 ? nameDifference : a.originalIndex - b.originalIndex;
      });

      const nameCounts = staffList.reduce((counts, staff) => {
        counts[staff.name] = (counts[staff.name] || 0) + 1;
        return counts;
      }, {});
      staffList.forEach(staff => {
        const location = staff.storeName || staff.regionName || '未分配门店';
        const phoneSuffix = staff.phone ? ` · ${String(staff.phone).slice(-4)}` : '';
        const suffix = `${location}${phoneSuffix}`;
        staff.displayName = nameCounts[staff.name] > 1 ? `${staff.name}（${suffix}）` : staff.name;
      });

      this._auxiliarySalesStaffOptions = [null].concat(staffList);
      this.setData({
        auxiliarySalesOptions: ['无'].concat(staffList.map(staff => staff.displayName))
      });
      if (callback) callback();
    };

    DataStorage.getAllStaffByDistributor(distributorId, applyStaffList, (err) => {
      console.error('获取辅助销售人列表失败:', err);
      applyStaffList([]);
    });
  },

  /**
   * 加载订单详情
   */
  loadOrderDetail: function (orderNo) {
    wx.showLoading({ title: '加载中...' });

    // 订单详情统一使用后台 API：先按订单号查询，再使用详情接口获取完整照片字段。
    api.order.queryList({ orderNo, page: 1, pageSize: 1 }).then(listResult => {
      const summary = listResult.data && listResult.data[0];
      if (!summary) return null;
      return api.order.getDetails(summary.orderId || summary.order_id || summary._id);
    }).then(orderData => {
      wx.hideLoading();

      if (orderData) {
        const order = this.processOrderData(this.applyLocalOrderOverride(orderData));
        this.initPageData(order);
        this.refreshPhotoDisplayUrls();
        if (this._openReturnAfterLoad) {
          this._openReturnAfterLoad = false;
          setTimeout(() => this.openReturnModal(), 120);
        }
      } else {
        wx.showToast({
          title: '订单不存在或已删除',
          icon: 'none'
        });
        setTimeout(() => {
          wx.navigateBack();
        }, 1500);
      }
    }).catch(err => {
      wx.hideLoading();
      console.error('加载订单详情失败:', err);
      wx.showToast({
        title: '加载失败，请重试',
        icon: 'none'
      });
    });
  },

  getLocalOrderOverrides: function () {
    return wx.getStorageSync('orderLocalOverrides') || {};
  },

  applyLocalOrderOverride: function (order) {
    if (!order || !order.orderNo) return order;
    const overrides = this.getLocalOrderOverrides();
    return Object.assign({}, order, overrides[order.orderNo] || {});
  },

  getCurrentStoreContext: function () {
    const tempStoreInfo = wx.getStorageSync('tempStoreInfo') || {};
    const userInfo = userUtils.getUserInfo() || {};
    const storeScoped = userUtils.isStoreScoped(userInfo);
    const storeId = storeScoped ? (tempStoreInfo.storeId || tempStoreInfo.store_id || tempStoreInfo.id || tempStoreInfo._id || userInfo.storeId || '') : '';
    const storeName = storeScoped ? (tempStoreInfo.storeName || tempStoreInfo.store_name || tempStoreInfo.name || userInfo.storeName || '') : '';
    return { storeId, storeName, userInfo };
  },

  saveLocalOrderOverride: function (orderNo, data) {
    if (!orderNo) return;
    const overrides = this.getLocalOrderOverrides();
    overrides[orderNo] = Object.assign({}, overrides[orderNo] || {}, data, {
      orderNo: orderNo,
      localUpdateTime: Date.now()
    });
    wx.setStorageSync('orderLocalOverrides', overrides);
  },

  /**
   * 处理订单数据
   */
  processOrderData: function (order) {
    // 格式化时间
    let createTime = order.createTime;
    let timestamp = createTime;

    try {
      if (typeof timestamp === 'string') {
        if (/^\d+$/.test(timestamp)) {
          timestamp = parseInt(timestamp);
        } else {
          const parsedDate = new Date(timestamp);
          if (!isNaN(parsedDate.getTime())) {
            order.createTimeFormat = `${parsedDate.getFullYear()}-${(parsedDate.getMonth() + 1).toString().padStart(2, '0')}-${parsedDate.getDate().toString().padStart(2, '0')} ${parsedDate.getHours().toString().padStart(2, '0')}:${parsedDate.getMinutes().toString().padStart(2, '0')}`;
          }
        }
      }

      if (typeof timestamp === 'number' && timestamp > 0) {
        if (timestamp < 10000000000) {
          timestamp = timestamp * 1000;
        }
        const date = new Date(timestamp);
        if (!isNaN(date.getTime()) && date.getFullYear() > 1970) {
          order.createTimeFormat = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
        }
      }
    } catch (error) {
      order.createTimeFormat = '未知时间';
    }

    // 字段兼容处理
    if (typeof order.discount === 'undefined' && typeof order.discountAmount !== 'undefined') {
      order.discount = order.discountAmount;
    }
    if (typeof order.actualAmount === 'undefined' && typeof order.actualPayment !== 'undefined') {
      order.actualAmount = order.actualPayment;
    }
    if (!order.customerSource && order.source) {
      order.customerSource = order.source;
    }
    order.customerSource = order.customerSource || order.customer_source || '';
    order.customerSourceDetail = order.customerSourceDetail ||
      order.customer_source_detail ||
      order.sourceDetail ||
      order.source_detail ||
      order.secondarySource ||
      order.secondary_source ||
      order.secondSource ||
      order.second_source ||
      order.sourceDetailName ||
      order.source_detail_name ||
      '';
    if (!order.contactName && order.customerName) {
      order.contactName = order.customerName;
    }
    order.contactName = order.contactName || order.customer_name || '';
    if (!order.contactMethod && order.customerPhone) {
      order.contactMethod = order.customerPhone;
    }
    order.contactMethod = order.contactMethod || order.customer_phone || '';
    order.invoiceStatus = order.invoiceStatus || order.invoice_status || '不开票';
    order.invoiceInfo = order.invoiceInfo || order.invoice_info || '';
    order.invoiceAmount = order.invoiceAmount || order.invoice_amount || '';

    // 商品列表兼容
    let goodsList = order.items || order.goods || [];
    goodsList = goodsList.map(item => this.normalizeEditableGoodsItem(item));
    order.goodsList = goodsList;

    const depositItems = (order.depositItems || order.deposits || [])
      .map(item => this.normalizeDepositItem(item));
    let paymentMethods = (order.paymentMethods || order.payments || [])
      .map(method => this.normalizePaymentMethod(method));
    paymentMethods = this.expandGuobuPaymentMethods(paymentMethods, order.nationalSubsidy);
    paymentMethods = this.appendDepositPaymentMethods(paymentMethods, depositItems);
    if (paymentMethods.length === 0) {
      paymentMethods = [{ type: '', amount: '' }];
    }
    order.paymentMethods = paymentMethods;
    order.depositItems = depositItems;
    const guobuPaymentAmount = this.getGuobuPaymentAmount(paymentMethods);

    // 辅助销售人
    let auxiliarySalesList = order.auxiliarySalesList || [];
    auxiliarySalesList = auxiliarySalesList.map(item => ({
      selected: item.selected || item.name || item.userName || '无',
      selectedDisplay: item.selectedDisplay || item.selected_display || item.selected || item.name || item.userName || '无',
      optionIndex: Number(item.optionIndex || item.option_index || 0),
      profitAmount: (item.profitAmount || 0).toString(),
      ratio: item.ratio || 0,
      staffId: item.staffId || item.staff_id || '',
      phone: item.phone || item.phoneNumber || '',
      storeId: item.storeId || item.store_id || '',
      storeName: item.storeName || item.store_name || '',
      regionId: item.regionId || item.region_id || ''
    }));
    order.auxiliarySalesList = auxiliarySalesList;

    // 默认值处理
    order.discount = (order.discount || 0).toString();
    order.nationalSubsidy = (order.nationalSubsidy || 0).toString();
    const paymentComputerAmount = paymentMethods
      .filter(p => String(p.type || '').indexOf('国补POS（电脑）') === 0)
      .reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    const paymentMobileAmount = paymentMethods
      .filter(p => String(p.type || '').indexOf('国补POS（手机平板）') === 0)
      .reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    order.computerAmount = (order.computerAmount || order.computer_amount || paymentComputerAmount || '').toString();
    order.mobileAmount = (order.mobileAmount || order.mobile_amount || paymentMobileAmount || '').toString();
    order.educationSubsidy = (order.educationSubsidy || 0).toString();
    order.actualAmount = (order.actualAmount || 0).toString();
    order.totalAmount = (order.totalAmount || 0).toString();
    order.subsidyStatus = order.subsidyStatus || order.subsidy_status || '';
    const hasGuobuInfo = guobuPaymentAmount > 0 ||
      parseFloat(order.nationalSubsidy) > 0 ||
      order.subsidyPerson ||
      order.subsidy_person ||
      order.subsidy_id ||
      order.subsidyId;
    if (hasGuobuInfo) {
      order.subsidyStatus = '国补';
    }
    order.subsidyStatus = order.subsidyStatus || '非国补';
    order.subsidyPerson = order.subsidyPerson || order.subsidy_person || '';
    order.subsidyId = order.subsidyId || order.subsidy_id || '';
    if (order.subsidyStatus === '国补') {
      order.subsidyPerson = order.subsidyPerson || order.contactName || '';
      order.subsidyId = order.subsidyId || order.contactMethod || '';
      if (!order.invoiceAmount && (guobuPaymentAmount > 0 || (parseFloat(order.nationalSubsidy) || 0) > 0)) {
        const originalGuobuAmount = (parseFloat(order.computerAmount) || 0) + (parseFloat(order.mobileAmount) || 0);
        order.invoiceAmount = (originalGuobuAmount > 0 ? originalGuobuAmount : (parseFloat(order.actualAmount) || 0)).toFixed(2);
      }
    }

    // 国补照片（与新建订单保持一致的7个固定位置）
    const defaultSubsidyPhotos = [
      { url: '', name: '产品及包装盒' },
      { url: '', name: '包装盒+开机SN' },
      { url: '', name: '能效标识' },
      { url: '', name: '底壳包装盒' },
      { url: '', name: '国补小票' },
      { url: '', name: 'ID照片（重庆）' },
      { url: '', name: '水印合影（重庆）' }
    ];

    const currentSubsidyPhotos = imageUpload.normalizeImageValues([
      ...(Array.isArray(order.subsidyPhotos) ? order.subsidyPhotos : order.subsidyPhotos ? [order.subsidyPhotos] : []),
      ...(Array.isArray(order.subsidy_photos) ? order.subsidy_photos : order.subsidy_photos ? [order.subsidy_photos] : [])
    ]);
    const legacySubsidyPhotos = imageUpload.normalizeImageValues([
      ...(Array.isArray(order.subsidyPhotoUrls) ? order.subsidyPhotoUrls : order.subsidyPhotoUrls ? [order.subsidyPhotoUrls] : []),
      ...(Array.isArray(order.subsidy_photo_urls) ? order.subsidy_photo_urls : order.subsidy_photo_urls ? [order.subsidy_photo_urls] : [])
    ]);
    const savedSubsidyPhotos = currentSubsidyPhotos.length ? currentSubsidyPhotos : legacySubsidyPhotos;
    order.subsidyPhotos = defaultSubsidyPhotos.map((item, index) => {
      const savedPhoto = savedSubsidyPhotos[index];
      const url = typeof savedPhoto === 'string'
        ? savedPhoto
        : (savedPhoto && (savedPhoto.url || savedPhoto.fileID || savedPhoto.fileId)) || '';
      return Object.assign({}, item, { url });
    });

    // 商品图片
    order.productPhotoUrls = imageUpload.normalizeImageValues([
      ...(Array.isArray(order.productPhotoUrls) ? order.productPhotoUrls : order.productPhotoUrls ? [order.productPhotoUrls] : []),
      ...(Array.isArray(order.product_photo_urls) ? order.product_photo_urls : order.product_photo_urls ? [order.product_photo_urls] : []),
      ...(Array.isArray(order.productPhotoIds) ? order.productPhotoIds : order.productPhotoIds ? [order.productPhotoIds] : []),
      ...(Array.isArray(order.product_photo_ids) ? order.product_photo_ids : order.product_photo_ids ? [order.product_photo_ids] : [])
    ]);
    const educationPhoto = order.educationSubsidyPhotoUrl || order.education_subsidy_photo_url || '';
    order.educationSubsidyPhotoUrl = typeof educationPhoto === 'string'
      ? educationPhoto
      : (educationPhoto.url || educationPhoto.fileID || educationPhoto.fileId || '');
    order.educationSubsidyCouponCode = order.educationSubsidyCouponCode || order.education_subsidy_coupon_code || '';
    const personalInfoPhoto = order.personalInfoPhoto || order.personal_info_photo || {};
    order.personalInfoPhoto = typeof personalInfoPhoto === 'string'
      ? { url: personalInfoPhoto, name: '个人资料' }
      : Object.assign({ url: '', name: '个人资料' }, personalInfoPhoto);

    // 补录记录
    order.supplements = order.supplements || [];
    order.supplementTotal = order.supplementTotal === undefined || order.supplementTotal === null
      ? 0
      : Number(order.supplementTotal || 0);

    return order;
  },

  // 云文件 ID 不能直接作为 image 组件的网络地址。保留原始 ID 用于保存，
  // 仅把临时 HTTPS 地址写入展示字段，避免临时链接过期后污染订单数据。
  refreshPhotoDisplayUrls: function () {
    const subsidyPhotos = this.data.subsidyPhotos || [];
    const productPhotoUrls = this.data.productPhotoUrls || [];
    const educationPhoto = this.data.educationSubsidyPhotoUrl || '';
    const personalPhoto = this.data.personalInfoPhoto && (this.data.personalInfoPhoto.url || this.data.personalInfoPhoto.fileID || '');
    return Promise.all([
      imageUpload.resolveImageUrls(subsidyPhotos.map(photo => photo && photo.url)),
      imageUpload.resolveImageUrls(productPhotoUrls),
      imageUpload.resolveImageUrls([educationPhoto]),
      imageUpload.resolveImageUrls([personalPhoto])
    ]).then(([subsidyUrls, productUrls, educationUrls, personalUrls]) => {
      const nextSubsidyPhotos = subsidyPhotos.map((photo, index) => Object.assign({}, photo, {
        displayUrl: subsidyUrls[index] || (photo && photo.url) || ''
      }));
      this.setData({
        subsidyPhotos: nextSubsidyPhotos,
        productPhotoDisplayUrls: productUrls,
        educationSubsidyPhotoDisplayUrl: educationUrls[0] || educationPhoto,
        personalInfoPhoto: Object.assign({}, this.data.personalInfoPhoto || {}, {
          displayUrl: personalUrls[0] || personalPhoto
        })
      });
      return { subsidyUrls, productUrls, educationUrls, personalUrls };
    });
  },

  /**
   * 初始化页面数据
   */
  initPageData: function (order) {
    const storeContext = this.getCurrentStoreContext();
    const userInfo = storeContext.userInfo;
    const currentStoreId = storeContext.storeId;

    // 计算编辑权限
    let canEdit = false;
    let canOperate = false;

    if (userUtils.isDistributor()) {
      canEdit = order.status === '未归档';
      canOperate = true;
    } else if (userUtils.isStoreAdmin()) {
      canEdit = order.status === '未归档' && String(order.storeId || order.store_id || '') === String(currentStoreId || '');
      canOperate = String(order.storeId || order.store_id || '') === String(currentStoreId || '');
    } else {
      canEdit = order.status === '未归档' && order.createUser === userInfo.userName;
      canOperate = order.createUser === userInfo.userName;
    }

    // 特殊字段编辑权限：国补人信息、国补照片、开票信息在归档后仍可编辑
    let canEditSpecialFields = false;
    if (userUtils.isDistributor()) {
      canEditSpecialFields = true;
    } else if (userUtils.isStoreAdmin()) {
      canEditSpecialFields = String(order.storeId || order.store_id || '') === String(currentStoreId || '');
    } else {
      canEditSpecialFields = order.createUser === userInfo.userName;
    }

    // 计算客户来源索引；历史二级来源不在当前父级下时，反查它原来的一级来源并保留回显
    let customerSourceLevel1List = [...(this.data.customerSourceLevel1List || [])];
    let customerSources = [...(this.data.customerSources || [])];
    let level1Index = customerSourceLevel1List.indexOf(order.customerSource);
    const level1Sources = this.data.level1SourcesData || [];
    const level2SourcesMap = this.data.level2SourcesMap || {};
    const getSourceId = source => String(source && (source._id || source.id || source.sourceId || source.value || source.name) || '');
    const hasSourceId = (source, id) => {
      const ids = [source && source._id, source && source.id, source && source.sourceId, source && source.value, source && source.name]
        .filter(value => value !== undefined && value !== null && value !== '')
        .map(value => String(value));
      return ids.indexOf(String(id)) >= 0;
    };

    if (level1Index < 0 && order.customerSourceDetail) {
      Object.keys(level2SourcesMap).some(parentId => {
        const matched = (level2SourcesMap[parentId] || []).some(s => s.name === order.customerSourceDetail);
        if (!matched) return false;
        const parent = level1Sources.find(source => hasSourceId(source, parentId));
        if (parent && parent.name) {
          order.customerSource = parent.name;
          if (customerSourceLevel1List.indexOf(parent.name) === -1) {
            customerSourceLevel1List.push(parent.name);
          }
          if (customerSources.indexOf(parent.name) === -1) {
            customerSources.push(parent.name);
          }
          level1Index = customerSourceLevel1List.indexOf(parent.name);
        }
        return true;
      });
    }

    if (level1Index < 0 && order.customerSource) {
      customerSourceLevel1List.push(order.customerSource);
      if (customerSources.indexOf(order.customerSource) === -1) {
        customerSources.push(order.customerSource);
      }
      level1Index = customerSourceLevel1List.indexOf(order.customerSource);
    }

    const customerSourceIndex = customerSources.indexOf(order.customerSource);
    const level1Source = level1Sources[level1Index >= 0 ? level1Index : 0] || {};
    const level1IdCandidates = [
      level1Source._id,
      level1Source.id,
      level1Source.sourceId,
      level1Source.value,
      level1Source.name
    ].filter(value => value !== undefined && value !== null && value !== '').map(value => String(value));
    const matchedLevel2Sources = level1IdCandidates.reduce((list, id) => {
      return list.length ? list : (level2SourcesMap[id] || []);
    }, []);
    let level2Names = matchedLevel2Sources.map(s => s.name);
    if (order.customerSourceDetail && level2Names.indexOf(order.customerSourceDetail) === -1) {
      level2Names = level2Names.concat(order.customerSourceDetail);
    }
    const level2Index = level2Names.indexOf(order.customerSourceDetail);

    // 计算收款方式索引；订单历史选项即使已不在字典中，也要能回显
    const paymentMethodOptions = [...(this.data.paymentMethodOptions || [])];
    order.paymentMethods.forEach(p => {
      if (p.type && paymentMethodOptions.indexOf(p.type) === -1) {
        paymentMethodOptions.push(p.type);
      }
    });
    const paymentMethodIndex = order.paymentMethods.map(p =>
      paymentMethodOptions.indexOf(p.type)
    );

    // 辅助销售人与新建订单使用同一套人员元数据和选项索引
    const auxiliarySalesOptions = [...(this.data.auxiliarySalesOptions || [])];
    const auxiliarySalesStaffOptions = [...(this._auxiliarySalesStaffOptions || [null])];
    order.auxiliarySalesList = order.auxiliarySalesList.map(item => {
      if (!item || !item.selected || item.selected === '无') {
        return Object.assign({}, item, {
          selected: '无',
          selectedDisplay: '无',
          optionIndex: 0
        });
      }

      let optionIndex = auxiliarySalesStaffOptions.findIndex(staff => {
        if (!staff) return false;
        if (item.staffId && staff.staffId && String(item.staffId) === String(staff.staffId)) return true;
        if (item.phone && staff.phone && String(item.phone) === String(staff.phone)) return true;
        return (
          item.selected === staff.name &&
          (!item.storeId || String(item.storeId) === String(staff.storeId || ''))
        );
      });

      if (optionIndex < 0) {
        const selectedDisplay = item.selectedDisplay || item.selected;
        optionIndex = auxiliarySalesOptions.indexOf(selectedDisplay);
        if (optionIndex < 0) {
          auxiliarySalesOptions.push(selectedDisplay);
          auxiliarySalesStaffOptions.push({
            staffId: item.staffId || '',
            name: item.selected,
            displayName: selectedDisplay,
            phone: item.phone || '',
            storeId: item.storeId || '',
            storeName: item.storeName || '',
            regionId: item.regionId || ''
          });
          optionIndex = auxiliarySalesOptions.length - 1;
        }
        return Object.assign({}, item, { selectedDisplay, optionIndex });
      }

      const matchedStaff = auxiliarySalesStaffOptions[optionIndex];
      return Object.assign({}, item, {
        selected: matchedStaff.name,
        selectedDisplay: matchedStaff.displayName || matchedStaff.name,
        optionIndex,
        staffId: matchedStaff.staffId,
        phone: matchedStaff.phone,
        storeId: matchedStaff.storeId,
        storeName: matchedStaff.storeName,
        regionId: matchedStaff.regionId
      });
    });
    this._auxiliarySalesStaffOptions = auxiliarySalesStaffOptions;
    const auxiliarySalesIndex = order.auxiliarySalesList.map(item => item.optionIndex || 0);

    // 计算金额
    const totalAmount = this.calculateGoodsTotal(order.goodsList);
    const actualAmount = this.calculateActualAmount(
      totalAmount,
      parseFloat(order.discount) || 0,
      parseFloat(order.nationalSubsidy) || 0,
      parseFloat(order.educationSubsidy) || 0,
      this.getDepositDeductionTotal(order.depositItems)
    );
    const orderProfit = calculateOrderProfit({
      actualAmount,
      totalAmount: order.totalAmount,
      discount: order.discount,
      receivableBeforeSubsidy: order.receivableBeforeSubsidy
    }, order.goodsList);
    const paymentTotal = this.calculatePaymentTotal(order.paymentMethods);
    const differenceAmount = (actualAmount - paymentTotal).toFixed(2);

    const returnItems = this.buildReturnItems(order.goodsList);
    const returnBreakdown = this.calculateReturnBreakdown(returnItems, order);
    this.setData({
      order,
      orderStatusLabel: this.getOrderStatusLabel(order.status),
      canEdit,
      canEditSpecialFields,
      canOperate,
      returnItems,
      returnAmount: returnBreakdown.customerAmount.toFixed(2),
      returnCustomerAmount: returnBreakdown.customerAmount.toFixed(2),
      returnPolicyAmount: returnBreakdown.policySubsidyAmount.toFixed(2),
      returnNationalSubsidyAmount: returnBreakdown.nationalSubsidyAmount.toFixed(2),
      returnPending: this.isReturnPendingStatus(order.status),
      isArchived: order.status === '已归档',

      // 客户信息
      customerSources,
      customerSourceLevel1List,
      customerSourceIndex: customerSourceIndex >= 0 ? customerSourceIndex : 0,
      customerSourceLevel1Index: level1Index >= 0 ? level1Index : 0,
      customerSourceLevel2Index: level2Index >= 0 ? level2Index : 0,
      customerSourceLevel2List: level2Names,

      // 商品
      goodsList: order.goodsList,

      // 金额
      totalAmount: totalAmount.toFixed(2),
      discount: order.discount,
      nationalSubsidy: order.nationalSubsidy,
      computerAmount: order.computerAmount,
      mobileAmount: order.mobileAmount,
      educationSubsidy: order.educationSubsidy,
      depositItems: order.depositItems,
      depositDeductionTotal: this.getDepositDeductionTotal(order.depositItems).toFixed(2),
      actualAmount: actualAmount.toFixed(2),
      paymentTotal: paymentTotal.toFixed(2),
      differenceAmount,
      grossProfit: orderProfit.grossProfit,
      minimumSalePriceTotal: orderProfit.minimumSalePriceTotal,

      // 收款
      paymentMethodOptions,
      paymentMethods: order.paymentMethods,
      paymentMethodIndex,

      // 辅助销售人
      auxiliarySalesOptions,
      auxiliarySalesList: order.auxiliarySalesList,
      auxiliarySalesIndex,

      // 开票
      invoiceStatus: order.invoiceStatus || '不开票',
      invoiceInfo: order.invoiceInfo || '',
      invoiceAmount: order.invoiceAmount || '',

      // 国补
      subsidyStatus: order.subsidyStatus || '非国补',
      subsidyPerson: order.subsidyPerson || '',
      subsidyId: order.subsidyId || '',
      subsidyPhotos: order.subsidyPhotos,
      hasSubsidyPhotos: order.subsidyPhotos.some(photo => photo && photo.url),

      // 图片
      productPhotoUrls: order.productPhotoUrls,
      educationSubsidyPhotoUrl: order.educationSubsidyPhotoUrl,
      educationSubsidyCouponCode: order.educationSubsidyCouponCode,
      personalInfoPhoto: order.personalInfoPhoto,

      // 补录
      supplements: order.supplements,
      supplementTotal: order.supplementTotal,

      // 保存原始数据
      originalData: JSON.parse(JSON.stringify(order))
    });
  },

  // ==================== 计算相关方法 ====================

  isReturnPendingStatus: function (status) {
    const value = String(status || '').trim().toLowerCase();
    return value === 'return_pending' || value === 'returning' || value.indexOf('退单审批') >= 0 || value.indexOf('已发起退单') >= 0;
  },

  getOrderStatusLabel: function (status) {
    const value = String(status || '').trim();
    if (value === 'pending_approval') return '待审批';
    if (['return_pending', 'returning', '已发起退单申请', '退单审批中'].indexOf(value) >= 0) return '退单审批中';
    if (['return_inbound', '退库处理中', '退货入库中'].indexOf(value) >= 0) return '退货入库中';
    if (['returned', '退单', '已退单'].indexOf(value) >= 0) return '已退单';
    return value || '未归档';
  },

  buildReturnItems: function (items, sourceOrder) {
    const order = sourceOrder || this.data.order || {};
    const orderIsGuobu = ['国补', '鍥借ˉ'].indexOf(String(this.data.subsidyStatus || order.subsidyStatus || order.subsidy_status || '')) >= 0;
    return (items || []).map((item, index) => {
      const quantity = Math.max(1, Number(item.quantity) || 1);
      const maxQuantity = Math.min(quantity, Math.max(0, Number(item.refundableQuantity !== undefined ? item.refundableQuantity : quantity) || 0));
      const unitPrice = Number(item.unitPrice !== undefined ? item.unitPrice : item.price) || 0;
      const resourceSummary = item.resourceSummary || item.resource_summary || {};
      const resourceRights = (Array.isArray(item.resourceRights) ? item.resourceRights : (Array.isArray(item.resource_rights) ? item.resource_rights : []))
        .concat(Array.isArray(resourceSummary.rights) ? resourceSummary.rights : []);
      const resourceTypes = [].concat(item.selectedResourceTypes || [], item.selected_resource_types || [], item.resourceTypes || [], item.resource_types || [])
        .concat(resourceRights.map(right => right.resourceType || right.resource_type || ''))
        .map(value => String(value || '').trim().toUpperCase()).filter(Boolean);
      if (!resourceTypes.length && orderIsGuobu) resourceTypes.push('GOV_SUBSIDY');
      return Object.assign({}, item, {
        returnIndex: index,
        selected: false,
        returnQuantity: maxQuantity,
        maxReturnQuantity: maxQuantity,
        returnUnitPrice: unitPrice,
        returnResourceTypes: Array.from(new Set(resourceTypes)),
        returnResourceRights: resourceRights,
        hasUsedGovSubsidy: resourceRights.some(right => String(right.resourceType || right.resource_type || '').toUpperCase() === 'GOV_SUBSIDY' && String(right.currentStatus || right.current_status || right.status || '').toUpperCase() === 'USED')
      });
    });
  },

  calculateReturnBreakdown: function (items, sourceOrder) {
    const order = sourceOrder || this.data.order || {};
    const paymentMethods = (this.data.paymentMethods && this.data.paymentMethods.length) ? this.data.paymentMethods : (order.paymentMethods || order.payments || []);
    const selectedGross = (items || []).reduce((sum, item) => {
      return sum + (item.selected && Number(item.returnQuantity) > 0 ? (Number(item.returnUnitPrice) || 0) * Number(item.returnQuantity) : 0);
    }, 0);
    const allItems = (this.data.goodsList && this.data.goodsList.length) ? this.data.goodsList : (items || []);
    const totalGross = allItems.reduce((sum, item) => sum + (Number(item.unitPrice !== undefined ? item.unitPrice : item.price) || 0) * (Number(item.quantity) || 1), 0);
    const customerPaymentTotal = paymentMethods.reduce((sum, method) => String(method && (method.type || method.paymentType || method.payment_method) || '').indexOf('政策补贴应收') >= 0 ? sum : sum + (Number(method.amount) || 0), 0) || Number(this.data.actualAmount || order.actualAmount || order.actualPayment || 0);
    const policyPaymentTotal = paymentMethods.reduce((sum, method) => String(method && (method.type || method.paymentType || method.payment_method) || '').indexOf('政策补贴应收') < 0 ? sum : sum + (Number(method.amount) || 0), 0) || Number(this.data.nationalSubsidy || order.nationalSubsidy || order.national_subsidy || 0);
    const eligibleItems = allItems.filter(item => [].concat(item.selectedResourceTypes || [], item.selected_resource_types || [], item.resourceTypes || [], item.resource_types || [], item.resourceRights || item.resource_rights || []).map(value => typeof value === 'object' ? (value.resourceType || value.resource_type) : value).some(value => String(value || '').toUpperCase() === 'GOV_SUBSIDY'));
    const eligibleGross = eligibleItems.length ? eligibleItems.reduce((sum, item) => sum + (Number(item.unitPrice !== undefined ? item.unitPrice : item.price) || 0) * (Number(item.quantity) || 1), 0) : (String(this.data.subsidyStatus || order.subsidyStatus || order.subsidy_status || '') === '国补' ? totalGross : 0);
    const selectedEligibleGross = (items || []).reduce((sum, item) => item.selected && Number(item.returnQuantity) > 0 && (item.returnResourceTypes || []).indexOf('GOV_SUBSIDY') >= 0 ? sum + (Number(item.returnUnitPrice) || 0) * Number(item.returnQuantity) : sum, 0);
    const customerAmount = totalGross ? Math.min(customerPaymentTotal, selectedGross / totalGross * customerPaymentTotal) : 0;
    const policySubsidyAmount = this.data.returnGovSubsidy && eligibleGross
      ? Math.min(policyPaymentTotal, selectedEligibleGross / eligibleGross * policyPaymentTotal)
      : 0;
    return { grossAmount: Math.round(selectedGross * 100) / 100, customerAmount: Math.round(customerAmount * 100) / 100, policySubsidyAmount: Math.round(policySubsidyAmount * 100) / 100, nationalSubsidyAmount: Math.round(policySubsidyAmount * 100) / 100 };
  },

  calculateReturnAmount: function (items) {
    return this.calculateReturnBreakdown(items).customerAmount;
  },

  openReturnModal: function () {
    if (!this.data.isArchived || !this.data.canOperate || this.data.returnPending) {
      wx.showToast({ title: this.data.returnPending ? '退单申请正在审批中' : '当前订单不可退单', icon: 'none' });
      return;
    }
    const returnItems = this.buildReturnItems(this.data.goodsList || [], this.data.order || {});
    if (!returnItems.some(item => item.maxReturnQuantity > 0)) {
      wx.showToast({ title: '该订单没有可退商品', icon: 'none' });
      return;
    }
    const returnGovSubsidyAvailable = returnItems.some(item => item.hasUsedGovSubsidy || item.returnResourceTypes.indexOf('GOV_SUBSIDY') >= 0);
    this.setData({
      showReturnModal: true,
      returnItems,
      returnGovSubsidy: false,
      returnGovSubsidyAvailable,
      returnAmount: '0.00',
      returnCustomerAmount: '0.00',
      returnPolicyAmount: '0.00',
      returnNationalSubsidyAmount: '0.00'
    });
  },

  closeReturnModal: function () {
    if (!this.data.returnSubmitting) this.setData({ showReturnModal: false });
  },

  stopModalTouchMove: function () {},

  stopModalTap: function () {},

  onReturnItemChange: function (e) {
    const selectedIndexes = (e.detail.value || []).map(value => Number(value));
    const returnItems = (this.data.returnItems || []).map((item, index) => Object.assign({}, item, { selected: selectedIndexes.indexOf(index) >= 0 }));
    const breakdown = this.calculateReturnBreakdown(returnItems);
    this.setData({ returnItems, returnAmount: breakdown.customerAmount.toFixed(2), returnCustomerAmount: breakdown.customerAmount.toFixed(2), returnPolicyAmount: breakdown.policySubsidyAmount.toFixed(2), returnNationalSubsidyAmount: breakdown.nationalSubsidyAmount.toFixed(2) });
  },

  onReturnQuantityInput: function (e) {
    const index = Number(e.currentTarget.dataset.index);
    const returnItems = (this.data.returnItems || []).map((item, itemIndex) => {
      if (itemIndex !== index) return item;
      return Object.assign({}, item, { returnQuantity: Math.max(0, Math.min(item.maxReturnQuantity, Math.floor(Number(e.detail.value) || 0))) });
    });
    const breakdown = this.calculateReturnBreakdown(returnItems);
    this.setData({ returnItems, returnAmount: breakdown.customerAmount.toFixed(2), returnCustomerAmount: breakdown.customerAmount.toFixed(2), returnPolicyAmount: breakdown.policySubsidyAmount.toFixed(2), returnNationalSubsidyAmount: breakdown.nationalSubsidyAmount.toFixed(2) });
  },

  onReturnGovSubsidyChange: function (e) {
    const returnGovSubsidy = (e.detail.value || '').indexOf('yes') >= 0;
    const breakdown = this.calculateReturnBreakdown(this.data.returnItems || []);
    this.setData({
      returnGovSubsidy,
      returnAmount: breakdown.customerAmount.toFixed(2),
      returnCustomerAmount: breakdown.customerAmount.toFixed(2),
      returnPolicyAmount: breakdown.policySubsidyAmount.toFixed(2),
      returnNationalSubsidyAmount: breakdown.nationalSubsidyAmount.toFixed(2)
    });
  },

  onReturnReasonInput: function (e) {
    this.setData({ returnReason: e.detail.value || '' });
  },

  submitPartialReturn: function () {
    if (this.data.returnSubmitting) return;
    const selectedItems = (this.data.returnItems || []).filter(item => item.selected && Number(item.returnQuantity) > 0);
    if (!selectedItems.length) {
      wx.showToast({ title: '请至少勾选一个商品', icon: 'none' });
      return;
    }
    const breakdown = this.calculateReturnBreakdown(this.data.returnItems);
    const refundAmount = breakdown.customerAmount;
    if (refundAmount <= 0) {
      wx.showToast({ title: '退单金额必须大于0', icon: 'none' });
      return;
    }
    const context = this.getCurrentStoreContext();
    const userInfo = context.userInfo || {};
    const order = this.data.order || {};
    const returnItems = selectedItems.map(item => ({
      itemId: item.itemId,
      item_id: item.itemId,
      productId: item.productId,
      product_id: item.productId,
      productName: item.productName || item.name,
      product_name: item.productName || item.name,
      pnCode: item.pnCode,
      pn_code: item.pnCode,
      snCode: item.snCode,
      sn_code: item.snCode,
      originalQuantity: item.quantity,
      original_quantity: item.quantity,
      quantity: Number(item.returnQuantity),
      returnQuantity: Number(item.returnQuantity),
      return_quantity: Number(item.returnQuantity),
      unitPrice: Number(item.returnUnitPrice) || 0,
      unit_price: Number(item.returnUnitPrice) || 0,
      refundAmount: Math.round((Number(item.returnUnitPrice) || 0) * Number(item.returnQuantity) * 100) / 100
    }));
    this.setData({ returnSubmitting: true });
    wx.showLoading({ title: '提交退单申请...' });
    api.order.requestReturn(order.orderId || order._id || order.order_id, {
      orderNo: order.orderNo,
      storeId: order.storeId || order.store_id || context.storeId || '',
      returnType: 'partial',
      return_type: 'partial',
      reason: this.data.returnReason || '客户部分退单',
      items: returnItems,
      goods: returnItems,
      refundAmount,
      refund_amount: refundAmount,
      customerReceivedRefundAmount: breakdown.customerAmount,
      customer_received_refund_amount: breakdown.customerAmount,
      policySubsidyReceivableRefundAmount: breakdown.policySubsidyAmount,
      policy_subsidy_receivable_refund_amount: breakdown.policySubsidyAmount,
      nationalSubsidyAmount: breakdown.nationalSubsidyAmount,
      national_subsidy_amount: breakdown.nationalSubsidyAmount,
      returnGovSubsidy: this.data.returnGovSubsidy ? 1 : 0,
      return_gov_subsidy: this.data.returnGovSubsidy ? 1 : 0,
      policySubsidyRefundAmount: breakdown.policySubsidyAmount,
      policy_subsidy_refund_amount: breakdown.policySubsidyAmount,
      originalPayments: order.paymentMethods || order.payments || [],
      original_payments: order.paymentMethods || order.payments || [],
      postToDailyStatement: true,
      post_to_daily_statement: true,
      createNegativeDailyStatement: true,
      create_negative_daily_statement: true,
      dailyStatementAmount: -refundAmount,
      daily_statement_amount: -refundAmount,
      policySubsidyDailyStatementAmount: -breakdown.policySubsidyAmount,
      policy_subsidy_daily_statement_amount: -breakdown.policySubsidyAmount,
      dailyStatementEntries: [
        { itemType: 'refund_customer_received', item_type: 'refund_customer_received', amount: -breakdown.customerAmount },
        ...(breakdown.policySubsidyAmount > 0 ? [{ itemType: 'refund_policy_subsidy_receivable', item_type: 'refund_policy_subsidy_receivable', amount: -breakdown.policySubsidyAmount }] : [])
      ],
      resourceReturnActions: selectedItems.reduce((actions, item) => {
        if ((item.returnResourceTypes || []).indexOf('GOV_SUBSIDY') < 0) return actions;
        const rights = (item.returnResourceRights || []).filter(right => String(right.resourceType || right.resource_type || '').toUpperCase() === 'GOV_SUBSIDY');
        if (!rights.length) {
          actions.push({ itemId: item.itemId, item_id: item.itemId, resourceType: 'GOV_SUBSIDY', resource_type: 'GOV_SUBSIDY', action: 'release', targetStatus: 'AVAILABLE', target_status: 'AVAILABLE' });
        } else {
          rights.forEach(right => actions.push({ itemId: item.itemId, item_id: item.itemId, resourceType: 'GOV_SUBSIDY', resource_type: 'GOV_SUBSIDY', resourceId: right.resourceId || right.resource_id || right.id || right._id || '', resource_id: right.resourceId || right.resource_id || right.id || right._id || '', beforeStatus: right.currentStatus || right.current_status || right.status || '', action: 'release', targetStatus: 'AVAILABLE', target_status: 'AVAILABLE' }));
        }
        return actions;
      }, []),
      userRole: userInfo.userRole || userInfo.role || '',
      userName: userInfo.userName || userInfo.name || ''
    }).then(result => {
      const returnStatus = result && result.data && result.data.status ? result.data.status : 'return_pending';
      this.setData({
        showReturnModal: false,
        returnPending: true,
        returnSubmitting: false,
        'order.status': returnStatus,
        orderStatusLabel: this.getOrderStatusLabel(returnStatus)
      });
      wx.showToast({ title: '退单申请已提交', icon: 'success' });
    }).catch(error => {
      this.setData({ returnSubmitting: false });
      wx.showToast({ title: (error && error.message) || '提交退单申请失败', icon: 'none' });
    }).finally(() => wx.hideLoading());
  },

  isDepositPayment: function (type) {
    const value = String(type || '').trim().toLowerCase();
    return value === '定金' || value === '定金抵扣' || value === 'deposit';
  },

  normalizeDepositItem: function (source = {}) {
    const amount = Number(
      source.deductionAmount !== undefined
        ? source.deductionAmount
        : (source.deduction_amount !== undefined ? source.deduction_amount : (source.amount || 0))
    );
    return {
      itemType: 'depositDeduction',
      name: '定金抵扣',
      depositId: source.depositId || source.deposit_id || source._id || '',
      depositNo: source.depositNo || source.deposit_no || '',
      customerName: source.customerName || source.customer_name || '',
      customerPhone: source.customerPhone || source.customer_phone || '',
      amount: amount.toFixed(2)
    };
  },

  getDepositDeductionTotal: function (depositItems) {
    return (depositItems || []).reduce((total, item) => {
      return total + (parseFloat(item.amount) || 0);
    }, 0);
  },

  normalizePaymentMethod: function (method = {}) {
    method = method || {};
    const type = method.type || method.paymentType || method.payment_method || method.method || '';
    return {
      type,
      amount: method.amount === undefined || method.amount === null ? '0' : String(method.amount),
      depositId: method.depositId || method.deposit_id || '',
      depositNo: method.depositNo || method.deposit_no || '',
      isPolicySubsidyReceivable: String(type).indexOf('政策补贴应收') >= 0
    };
  },

  getGuobuBasePaymentType: function (type) {
    const value = String(type || '').trim();
    if (value.indexOf('国补POS（手机平板）') === 0) return '国补POS（手机平板）';
    if (value.indexOf('国补POS（电脑）') === 0) return '国补POS（电脑）';
    return '';
  },

  getLegacyGuobuSubsidyAmount: function (type, customerReceivedAmount) {
    const baseType = this.getGuobuBasePaymentType(type);
    const received = Math.max(0, parseFloat(customerReceivedAmount) || 0);
    const limit = baseType === '国补POS（电脑）' ? 1500 : 500;
    return Math.round(Math.min(received * 0.15 / 0.85, limit) * 100) / 100;
  },

  expandGuobuPaymentMethods: function (paymentMethods, nationalSubsidy) {
    const methods = paymentMethods || [];
    const legacyGuobuMethods = methods.filter(method => {
      const type = String(method && method.type || '').trim();
      return type === '国补POS（电脑）' || type === '国补POS（手机平板）';
    });
    const declaredSubsidy = Math.max(0, parseFloat(nationalSubsidy) || 0);

    return methods.reduce((result, method) => {
      const type = String(method && method.type || '').trim();
      const baseType = this.getGuobuBasePaymentType(type);
      if (!baseType || type !== baseType) {
        result.push(method);
        return result;
      }

      const customerReceived = Math.max(0, parseFloat(method.amount) || 0);
      const subsidyReceivable = legacyGuobuMethods.length === 1 && declaredSubsidy > 0
        ? declaredSubsidy
        : this.getLegacyGuobuSubsidyAmount(baseType, customerReceived);
      result.push(Object.assign({}, method, {
        type: `${baseType}-客户实收`,
        amount: customerReceived.toFixed(2),
        isPolicySubsidyReceivable: false
      }));
      result.push({
        type: `${baseType}-政策补贴应收`,
        amount: subsidyReceivable.toFixed(2),
        isPolicySubsidyReceivable: true
      });
      return result;
    }, []);
  },

  appendDepositPaymentMethods: function (paymentMethods, depositItems) {
    const methods = (paymentMethods || []).slice();
    const existingDepositIds = new Set(
      methods
        .filter(method => this.isDepositPayment(method && method.type))
        .map(method => String(method.depositId || method.deposit_id || ''))
    );

    (depositItems || []).forEach(item => {
      const depositId = String(item.depositId || item.deposit_id || '');
      if ((depositId && existingDepositIds.has(depositId)) ||
          (!depositId && methods.some(method => this.isDepositPayment(method && method.type)))) {
        return;
      }
      methods.push({
        type: '定金抵扣',
        amount: item.amount,
        depositId,
        depositNo: item.depositNo || item.deposit_no || '',
        isPolicySubsidyReceivable: false
      });
      if (depositId) existingDepositIds.add(depositId);
    });
    return methods;
  },

  getEditablePaymentMethods: function (paymentMethods, index) {
    const list = (paymentMethods || []).map(method => this.normalizePaymentMethod(method));
    const targetIndex = parseInt(index, 10);
    if (isNaN(targetIndex) || targetIndex < 0) {
      return list;
    }

    while (list.length <= targetIndex) {
      list.push(this.normalizePaymentMethod());
    }

    return list;
  },

  /**
   * 计算商品总计
   */
  calculateGoodsTotal: function (goodsList) {
    return goodsList.reduce((total, item) => {
      const price = parseFloat(item.price) || 0;
      const quantity = parseFloat(item.quantity) || 1;
      return total + (price * quantity);
    }, 0);
  },

  /**
   * 计算应收金额
   */
  calculateActualAmount: function (total, discount, nationalSubsidy, educationSubsidy, depositDeductionTotal = 0) {
    // 定金作为收款方式处理，只记录核销金额，不再从应收金额中重复扣减。
    return Math.max(0, total - discount - nationalSubsidy - educationSubsidy);
  },

  /**
   * 计算收款汇总
   */
  calculatePaymentTotal: function (paymentMethods) {
    return paymentMethods.reduce((total, method) => {
      const amount = parseFloat(method.amount) || 0;
      const methodType = method.type || '';

      // 政策补贴应收属于后续结算款，不计入当前客户实收/定金抵扣汇总。
      if (String(methodType).indexOf('政策补贴应收') >= 0) {
        return total;
      }

      // 国补POS特殊计算
      if (methodType === '国补POS（手机平板）') {
        const discount = amount * 0.15;
        const actualDiscount = Math.min(discount, 500);
        return total + (amount - actualDiscount);
      }

      if (methodType === '国补POS（电脑）') {
        const discount = amount * 0.15;
        const actualDiscount = Math.min(discount, 1500);
        return total + (amount - actualDiscount);
      }

      return total + amount;
    }, 0);
  },

  getGuobuPaymentAmount: function (paymentMethods) {
    return (paymentMethods || []).reduce((total, method) => {
      const type = String(method && method.type || '');
      if (type.indexOf('国补') === -1) return total;
      return total + (parseFloat(method.amount) || 0);
    }, 0);
  },

  getDefaultInvoiceAmount: function (paymentMethods, subsidyStatusOverride) {
    const originalGuobuAmount = (parseFloat(this.data.computerAmount) || 0) + (parseFloat(this.data.mobileAmount) || 0);
    const isGuobu = (subsidyStatusOverride || this.data.subsidyStatus) === '国补' ||
      (parseFloat(this.data.nationalSubsidy) || 0) > 0 ||
      this.getGuobuPaymentAmount(paymentMethods || this.data.paymentMethods) > 0;
    if (isGuobu && originalGuobuAmount > 0) return originalGuobuAmount.toFixed(2);
    const actualAmount = parseFloat(this.data.actualAmount) || 0;
    return actualAmount > 0 ? actualAmount.toFixed(2) : '';
  },

  /**
   * 重新计算所有金额
   */
  recalculateAmounts: function () {
    const { goodsList, discount, nationalSubsidy, educationSubsidy, paymentMethods, depositItems } = this.data;

    const totalAmount = this.calculateGoodsTotal(goodsList);
    const actualAmount = this.calculateActualAmount(
      totalAmount,
      parseFloat(discount) || 0,
      parseFloat(nationalSubsidy) || 0,
      parseFloat(educationSubsidy) || 0,
      this.getDepositDeductionTotal(depositItems)
    );
    const paymentTotal = this.calculatePaymentTotal(paymentMethods);
    const differenceAmount = (actualAmount - paymentTotal).toFixed(2);

    this.setData({
      totalAmount: totalAmount.toFixed(2),
      depositDeductionTotal: this.getDepositDeductionTotal(depositItems).toFixed(2),
      actualAmount: actualAmount.toFixed(2),
      paymentTotal: paymentTotal.toFixed(2),
      differenceAmount
    });
  },

  // ==================== 客户信息相关 ====================

  onCustomerSourceChange: function (e) {
    const index = e.detail.value;
    const customerSource = this.data.customerSources[index];
    this.setData({
      'order.customerSource': customerSource,
      customerSourceIndex: index
    });
  },

  onCustomerSourceLevel1Change: function (e) {
    const index = parseInt(e.detail.value);
    const level1Sources = this.data.level1SourcesData || [];
    const level1Name = this.data.customerSourceLevel1List[index];
    const level1Id = level1Sources[index]?._id || '';
    const level2List = this.data.level2SourcesMap[level1Id] || [];
    const level2Names = level2List.map(s => s.name);
    const level2Name = level2List.length > 0 ? level2List[0].name : '';

    this.setData({
      customerSourceLevel1Index: index,
      customerSourceLevel2Index: 0,
      customerSourceLevel2List: level2Names,
      'order.customerSource': level1Name,
      'order.customerSourceDetail': level2Name
    });
  },

  onCustomerSourceLevel2Change: function (e) {
    const index = parseInt(e.detail.value);
    const level1Sources = this.data.level1SourcesData || [];
    const level1Index = this.data.customerSourceLevel1Index || 0;
    const level1Id = level1Sources[level1Index]?._id || '';
    const level2List = this.data.level2SourcesMap[level1Id] || [];
    const level2Name = level2List[index]?.name || '';

    this.setData({
      customerSourceLevel2Index: index,
      'order.customerSourceDetail': level2Name
    });
  },

  onContactNameInput: function (e) {
    const updateData = {
      'order.contactName': e.detail.value
    };
    if (this.data.subsidyStatus === '国补' && !this.data.subsidyPerson) {
      updateData.subsidyPerson = e.detail.value;
    }
    this.setData(updateData);
  },

  onContactMethodInput: function (e) {
    const updateData = {
      'order.contactMethod': e.detail.value
    };
    if (this.data.subsidyStatus === '国补' && !this.data.subsidyId) {
      updateData.subsidyId = e.detail.value;
    }
    this.setData(updateData);
  },

  // ==================== 商品相关 ====================

  onGoodsInput: function (e) {
    const { index, field } = e.currentTarget.dataset;
    let value = e.detail.value;

    // PN/SN码转大写
    if (field === 'pnCode' || field === 'snCode') {
      value = value.toUpperCase();
    }

    const goodsList = this.data.goodsList;
    goodsList[index][field] = value;

    // 如果修改了商品名称，检查是否需要显示IMEI
    if (field === 'name') {
      goodsList[index].showImei = value.toLowerCase().includes('moto');
    }

    this.setData({ goodsList });
    this.recalculateAmounts();
  },

  /**
   * 商品信息输入框失去焦点处理
   */
  onGoodsBlur: function (e) {
    const index = e.currentTarget.dataset.index;
    const field = e.currentTarget.dataset.field;
    const value = e.detail.value;

    // 当商品名称输入框失去焦点时，自动查询PN码

    // 当PN或SN码输入框失去焦点时，自动获取商品信息
    // PN/SN 统一通过输入框旁的“查询”按钮查询，避免失焦时误触发查询。
  },

  searchGoodsByName: function (e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.goodsList[index] || {};
    const goodsName = String(item.name || '').trim();
    if (!goodsName) {
      wx.showToast({ title: '请先输入商品名称', icon: 'none' });
      return;
    }
    this.searchPNByGoodsName(goodsName, index);
  },

  queryGoodsByPN: function (e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.goodsList[index] || {};
    const pn = String(item.pnCode || '').trim();
    if (!pn) {
      wx.showToast({ title: '请输入PN码', icon: 'none' });
      return;
    }
    this.searchGoodsByNameRegExp([pn], index);
  },

  queryGoodsBySN: function (e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.goodsList[index] || {};
    const sn = String(item.snCode || '').trim();
    if (!sn) {
      wx.showToast({ title: '请输入SN码', icon: 'none' });
      return;
    }
    this.getGoodsInfoBySN(sn, index, { showLoading: true });
  },

  onSnPickerChange: function (e) {
    const index = Number(e.currentTarget.dataset.index);
    const selectedIndex = Number(e.detail.value || 0);
    const goodsList = this.data.goodsList;
    const current = goodsList[index] || {};
    const record = selectedIndex > 0 ? ((current.snRecords || [])[selectedIndex - 1] || {}) : {};
    current.snPickerIndex = selectedIndex;
    current.snCode = selectedIndex > 0
      ? (record.snCode || record.sn_code || record.sn || (current.snOptions || [])[selectedIndex - 1] || '')
      : '';
    current.inventoryId = record.inventoryId || record.inventory_id || record.snId || record.sn_id || '';
    current.inventoryStatus = record.inventoryStatus || record.inventory_status || record.status || '';
    current.previousSnStatus = current.inventoryStatus || current.previousSnStatus || '在库';
    if (selectedIndex > 0) {
      const effectivePrice = getEffectiveSnSalePrice(record);
      if (effectivePrice > 0) current.price = effectivePrice;
    }
    current.subtotal = (parseFloat(current.price) || 0) * (parseFloat(current.quantity) || 0);
    this.setData({ goodsList });
    this.recalculateAmounts();
  },

  showSnList: function (e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.goodsList[index] || {};
    const records = (item.snRecords || []).length
      ? item.snRecords
      : (item.snOptions || []).map(snCode => ({ snCode }));
    const items = records.map(record => ({
      record,
      snCode: record.snCode || record.sn_code || '',
      statusText: record.inventoryStatus || record.inventory_status || record.status || '可用'
    })).filter(row => row.snCode);
    if (!items.length) {
      wx.showToast({ title: '暂无可用SN，请先查询PN', icon: 'none' });
      return;
    }
    this.setData({ showSnListModal: true, snListModalIndex: index, snListModalItems: items });
  },

  closeSnListModal: function () {
    this.setData({ showSnListModal: false, snListModalItems: [] });
  },

  selectSnFromList: function (e) {
    const item = this.data.snListModalItems[Number(e.currentTarget.dataset.index)] || {};
    const record = item.record || {};
    const goodsList = this.data.goodsList;
    const goods = goodsList[this.data.snListModalIndex] || {};
    goods.snCode = item.snCode || '';
    goods.inventoryId = record.inventoryId || record.inventory_id || record.snId || record.sn_id || '';
    goods.inventoryStatus = record.inventoryStatus || record.inventory_status || record.status || '';
    goods.previousSnStatus = goods.inventoryStatus || '在库';
    const effectivePrice = getEffectiveSnSalePrice(record);
    if (effectivePrice > 0) goods.price = effectivePrice;
    goods.subtotal = (parseFloat(goods.price) || 0) * (parseFloat(goods.quantity) || 0);
    this.setData({ goodsList, showSnListModal: false, snListModalItems: [] });
    this.recalculateAmounts();
  },

  addGoodsItem: function () {
    const goodsList = this.data.goodsList;
    goodsList.push({
      productId: '',
      inventoryId: '',
      pnCode: '',
      snCode: '',
      name: '',
      price: '',
      quantity: '1',
      needSn: false,
      snOptions: [],
      snOptionsDisplay: [],
      snRecords: [],
      snPickerIndex: 0,
      showImei: false,
      imei1: '',
      imei2: ''
    });
    this.setData({ goodsList });
  },

  deleteGoodsItem: function (e) {
    const index = e.currentTarget.dataset.index;
    const goodsList = this.data.goodsList;

    wx.showModal({
      title: '确认删除',
      content: '确定要删除这个商品吗？',
      success: (res) => {
        if (res.confirm) {
          goodsList.splice(index, 1);
          this.setData({ goodsList });
          this.recalculateAmounts();
        }
      }
    });
  },

  scanCode: function (e) {
    const { index, field } = e.currentTarget.dataset;

    wx.scanCode({
      success: (res) => {
        const goodsList = this.data.goodsList;
        goodsList[index][field] = res.result.toUpperCase();
        this.setData({ goodsList });

        // 自动查询商品信息
        if (field === 'pnCode') {
          this.getGoodsInfoByPN(res.result, index);
        } else if (field === 'snCode') {
          this.getGoodsInfoBySN(res.result, index);
        }

        wx.showToast({
          title: '扫码成功',
          icon: 'success'
        });
      },
      fail: (err) => {
        console.error('扫码失败:', err);
      }
    });
  },

  getCurrentStoreId: function () {
    const order = this.data.order || {};
    const userInfo = wx.getStorageSync('userInfo') || {};
    const tempStoreInfo = wx.getStorageSync('tempStoreInfo') || {};
    return order.storeId || order.store_id || (userUtils.isStoreScoped(userInfo)
      ? (tempStoreInfo.storeId || tempStoreInfo.store_id || userInfo.storeId || userInfo.store_id || '')
      : '');
  },

  fillSnOptionsByInventory: function (index, productId, pnCode) {
    const goodsList = this.data.goodsList;
    const current = goodsList[index] || {};
    current.snOptions = [];
    current.snOptionsDisplay = [];
    current.snRecords = [];
    current.snPickerIndex = 0;

    if (!this.isSnManagedGoods(current) || !productId) {
      this.setData({ goodsList });
      return Promise.resolve([]);
    }

    const storeId = this.getCurrentStoreId();
    return api.order.getProductSns(storeId, productId, pnCode)
      .then(res => {
        const records = (res.data || []).filter(item => item.sn_code || item.snCode);
        const options = records.map(item => item.sn_code || item.snCode);
        const latestList = this.data.goodsList;
        const latest = latestList[index] || {};
        const oldSn = String(latest.snCode || '').trim();
        const oldIndex = options.indexOf(oldSn);
        latest.snRecords = records;
        latest.snOptions = options;
        latest.snOptionsDisplay = options.length ? ['请选择SN码'].concat(options) : [];
        latest.snPickerIndex = oldIndex >= 0 ? oldIndex + 1 : 0;
        if (oldIndex < 0 && options.length === 1) {
          latest.snPickerIndex = 1;
          latest.snCode = options[0];
          const selected = records[0] || {};
          latest.inventoryId = selected.inventoryId || selected.inventory_id || selected.snId || selected.sn_id || '';
          const effectivePrice = getEffectiveSnSalePrice(selected);
          if (effectivePrice > 0) latest.price = effectivePrice;
        } else if (oldIndex < 0 && options.length !== 1) {
          latest.snCode = '';
          latest.inventoryId = '';
        }
        this.setData({ goodsList: latestList });
        this.recalculateAmounts();
        return records;
      })
      .catch(err => {
        console.error('查询SN库存失败:', err);
        return [];
      });
  },

  getGoodsInfoByPN: function (pn, index, options = {}) {
    if (options.showLoading) wx.showLoading({ title: '查询中...' });
    DataStorage.getGoodsByPN(pn, (goods) => {
      if (goods && goods.name) {
        const goodsList = this.data.goodsList;
        const needSn = this.isSnManagedGoods(goods);
        goodsList[index].productId = goods.productId || goodsList[index].productId || '';
        goodsList[index].name = goods.name;
        goodsList[index].price = goods.price ? goods.price.toString() : '';
        goodsList[index].standardPrice = Number(goods.standardPrice || goods.standard_price || goods.productStandardPrice || goods.product_standard_price ||
          goods.Product?.standardPrice || goods.Product?.standard_price || 0);
        goodsList[index].minSalePrice = Number(goods.minSalePrice || goods.min_sale_price || goods.minimumSalePrice || goods.minimum_sale_price ||
          goods.minPrice || goods.min_price || goods.lowestSalePrice || goods.lowest_sale_price || goods.lowPrice || goods.low_price ||
          goods.Product?.minSalePrice || goods.Product?.min_sale_price || 0);
        goodsList[index].costPrice = goods.costPrice || goods.cost_price || goods.purchasePrice || goods.purchase_price || goods.importPrice || goods.import_price || goods.cost || goods.settlementPrice || goods.settlement_price || 0;
        goodsList[index].pnCode = goods.pnCode || pn;
        goodsList[index].needSn = needSn;
        if (!needSn) {
          goodsList[index].snCode = '';
          goodsList[index].inventoryId = '';
          goodsList[index].inventoryStatus = '';
          goodsList[index].previousSnStatus = '';
        }
        goodsList[index].showImei = String(goods.name || '').toLowerCase().includes('moto');
        this.setData({ goodsList });
        this.recalculateAmounts();
        this.fillSnOptionsByInventory(index, goodsList[index].productId, goodsList[index].pnCode);
      }
      if (options.showLoading) wx.hideLoading();
    });
  },

  getGoodsInfoBySN: function (sn, index, options = {}) {
    if (options.showLoading) wx.showLoading({ title: '查询中...' });
    DataStorage.getGoodsBySN(sn, (goods) => {
      if (goods && goods.name) {
        const goodsList = this.data.goodsList;
        goodsList[index].productId = goods.productId || goodsList[index].productId || '';
        const inventoryId = goods.inventoryId || goodsList[index].inventoryId || '';
        goodsList[index].inventoryId = inventoryId;
        goodsList[index].name = goods.name;
        goodsList[index].price = goods.price ? goods.price.toString() : '';
        goodsList[index].standardPrice = Number(goods.standardPrice || goods.standard_price || goods.productStandardPrice || goods.product_standard_price ||
          goods.Product?.standardPrice || goods.Product?.standard_price || 0);
        goodsList[index].minSalePrice = Number(goods.minSalePrice || goods.min_sale_price || goods.minimumSalePrice || goods.minimum_sale_price ||
          goods.minPrice || goods.min_price || goods.lowestSalePrice || goods.lowest_sale_price || goods.lowPrice || goods.low_price ||
          goods.Product?.minSalePrice || goods.Product?.min_sale_price || 0);
        goodsList[index].costPrice = goods.costPrice || goods.cost_price || goods.purchasePrice || goods.purchase_price || goods.importPrice || goods.import_price || goods.cost || goods.settlementPrice || goods.settlement_price || 0;
        goodsList[index].pnCode = goods.pnCode || goodsList[index].pnCode || '';
        goodsList[index].snCode = goods.snCode || sn;
        goodsList[index].inventoryStatus = goods.inventoryStatus || goods.status || '';
        goodsList[index].previousSnStatus = goodsList[index].inventoryStatus || goodsList[index].previousSnStatus || '在库';
        goodsList[index].needSn = this.isSnManagedGoods(goods);
        goodsList[index].showImei = String(goods.name || '').toLowerCase().includes('moto');
        this.setData({ goodsList });
        this.recalculateAmounts();
      }
      if (options.showLoading) wx.hideLoading();
    });
  },

  /**
   * 根据商品名称查询PN码（模糊查询）
   */
  searchPNByGoodsName: function (goodsName, index) {
    if (!goodsName || goodsName.trim() === '') {
      return;
    }

    wx.showLoading({ title: '查询中...' });

    // 构建模糊查询条件（支持空格分隔的关键词）
    const keywords = goodsName.trim().split(/\s+/).filter(k => k.length > 0);

    if (keywords.length === 0) {
      wx.hideLoading();
      return;
    }

    // 使用正则表达式查询商品名称
    this.searchGoodsByNameRegExp(keywords, index);
  },

  /**
   * 使用云函数搜索商品（支持多关键词）
   */
  searchGoodsByNameRegExp: function (keywords, index, options = {}) {
    const isLoadMore = options.loadMore === true;
    const pageSize = this.data.goodsSelectPageSize || 10;
    const page = isLoadMore ? (this.data.goodsSelectPage || 1) + 1 : 1;
    if (isLoadMore && (this.data.goodsSelectLoading || !this.data.goodsSelectHasMore)) return;
    this.setData({ goodsSelectLoading: true });
    wx.showLoading({ title: '查询中...' });

    console.log('搜索关键词:', keywords);

    // 使用云函数查询
    api.product.search(keywords.join(' '), {
      storeId: this.getCurrentStoreContext().storeId,
      activeOnly: 1,
      page,
      pageSize
    }).then(rows => {
      const pageRows = (rows || []).slice(0, pageSize);
      return {
        result: {
          code: 0,
          data: pageRows,
          pagination: { page, pageSize, hasMore: (rows || []).length >= pageSize }
        }
      };
    }).then(res => {
      wx.hideLoading();
      this.setData({ goodsSelectLoading: false });
      console.log('========== 商品名称查询结果 ==========');
      console.log('商品搜索 API 返回:', res);

      if (isLoadMore && (!res.result || !Array.isArray(res.result.data) || res.result.data.length === 0)) {
        this.setData({ goodsSelectHasMore: false, goodsSelectPage: page });
        return;
      }
      if (res.result && res.result.code === 0 && res.result.data && res.result.data.length > 0) {
        console.log('查询结果原始数据:', JSON.stringify(res.result.data));
        console.log('查询结果数量:', res.result.data.length);

        // 按PN剔重
        console.log('开始按PN剔重...');
        const pnMap = new Map();
        res.result.data.forEach((item, idx) => {
          const pn = item.pnCode || '';
          console.log(`[${idx}] name=${item.name}, pn=${pn}`);
          const productId = item.productId || item.product_id || '';
          const price = Number(item.price || item.standard_price || item.retailPrice || item.retail_price || 0);
          const standardPrice = Number(item.standardPrice || item.standard_price || item.productStandardPrice || item.product_standard_price ||
            item.Product?.standardPrice || item.Product?.standard_price || 0);
          const minSalePrice = Number(item.minSalePrice || item.min_sale_price || item.minimumSalePrice || item.minimum_sale_price ||
            item.minPrice || item.min_price || item.lowestSalePrice || item.lowest_sale_price || item.lowPrice || item.low_price ||
            item.Product?.minSalePrice || item.Product?.min_sale_price || 0);
          const settlementPrice = Number(item.settlementPrice || item.settlement_price || item.min_sale_price || price || 0);
          const costPrice = Number(item.costPrice || item.cost_price || item.purchasePrice || item.purchase_price || item.importPrice || item.import_price || item.cost || item.settlementPrice || item.settlement_price || item.min_sale_price || price || 0);
          const currentStoreStockQty = Number(item.currentStoreStockQty || item.current_store_stock_qty || item.normal_qty || item.stock || 0);
          const otherStoreStockQty = Number(item.otherStoreStockQty || item.other_store_stock_qty || 0);
          const totalStockQty = Number(item.totalStockQty || item.total_stock_qty || item.stock_qty || item.stock || currentStoreStockQty + otherStoreStockQty || 0);
          const needSn = item.needSn !== undefined ? item.needSn : (item.need_sn !== undefined ? item.need_sn : 0);
          if (pn && !pnMap.has(pn)) {
            console.log(`  -> 新PN，加入Map`);
            pnMap.set(pn, {
              name: item.name,
              productId,
              pnCode: pn,
              price,
              standardPrice,
              minSalePrice,
              settlementPrice,
              costPrice,
              needSn,
              currentStoreStockQty,
              otherStoreStockQty,
              totalStockQty,
              matchScore: 1
            });
          } else if (pn && pnMap.has(pn)) {
            // 同一PN可能同时从商品主表和库存接口返回，保留信息更完整的一条。
            const existing = pnMap.get(pn);
            if (!existing.productId && productId) existing.productId = productId;
            if (!existing.name && item.name) existing.name = item.name;
            if (!existing.price && price) existing.price = price;
            if (!existing.standardPrice && standardPrice) existing.standardPrice = standardPrice;
            if (!existing.minSalePrice && minSalePrice) existing.minSalePrice = minSalePrice;
            if (!existing.settlementPrice && settlementPrice) existing.settlementPrice = settlementPrice;
            if (!existing.costPrice && costPrice) existing.costPrice = costPrice;
            if (existing.needSn === undefined || existing.needSn === null) existing.needSn = needSn;
            existing.currentStoreStockQty = Math.max(Number(existing.currentStoreStockQty || 0), currentStoreStockQty);
            existing.otherStoreStockQty = Math.max(Number(existing.otherStoreStockQty || 0), otherStoreStockQty);
            existing.totalStockQty = Math.max(Number(existing.totalStockQty || 0), totalStockQty);
            console.log(`  -> PN ${pn} 已存在，合并商品信息`);
          } else {
            console.log(`  -> PN为空，跳过`);
          }
        });
        let matchedGoods = Array.from(pnMap.values());
        const pageInfo = (res.result && res.result.pagination) || {};
        const hasMore = pageInfo.hasMore !== undefined ? pageInfo.hasMore : res.result.data.length >= pageSize;
        if (isLoadMore) {
          matchedGoods = this.mergeGoodsSelectResults((this.data.goodsSelectList || []).concat(matchedGoods));
        }

        console.log('========== 剔重完成 ==========');
        console.log('剔重前数量:', res.result.data.length);
        console.log('剔重后数量:', matchedGoods.length);
        console.log('匹配到的商品:', JSON.stringify(matchedGoods));

        if (matchedGoods.length === 1 && !isLoadMore && !hasMore) {
          this.fillGoodsPN(matchedGoods[0], index);
        } else if (matchedGoods.length > 0 || isLoadMore) {
          this.showGoodsSelectModal(matchedGoods, index, {
            hasMore,
            page,
            keywords
          });
        } else {
          wx.showToast({
            title: '暂未收到对应的商品PN，请核对',
            icon: 'none',
            duration: 2000
          });
        }
      } else {
        wx.showToast({
          title: '暂未收到对应的商品PN，请核对',
          icon: 'none',
          duration: 2000
        });
      }
    }).catch(err => {
      wx.hideLoading();
      this.setData({ goodsSelectLoading: false });
      console.error('商品搜索 API 失败:', err);

      wx.showToast({
        title: '查询失败，请重试',
        icon: 'none',
        duration: 2000
      });
    });
  },

  /**
   * 显示商品选择弹窗（自定义弹窗，支持显示更多商品）
   */
  formatGoodsSelectItem: function (item) {
    const price = item.price || item.standard_price || 0;
    const standardPrice = Number(item.standardPrice || item.standard_price || item.productStandardPrice || item.product_standard_price ||
      item.Product?.standardPrice || item.Product?.standard_price || 0);
    const minSalePrice = Number(item.minSalePrice || item.min_sale_price || item.minimumSalePrice || item.minimum_sale_price ||
      item.minPrice || item.min_price || item.lowestSalePrice || item.lowest_sale_price || item.lowPrice || item.low_price ||
      item.Product?.minSalePrice || item.Product?.min_sale_price || 0);
    const settlementPrice = item.settlementPrice || item.settlement_price || item.min_sale_price || price || 0;
    const costPrice = item.costPrice || item.cost_price || item.purchasePrice || item.purchase_price || item.importPrice || item.import_price || item.cost || item.settlementPrice || item.settlement_price || item.min_sale_price || price || 0;
    const currentStoreStockQty = Number(item.currentStoreStockQty || item.current_store_stock_qty || 0);
    const otherStoreStockQty = Number(item.otherStoreStockQty || item.other_store_stock_qty || 0);
    const totalStockQty = Number(item.totalStockQty || item.total_stock_qty || item.stock_qty || item.stock || currentStoreStockQty + otherStoreStockQty || 0);
    return Object.assign({}, item, {
      pnCode: item.pnCode || '',
      price,
      standardPrice,
      standard_price: standardPrice,
      minSalePrice,
      min_sale_price: minSalePrice,
      settlementPrice,
      costPrice,
      settlementPriceText: Number(settlementPrice || 0).toFixed(2),
      currentStoreStockQty,
      otherStoreStockQty,
      totalStockQty,
      currentStoreStockText: currentStoreStockQty > 0 ? currentStoreStockQty : 0,
      totalStockText: totalStockQty > 0 ? totalStockQty : 0
    });
  },

  mergeGoodsSelectResults: function (goodsList) {
    const map = new Map();
    (goodsList || []).forEach(item => {
      const formatted = this.formatGoodsSelectItem(item);
      const key = `${formatted.productId || formatted.name || ''}|${formatted.pnCode || ''}`;
      if (key !== '|') map.set(key, formatted);
    });
    return Array.from(map.values());
  },

  loadMoreGoods: function () {
    if (this.data.goodsSelectLoading || !this.data.goodsSelectHasMore) return;
    this.searchGoodsByNameRegExp(this.data.goodsSelectKeywords || [], this.data.goodsSelectIndex, { loadMore: true });
  },

  showGoodsSelectModal: function (goodsList, index, options = {}) {
    const formattedList = this.mergeGoodsSelectResults(goodsList);

    this.setData({
      showGoodsSelectModal: true,
      goodsSelectList: formattedList,
      goodsSelectIndex: index,
      goodsSelectPage: options.page || 1,
      goodsSelectHasMore: options.hasMore === true,
      goodsSelectKeywords: options.keywords || this.data.goodsSelectKeywords || [],
      goodsSelectLoading: false
    });
  },

  /**
   * 关闭商品选择弹窗
   */
  closeGoodsSelectModal: function () {
    this.setData({
      showGoodsSelectModal: false,
      goodsSelectList: [],
      goodsSelectIndex: 0,
      goodsSelectPage: 1,
      goodsSelectHasMore: false,
      goodsSelectLoading: false,
      goodsSelectKeywords: []
    });
  },

  /**
   * 选择商品
   */
  selectGoods: function (e) {
    const selectedIndex = e.currentTarget.dataset.index;
    const selectedGoods = this.data.goodsSelectList[selectedIndex];
    const index = this.data.goodsSelectIndex;

    this.closeGoodsSelectModal();
    this.fillGoodsPN(selectedGoods, index);
  },

  /**
   * 填充商品PN码
   */
  fillGoodsPN: function (goods, index) {
    const goodsList = this.data.goodsList;
    const pnCode = goods.pnCode || '';
    const productId = goods.productId || '';
    goodsList[index].pnCode = pnCode;
    goodsList[index].productId = productId;
    goodsList[index].name = goods.name || goods.productName || goods.product_name || '';

    this.setData({
      goodsList: goodsList
    });

    wx.showToast({
      title: '已填充PN码',
      icon: 'success'
    });

    // 如果有PN码，继续查询商品信息获取价格
    if (pnCode) {
      this.getGoodsInfoByPN(pnCode, index);
    }
  },

  // ==================== 金额相关 ====================

  onDiscountInput: function (e) {
    this.setData({
      discount: this.limitDecimals(e.detail.value, 2)
    });
    this.recalculateAmounts();
  },

  onNationalSubsidyInput: function (e) {
    const value = this.limitDecimals(e.detail.value, 2);
    const nationalSubsidy = parseFloat(value) || 0;

    if (nationalSubsidy === 0) {
      this.setData({
        nationalSubsidy: value,
        subsidyStatus: '非国补'
      });
    } else {
      this.setData({
        nationalSubsidy: value,
        subsidyStatus: '国补',
        invoiceStatus: '开普票'
      });
    }
    this.recalculateAmounts();
  },

  onComputerSubsidyInput: function (e) {
    const value = this.limitDecimals(e.detail.value, 2);
    const computerAmount = parseFloat(value) || 0;
    let computerSubsidy = computerAmount * 0.15;
    if (computerSubsidy > 1500) computerSubsidy = 1500;

    const mobileAmount = parseFloat(this.data.mobileAmount) || 0;
    let mobileSubsidy = mobileAmount * 0.15;
    if (mobileSubsidy > 500) mobileSubsidy = 500;

    const totalNationalSubsidy = computerSubsidy + mobileSubsidy;

    this.setData({
      computerAmount: value,
      nationalSubsidy: totalNationalSubsidy.toFixed(2),
      subsidyStatus: totalNationalSubsidy > 0 ? '国补' : '非国补',
      invoiceStatus: totalNationalSubsidy > 0 ? '开普票' : this.data.invoiceStatus,
      invoiceAmount: totalNationalSubsidy > 0
        ? this.getDefaultInvoiceAmount(this.data.paymentMethods, '国补')
        : (this.data.invoiceStatus === '不开票' ? 0 : this.getDefaultInvoiceAmount(this.data.paymentMethods, '非国补'))
    });
    this.recalculateAmounts();
  },

  onMobileSubsidyInput: function (e) {
    const value = this.limitDecimals(e.detail.value, 2);
    const mobileAmount = parseFloat(value) || 0;
    let mobileSubsidy = mobileAmount * 0.15;
    if (mobileSubsidy > 500) mobileSubsidy = 500;

    const computerAmount = parseFloat(this.data.computerAmount) || 0;
    let computerSubsidy = computerAmount * 0.15;
    if (computerSubsidy > 1500) computerSubsidy = 1500;

    const totalNationalSubsidy = computerSubsidy + mobileSubsidy;

    this.setData({
      mobileAmount: value,
      nationalSubsidy: totalNationalSubsidy.toFixed(2),
      subsidyStatus: totalNationalSubsidy > 0 ? '国补' : '非国补',
      invoiceStatus: totalNationalSubsidy > 0 ? '开普票' : this.data.invoiceStatus,
      invoiceAmount: totalNationalSubsidy > 0
        ? this.getDefaultInvoiceAmount(this.data.paymentMethods, '国补')
        : (this.data.invoiceStatus === '不开票' ? 0 : this.getDefaultInvoiceAmount(this.data.paymentMethods, '非国补'))
    });
    this.recalculateAmounts();
  },

  onEducationSubsidyInput: function (e) {
    this.setData({
      educationSubsidy: this.limitDecimals(e.detail.value, 2)
    });
    this.recalculateAmounts();
  },

  limitDecimals: function (value, decimals = 2) {
    if (!value && value !== 0) return '';
    let str = value.toString();
    str = str.replace(/[^0-9.]/g, '');

    const firstDotIndex = str.indexOf('.');
    if (firstDotIndex !== -1) {
      const beforeDot = str.substring(0, firstDotIndex + 1);
      const afterDot = str.substring(firstDotIndex + 1).replace(/\./g, '');
      str = beforeDot + afterDot;
    }

    if (str.indexOf('.') !== -1) {
      const parts = str.split('.');
      if (parts[1] && parts[1].length > decimals) {
        return parts[0] + '.' + parts[1].substring(0, decimals);
      }
    }

    return str;
  },

  // ==================== 收款方式相关 ====================

  onPaymentMethodChange: function (e) {
    const index = e.currentTarget.dataset.index;
    const paymentMethodIndex = [...this.data.paymentMethodIndex];
    const paymentMethods = this.getEditablePaymentMethods(this.data.paymentMethods, index);

    paymentMethodIndex[index] = e.detail.value;
    paymentMethods[index].type = this.data.paymentMethodOptions[e.detail.value] || '';

    const updateData = {
      paymentMethods,
      paymentMethodIndex
    };
    if (this.data.subsidyStatus === '国补') {
      updateData.invoiceAmount = this.getDefaultInvoiceAmount(paymentMethods);
    }
    this.setData(updateData);
    this.recalculateAmounts();
  },

  onPaymentAmountInput: function (e) {
    const index = e.currentTarget.dataset.index;
    const paymentMethods = this.getEditablePaymentMethods(this.data.paymentMethods, index);

    paymentMethods[index].amount = this.limitDecimals(e.detail.value, 2);
    const updateData = { paymentMethods };
    if (this.data.subsidyStatus === '国补') {
      updateData.invoiceAmount = this.getDefaultInvoiceAmount(paymentMethods);
    }
    this.setData(updateData);
    this.recalculateAmounts();
  },

  addPaymentMethod: function () {
    const paymentMethods = [...this.data.paymentMethods];
    const paymentMethodIndex = [...this.data.paymentMethodIndex];

    paymentMethods.push({ type: '', amount: '' });
    paymentMethodIndex.push(-1);

    this.setData({
      paymentMethods,
      paymentMethodIndex
    });
  },

  removePaymentMethod: function (e) {
    const index = e.currentTarget.dataset.index;

    if (this.data.paymentMethods.length <= 1) {
      wx.showToast({
        title: '至少保留一种收款方式',
        icon: 'none'
      });
      return;
    }

    const paymentMethods = [...this.data.paymentMethods];
    const paymentMethodIndex = [...this.data.paymentMethodIndex];

    paymentMethods.splice(index, 1);
    paymentMethodIndex.splice(index, 1);

    this.setData({
      paymentMethods,
      paymentMethodIndex
    });
    this.recalculateAmounts();
  },

  // ==================== 辅助销售人相关 ====================

  onAuxiliarySalesChange: function (e) {
    const index = e.currentTarget.dataset.index;
    const optionIndex = Number(e.detail.value || 0);
    const selectedDisplay = this.data.auxiliarySalesOptions[optionIndex] || '无';
    const selectedStaff = (this._auxiliarySalesStaffOptions || [])[optionIndex] || null;
    const auxiliarySalesIndex = [...this.data.auxiliarySalesIndex];
    const auxiliarySalesList = [...this.data.auxiliarySalesList];

    auxiliarySalesIndex[index] = optionIndex;
    auxiliarySalesList[index] = Object.assign({}, auxiliarySalesList[index], {
      selected: selectedStaff ? selectedStaff.name : '无',
      selectedDisplay,
      optionIndex,
      staffId: selectedStaff ? selectedStaff.staffId : '',
      phone: selectedStaff ? selectedStaff.phone : '',
      storeId: selectedStaff ? selectedStaff.storeId : '',
      storeName: selectedStaff ? selectedStaff.storeName : '',
      regionId: selectedStaff ? selectedStaff.regionId : ''
    });

    this.setData({
      auxiliarySalesList,
      auxiliarySalesIndex
    });
  },

  onAuxiliarySalesAmountInput: function (e) {
    const index = e.currentTarget.dataset.index;
    const auxiliarySalesList = [...this.data.auxiliarySalesList];

    auxiliarySalesList[index].profitAmount = this.limitDecimals(e.detail.value, 2);
    this.setData({ auxiliarySalesList });
  },

  calculateDefaultRatio: function (totalPeople) {
    if (totalPeople === 2) return 50;
    if (totalPeople === 3) return 33;
    return 0;
  },

  addAuxiliarySales: function () {
    const auxiliarySalesList = [...this.data.auxiliarySalesList];
    const auxiliarySalesIndex = [...this.data.auxiliarySalesIndex];
    const newTotalPeople = 1 + auxiliarySalesList.length + 1;
    const willExceedLimit = auxiliarySalesList.length >= 2;
    const defaultRatio = willExceedLimit ? 0 : this.calculateDefaultRatio(newTotalPeople);

    if (!willExceedLimit) {
      auxiliarySalesList.forEach(item => {
        item.ratio = defaultRatio;
      });
    }

    auxiliarySalesList.push({
      selected: '无',
      selectedDisplay: '无',
      optionIndex: 0,
      profitAmount: 0,
      ratio: defaultRatio
    });
    auxiliarySalesIndex.push(0);

    this.setData({
      auxiliarySalesList,
      auxiliarySalesIndex
    });
  },

  removeAuxiliarySales: function (e) {
    const index = e.currentTarget.dataset.index;
    const auxiliarySalesList = [...this.data.auxiliarySalesList];
    const auxiliarySalesIndex = [...this.data.auxiliarySalesIndex];

    if (auxiliarySalesList[index] && auxiliarySalesList[index].isMainSales) {
      wx.showToast({ title: '主销售人不能删除', icon: 'none' });
      return;
    }

    auxiliarySalesList.splice(index, 1);
    auxiliarySalesIndex.splice(index, 1);

    this.setData({
      auxiliarySalesList,
      auxiliarySalesIndex
    });
  },

  // ==================== 开票信息相关 ====================

  onInvoiceStatusChange: function (e) {
    const value = e.detail.value;

    if (this.data.subsidyStatus === '国补' && (value === '不开票' || value === '开专票')) {
      wx.showToast({
        title: '国补订单必须开普票',
        icon: 'none'
      });
      return;
    }

    this.setData({
      invoiceStatus: value,
      invoiceAmount: value === '不开票' ? 0 : this.getDefaultInvoiceAmount(this.data.paymentMethods)
    });
  },

  onInvoiceInfoInput: function (e) {
    this.setData({ invoiceInfo: e.detail.value });
  },

  onInvoiceAmountInput: function (e) {
    this.setData({
      invoiceAmount: this.limitDecimals(e.detail.value, 2)
    });
  },

  // ==================== 国补信息相关 ====================

  onSubsidyPersonInput: function (e) {
    this.setData({ subsidyPerson: e.detail.value });
  },

  onSubsidyIdInput: function (e) {
    let value = e.detail.value.replace(/[^0-9]/g, '');
    if (value.length > 11) value = value.substring(0, 11);
    this.setData({ subsidyId: value });
  },

  /**
   * 国补状态变化处理
   */
  onSubsidyStatusChange: function (e) {
    const value = e.detail.value;
    const { order, subsidyPerson, subsidyId } = this.data;

    // 如果选择了国补，自动设置开票状态为开普票，并同步国补人信息
    if (value === '国补') {
      const updateData = {
        subsidyStatus: value,
        invoiceStatus: '开普票',
        invoiceAmount: this.getDefaultInvoiceAmount(this.data.paymentMethods, '国补')
      };

      // 如果国补人姓名为空，则同步会员称呼
      if (!subsidyPerson && order.contactName) {
        updateData.subsidyPerson = order.contactName;
      }

      // 如果国补人ID为空，则同步会员ID
      if (!subsidyId && order.contactMethod) {
        updateData.subsidyId = order.contactMethod;
      }

      this.setData(updateData);
    } else {
      this.setData({
        subsidyStatus: value,
        invoiceAmount: this.data.invoiceStatus === '不开票' ? 0 : this.getDefaultInvoiceAmount(this.data.paymentMethods),
        // 取消国补时清空国补人信息
        subsidyPerson: '',
        subsidyId: ''
      });
    }
  },

  // ==================== 照片相关 ====================

  previewPhoto: function (e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;

    const urls = [
      ...this.data.subsidyPhotos.map(p => p && (p.displayUrl || p.url)).filter(u => u),
      ...(this.data.productPhotoDisplayUrls || this.data.productPhotoUrls).filter(u => u),
      this.data.educationSubsidyPhotoDisplayUrl || this.data.educationSubsidyPhotoUrl,
      this.data.personalInfoPhoto && (this.data.personalInfoPhoto.displayUrl || this.data.personalInfoPhoto.url)
    ];
    const availableUrls = [...new Set(urls.filter(Boolean))];

    wx.previewImage({
      current: url,
      urls: availableUrls.length > 0 ? availableUrls : [url]
    });
  },

  reuploadSubsidyPhoto: function (e) {
    const index = e.currentTarget.dataset.index;
    this.chooseAndUploadPhoto('subsidy', index);
  },

  deleteSubsidyPhoto: function (e) {
    const index = e.currentTarget.dataset.index;
    const subsidyPhotos = [...this.data.subsidyPhotos];

    wx.showModal({
      title: '确认删除',
      content: '确定要删除这张照片吗？',
      success: (res) => {
        if (res.confirm) {
          subsidyPhotos[index].url = '';
          subsidyPhotos[index].displayUrl = '';
          this.setData({
            subsidyPhotos,
            hasSubsidyPhotos: subsidyPhotos.some(photo => photo && photo.url)
          });
        }
      }
    });
  },

  addProductPhoto: function () {
    this.chooseAndUploadPhoto('product');
  },

  uploadProductPhoto: function () {
    this.chooseAndUploadPhoto('product');
  },

  uploadEducationSubsidyPhoto: function () {
    this.chooseAndUploadPhoto('education');
  },

  reuploadProductPhoto: function (e) {
    const index = e.currentTarget.dataset.index;
    this.chooseAndUploadPhoto('product', index);
  },

  deleteProductPhoto: function (e) {
    const index = e.currentTarget.dataset.index;
    const productPhotoUrls = [...this.data.productPhotoUrls];

    wx.showModal({
      title: '确认删除',
      content: '确定要删除这张照片吗？',
      success: (res) => {
        if (res.confirm) {
          productPhotoUrls.splice(index, 1);
          const productPhotoDisplayUrls = [...(this.data.productPhotoDisplayUrls || [])];
          productPhotoDisplayUrls.splice(index, 1);
          this.setData({ productPhotoUrls, productPhotoDisplayUrls });
        }
      }
    });
  },

  deleteEducationSubsidyPhoto: function () {
    wx.showModal({
      title: '确认删除',
      content: '确定要删除教育补贴核销凭证吗？',
      success: (res) => {
        if (res.confirm) {
          this.setData({
            educationSubsidyPhotoUrl: '',
            educationSubsidyPhotoDisplayUrl: '',
            educationSubsidyCouponCode: ''
          });
        }
      }
    });
  },

  scanEducationSubsidyCoupon: function () {
    wx.scanCode({
      success: (res) => {
        const couponCode = String(res.result || '').trim();
        if (!couponCode) {
          wx.showToast({
            title: '未获取到券码',
            icon: 'none'
          });
          return;
        }

        this.setData({
          educationSubsidyCouponCode: couponCode
        });
        wx.showToast({
          title: '扫码成功',
          icon: 'success'
        });
      },
      fail: (err) => {
        console.error('教育补贴券码扫码失败:', err);
        wx.showToast({
          title: '扫码失败，请重试',
          icon: 'none'
        });
      }
    });
  },

  onEducationSubsidyCouponInput: function (e) {
    this.setData({
      educationSubsidyCouponCode: e.detail.value
    });
  },

  chooseAndUploadPhoto: function (type, index = -1) {
    // 检查国补状态，如果是国补但国补人姓名为空，则不允许上传国补照片
    if (type === 'subsidy') {
      const { subsidyStatus, subsidyPerson } = this.data;
      if (subsidyStatus === '国补' && !subsidyPerson) {
        wx.showModal({
          title: '提示',
          content: '请先输入国补人姓名后再上传国补照片',
          showCancel: false,
          confirmText: '知道了'
        });
        return;
      }
    }

    wx.chooseImage({
      count: 1,
      sizeType: ['original'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const tempFilePath = res.tempFilePaths[0];
        this.uploadPhoto(type, tempFilePath, index);
      }
    });
  },

  uploadPhoto: function (type, filePath, index) {
    wx.showLoading({ title: '上传中...' });

    const now = new Date();
    const dateTimeStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;

    const orderNo = this.data.orderNo;

    // 获取照片标题（用于国补照片命名）
    let photoTitle = '';
    if (type === 'subsidy' && index >= 0 && this.data.subsidyPhotos[index]) {
      photoTitle = this.data.subsidyPhotos[index].name || '照片';
    } else if (type === 'education') {
      photoTitle = '教育补贴核销凭证';
    }

    // 过滤文件名中的特殊字符（包括空格和+号，避免URL编码问题）
    const sanitizeFileName = (str) => {
      return str.replace(/[\\/:*?"<>|、，,\s+]/g, '');
    };

    // 获取商品列表中单价最高的SN码
    let highestSnCode = '';
    const goodsList = this.data.goodsList || [];
    if (goodsList.length > 0) {
      let maxPrice = -1;
      let highestPriceItem = null;
      goodsList.forEach(item => {
        const price = parseFloat(item.price) || 0;
        if (price > maxPrice) {
          maxPrice = price;
          highestPriceItem = item;
        }
      });
      if (highestPriceItem && highestPriceItem.snCode) {
        highestSnCode = highestPriceItem.snCode;
      }
    }

    // 构建文件名（包含订单号和最高单价商品的SN码）
    let cloudPath = '';
    if (type === 'subsidy') {
      const subsidyPerson = this.data.subsidyPerson || this.data.order.contactName || '未知客户';
      const photoName = `${dateTimeStr}_${sanitizeFileName(subsidyPerson)}_${sanitizeFileName(photoTitle)}.jpg`;
      cloudPath = `orders/${orderNo}/subsidy_${photoName}`;
    } else if (type === 'education') {
      cloudPath = `orders/${orderNo}/education_${dateTimeStr}_${Date.now()}.jpg`;
    } else {
      let fileName = `product_${orderNo}`;
      if (highestSnCode) {
        fileName += `_${highestSnCode}`;
      }
      fileName += `_${dateTimeStr}_${Date.now()}.jpg`;
      cloudPath = `orders/${orderNo}/${fileName}`;
    }

    wx.cloud.uploadFile({
      cloudPath,
      filePath
    }).then(res => {
      wx.hideLoading();

      if (type === 'subsidy') {
        const subsidyPhotos = [...this.data.subsidyPhotos];
        if (index >= 0) {
          subsidyPhotos[index].url = res.fileID;
        }
        this.setData({ subsidyPhotos, hasSubsidyPhotos: true });
      } else if (type === 'education') {
        this.setData({ educationSubsidyPhotoUrl: res.fileID });
      } else {
        const productPhotoUrls = [...this.data.productPhotoUrls];
        if (index >= 0) {
          productPhotoUrls[index] = res.fileID;
        } else {
          productPhotoUrls.push(res.fileID);
        }
        this.setData({ productPhotoUrls });
      }

      this.refreshPhotoDisplayUrls();

      wx.showToast({
        title: '上传成功',
        icon: 'success'
      });
    }).catch(err => {
      wx.hideLoading();
      console.error('上传失败:', err);
      wx.showToast({
        title: '上传失败',
        icon: 'none'
      });
    });
  },

  // ==================== 补录记录相关 ====================

  deleteSupplement: function (e) {
    const index = e.currentTarget.dataset.index;

    wx.showModal({
      title: '确认删除',
      content: '确定要删除这条补录记录吗？',
      success: (res) => {
        if (res.confirm) {
          this.doDeleteSupplement(index);
        }
      }
    });
  },

  doDeleteSupplement: function (index) {
    wx.showLoading({ title: '删除中...' });

    const supplements = [...this.data.supplements];
    supplements.splice(index, 1);

    const order = this.data.order || {};
    const orderId = order.orderId || order.order_id || order._id;
    if (!orderId) {
      wx.hideLoading();
      wx.showToast({ title: '订单信息不完整，请刷新后重试', icon: 'none' });
      return;
    }

    const newSupplementTotal = supplements.reduce((sum, item) => {
      const amount = Number(item.amount || 0);
      const amountType = item.amountType || item.amount_type;
      return sum + (amountType === 'decrease' ? -amount : amount);
    }, 0);

    api.order.updateSupplements(orderId, supplements).then(() => {
      wx.hideLoading();
      this.setData({ supplements, supplementTotal: newSupplementTotal });
      wx.showToast({ title: '删除成功', icon: 'success' });
    }).catch(err => {
      wx.hideLoading();
      console.error('删除补录记录失败:', err);
      wx.showToast({
        title: '删除失败',
        icon: 'none'
      });
    });
  },

  // ==================== 归档相关 ====================

  normalizeEditableGoodsItem: function (item) {
    const normalized = normalizeEditableOrderItem(item || {});
    return Object.assign({}, normalized, {
      name: normalized.productName,
      price: String(normalized.unitPrice),
      quantity: String(normalized.quantity),
      inventoryStatusLabel: normalized.inventoryStatusLabel || normalized.inventoryStatus || '',
      showImei: String(normalized.productName || '').toLowerCase().includes('moto')
    });
  },

  getArchiveSnCode: function (item) {
    return normalizeSnCode(item && item.snCode);
  },

  getArchivePnCode: function (item) {
    const pnCode = item.pnCode || '';
    return String(pnCode || '').trim();
  },

  isSnManagedGoods: function (item) {
    const value = item.needSn;
    if (value === true || value === 1) return true;
    return ['1', 'true', 'yes'].indexOf(String(value || '').trim().toLowerCase()) >= 0;
  },

  isArchiveSellableStock: function (stockItem, orderItem = {}) {
    const status = stockItem.status !== undefined && stockItem.status !== ''
      ? stockItem.status
      : (stockItem.inventoryStatus !== undefined && stockItem.inventoryStatus !== ''
        ? stockItem.inventoryStatus
        : stockItem.inventory_status);

    if (status === undefined || status === null || status === '') return true;
    if (status === true || status === 1) return true;

    const normalized = String(status).trim().toLowerCase();
    if (['reserved', 'occupied', '已占用'].indexOf(normalized) >= 0) {
      const orderStatus = String(orderItem.inventoryStatus || orderItem.inventory_status || '').trim().toLowerCase();
      return ['reserved', 'occupied', '已占用'].indexOf(orderStatus) >= 0;
    }
    return ['1', 'in_stock', 'instock', 'available', 'normal', 'sellable', 'on_hand', '在库', '可售'].indexOf(normalized) >= 0;
  },

  validateArchiveGoods: function () {
    const goodsList = (this.data.goodsList || []).filter(item => !isEmptyOrderItem(item));
    const order = this.data.order || {};
    const tempStoreInfo = wx.getStorageSync('tempStoreInfo') || {};
    const userInfo = wx.getStorageSync('userInfo') || {};
    const orderStoreId = order.storeId || order.store_id || '';
    const selectedStoreId = userUtils.isStoreScoped(userInfo)
      ? (tempStoreInfo.storeId || tempStoreInfo.store_id || tempStoreInfo.id || tempStoreInfo._id || '')
      : '';
    const storeId = orderStoreId || selectedStoreId || (userUtils.isStoreScoped(userInfo) ? userInfo.storeId || '' : '');
    const seenSn = {};

    const prepareGoods = Promise.all(goodsList.map(item => {
      if (this.getArchivePnCode(item) || !item.productId) return Promise.resolve(item);
      return api.product.getPns(item.productId, storeId)
        .then(rows => {
          const pnCode = (rows || []).map(row => this.getArchivePnCode(row)).find(Boolean) || '';
          if (pnCode) item.pnCode = pnCode;
          return item;
        })
        .catch(() => item);
    }));

    return prepareGoods.then(preparedGoods => {
    const checks = preparedGoods.map((item, index) => {
      const pnCode = this.getArchivePnCode(item);
      const snCode = this.getArchiveSnCode(item);
      if (!pnCode) {
        const label = item.productName || item.name || item.productId || '';
        return Promise.reject(new Error(label
          ? `商品${index + 1}（${label}）缺少PN码，不能归档`
          : `商品${index + 1}没有商品ID和PN码，不能归档`));
      }

      if (snCode) {
        const normalizedSn = snCode.toLowerCase();
        if (seenSn[normalizedSn]) {
          return Promise.reject(new Error(`商品${index + 1}的SN码与其他商品重复`));
        }
        seenSn[normalizedSn] = true;
      }

      return api.inventory.getGoodsByPN(pnCode, storeId).then(product => {
        const productPnCode = this.getArchivePnCode(product || {});
        if (!product || !productPnCode || productPnCode.toLowerCase() !== pnCode.toLowerCase()) {
          throw new Error(`商品${index + 1}的PN码不存在`);
        }

          item.pnCode = productPnCode;
        item.productId = item.productId || product.productId || '';
        if (product.needSn !== undefined) {
          item.needSn = product.needSn;
        }

        if (!snCode) {
          if (this.isSnManagedGoods(item)) {
            throw new Error(`请先填写商品${index + 1}的SN码`);
          }
          return null;
        }

        const productId = item.productId || product.productId || '';
        return api.inventory.getGoodsBySN(snCode, storeId, productId)
          .then(stockItem => {
            if (stockItem || !storeId) return stockItem;
            return api.inventory.getGoodsBySN(snCode, '', productId);
          })
          .then(stockItem => {
          const stockSnCode = this.getArchiveSnCode(stockItem || {});
          const stockPnCode = this.getArchivePnCode(stockItem || {});
          const stockStoreId = stockItem && stockItem.storeId;
          if (!stockItem || !stockSnCode || stockSnCode.toLowerCase() !== snCode.toLowerCase()) {
            throw new Error(`商品${index + 1}的SN码不存在`);
          }
          if (stockPnCode && stockPnCode.toLowerCase() !== productPnCode.toLowerCase()) {
            throw new Error(`商品${index + 1}的SN码与PN码不匹配`);
          }
          if (stockStoreId && storeId && String(stockStoreId) !== String(storeId)) {
            throw new Error(`商品${index + 1}的SN码不属于当前门店`);
          }
          if (!this.isArchiveSellableStock(stockItem, item)) {
            throw new Error(`商品${index + 1}的SN码当前不可售`);
          }

          const inventoryId = stockItem.inventoryId || '';
          item.snCode = stockSnCode;
          item.inventoryId = inventoryId;
          return stockItem;
          });
      });
    });

    return Promise.all(checks);
    });
  },

  validateArchiveRequiredFields: function () {
    if (this.data.subsidyStatus !== '国补') return true;

    if (!String(this.data.invoiceInfo || '').trim()) {
      wx.showToast({ title: '归档前请输入云闪付订单号', icon: 'none' });
      return false;
    }

    const hasSubsidyPhoto = (this.data.subsidyPhotos || []).some(photo => {
      if (typeof photo === 'string') return Boolean(photo.trim());
      if (!photo) return false;
      return Boolean(String(photo.url || photo.fileID || photo.fileId || photo.displayUrl || '').trim());
    });
    if (!hasSubsidyPhoto) {
      wx.showToast({ title: '归档前请上传国补照片', icon: 'none' });
      return false;
    }

    return true;
  },

  onArchiveChange: function (e) {
    const checked = e.detail.value;

    if (checked) {
      if (!this.validateArchiveRequiredFields()) {
        this.setData({ isArchived: false });
        return;
      }

      // 验证客户来源
      if (!this.data.order.customerSource) {
        wx.showToast({ title: '请先选择客户来源', icon: 'none' });
        this.setData({ isArchived: false });
        return;
      }

      // 验证PN码
      const goodsList = (this.data.goodsList || []).filter(item => !isEmptyOrderItem(item));
      for (let i = 0; i < goodsList.length; i++) {
        const item = goodsList[i];
        const pnCodeStr = item.pnCode ? String(item.pnCode).trim() : '';
        if (!pnCodeStr && !item.productId) {
          wx.showToast({ title: `请先填写商品${i + 1}的PN码`, icon: 'none' });
          this.setData({ isArchived: false });
          return;
        }
      }

      // 验证开票金额（如果需要开票）
      const { invoiceStatus, invoiceAmount, totalAmount } = this.data;
      if (invoiceStatus === '开专票' || invoiceStatus === '开普票') {
        const invoiceAmountNum = parseFloat(invoiceAmount);
        const totalAmountNum = parseFloat(totalAmount);

        if (!invoiceAmount || isNaN(invoiceAmountNum)) {
          wx.showToast({ title: '请填写开票金额', icon: 'none' });
          this.setData({ isArchived: false });
          return;
        }

        if (invoiceAmountNum > totalAmountNum) {
          wx.showToast({ title: '开票金额不能大于订单总金额', icon: 'none' });
          this.setData({ isArchived: false });
          return;
        }
      }

      this.setData({
        showArchiveModal: true,
        archiveNeedsApproval: false
      });
    } else {
      this.setData({ isArchived: false });
    }
  },

  closeArchiveModal: function () {
    this.setData({
      showArchiveModal: false,
      isArchived: false,
      archiveNeedsApproval: false
    });
  },

  confirmArchive: function () {
    if (!this.validateArchiveRequiredFields()) {
      this.setData({ showArchiveModal: false, isArchived: false });
      return;
    }

    // 验证客户来源
    if (!this.data.order.customerSource) {
      wx.showToast({ title: '请先选择客户来源', icon: 'none' });
      this.setData({ showArchiveModal: false, isArchived: false });
      return;
    }

    // 验证PN码
    const goodsList = (this.data.goodsList || []).filter(item => !isEmptyOrderItem(item));
    for (let i = 0; i < goodsList.length; i++) {
      const item = goodsList[i];
      const pnCodeStr = item.pnCode ? String(item.pnCode).trim() : '';
      if (!pnCodeStr && !item.productId) {
        wx.showToast({ title: `请先填写商品${i + 1}的PN码`, icon: 'none' });
        this.setData({ showArchiveModal: false, isArchived: false });
        return;
      }
    }

    // 验证开票金额（如果需要开票）
    const { invoiceStatus, invoiceAmount, totalAmount } = this.data;
    if (invoiceStatus === '开专票' || invoiceStatus === '开普票') {
      const invoiceAmountNum = parseFloat(invoiceAmount);
      const totalAmountNum = parseFloat(totalAmount);

      if (!invoiceAmount || isNaN(invoiceAmountNum)) {
        wx.showToast({ title: '请填写开票金额', icon: 'none' });
        this.setData({ showArchiveModal: false, isArchived: false });
        return;
      }

      if (invoiceAmountNum > totalAmountNum) {
        wx.showToast({ title: '开票金额不能大于订单总金额', icon: 'none' });
        this.setData({ showArchiveModal: false, isArchived: false });
        return;
      }
    }

    wx.showLoading({ title: '校验PN/SN中...' });

    this.validateArchiveGoods()
      .then(() => {
        wx.showLoading({ title: '归档校验中...' });
        return api.call('queryOrders', 'updateOrderStatus', {
          orderId: this.data.order.orderId || this.data.order._id || this.data.order.order_id || '',
          orderNo: this.data.orderNo,
          // 归档与负毛利审批由 ANY-ERP 统一判断；小程序只提交当前订单状态。
          status: '已归档',
          items: this.data.goodsList,
          goods: this.data.goodsList,
          depositItems: this.data.depositItems || [],
          deposits: this.data.depositItems || [],
          invoiceStatus: this.data.invoiceStatus,
          invoiceInfo: this.data.invoiceInfo,
          invoiceAmount: this.data.invoiceAmount,
          subsidyPhotos: this.data.subsidyPhotos || [],
          actualAmount: this.data.actualAmount,
          totalAmount: this.data.totalAmount,
          discount: this.data.discount,
        });
      })
      .then((res) => {
        wx.hideLoading();

        const resultData = res && res.result ? (res.result.data || {}) : (res?.data || res || {});
        const pendingApproval = resultData.pendingApproval === true || resultData.status === 'pending_approval';
        if (pendingApproval) {
          this.setData({
            'order.status': 'pending_approval',
            isArchived: false,
            canEdit: false,
            showArchiveModal: false,
            archiveNeedsApproval: false
          });
          wx.showToast({
            title: resultData.message || '负毛利订单已提交审批',
            icon: 'none',
            duration: 2500
          });
          return;
        }

        this.setData({
          'order.status': '已归档',
          isArchived: true,
          canEdit: false,
          showArchiveModal: false
        });

        wx.showToast({
          title: '归档成功',
          icon: 'success'
        });
      })
      .catch((err) => {
        wx.hideLoading();
        wx.showToast({
          title: '归档失败：' + (err && err.message ? err.message : err),
          icon: 'none'
        });
        this.setData({
          isArchived: false,
          showArchiveModal: false
        });
      });
  },

  // ==================== 保存订单 ====================

  saveOrder: function () {
    if (this.data.isSaving) return;

    // 验证
    if (!this.validateForm()) return;

    this.setData({ isSaving: true });
    wx.showLoading({ title: '保存中...' });

    const orderData = this.generateOrderData();
    console.log('保存订单数据:', JSON.stringify(orderData));

    const currentUserInfo = userUtils.getUserInfo();
    const storeContext = this.getCurrentStoreContext();

    wx.cloud.callFunction({
      name: 'updateOrder',
      data: {
        orderNo: this.data.orderNo,
        orderData: orderData,
        userRole: currentUserInfo.role || currentUserInfo.userRole,
        userName: currentUserInfo.userName,
        storeId: storeContext.storeId
      }
    }).then(res => {
      wx.hideLoading();
      this.setData({ isSaving: false });

      if (res.result && res.result.code === 0) {
        this.saveLocalOrderOverride(this.data.orderNo, orderData);

        wx.showToast({
          title: '保存成功',
          icon: 'success'
        });

        // 更新原始数据
        this.setData({
          order: Object.assign({}, this.data.order, orderData),
          originalData: JSON.parse(JSON.stringify(orderData))
        });
      } else {
        wx.showToast({
          title: res.result?.message || '保存失败',
          icon: 'none'
        });
      }
    }).catch(err => {
      wx.hideLoading();
      this.setData({ isSaving: false });
      console.error('保存订单失败:', err);
      wx.showToast({
        title: '保存失败，请重试',
        icon: 'none'
      });
    });
  },

  /**
   * 验证表单
   */
  validateForm: function () {
    const { goodsList, order, paymentMethods, subsidyStatus, subsidyPerson, subsidyId, isArchived, canEdit } = this.data;

    // 如果是已归档订单且没有完整编辑权限，只验证特殊字段
    if (isArchived && !canEdit) {
      // 验证国补信息（如果订单是国补状态）
      if (subsidyStatus === '国补') {
        if (!subsidyPerson || !subsidyPerson.trim()) {
          wx.showToast({ title: '请输入国补人姓名', icon: 'none' });
          return false;
        }
        if (!subsidyId || !/^\d{11}$/.test(subsidyId)) {
          wx.showToast({ title: '请输入11位国补人ID', icon: 'none' });
          return false;
        }
      }
      return true;
    }

    // 验证客户来源
    if (!order.customerSource) {
      wx.showToast({ title: '请选择客户来源', icon: 'none' });
      return false;
    }

    // 验证商品
    for (let i = 0; i < goodsList.length; i++) {
      const item = goodsList[i];
      const pnCodeStr = item.pnCode ? String(item.pnCode).trim() : '';
      if (!pnCodeStr) {
        wx.showToast({ title: `请输入商品${i + 1}的PN码`, icon: 'none' });
        return false;
      }
    }

    // 验证收款方式
    for (let i = 0; i < paymentMethods.length; i++) {
      const method = paymentMethods[i];
      if (!method.type) {
        wx.showToast({ title: `请选择收款方式${i + 1}`, icon: 'none' });
        return false;
      }
      if (!method.amount || parseFloat(method.amount) <= 0) {
        wx.showToast({ title: `请输入收款金额${i + 1}`, icon: 'none' });
        return false;
      }
    }

    // 验证国补信息
    if (subsidyStatus === '国补') {
      if (!subsidyPerson || !subsidyPerson.trim()) {
        wx.showToast({ title: '请输入国补人姓名', icon: 'none' });
        return false;
      }
      if (!subsidyId || !/^\d{11}$/.test(subsidyId)) {
        wx.showToast({ title: '请输入11位国补人ID', icon: 'none' });
        return false;
      }
    }

    // 验证金额平衡
    const diff = parseFloat(this.data.differenceAmount);
    if (Math.abs(diff) > 0.01) {
      wx.showModal({
        title: '金额不平衡',
        content: `应收金额与收款汇总差额为¥${diff.toFixed(2)}，请核对后再保存。`,
        showCancel: false
      });
      return false;
    }

    return true;
  },

  /**
   * 生成订单数据
   */
  generateOrderData: function () {
    const { order, goodsList, paymentMethods, auxiliarySalesList, isArchived, canEdit, depositItems } = this.data;

    // 如果是已归档订单且没有完整编辑权限，只返回允许修改的特殊字段
    if (isArchived && !canEdit) {
      return {
        orderNo: this.data.orderNo,
        // 国补人信息和照片
        subsidyPerson: this.data.subsidyStatus === '国补' ? (this.data.subsidyPerson || this.data.order.contactName || '') : this.data.subsidyPerson,
        subsidyId: this.data.subsidyStatus === '国补' ? (this.data.subsidyId || this.data.order.contactMethod || '') : this.data.subsidyId,
        subsidyStatus: this.data.subsidyStatus,
        subsidyPhotos: this.data.subsidyPhotos,
        productPhotoUrls: this.data.productPhotoUrls,
        educationSubsidyPhotoUrl: this.data.educationSubsidyPhotoUrl,
        educationSubsidyCouponCode: this.data.educationSubsidyCouponCode,
        personalInfoPhoto: this.data.personalInfoPhoto,
        // 开票信息
        invoiceStatus: this.data.invoiceStatus,
        invoiceInfo: this.data.invoiceInfo,
        invoiceAmount: (this.data.subsidyStatus === '国补' && !this.data.invoiceAmount)
          ? this.getDefaultInvoiceAmount(this.data.paymentMethods)
          : this.data.invoiceAmount,

        updateTime: new Date().getTime(),
        updateUser: userUtils.getUserInfo().userName
      };
    }

    // 处理商品来源：一、二级来源只保留在金额最高的商品中，其他商品清空
    const processedGoodsList = this.processGoodsSourceForHighestPrice(
      goodsList,
      order.customerSource,
      order.customerSourceDetail
    );
    const canonicalProcessedGoodsList = processedGoodsList.map(item => normalizeEditableOrderItem(item));

    return {
      orderNo: this.data.orderNo,
      customerSource: order.customerSource,
      customerSourceDetail: order.customerSourceDetail,
      contactName: order.contactName,
      contactMethod: order.contactMethod,

      // 商品列表 - 使用items字段名与数据库保持一致
      items: processedGoodsList.map(item => {
        const snCode = String(item.snCode || item.sn_code || item.sn || item.SN || '').trim();
        const pnCode = String(item.pnCode || '').trim();
        // SN码是业务编码，不能在没有真实库存记录ID时冒充 inventoryId。
        // 否则编辑商品后保存会把SN文本写入库存ID，导致明细匹配和库存同步沿用旧状态。
        const inventoryId = String(item.inventoryId || item.inventory_id || item.snId || item.sn_id || item.inventorySnId || item.inventory_sn_id || '').trim();
        const previousSnStatus = item.previousSnStatus || item.previous_sn_status || item.inventoryStatus || item.inventory_status || item.status || '在库';
        const price = parseFloat(item.price || item.unitPrice || item.salePrice || 0) || 0;
        const quantity = parseFloat(item.quantity) || 1;

        return {
          itemId: item.itemId || item.item_id || item._id || item.id || '',
          productId: item.productId || item.product_id || '',
          inventoryId: inventoryId,
          pnCode: pnCode,
          snCode: snCode,
          previousSnStatus: previousSnStatus,
          productName: item.name || item.productName || item.product_name || '',
          name: item.name || item.productName || item.product_name || '',
          unitPrice: price,
          price: price,
          standardPrice: Number(item.standardPrice || item.standard_price || item.productStandardPrice || item.product_standard_price || 0),
          standard_price: Number(item.standardPrice || item.standard_price || item.productStandardPrice || item.product_standard_price || 0),
          minSalePrice: Number(item.minSalePrice || item.min_sale_price || item.minimumSalePrice || item.minimum_sale_price || item.minPrice || item.min_price || item.lowestSalePrice || item.lowest_sale_price || item.lowPrice || item.low_price || item.floorPrice || item.floor_price || 0),
          min_sale_price: Number(item.minSalePrice || item.min_sale_price || item.minimumSalePrice || item.minimum_sale_price || item.minPrice || item.min_price || item.lowestSalePrice || item.lowest_sale_price || item.lowPrice || item.low_price || item.floorPrice || item.floor_price || 0),
          quantity: quantity,
          imei1: item.imei1 || '',
          imei_1: item.imei1 || '',
          IMEI1: item.imei1 || '',
          imei2: item.imei2 || '',
          imei_2: item.imei2 || '',
          IMEI2: item.imei2 || '',
          customerSource: item.customerSource || item.customer_source || '',
          customer_source: item.customerSource || item.customer_source || '',
          CUSTOMER_SOURCE: item.customerSource || item.customer_source || '',
          customerSourceDetail: item.customerSourceDetail || item.customer_source_detail || '',
          customer_source_detail: item.customerSourceDetail || item.customer_source_detail || '',
          CUSTOMER_SOURCE_DETAIL: item.customerSourceDetail || item.customer_source_detail || ''
        };
      }),
      goods: processedGoodsList.map(item => {
        const snCode = String(item.snCode || item.sn_code || item.sn || item.SN || '').trim();
        const inventoryId = String(item.inventoryId || item.inventory_id || item.snId || item.sn_id || item.inventorySnId || item.inventory_sn_id || '').trim();
        const previousSnStatus = item.previousSnStatus || item.previous_sn_status || item.inventoryStatus || item.inventory_status || item.status || '在库';
        return Object.assign({}, item, {
          itemId: item.itemId || item.item_id || item._id || item.id || '',
          inventoryId: inventoryId,
          snCode: snCode,
          previousSnStatus: previousSnStatus,
          imei_1: item.imei1 || '',
          IMEI1: item.imei1 || '',
          imei_2: item.imei2 || '',
          IMEI2: item.imei2 || ''
        });
      }),
      // 统一提交模型；上面的旧字段仅用于兼容历史页面逻辑，最终不出页面边界。
      items: canonicalProcessedGoodsList,
      goods: canonicalProcessedGoodsList,

      totalAmount: parseFloat(this.data.totalAmount) || 0,
      discount: parseFloat(this.data.discount) || 0,
      discountAmount: parseFloat(this.data.discount) || 0,
      nationalSubsidy: parseFloat(this.data.nationalSubsidy) || 0,
      computerAmount: this.data.computerAmount || '',
      mobileAmount: this.data.mobileAmount || '',
      educationSubsidy: parseFloat(this.data.educationSubsidy) || 0,
      actualAmount: parseFloat(this.data.actualAmount) || 0,
      actualPayment: parseFloat(this.data.actualAmount) || 0,
      depositItems: depositItems || [],
      deposits: depositItems || [],
      depositDeductionTotal: this.getDepositDeductionTotal(depositItems),

      paymentMethods: paymentMethods.map(p => ({
        type: p.type,
        paymentType: p.type,
        amount: parseFloat(p.amount) || 0,
        depositId: p.depositId || '',
        depositNo: p.depositNo || ''
      })),
      paymentTotal: parseFloat(this.data.paymentTotal) || 0,

      auxiliarySalesList: auxiliarySalesList.map(a => ({
        selected: a.selected,
        selectedDisplay: a.selectedDisplay || a.selected,
        optionIndex: Number(a.optionIndex || 0),
        staffId: a.staffId || '',
        phone: a.phone || '',
        storeId: a.storeId || '',
        storeName: a.storeName || '',
        regionId: a.regionId || '',
        profitAmount: parseFloat(a.profitAmount) || 0,
        ratio: a.ratio
      })),

      invoiceStatus: this.data.invoiceStatus,
      invoiceInfo: this.data.invoiceInfo,
      invoiceAmount: (this.data.subsidyStatus === '国补' && !this.data.invoiceAmount)
        ? this.getDefaultInvoiceAmount(paymentMethods)
        : this.data.invoiceAmount,

      subsidyStatus: this.data.subsidyStatus,
      subsidyPerson: this.data.subsidyStatus === '国补' ? (this.data.subsidyPerson || order.contactName || '') : this.data.subsidyPerson,
      subsidyId: this.data.subsidyStatus === '国补' ? (this.data.subsidyId || order.contactMethod || '') : this.data.subsidyId,
      subsidyPhotos: this.data.subsidyPhotos,
      productPhotoUrls: this.data.productPhotoUrls,
      educationSubsidyPhotoUrl: this.data.educationSubsidyPhotoUrl,
      educationSubsidyCouponCode: this.data.educationSubsidyCouponCode,
      personalInfoPhoto: this.data.personalInfoPhoto,

      updateTime: new Date().getTime(),
      updateUser: userUtils.getUserInfo().userName
    };
  },

  /**
   * 处理商品来源：只保留金额最高商品的一、二级来源，其他清空
   */
  processGoodsSourceForHighestPrice: function (goodsList, customerSource, customerSourceDetail) {
    if (!goodsList || goodsList.length === 0) return goodsList;

    // 找到金额最高的商品
    let maxPrice = -1;
    let maxIndex = -1;
    goodsList.forEach((item, index) => {
      const price = parseFloat(item.price) || 0;
      if (price > maxPrice) {
        maxPrice = price;
        maxIndex = index;
      }
    });

    // 处理每个商品
    return goodsList.map((item, index) => {
      if (index === maxIndex) {
        // 金额最高的商品，保留来源
        return {
          ...item,
          customerSource: customerSource !== undefined ? customerSource : (item.customerSource || ''),
          customerSourceDetail: customerSourceDetail !== undefined ? customerSourceDetail : (item.customerSourceDetail || '')
        };
      } else {
        // 其他商品，清空来源
        return {
          ...item,
          customerSource: '',
          customerSourceDetail: ''
        };
      }
    });
  },

  // ==================== 其他功能 ====================

  printOrder: function () {
    const BluetoothPrinter = require('../../utils/bluetooth.js');

    wx.showLoading({ title: '打印中...' });

    const printData = this.convertOrderToPrintFormat(this.data.order);

    BluetoothPrinter.printOrder(printData,
      (res) => {
        wx.hideLoading();
        wx.showToast({ title: '打印成功', icon: 'success' });
      },
      (err) => {
        wx.hideLoading();
        wx.showToast({
          title: '打印失败：' + err,
          icon: 'none'
        });
      }
    );
  },

  convertOrderToPrintFormat: function (orderData) {
    return {
      orderNo: this.data.orderNo,
      createTime: orderData.createTimeFormat,
      createUser: orderData.createUser,
      customerSource: orderData.customerSource,
      contactName: orderData.contactName,
      contactMethod: orderData.contactMethod,
      paymentMethods: this.data.paymentMethods,
      paymentTotal: this.data.paymentTotal,
      goods: this.data.goodsList,
      totalAmount: this.data.totalAmount,
      discount: this.data.discount,
      nationalSubsidy: this.data.nationalSubsidy,
      educationSubsidy: this.data.educationSubsidy,
      actualAmount: this.data.actualAmount,
      invoiceStatus: this.data.invoiceStatus,
      invoiceInfo: this.data.invoiceInfo,
      subsidyStatus: this.data.subsidyStatus
    };
  },

  navigateBack: function () {
    wx.navigateBack({ delta: 1 });
  }
});
