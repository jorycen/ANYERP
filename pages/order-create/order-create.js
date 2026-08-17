// pages/order-create/order-create.js
const userUtils = require('../profile/user-utils.js');
const DataStorage = require('../../utils/storage.js');
const api = require('../../utils/api.js');
const couponOcr = require('../../utils/coupon-ocr.js');
const { normalizeOrderItem, normalizeSnCode, isEmptyOrderItem } = require('../../utils/model.js');
const { calculateOrderProfit } = require('../../utils/order-profit.js');
require('../../utils/cloud-adapter.js').install();
Page({
  /**
   * 页面的初始数据
   */
  data: {
    goodsList: [
      {
        pnCode: '',
        mtmCode: '',
        snCode: '',
        name: '',
        price: 0,
        quantity: 1,
        subtotal: 0,
        showImei: false,
        needSn: false,
        pnOptions: [],
        pnOptionsDisplay: [],
        pnPickerIndex: 0,
        pnStockStatus: '',
        snOptions: [],
        snOptionsDisplay: [],
        snRecords: [],
        snPickerIndex: 0,
        snStockStatus: '',
        imei1: '',
        imei2: ''
      }
    ],
    totalAmount: 0,
    totalAmountFixed: '0.00',
    discount: 0,
    nationalSubsidy: 0, // 国补
    computerAmount: '', // 电脑金额（用于计算国补）
    mobileAmount: '', // 手机平板金额（用于计算国补）
    educationSubsidy: 0, // 教育补贴
    actualAmount: 0,
    actualAmountFixed: '0.00',
    differenceAmount: '0.00', // 差额（应收金额 - 收款汇总）
    showPreview: false,
    previewData: {},
    // 辅助销售人列表
    auxiliarySalesList: [],
    // 辅助销售人选项
    auxiliarySalesOptions: ['无'],
    // 客户信息
    customerSourcesLevel1: [],
    customerSourcesLevel2Map: {},
    customerSourcesLevel2Display: [],
    selectedCustomerSourceLevel1: '',
    selectedCustomerSourceLevel2: '',
    level1Index: 0,
    level2Index: 0,
    level1SourcesData: [],
    contactName: '', // 联系人
    contactMethod: '', // 联系方式
    // 收款方式
    paymentMethodOptions: [],
    paymentMethods: [
      {
        type: '',
        amount: 0,
        depositId: '',
        depositNo: ''
      }
    ],
    depositItems: [],
    depositDeductionTotal: 0,
    depositDeductionTotalFixed: '0.00',
    availableDepositList: [],
    availableDepositDisplay: ['无'],
    depositPickerIndex: 0,
    depositLoading: false,
    // 开票状态
    invoiceStatus: '不开票',
    invoiceOptions: ['不开票', '开专票', '开普票'],
    // 开票信息
    invoiceInfo: '',
    // 开票金额
    invoiceAmount: '',
    // 国补状态
    subsidyStatus: '非国补',
    subsidyOptions: ['国补', '非国补'],
    // 国补人信息
    subsidyPerson: '', // 国补人
    subsidyId: '', // 国补ID
    // 国补照片上传（7个固定位置）
    subsidyPhotos: [
      { url: '', name: '产品及包装盒' },
      { url: '', name: '包装盒+开机SN' },
      { url: '', name: '能效标识' },
      { url: '', name: '底壳包装盒' },
      { url: '', name: '国补小票' },
      { url: '', name: 'ID照片（重庆）' },
      { url: '', name: '水印合影（重庆）' }
    ],
    // 非国补商品图片上传（支持多图）
    productPhotoUrls: [],
    // 教育补贴核销凭证图片
    educationSubsidyPhotoUrl: '',
    educationSubsidyCouponCode: '',
    educationSubsidyOcrText: '',
    educationSubsidyOcrStatus: '',
    educationSubsidyTempFilePath: '',
    // 个人资料照片上传
    personalInfoPhoto: { url: '', name: '个人资料' },
    // 订单编号（页面加载时生成）
    orderNo: '',
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
    // 打印机连接引导弹窗
    showPrinterGuideModal: false,
    // 待打印的订单数据（用于连接打印机后自动打印）
    pendingPrintOrderData: null,
    // 订单提交状态，防止重复提交
    isSubmitting: false,
    // 是否有国补POS（手机平板）收款方式
    hasGuobuPhonePayment: false,
    // IMEI信息
    imei1: '',
    imei2: '',
    // 是否正在打印（防止重复打印）
    isPrinting: false,
    // 是否已恢复缓存（防止onShow重复恢复）
    isCacheRestored: false,
    // 是否显示打印确认弹窗
    showPrintConfirmModal: false,
    // 待打印的订单数据（用于提交成功后打印）
    pendingPrintOrderData: null,
    showPrivacyModal: false,
    privacyContractName: '隐私保护指引',
    // iOS 输入云闪付订单号时隐藏固定底栏，避免键盘与 fixed 布局互相重排
    isInvoiceInfoFocused: false,
    storeId: '',
    storeName: '',
    orderStoreOptions: [],
    showStorePicker: false
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: function (options) {
    this.initPrivacyAuthorization();
    this.initOrderStore();
    // 检查用户登录状态
    const userInfo = userUtils.getUserInfo();
    if (!userInfo || !userInfo.phoneNumber) {
      wx.showToast({
        title: '请先登录',
        icon: 'none'
      });
      // 跳转到登录页
      setTimeout(() => {
        wx.redirectTo({
          url: '/pages/login/login'
        });
      }, 1500);
      return;
    }

    // 检查是否有缓存的订单数据
    const cachedData = wx.getStorageSync('orderCreateCache');
    const hasCachedData = cachedData && cachedData.goodsList && 
                          cachedData.goodsList.some(item => item.pnCode || item.name);

    if (!hasCachedData) {
      // 没有缓存数据，才进行初始化
      console.log('onLoad: 无缓存数据，执行初始化');

      // 初始化totalAmount和actualAmount为0
      this.setData({
        totalAmount: 0,
        actualAmount: 0,
        discount: 0
      });

      // 初始化每个商品的小计
      const goodsList = this.data.goodsList;
      goodsList.forEach(item => {
        item.price = 0;
        item.quantity = 1;
        item.subtotal = 0;
      });
      this.setData({ goodsList });

      // 初始化金额计算
      this.calculateTotal();

      // 生成订单编号
      const now = new Date();
      const orderNo = 'ORD' + now.getTime();
      this.setData({ orderNo: orderNo });
    } else {
      console.log('onLoad: 有缓存数据，跳过初始化');
    }

    // 加载客户来源列表
    this.loadCustomerSources();

    // 加载收款方式列表
    this.loadPaymentMethods();

    // 加载门店店员信息作为辅助销售人选项
    this.loadStaffList();
  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow: function () {
    // 只在首次显示时恢复缓存，避免扫码后重复恢复覆盖数据
    if (!this.data.isCacheRestored) {
      this.restoreOrderDataFromCache();
      this.setData({ isCacheRestored: true });
    }

    // picker 打开时无法等待异步请求，页面显示时提前加载，确保第一次点击就有数据
    this.loadAvailableDeposits({ showToast: false });

    // 检查是否有待打印的订单数据
    const pendingOrderData = this.data.pendingPrintOrderData;
    if (pendingOrderData && !this.data.isPrinting) {
      console.log('检测到有待打印订单，检查蓝牙状态');
      
      // 标记正在打印，防止重复执行
      this.setData({ isPrinting: true });
      
      // 检查蓝牙适配器状态
      wx.openBluetoothAdapter({
        success: () => {
          wx.getBluetoothAdapterState({
            success: (adapterState) => {
              if (adapterState.available) {
                // 蓝牙已开启，检查打印机信息
                const printerInfo = wx.getStorageSync('printerInfo');
                const connectedPrinter = wx.getStorageSync('connectedPrinter');
                
                if (printerInfo && connectedPrinter) {
                  console.log('蓝牙和打印机都已就绪，自动执行打印');
                  // 关闭弹窗并执行打印
                  this.setData({
                    showPrinterGuideModal: false
                  });
                  this.executePrint(pendingOrderData);
                } else {
                  console.log('蓝牙已开启但未绑定打印机，保持弹窗');
                  this.setData({ isPrinting: false });
                }
              } else {
                console.log('蓝牙未开启，保持弹窗');
                this.setData({ isPrinting: false });
              }
            },
            fail: () => {
              console.log('获取蓝牙状态失败，保持弹窗');
              this.setData({ isPrinting: false });
            }
          });
        },
        fail: () => {
          console.log('蓝牙适配器未初始化，保持弹窗');
          this.setData({ isPrinting: false });
        }
      });
    }
  },

  /**
   * 生命周期函数--监听页面隐藏
   */
  onHide: function () {
    // 保存订单数据到缓存
    this.saveOrderDataToCache();
  },

  initOrderStore: function () {
    const userInfo = userUtils.getUserInfo() || wx.getStorageSync('userInfo') || {};
    const tempStoreInfo = wx.getStorageSync('tempStoreInfo') || {};
    const distributorInfo = wx.getStorageSync('distributorInfo') || {};
    const currentStoreId = userUtils.isStoreScoped(userInfo)
      ? String(userInfo.storeId || userInfo.store_id || tempStoreInfo.storeId || tempStoreInfo.store_id || tempStoreInfo.id || tempStoreInfo._id || '')
      : '';
    const currentStoreName = userUtils.isStoreScoped(userInfo)
      ? (userInfo.storeName || userInfo.store_name || tempStoreInfo.storeName || tempStoreInfo.store_name || tempStoreInfo.name || '')
      : '';
    const distributorId = userInfo.distributorId || userInfo.distributor_id ||
      distributorInfo.distributorId || distributorInfo.distributor_id || distributorInfo.id || distributorInfo._id || '';
    this.setData({ storeId: currentStoreId, storeName: currentStoreName });
    api.store.getStores(distributorId).then(result => {
      const stores = (result && result.data) || result || [];
      const options = stores.map(store => ({
        storeId: String(store.storeId || store.store_id || store.id || store._id || ''),
        name: store.name || store.storeName || store.store_name || ''
      })).filter(store => store.storeId && store.name);
      // 当前门店优先；经销商账号没有当前门店时默认第一家，但仍展示全部可选门店。
      const selected = options.find(store => store.storeId === currentStoreId) || options[0];
      this.setData({
        orderStoreOptions: options,
        ...(selected ? { storeId: selected.storeId, storeName: selected.name } : {})
      });
    }).catch(err => {
      console.error('加载订单门店失败:', err);
      if (currentStoreId || currentStoreName) {
        this.setData({ orderStoreOptions: [{ storeId: currentStoreId, name: currentStoreName }] });
      }
    });
  },

  openStorePicker: function () {
    if (!this.data.orderStoreOptions.length) this.initOrderStore();
    this.setData({ showStorePicker: true });
  },

  closeStorePicker: function () {
    this.setData({ showStorePicker: false });
  },

  selectOrderStore: function (e) {
    const selected = this.data.orderStoreOptions[Number(e.currentTarget.dataset.index)];
    if (!selected) return;
    this.setData({ storeId: selected.storeId, storeName: selected.name, showStorePicker: false });
    this.saveOrderDataToCache();
  },

  onUnload: function () {
    if (this._invoiceCacheTimer) {
      clearTimeout(this._invoiceCacheTimer);
      this._invoiceCacheTimer = null;
    }
    if (this._depositReloadTimer) {
      clearTimeout(this._depositReloadTimer);
      this._depositReloadTimer = null;
    }
    this._depositLoadRequestId = (this._depositLoadRequestId || 0) + 1;
  },

  /**
   * 保存订单数据到缓存
   */
  saveOrderDataToCache: function () {
    const orderData = {
      goodsList: this.data.goodsList,
      totalAmount: this.data.totalAmount,
      discount: this.data.discount,
      nationalSubsidy: this.data.nationalSubsidy,
      computerAmount: this.data.computerAmount,
      mobileAmount: this.data.mobileAmount,
      educationSubsidy: this.data.educationSubsidy,
      actualAmount: this.data.actualAmount,
      selectedCustomerSource: this.data.selectedCustomerSource,
      contactName: this.data.contactName,
      contactMethod: this.data.contactMethod,
      paymentMethods: this.data.paymentMethods,
      depositItems: this.data.depositItems,
      depositDeductionTotal: this.data.depositDeductionTotal,
      invoiceStatus: this.data.invoiceStatus,
      invoiceInfo: this.data.invoiceInfo,
      invoiceAmount: this.data.invoiceAmount,
      subsidyStatus: this.data.subsidyStatus,
      subsidyPerson: this.data.subsidyPerson,
      subsidyId: this.data.subsidyId,
      subsidyPhotos: this.data.subsidyPhotos,
      productPhotoUrls: this.data.productPhotoUrls,
      educationSubsidyPhotoUrl: this.data.educationSubsidyPhotoUrl,
      educationSubsidyCouponCode: this.data.educationSubsidyCouponCode,
      educationSubsidyOcrText: this.data.educationSubsidyOcrText,
      educationSubsidyOcrStatus: this.data.educationSubsidyOcrStatus,
      educationSubsidyTempFilePath: this.data.educationSubsidyTempFilePath,
      personalInfoPhoto: this.data.personalInfoPhoto,
      orderNo: this.data.orderNo,
      auxiliarySalesList: this.data.auxiliarySalesList,
      imei1: this.data.imei1,
      imei2: this.data.imei2,
      saveTime: new Date().getTime()
    };

    wx.setStorageSync('orderCreateCache', orderData);
    console.log('订单数据已保存到缓存');
  },

  /**
   * 延迟保存输入中的订单草稿，避免每个字符都同步阻塞 UI 线程。
   */
  scheduleSaveOrderDataToCache: function (delay) {
    if (this._invoiceCacheTimer) {
      clearTimeout(this._invoiceCacheTimer);
    }

    this._invoiceCacheTimer = setTimeout(() => {
      this._invoiceCacheTimer = null;
      this.saveOrderDataToCache();
    }, delay || 300);
  },

  /**
   * 从缓存恢复订单数据
   */
  restoreOrderDataFromCache: function () {
    console.log('尝试从缓存恢复订单数据...');
    const cachedData = wx.getStorageSync('orderCreateCache');
    if (!cachedData) {
      console.log('没有缓存的订单数据');
      return;
    }

    console.log('找到缓存数据:', cachedData);

    // 检查缓存时间（24小时内有效）
    const now = new Date().getTime();
    const cacheTime = cachedData.saveTime || 0;
    const hoursDiff = (now - cacheTime) / (1000 * 60 * 60);

    if (hoursDiff > 24) {
      console.log('缓存数据已过期（超过24小时），清除缓存');
      wx.removeStorageSync('orderCreateCache');
      return;
    }

    // 检查是否有有效数据（有商品或客户信息）
    const hasGoods = cachedData.goodsList && cachedData.goodsList.length > 0 && 
                     cachedData.goodsList.some(item => item.pnCode || item.name);
    const hasCustomer = cachedData.selectedCustomerSource || cachedData.contactName;
    
    if (!hasGoods && !hasCustomer) {
      console.log('缓存数据为空（无商品和客户信息），跳过恢复');
      return;
    }

    console.log('开始恢复订单数据到页面...');

    // 处理商品列表，确保showImei字段正确
    let goodsList = cachedData.goodsList || this.data.goodsList;
    if (goodsList && goodsList.length > 0) {
      goodsList = goodsList.map(item => {
        // 根据商品名称判断是否显示IMEI
        const name = item.name || '';
        item.showImei = name.toLowerCase().includes('moto');
        item.needSn = this.isNeedSnGoods(item);
        item.pnOptions = item.pnOptions || [];
        item.pnOptionsDisplay = item.pnOptionsDisplay || [];
        item.pnPickerIndex = item.pnPickerIndex || 0;
        item.pnStockStatus = item.pnStockStatus || '';
        item.snOptions = item.snOptions || [];
        item.snOptionsDisplay = item.snOptionsDisplay || [];
        item.snRecords = item.snRecords || [];
        item.snPickerIndex = item.snPickerIndex || 0;
        item.snStockStatus = item.snStockStatus || '';
        return item;
      });
    }

    // 恢复数据到页面
    const legacyDepositItems = (cachedData.depositItems || []).map(item => {
      return this.normalizeDepositItem(Object.assign({ itemType: 'depositDeduction' }, item));
    });
    let restoredPaymentMethods = (cachedData.paymentMethods || this.data.paymentMethods || [])
      .map(method => this.normalizePaymentMethod(method));
    if (!restoredPaymentMethods.some(method => this.isDepositPayment(method.type)) && legacyDepositItems.length) {
      restoredPaymentMethods.push(this.createDepositPaymentMethod(legacyDepositItems[0]));
    }
    if (restoredPaymentMethods.length === 0) {
      restoredPaymentMethods = [{ type: '', amount: 0, depositId: '', depositNo: '' }];
    }
    const restoredDepositItems = this.getDepositItemsFromPaymentMethods(restoredPaymentMethods);
    this.setData({
      goodsList: goodsList,
      totalAmount: cachedData.totalAmount || 0,
      discount: cachedData.discount || 0,
      nationalSubsidy: cachedData.nationalSubsidy || 0,
      computerAmount: cachedData.computerAmount || '',
      mobileAmount: cachedData.mobileAmount || '',
      educationSubsidy: cachedData.educationSubsidy || 0,
      actualAmount: cachedData.actualAmount || 0,
      selectedCustomerSource: cachedData.selectedCustomerSource || '',
      contactName: cachedData.contactName || '',
      contactMethod: cachedData.contactMethod || '',
      paymentMethods: restoredPaymentMethods,
      depositItems: restoredDepositItems,
      invoiceStatus: cachedData.invoiceStatus || '不开票',
      invoiceInfo: cachedData.invoiceInfo || '',
      invoiceAmount: cachedData.invoiceAmount || '',
      subsidyStatus: cachedData.subsidyStatus || '非国补',
      subsidyPerson: cachedData.subsidyPerson || '',
      subsidyId: cachedData.subsidyId || '',
      subsidyPhotos: this.mergeSubsidyPhotos(cachedData.subsidyPhotos, this.data.subsidyPhotos),
      productPhotoUrls: cachedData.productPhotoUrls || [],
      educationSubsidyPhotoUrl: cachedData.educationSubsidyPhotoUrl || '',
      educationSubsidyCouponCode: cachedData.educationSubsidyCouponCode || '',
      educationSubsidyOcrText: cachedData.educationSubsidyOcrText || '',
      educationSubsidyOcrStatus: cachedData.educationSubsidyOcrStatus || '',
      educationSubsidyTempFilePath: cachedData.educationSubsidyTempFilePath || '',
      personalInfoPhoto: cachedData.personalInfoPhoto || this.data.personalInfoPhoto,
      orderNo: cachedData.orderNo || this.data.orderNo,
      auxiliarySalesList: cachedData.auxiliarySalesList || [],
      imei1: cachedData.imei1 || '',
      imei2: cachedData.imei2 || ''
    }, () => {
      // 数据恢复后重新计算金额
      this.calculateTotal();
      console.log('订单数据已从缓存恢复，当前数据:', this.data);
    });
  },

  /**
   * 清除订单缓存
   */
  clearOrderCache: function () {
    wx.removeStorageSync('orderCreateCache');
    console.log('订单缓存已清除');
  },

  /**
   * 重置页面数据为初始状态
   */
  resetPageData: function () {
    const now = new Date();
    const orderNo = 'ORD' + now.getTime();

    // 获取当前用户信息（主销售人）
    const userInfo = userUtils.getUserInfo();
    const createUser = userInfo.userName || '未知用户';

    // 初始化辅助销售人列表，默认包含主销售人
    const defaultAuxiliarySalesList = [{
      selected: createUser,
      profitAmount: 0,
      ratio: '利润平分',
      isMainSales: true
    }];

    this.setData({
      goodsList: [{
        pnCode: '',
        mtmCode: '',
        snCode: '',
        name: '',
        price: 0,
        costPrice: 0,
        quantity: 1,
        subtotal: 0,
        showImei: false,
        needSn: false,
        pnOptions: [],
        pnOptionsDisplay: [],
        pnPickerIndex: 0,
        pnStockStatus: '',
        snOptions: [],
        snOptionsDisplay: [],
        snRecords: [],
        snPickerIndex: 0,
        snStockStatus: '',
        imei1: '',
        imei2: ''
      }],
      totalAmount: 0,
      totalAmountFixed: '0.00',
      discount: 0,
      nationalSubsidy: 0,
      computerAmount: '',
      mobileAmount: '',
      educationSubsidy: 0,
      actualAmount: 0,
      actualAmountFixed: '0.00',
      differenceAmount: '0.00',
      selectedCustomerSource: '',
      contactName: '',
      contactMethod: '',
      paymentMethods: [{
        type: '',
        amount: 0,
        depositId: '',
        depositNo: ''
      }],
      depositItems: [],
      depositDeductionTotal: 0,
      depositDeductionTotalFixed: '0.00',
      availableDepositList: [],
      availableDepositDisplay: ['无'],
      depositPickerIndex: 0,
      invoiceStatus: '不开票',
      invoiceInfo: '',
      invoiceAmount: '',
      subsidyStatus: '非国补',
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
      productPhotoUrls: [],
      educationSubsidyPhotoUrl: '',
      educationSubsidyCouponCode: '',
      educationSubsidyOcrText: '',
      educationSubsidyOcrStatus: '',
      educationSubsidyTempFilePath: '',
      personalInfoPhoto: { url: '', name: '个人资料' },
      orderNo: orderNo,
      auxiliarySalesList: defaultAuxiliarySalesList,
      imei1: '',
      imei2: '',
      showPreview: false,
      previewData: {}
    });

    console.log('页面数据已重置');
  },

  /**
   * 一键清空所有数据
   */
  clearAllData: function () {
    wx.showModal({
      title: '确认清空',
      content: '确定要清空所有已填写的信息吗？此操作不可恢复。',
      confirmText: '清空',
      confirmColor: '#FF4444',
      success: (res) => {
        if (res.confirm) {
          // 清除缓存
          this.clearOrderCache();

          // 重置所有数据
          const now = new Date();
          const orderNo = 'ORD' + now.getTime();

          this.setData({
            goodsList: [{
              pnCode: '',
              mtmCode: '',
              snCode: '',
              name: '',
              price: 0,
              quantity: 1,
              subtotal: 0,
              showImei: false,
              needSn: false,
              pnOptions: [],
              pnOptionsDisplay: [],
              pnPickerIndex: 0,
              pnStockStatus: '',
              snOptions: [],
              snOptionsDisplay: [],
              snRecords: [],
              snPickerIndex: 0,
              snStockStatus: '',
              imei1: '',
              imei2: ''
            }],
            totalAmount: 0,
            totalAmountFixed: '0.00',
            discount: 0,
            nationalSubsidy: 0,
            computerAmount: '',
            mobileAmount: '',
            educationSubsidy: 0,
            actualAmount: 0,
            actualAmountFixed: '0.00',
            differenceAmount: '0.00',
            selectedCustomerSource: '',
            contactName: '',
            contactMethod: '',
            paymentMethods: [{
              type: '',
              amount: 0,
              depositId: '',
              depositNo: ''
            }],
            depositItems: [],
            depositDeductionTotal: 0,
            depositDeductionTotalFixed: '0.00',
            availableDepositList: [],
            availableDepositDisplay: ['无'],
            depositPickerIndex: 0,
            invoiceStatus: '不开票',
            invoiceInfo: '',
            invoiceAmount: '',
            subsidyStatus: '非国补',
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
            productPhotoUrls: [],
            educationSubsidyPhotoUrl: '',
            educationSubsidyCouponCode: '',
            educationSubsidyOcrText: '',
            educationSubsidyOcrStatus: '',
            educationSubsidyTempFilePath: '',
            personalInfoPhoto: { url: '', name: '个人资料' },
            orderNo: orderNo,
            auxiliarySalesList: [],
            imei1: '',
            imei2: '',
            showPreview: false,
            previewData: {}
          }, () => {
            // 重新计算金额
            this.calculateTotal();
            wx.showToast({
              title: '已清空',
              icon: 'success'
            });
          });
        }
      }
    });
  },

  /**
   * 添加商品条目
   */
  addGoodsItem: function () {
    const goodsList = this.data.goodsList;
    goodsList.push({
      pnCode: '',
      mtmCode: '',
      snCode: '',
      name: '',
      price: 0,
      quantity: 1,
      subtotal: 0,
      showImei: false,
      needSn: false,
      pnOptions: [],
      pnOptionsDisplay: [],
      pnPickerIndex: 0,
      pnStockStatus: '',
      snOptions: [],
      snOptionsDisplay: [],
      snRecords: [],
      snPickerIndex: 0,
      snStockStatus: '',
      imei1: '',
      imei2: ''
    });
    this.setData({
      goodsList: goodsList
    });
    // 重新计算金额
    this.calculateTotal();

    // 自动保存到缓存
    this.saveOrderDataToCache();
  },

  /**
   * 删除商品条目
   */
  deleteGoodsItem: function (e) {
    const index = e.currentTarget.dataset.index;
    const goodsList = this.data.goodsList;
    goodsList.splice(index, 1);
    this.setData({
      goodsList: goodsList
    });
    // 重新计算金额
    this.calculateTotal();

    // 自动保存到缓存
    this.saveOrderDataToCache();
  },

  /**
   * 限制小数位数（支持输入过程中的小数点）
   * @param {string|number} value - 输入值
   * @param {number} decimals - 小数位数，默认2位
   * @returns {string|number} - 处理后的值
   */
  limitDecimals: function (value, decimals = 2) {
    if (!value && value !== 0) return '';
    let str = value.toString();

    // 过滤掉除数字和小数点以外的字符
    str = str.replace(/[^0-9.]/g, '');

    // 处理多个小数点的情况，只保留第一个
    const firstDotIndex = str.indexOf('.');
    if (firstDotIndex !== -1) {
      const beforeDot = str.substring(0, firstDotIndex + 1);
      const afterDot = str.substring(firstDotIndex + 1).replace(/\./g, '');
      str = beforeDot + afterDot;
    }

    // 检查是否有小数点
    if (str.indexOf('.') !== -1) {
      const parts = str.split('.');
      // 限制小数位数
      if (parts[1] && parts[1].length > decimals) {
        return parts[0] + '.' + parts[1].substring(0, decimals);
      }
      // 保留小数点，方便用户继续输入
      return str;
    }

    // 如果没有小数点，直接返回原字符串
    return str;
  },

  /**
   * 计算收款金额汇总（支持国补POS特殊计算）
   * @param {Array} paymentMethods - 收款方式列表
   * @returns {number} - 计算后的收款金额汇总
   */
  calculatePaymentTotal: function (paymentMethods) {
    if (!paymentMethods || paymentMethods.length === 0) {
      return 0;
    }

    const total = paymentMethods.reduce((sum, method) => {
      const amount = parseFloat(method.amount) || 0;
      const methodType = method.type || '';

      // 国补POS（手机平板）：金额 * 0.85，优惠封顶500
      if (methodType === '国补POS（手机平板）') {
        return sum + amount - Math.min(amount * 0.15, 500);
      }

      // 国补POS（电脑）：金额 * 0.85，优惠封顶1500
      if (methodType === '国补POS（电脑）') {
        return sum + amount - Math.min(amount * 0.15, 1500);
      }

      // 其他收款方式：直接累加
      return sum + amount;
    }, 0);

    return Math.round(total * 100) / 100;
  },

  isDepositPayment: function (type) {
    const value = String(type || '').trim().toLowerCase();
    return value === '定金' || value === '定金抵扣' || value === 'deposit';
  },

  normalizeDepositItem: function (source = {}) {
    const hasAvailableAmount = source.availableAmount !== undefined || source.available_amount !== undefined;
    const availableAmount = Number(hasAvailableAmount
      ? (source.availableAmount !== undefined ? source.availableAmount : source.available_amount)
      : (source.amount || 0));
    const amount = Number(
      source.deductionAmount !== undefined
        ? source.deductionAmount
        : (source.deduction_amount !== undefined
          ? source.deduction_amount
          : ((source.itemType === 'depositDeduction' || this.isDepositPayment(source.type))
            ? source.amount
            : availableAmount))
    );
    return {
      itemType: 'depositDeduction',
      name: '定金抵扣',
      depositId: source.depositId || source.deposit_id || source._id || '',
      depositNo: source.depositNo || source.deposit_no || '',
      customerName: source.customerName || source.customer_name || '',
      customerPhone: source.customerPhone || source.customer_phone || '',
      amount: (isNaN(amount) ? 0 : amount).toFixed(2),
      availableAmount: (isNaN(availableAmount) ? 0 : availableAmount).toFixed(2),
      depositDisplay: source.depositDisplay || source.deposit_display || ''
    };
  },

  getDepositDeductionTotal: function (depositItems) {
    return (depositItems || []).reduce((total, item) => {
      return total + (parseFloat(item.amount) || 0);
    }, 0);
  },

  getMaximumOrderDepositDeduction: function () {
    const totalAmount = parseFloat(this.data.totalAmount) || 0;
    const otherDeductions =
      (parseFloat(this.data.discount) || 0) +
      (parseFloat(this.data.nationalSubsidy) || 0) +
      (parseFloat(this.data.educationSubsidy) || 0);
    return Math.max(0, totalAmount - otherDeductions);
  },

  normalizePaymentMethod: function (method = {}) {
    method = method || {};
    return {
      type: method.type || '',
      amount: method.amount === undefined || method.amount === null ? 0 : method.amount,
      depositId: method.depositId || method.deposit_id || '',
      depositNo: method.depositNo || method.deposit_no || '',
      customerName: method.customerName || method.customer_name || '',
      customerPhone: method.customerPhone || method.customer_phone || '',
      depositDisplay: method.depositDisplay || method.deposit_display || '',
      availableAmount: method.availableAmount !== undefined
        ? method.availableAmount
        : (method.available_amount !== undefined ? method.available_amount : ''),
      depositPickerIndex: Number(method.depositPickerIndex || 0)
    };
  },

  getDepositItemsFromPaymentMethods: function (paymentMethods) {
    return (paymentMethods || [])
      .filter(method => this.isDepositPayment(method && method.type))
      .map(method => this.normalizeDepositItem(method));
  },

  createDepositPaymentMethod: function (depositItem) {
    const item = this.normalizeDepositItem(depositItem || {});
    return {
      type: '定金抵扣',
      amount: item.amount || '',
      depositId: item.depositId || '',
      depositNo: item.depositNo || '',
      customerName: item.customerName || '',
      customerPhone: item.customerPhone || '',
      depositDisplay: this.getDepositDisplay(item),
      availableAmount: item.availableAmount || '',
      depositPickerIndex: 0
    };
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

  getEffectivePaymentMethods: function (paymentMethods) {
    return (paymentMethods || []).filter(method => {
      return method && (method.type || (parseFloat(method.amount) || 0) > 0);
    });
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

  getDepositDisplay: function (item) {
    const customerName = String(item && (item.customerName || item.customer_name) || '').trim() || '未填写姓名';
    const availableAmount = Number(
      item && item.availableAmount !== undefined
        ? item.availableAmount
        : (item && item.available_amount !== undefined ? item.available_amount : 0)
    );
    return `${customerName}  ¥${(isNaN(availableAmount) ? 0 : availableAmount).toFixed(2)}`;
  },

  formatDepositPickerOptions: function (rows) {
    const list = rows || [];
    return ['无'].concat(list.map(item => this.getDepositDisplay(item)));
  },

  recalculatePaymentSummary: function (paymentMethods) {
    const paymentTotal = this.calculatePaymentTotal(paymentMethods);
    const actualAmount = parseFloat(this.data.actualAmount) || 0;
    return {
      paymentTotal: paymentTotal,
      differenceAmount: (actualAmount - paymentTotal).toFixed(2)
    };
  },

  onDepositPickerChange: function (e) {
    const paymentIndex = Number(e.currentTarget.dataset.paymentIndex);
    if (isNaN(paymentIndex) || paymentIndex < 0) return;
    const selectedIndex = Number(e.detail.value || 0);
    const deposit = selectedIndex > 0 ? (this.data.availableDepositList[selectedIndex - 1] || null) : null;
    const depositItem = deposit ? this.normalizeDepositItem(deposit) : null;
    if (depositItem) {
      const availableAmount = parseFloat(depositItem.availableAmount) || 0;
      const maximumOrderAmount = this.getMaximumOrderDepositDeduction();
      depositItem.amount = Math.min(
        availableAmount,
        maximumOrderAmount > 0 ? maximumOrderAmount : availableAmount
      ).toFixed(2);
    }
    const paymentMethods = this.getEditablePaymentMethods(this.data.paymentMethods, paymentIndex);
    paymentMethods[paymentIndex] = depositItem
      ? Object.assign(this.createDepositPaymentMethod(depositItem), { depositPickerIndex: selectedIndex })
      : this.createDepositPaymentMethod();
    const depositItems = this.getDepositItemsFromPaymentMethods(paymentMethods);

    this.setData({
      paymentMethods,
      depositItems,
      depositPickerIndex: deposit ? selectedIndex : 0
    }, () => {
      this.calculateTotal();
      this.saveOrderDataToCache();
    });
  },

  onDepositAmountInput: function (e) {
    const paymentIndex = Number(e.currentTarget.dataset.paymentIndex);
    if (isNaN(paymentIndex) || paymentIndex < 0) return;
    const paymentMethods = this.getEditablePaymentMethods(this.data.paymentMethods, paymentIndex);
    if (!this.isDepositPayment(paymentMethods[paymentIndex].type)) return;
    paymentMethods[paymentIndex].amount = this.limitDecimals(e.detail.value, 2);
    const depositItems = this.getDepositItemsFromPaymentMethods(paymentMethods);
    this.setData({ paymentMethods, depositItems }, () => {
      this.calculateTotal();
      this.saveOrderDataToCache();
    });
  },

  onDepositAmountBlur: function (e) {
    const paymentIndex = Number(e.currentTarget.dataset.paymentIndex);
    if (isNaN(paymentIndex) || paymentIndex < 0) return;
    const paymentMethods = this.getEditablePaymentMethods(this.data.paymentMethods, paymentIndex);
    const paymentMethod = paymentMethods[paymentIndex];
    if (!this.isDepositPayment(paymentMethod.type)) return;
    const availableAmount = parseFloat(paymentMethod.availableAmount) || 0;
    const maximumOrderAmount = this.getMaximumOrderDepositDeduction();
    const enteredAmount = parseFloat(paymentMethod.amount) || 0;
    const validAmount = Math.min(enteredAmount, availableAmount, maximumOrderAmount);

    if (enteredAmount > validAmount) {
      wx.showToast({ title: '抵扣金额已调整为可用上限', icon: 'none' });
    }
    paymentMethod.amount = validAmount > 0 ? validAmount.toFixed(2) : '';
    const depositItems = this.getDepositItemsFromPaymentMethods(paymentMethods);
    this.setData({ paymentMethods, depositItems }, () => {
      this.calculateTotal();
      this.saveOrderDataToCache();
    });
  },

  validateDepositItems: function (depositItems) {
    const items = depositItems || [];
    let total = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.depositId) {
        wx.showToast({ title: '请选择定金抵扣' + (i + 1), icon: 'none' });
        return false;
      }
      const amount = parseFloat(item.amount) || 0;
      const availableAmount = parseFloat(item.availableAmount) || 0;
      if (amount <= 0) {
        wx.showToast({ title: '请输入本次定金抵扣金额', icon: 'none' });
        return false;
      }
      if (availableAmount > 0 && amount > availableAmount + 0.001) {
        wx.showToast({ title: '抵扣金额不能超过定金余额', icon: 'none' });
        return false;
      }
      total += amount;
    }
    if (total > this.getMaximumOrderDepositDeduction() + 0.001) {
      wx.showToast({ title: '抵扣金额不能超过订单应付金额', icon: 'none' });
      return false;
    }
    return true;
  },

  getDepositPickerIndex: function (rows, depositItems) {
    const selected = (depositItems || [])[0] || {};
    const selectedId = selected.depositId || selected.deposit_id || selected._id || '';
    if (!selectedId) return 0;

    const index = (rows || []).findIndex(item => {
      return (item.depositId || item.deposit_id || item._id || '') === selectedId;
    });
    return index >= 0 ? index + 1 : 0;
  },

  loadAvailableDeposits: function (options = {}) {
    const contactMethod = String(this.data.contactMethod || '').trim();
    const storeId = options.storeId || this.getCurrentStoreId();
    const requestId = (this._depositLoadRequestId || 0) + 1;
    this._depositLoadRequestId = requestId;

    // 未填写当前客户手机号时不查询，避免把其他客户的定金暴露在下拉框中。
    if (!contactMethod) {
      this.setData({
        availableDepositList: [],
        availableDepositDisplay: ['无'],
        depositPickerIndex: 0,
        depositLoading: false
      });
      if (options.showToast) {
        wx.showToast({ title: '请先填写客户联系方式', icon: 'none' });
      }
      return Promise.resolve([]);
    }

    this.setData({ depositLoading: true });
    return api.deposit.available({
      customerPhone: contactMethod || '',
      storeId
    }).then(res => {
      if (requestId !== this._depositLoadRequestId) {
        return res.data || [];
      }
      const normalizePhone = value => String(value || '').replace(/\s+/g, '');
      // 后端旧版本可能忽略 customerPhone 参数，前端再次严格过滤当前客户。
      const rows = (res.data || []).filter(item => {
        return normalizePhone(item.customerPhone || item.customer_phone) === normalizePhone(contactMethod);
      });
      const paymentMethods = (this.data.paymentMethods || []).map(method => {
        const normalized = this.normalizePaymentMethod(method);
        if (this.isDepositPayment(normalized.type)) {
          normalized.depositPickerIndex = this.getDepositPickerIndex(rows, [normalized]);
        }
        return normalized;
      });
      this.setData({
        paymentMethods,
        availableDepositList: rows,
        availableDepositDisplay: this.formatDepositPickerOptions(rows),
        depositPickerIndex: this.getDepositPickerIndex(rows, this.getDepositItemsFromPaymentMethods(paymentMethods)),
        depositLoading: false
      });
      if (!rows.length && options.showToast) {
        wx.showToast({ title: '暂无可核销定金', icon: 'none' });
      }
      return rows;
    }).catch(err => {
      if (requestId !== this._depositLoadRequestId) {
        return [];
      }
      console.error('加载可核销定金失败:', err);
      this.setData({
        availableDepositList: [],
        availableDepositDisplay: ['无'],
        depositPickerIndex: 0,
        depositLoading: false
      });
      if (options.showToast) {
        wx.showToast({ title: '加载定金失败', icon: 'none' });
      }
      return [];
    });
  },

  scheduleAvailableDepositsReload: function () {
    if (this._depositReloadTimer) {
      clearTimeout(this._depositReloadTimer);
    }
    this._depositReloadTimer = setTimeout(() => {
      this._depositReloadTimer = null;
      this.loadAvailableDeposits({ showToast: false });
    }, 300);
  },

  /**
   * 检查是否有国补POS（手机平板）收款方式
   */
  checkGuobuPhonePayment: function () {
    const paymentMethods = this.data.paymentMethods;
    const hasGuobuPhonePayment = paymentMethods.some(method =>
      method.type === '国补POS（手机平板）'
    );
    this.setData({
      hasGuobuPhonePayment: hasGuobuPhonePayment
    });
  },

  /**
   * IMEI1输入处理
   */
  onIMEI1Input: function (e) {
    this.setData({
      imei1: e.detail.value
    });
  },

  /**
   * IMEI2输入处理
   */
  onIMEI2Input: function (e) {
    this.setData({
      imei2: e.detail.value
    });
  },

  /**
   * 扫码IMEI1
   */
  scanIMEI1: function () {
    wx.scanCode({
      success: (res) => {
        this.setData({
          imei1: res.result
        });
      },
      fail: (err) => {
        console.error('扫码失败:', err);
        wx.showToast({
          title: '扫码失败',
          icon: 'none'
        });
      }
    });
  },

  /**
   * 扫码IMEI2
   */
  scanIMEI2: function () {
    wx.scanCode({
      success: (res) => {
        this.setData({
          imei2: res.result
        });
      },
      fail: (err) => {
        console.error('扫码失败:', err);
        wx.showToast({
          title: '扫码失败',
          icon: 'none'
        });
      }
    });
  },

  /**
   * 商品信息输入处理
   */
  onGoodsInput: function (e) {
    const index = e.currentTarget.dataset.index;
    const field = e.currentTarget.dataset.field;
    let value = e.detail.value;

    // PN和SN码自动转换为大写
    if (field === 'pnCode' || field === 'snCode') {
      value = value.toUpperCase();
    }

    const goodsList = this.data.goodsList;

    // 处理数字类型字段，限制2位小数，保留字符串以支持输入过程中的小数点
    if (field === 'price' || field === 'quantity') {
      value = this.limitDecimals(value, 2);
    }

    goodsList[index][field] = value;
    if (field === 'pnCode') {
      goodsList[index].productId = '';
      goodsList[index].needSn = false;
      goodsList[index].pnOptions = [];
      goodsList[index].pnOptionsDisplay = [];
      goodsList[index].pnPickerIndex = 0;
      goodsList[index].pnStockStatus = '';
      goodsList[index].inventoryId = '';
      goodsList[index].snCode = '';
      goodsList[index].snOptions = [];
      goodsList[index].snOptionsDisplay = [];
      goodsList[index].snRecords = [];
      goodsList[index].snPickerIndex = 0;
      goodsList[index].snStockStatus = '';
    } else if (field === 'snCode') {
      goodsList[index].inventoryId = '';
      goodsList[index].snPickerIndex = 0;
    }

    // 重新计算当前商品的小计（使用parseFloat转换）
    const price = parseFloat(goodsList[index].price) || 0;
    const quantity = parseFloat(goodsList[index].quantity) || 0;
    goodsList[index].subtotal = price * quantity;

    // 如果商品名称包含moto（不区分大小写），显示IMEI字段
    if (field === 'name') {
      const name = value || '';
      goodsList[index].showImei = name.toLowerCase().includes('moto');
    }

    this.setData({
      goodsList: goodsList
    });

    // 重新计算总金额
    this.calculateTotal();

    // 自动保存到缓存
    this.saveOrderDataToCache();
  },

  /**
   * 商品信息输入框获得焦点处理
   */
  onGoodsFocus: function (e) {
    const index = e.currentTarget.dataset.index;
    const field = e.currentTarget.dataset.field;
    const goodsList = this.data.goodsList;
    const value = goodsList[index][field];

    if (field === 'pnCode' && goodsList[index].productId && !(goodsList[index].pnOptionsDisplay || []).length) {
      this.fillPnOptionsByInventory(index, goodsList[index].productId, goodsList[index].pnCode);
    }

    // 如果值为0或0.00，清空输入框
    if (value === 0 || value === '0' || value === '0.00' || value === '0.0') {
      goodsList[index][field] = '';
      this.setData({
        goodsList: goodsList
      });
    }
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
    // PN、SN 和商品名称统一通过旁边的按钮主动查询，失焦不再自动回填。
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
    const index = e.currentTarget.dataset.index;
    const item = this.data.goodsList[index] || {};
    const pn = (item.pnCode || '').trim();
    if (!pn && item.productId) {
      wx.showLoading({ title: '查询PN...' });
      this.fillPnOptionsByInventory(index, item.productId, '')
        .then(pnOptions => {
          wx.hideLoading();
          wx.showToast({
            title: pnOptions.length > 1 ? '请选择PN码' : (pnOptions.length === 1 ? '已找到PN码' : '当前门店暂无可选PN'),
            icon: pnOptions.length ? 'success' : 'none'
          });
        })
        .catch(() => wx.hideLoading());
      return;
    }
    if (!pn) {
      wx.showToast({ title: '请输入PN码', icon: 'none' });
      return;
    }
    // PN 支持模糊查询；多个结果通过现有商品选择弹窗选择。
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
    const index = e.currentTarget.dataset.index;
    const selectedIndex = Number(e.detail.value || 0);
    const goodsList = this.data.goodsList;
    const current = goodsList[index] || {};
    const snRecord = selectedIndex > 0 ? ((current.snRecords || [])[selectedIndex - 1] || {}) : {};

    current.snPickerIndex = selectedIndex;
    current.inventoryId = snRecord.inventoryId || snRecord.snId || snRecord.sn_id || '';
    current.snCode = selectedIndex > 0
      ? (snRecord.snCode || snRecord.sn_code || snRecord.sn || (current.snOptions || [])[selectedIndex - 1] || '')
      : '';
    current.inventoryType = snRecord.inventory_type || snRecord.inventoryType || '';
    current.inventoryStatus = snRecord.inventory_status || snRecord.inventoryStatus || snRecord.status || '';
    current.previousSnStatus = current.inventoryStatus || current.previousSnStatus || '在库';

    this.setData({ goodsList });
    this.saveOrderDataToCache();
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
    this.setData({ goodsList, showSnListModal: false, snListModalItems: [] });
    this.calculateTotal();
    this.saveOrderDataToCache();
  },

  onPnPickerChange: function (e) {
    const index = e.currentTarget.dataset.index;
    const selectedIndex = Number(e.detail.value || 0);
    const goodsList = this.data.goodsList;
    const current = goodsList[index] || {};
    const pnCode = selectedIndex > 0 ? ((current.pnOptions || [])[selectedIndex - 1] || '') : '';

    current.pnPickerIndex = selectedIndex;
    current.pnCode = pnCode;
    current.inventoryId = '';
    current.snCode = '';
    current.snOptions = [];
    current.snOptionsDisplay = [];
    current.snRecords = [];
    current.snPickerIndex = 0;
    current.snStockStatus = '';

    this.setData({ goodsList });
    if (pnCode) {
      this.fillSnOptionsByInventory(index, current.productId, pnCode);
    }
    this.saveOrderDataToCache();
  },

  /**
   * 金额输入框获得焦点处理（通用）
   */
  onAmountFocus: function (e) {
    const field = e.currentTarget.dataset.field;
    const value = this.data[field];

    // 如果值为0或0.00，清空输入框
    if (value === 0 || value === '0' || value === '0.00' || value === '0.0') {
      this.setData({
        [field]: ''
      });
    }
  },

  /**
   * 优惠金额输入处理
   */
  onDiscountInput: function (e) {
    const value = this.limitDecimals(e.detail.value, 2);
    this.setData({
      discount: value
    });
    // 重新计算所有金额
    this.calculateTotal();

    // 自动保存到缓存
    this.saveOrderDataToCache();
  },

  /**
   * 国补金额输入处理
   */
  onNationalSubsidyInput: function (e) {
    const value = this.limitDecimals(e.detail.value, 2);
    const nationalSubsidy = parseFloat(value) || 0;

    // 计算新的实收金额
    const goodsList = this.data.goodsList;
    let totalAmount = 0;
    goodsList.forEach(item => {
      const price = parseFloat(item.price) || 0;
      const quantity = parseFloat(item.quantity) || 1;
      totalAmount += price * quantity;
    });
    const discount = parseFloat(this.data.discount) || 0;
    const educationSubsidy = parseFloat(this.data.educationSubsidy) || 0;
    const newActualAmount = Math.max(0, totalAmount - discount - nationalSubsidy - educationSubsidy);

    // 根据国补金额自动切换国补状态
    if (nationalSubsidy === 0) {
      // 国补为0，默认非国补
      this.setData({
        nationalSubsidy: value,
        subsidyStatus: '非国补'
      });
    } else {
      // 国补不为0，强制选择国补，并设置开票金额为实付金额
      this.setData({
        nationalSubsidy: value,
        subsidyStatus: '国补',
        invoiceStatus: '开普票', // 国补必须开普票
        invoiceAmount: this.getDefaultInvoiceAmount(this.data.paymentMethods, '国补')
      });
    }

    // 重新计算所有金额
    this.calculateTotal();

    // 自动保存到缓存
    this.saveOrderDataToCache();
  },

  /**
   * 电脑金额输入处理（计算国补：15%，封顶1500）
   */
  onComputerSubsidyInput: function (e) {
    const value = this.limitDecimals(e.detail.value, 2);
    const computerAmount = parseFloat(value) || 0;

    // 计算国补：15%，封顶1500
    let computerSubsidy = computerAmount * 0.15;
    if (computerSubsidy > 1500) {
      computerSubsidy = 1500;
    }

    // 获取当前手机平板国补
    const mobileAmount = parseFloat(this.data.mobileAmount) || 0;
    let mobileSubsidy = mobileAmount * 0.15;
    if (mobileSubsidy > 500) {
      mobileSubsidy = 500;
    }

    // 总国补 = 电脑国补 + 手机平板国补
    const totalNationalSubsidy = computerSubsidy + mobileSubsidy;

    // 计算新的实收金额
    let totalAmount = 0;
    this.data.goodsList.forEach(item => {
      const price = parseFloat(item.price) || 0;
      const quantity = parseFloat(item.quantity) || 1;
      totalAmount += price * quantity;
    });
    const discount = parseFloat(this.data.discount) || 0;
    const educationSubsidy = parseFloat(this.data.educationSubsidy) || 0;
    const newActualAmount = Math.max(0, totalAmount - discount - totalNationalSubsidy - educationSubsidy);

    // 更新数据
    const updateData = {
      computerAmount: value,
      nationalSubsidy: totalNationalSubsidy.toFixed(2)
    };

    // 根据国补金额自动切换国补状态
    if (totalNationalSubsidy > 0) {
      updateData.subsidyStatus = '国补';
      updateData.invoiceStatus = '开普票'; // 国补必须开普票
      updateData.invoiceAmount = this.getDefaultInvoiceAmount(this.data.paymentMethods, '国补');
    } else {
      updateData.subsidyStatus = '非国补';
    }

    this.setData(updateData);

    // 重新计算所有金额
    this.calculateTotal();

    // 自动保存到缓存
    this.saveOrderDataToCache();
  },

  /**
   * 手机平板金额输入处理（计算国补：15%，封顶500）
   */
  onMobileSubsidyInput: function (e) {
    const value = this.limitDecimals(e.detail.value, 2);
    const mobileAmount = parseFloat(value) || 0;

    // 计算国补：15%，封顶500
    let mobileSubsidy = mobileAmount * 0.15;
    if (mobileSubsidy > 500) {
      mobileSubsidy = 500;
    }

    // 获取当前电脑国补
    const computerAmount = parseFloat(this.data.computerAmount) || 0;
    let computerSubsidy = computerAmount * 0.15;
    if (computerSubsidy > 1500) {
      computerSubsidy = 1500;
    }

    // 总国补 = 电脑国补 + 手机平板国补
    const totalNationalSubsidy = computerSubsidy + mobileSubsidy;

    // 计算新的实收金额
    let totalAmount = 0;
    this.data.goodsList.forEach(item => {
      const price = parseFloat(item.price) || 0;
      const quantity = parseFloat(item.quantity) || 1;
      totalAmount += price * quantity;
    });
    const discount = parseFloat(this.data.discount) || 0;
    const educationSubsidy = parseFloat(this.data.educationSubsidy) || 0;
    const newActualAmount = Math.max(0, totalAmount - discount - totalNationalSubsidy - educationSubsidy);

    // 更新数据
    const updateData = {
      mobileAmount: value,
      nationalSubsidy: totalNationalSubsidy.toFixed(2)
    };

    // 根据国补金额自动切换国补状态
    if (totalNationalSubsidy > 0) {
      updateData.subsidyStatus = '国补';
      updateData.invoiceStatus = '开普票'; // 国补必须开普票
      updateData.invoiceAmount = this.getDefaultInvoiceAmount(this.data.paymentMethods, '国补');
    } else {
      updateData.subsidyStatus = '非国补';
    }

    this.setData(updateData);

    // 重新计算所有金额
    this.calculateTotal();

    // 自动保存到缓存
    this.saveOrderDataToCache();
  },

  /**
   * 教育补贴金额输入处理
   */
  onEducationSubsidyInput: function (e) {
    const value = this.limitDecimals(e.detail.value, 2);
    this.setData({
      educationSubsidy: value
    });
    // 重新计算所有金额
    this.calculateTotal();

    // 自动保存到缓存
    this.saveOrderDataToCache();
  },

  /**
   * 计算默认利润比例
   * @param {number} totalPeople - 总人数（包括销售人）
   * @returns {number} - 默认比例
   */
  calculateDefaultRatio: function (totalPeople) {
    if (totalPeople === 2) {
      return 50;
    } else if (totalPeople === 3) {
      return 33;
    }
    return 0;
  },

  /**
   * 添加辅助销售人
   */
  addAuxiliarySales: function () {
    const auxiliarySalesList = this.data.auxiliarySalesList;
    // 新总人数 = 销售人(1) + 现有辅助销售人数量 + 新添加的辅助销售人(1)
    const newTotalPeople = 1 + auxiliarySalesList.length + 1;

    // 判断添加后是否超过3人（即辅助销售人是否超过2人）
    const willExceedLimit = auxiliarySalesList.length >= 2;

    // 计算默认利润比例
    // 如果超过限制，新添加的人比例为0，其他人保持原比例
    // 否则根据人数设置默认比例
    const defaultRatio = willExceedLimit ? 0 : this.calculateDefaultRatio(newTotalPeople);

    // 只有未超过限制时才更新现有辅助销售人的比例
    if (!willExceedLimit) {
      auxiliarySalesList.forEach(item => {
        item.ratio = defaultRatio;
      });
    }

    // 添加新的辅助销售人
    auxiliarySalesList.push({
      selected: '无',
      selectedDisplay: '无',
      optionIndex: 0,
      profitAmount: 0,
      ratio: defaultRatio
    });

    this.setData({
      auxiliarySalesList: auxiliarySalesList
    });
  },

  /**
   * 删除辅助销售人
   */
  removeAuxiliarySales: function (e) {
    const index = e.currentTarget.dataset.index;
    const auxiliarySalesList = this.data.auxiliarySalesList;

    // 检查是否是主销售人，主销售人不可删除
    if (auxiliarySalesList[index] && auxiliarySalesList[index].isMainSales) {
      wx.showToast({
        title: '主销售人不能删除',
        icon: 'none'
      });
      return;
    }

    auxiliarySalesList.splice(index, 1);

    // 删除后保持剩余人员的原有比例不变，不自动重置
    // 这样用户手动修改的比例值会被保留

    this.setData({
      auxiliarySalesList: auxiliarySalesList
    });
  },

  /**
   * 辅助销售人选择处理
   */
  onAuxiliarySalesChange: function (e) {
    const index = e.currentTarget.dataset.index;
    const optionIndex = Number(e.detail.value || 0);
    const selectedDisplay = this.data.auxiliarySalesOptions[optionIndex] || '无';
    const selectedStaff = (this._auxiliarySalesStaffOptions || [])[optionIndex] || null;
    const auxiliarySalesList = this.data.auxiliarySalesList;
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
      auxiliarySalesList: auxiliarySalesList
    });
  },

  /**
   * 辅助销售人金额分配输入框获得焦点处理
   */
  onAuxiliarySalesProfitAmountFocus: function (e) {
    const index = e.currentTarget.dataset.index;
    const auxiliarySalesList = this.data.auxiliarySalesList;
    const value = auxiliarySalesList[index].profitAmount;

    // 如果值为0或0.00，清空输入框
    if (value === 0 || value === '0' || value === '0.00' || value === '0.0') {
      auxiliarySalesList[index].profitAmount = '';
      this.setData({
        auxiliarySalesList: auxiliarySalesList
      });
    }
  },

  /**
   * 辅助销售人利润金分配输入处理
   * 金额和比例互斥，填写金额时清空比例
   */
  onAuxiliarySalesProfitAmountInput: function (e) {
    const index = e.currentTarget.dataset.index;
    const value = this.limitDecimals(e.detail.value, 2);
    const auxiliarySalesList = this.data.auxiliarySalesList;
    auxiliarySalesList[index].profitAmount = value;

    // 如果输入了金额，清空比例
    if (value && parseFloat(value) > 0) {
      auxiliarySalesList[index].ratio = '';
    }

    this.setData({
      auxiliarySalesList: auxiliarySalesList
    });
  },

  /**
   * 辅助销售人利润比例分配输入处理
   * 金额和比例互斥，填写比例时清空金额
   */
  onAuxiliarySalesRatioInput: function (e) {
    const index = e.currentTarget.dataset.index;
    let value = e.detail.value;

    // 限制只能输入数字
    value = value.replace(/[^0-9]/g, '');

    // 转换为数字并限制范围0-100
    let numValue = parseInt(value) || 0;
    if (numValue > 100) {
      numValue = 100;
    }

    const auxiliarySalesList = this.data.auxiliarySalesList;
    auxiliarySalesList[index].ratio = numValue;

    // 如果输入了比例，清空金额
    if (numValue > 0) {
      auxiliarySalesList[index].profitAmount = '';
    }

    this.setData({
      auxiliarySalesList: auxiliarySalesList
    });
  },

  /**
   * 加载客户来源列表
   */
  loadCustomerSources: function () {
    DataStorage.getCustomerSources(
      (sources) => {
        const level1Sources = sources.filter(s => s.level === 1);
        const level2SourcesMap = {};

        sources.filter(s => s.level === 2).forEach(s => {
          if (!level2SourcesMap[s.parentId]) {
            level2SourcesMap[s.parentId] = [];
          }
          level2SourcesMap[s.parentId].push(s);
        });

        const level1Names = level1Sources.map(s => s.name);
        const cachedLevel1 = wx.getStorageSync('tempCustomerSourceLevel1') || '';
        const cachedLevel2 = wx.getStorageSync('tempCustomerSourceLevel2') || '';

        let selectedLevel1Index = level1Names.indexOf(cachedLevel1);
        if (selectedLevel1Index < 0) selectedLevel1Index = 0;
        const selectedLevel1 = level1Names[selectedLevel1Index] || '';
        const selectedLevel1Id = level1Sources[selectedLevel1Index]?._id || '';

        let selectedLevel2Index = 0;
        const level2List = level2SourcesMap[selectedLevel1Id] || [];
        const level2Names = level2List.map(s => s.name);
        if (level2Names.indexOf(cachedLevel2) >= 0) {
          selectedLevel2Index = level2Names.indexOf(cachedLevel2);
        }

        this.setData({
          customerSourcesLevel1: level1Names,
          customerSourcesLevel2Map: level2SourcesMap,
          customerSourcesLevel2Display: level2Names,
          selectedCustomerSourceLevel1: selectedLevel1,
          selectedCustomerSourceLevel2: level2Names[selectedLevel2Index] || '',
          level1SourcesData: level1Sources
        });
      },
      (err) => {
        console.error('获取客户来源列表失败:', err);
        this.setData({
          customerSourcesLevel1: ['线上', '线下'],
          customerSourcesLevel2Map: {},
          customerSourcesLevel2Display: [],
          selectedCustomerSourceLevel1: '线上',
          selectedCustomerSourceLevel2: ''
        });
      }
    );
  },

  onCustomerSourceLevel1Change: function (e) {
    const index = parseInt(e.detail.value);
    const level1Sources = this.data.level1SourcesData || [];
    const level1Name = this.data.customerSourcesLevel1[index];
    const level1Id = level1Sources[index]?._id || '';
    const level2List = this.data.customerSourcesLevel2Map[level1Id] || [];
    const level2Names = level2List.map(s => s.name);
    const level2Name = level2List.length > 0 ? level2List[0].name : '';

    this.setData({
      selectedCustomerSourceLevel1: level1Name,
      selectedCustomerSourceLevel2: level2Name,
      level1Index: index,
      level2Index: 0,
      customerSourcesLevel2Display: level2Names
    });

    wx.setStorageSync('tempCustomerSourceLevel1', level1Name);
    wx.setStorageSync('tempCustomerSourceLevel2', level2Name);
    this.saveOrderDataToCache();
  },

  onCustomerSourceLevel2Change: function (e) {
    const index = parseInt(e.detail.value);
    const level1Sources = this.data.level1SourcesData || [];
    const level1Index = this.data.level1Index || 0;
    const level1Id = level1Sources[level1Index]?._id || '';
    const level2List = this.data.customerSourcesLevel2Map[level1Id] || [];
    const level2Name = level2List[index]?.name || '';

    this.setData({
      selectedCustomerSourceLevel2: level2Name,
      level2Index: index
    });

    wx.setStorageSync('tempCustomerSourceLevel2', level2Name);
    this.saveOrderDataToCache();
  },

  getCustomerSourceLevel2List: function () {
    const level1Sources = this.data.level1SourcesData || [];
    const level1Index = this.data.level1Index || 0;
    const level1Id = level1Sources[level1Index]?._id || '';
    return this.data.customerSourcesLevel2Map[level1Id] || [];
  },

  /**
   * 加载收款方式列表
   */
  loadPaymentMethods: function () {
    DataStorage.getPaymentMethods(
      (methods) => {
        // 提取收款方式名称到数组，按sortOrder升序排列（数据库已排序）
        const paymentMethodNames = methods
          .map(method => method.name)
          .filter(name => !this.isDepositPayment(name));
        paymentMethodNames.push('定金抵扣');
        this.setData({
          paymentMethodOptions: [...new Set(paymentMethodNames)]
        });
      },
      (err) => {
        console.error('获取收款方式列表失败:', err);
        // 失败时使用默认值
        this.setData({
          paymentMethodOptions: ['二维码', '国补POS', '智店通POS', '现金', '对公转账', 'OMO支付', '定金抵扣']
        });
      }
    );
  },

  /**
   * 加载门店店员信息作为辅助销售人选项
   */
  loadStaffList: function () {
    const currentStoreId = this.getCurrentStoreId();
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
      const auxiliarySalesList = (this.data.auxiliarySalesList || []).map(item => {
        if (!item || item.selected === '无') {
          return Object.assign({}, item, { selected: '无', selectedDisplay: '无', optionIndex: 0 });
        }
        const matchedIndex = staffList.findIndex(staff => {
          if (item.staffId && staff.staffId && String(item.staffId) === String(staff.staffId)) return true;
          if (item.phone && staff.phone && String(item.phone) === String(staff.phone)) return true;
          return (
            item.selected === staff.name &&
            (!item.storeId || String(item.storeId) === String(staff.storeId || ''))
          );
        });
        if (matchedIndex < 0) return item;
        const matchedStaff = staffList[matchedIndex];
        return Object.assign({}, item, {
          selected: matchedStaff.name,
          selectedDisplay: matchedStaff.displayName,
          optionIndex: matchedIndex + 1,
          staffId: matchedStaff.staffId,
          phone: matchedStaff.phone,
          storeId: matchedStaff.storeId,
          storeName: matchedStaff.storeName,
          regionId: matchedStaff.regionId
        });
      });
      this.setData({
        auxiliarySalesOptions: ['无'].concat(staffList.map(staff => staff.displayName)),
        auxiliarySalesList
      });
      console.log('辅助销售人选项加载成功，共', staffList.length, '人');
    };

    DataStorage.getAllStaffByDistributor(distributorId, applyStaffList, (err) => {
      console.error('获取辅助销售人列表失败:', err);
      applyStaffList([]);
    });
  },

  /**
   * 联系人输入处理
   */
  onContactNameInput: function (e) {
    const contactName = e.detail.value;
    const { subsidyStatus, subsidyPerson } = this.data;

    // 如果国补状态为"国补"且国补人姓名为空，则自动同步
    if (subsidyStatus === '国补' && !subsidyPerson) {
      this.setData({
        contactName: contactName,
        subsidyPerson: contactName
      });
    } else {
      this.setData({
        contactName: contactName
      });
    }

    // 自动保存到缓存
    this.saveOrderDataToCache();
  },

  /**
   * 联系方式输入处理
   */
  onContactMethodInput: function (e) {
    const contactMethod = e.detail.value;
    const { subsidyStatus, subsidyId } = this.data;

    // 如果国补状态为"国补"且国补人ID为空，则自动同步
    if (subsidyStatus === '国补' && !subsidyId) {
      this.setData({
        contactMethod: contactMethod,
        subsidyId: contactMethod
      });
    } else {
      this.setData({
        contactMethod: contactMethod
      });
    }

    // 自动保存到缓存
    this.saveOrderDataToCache();

    // 首次加载结果可能为空；会员ID变化后也必须重新查询定金库。
    this.scheduleAvailableDepositsReload();
  },

  /**
   * 会员ID输入处理（同步到国补人ID）
   */
  onCustomerIdInput: function (e) {
    const customerId = e.detail.value;
    const { subsidyStatus, subsidyId } = this.data;

    // 如果国补状态为"国补"且国补人ID为空，则自动同步
    if (subsidyStatus === '国补' && !subsidyId) {
      this.setData({
        contactMethod: customerId,
        subsidyId: customerId
      });
    } else {
      this.setData({
        contactMethod: customerId
      });
    }

    // 自动保存到缓存
    this.saveOrderDataToCache();

    // 首次加载结果可能为空；会员ID变化后也必须重新查询定金库。
    this.scheduleAvailableDepositsReload();
  },

  /**
   * 开票信息输入处理
   */
  onInvoiceInfoInput: function (e) {
    this.setData({
      invoiceInfo: e.detail.value
    });

    // 输入过程中不再同步写缓存，降低 iOS 键盘场景下的卡顿和重排概率
    this.scheduleSaveOrderDataToCache();
  },

  onInvoiceInfoFocus: function () {
    this.setData({ isInvoiceInfoFocused: true });
  },

  onInvoiceInfoBlur: function () {
    this.setData({ isInvoiceInfoFocused: false });
    if (this._invoiceCacheTimer) {
      clearTimeout(this._invoiceCacheTimer);
      this._invoiceCacheTimer = null;
    }
    // 失焦时立即保存，确保离开字段前草稿已落盘
    this.saveOrderDataToCache();
  },

  /**
   * 开票金额输入处理
   */
  onInvoiceAmountInput: function (e) {
    // 限制只能输入数字和小数点，最多2位小数
    let value = e.detail.value;
    // 过滤掉除数字和小数点以外的字符
    value = value.replace(/[^0-9.]/g, '');
    // 处理多个小数点的情况，只保留第一个
    const firstDotIndex = value.indexOf('.');
    if (firstDotIndex !== -1) {
      const beforeDot = value.substring(0, firstDotIndex + 1);
      const afterDot = value.substring(firstDotIndex + 1).replace(/\./g, '');
      value = beforeDot + afterDot;
    }
    // 限制小数位数为2位
    if (value.indexOf('.') !== -1) {
      const parts = value.split('.');
      if (parts[1] && parts[1].length > 2) {
        value = parts[0] + '.' + parts[1].substring(0, 2);
      }
    }

    this.setData({
      invoiceAmount: value
    });

    // 自动保存到缓存
    this.saveOrderDataToCache();
  },

  /**
   * 收款方式选择处理
   */
  onPaymentMethodChange: function (e) {
    const index = parseInt(e.currentTarget.dataset.index, 10);
    if (isNaN(index) || index < 0) return;
    const paymentMethods = this.getEditablePaymentMethods(this.data.paymentMethods, index);
    const nextType = this.data.paymentMethodOptions[e.detail.value] || '';
    if (this.isDepositPayment(nextType) && paymentMethods.some((method, methodIndex) => {
      return methodIndex !== index && this.isDepositPayment(method.type);
    })) {
      wx.showToast({ title: '定金抵扣只能添加一次', icon: 'none' });
      return;
    }

    const wasDeposit = this.isDepositPayment(paymentMethods[index].type);
    paymentMethods[index].type = nextType;
    if (wasDeposit || this.isDepositPayment(nextType)) {
      paymentMethods[index].amount = '';
      paymentMethods[index].depositId = '';
      paymentMethods[index].depositNo = '';
      paymentMethods[index].customerName = '';
      paymentMethods[index].customerPhone = '';
      paymentMethods[index].availableAmount = '';
      paymentMethods[index].depositPickerIndex = 0;
    }
    const depositItems = this.getDepositItemsFromPaymentMethods(paymentMethods);
    
    // 计算收款金额汇总（支持国补POS特殊计算）
    const summary = this.recalculatePaymentSummary(paymentMethods);
    const updateData = {
      paymentMethods: paymentMethods,
      depositItems,
      paymentTotal: summary.paymentTotal,
      differenceAmount: summary.differenceAmount
    };
    if (this.data.subsidyStatus === '国补') {
      updateData.invoiceAmount = this.getDefaultInvoiceAmount(paymentMethods);
    }

    this.setData(updateData, () => {
      this.calculateTotal();
    });

    // 检查是否有国补POS（手机平板）收款方式
    this.checkGuobuPhonePayment();

    // 自动保存到缓存
    this.saveOrderDataToCache();
    if (this.isDepositPayment(nextType)) {
      this.loadAvailableDeposits({ showToast: true });
    }
  },

  /**
   * 收款金额输入框获得焦点处理
   */
  onPaymentAmountFocus: function (e) {
    const index = parseInt(e.currentTarget.dataset.index, 10);
    if (isNaN(index) || index < 0) return;
    const paymentMethods = this.getEditablePaymentMethods(this.data.paymentMethods, index);
    const value = paymentMethods[index].amount;

    // 如果值为0或0.00，清空输入框
    if (value === 0 || value === '0' || value === '0.00' || value === '0.0') {
      paymentMethods[index].amount = '';
      this.setData({
        paymentMethods: paymentMethods
      });
    }
  },

  /**
   * 收款金额输入处理
   */
  onPaymentAmountInput: function (e) {
    const index = parseInt(e.currentTarget.dataset.index, 10);
    if (isNaN(index) || index < 0) return;
    const value = this.limitDecimals(e.detail.value, 2);
    const paymentMethods = this.getEditablePaymentMethods(this.data.paymentMethods, index);
    paymentMethods[index].amount = value;

    // 计算收款金额汇总（支持国补POS特殊计算）
    const summary = this.recalculatePaymentSummary(paymentMethods);
    const updateData = {
      paymentMethods: paymentMethods,
      paymentTotal: summary.paymentTotal,
      differenceAmount: summary.differenceAmount
    };
    if (this.data.subsidyStatus === '国补') {
      updateData.invoiceAmount = this.getDefaultInvoiceAmount(paymentMethods);
    }

    this.setData(updateData);

    // 自动保存到缓存
    this.saveOrderDataToCache();
  },

  clearSelectedDeposits: function () {
    const paymentMethods = (this.data.paymentMethods || []).map(method => {
      if (!this.isDepositPayment(method.type)) return this.normalizePaymentMethod(method);
      return this.createDepositPaymentMethod();
    });
    this.setData({
      paymentMethods,
      depositItems: this.getDepositItemsFromPaymentMethods(paymentMethods),
      depositPickerIndex: 0
    }, () => {
      this.calculateTotal();
      this.saveOrderDataToCache();
    });
  },

  /**
   * 开票状态变化处理
   */
  onInvoiceStatusChange: function (e) {
    const value = e.detail.value;

    // 如果选择了国补，不能选择不开票
    if (this.data.subsidyStatus === '国补' && (value === '不开票' || value === '开专票')) {
      wx.showToast({
        title: '选择国补时必须开普票',
        icon: 'none'
      });
      return;
    }

    this.setData({
      invoiceStatus: value,
      invoiceAmount: value === '不开票' ? 0 : this.getDefaultInvoiceAmount(this.data.paymentMethods)
    });

    // 自动保存到缓存
    this.saveOrderDataToCache();
  },
  
  /**
   * 国补状态变化处理
   */
  onSubsidyStatusChange: function (e) {
    const value = e.detail.value;
    const { contactName, contactMethod, subsidyPerson, subsidyId } = this.data;

    // 如果选择了国补，自动设置开票状态为开普票，并同步国补人信息
    if (value === '国补') {
      const updateData = {
        subsidyStatus: value,
        invoiceStatus: '开普票',
        invoiceAmount: this.getDefaultInvoiceAmount(this.data.paymentMethods, '国补')
      };

      // 如果国补人姓名为空，则同步会员称呼
      if (!subsidyPerson && contactName) {
        updateData.subsidyPerson = contactName;
      }

      // 如果国补人ID为空，则同步会员ID
      if (!subsidyId && contactMethod) {
        updateData.subsidyId = contactMethod;
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

    // 自动保存到缓存
    this.saveOrderDataToCache();
  },

  /**
   * 国补人输入处理
   */
  onSubsidyPersonInput: function (e) {
    this.setData({
      subsidyPerson: e.detail.value
    });

    // 自动保存到缓存
    this.saveOrderDataToCache();
  },

  onSubsidyPersonFocus: function () {
    if (this.data.contactName) {
      this.setData({ subsidyPerson: this.data.contactName });
      this.saveOrderDataToCache();
    }
  },

  /**
   * 国补人ID输入处理
   */
  onSubsidyIdInput: function (e) {
    // 限制只能输入数字
    let value = e.detail.value.replace(/[^0-9]/g, '');
    // 限制最多11位
    if (value.length > 11) {
      value = value.substring(0, 11);
    }

    this.setData({
      subsidyId: value
    });

    // 自动保存到缓存
    this.saveOrderDataToCache();
  },

  onSubsidyIdFocus: function () {
    if (this.data.contactMethod) {
      this.setData({ subsidyId: this.data.contactMethod });
      this.saveOrderDataToCache();
    }
  },
  
  /**
   * 选择国补照片
   */
  initPrivacyAuthorization: function () {
    if (typeof wx.onNeedPrivacyAuthorization !== 'function') return;

    wx.onNeedPrivacyAuthorization((resolve, eventInfo) => {
      this.resolvePrivacyAuthorization = resolve;
      this.setData({
        showPrivacyModal: true,
        privacyContractName: (eventInfo && eventInfo.privacyContractName) || this.data.privacyContractName || '隐私保护指引'
      });
    });
  },

  requestPrivacyAuthorization: function (onSuccess, onFail) {
    if (typeof wx.requirePrivacyAuthorize !== 'function') {
      onSuccess();
      return;
    }

    wx.requirePrivacyAuthorize({
      success: onSuccess,
      fail: (err) => {
        this.pendingPrivacyAction = null;
        if (typeof onFail === 'function') {
          onFail(err);
        }
      }
    });
  },

  onAgreePrivacyAuthorization: function () {
    this.setData({ showPrivacyModal: false });

    if (this.resolvePrivacyAuthorization) {
      this.resolvePrivacyAuthorization({
        buttonId: 'agree-btn',
        event: 'agree'
      });
      this.resolvePrivacyAuthorization = null;
    }
  },

  closePrivacyAuthorization: function () {
    this.setData({ showPrivacyModal: false });

    if (this.resolvePrivacyAuthorization) {
      this.resolvePrivacyAuthorization({
        event: 'disagree'
      });
      this.resolvePrivacyAuthorization = null;
    }

    wx.showToast({
      title: '需同意隐私授权',
      icon: 'none'
    });
  },

  openPrivacyContract: function () {
    if (typeof wx.openPrivacyContract !== 'function') return;

    wx.openPrivacyContract({
      fail: (err) => {
        console.error('打开隐私协议失败:', err);
      }
    });
  },

  chooseOrderImages: function (options = {}) {
    const count = options.count || 1;
    const onSuccess = typeof options.success === 'function' ? options.success : function () {};
    const onFail = typeof options.fail === 'function' ? options.fail : null;

    const isCancel = (err) => {
      const errMsg = (err && err.errMsg) || '';
      return errMsg.toLowerCase().indexOf('cancel') !== -1;
    };

    const isPrivacyScopeMissing = (err) => {
      const errMsg = (err && err.errMsg) || '';
      return err && (err.errno === 112 || errMsg.indexOf('api scope is not declared in the privacy agreement') !== -1);
    };

    const handleFail = (err) => {
      if (isCancel(err)) return;

      console.error('选择照片失败:', err);

      if (onFail) {
        onFail(err);
        return;
      }

      const errMsg = (err && err.errMsg) || '';
      if (isPrivacyScopeMissing(err)) {
        wx.showModal({
          title: '隐私声明未配置',
          content: '请在微信公众平台的用户隐私保护指引中声明相册/摄像头或图片上传相关接口，审核生效后再重新编译。',
          showCancel: false,
          confirmText: '知道了'
        });
        return;
      }

      wx.showToast({
        title: /privacy|authorize|auth/i.test(errMsg) ? '请先同意授权' : '选择照片失败',
        icon: 'none'
      });
    };

    const normalizeMediaResult = (res) => {
      const tempFiles = res.tempFiles || [];
      const tempFilePaths = tempFiles
        .map(item => item.tempFilePath || item.path)
        .filter(Boolean);

      if (!tempFilePaths.length) {
        handleFail({ errMsg: 'chooseMedia:fail empty tempFilePath' });
        return;
      }

      onSuccess({
        tempFilePaths,
        tempFiles
      });
    };

    const chooseByImage = () => {
      wx.chooseImage({
        count,
        sizeType: ['original'],
        sourceType: ['album', 'camera'],
        success: onSuccess,
        fail: handleFail
      });
    };

    // chooseMedia 没有 sizeType 参数，为保证照片默认原图，统一走 chooseImage。
    const chooseByMedia = () => chooseByImage();

    this.requestPrivacyAuthorization(chooseByMedia, handleFail);
  },

  chooseSubsidyPhoto: function (e) {
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

    const index = e.currentTarget.dataset.index;
    this.chooseOrderImages({
      count: 1,
      success: (res) => {
        const tempFilePath = res.tempFilePaths[0];
        this.uploadSubsidyPhoto(tempFilePath, index);
      },
      fail: (err) => {
        console.error('选择照片失败:', err);
        wx.showToast({
          title: '选择照片失败',
          icon: 'none'
        });
      }
    });
  },

  /**
   * 上传国补照片
   */
  uploadSubsidyPhoto: function (tempFilePath, index) {
    wx.showLoading({
      title: '上传中...',
    });

    // 获取当前日期时间
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');
    const second = String(now.getSeconds()).padStart(2, '0');
    const dateTimeStr = `${year}${month}${day}${hour}${minute}${second}`;

    // 获取国补人姓名（优先使用国补人，如果没有则使用客户称呼）
    const subsidyPerson = this.data.subsidyPerson || this.data.contactName || '未知客户';

    // 获取照片标题
    const photoTitle = this.data.subsidyPhotos[index].name || '照片';

    // 过滤文件名中的特殊字符（保留中文、英文、数字、下划线，移除空格、+号和括号避免URL编码问题）
    const sanitizeFileName = (str) => {
      return str.replace(/[\\/:*?"<>|、，,\s+()（）]/g, '');
    };

    // 构建文件名：时间+国补人+标题
    const photoName = `${dateTimeStr}_${sanitizeFileName(subsidyPerson)}_${sanitizeFileName(photoTitle)}.jpg`;

    // 检查云开发环境是否可用
    const app = getApp();
    if (app.isCloudAvailable()) {
      // 云开发环境可用，尝试云上传
      wx.cloud.uploadFile({
        cloudPath: `subsidy_photos/${photoName}`,
        filePath: tempFilePath,
        success: (res) => {
          const fileID = res.fileID;
          const subsidyPhotos = this.data.subsidyPhotos;
          subsidyPhotos[index].url = fileID;

          this.setData({
            subsidyPhotos: subsidyPhotos
          });

          wx.hideLoading();
          wx.showToast({
            title: '上传成功',
            icon: 'success'
          });
        },
        fail: (err) => {
          console.error('云上传失败:', err);
          // 云上传失败，使用本地临时路径作为备选
          const subsidyPhotos = this.data.subsidyPhotos;
          subsidyPhotos[index].url = tempFilePath;

          this.setData({
            subsidyPhotos: subsidyPhotos
          });

          wx.hideLoading();
          wx.showToast({
            title: '上传成功（本地缓存）',
            icon: 'success'
          });
        }
      });
    } else {
      // 云开发环境不可用，使用本地临时路径
      const subsidyPhotos = this.data.subsidyPhotos;
      subsidyPhotos[index].url = tempFilePath;

      this.setData({
        subsidyPhotos: subsidyPhotos
      });

      wx.hideLoading();
      wx.showToast({
        title: '云开发不可用，已保存本地',
        icon: 'success'
      });
    }
  },

  /**
   * 删除国补照片
   */
  deleteSubsidyPhoto: function (e) {
    const index = e.currentTarget.dataset.index;
    const subsidyPhotos = this.data.subsidyPhotos;
    subsidyPhotos[index].url = '';

    this.setData({
      subsidyPhotos: subsidyPhotos
    });

    wx.showToast({
      title: '删除成功',
      icon: 'success'
    });
  },

  /**
   * 合并缓存的国补照片数据与新的照片定义
   * 用于确保新增的照片框能显示出来，同时保留已上传的照片
   * @param {Array} cachedPhotos - 缓存的照片数据
   * @param {Array} defaultPhotos - 默认的照片定义（包含最新的name定义）
   * @returns {Array} 合并后的照片数组
   */
  mergeSubsidyPhotos: function (cachedPhotos, defaultPhotos) {
    // 如果没有缓存数据，直接返回默认定义
    if (!cachedPhotos || !Array.isArray(cachedPhotos) || cachedPhotos.length === 0) {
      return defaultPhotos;
    }

    // 以默认定义为基础，将缓存中的url合并进来
    return defaultPhotos.map((defaultPhoto, index) => {
      // 如果缓存中有对应索引的照片数据，保留其url
      if (index < cachedPhotos.length && cachedPhotos[index].url) {
        return {
          ...defaultPhoto,
          url: cachedPhotos[index].url
        };
      }
      return defaultPhoto;
    });
  },

  /**
   * 预览国补照片
   */
  previewSubsidyPhoto: function (e) {
    const index = e.currentTarget.dataset.index;
    const urls = this.data.subsidyPhotos.map(p => p.url).filter(u => u);
    const currentUrl = this.data.subsidyPhotos[index].url;

    if (!currentUrl) return;

    wx.previewImage({
      current: currentUrl,
      urls: urls
    });
  },

  /**
   * 上传非国补商品图片（支持多图）
   */
  uploadProductPhoto: function () {
    const currentCount = this.data.productPhotoUrls.length;
    const maxCount = 9 - currentCount;

    if (maxCount <= 0) {
      wx.showToast({
        title: '最多上传9张图片',
        icon: 'none'
      });
      return;
    }

    this.chooseOrderImages({
      count: maxCount,
      success: (res) => {
        const tempFilePaths = res.tempFilePaths;

        wx.showLoading({
          title: '上传中...',
        });

        // 获取当前日期时间
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hour = String(now.getHours()).padStart(2, '0');
        const minute = String(now.getMinutes()).padStart(2, '0');
        const second = String(now.getSeconds()).padStart(2, '0');
        const dateTimeStr = `${year}${month}${day}${hour}${minute}${second}`;

        // 获取订单编号
        const orderNo = this.data.orderNo || '未知订单';

        // 上传所有选中的图片
        const uploadPromises = tempFilePaths.map((tempFilePath, index) => {
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
          let fileName = `product_${orderNo}`;
          if (highestSnCode) {
            fileName += `_${highestSnCode}`;
          }
          fileName += `_${dateTimeStr}_${index}.jpg`;

          return new Promise((resolve, reject) => {
            wx.cloud.uploadFile({
              cloudPath: `orders/${orderNo}/${fileName}`,
              filePath: tempFilePath,
              success: (uploadRes) => {
                resolve(uploadRes.fileID);
              },
              fail: (err) => {
                console.error('上传失败:', err);
                // 上传失败，使用本地临时路径
                resolve(tempFilePath);
              }
            });
          });
        });

        Promise.all(uploadPromises)
          .then(fileIDs => {
            const newProductPhotoUrls = [...this.data.productPhotoUrls, ...fileIDs];
            this.setData({
              productPhotoUrls: newProductPhotoUrls
            });

            wx.hideLoading();
            wx.showToast({
              title: `成功上传${fileIDs.length}张图片`,
              icon: 'success'
            });
          })
          .catch(err => {
            wx.hideLoading();
            console.error('上传失败:', err);
            wx.showToast({
              title: '上传失败',
              icon: 'none'
            });
          });
      },
      fail: (err) => {
        console.error('选择照片失败:', err);
        wx.showToast({
          title: '选择照片失败',
          icon: 'none'
        });
      }
    });
  },

  /**
   * 预览非国补商品图片
   */
  previewProductPhoto: function (e) {
    const index = e.currentTarget.dataset.index;
    const urls = this.data.productPhotoUrls;

    wx.previewImage({
      current: urls[index],
      urls: urls
    });
  },

  /**
   * 删除非国补商品图片
   */
  deleteProductPhoto: function (e) {
    const index = e.currentTarget.dataset.index;
    const productPhotoUrls = this.data.productPhotoUrls;

    productPhotoUrls.splice(index, 1);
    this.setData({
      productPhotoUrls: productPhotoUrls
    });

    wx.showToast({
      title: '删除成功',
      icon: 'success'
    });
  },

  /**
   * 上传教育补贴核销凭证图片
   */
  uploadEducationSubsidyPhoto: function () {
    this.chooseOrderImages({
      count: 1,
      success: (res) => {
        const tempFilePath = res.tempFilePaths[0];
        this.setData({
          educationSubsidyTempFilePath: tempFilePath,
          educationSubsidyOcrStatus: '图片上传中...'
        });

        wx.showLoading({
          title: '上传中...',
        });

        // 获取当前日期时间
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hour = String(now.getHours()).padStart(2, '0');
        const minute = String(now.getMinutes()).padStart(2, '0');
        const second = String(now.getSeconds()).padStart(2, '0');
        const dateTimeStr = `${year}${month}${day}${hour}${minute}${second}`;

        // 获取订单编号
        const orderNo = this.data.orderNo || '未知订单';

        // 构建文件名
        const fileName = `edu_subsidy_${orderNo}_${dateTimeStr}.jpg`;

        // 上传到云存储
        wx.cloud.uploadFile({
          cloudPath: `orders/${orderNo}/${fileName}`,
          filePath: tempFilePath,
          success: (uploadRes) => {
            const fileID = uploadRes.fileID;

            this.setData({
              educationSubsidyPhotoUrl: fileID,
              educationSubsidyOcrStatus: '凭证已上传，正在OCR识别券码'
            });

            wx.hideLoading();
            wx.showToast({
              title: '上传成功',
              icon: 'success'
            });
            this.recognizeEducationSubsidyCoupon(tempFilePath);
          },
          fail: (err) => {
            console.error('上传失败:', err);

            // 上传失败，使用本地临时路径
            this.setData({
              educationSubsidyPhotoUrl: tempFilePath,
              educationSubsidyOcrStatus: '凭证已保存本地，正在OCR识别券码'
            });

            wx.hideLoading();
            wx.showToast({
              title: '上传失败（已保存本地）',
              icon: 'none'
            });
            this.recognizeEducationSubsidyCoupon(tempFilePath);
          }
        });
      },
      fail: (err) => {
        console.error('选择照片失败:', err);
        wx.showToast({
          title: '选择照片失败',
          icon: 'none'
        });
      }
    });
  },

  /**
   * 删除教育补贴核销凭证图片
   */
  deleteEducationSubsidyPhoto: function () {
    this.setData({
      educationSubsidyPhotoUrl: '',
      educationSubsidyCouponCode: '',
      educationSubsidyOcrText: '',
      educationSubsidyOcrStatus: '',
      educationSubsidyTempFilePath: ''
    });

    wx.showToast({
      title: '删除成功',
      icon: 'success'
    });
  },

  /**
   * 选择个人资料照片
   */
  recognizeEducationSubsidyCoupon: function (filePath) {
    if (!filePath) return;

    this.setData({
      educationSubsidyOcrStatus: 'OCR识别中...'
    });

    couponOcr.recognizeCouponCode(filePath, { scene: 'education_subsidy' })
      .then(result => {
        const couponCode = result.couponCode || '';
        this.setData({
          educationSubsidyCouponCode: couponCode,
          educationSubsidyOcrText: result.rawText || '',
          educationSubsidyOcrStatus: couponCode ? 'OCR识别成功，可手动修改' : '未识别到券码，请手动输入'
        });
        this.saveOrderDataToCache();
      })
      .catch(err => {
        console.error('教育补贴券码OCR失败:', err);
        this.setData({
          educationSubsidyOcrStatus: 'OCR识别失败，请手动输入券码'
        });
        wx.showToast({
          title: 'OCR识别失败',
          icon: 'none'
        });
      });
  },

  retryEducationSubsidyCouponOcr: function () {
    const filePath = this.data.educationSubsidyTempFilePath;
    if (!filePath) {
      wx.showToast({
        title: '请重新上传图片后识别',
        icon: 'none'
      });
      return;
    }

    this.recognizeEducationSubsidyCoupon(filePath);
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
          educationSubsidyCouponCode: couponCode,
          educationSubsidyOcrStatus: '扫码成功，可手动修改'
        });
        this.saveOrderDataToCache();
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
      educationSubsidyCouponCode: e.detail.value,
      educationSubsidyOcrStatus: e.detail.value ? '已手动输入券码' : ''
    });
    this.saveOrderDataToCache();
  },

  choosePersonalInfoPhoto: function (e) {
    this.chooseOrderImages({
      count: 1,
      success: (res) => {
        const tempFilePath = res.tempFilePaths[0];
        this.uploadPersonalInfoPhoto(tempFilePath);
      },
      fail: (err) => {
        console.error('选择照片失败:', err);
        wx.showToast({
          title: '选择照片失败',
          icon: 'none'
        });
      }
    });
  },

  /**
   * 上传个人资料照片
   */
  uploadPersonalInfoPhoto: function (tempFilePath) {
    wx.showLoading({
      title: '上传中...',
    });

    // 获取当前日期时间
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');
    const second = String(now.getSeconds()).padStart(2, '0');
    const dateTimeStr = `${year}${month}${day}${hour}${minute}${second}`;

    // 获取客户姓名 - 优先使用国补人姓名，其次使用联系人姓名
    const customerName = this.data.subsidyPerson || this.data.contactName || '未知客户';
    console.log('上传个人资料照片 - 客户姓名:', customerName, ' subsidyPerson:', this.data.subsidyPerson, ' contactName:', this.data.contactName);

    // 获取照片标题
    const photoTitle = this.data.personalInfoPhoto.name || '个人资料';

    // 过滤文件名中的特殊字符（保留中文、英文、数字、下划线，移除空格、+号和括号避免URL编码问题）
    const sanitizeFileName = (str) => {
      return str.replace(/[\\/:*?"<>|、，,\s+()（）]/g, '');
    };

    // 构建文件名：时间+姓名+标题
    const photoName = `${dateTimeStr}_${sanitizeFileName(customerName)}_${sanitizeFileName(photoTitle)}.jpg`;
    const cloudPath = `personal-info-photos/${photoName}`;

    wx.cloud.uploadFile({
      cloudPath: cloudPath,
      filePath: tempFilePath,
      success: (res) => {
        console.log('个人资料照片上传成功:', res);
        const fileID = res.fileID;

        // 获取临时访问链接
        wx.cloud.getTempFileURL({
          fileList: [fileID],
          success: (urlRes) => {
            wx.hideLoading();
            const tempFileURL = urlRes.fileList[0].tempFileURL;

            // 更新数据
            this.setData({
              personalInfoPhoto: {
                url: tempFileURL,
                fileID: fileID,
                name: '个人资料'
              }
            });

            wx.showToast({
              title: '上传成功',
              icon: 'success'
            });
          },
          fail: (err) => {
            wx.hideLoading();
            console.error('获取图片链接失败:', err);
            // 即使获取链接失败，也保存fileID
            this.setData({
              personalInfoPhoto: {
                url: tempFilePath,
                fileID: fileID,
                name: '个人资料'
              }
            });
          }
        });
      },
      fail: (err) => {
        wx.hideLoading();
        console.error('上传照片失败:', err);
        wx.showToast({
          title: '上传失败',
          icon: 'none'
        });
      }
    });
  },

  /**
   * 删除个人资料照片
   */
  deletePersonalInfoPhoto: function (e) {
    this.setData({
      personalInfoPhoto: { url: '', fileID: '', name: '个人资料' }
    });

    wx.showToast({
      title: '删除成功',
      icon: 'success'
    });
  },

  /**
   * 添加收款方式
   */
  addPaymentMethod: function () {
    const paymentMethods = this.data.paymentMethods;
    paymentMethods.push({
      type: '',
      amount: 0,
      depositId: '',
      depositNo: ''
    });
    
    // 计算收款金额汇总（支持国补POS特殊计算）
    const paymentTotal = this.calculatePaymentTotal(paymentMethods);

    // 计算差额
    const actualAmount = parseFloat(this.data.actualAmount) || 0;
    const differenceAmount = (actualAmount - paymentTotal).toFixed(2);

    this.setData({
      paymentMethods: paymentMethods,
      paymentTotal: paymentTotal,
      differenceAmount: differenceAmount
    });

    // 检查是否有国补POS（手机平板）收款方式
    this.checkGuobuPhonePayment();

    // 自动保存到缓存
    this.saveOrderDataToCache();
  },

  /**
   * 删除收款方式
   */
  removePaymentMethod: function (e) {
    const index = e.currentTarget.dataset.index;
    const paymentMethods = (this.data.paymentMethods || []).map(method => this.normalizePaymentMethod(method));
    if (paymentMethods.length > 1) {
      paymentMethods.splice(index, 1);
      const depositItems = this.getDepositItemsFromPaymentMethods(paymentMethods);

      // 计算收款金额汇总（支持国补POS特殊计算）
      const paymentTotal = this.calculatePaymentTotal(paymentMethods);

      // 计算差额
      const actualAmount = parseFloat(this.data.actualAmount) || 0;
      const differenceAmount = (actualAmount - paymentTotal).toFixed(2);

      this.setData({
        paymentMethods: paymentMethods,
        depositItems,
        paymentTotal: paymentTotal,
        differenceAmount: differenceAmount
      }, () => {
        this.calculateTotal();
      });

      // 检查是否有国补POS（手机平板）收款方式
      this.checkGuobuPhonePayment();

      // 自动保存到缓存
      this.saveOrderDataToCache();
    } else {
      wx.showToast({
        title: '至少保留一种收款方式',
        icon: 'none'
      });
    }
  },

  /**
   * 计算订单总金额和应收金额
   */
  calculateTotal: function () {
    const goodsList = this.data.goodsList;
    let totalAmount = 0;
    
    // 计算所有商品小计之和
    goodsList.forEach(item => {
      // 确保price和quantity是数字
      const price = parseFloat(item.price) || 0;
      const quantity = parseFloat(item.quantity) || 1;
      const subtotal = price * quantity;
      
      // 更新商品的小计
      item.subtotal = subtotal;
      totalAmount += subtotal;
    });
    
    // 确保totalAmount是数字，避免NaN
    totalAmount = parseFloat(totalAmount) || 0;
    
    // 计算应收金额，包含优惠、国补和教育补贴
    const discount = parseFloat(this.data.discount) || 0;
    const nationalSubsidy = parseFloat(this.data.nationalSubsidy) || 0;
    const educationSubsidy = parseFloat(this.data.educationSubsidy) || 0;
    const depositItems = this.getDepositItemsFromPaymentMethods(this.data.paymentMethods);
    const depositDeductionTotal = this.getDepositDeductionTotal(depositItems);
    
    // 定金现在作为收款方式计入收款汇总，不再从应收金额中重复扣减。
    const totalDiscount = discount + nationalSubsidy + educationSubsidy;
    const actualAmount = totalAmount - totalDiscount;
    
    // 确保actualAmount不小于0
    const finalActualAmount = Math.max(0, actualAmount);
    
    // 格式化金额为两位小数
    const totalAmountFixed = totalAmount.toFixed(2);
    const actualAmountFixed = finalActualAmount.toFixed(2);
    
    // 计算差额（应收金额 - 收款汇总）
    const paymentTotal = parseFloat(this.data.paymentTotal) || 0;
    const differenceAmount = (finalActualAmount - paymentTotal).toFixed(2);
    
    // 立即更新数据，确保实时显示
    this.setData({
      goodsList: goodsList,
      totalAmount: totalAmount,
      totalAmountFixed: totalAmountFixed,
      depositItems,
      depositDeductionTotal: depositDeductionTotal,
      depositDeductionTotalFixed: depositDeductionTotal.toFixed(2),
      actualAmount: finalActualAmount,
      actualAmountFixed: actualAmountFixed,
      differenceAmount: differenceAmount
    });
  },

  /**
   * 扫码功能
   */
  scanCode: function (e) {
    const index = e.currentTarget.dataset.index;
    const codeType = e.currentTarget.dataset.codeType || '';

    wx.scanCode({
      success: (res) => {
        const scanResult = res.result;
        const goodsList = this.data.goodsList;

        // 根据codeType决定将结果填入哪个字段
        if (codeType === 'pnCode') {
          goodsList[index].pnCode = scanResult;
          // 扫描PN码，自动带出商品信息
          this.getGoodsInfoByPN(scanResult, index);
        } else if (codeType === 'snCode') {
          goodsList[index].snCode = scanResult;
          // 扫描SN码，自动带出商品信息
          this.getGoodsInfoBySN(scanResult, index);
        } else if (codeType === 'imei1') {
          // 扫描IMEI1
          goodsList[index].imei1 = scanResult;
        } else if (codeType === 'imei2') {
          // 扫描IMEI2
          goodsList[index].imei2 = scanResult;
        } else {
          // 默认情况，尝试自动识别
          goodsList[index].pnCode = scanResult;
          // 尝试作为PN码查询
          this.getGoodsInfoByPN(scanResult, index);
        }

        // 更新商品信息
        this.setData({
          goodsList: goodsList
        });

        // 重新计算金额
        this.calculateTotal();

        // 自动保存到缓存
        this.saveOrderDataToCache();

        // 显示扫码成功提示
        wx.showToast({
          title: '扫码成功',
          icon: 'success'
        });
      },
      fail: (err) => {
        console.error('扫码失败:', err);
        wx.showToast({
          title: '扫码失败，请重试',
          icon: 'none'
        });
      }
    });
  },

  /**
   * 判断商品是否需要SN管理
   */
  isNeedSnGoods: function (goods) {
    if (!goods) return false;
    const values = [
      goods.needSn,
      goods.need_sn,
      goods.Product && goods.Product.needSn,
      goods.Product && goods.Product.need_sn,
      goods.product && goods.product.needSn,
      goods.product && goods.product.need_sn
    ];
    return values.some(value => value === true || value === 1 || value === '1' || value === 'true' || String(value || '').toLowerCase() === 'yes');
  },

  getCurrentStoreId: function () {
    const tempStoreInfo = wx.getStorageSync('tempStoreInfo') || {};
    const userInfo = userUtils.getUserInfo() || {};
    return userUtils.isStoreScoped(userInfo)
      ? (tempStoreInfo.storeId || tempStoreInfo.store_id || tempStoreInfo.id || tempStoreInfo._id || userInfo.storeId || '')
      : (this.data.storeId || '');
  },

  fillPnOptionsByInventory: function (index, productId, preferredPn) {
    const storeId = this.getCurrentStoreId();
    const goodsList = this.data.goodsList;
    const current = goodsList[index] || {};

    if (!productId || !storeId) {
      current.pnOptions = [];
      current.pnOptionsDisplay = [];
      current.pnPickerIndex = 0;
      current.pnStockStatus = '';
      this.setData({ goodsList });
      return Promise.resolve([]);
    }

    return api.order.getProductPns(storeId, productId)
      .then(res => {
        const pnOptions = [...new Set((res.data || []).map(code => String(code || '').trim()).filter(Boolean))];
        const latestGoodsList = this.data.goodsList;
        const latest = latestGoodsList[index] || {};
        const oldPn = String(preferredPn || latest.pnCode || '').trim();
        const matchedIndex = pnOptions.indexOf(oldPn);

        latest.pnOptions = pnOptions;
        latest.pnOptionsDisplay = pnOptions.length ? ['请选择PN码'].concat(pnOptions) : [];
        latest.pnStockStatus = pnOptions.length ? 'available' : 'empty';

        if (matchedIndex >= 0) {
          latest.pnCode = oldPn;
          latest.pnPickerIndex = matchedIndex + 1;
        } else if (pnOptions.length === 1) {
          latest.pnCode = pnOptions[0];
          latest.pnPickerIndex = 1;
        } else if (pnOptions.length > 1) {
          latest.pnCode = '';
          latest.pnPickerIndex = 0;
        } else {
          latest.pnCode = oldPn || latest.pnCode || '';
          latest.pnPickerIndex = 0;
        }

        latest.inventoryId = '';
        latest.snCode = '';
        latest.snOptions = [];
        latest.snOptionsDisplay = [];
        latest.snRecords = [];
        latest.snPickerIndex = 0;
        latest.snStockStatus = '';

        this.setData({ goodsList: latestGoodsList });

        if (latest.pnCode) {
          return this.fillSnOptionsByInventory(index, productId, latest.pnCode)
            .then(() => pnOptions);
        }
        return pnOptions;
      })
      .catch(err => {
        console.error('查询当前门店PN库存失败:', err);
        const latestGoodsList = this.data.goodsList;
        const latest = latestGoodsList[index] || {};
        latest.pnOptions = [];
        latest.pnOptionsDisplay = [];
        latest.pnPickerIndex = 0;
        latest.pnStockStatus = 'empty';
        this.setData({ goodsList: latestGoodsList });
        return [];
      });
  },

  fillSnOptionsByInventory: function (index, productId, pnCode) {
    const storeId = this.getCurrentStoreId();
    const goodsList = this.data.goodsList;
    const current = goodsList[index] || {};

    if (!this.isNeedSnGoods(current) || !productId || !storeId) {
      current.snOptions = [];
      current.snOptionsDisplay = [];
      current.snRecords = [];
      current.snPickerIndex = 0;
      current.snStockStatus = this.isNeedSnGoods(current) ? 'empty' : '';
      this.setData({ goodsList });
      return Promise.resolve([]);
    }

    return api.order.getProductSns(storeId, productId, pnCode)
      .then(res => {
        const snRecords = (res.data || []).filter(item => item.sn_code || item.snCode);
        const snOptions = snRecords.map(item => item.sn_code || item.snCode);
        const latestGoodsList = this.data.goodsList;
        const latest = latestGoodsList[index] || {};
        const oldSnCode = String(latest.snCode || '').trim();
        let snPickerIndex = snOptions.indexOf(oldSnCode);

        latest.snRecords = snRecords;
        latest.snOptions = snOptions;
        latest.snOptionsDisplay = snOptions.length ? ['请选择SN码'].concat(snOptions) : [];
        latest.snStockStatus = snOptions.length > 0 ? 'available' : 'empty';

        if (snOptions.length > 0 && snPickerIndex >= 0) {
          if (snPickerIndex < 0) {
            snPickerIndex = 0;
          }
          const selectedSn = snRecords[snPickerIndex] || {};
          latest.snPickerIndex = snPickerIndex + 1;
          latest.snCode = snOptions[snPickerIndex] || '';
          latest.inventoryId = selectedSn.inventoryId || selectedSn.sn_id || selectedSn.snId || '';
          latest.inventoryType = selectedSn.inventory_type || selectedSn.inventoryType || '';
        } else if (snOptions.length === 1) {
          const selectedSn = snRecords[0] || {};
          latest.snPickerIndex = 1;
          latest.snCode = snOptions[0] || '';
          latest.inventoryId = selectedSn.inventoryId || selectedSn.sn_id || selectedSn.snId || '';
          latest.inventoryType = selectedSn.inventory_type || selectedSn.inventoryType || '';
        } else if (snOptions.length > 1) {
          latest.snPickerIndex = 0;
          latest.snCode = '';
          latest.inventoryId = '';
          latest.inventoryType = '';
        } else {
          latest.snPickerIndex = 0;
          latest.inventoryId = '';
        }

        this.setData({ goodsList: latestGoodsList });
        return snRecords;
      })
      .catch(err => {
        console.error('查询当前门店SN库存失败:', err);
        const latestGoodsList = this.data.goodsList;
        const latest = latestGoodsList[index] || {};
        latest.snOptions = [];
        latest.snOptionsDisplay = [];
        latest.snRecords = [];
        latest.snPickerIndex = 0;
        latest.snStockStatus = 'empty';
        latest.inventoryId = '';
        this.setData({ goodsList: latestGoodsList });
        return [];
      });
  },

  /**
   * 根据SN码获取商品信息
   */
  getGoodsInfoBySN: function (sn, index, options = {}) {
    if (options.showLoading) {
      wx.showLoading({ title: '查询中...' });
    }
    DataStorage.getGoodsBySN(sn, (goods) => {
      if (goods && goods.name && goods.name.trim() !== '') {
        // 获取最新的 goodsList，避免闭包问题
        const goodsList = this.data.goodsList;

        // 找到商品信息，自动填充
        goodsList[index].name = goods.name;
        goodsList[index].pnCode = goods.pnCode;
        goodsList[index].productId = goods.productId || goods.product_id || '';
        const inventoryId = goods.inventoryId || goods.snId || goods.sn_id || goods.inventory_id || '';
        goodsList[index].inventoryId = inventoryId;
        goodsList[index].snCode = goods.snCode || goodsList[index].snCode || sn;
        goodsList[index].inventoryStatus = goods.inventoryStatus || goods.inventory_status || goods.status || '';
        goodsList[index].previousSnStatus = goodsList[index].inventoryStatus || goodsList[index].previousSnStatus || '在库';
        goodsList[index].needSn = this.isNeedSnGoods(goods);
        goodsList[index].snOptions = [];
        goodsList[index].snOptionsDisplay = [];
        goodsList[index].snRecords = [];
        goodsList[index].snPickerIndex = 0;
        goodsList[index].snStockStatus = goodsList[index].needSn ? 'available' : '';
        goodsList[index].price = goods.price;
        goodsList[index].standardPrice = Number(goods.standardPrice || goods.standard_price || goods.price || 0);
        goodsList[index].minSalePrice = Number(goods.minSalePrice || goods.min_sale_price || goods.minimumSalePrice || goods.minimum_sale_price || goods.minPrice || goods.min_price || goods.lowestSalePrice || goods.lowest_sale_price || goods.lowPrice || goods.low_price || goods.floorPrice || goods.floor_price || 0);
        goodsList[index].costPrice = goods.costPrice || goods.cost_price || goods.purchasePrice || goods.purchase_price || goods.importPrice || goods.import_price || goods.cost || goods.settlementPrice || goods.settlement_price || 0;
        // 根据商品名称判断是否显示IMEI
        goodsList[index].showImei = goods.name.toLowerCase().includes('moto');

        this.setData({
          goodsList: goodsList
        });

        this.calculateTotal();

        wx.showToast({
          title: '商品信息自动填充成功',
          icon: 'success'
        });
        if (options.showLoading) wx.hideLoading();
      } else {
        // 没有找到商品信息或商品名称为空，尝试查询最近的订单记录
        this.getRecentOrderInfo(index);
        if (options.showLoading) wx.hideLoading();
      }
    }, err => {
      if (options.showLoading) wx.hideLoading();
      wx.showToast({ title: err && err.message ? err.message : '查询商品失败', icon: 'none' });
    });
  },

  /**
   * 根据PN码获取商品信息
   */
  getGoodsInfoByPN: function (pn, index, options = {}) {
    if (options.showLoading) {
      wx.showLoading({ title: '查询中...' });
    }
    DataStorage.getGoodsByPN(pn, (goods) => {
      if (goods && goods.name && goods.name.trim() !== '') {
        // 获取最新的 goodsList，避免闭包问题
        const goodsList = this.data.goodsList;
        const needSn = this.isNeedSnGoods(goods);

        // 找到商品信息，自动填充
        goodsList[index].name = goods.name;
        goodsList[index].productId = goods.productId || goods.product_id || '';
        goodsList[index].pnCode = goods.pnCode || goodsList[index].pnCode || pn;
        goodsList[index].needSn = needSn;
        if (!needSn) {
          goodsList[index].snCode = '';
          goodsList[index].inventoryId = '';
          goodsList[index].inventoryStatus = '';
          goodsList[index].previousSnStatus = '';
        }
        goodsList[index].price = goods.price;
        goodsList[index].standardPrice = Number(goods.standardPrice || goods.standard_price || goods.price || 0);
        goodsList[index].minSalePrice = Number(goods.minSalePrice || goods.min_sale_price || goods.minimumSalePrice || goods.minimum_sale_price || goods.minPrice || goods.min_price || goods.lowestSalePrice || goods.lowest_sale_price || goods.lowPrice || goods.low_price || goods.floorPrice || goods.floor_price || 0);
        goodsList[index].costPrice = goods.costPrice || goods.cost_price || goods.purchasePrice || goods.purchase_price || goods.importPrice || goods.import_price || goods.cost || goods.settlementPrice || goods.settlement_price || 0;
        goodsList[index].snOptions = [];
        goodsList[index].snOptionsDisplay = [];
        goodsList[index].snRecords = [];
        goodsList[index].snPickerIndex = 0;
        goodsList[index].snStockStatus = needSn ? 'empty' : '';
        // 根据商品名称判断是否显示IMEI
        goodsList[index].showImei = goods.name.toLowerCase().includes('moto');

        this.setData({
          goodsList: goodsList
        });

        this.fillPnOptionsByInventory(index, goodsList[index].productId, goodsList[index].pnCode)
          .then(pnOptions => {
            if (options.showLoading) wx.hideLoading();
            this.calculateTotal();
            const latest = this.data.goodsList[index] || {};
            const snCount = (latest.snOptions || []).length;
            wx.showToast({
              title: pnOptions.length > 1 ? '请选择PN码' : (needSn && snCount > 1 ? '请选择SN码' : '商品信息自动填充成功'),
              icon: 'success'
            });
          });
      } else {
        if (options.showLoading) wx.hideLoading();
        // 没有找到商品信息或商品名称为空，尝试查询最近的订单记录
        this.getRecentOrderInfo(index);
      }
    }, err => {
      if (options.showLoading) wx.hideLoading();
      wx.showToast({
        title: err && err.message ? err.message : '查询商品失败',
        icon: 'none'
      });
    });
  },

  /**
   * 查询最近的订单记录，获取商品名称和价格
   */
  getRecentOrderInfo: function (index) {
    const goodsList = this.data.goodsList;
    const currentGoods = goodsList[index];
    const pnCode = currentGoods.pnCode;
    const snCode = currentGoods.snCode;
    
    DataStorage.getOrders((orders) => {
      if (orders && orders.length > 0) {
        // 按创建时间排序，最新的在前
        const sortedOrders = orders.sort((a, b) => b.createTime - a.createTime);
        
        // 遍历订单，查找匹配PN或SN的商品
        let matchedGoods = null;
        for (const order of sortedOrders) {
          if (order.goods && order.goods.length > 0) {
            for (const goods of order.goods) {
              if ((pnCode && goods.pnCode === pnCode) || (snCode && goods.snCode === snCode)) {
                matchedGoods = goods;
                break;
              }
            }
            if (matchedGoods) break;
          }
        }
        
        if (matchedGoods) {
          // 找到匹配的商品信息
          goodsList[index].name = matchedGoods.name;
          goodsList[index].productId = matchedGoods.productId || matchedGoods.product_id || '';
          goodsList[index].price = matchedGoods.price;
          goodsList[index].standardPrice = Number(matchedGoods.standardPrice || matchedGoods.standard_price || matchedGoods.price || 0);
          goodsList[index].minSalePrice = Number(matchedGoods.minSalePrice || matchedGoods.min_sale_price || matchedGoods.minimumSalePrice || matchedGoods.minimum_sale_price || matchedGoods.minPrice || matchedGoods.min_price || matchedGoods.lowestSalePrice || matchedGoods.lowest_sale_price || matchedGoods.lowPrice || matchedGoods.low_price || matchedGoods.floorPrice || matchedGoods.floor_price || 0);
          goodsList[index].costPrice = matchedGoods.costPrice || matchedGoods.cost_price || matchedGoods.purchasePrice || matchedGoods.purchase_price || matchedGoods.importPrice || matchedGoods.import_price || matchedGoods.cost || matchedGoods.settlementPrice || matchedGoods.settlement_price || 0;
          // 根据商品名称判断是否显示IMEI
          goodsList[index].showImei = matchedGoods.name.toLowerCase().includes('moto');

          this.setData({
            goodsList: goodsList
          });

          this.calculateTotal();

          wx.showToast({
            title: '已填充最近订单的商品信息',
            icon: 'success'
          });
        } else {
          // 没有找到匹配的商品信息，提示手工填写
          wx.showToast({
            title: '未找到商品信息，请手工填写',
            icon: 'none'
          });
        }
      } else {
        // 没有找到订单记录，提示手工填写
        wx.showToast({
          title: '未找到商品信息，请手工填写',
          icon: 'none'
        });
      }
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

  // 是否使用云函数查询（调试阶段强制使用云函数）
  _useProductSearchApi: true,
  
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
    if (!this._useProductSearchApi) {
      console.log('商品名称查询统一使用 API');
      this._useProductSearchApi = true;
    }
    
    // 根据配置决定是否使用云函数
    if (this._useProductSearchApi) {
      // 使用云函数查询
      api.product.search(keywords.join(' '), {
        storeId: this.getCurrentStoreId(),
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
          
          // 按商品剔重。同一商品可能有多个PN，PN留到下一步按当前门店库存选择。
          console.log('开始按商品剔重...');
          const productMap = new Map();
          res.result.data.forEach((item, idx) => {
            const pn = item.pnCode || '';
            const productId = item.productId || item.product_id || '';
            const key = productId || item.name || pn;
            console.log(`[${idx}] name=${item.name}, productId=${productId}, pn=${pn}`);
            if (key && !productMap.has(key)) {
              console.log(`  -> 新商品，加入Map`);
              productMap.set(key, {
                 name: item.name || item.productName || item.product_name || item.NAME || '',
                  productId,
                  pnCode: pn,
                  price: item.price || item.standard_price || 0,
                  standardPrice: Number(item.standardPrice || item.standard_price || item.price || 0),
                  minSalePrice: Number(item.minSalePrice || item.min_sale_price || item.minimumSalePrice || item.minimum_sale_price || item.minPrice || item.min_price || item.lowestSalePrice || item.lowest_sale_price || item.lowPrice || item.low_price || item.floorPrice || item.floor_price || 0),
                  costPrice: item.costPrice || item.cost_price || item.purchasePrice || item.purchase_price || item.importPrice || item.import_price || item.cost || item.settlementPrice || item.settlement_price || item.min_sale_price || item.price || item.standard_price || 0,
                 settlementPrice: item.settlementPrice || item.settlement_price || item.min_sale_price || item.price || item.standard_price || 0,
                 needSn: this.isNeedSnGoods(item),
                 stockRank: item.stock_rank !== undefined ? Number(item.stock_rank) : (Number(item.current_store_stock_qty || 0) > 0 ? 0 : (Number(item.other_store_stock_qty || item.total_stock_qty || 0) > 0 ? 1 : 2)),
                 currentStoreStockQty: Number(item.currentStoreStockQty || item.current_store_stock_qty || 0),
                 otherStoreStockQty: Number(item.otherStoreStockQty || item.other_store_stock_qty || 0),
                 totalStockQty: Number(item.totalStockQty || item.total_stock_qty || item.stock || 0),
                matchScore: 1
              });
            } else if (key && productMap.has(key)) {
              const existing = productMap.get(key);
              if (!existing.pnCode && pn) existing.pnCode = pn;
               const settlementPrice = item.settlementPrice || item.settlement_price || item.min_sale_price || item.price || item.standard_price || 0;
               const standardPrice = Number(item.standardPrice || item.standard_price || item.price || 0);
               const minSalePrice = Number(item.minSalePrice || item.min_sale_price || item.minimumSalePrice || item.minimum_sale_price || item.minPrice || item.min_price || item.lowestSalePrice || item.lowest_sale_price || item.lowPrice || item.low_price || item.floorPrice || item.floor_price || 0);
               const costPrice = item.costPrice || item.cost_price || item.purchasePrice || item.purchase_price || item.importPrice || item.import_price || item.cost || item.settlementPrice || item.settlement_price || item.min_sale_price || item.price || item.standard_price || 0;
               if (!existing.standardPrice && standardPrice) existing.standardPrice = standardPrice;
               if (!existing.minSalePrice && minSalePrice) existing.minSalePrice = minSalePrice;
              if (!existing.costPrice && costPrice) existing.costPrice = costPrice;
              if (!existing.settlementPrice && settlementPrice) existing.settlementPrice = settlementPrice;
              const stockRank = item.stock_rank !== undefined ? Number(item.stock_rank) : (Number(item.current_store_stock_qty || 0) > 0 ? 0 : (Number(item.other_store_stock_qty || item.total_stock_qty || 0) > 0 ? 1 : 2));
              if (stockRank < existing.stockRank) existing.stockRank = stockRank;
              existing.currentStoreStockQty = Math.max(existing.currentStoreStockQty || 0, Number(item.current_store_stock_qty || 0));
              existing.otherStoreStockQty = Math.max(existing.otherStoreStockQty || 0, Number(item.other_store_stock_qty || 0));
              existing.totalStockQty = Math.max(existing.totalStockQty || 0, Number(item.total_stock_qty || item.stock || 0));
              console.log(`  -> 商品 ${key} 已存在，跳过重复记录`);
            } else {
              console.log(`  -> 商品标识为空，跳过`);
            }
          });
          let matchedGoods = Array.from(productMap.values()).sort((a, b) => {
            const aRank = a.stockRank !== undefined ? a.stockRank : 2;
            const bRank = b.stockRank !== undefined ? b.stockRank : 2;
            const rankDiff = aRank - bRank;
            if (rankDiff !== 0) return rankDiff;
            if (aRank === 0 && (b.currentStoreStockQty || 0) !== (a.currentStoreStockQty || 0)) {
              return (b.currentStoreStockQty || 0) - (a.currentStoreStockQty || 0);
            }
            if (aRank === 1 && (b.otherStoreStockQty || 0) !== (a.otherStoreStockQty || 0)) {
              return (b.otherStoreStockQty || 0) - (a.otherStoreStockQty || 0);
            }
            return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN');
          });
          
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
              append: false,
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
        
        // 暂时屏蔽本地查询降级，只使用云函数
        wx.showToast({
          title: '查询失败，请重试',
          icon: 'none',
          duration: 2000
        });
      });
    }
  },
  
  /**
   * 本地商品名称搜索（降级方案）
   */
  searchGoodsByNameLocal: function (keywords, index) {
    wx.showLoading({ title: '查询中...' });
    
    const db = wx.cloud.database();
    const _ = db.command;
    
    console.log('本地搜索关键词:', keywords);
    
    // 构建"且"关系的查询条件
    const andConditions = keywords.map(keyword => ({
      NAME: db.RegExp({
        regexp: keyword,
        options: 'i'
      })
    }));
    
    db.collection('goods')
      .where(_.and(andConditions))
      .limit(20)
      .get()
      .then(res => {
        wx.hideLoading();
        
        if (res.data && res.data.length > 0) {
          console.log('本地查询结果:', res.data);
          
          // 按PN剔重，只保留有PN的商品
          const pnMap = new Map();
          res.data.forEach((item, idx) => {
            const pn = item.pnCode || '';
            console.log(`本地商品${idx}: NAME=${item.NAME}, PN=${pn}`);
            
            // 只处理有PN的商品，且PN不重复
            if (pn && !pnMap.has(pn)) {
              pnMap.set(pn, {
                name: item.NAME || item.name || item.productName || item.product_name || '',
                pnCode: pn,
                matchScore: 1
              });
            } else if (pn && pnMap.has(pn)) {
              console.log(`  -> PN ${pn} 已存在，跳过`);
            }
          });
          const matchedGoods = Array.from(pnMap.values());
          
          console.log('本地查询剔重后:', matchedGoods);
          console.log('本地查询剔重前数量:', res.data.length, '剔重后数量:', matchedGoods.length);
          
          if (matchedGoods.length === 1) {
            this.fillGoodsPN(matchedGoods[0], index);
          } else if (matchedGoods.length > 1) {
            this.showGoodsSelectModal(matchedGoods, index);
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
      })
      .catch(err => {
        wx.hideLoading();
        console.error('本地查询商品信息失败:', err);
        
        wx.showToast({
          title: '查询失败，请重试',
          icon: 'none'
        });
      });
  },

  /**
   * 显示商品选择弹窗（自定义弹窗，支持显示更多商品）
   */
  formatGoodsSelectItem: function (item) {
    const price = item.price || item.standard_price || 0;
    const standardPrice = Number(item.standardPrice || item.standard_price || item.price || 0);
    const minSalePrice = Number(item.minSalePrice || item.min_sale_price || item.minimumSalePrice || item.minimum_sale_price || item.minPrice || item.min_price || item.lowestSalePrice || item.lowest_sale_price || item.lowPrice || item.low_price || item.floorPrice || item.floor_price || 0);
    const settlementPrice = item.settlementPrice || item.settlement_price || item.min_sale_price || price || 0;
    const costPrice = item.costPrice || item.cost_price || item.purchasePrice || item.purchase_price || item.importPrice || item.import_price || item.cost || item.settlementPrice || item.settlement_price || item.min_sale_price || price || 0;
    const currentStoreStockQty = Number(item.currentStoreStockQty || item.current_store_stock_qty || 0);
    const otherStoreStockQty = Number(item.otherStoreStockQty || item.other_store_stock_qty || 0);
    const totalStockQty = Number(item.totalStockQty || item.total_stock_qty || item.stock_qty || item.stock || currentStoreStockQty + otherStoreStockQty || 0);

    return {
      ...item,
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
    };
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
    // 最多显示100个商品（可以根据需要调整）
    const formattedList = this.mergeGoodsSelectResults(goodsList);

    this.setData({
      showGoodsSelectModal: true,
      goodsSelectList: options.append
        ? this.mergeGoodsSelectResults((this.data.goodsSelectList || []).concat(formattedList))
        : formattedList,
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
    const productId = goods.productId || goods.product_id || '';
    goodsList[index].pnCode = goods.pnCode || '';
    goodsList[index].name = goods.name;
    goodsList[index].productId = productId;
    goodsList[index].needSn = this.isNeedSnGoods(goods);
    goodsList[index].need_sn = goodsList[index].needSn ? 1 : 0;
    goodsList[index].price = goods.price || goodsList[index].price || 0;
    goodsList[index].standardPrice = Number(goods.standardPrice || goods.standard_price || goods.price || goodsList[index].standardPrice || 0);
    goodsList[index].minSalePrice = Number(goods.minSalePrice || goods.min_sale_price || goods.minimumSalePrice || goods.minimum_sale_price || goods.minPrice || goods.min_price || goods.lowestSalePrice || goods.lowest_sale_price || goods.lowPrice || goods.low_price || goods.floorPrice || goods.floor_price || goodsList[index].minSalePrice || 0);
    goodsList[index].costPrice = goods.costPrice || goods.cost_price || goods.purchasePrice || goods.purchase_price || goods.importPrice || goods.import_price || goods.cost || goods.settlementPrice || goods.settlement_price || goodsList[index].costPrice || 0;
    goodsList[index].pnOptions = [];
    goodsList[index].pnOptionsDisplay = [];
    goodsList[index].pnPickerIndex = 0;
    goodsList[index].pnStockStatus = '';
    goodsList[index].inventoryId = '';
    goodsList[index].snCode = '';
    goodsList[index].snOptions = [];
    goodsList[index].snOptionsDisplay = [];
    goodsList[index].snRecords = [];
    goodsList[index].snPickerIndex = 0;
    goodsList[index].snStockStatus = '';
    
    this.setData({
      goodsList: goodsList
    });
    
    if (productId) {
      this.fillPnOptionsByInventory(index, productId, goods.pnCode)
        .then(pnOptions => {
          this.calculateTotal();
          wx.showToast({
            title: pnOptions.length > 1 ? '请选择PN码' : '已选择商品',
            icon: 'success'
          });
        });
    } else if (goods.pnCode) {
      this.getGoodsInfoByPN(goods.pnCode, index);
    } else {
      wx.showToast({
        title: '已选择商品',
        icon: 'success'
      });
    }
  },

  /**
   * 从OCR页面更新商品信息
   */
  updateGoodsFromOCR: function (data) {
    const index = data.index;
    const pnCode = data.pnCode;
    const mtmCode = data.mtmCode;
    const snCode = data.snCode;
    
    const goodsList = this.data.goodsList;
    // OCR识别到的PN和MTM码，优先使用PN码，如果PN码为空则使用MTM码
    goodsList[index].pnCode = pnCode || mtmCode;
    goodsList[index].mtmCode = mtmCode;
    goodsList[index].snCode = snCode;
    
    this.setData({
      goodsList: goodsList
    });
  },

  /**
   * 预览订单
   */
  previewOrder: function () {
    // 先保存当前数据到缓存
    this.saveOrderDataToCache();

    // 校验收款方式（不能为"请选择收款方式"）
    const actualAmount = parseFloat(this.data.actualAmount) || 0;
    const paymentMethods = this.getEffectivePaymentMethods(this.data.paymentMethods);
    if (actualAmount > 0 && paymentMethods.length === 0) {
      wx.showToast({
        title: '请添加收款方式',
        icon: 'none'
      });
      return;
    }
    for (let i = 0; i < paymentMethods.length; i++) {
      const method = paymentMethods[i];
      if (!method.type || method.type === '请选择收款方式') {
        wx.showToast({
          title: `请选择收款方式${i + 1}`,
          icon: 'none'
        });
        return;
      }
    }
    const depositItems = this.getDepositItemsFromPaymentMethods(paymentMethods);
    if (!this.validateDepositItems(depositItems)) return;

    // 校验金额是否一致
    const paymentTotal = this.calculatePaymentTotal(paymentMethods);

    const difference = Math.abs(actualAmount - paymentTotal);
    if (Math.round(actualAmount * 100) !== Math.round(paymentTotal * 100)) {
      wx.showModal({
        title: '金额不一致',
        content: `应收金额（¥${actualAmount.toFixed(2)}）与收款信息汇总（¥${paymentTotal.toFixed(2)}）不一致，差额¥${difference.toFixed(2)}。请核对后再提交。`,
        showCancel: false,
        confirmText: '去修改'
      });
      return;
    }

    // 校验国补人信息（如果选择了国补）
    if (this.data.subsidyStatus === '国补') {
      const subsidyPerson = this.data.subsidyPerson || '';
      const subsidyId = this.data.subsidyId || '';

      // 校验国补人和国补ID不能为空
      if (!subsidyPerson.trim()) {
        wx.showToast({
          title: '请输入国补人姓名',
          icon: 'none'
        });
        return;
      }

      if (!subsidyId.trim()) {
        wx.showToast({
          title: '请输入国补人ID',
          icon: 'none'
        });
        return;
      }

      // 校验国补ID必须为11位纯数字
      if (!/^\d{11}$/.test(subsidyId)) {
        wx.showToast({
          title: '输入有误，请输入11位数字',
          icon: 'none',
          duration: 2000
        });
        return;
      }
    }

    // 生成预览数据（不进行表单验证，允许用户先预览再完善信息）
    const previewData = this.generatePreviewData();

    this.setData({
      showPreview: true,
      previewData: previewData
    });
  },

  /**
   * 生成预览数据
   */
  generatePreviewData: function () {
    const goodsList = this.data.goodsList;
    const totalAmount = this.data.totalAmount;
    const discount = this.data.discount;
    const nationalSubsidy = this.data.nationalSubsidy;
    const computerAmount = this.data.computerAmount;
    const mobileAmount = this.data.mobileAmount;
    const educationSubsidy = this.data.educationSubsidy;
    const actualAmount = this.data.actualAmount;
    // 处理辅助销售人列表
    // 检查是否所有辅助销售人（除主销售人外）的利润金额都为0
    const nonMainSalesList = this.data.auxiliarySalesList.filter(item => !item.isMainSales);
    const allProfitZero = nonMainSalesList.length === 0 || nonMainSalesList.every(item => (parseFloat(item.profitAmount) || 0) === 0);

    const auxiliarySalesList = this.data.auxiliarySalesList.map(item => {
      const profitAmount = parseFloat(item.profitAmount) || 0;
      // 如果所有辅助销售人的利润金额都为0，则标记为"利润平分"
      if (allProfitZero) {
        return {
          ...item,
          ratio: '利润平分'
        };
      }
      return item;
    });
    const selectedCustomerSource = this.data.selectedCustomerSourceLevel1;
    const selectedCustomerSourceDetail = this.data.selectedCustomerSourceLevel2;
    const paymentMethods = this.data.paymentMethods;
    const depositItems = this.getDepositItemsFromPaymentMethods(paymentMethods);
    const contactName = this.data.contactName;
    const contactMethod = this.data.contactMethod;
    const invoiceStatus = this.data.invoiceStatus;
    const invoiceInfo = this.data.invoiceInfo;
    const hasGuobuPayment = this.getGuobuPaymentAmount(paymentMethods) > 0;
    const subsidyStatus = this.data.subsidyStatus === '国补' || hasGuobuPayment ? '国补' : this.data.subsidyStatus;
    const invoiceAmount = invoiceStatus === '不开票'
      ? 0
      : subsidyStatus === '国补'
        ? (this.data.invoiceAmount || this.getDefaultInvoiceAmount(paymentMethods))
        : this.data.invoiceAmount;
    const subsidyPerson = subsidyStatus === '国补'
      ? (this.data.subsidyPerson || contactName || '')
      : this.data.subsidyPerson;
    const subsidyId = subsidyStatus === '国补'
      ? (this.data.subsidyId || contactMethod || '')
      : this.data.subsidyId;
    const subsidyPhotos = this.data.subsidyPhotos;
    
    // 计算收款金额汇总（支持国补POS特殊计算）
    const paymentTotal = this.calculatePaymentTotal(paymentMethods);
    const previewPaymentMethods = paymentMethods.map(method => {
      const amount = parseFloat(method.amount) || 0;
      const methodType = method.type || '';
      let previewAmount = amount;

      // 国补 POS 录入的是参与补贴的商品金额，预览展示扣除国补后的实付金额。
      if (methodType === '国补POS（手机平板）') {
        previewAmount = amount - Math.min(amount * 0.15, 500);
      } else if (methodType === '国补POS（电脑）') {
        previewAmount = amount - Math.min(amount * 0.15, 1500);
      }

      return Object.assign({}, method, {
        previewTitle: this.isDepositPayment(methodType)
          ? '定金抵扣'
          : methodType + (method.depositNo ? ' - ' + method.depositNo : ''),
        previewAmount: (Math.round(previewAmount * 100) / 100).toFixed(2)
      });
    });

    // 获取当前时间，自定义格式，不包含时区信息
    const now = new Date();
    const createTime = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    
    // 生成订单编号
    const orderNo = 'ORD' + now.getTime();
    
    // 获取用户信息（实际销售人）
    const userInfo = userUtils.getUserInfo();
    const createUser = userInfo.userName || '未知用户';
    const createUserPhone = userInfo.phone || userInfo.userPhone || '';

    return {
      orderNo: orderNo,
      createTime: createTime,
      createUser: createUser, // 实际销售人（开单人）
      createUserPhone: createUserPhone, // 提单人电话
      auxiliarySalesList: auxiliarySalesList,
      customerSource: selectedCustomerSource,
      customerSourceDetail: selectedCustomerSourceDetail,
      contactName: contactName,
      contactMethod: contactMethod,
      paymentMethods: previewPaymentMethods,
      depositItems: depositItems,
      depositDeductionTotal: this.getDepositDeductionTotal(depositItems).toFixed(2),
      paymentTotal: parseFloat(paymentTotal).toFixed(2),
      goods: goodsList,
      totalAmount: parseFloat(totalAmount).toFixed(2),
      discount: parseFloat(discount).toFixed(2),
      nationalSubsidy: parseFloat(nationalSubsidy).toFixed(2),
      computerAmount: computerAmount,
      mobileAmount: mobileAmount,
      educationSubsidy: parseFloat(educationSubsidy).toFixed(2),
      actualAmount: parseFloat(actualAmount).toFixed(2),
      invoiceStatus: invoiceStatus,
      invoiceInfo: invoiceInfo,
      invoiceAmount: invoiceAmount,
      subsidyStatus: subsidyStatus,
      subsidyPhotos: subsidyPhotos
    };
  },

  /**
   * 关闭预览
   */
  closePreview: function () {
    this.setData({
      showPreview: false
    });
  },

  /**
   * 蓝牙打印
   */
  printOrder: function () {
    const BluetoothPrinter = require('../../utils/bluetooth.js');

    wx.showLoading({
      title: '打印中...',
    });

    // 使用预览数据进行打印
    const orderData = this.data.previewData;
    console.log('printOrder - previewData:', orderData);
    console.log('printOrder - previewData.goods:', orderData.goods);

    BluetoothPrinter.printOrder(orderData,
      (res) => {
        wx.hideLoading();
        wx.showToast({
          title: '打印成功',
          icon: 'success'
        });
      },
      (err) => {
        wx.hideLoading();
        wx.showToast({
          title: '打印失败：' + err,
          icon: 'none'
        });
        console.error('打印失败：', err);
      }
    );
  },

  /**
   * 打印并提交订单
   * 先提交订单，提交成功后显示打印确认弹窗
   */
  printAndSubmitOrder: function () {
    // 防止重复提交
    if (this.data.isSubmitting) {
      wx.showToast({
        title: '订单正在提交中，请勿重复点击',
        icon: 'none'
      });
      return;
    }

    // 提交前再次校验，避免预览后数据变化或该入口绕过完整表单校验。
    if (!this.validateForm()) {
      return;
    }

    // 生成订单数据
    const orderData = this.generateOrderData();

    if (!this.confirmNegativeGrossProfit(orderData, () => this.printAndSubmitOrderConfirmed(orderData))) return;
  },

  printAndSubmitOrderConfirmed: function (orderData) {

    // 开始提交订单
    this.setData({
      isSubmitting: true
    });

    wx.showLoading({
      title: '提交订单中...',
    });

    // 保存订单
    const DataStorage = require('../../utils/storage.js');
    DataStorage.saveOrder(orderData,
      (res) => {
        wx.hideLoading();

        // 订单提交成功，清除缓存并重置页面数据
        this.clearOrderCache();
        this.resetPageData();

        // 显示打印确认弹窗
        this.setData({
          showPrintConfirmModal: true,
          pendingPrintOrderData: orderData,
          isSubmitting: false
        });
      },
      (err) => {
        wx.hideLoading();
        this.setData({
          isSubmitting: false
        });
        this.showSaveError(err);
        console.error('保存订单失败：', err);
      }
    );
  },

  /**
   * 关闭打印确认弹窗并返回首页
   */
  closePrintConfirmModal: function () {
    this.setData({
      showPrintConfirmModal: false,
      pendingPrintOrderData: null
    });

    // 返回首页
    wx.switchTab({
      url: '/pages/index/index'
    });
  },

  /**
   * 立即打印订单
   * 用户点击绿色打印按钮后执行，直接启动打印
   */
  doPrintOrder: function () {
    const orderData = this.data.pendingPrintOrderData;
    if (!orderData) {
      wx.showToast({
        title: '订单数据不存在',
        icon: 'none'
      });
      return;
    }

    // 检查打印机信息
    const printerInfo = wx.getStorageSync('printerInfo');
    const connectedPrinter = wx.getStorageSync('connectedPrinter');

    if (!printerInfo || !connectedPrinter) {
      wx.showModal({
        title: '未连接打印机',
        content: '您还未连接蓝牙打印机，请先连接打印机后再打印。',
        confirmText: '去连接',
        cancelText: '取消',
        success: (res) => {
          if (res.confirm) {
            this.setData({
              showPrintConfirmModal: false
            });
            wx.navigateTo({
              url: '/pages/printer/printer'
            });
          }
        }
      });
      return;
    }

    // 直接执行打印，不再检测蓝牙状态
    this.executePrintDirect(orderData);
  },

  /**
   * 直接执行打印（不检测蓝牙状态，直接发送打印指令）
   */
  executePrintDirect: function (orderData) {
    const BluetoothPrinter = require('../../utils/bluetooth.js');

    wx.showLoading({
      title: '打印中...'
    });

    // 转换订单数据格式以适配打印函数
    const printData = this.convertOrderToPrintFormat(orderData);

    BluetoothPrinter.printOrder(printData,
      (res) => {
        wx.hideLoading();
        wx.showToast({
          title: '打印成功',
          icon: 'success'
        });

        // 关闭弹窗并返回首页
        setTimeout(() => {
          this.setData({
            showPrintConfirmModal: false,
            pendingPrintOrderData: null
          });
          wx.switchTab({
            url: '/pages/index/index'
          });
        }, 1000);
      },
      (err) => {
        wx.hideLoading();
        wx.showModal({
          title: '打印失败',
          content: '打印失败：' + err + '，请检查打印机连接后重试，或到订单查询中重新打印。',
          confirmText: '去订单查询',
          cancelText: '关闭',
          success: (modalRes) => {
            if (modalRes.confirm) {
              this.setData({
                showPrintConfirmModal: false
              });
              wx.navigateTo({ url: '/pages/order-list/order-list' });
            } else {
              this.closePrintConfirmModal();
            }
          }
        });
        console.error('打印失败：', err);
      }
    );
  },

  /**
   * 提交后检测打印机并打印
   */
  printAfterSubmit: function (orderData) {
    // 检查是否已连接打印机
    const printerInfo = wx.getStorageSync('printerInfo');
    const connectedPrinter = wx.getStorageSync('connectedPrinter');

    if (!printerInfo || !connectedPrinter) {
      // 未连接打印机，保存订单数据并显示引导弹窗
      console.log('未检测到打印机连接信息，显示引导弹窗');
      this.setData({
        pendingPrintOrderData: orderData,
        showPrinterGuideModal: true
      });
      return;
    }

    // 已连接打印机，直接执行打印
    console.log('有打印机信息，执行打印');
    this.executePrint(orderData);
  },

  /**
   * 执行打印操作（与订单详情页打印保持一致）
   */
  executePrint: function (orderData) {
    const BluetoothPrinter = require('../../utils/bluetooth.js');

    wx.showLoading({
      title: '打印中...'
    });

    // 调试日志：检查订单数据
    console.log('executePrint - orderData:', orderData);
    console.log('executePrint - orderData.goods:', orderData.goods);

    // 转换订单数据格式以适配打印函数
    const printData = this.convertOrderToPrintFormat(orderData);
    console.log('executePrint - printData:', printData);
    console.log('executePrint - printData.goods:', printData.goods);

    BluetoothPrinter.printOrder(printData,
      (res) => {
        wx.hideLoading();
        wx.showToast({
          title: '打印成功',
          icon: 'success'
        });

        // 清空待打印数据，重置提交状态
        this.setData({
          pendingPrintOrderData: null,
          isSubmitting: false,
          isPrinting: false
        });

        // 打印成功后关闭预览并返回首页
        setTimeout(() => {
          this.setData({
            showPreview: false
          });
          wx.switchTab({
            url: '/pages/index/index'
          });
        }, 1000);
      },
      (err) => {
        wx.hideLoading();
        wx.showToast({
          title: '打印失败：' + err,
          icon: 'none'
        });
        console.error('打印失败：', err);

        // 重置提交状态
        this.setData({
          isSubmitting: false,
          isPrinting: false
        });
      }
    );
  },

  /**
   * 显示打印失败提示并引导用户到订单查询页面重新打印
   */
  showPrintFailAndGuide: function (orderData, failReason) {
    // 重置提交状态
    this.setData({
      isSubmitting: false,
      isPrinting: false,
      pendingPrintOrderData: null
    });

    wx.showModal({
      title: '打印失败',
      content: failReason + '，请重新连接打印机后，到订单查询中重新打印小票。',
      confirmText: '去订单查询',
      cancelText: '返回首页',
      success: (res) => {
        if (res.confirm) {
          // 关闭预览弹窗
          this.setData({
            showPreview: false
          });
          // 跳转到订单列表页面
          wx.navigateTo({ url: '/pages/order-list/order-list' });
        } else if (res.cancel) {
          // 关闭预览并返回首页
          this.setData({
            showPreview: false
          });
          wx.switchTab({
            url: '/pages/index/index'
          });
        }
      }
    });
  },

  /**
   * 将订单数据转换为打印格式
   */
  convertOrderToPrintFormat: function (orderData) {
    const now = new Date();
    const createTime = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

    // 计算收款金额汇总（支持国补POS特殊计算）
    const paymentTotal = this.calculatePaymentTotal(orderData.paymentMethods);

    // 确保数值字段为数字类型，避免 toFixed 报错
    const ensureNumber = (value) => {
      const num = parseFloat(value);
      return isNaN(num) ? 0 : num;
    };

    return {
      orderNo: orderData.orderNo,
      createTime: createTime,
      createUser: orderData.createUser,
      auxiliarySalesList: orderData.auxiliarySalesList,
      customerSource: orderData.customerSource,
      contactName: orderData.contactName,
      contactMethod: orderData.contactMethod,
      paymentMethods: orderData.paymentMethods,
      paymentTotal: ensureNumber(paymentTotal).toFixed(2),
      goods: orderData.goods,
      totalAmount: ensureNumber(orderData.totalAmount).toFixed(2),
      discount: ensureNumber(orderData.discount).toFixed(2),
      nationalSubsidy: ensureNumber(orderData.nationalSubsidy).toFixed(2),
      educationSubsidy: ensureNumber(orderData.educationSubsidy).toFixed(2),
      actualAmount: ensureNumber(orderData.actualAmount).toFixed(2),
      invoiceStatus: orderData.invoiceStatus,
      invoiceInfo: orderData.invoiceInfo,
      subsidyStatus: orderData.subsidyStatus,
      subsidyPhotos: orderData.subsidyPhotos
    };
  },

  /**
   * 关闭打印机引导弹窗
   */
  closePrinterGuideModal: function () {
    this.setData({
      showPrinterGuideModal: false
    });
  },

  /**
   * 跳转到打印机设置页面
   */
  navigateToPrinterPage: function () {
    this.setData({
      showPrinterGuideModal: false
    });
    wx.navigateTo({
      url: '/pages/printer/printer'
    });
  },

  /**
   * 打印后提交订单
   */
  submitOrderAfterPrint: function () {
    // 验证表单
    if (!this.validateForm()) {
      return;
    }

    // 生成订单数据
    const orderData = this.generateOrderData();

    if (!this.confirmNegativeGrossProfit(orderData, () => this.submitOrderAfterPrintConfirmed(orderData))) return;
  },

  submitOrderAfterPrintConfirmed: function (orderData) {

    // 关闭预览弹窗
    this.setData({
      showPreview: false
    });

    // 保存订单
    this.saveOrder(orderData, true); // true 表示打印后提交，需要返回首页
  },

  /**
   * 提交订单
   */
  submitOrder: function () {
    // 验证表单
    if (!this.validateForm()) {
      return;
    }
    
    // 生成订单数据
    const orderData = this.generateOrderData();

    if (!this.confirmNegativeGrossProfit(orderData, () => this.saveOrder(orderData))) return;
  },

  confirmNegativeGrossProfit: function (orderData, onConfirm) {
    const profit = calculateOrderProfit(orderData);
    if (!profit.isBelowMinimum) {
      onConfirm();
      return true;
    }

    wx.showModal({
      title: '低于最低销售价提醒',
      content: `该单国补、教育优惠前应收 ¥${profit.receivable.toFixed(2)}，低于所有商品最低销售价合计 ¥${profit.minimumSalePriceTotal.toFixed(2)}，将触发审批流程。`,
      confirmText: '继续保存',
      cancelText: '返回修改',
      success: result => {
        if (result.confirm) onConfirm();
      }
    });
    return false;
  },

  /**
   * 验证表单
   */
  validateForm: function () {
    const goodsList = this.data.goodsList;
    const selectedCustomerSource = this.data.selectedCustomerSourceLevel1;
    const paymentMethods = this.getEffectivePaymentMethods(this.data.paymentMethods);
    const depositItems = this.getDepositItemsFromPaymentMethods(paymentMethods);
    const actualAmount = this.data.actualAmount;
    const invoiceStatus = this.data.invoiceStatus;
    const invoiceInfo = this.data.invoiceInfo;
    
    // 验证客户来源
    if (!selectedCustomerSource) {
      wx.showToast({
        title: '请选择客户来源',
        icon: 'none'
      });
      return false;
    }
    
    // 新建订单只保存录入内容，PN/SN 是否存在统一在归档时校验。
    for (let i = 0; i < goodsList.length; i++) {
      const item = goodsList[i];
      if (isEmptyOrderItem(item)) {
        wx.showToast({
          title: `商品${i + 1}为空，请删除空白行`,
          icon: 'none'
        });
        return false;
      }
      // 验证价格
      if (item.price < 0) {
        wx.showToast({
          title: '请输入商品' + (i + 1) + '的正确单价',
          icon: 'none'
        });
        return false;
      }
    }
    
    // 验证收款方式和金额
    let totalPaymentAmount = 0;
    const paymentTypeSet = new Set();
    if ((parseFloat(actualAmount) || 0) > 0 && paymentMethods.length === 0) {
      wx.showToast({
        title: '请添加收款方式',
        icon: 'none'
      });
      return false;
    }
    for (let i = 0; i < paymentMethods.length; i++) {
      const method = paymentMethods[i];
      if (!method.type) {
        wx.showToast({
          title: '请选择收款方式' + (i + 1),
          icon: 'none'
        });
        return false;
      }
      if (paymentTypeSet.has(method.type)) {
        wx.showToast({
          title: '收款方式重复，请合并',
          icon: 'none'
        });
        return false;
      }
      paymentTypeSet.add(method.type);
      if (this.isDepositPayment(method.type) && !method.depositId) {
        wx.showToast({
          title: '请选择可抵扣定金',
          icon: 'none'
        });
        return false;
      }
      if (method.amount <= 0) {
        wx.showToast({
          title: this.isDepositPayment(method.type) ? '请输入定金抵扣金额' : '请输入收款金额' + (i + 1),
          icon: 'none'
        });
        return false;
      }
      totalPaymentAmount += parseFloat(method.amount) || 0;
    }

    if (!this.validateDepositItems(depositItems)) return false;

    const paymentTotal = this.calculatePaymentTotal(paymentMethods);
    if (
      Math.round((parseFloat(actualAmount) || 0) * 100) !==
      Math.round(paymentTotal * 100)
    ) {
      wx.showModal({
        title: '金额不一致',
        content: `应收金额（¥${(parseFloat(actualAmount) || 0).toFixed(2)}）与收款信息汇总（¥${paymentTotal.toFixed(2)}）不一致，请核对后再提交。`,
        showCancel: false,
        confirmText: '去修改'
      });
      return false;
    }
    
    // 验证开票信息（国补订单的云闪付订单号允许提交时暂不填写，归档前再校验）
    if (invoiceStatus === '开专票' || invoiceStatus === '开普票') {
      if (this.data.subsidyStatus !== '国补' && !invoiceInfo.trim()) {
        wx.showToast({
          title: '请输入开票信息',
          icon: 'none'
        });
        return false;
      }
      if (!this.data.invoiceAmount || parseFloat(this.data.invoiceAmount) <= 0) {
        wx.showToast({
          title: '请输入开票金额',
          icon: 'none'
        });
        return false;
      }
    }

    return true;
  },

  /**
   * 生成订单数据
   */
  generateOrderData: function () {
    const goodsList = this.data.goodsList;
    const totalAmount = this.data.totalAmount;
    const discount = this.data.discount;
    const nationalSubsidy = this.data.nationalSubsidy;
    const computerAmount = this.data.computerAmount;
    const mobileAmount = this.data.mobileAmount;
    const educationSubsidy = this.data.educationSubsidy;
    const actualAmount = this.data.actualAmount;
    const auxiliarySalesList = this.data.auxiliarySalesList.map(item => {
      const profitAmount = parseFloat(item.profitAmount) || 0;
      // 如果金额分配为0，则将ratio设置为"利润平分"
      if (profitAmount === 0) {
        return {
          ...item,
          ratio: '利润平分'
        };
      }
      return item;
    });
    const selectedCustomerSource = this.data.selectedCustomerSourceLevel1;
    const selectedCustomerSourceDetail = this.data.selectedCustomerSourceLevel2;
    const contactName = this.data.contactName;
    const contactMethod = this.data.contactMethod;
    const paymentMethods = this.getEffectivePaymentMethods(this.data.paymentMethods);
    const depositItems = this.getDepositItemsFromPaymentMethods(paymentMethods);
    const invoiceStatus = this.data.invoiceStatus;
    const invoiceInfo = this.data.invoiceInfo;
    const hasGuobuPayment = this.getGuobuPaymentAmount(paymentMethods) > 0;
    const subsidyStatus = this.data.subsidyStatus === '国补' || hasGuobuPayment ? '国补' : this.data.subsidyStatus;
    const invoiceAmount = invoiceStatus === '不开票'
      ? 0
      : subsidyStatus === '国补'
        ? (this.data.invoiceAmount || this.getDefaultInvoiceAmount(paymentMethods))
        : this.data.invoiceAmount;
    const subsidyPerson = subsidyStatus === '国补'
      ? (this.data.subsidyPerson || contactName || '')
      : this.data.subsidyPerson;
    const subsidyId = subsidyStatus === '国补'
      ? (this.data.subsidyId || contactMethod || '')
      : this.data.subsidyId;
    const subsidyPhotos = this.data.subsidyPhotos;
    const productPhotoUrls = this.data.productPhotoUrls;
    const educationSubsidyPhotoUrl = this.data.educationSubsidyPhotoUrl;
    const educationSubsidyCouponCode = this.data.educationSubsidyCouponCode;
    const educationSubsidyOcrText = this.data.educationSubsidyOcrText;

    // 计算收款金额汇总（支持国补POS特殊计算）
    const paymentTotal = this.calculatePaymentTotal(paymentMethods);

    // 获取当前时间
    const now = new Date();
    const createTime = now.getTime();

    // 生成订单编号
    const orderNo = 'ORD' + createTime;

    // 获取用户信息（实际销售人）
    const userInfo = userUtils.getUserInfo();
    const createUser = userInfo.userName || '未知用户';
    const createUserPhone = userInfo.phone || userInfo.userPhone || '';

    // 获取临时门店信息（优先使用，否则使用用户所属门店）
    const tempStoreInfo = wx.getStorageSync('tempStoreInfo') || {};
    const storeId = this.data.storeId || tempStoreInfo.storeId || tempStoreInfo.store_id || tempStoreInfo.id || tempStoreInfo._id || (userUtils.isStoreScoped(userInfo) ? userInfo.storeId : '');
    const storeName = this.data.storeName || tempStoreInfo.storeName || tempStoreInfo.store_name || tempStoreInfo.name || (userUtils.isStoreScoped(userInfo) ? userInfo.storeName : '');

    // 处理商品来源：一、二级来源只保留在金额最高的商品中，其他商品清空
    const processedGoodsList = this.processGoodsSourceForHighestPrice(
      goodsList,
      selectedCustomerSource,
      selectedCustomerSourceDetail
    );
    const processedItems = processedGoodsList.map(item => {
        const quantity = Number(item.quantity || 1);
        const price = Number(item.price || item.unitPrice || item.salePrice || 0);
        const inventoryId = item.inventoryId || item.inventory_id || item.snId || item.sn_id || '';
        const previousSnStatus = item.previousSnStatus || item.previous_sn_status || item.inventoryStatus || item.inventory_status || item.status || '在库';
        return {
        productId: item.productId || item.product_id || '',
        inventoryId: inventoryId,
        pnCode: item.pnCode || '',
        snCode: item.snCode || item.sn_code || item.sn || '',
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
        subtotal: item.subtotal !== undefined ? Number(item.subtotal || 0) : price * quantity,
        costPrice: Number(item.costPrice || item.cost_price || item.purchasePrice || item.purchase_price || item.importPrice || item.import_price || item.cost || item.settlementPrice || item.settlement_price || 0),
        cost_price: Number(item.costPrice || item.cost_price || item.purchasePrice || item.purchase_price || item.importPrice || item.import_price || item.cost || item.settlementPrice || item.settlement_price || 0),
        mtmCode: item.mtmCode || item.mtm_code || '',
        imei1: item.imei1 || '',
        imei2: item.imei2 || '',
        needSn: item.needSn !== undefined ? item.needSn : (item.need_sn || false),
        need_sn: item.needSn !== undefined ? item.needSn : (item.need_sn || false),
        customerSource: item.customerSource || '',
        customer_source: item.customerSource || '',
        customerSourceDetail: item.customerSourceDetail || '',
        customer_source_detail: item.customerSourceDetail || ''
      };
    });
    const canonicalProcessedItems = processedItems.map(item => normalizeOrderItem(item));

    return {
      orderNo: orderNo,
      createTime: createTime,
      createUser: createUser, // 实际销售人（开单人）
      createUserPhone: createUserPhone, // 提单人电话
      storeId: storeId, // 门店ID（优先使用临时门店）
      storeName: storeName, // 门店名称（优先使用临时门店）
      auxiliarySalesList: auxiliarySalesList,
      customerSource: selectedCustomerSource,
      customerSourceDetail: selectedCustomerSourceDetail,
      contactName: contactName,
      contactMethod: contactMethod,
      paymentMethods: paymentMethods,
      depositItems: depositItems,
      deposits: depositItems,
      depositDeductionTotal: this.getDepositDeductionTotal(depositItems),
      paymentTotal: paymentTotal, // 收款金额汇总
      goods: canonicalProcessedItems,
      items: canonicalProcessedItems,
      totalAmount: totalAmount,
      discount: discount,
      nationalSubsidy: nationalSubsidy,
      computerAmount: computerAmount,
      mobileAmount: mobileAmount,
      educationSubsidy: educationSubsidy,
      actualAmount: actualAmount,
      invoiceStatus: invoiceStatus,
      invoiceInfo: invoiceInfo,
      invoiceAmount: invoiceAmount, // 开票金额
      subsidyStatus: subsidyStatus, // 国补状态
      subsidyPerson: subsidyPerson, // 国补人
      subsidyId: subsidyId, // 国补人ID
      subsidyPhotos: subsidyPhotos, // 国补照片（6个固定位置）
      productPhotoUrls: productPhotoUrls, // 非国补商品图片（多图）
      educationSubsidyPhotoUrl: educationSubsidyPhotoUrl, // 教育补贴核销凭证
      educationSubsidyCouponCode: educationSubsidyCouponCode,
      educationSubsidyOcrText: educationSubsidyOcrText,
      personalInfoPhoto: this.data.personalInfoPhoto, // 个人资料照片
      imei1: processedGoodsList.find(g => g.imei1)?.imei1 || '', // 从商品列表中提取IMEI1
      imei2: processedGoodsList.find(g => g.imei2)?.imei2 || '', // 从商品列表中提取IMEI2
      status: '未归档',
      createDate: `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`
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

  /**
   * 保存订单
   */
  formatSaveError: function (err) {
    const message = err && (err.message || err.errMsg || err.error || (err.body && (err.body.message || err.body.error))) || err;
    return String(message || '订单保存失败，请稍后重试').replace(/^Error:\s*/i, '').trim();
  },

  showSaveError: function (err) {
    wx.showModal({
      title: '保存失败',
      content: this.formatSaveError(err),
      showCancel: false,
      confirmText: '知道了'
    });
  },

  saveOrder: function (orderData, returnToIndex = false) {
    const DataStorage = require('../../utils/storage.js');

    wx.showLoading({
      title: '保存订单中...',
    });

    DataStorage.saveOrder(orderData,
      (res) => {
        wx.hideLoading();

        // 订单提交成功，清除缓存
        this.clearOrderCache();

        wx.showToast({
          title: '订单提交成功',
          icon: 'success',
          duration: 2000,
          success: () => {
            // 延迟后跳转
            setTimeout(() => {
              if (returnToIndex) {
                // 打印并提交后返回首页
                wx.switchTab({
                  url: '/pages/index/index'
                });
              } else {
                // 普通提交后跳转到订单列表
                wx.navigateTo({ url: '/pages/order-list/order-list' });
              }
            }, 2000);
          }
        });
      },
      (err) => {
        wx.hideLoading();
        this.showSaveError(err);
        console.error('保存订单失败：', err);
      }
    );
  }
})
