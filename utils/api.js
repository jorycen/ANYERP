const http = require('./request.js');
const { normalizePnCode, readExternalPnCode } = require('./pn.js');
const { normalizeOrderItem, normalizeMoney, normalizeQuantity, normalizeSnCode, isEmptyOrderItem } = require('./model.js');

function toQuery(params) {
  const parts = [];
  Object.keys(params || {}).forEach(key => {
    const value = params[key];
    if (value !== undefined && value !== null && value !== '') {
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
    }
  });
  return parts.length ? '?' + parts.join('&') : '';
}

function getListPayload(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.list)) return result.list;
  if (Array.isArray(result.rows)) return result.rows;
  if (Array.isArray(result.items)) return result.items;
  if (Array.isArray(result.records)) return result.records;
  if (Array.isArray(result.locations)) return result.locations;
  if (Array.isArray(result.data)) return result.data;
  if (result.data && Array.isArray(result.data.list)) return result.data.list;
  if (result.data && Array.isArray(result.data.rows)) return result.data.rows;
  if (result.data && Array.isArray(result.data.items)) return result.data.items;
  if (result.data && Array.isArray(result.data.records)) return result.data.records;
  if (result.data && Array.isArray(result.data.locations)) return result.data.locations;
  return [];
}

function mapRole(roleCode) {
  const role = String(roleCode || '').toLowerCase();
  if (['boss', 'admin', 'distributor', 'system_admin', 'business', 'finance', 'purchaser', 'cashier'].includes(role)) return 'distributor';
  if (role === 'manager' || role === 'store_admin') return 'store_admin';
  return 'staff';
}

function normalizeUser(userInfo) {
  const role = mapRole(userInfo.roleCode || userInfo.role_code || userInfo.ROLE_CODE || userInfo.role || '');
  const staffId = userInfo.staffId || userInfo.staff_id || userInfo.userId || userInfo.user_id || userInfo._id || userInfo.id || '';
  const name = userInfo.name || userInfo.userName || userInfo.user_name || userInfo.staffName || userInfo.staff_name ||
    userInfo.employeeName || userInfo.employee_name || userInfo.realName || userInfo.real_name || userInfo.NAME || '';
  const phone = userInfo.phone || userInfo.phoneNumber || userInfo.phone_number || userInfo.mobile || userInfo.mobilePhone ||
    userInfo.mobile_phone || userInfo.PHONE || '';
  return {
    _id: staffId,
    id: staffId,
    staffId,
    name,
    phone,
    phoneNumber: phone,
    role,
    roleCode: userInfo.roleCode || userInfo.role_code || role,
    roleName: userInfo.roleName || '',
    roleNames: userInfo.roleNames || userInfo.role_names || [],
    roles: userInfo.roles || [],
    scopeType: userInfo.scopeType || userInfo.scope_type || '',
    distributorId: userInfo.distributorId || userInfo.distributor_id || '',
    distributorName: userInfo.distributorName || '',
    storeId: userInfo.storeId || userInfo.store_id || '',
    storeName: userInfo.storeName || userInfo.store_name || userInfo.STORE_NAME || '',
    regionId: userInfo.regionId || userInfo.region_id || '',
    regionCode: userInfo.regionCode || userInfo.region_code || '',
    regionName: userInfo.regionName || userInfo.region_name || userInfo.REGION_NAME || '',
    regionCodes: userInfo.regionCodes || userInfo.region_codes || [],
    storeIds: userInfo.storeIds || userInfo.store_ids || [],
    menus: userInfo.menus || []
  };
}

function normalizeStore(store) {
  return {
    _id: store.store_id || store.storeId || store._id || '',
    id: store.store_id || store.storeId || store.id || '',
    storeId: store.store_id || store.storeId || '',
    name: store.name || '',
    address: store.address || '',
    phone: store.phone || '',
    status: store.status,
    distributorId: store.distributor_id || store.distributorId || '',
    regionId: store.region_id || store.regionId || '',
    regionName: store.region_name || store.Region?.name || '',
    regionCode: store.region_code || store.regionCode || '',
    sameRegion: store.same_region !== false && store.sameRegion !== false,
    managerName: store.managerName || store.manager_name || '',
    managerPhone: store.managerPhone || store.manager_phone || '',
    staffList: store.staffList || store.staff_list || []
  };
}

function normalizeLocation(location) {
  if (typeof location === 'string') {
    return { locationId: location, name: location, code: '', status: 1, storeId: '' };
  }
  return {
    locationId: location.location_id || location.locationId || location.LOCATION_ID || location.id || location._id || '',
    name: location.name || location.location_name || location.locationName || location.NAME || '',
    code: location.code || location.location_code || location.locationCode || location.CODE || '',
    status: location.status === undefined ? location.STATUS : location.status,
    type: location.type || location.location_type || location.locationType || location.TYPE || '',
    storeId: location.store_id || location.storeId || location.STORE_ID || ''
  };
}

function normalizeInventoryStatusLabel(item = {}, status = '') {
  const rawLabel = item.status_label || item.statusLabel || item.statusText || item.currentStatusLabel || '';
  if (rawLabel) return rawLabel;
  const labels = {
    in_stock: '在库',
    reserved: '已占用',
    occupied: '已占用',
    sold: '已销售',
    out_stock: '已出库',
    transferring: '调拨中',
    return_pending: '退货待入库',
    voided: '已作废'
  };
  const normalized = String(status || '').trim();
  return labels[normalized] || (normalized && !['0', '1'].includes(normalized) ? normalized : '');
}

function normalizeProduct(item) {
  const product = item.Product || item.product || {};
  const priceInfo = item.ProductPrice || item.productPrice || product.ProductPrice || {};
  const standardPrice = item.standard_price || item.standardPrice || item.product_standard_price || item.productStandardPrice ||
    priceInfo.standard_price || priceInfo.standardPrice || product.standard_price || product.standardPrice ||
    product.product_standard_price || product.productStandardPrice || item.price || item.PRICE || 0;
  const retailPrice = item.retail_price || item.retailPrice || item.sale_price || item.salePrice ||
    priceInfo.retail_price || priceInfo.retailPrice || priceInfo.sale_price || priceInfo.salePrice ||
    item.price || item.PRICE || standardPrice || 0;
  const price = retailPrice;
  const settlementPrice = item.settlement_price || retailPrice || standardPrice || 0;
  const nestedPnList = product.manufacturer_codes || product.pn_list || product.manufacturerCodes || product.pnList || [];
  const pnList = item.manufacturer_codes || item.pn_list || item.manufacturerCodes || item.pnList || nestedPnList || [];
  const pnCode = normalizePnCode(
    readExternalPnCode(item) ||
    readExternalPnCode(product) ||
    item.barcode || product.barcode || pnList[0] || ''
  );
  const sn = item.sn || item.sn_code || item.snCode || item.SN ||
    product.sn || product.sn_code || product.snCode || product.SN || '';
  const snId = item.sn_id || item.snId || item.inventory_sn_id || item.inventorySnId || item.serial_id || item.serialId || item.inventory_id || item.inventoryId || item.id || item._id || '';
  const inventoryId = item.inventory_id || item.inventoryId || item.inventory_sn_id || item.inventorySnId || snId || '';
  const inferredStockQty = Number(item.normal_qty || item.stock_qty || item.stock || 0);
  const currentStoreStockQty = item.current_store_stock_qty !== undefined || item.currentStoreStockQty !== undefined
    ? Number(item.current_store_stock_qty || item.currentStoreStockQty || 0)
    : inferredStockQty;
  const otherStoreStockQty = Number(item.other_store_stock_qty || item.otherStoreStockQty || 0);
  const totalStockQty = Number(item.total_stock_qty || item.totalStoreStockQty || item.stock_qty || item.stock || item.normal_qty || 0);
  const status = item.status !== undefined
    ? item.status
    : (item.STATUS !== undefined ? item.STATUS : (product.status !== undefined ? product.status : ''));
  const statusLabel = normalizeInventoryStatusLabel(item, status);
  return {
    productId: item.productId || item.product_id || item.id || item._id || product.productId || product.product_id || product.id || product._id || '',
    productCode: item.product_code || item.productCode || product.product_code || product.productCode || '',
    storeId: item.store_id || item.storeId || product.store_id || product.storeId || '',
    inventoryId,
    snCode: normalizeSnCode(sn),
    inventoryType: item.inventory_type || item.inventoryType || '',
    pnCode,
    pnOptions: (Array.isArray(pnList) ? pnList : [pnList]).map(normalizePnCode).filter(Boolean),
    name: item.name || item.productName || item.product_name || item.NAME ||
      product.name || product.productName || product.product_name || product.NAME || '',
    spec: item.spec || item.config || item.product_spec || product.spec || product.config || product.product_spec || '',
    config: item.config || item.spec || item.product_spec || product.config || product.spec || product.product_spec || '',
    price,
    retailPrice,
    salePrice: retailPrice,
    sale_price: retailPrice,
    settlementPrice,
    standardPrice: Number(standardPrice || 0),
    standard_price: Number(standardPrice || 0),
    costPrice: Number(item.cost_price || item.costPrice || item.purchase_price || item.purchasePrice || item.import_price || item.importPrice || item.cost || item.settlement_price || item.settlementPrice || settlementPrice || 0),
    minSalePrice: item.min_sale_price || item.minSalePrice || item.minimum_sale_price || item.minimumSalePrice ||
      item.min_price || item.minPrice || item.lowest_sale_price || item.lowestSalePrice || item.low_price || item.lowPrice ||
      item.floor_price || item.floorPrice || priceInfo.min_sale_price || priceInfo.minSalePrice ||
      priceInfo.minimum_sale_price || priceInfo.minimumSalePrice || priceInfo.min_price || priceInfo.minPrice ||
      priceInfo.lowest_sale_price || priceInfo.lowestSalePrice || priceInfo.low_price || priceInfo.lowPrice ||
      product.min_sale_price || product.minSalePrice || product.minimum_sale_price || product.minimumSalePrice ||
      product.min_price || product.minPrice || product.lowest_sale_price || product.lowestSalePrice || product.low_price || product.lowPrice || 0,
    min_sale_price: item.min_sale_price || item.minSalePrice || item.minimum_sale_price || item.minimumSalePrice ||
      item.min_price || item.minPrice || item.lowest_sale_price || item.lowestSalePrice || item.low_price || item.lowPrice ||
      item.floor_price || item.floorPrice || priceInfo.min_sale_price || priceInfo.minSalePrice ||
      priceInfo.minimum_sale_price || priceInfo.minimumSalePrice || priceInfo.min_price || priceInfo.minPrice ||
      priceInfo.lowest_sale_price || priceInfo.lowestSalePrice || priceInfo.low_price || priceInfo.lowPrice ||
      product.min_sale_price || product.minSalePrice || product.minimum_sale_price || product.minimumSalePrice ||
      product.min_price || product.minPrice || product.lowest_sale_price || product.lowestSalePrice || product.low_price || product.lowPrice || 0,
    category: item.category || product.category || '',
    needSn: item.needSn !== undefined ? item.needSn : (
      item.need_sn !== undefined ? item.need_sn : (
        product.needSn !== undefined ? product.needSn : (product.need_sn || 0)
      )
    ),
    stock: item.stock || item.normal_qty || item.stock_qty || 0,
    currentStoreStockQty,
    otherStoreStockQty,
    totalStockQty,
    currentStoreName: item.current_store_name || item.currentStoreName || '',
    status,
    statusLabel,
    statusText: statusLabel,
    inventoryStatus: item.inventoryStatus !== undefined ? item.inventoryStatus : (item.inventory_status !== undefined ? item.inventory_status : (product.inventoryStatus !== undefined ? product.inventoryStatus : '')),
    storeStockInfo: item.store_stock_info || item.storeStockInfo || [],
    otherStoreStockInfo: item.other_store_stock_info || item.otherStoreStockInfo || [],
    sales7Qty: Number(item.sales_7_qty || item.sales7Qty || 0),
    sales30Qty: Number(item.sales_30_qty || item.sales30Qty || 0),
    avgGrossProfit7: Number(item.avg_gross_profit_7 || item.avgGrossProfit7 || 0),
    maxGrossProfit7: Number(item.max_gross_profit_7 || item.maxGrossProfit7 || 0),
    stockRank: item.stock_rank !== undefined ? Number(item.stock_rank) : 2
  };
}

function normalizeSnInventoryRow(item = {}) {
  const product = normalizeProduct(item);
  const statusChangeTime = item.status_change_time || item.statusChangeTime ||
    item.update_time || item.updateTime || '';
  return Object.assign({}, product, {
    snId: item.sn_id || item.snId || item.inventory_id || item.inventoryId || item.id || item._id || '',
    snCode: normalizeSnCode(item.sn_code || item.snCode || item.SN || item.sn || product.snCode || ''),
    pnCode: normalizePnCode(item.pn_code || item.pnCode || product.pnCode || ''),
    productName: item.product_name || item.productName || product.name || '',
    storeId: item.store_id || item.storeId || product.storeId || '',
    storeName: item.store_name || item.storeName || item.Store?.name || '',
    locationName: item.location_name || item.locationName || item.Location?.name || '未指定库位',
    status: item.status !== undefined ? item.status : product.status,
    statusLabel: item.status_label || item.statusLabel || item.statusText || product.statusLabel || '',
    statusChangeTime,
    inboundTime: item.inbound_time || item.inboundTime || '',
    stockAgeDays: item.stock_age_days !== undefined ? item.stock_age_days : item.stockAgeDays,
    unifiedSalePrice: Number(item.unified_sale_price || item.unifiedSalePrice || item.standard_price || item.standardPrice || 0),
    effectiveSalePrice: Number(item.effective_sale_price || item.effectiveSalePrice || item.retail_price || item.retailPrice || 0),
    specialPrice: item.special_price !== undefined ? Number(item.special_price || 0) : null,
    isSpecialPrice: item.is_special_price === true || item.is_special_price === 1 || item.isSpecialPrice === true,
    specialPriceRemark: item.special_price_remark || item.specialPriceRemark || item.remark || ''
  });
}

function parseJsonField(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return value;
  }
}

function normalizeArrayField(value) {
  const parsed = parseJsonField(value, []);
  if (Array.isArray(parsed)) return parsed;
  return parsed === undefined || parsed === null || parsed === '' ? [] : [parsed];
}

function mergeArrayFields() {
  const result = [];
  Array.prototype.slice.call(arguments).forEach(value => {
    normalizeArrayField(value).forEach(item => {
      const key = typeof item === 'string' ? item : JSON.stringify(item);
      if (key && !result.some(existing => (typeof existing === 'string' ? existing : JSON.stringify(existing)) === key)) {
        result.push(item);
      }
    });
  });
  return result;
}

function getFirstFiniteNumber(source, keys) {
  for (let i = 0; i < keys.length; i++) {
    const value = source && source[keys[i]];
    if (value === undefined || value === null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) {
      return { found: true, value: number };
    }
  }
  return { found: false, value: 0 };
}

function normalizeOrder(order) {
  const items = normalizeArrayField(order.OrderItems || order.items || order.goods || []);
  const payments = normalizeArrayField(order.OrderPayments || order.payments || order.paymentMethods || []);
  const supplements = normalizeArrayField(order.supplements || order.OrderSupplements || []);
  const normalizedItems = mapSalesItems(items);
  const sourceItem = normalizedItems.find(item =>
    item.customerSource ||
    item.customer_source ||
    item.customerSourceDetail ||
    item.customer_source_detail
  ) || {};
  const rawStatus = order.order_status || order.status;
  const normalizedStatus = rawStatus === 'archived'
    ? '已归档'
    : (rawStatus === 'voided' || rawStatus === 'cancelled' ? '已作废' : rawStatus);
  const totalAmount = Number(order.total_amount || order.totalAmount || 0);
  const discount = Number(order.discount_amount || order.discountAmount || order.discount || 0);
  const nationalSubsidy = Number(order.national_subsidy || order.nationalSubsidy || 0);
  const educationSubsidy = Number(order.education_subsidy || order.educationSubsidy || 0);
  const depositDeductionTotal = Number(order.deposit_deduction_total || order.depositDeductionTotal || 0);
  // 定金属于收款方式，depositDeductionTotal 仅用于核销记录，不再减少应收金额。
  const computedActualAmount = Math.max(0, totalAmount - discount - nationalSubsidy - educationSubsidy);
  const storedActualPayment = getFirstFiniteNumber(order, ['actual_payment', 'actualPayment', 'actual_amount', 'actualAmount']);
  const actualAmount = Math.max(0, storedActualPayment.found ? storedActualPayment.value : computedActualAmount);
  const storedPaymentTotal = getFirstFiniteNumber(order, ['payment_total', 'paymentTotal']);
  const paymentTotal = Math.max(0, storedPaymentTotal.found ? storedPaymentTotal.value : actualAmount);
  const hasGuobuInfo = nationalSubsidy > 0 ||
    order.subsidy_person ||
    order.subsidyPerson ||
    order.subsidy_id ||
    order.subsidyId ||
    (payments || []).some(payment => String(payment.payment_method || payment.method || payment.type || '').indexOf('国补') >= 0);
  const subsidyStatus = hasGuobuInfo ? '国补' : (order.subsidy_status || order.subsidyStatus || '');
  const normalized = {
    ...order,
    _id: order.order_id || order._id,
    orderId: order.order_id || order.orderId,
    orderNo: order.order_no || order.orderNo,
    storeId: order.store_id || order.storeId,
    storeName: order.store_name || order.Store?.name || order.storeName,
    createUser: order.create_user || order.createUser,
    contactName: order.customer_name || order.contactName,
    contactMethod: order.customer_phone || order.contactMethod,
    customerSource: order.customer_source || order.customerSource || sourceItem.customerSource || sourceItem.customer_source || '',
    customerSourceDetail: order.customer_source_detail || order.customerSourceDetail || order.source_detail || order.sourceDetail || order.secondary_source || order.secondarySource || order.second_source || order.secondSource || order.source_detail_name || order.sourceDetailName || sourceItem.customerSourceDetail || sourceItem.customer_source_detail || '',
    totalAmount,
    actualAmount,
    actualPayment: actualAmount,
    discount,
    discountAmount: discount,
    nationalSubsidy,
    computerAmount: order.computer_amount || order.computerAmount || '',
    mobileAmount: order.mobile_amount || order.mobileAmount || '',
    educationSubsidy,
    paymentTotal,
    invoiceStatus: order.invoice_status || order.invoiceStatus || '',
    invoiceInfo: order.invoice_info || order.invoiceInfo || '',
    invoiceAmount: order.invoice_amount || order.invoiceAmount || '',
    subsidyStatus,
    subsidyPerson: order.subsidy_person || order.subsidyPerson || '',
    subsidyId: order.subsidy_id || order.subsidyId || '',
    subsidyPhotos: mergeArrayFields(order.subsidy_photos, order.subsidyPhotos, order.subsidy_photo_urls, order.subsidyPhotoUrls),
    productPhotoUrls: mergeArrayFields(order.product_photo_urls, order.productPhotoUrls, order.product_photo_ids, order.productPhotoIds),
    educationSubsidyPhotoUrl: parseJsonField(order.education_subsidy_photo_url || order.educationSubsidyPhotoUrl || '', ''),
    educationSubsidyCouponCode: order.education_subsidy_coupon_code || order.educationSubsidyCouponCode || '',
    educationSubsidyOcrText: order.education_subsidy_ocr_text || order.educationSubsidyOcrText || '',
    personalInfoPhoto: parseJsonField(order.personal_info_photo || order.personalInfoPhoto || '', ''),
    depositItems: normalizeArrayField(order.deposit_items || order.depositItems || order.deposits || []),
    depositDeductionTotal,
    auxiliarySalesList: normalizeArrayField(order.auxiliary_sales_list || order.auxiliarySalesList || []),
    status: normalizedStatus,
    createTime: order.create_time || order.createTime,
    updateTime: order.update_time || order.updateTime,
    goods: normalizedItems,
    items: normalizedItems,
    paymentMethods: payments.map(payment => ({
      type: payment.payment_method || payment.method || payment.type,
      amount: payment.amount,
      depositId: payment.deposit_id || payment.depositId || '',
      depositNo: payment.deposit_no || payment.depositNo || ''
    })),
    supplements: supplements
      .filter(item => item.is_deleted !== 1 && item.isDeleted !== true)
      .map(item => ({
        supplementId: item.supplement_id || item.supplementId || item._id || '',
        itemId: item.item_id || item.itemId || '',
        itemName: item.item_name || item.itemName || '',
        amount: Number(item.amount || 0),
        amountType: item.amount_type || item.amountType || 'increase',
        content: item.content || '',
        proofPhotoUrl: item.proof_photo_url || item.proofPhotoUrl || '',
        couponCode: item.coupon_code || item.couponCode || '',
        couponOcrText: item.coupon_ocr_text || item.couponOcrText || '',
        createUser: item.create_user || item.createUser || '',
        createTime: item.create_time || item.createTime || ''
      }))
  };
  [
    'order_id', 'order_no', 'store_id', 'store_name', 'create_user', 'customer_name', 'customer_phone',
    'customer_source', 'customer_source_detail', 'source_detail', 'sourceDetail', 'secondary_source',
    'secondarySource', 'second_source', 'secondSource', 'source_detail_name', 'sourceDetailName',
    'total_amount', 'actual_payment', 'actual_amount', 'discount_amount', 'national_subsidy',
    'computer_amount', 'mobile_amount', 'education_subsidy', 'payment_total', 'invoice_status',
    'invoice_info', 'invoice_amount', 'subsidy_status', 'subsidy_person', 'subsidy_id', 'subsidy_photos',
    'product_photo_urls', 'education_subsidy_photo_url', 'education_subsidy_coupon_code',
    'education_subsidy_ocr_text', 'personal_info_photo', 'deposit_items', 'deposit_deduction_total',
    'auxiliary_sales_list', 'create_time', 'update_time', 'order_status'
  ].forEach(key => delete normalized[key]);
  return normalized;
}

function mapSalesOrderPayload(data = {}) {
  const payload = Object.assign({}, data);

  const aliases = {
    orderNo: 'order_no',
    contactName: 'customer_name',
    contactMethod: 'customer_phone',
    customerName: 'customer_name',
    customerPhone: 'customer_phone',
    customerSource: 'customer_source',
    customerSourceDetail: 'customer_source_detail',
    totalAmount: 'total_amount',
    discountAmount: 'discount_amount',
    nationalSubsidy: 'national_subsidy',
    computerAmount: 'computer_amount',
    mobileAmount: 'mobile_amount',
    educationSubsidy: 'education_subsidy',
    actualPayment: 'actual_payment',
    actualAmount: 'actual_payment',
    paymentTotal: 'payment_total',
    invoiceStatus: 'invoice_status',
    invoiceInfo: 'invoice_info',
    invoiceAmount: 'invoice_amount',
    subsidyStatus: 'subsidy_status',
    subsidyPerson: 'subsidy_person',
    subsidyId: 'subsidy_id',
    subsidyPhotos: 'subsidy_photos',
    productPhotoUrls: 'product_photo_urls',
    educationSubsidyPhotoUrl: 'education_subsidy_photo_url',
    educationSubsidyCouponCode: 'education_subsidy_coupon_code',
    educationSubsidyOcrText: 'education_subsidy_ocr_text',
    personalInfoPhoto: 'personal_info_photo',
    depositItems: 'deposit_items',
    depositDeductionTotal: 'deposit_deduction_total',
    depositAction: 'deposit_action',
    auxiliarySalesList: 'auxiliary_sales_list',
    storeName: 'store_name',
    createUser: 'create_user',
    createUserPhone: 'create_user_phone',
    orderStatus: 'order_status',
    snStatusAction: 'sn_status_action',
    targetSnStatus: 'target_sn_status',
    previousSnStatus: 'previous_sn_status',
    inventoryStatusAction: 'inventory_status_action',
    targetInventoryStatus: 'target_inventory_status',
    previousInventoryStatus: 'previous_inventory_status',
    restorePreviousSnStatus: 'restore_previous_sn_status',
    restoreOriginalInventory: 'restore_original_inventory',
    voidReason: 'void_reason'
  };

  Object.keys(aliases).forEach(key => {
    if (payload[key] !== undefined && payload[aliases[key]] === undefined) {
      payload[aliases[key]] = payload[key];
    }
  });

  if (payload.discount !== undefined && payload.discount_amount === undefined) {
    payload.discount_amount = payload.discount;
  }
  if (payload.status !== undefined && payload.order_status === undefined) {
    payload.order_status = payload.status;
  }

  if (payload.items || payload.goods) {
    const items = mapSalesItems(payload.items || payload.goods || []);
    [
      'items',
      'goods',
      'orderItems',
      'OrderItems',
      'productItems',
      'saleItems',
      'salesItems',
      'itemList',
      'order_items',
      'goodsList',
      'products'
    ].forEach(key => {
      payload[key] = items;
    });
  }

  if (payload.payments || payload.paymentMethods) {
    const payments = mapSalesPayments(payload.payments || payload.paymentMethods || []);
    payload.payments = payments;
    payload.paymentMethods = payments;
  }

  return payload;
}

function pickInvoicePayload(data = {}) {
  return mapSalesOrderPayload({
    invoiceStatus: data.invoiceStatus || '',
    invoiceInfo: data.invoiceInfo || '',
    invoiceAmount: data.invoiceAmount || ''
  });
}

function pickItemsPayload(data = {}) {
  const items = mapSalesItems(data.items || data.goods || []);
  return {
    items,
    goods: items
  };
}

function pickOrderItemsForSnDebug(order = {}) {
  const items = order.OrderItems || order.orderItems || order.items || order.goods ||
    order.productItems || order.saleItems || order.salesItems || order.itemList ||
    order.order_items || order.goodsList || order.products || [];
  return Array.isArray(items) ? items : [];
}

function mapOrderSnDebugRows(items = []) {
  return (items || []).map((rawItem, index) => {
    const item = normalizeOrderItem(rawItem);
    return {
    index,
    itemId: item.itemId,
    productId: item.productId,
    productName: item.productName,
    pnCode: item.pnCode,
    inventoryId: item.inventoryId,
    snCode: item.snCode,
    quantity: item.quantity
    };
  });
}

function getComparableItemValue(item, keys) {
  for (let i = 0; i < keys.length; i++) {
    const value = item && item[keys[i]];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
}

function getComparableItemKey(item) {
  const inventoryId = getComparableItemValue(item, ['inventoryId']);
  if (inventoryId) return 'inventory:' + inventoryId;
  return [
    getComparableItemValue(item, ['productId']),
    getComparableItemValue(item, ['pnCode']),
    getComparableItemValue(item, ['productName']),
    getComparableItemValue(item, ['quantity'])
  ].join('|');
}

function mergeExistingOrderItemIds(data = {}, existingItems = []) {
  if ((!data.items || !data.items.length) && (!data.goods || !data.goods.length)) return data;
  const usedIndexes = {};
  const existing = (existingItems || []).filter(item => getComparableItemValue(item, ['itemId', 'item_id', '_id', 'id']));

  function findExistingItem(item, index) {
    const currentId = getComparableItemValue(item, ['itemId', 'item_id', '_id', 'id']);
    if (currentId) return null;
    const key = getComparableItemKey(item);
    let fallback = null;
    for (let i = 0; i < existing.length; i++) {
      if (usedIndexes[i]) continue;
      if (!fallback && i === index) fallback = { item: existing[i], index: i };
      if (getComparableItemKey(existing[i]) === key) {
        usedIndexes[i] = true;
        return existing[i];
      }
    }
    if (fallback) {
      usedIndexes[fallback.index] = true;
      return fallback.item;
    }
    return null;
  }

  function enrichItems(items = []) {
    return (items || []).map((item, index) => {
      const matched = findExistingItem(item, index);
      if (!matched) return item;
      const itemId = getComparableItemValue(matched, ['itemId', 'item_id', '_id', 'id']);
      return Object.assign({}, item, {
        itemId,
        item_id: itemId
      });
    });
  }

  const next = Object.assign({}, data);
  const sourceItems = next.items && next.items.length ? next.items : (next.goods || []);
  const enrichedItems = enrichItems(sourceItems);
  [
    'items',
    'goods',
    'orderItems',
    'OrderItems',
    'productItems',
    'saleItems',
    'salesItems',
    'itemList',
    'order_items',
    'goodsList',
    'products'
  ].forEach(key => {
    if (next[key] && next[key].length) next[key] = enrichedItems;
  });
  if (!next.items && sourceItems.length) next.items = enrichedItems;
  if (!next.goods && sourceItems.length) next.goods = enrichedItems;
  return next;
}

function enrichPayloadWithExistingOrderItems(orderId, data = {}) {
  if (!orderId || ((!data.items || !data.items.length) && (!data.goods || !data.goods.length))) {
    return Promise.resolve(data);
  }
  return api.order.getDetails(orderId)
    .then(detailOrder => {
      const existingItems = pickOrderItemsForSnDebug(detailOrder);
      return mergeExistingOrderItemIds(data, existingItems);
    })
    .catch(err => {
      console.warn('updateByOrderNo merge item ids failed:', err);
      return data;
    });
}

function buildOrderItemUpdatePayload(orderId, orderNo, item) {
  const normalized = mapSalesItems([item])[0] || {};
  normalized.orderNo = orderNo;
  normalized.order_no = orderNo;
  normalized.ORDER_NO = orderNo;
  normalized.orderId = orderId;
  normalized.order_id = orderId;
  normalized.ORDER_ID = orderId;
  return Object.assign({}, normalized, {
    orderId,
    order_id: orderId,
    ORDER_ID: orderId,
    orderNo,
    order_no: orderNo,
    ORDER_NO: orderNo,
    item: normalized,
    items: [normalized],
    goods: [normalized],
    OrderItems: [normalized],
    orderItems: [normalized]
  });
}

function getOrderItemUpdateCandidates(orderId, itemId, payload) {
  const encodedOrderId = encodeURIComponent(orderId);
  const encodedItemId = encodeURIComponent(itemId);
  return [
    { method: 'PUT', url: '/sales/order-items', data: payload },
    { method: 'POST', url: '/sales/order-items', data: payload },
    { method: 'PUT', url: '/sales/order-items/' + encodedItemId, data: payload },
    { method: 'PATCH', url: '/sales/order-items/' + encodedItemId, data: payload },
    { method: 'PUT', url: '/sales/order-items/update/' + encodedItemId, data: payload },
    { method: 'POST', url: '/sales/order-items/update/' + encodedItemId, data: payload },
    { method: 'PUT', url: '/sales/order-item/' + encodedItemId, data: payload },
    { method: 'PATCH', url: '/sales/order-item/' + encodedItemId, data: payload },
    { method: 'PUT', url: '/sales/order-item/update/' + encodedItemId, data: payload },
    { method: 'POST', url: '/sales/order-item/update/' + encodedItemId, data: payload },
    { method: 'PUT', url: '/sales/items/' + encodedItemId, data: payload },
    { method: 'PATCH', url: '/sales/items/' + encodedItemId, data: payload },
    { method: 'PUT', url: '/sales/items/update/' + encodedItemId, data: payload },
    { method: 'POST', url: '/sales/items/update/' + encodedItemId, data: payload },
    { method: 'PUT', url: '/sales/item/' + encodedItemId, data: payload },
    { method: 'PATCH', url: '/sales/item/' + encodedItemId, data: payload },
    { method: 'PUT', url: '/sales/item/update/' + encodedItemId, data: payload },
    { method: 'POST', url: '/sales/item/update/' + encodedItemId, data: payload },
    { method: 'PUT', url: '/sales/update-item/' + encodedItemId, data: payload },
    { method: 'POST', url: '/sales/update-item/' + encodedItemId, data: payload },
    { method: 'PUT', url: '/sales/update-order-item/' + encodedItemId, data: payload },
    { method: 'POST', url: '/sales/update-order-item/' + encodedItemId, data: payload },
    { method: 'PUT', url: '/sales/' + encodedOrderId + '/items/' + encodedItemId, data: payload },
    { method: 'PATCH', url: '/sales/' + encodedOrderId + '/items/' + encodedItemId, data: payload },
    { method: 'PUT', url: '/sales/' + encodedOrderId + '/order-items/' + encodedItemId, data: payload },
    { method: 'PATCH', url: '/sales/' + encodedOrderId + '/order-items/' + encodedItemId, data: payload },
    { method: 'PUT', url: '/sales/' + encodedOrderId + '/items', data: payload },
    { method: 'PUT', url: '/sales/' + encodedOrderId + '/order-items', data: payload }
  ];
}

function requestOrderItemCandidate(candidate) {
  return http.request({
    url: candidate.url,
    method: candidate.method,
    data: candidate.data,
    silentErrors: true
  }).then(result => {
    const text = typeof result === 'string' ? result.trim() : '';
    if (text.indexOf('<!DOCTYPE html') === 0 || text.indexOf('<div id="app"></div>') >= 0) {
      const err = new Error('Endpoint returned admin HTML fallback');
      err.statusCode = 200;
      throw err;
    }
    return result;
  });
}

function validateOrderItemInventorySynced(orderId, itemId, inventoryId) {
  return api.order.getDetails(orderId).then(detailOrder => {
    const rows = pickOrderItemsForSnDebug(detailOrder);
    const matched = rows.find(row => String(getComparableItemValue(row, ['itemId', 'item_id', '_id', 'id'])) === String(itemId));
    const backendInventoryId = matched ? getComparableItemValue(matched, ['inventoryId', 'inventory_id', 'INVENTORY_ID', 'snId', 'sn_id', 'inventorySnId', 'inventory_sn_id']) : '';
    return {
      synced: backendInventoryId === String(inventoryId),
      backendInventoryId,
      backendRows: mapOrderSnDebugRows(rows)
    };
  });
}

function syncSingleOrderItemInventory(orderId, orderNo, item) {
  const itemId = getComparableItemValue(item, ['itemId', 'item_id', 'orderItemId', 'order_item_id', 'ITEM_ID', '_id', 'id']);
  const inventoryId = getComparableItemValue(item, ['inventoryId', 'inventory_id', 'INVENTORY_ID', 'snId', 'sn_id', 'inventorySnId', 'inventory_sn_id']);
  if (!orderId || !itemId || !inventoryId) return Promise.resolve({ skipped: true, itemId, inventoryId });

  const payload = buildOrderItemUpdatePayload(orderId, orderNo, item);
  const candidates = getOrderItemUpdateCandidates(orderId, itemId, payload);
  const failures = [];

  function tryAt(index) {
    if (index >= candidates.length) {
      return Promise.resolve({
        success: false,
        itemId,
        inventoryId,
        failures
      });
    }
    const candidate = candidates[index];
    return requestOrderItemCandidate(candidate)
      .then(result => validateOrderItemInventorySynced(orderId, itemId, inventoryId)
        .then(validation => {
          if (!validation.synced) {
            const validationErr = new Error('Endpoint returned success but backend item inventory was not updated');
            validationErr.validation = validation;
            throw validationErr;
          }
          return {
            success: true,
            itemId,
            inventoryId,
            endpoint: candidate.method + ' ' + candidate.url,
            result,
            validation
          };
        }))
      .catch(err => {
        failures.push({
          endpoint: candidate.method + ' ' + candidate.url,
          statusCode: err && err.statusCode || '',
          message: err && err.message || String(err || ''),
          validation: err && err.validation || undefined
        });
        return tryAt(index + 1);
      });
  }

  return tryAt(0);
}

function syncOrderItemsInventory(orderId, orderNo, data = {}) {
  const items = pickOrderItemsForSnDebug(data).filter(item =>
    getComparableItemValue(item, ['itemId', 'item_id', 'orderItemId', 'order_item_id', 'ITEM_ID', '_id', 'id']) &&
    getComparableItemValue(item, ['inventoryId', 'inventory_id', 'INVENTORY_ID', 'snId', 'sn_id', 'inventorySnId', 'inventory_sn_id'])
  );
  if (!orderId || !items.length) return Promise.resolve([]);

  return syncOrderItemsByRepairFunction(orderId, orderNo, items)
    .then(repairResult => {
      if (repairResult && repairResult.success) {
        return [repairResult];
      }
      return items.reduce((promise, item) => {
        return promise.then(results => syncSingleOrderItemInventory(orderId, orderNo, item)
          .then(result => results.concat(result)));
      }, Promise.resolve([])).then(results => {
        return [repairResult].concat(results);
      });
    });
}

function syncOrderItemsByRepairFunction(orderId, orderNo, items = []) {
  if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) {
    return Promise.resolve({ success: false, endpoint: 'cloudFunction orderItemRepair', message: 'wx.cloud.callFunction unavailable' });
  }

  return wx.cloud.callFunction({
    name: 'orderItemRepair',
    data: {
      action: 'updateOrderItems',
      data: {
        orderId,
        order_id: orderId,
        ORDER_ID: orderId,
        orderNo,
        order_no: orderNo,
        ORDER_NO: orderNo,
        items: mapSalesItems(items)
      }
    }
  }).then(res => {
    const result = res && (res.result || res);
    if (!result || result.code !== 0) {
      return {
        success: false,
        endpoint: 'cloudFunction orderItemRepair',
        message: result && result.message || 'orderItemRepair failed',
        result
      };
    }
    return validateOrderItemsInventorySynced(orderId, items)
      .then(validation => ({
        success: validation.synced,
        endpoint: 'cloudFunction orderItemRepair',
        result,
        validation
      }));
  }).catch(err => ({
    success: false,
    endpoint: 'cloudFunction orderItemRepair',
    message: err && err.message || String(err || '')
  }));
}

function validateOrderItemsInventorySynced(orderId, items = []) {
  return api.order.getDetails(orderId).then(detailOrder => {
    const rows = pickOrderItemsForSnDebug(detailOrder);
    const checks = items.map(item => {
      const itemId = getComparableItemValue(item, ['itemId', 'item_id', 'orderItemId', 'order_item_id', 'ITEM_ID', '_id', 'id']);
      const expectedInventoryId = getComparableItemValue(item, ['inventoryId', 'inventory_id', 'INVENTORY_ID', 'snId', 'sn_id', 'inventorySnId', 'inventory_sn_id']);
      const matched = rows.find(row => String(getComparableItemValue(row, ['itemId', 'item_id', '_id', 'id'])) === String(itemId));
      const backendInventoryId = matched ? getComparableItemValue(matched, ['inventoryId', 'inventory_id', 'INVENTORY_ID', 'snId', 'sn_id', 'inventorySnId', 'inventory_sn_id']) : '';
      return {
        itemId,
        expectedInventoryId,
        backendInventoryId,
        synced: expectedInventoryId && backendInventoryId === expectedInventoryId
      };
    });
    return {
      synced: checks.every(item => item.synced),
      checks,
      backendRows: mapOrderSnDebugRows(rows)
    };
  });
}

function mapSalesItems(items = []) {
  return (items || []).filter(item => !isEmptyOrderItem(item)).map(item => {
  const normalized = normalizeOrderItem(item);
    const itemId = normalized.itemId;
    const salePrice = normalized.unitPrice;
    const quantity = normalizeQuantity(normalized.quantity);
    const productName = normalized.productName;
    const pnCode = normalized.pnCode;
    const snCode = normalized.snCode;
    const productId = normalized.productId;
    const mtmCode = normalized.mtmCode;
    const needSn = normalized.needSn;
    // SN 文本不能充当库存记录 ID。新建订单允许录入尚不存在的 SN，
    // 真实库存 ID 仅在归档校验成功后由归档流程补充。
    const inventoryId = normalized.inventoryId;
    const previousSnStatus = normalized.previousSnStatus || normalized.inventoryStatus || '';
    const subtotal = normalizeMoney(normalized.subtotal);

    // 应用层只保留驼峰字段；以下少量下划线字段是 MySQL/历史 HTTP 接口边界字段。
    return {
      ...normalized,
      itemId,
      item_id: itemId,
      productId,
      product_id: productId,
      productName,
      product_name: productName,
      pnCode,
      mtmCode,
      mtm_code: mtmCode,
      needSn,
      need_sn: needSn,
      inventoryId,
      inventory_id: inventoryId,
      snId: inventoryId,
      sn_id: inventoryId,
      snCode,
      sn_code: snCode,
      previousSnStatus,
      previous_sn_status: previousSnStatus,
      unitPrice: salePrice,
      unit_price: salePrice,
      standardPrice: normalized.standardPrice,
      standard_price: normalized.standardPrice,
      minSalePrice: normalized.minSalePrice,
      min_sale_price: normalized.minSalePrice,
      quantity,
      subtotal,
      costPrice: normalized.costPrice,
      cost_price: normalized.costPrice,
      imei1: normalized.imei1,
      imei2: normalized.imei2,
      customerSource: normalized.customerSource,
      customerSourceDetail: normalized.customerSourceDetail
    };
  });
}

function mapArchiveItems(items = []) {
  return mapSalesItems(items).map(item => ({
    ...item,
    pnCode: normalizePnCode(item.pnCode)
  }));
}

function mapSalesPayments(payments = []) {
  return (payments || []).map(payment => {
    const method = payment.method || payment.paymentType || payment.type || payment.payment_method || '';
    return Object.assign({}, payment, {
      method,
      type: method,
      paymentType: method,
      payment_method: method,
      amount: Number(payment.amount || 0),
      depositId: payment.depositId || payment.deposit_id || '',
      deposit_id: payment.depositId || payment.deposit_id || '',
      depositNo: payment.depositNo || payment.deposit_no || '',
      deposit_no: payment.depositNo || payment.deposit_no || ''
    });
  });
}

function normalizeCustomerSource(row) {
  const sourceId = row.source_id || row.sourceId || row._id || row.id || '';
  const parentId = row.parent_id || row.parentId || '';
  return {
    _id: sourceId,
    id: sourceId,
    sourceId,
    name: row.name || '',
    parentId,
    parentName: row.parent_name || row.parentName || '',
    level: Number(row.level || (parentId ? 2 : 1)),
    sortOrder: row.sort_order || row.sortOrder || 0,
    children: (row.children || []).map(normalizeCustomerSource)
  };
}

function flattenCustomerSources(rows) {
  const result = [];
  (rows || []).forEach(row => {
    const normalized = normalizeCustomerSource(row);
    const children = normalized.children || [];
    result.push(Object.assign({}, normalized, { children }));
    children.forEach(child => {
      result.push(Object.assign({}, child, {
        parentId: child.parentId || normalized._id,
        parentName: child.parentName || normalized.name
      }));
    });
  });
  return result;
}

function mergeProducts() {
  const map = new Map();
  Array.prototype.slice.call(arguments).forEach(list => {
    (list || []).forEach(row => {
      const item = normalizeProduct(row);
      const key = [
        item.productId || '',
        item.pnCode || '',
        item.snCode || '',
        item.name || ''
      ].join('|');
      // normalizeProduct 已统一为 productId；旧的 product_id 判断会把所有
      // 新接口返回的商品都过滤掉，导致采购申请里始终搜不到商品。
      if ((item.productId || item.pnCode || item.snCode || item.name) && !map.has(key)) {
        map.set(key, item);
      }
    });
  });
  return Array.from(map.values());
}

function enrichProductsWithPn(products, storeId = '') {
  const list = (products || []).map(normalizeProduct);
  const targets = list.filter(item => item.productId && !item.pnCode).slice(0, 100);
  if (!targets.length) return Promise.resolve(list);

  const tasks = targets.map(item => {
    return http.request('/product/pn-list' + toQuery({ productId: item.productId, storeId, page: 1, pageSize: 5 }))
      .then(result => {
        const pnRows = getListPayload(result);
        const firstPn = pnRows[0] ? normalizeProduct(pnRows[0]).pnCode : '';
        if (firstPn) {
          item.pnCode = firstPn;
        }
      })
      .catch(() => null);
  });

  return Promise.all(tasks).then(() => list);
}

function searchProductsWithFallback(keyword, params = {}) {
  const query = String(keyword || '').trim();
  if (!query) return api.product.list(params);
  const queryParams = Object.assign({ keyword: query, page: 1, pageSize: 50 }, params);
  const productSearch = http.request('/product/search' + toQuery(queryParams))
    .then(result => getListPayload(result))
    .catch(() => []);
  const productList = http.request('/product/list' + toQuery(queryParams))
    .then(result => getListPayload(result))
    .catch(() => []);
  const pnList = http.request('/product/pn-list' + toQuery(queryParams))
    .then(result => getListPayload(result))
    .catch(() => []);

  return Promise.all([productSearch, productList, pnList]).then(results => {
    const merged = mergeProducts(results[0], results[1], results[2]);
    return enrichProductsWithPn(merged, params.storeId || '');
  });
}

function normalizePaymentMethod(row) {
  return {
    _id: row.method_id || row._id,
    id: row.method_id || row.id,
    methodId: row.method_id || row.methodId,
    name: row.name || '',
    code: row.code || '',
    defaultTaxRate: Number(row.default_tax_rate !== undefined ? row.default_tax_rate : (row.defaultTaxRate || 0)),
    sortOrder: row.sort_order || row.sortOrder || 0,
    isGlobal: row.is_global === 1 || row.isGlobal === true,
    status: row.status
  };
}

function normalizeDeposit(row) {
  const amount = Number(row.amount || 0);
  const reservedAmount = Number(
    row.reserved_amount !== undefined ? row.reserved_amount : (row.reservedAmount || 0)
  );
  const redeemedAmount = Number(
    row.redeemed_amount !== undefined ? row.redeemed_amount : (row.redeemedAmount || 0)
  );
  const refundedAmount = Number(
    row.refunded_amount !== undefined ? row.refunded_amount : (row.refundedAmount || 0)
  );
  const availableAmount = Number(
    row.available_amount !== undefined
      ? row.available_amount
      : (row.availableAmount !== undefined
        ? row.availableAmount
        : (amount - reservedAmount - redeemedAmount - refundedAmount))
  );
  return {
    ...row,
    _id: row.deposit_id || row.depositId || row._id || '',
    depositId: row.deposit_id || row.depositId || row._id || '',
    depositNo: row.deposit_no || row.depositNo || '',
    storeId: row.store_id || row.storeId || '',
    storeName: row.store_name || row.storeName || row.Store?.name || '',
    customerName: row.customer_name || row.customerName || '',
    customerPhone: row.customer_phone || row.customerPhone || '',
    amount,
    reservedAmount,
    availableAmount,
    paymentMethod: row.payment_method || row.paymentMethod || '',
    payment_method: row.payment_method || row.paymentMethod || '',
    status: row.status || '',
    createUser: row.create_user || row.createUser || '',
    createTime: row.create_time || row.createTime || '',
    archiveTime: row.archive_time || row.archiveTime || '',
    remark: row.remark || ''
  };
}

function assertDepositApiResult(result) {
  if (typeof result === 'string' && /<!doctype html|<html/i.test(result)) {
    const err = new Error('Deposit API returned HTML; backend route /sales/deposits/available is missing');
    err.code = 'DEPOSIT_API_NOT_DEPLOYED';
    throw err;
  }
  return result;
}

function getDepositAvailableAmount(row) {
  if (!row) return 0;
  if (row.availableAmount !== undefined) return Number(row.availableAmount || 0);
  if (row.available_amount !== undefined) return Number(row.available_amount || 0);
  const amount = Number(row.amount || 0);
  const reservedAmount = Number(
    row.reserved_amount !== undefined ? row.reserved_amount : (row.reservedAmount || 0)
  );
  const redeemedAmount = Number(
    row.redeemed_amount !== undefined ? row.redeemed_amount : (row.redeemedAmount || 0)
  );
  const refundedAmount = Number(
    row.refunded_amount !== undefined ? row.refunded_amount : (row.refundedAmount || 0)
  );
  return amount - reservedAmount - redeemedAmount - refundedAmount;
}

function isAvailableDeposit(row) {
  const status = String(row && row.status || '').toLowerCase();
  const availableAmount = getDepositAvailableAmount(row);

  if (availableAmount <= 0) return false;
  if (!status) return true;
  return status === 'submitted' || status === 'archived' || status === 'available';
}

function mergeAvailableDeposits() {
  const merged = [];
  const seen = {};
  Array.prototype.slice.call(arguments).forEach(rows => {
    (rows || []).forEach(row => {
      const normalized = normalizeDeposit(row);
      if (!isAvailableDeposit(normalized)) return;
      const key = normalized.depositId || normalized.depositNo;
      if (key && seen[key]) return;
      if (key) seen[key] = true;
      merged.push(normalized);
    });
  });
  return merged.sort((a, b) => {
    return new Date(b.createTime || 0).getTime() - new Date(a.createTime || 0).getTime();
  });
}

function buildAvailableDepositFallbackParams(params) {
  return Object.assign({}, params, {
    // 不限定 archived，兼容“提交即进入定金库”的 available 状态和历史 submitted 数据。
    status: params.status || '',
    page: params.page || 1,
    pageSize: params.pageSize || 100
  });
}

function normalizeDepositApiError(err) {
  const message = err && (err.message || err.errMsg || '');
  const bodyMessage = err && err.body && (err.body.message || err.body.error || '');
  if (err && err.statusCode === 404) {
    const next = new Error('定金服务尚未部署，请重新部署网页版后端服务');
    next.statusCode = 404;
    next.code = 'DEPOSIT_API_NOT_DEPLOYED';
    next.originalError = err;
    throw next;
  }
  throw err;
}

function normalizeSupplementItem(row) {
  return {
    _id: row.item_id || row._id,
    id: row.item_id || row.id,
    itemId: row.item_id || row.itemId,
    name: row.name || '',
    code: row.code || '',
    amount: Number(row.amount || 0),
    sortOrder: row.sort_order || row.sortOrder || 0,
    isActive: row.is_active !== 0 && row.isActive !== false,
    amountType: row.amount_type || row.amountType || 'increase'
  };
}

function normalizeTransfer(row) {
  const items = row.TransferItems || row.items || [];
  return {
    ...row,
    _id: row.transfer_id || row.transferId || row._id,
    transferId: row.transfer_id || row.transferId || row._id,
    transferNo: row.transfer_no || row.transferNo,
    fromStoreId: row.from_store_id || row.fromStoreId,
    fromStoreName: row.from_store_name || row.fromStoreName || row.FromStore?.name || '',
    toStoreId: row.to_store_id || row.toStoreId,
    toStoreName: row.to_store_name || row.toStoreName || row.ToStore?.name || '',
    totalQuantity: row.total_quantity || row.totalQuantity || 0,
    outboundQuantity: Number(row.outbound_quantity ?? row.outboundQuantity ?? 0),
    remainingQuantity: Number(row.remaining_quantity ?? row.remainingQuantity ?? 0),
    remainingStatus: row.remaining_status || row.remainingStatus || 'pending',
    status: row.status,
    applyUserId: row.apply_user_id || row.applyUserId || row.apply_user || row.applyUser,
    applyUser: row.apply_user || row.applyUser,
    applyUserName: row.apply_user_name || row.applyUserName || row.applyUser || '',
    shippingUser: row.shipping_user || row.shippingUser || '',
    receiveUser: row.receive_user || row.receiveUser || row.confirm_user || row.confirmUser || '',
    shippingPhotos: mergeArrayFields(
      row.shipping_photos, row.shippingPhotos, row.shipping_photo_ids, row.shippingPhotoIds,
      row.shipping_photo_urls, row.shippingPhotoUrls, row.outbound_photos, row.outboundPhotos
    ),
    receivingPhotos: mergeArrayFields(
      row.receiving_photos, row.receivingPhotos, row.receiving_photo_ids, row.receivingPhotoIds,
      row.receiving_photo_urls, row.receivingPhotoUrls, row.inbound_photos, row.inboundPhotos
    ),
    createTime: row.create_time || row.createTime,
    updateTime: row.update_time || row.updateTime,
    items: items.map(item => ({
      itemId: item.item_id || item.itemId || item.transfer_item_id || item.transferItemId || item.line_id || item.lineId || item._id || item.id || '',
      productId: item.product_id || item.productId,
      productCode: item.product_code || item.productCode || item.product_id || item.productId || '',
      productName: item.product_name || item.productName || '',
      inventoryId: item.inventory_id || item.inventoryId || item.sn_id || item.snId || '',
      snCode: normalizeSnCode(item.sn_code || item.snCode || ''),
      inventoryStatus: item.inventory_status || item.inventoryStatus || item.status || '',
      inventoryStatusLabel: item.inventory_status_label || item.inventoryStatusLabel || item.status_label || item.statusLabel || '',
      quantity: normalizeQuantity(item.quantity),
      needSn: item.need_sn === true || item.needSn === true || Number(item.need_sn) === 1 || Number(item.needSn) === 1,
       pnCode: normalizePnCode(item.pn_code || item.pnCode),
      requested: item.requested === true || item.requested === 1
    }))
  };
}

function purchaseInitiatorNameOf(row) {
  const purchaseRequest = row && (row.PurchaseRequest || row.purchaseRequest || row.purchase_request) || {};
  const purchaseRequester = purchaseRequest.applicant || purchaseRequest.Applicant ||
    purchaseRequest.requester || purchaseRequest.Requester || purchaseRequest.user || purchaseRequest.User || {};
  return row && (row.purchase_initiator_name || row.purchaseInitiatorName ||
    row.purchase_applicant_name || row.purchaseApplicantName || row.purchase_user_name || row.purchaseUserName ||
    row.purchase_request_create_user_name || row.purchaseRequestCreateUserName ||
    row.source_create_user_name || row.sourceCreateUserName || row.apply_user_name || row.applyUserName ||
    row.applicant_name || row.applicantName || row.apply_user || row.applyUser ||
    row.purchase_user || row.purchaseUser || row.requester_name || row.requesterName) ||
    purchaseRequest.apply_user_name || purchaseRequest.applyUserName || purchaseRequest.applicant_name ||
    purchaseRequest.applicantName || purchaseRequest.apply_user || purchaseRequest.applyUser ||
    purchaseRequest.requester_name || purchaseRequest.requesterName || purchaseRequester.name ||
    purchaseRequester.userName || purchaseRequester.user_name || '';
}

function normalizeInbound(row) {
  const items = row.items || row.InboundItems || [];
  // CREATE_USER 是入库单制单人，不能作为采购申请发起人兜底，否则会把入库操作人显示成采购发起人。
  const purchaseInitiatorName = purchaseInitiatorNameOf(row);
  return {
    ...row,
    _id: row.inbound_id || row.inboundId || row._id,
    inboundId: row.inbound_id || row.inboundId || row._id,
    inboundNo: row.inbound_no || row.inboundNo || '',
    storeId: row.store_id || row.storeId || '',
    storeName: row.store_name || row.storeName || row.Store?.name || '',
    sourceType: row.source_type || row.sourceType || '',
    sourceNo: row.source_no || row.sourceNo || '',
    itemsSummary: row.items_summary || row.itemsSummary || '',
    totalQuantity: Number(row.total_quantity || row.totalQuantity || 0),
    totalAmount: Number(row.total_amount || row.totalAmount || 0),
    status: row.status || '',
    createUser: row.create_user || row.createUser || '',
    receiveUser: row.receive_user || row.receiveUser || '',
    receiveTime: row.receive_time || row.receiveTime || '',
    purchaseInitiatorName,
    createTime: row.create_time || row.createTime || '',
    updateTime: row.update_time || row.updateTime || '',
    productPns: row.product_pns || row.productPns || {},
    items: items.map(item => ({
      ...item,
      itemId: item.item_id || item.itemId || item._id || '',
      productId: item.product_id || item.productId || '',
      productName: item.product_name || item.productName || '',
      pnCode: normalizePnCode(item.pnCode || item.pn_code || item.PN_CODE),
      snCode: item.sn_code || item.snCode || '',
      locationId: item.location_id || item.locationId || item.LOCATION_ID || '',
      unitPrice: Number(item.unit_price || item.unitPrice || 0),
      quantity: Number(item.quantity || 0),
      originalQuantity: Number(item.original_quantity ?? item.originalQuantity ?? item.quantity ?? 0),
      receivedQuantity: Number(item.received_quantity ?? item.receivedQuantity ?? 0),
      remainingQuantity: Number(item.remaining_quantity ?? item.remainingQuantity ?? item.quantity ?? 0),
      receiveUser: item.receive_user || item.receiveUser || '',
      receiveTime: item.receive_time || item.receiveTime || '',
      pns: Array.isArray(item.pns) ? item.pns : (Array.isArray(item.PNs) ? item.PNs : []),
      snCodes: Array.isArray(item.sn_codes || item.snCodes) ? (item.sn_codes || item.snCodes) : [],
      needSn: item.need_sn === true || item.needSn === true || Number(item.need_sn) === 1 || Number(item.needSn) === 1,
      inventoryType: item.inventory_type || item.inventoryType || 'normal_qty',
      remark: item.remark || ''
    }))
  };
}

function emptyCloudResult(data) {
  return { result: { code: 0, data } };
}

const api = {
  call(name, action, data = {}) {
    if (name === 'queryGoods' && action === 'searchGoodsByName') {
      return api.product.search(data.keywords || data.keyword || '', { page: 1, pageSize: data.limit || 100, storeId: data.storeId || '' })
        .then(rows => ({ result: { code: 0, data: rows } }));
    }
    if (name === 'queryGoods' && action === 'getGoodsBySN') {
      return api.inventory.getGoodsBySN(data.sn || data.snCode || data.SN || '')
        .then(row => ({ result: { code: 0, data: row } }));
    }
    if (name === 'queryGoods' && action === 'getGoodsByPN') {
      return api.inventory.getGoodsByPN(data.pnCode || '')
        .then(row => ({ result: { code: 0, data: row } }));
    }
    if (name === 'queryOrders' && action === 'getOrders') {
      return api.order.queryList(data).then(res => {
        const raw = res.raw || {};
        const pagination = raw.pagination || {};
        return {
          result: {
            code: 0,
            data: {
              list: res.data || [],
              total: pagination.total || (res.data || []).length,
              hasMore: pagination.page && pagination.totalPages ? pagination.page < pagination.totalPages : false
            }
          }
        };
      });
    }
    if (name === 'queryOrders' && action === 'getOrderByNo') {
      return api.order.queryList({ orderNo: data.orderNo, page: 1, pageSize: 1 })
        .then(res => {
          const summary = (res.data || [])[0] || null;
          if (!summary) {
            return { result: { code: 0, data: null } };
          }

          const orderId = summary.orderId || summary._id || summary.order_id || '';
          if (!orderId) {
            return { result: { code: 0, data: summary } };
          }

          return api.order.getDetails(orderId)
            .then(detail => ({
              result: {
                code: 0,
                data: Object.assign({}, summary, detail, {
                  customerSource: detail.customerSource || summary.customerSource || '',
                  customerSourceDetail: detail.customerSourceDetail || summary.customerSourceDetail || '',
                  auxiliarySalesList: detail.auxiliarySalesList && detail.auxiliarySalesList.length
                    ? detail.auxiliarySalesList
                    : (summary.auxiliarySalesList || []),
                  subsidyPhotos: detail.subsidyPhotos && detail.subsidyPhotos.length
                    ? detail.subsidyPhotos
                    : (summary.subsidyPhotos || []),
                  productPhotoUrls: detail.productPhotoUrls && detail.productPhotoUrls.length
                    ? detail.productPhotoUrls
                    : (summary.productPhotoUrls || []),
                  educationSubsidyPhotoUrl: detail.educationSubsidyPhotoUrl || summary.educationSubsidyPhotoUrl || '',
                  personalInfoPhoto: detail.personalInfoPhoto || summary.personalInfoPhoto || ''
                })
              }
            }))
            .catch(err => {
              console.warn('获取订单完整详情失败，使用列表数据兜底:', err);
              return { result: { code: 0, data: summary } };
            });
        });
    }
    if (name === 'queryOrders' && action === 'getGuanghuanStats') {
      return api.report.sales(data).then(res => ({ result: { code: 0, data: res } }));
    }
    if (name === 'queryOrders' && action === 'updateOrderStatus') {
      if (data.status === '已归档') {
        const rawArchiveItems = data.items || data.goods || [];
        const archiveItems = mapArchiveItems(rawArchiveItems);
        const archivePayload = {
          // 审批判断由 ANY-ERP 根据归档前最终毛利统一执行。
          order_status: '已归档',
          status: '已归档',
          order_no: data.orderNo || data.order_no || '',
          deposit_action: 'redeem',
          deposit_items: data.depositItems || data.deposit_items || data.deposits || [],
          items: archiveItems,
          goods: archiveItems,
          invoice_status: data.invoiceStatus || data.invoice_status || '',
          invoice_info: data.invoiceInfo || data.invoice_info || '',
          invoice_amount: data.invoiceAmount || data.invoice_amount || ''
        };
        console.log('归档提交商品字段:', archivePayload.items.map(item => ({
          itemId: item.itemId,
          productId: item.productId,
          pnCode: item.pnCode,
          inventoryId: item.inventoryId,
          snCode: item.snCode
        })));
        const orderId = data.orderId || data.order_id || '';
        const archiveRequest = orderId
          ? api.order.archive(orderId, archivePayload)
          : api.order.archiveByOrderNo(data.orderNo, archivePayload);
        return archiveRequest
          .then(response => ({ result: {
            code: 0,
            data: response && response.data !== undefined ? response.data : response,
            message: response?.message || ''
          } }))
          .catch(err => {
            console.error('归档接口返回错误:', {
              statusCode: err && err.statusCode,
              message: err && err.message,
              body: err && err.body,
              items: archivePayload.items.map(item => ({
                productId: item.productId,
                pnCode: item.pnCode,
                snCode: item.snCode
              }))
            });
            throw err;
          });
      }

      const statusPayload = { order_status: data.status, status: data.status };
      statusPayload.orderNo = data.orderNo || data.order_no || '';
      statusPayload.order_no = data.orderNo || data.order_no || '';
      statusPayload.depositAction = data.status === '已作废' ? 'release' : '';
      statusPayload.deposit_action = statusPayload.depositAction;
      statusPayload.depositItems = data.depositItems || data.deposit_items || data.deposits || [];
      statusPayload.deposit_items = statusPayload.depositItems;
      if (data.snStatusAction !== undefined) statusPayload.snStatusAction = data.snStatusAction;
      if (data.targetSnStatus !== undefined) statusPayload.targetSnStatus = data.targetSnStatus;
      if (data.previousSnStatus !== undefined) statusPayload.previousSnStatus = data.previousSnStatus;
      if (data.inventoryStatusAction !== undefined) statusPayload.inventoryStatusAction = data.inventoryStatusAction;
      if (data.targetInventoryStatus !== undefined) statusPayload.targetInventoryStatus = data.targetInventoryStatus;
      if (data.previousInventoryStatus !== undefined) statusPayload.previousInventoryStatus = data.previousInventoryStatus;
      if (data.restorePreviousSnStatus !== undefined) statusPayload.restorePreviousSnStatus = data.restorePreviousSnStatus;
      if (data.restoreOriginalInventory !== undefined) statusPayload.restoreOriginalInventory = data.restoreOriginalInventory;
      if (data.voidReason !== undefined) statusPayload.voidReason = data.voidReason;
      if (data.grossProfit !== undefined) {
        statusPayload.grossProfit = Number(data.grossProfit);
        statusPayload.gross_profit = Number(data.grossProfit);
      }
      if (data.costTotal !== undefined) {
        statusPayload.costTotal = Number(data.costTotal);
        statusPayload.cost_total = Number(data.costTotal);
      }
      if (data.pricingTotal !== undefined) {
        statusPayload.pricingTotal = Number(data.pricingTotal);
        statusPayload.pricing_total = Number(data.pricingTotal);
      }
      if (data.minimumSalePriceTotal !== undefined) {
        statusPayload.minimumSalePriceTotal = Number(data.minimumSalePriceTotal);
        statusPayload.minimum_sale_price_total = Number(data.minimumSalePriceTotal);
      }
      if (data.requiresGrossProfitApproval !== undefined) {
        statusPayload.requiresGrossProfitApproval = !!data.requiresGrossProfitApproval;
        statusPayload.requires_gross_profit_approval = !!data.requiresGrossProfitApproval;
      }
      if (data.approvalType !== undefined) {
        statusPayload.approvalType = data.approvalType;
        statusPayload.approval_type = data.approvalType;
      }
      if ((data.items && data.items.length) || (data.goods && data.goods.length)) {
        const itemsPayload = pickItemsPayload(data);
        Object.assign(statusPayload, itemsPayload);
      }
      if (data.invoiceStatus !== undefined || data.invoice_status !== undefined || data.invoiceInfo !== undefined || data.invoice_info !== undefined || data.invoiceAmount !== undefined || data.invoice_amount !== undefined) {
        const invoicePayload = pickInvoicePayload({
          invoiceStatus: data.invoiceStatus || data.invoice_status || '',
          invoiceInfo: data.invoiceInfo || data.invoice_info || '',
          invoiceAmount: data.invoiceAmount || data.invoice_amount || ''
        });
        Object.assign(statusPayload, invoicePayload);
      }
      return api.order.updateByOrderNo(data.orderNo, statusPayload)
        .then(() => ({ result: { code: 0, data: true } }));
    }
    if (name === 'queryOrders' && action === 'reportOrderToMall') {
      return api.order.updateByOrderNo(data.orderNo, { mall_report_status: data.status || 'reported' })
        .then(() => ({ result: { code: 0, data: true } }));
    }
    if (name === 'queryOrders' && action === 'updateInvoiceInfo') {
      return api.order.updateByOrderNo(data.orderNo, pickInvoicePayload(data))
        .then(() => ({ result: { code: 0, data: true } }));
    }
    if (name === 'queryOrders' && (action === 'deleteSupplement' || action === 'updateOrderSupplement' || action === 'updateOrderRemark')) {
      const payload = Object.assign({}, data);
      delete payload.orderNo;
      return api.order.updateByOrderNo(data.orderNo, payload)
        .then(() => ({ result: { code: 0, data: true } }));
    }
    if (name === 'updateOrder') {
      const payload = data.updateData || data.orderData || data;
      return api.order.updateByOrderNo(data.orderNo, payload)
        .then(() => {
          if ((payload.items && payload.items.length) || (payload.goods && payload.goods.length)) {
            return api.order.updateByOrderNo(data.orderNo, pickItemsPayload(payload));
          }
          return null;
        })
        .then(() => {
          if (payload.invoiceStatus !== undefined || payload.invoiceInfo !== undefined || payload.invoiceAmount !== undefined) {
            return api.order.updateByOrderNo(data.orderNo, pickInvoicePayload(payload));
          }
          return null;
        })
        .then(() => ({ result: { code: 0, data: true } }));
    }
    if (name === 'updateOrderRemark') {
      return api.order.updateByOrderNo(data.orderNo, { remark: data.remark || '' })
        .then(() => ({ result: { code: 0, success: true, data: true } }));
    }
    if (name === 'getDailySummary') {
      return api.report.dailySummary(data).then(res => ({ result: { code: 0, data: res } }));
    }
    if (name === 'exportOrders') {
      if (action === 'getMyExportTasks') return Promise.resolve(emptyCloudResult([]));
      return Promise.resolve({
        result: {
          code: 400,
          message: '导出任务已禁用，需要迁移为 MySQL 后端导出接口'
        }
      });
    }
    return Promise.reject(new Error('Unsupported API call: ' + name + '/' + action));
  },

  auth: {
    login(phoneNumber, password) {
      return http.request({
        url: '/auth/login',
        method: 'POST',
        auth: false,
        timeout: 15000,
        retries: 1,
        retryDelay: 1000,
        data: { phone: phoneNumber, password }
      }).then(result => {
        const token = result.token || result.accessToken || '';
        if (token) http.setToken(token);
        return normalizeUser(result.userInfo || result.user || {});
      });
    },
    getProfile() {
      return http.request('/auth/userinfo').then(normalizeUser);
    },
    changePassword(oldPassword, newPassword) {
      return http.request({
        url: '/auth/changePassword',
        method: 'POST',
        data: { oldPassword, newPassword }
      });
    },
    logout() {
      http.clearToken();
      return Promise.resolve();
    }
  },

  inventory: {
    list(params = {}) {
      return http.request('/inventory/list' + toQuery(Object.assign({ page: 1, pageSize: 100 }, params)))
        .then(result => ({
          code: 200,
          data: getListPayload(result).map(normalizeProduct),
          total: Number(result?.total || result?.pagination?.total || 0),
          pagination: result?.pagination || {
            total: Number(result?.total || 0),
            page: Number(result?.page || params.page || 1),
            pageSize: Number(result?.pageSize || params.pageSize || 100),
            totalPages: Number(result?.totalPages || 0)
          },
          raw: result
        }));
    },
    productOrders(productId) {
      if (!productId) return Promise.reject(new Error('商品ID不能为空'));
      return http.request('/sales/product-orders/' + encodeURIComponent(productId))
        .then(result => {
          // 兼容直返 data、网关包裹 data 以及云容器再次包裹 code/data 的响应格式。
          let payload = result || {};
          for (let index = 0; index < 3; index += 1) {
            if (payload && (payload.code === 0 || payload.code === 200) && payload.data !== undefined) {
              payload = payload.data;
              continue;
            }
            if (payload && payload.data && !Array.isArray(payload.data) &&
              (payload.data.orders || payload.data.product || payload.data.code !== undefined)) {
              payload = payload.data;
              continue;
            }
            break;
          }
          const orders = Array.isArray(payload.orders)
            ? payload.orders
            : (Array.isArray(payload.data) ? payload.data : []);
          return {
          code: 200,
          product: payload.product || null,
          data: orders,
          raw: result
          };
        });
    },
    getGoodsByPNDetailed(pn, storeId = '') {
      const keyword = String(pn || '').trim();
      const normalizedKeyword = keyword.toLowerCase();
      const diagnostics = { keyword, storeId: storeId || '', attempts: [], candidatePns: [] };
      if (!keyword) return Promise.resolve({ product: null, diagnostics });

      const splitPnValues = value => String(value || '')
        .split(/[,\s]+/)
        .map(code => code.trim().toLowerCase())
        .filter(Boolean);
      const getItemPnCodes = item => [
        item && item.pnCode,
        ...(Array.isArray(item && item.pnOptions) ? item.pnOptions : [])
      ].reduce((codes, value) => codes.concat(splitPnValues(value)), []);
      const getRows = result => {
        const rows = getListPayload(result);
        if (rows.length) return rows;
        const single = result && result.data && !Array.isArray(result.data) ? result.data : result;
        return single && typeof single === 'object' && !single.code && !single.message ? [single] : [];
      };
      const requestCandidate = (source, queryStoreId, path) => http.request(path)
        .then(result => {
          const list = getRows(result).map(normalizeProduct);
          const candidatePns = [];
          list.forEach(item => getItemPnCodes(item).forEach(code => {
            if (candidatePns.indexOf(code) < 0) candidatePns.push(code);
            if (diagnostics.candidatePns.indexOf(code) < 0) diagnostics.candidatePns.push(code);
          }));
          diagnostics.attempts.push({ source, storeId: queryStoreId || '', rowCount: list.length, candidatePns: candidatePns.slice(0, 20) });
          const matched = list.find(item => getItemPnCodes(item).includes(normalizedKeyword));
          return matched ? Object.assign({}, matched, { pnCode: normalizePnCode(keyword) }) : null;
        })
        .catch(err => {
          diagnostics.attempts.push({
            source,
            storeId: queryStoreId || '',
            error: err && (err.message || err.errMsg || '接口请求失败'),
            statusCode: err && err.statusCode
          });
          return null;
        });
      const attempts = [];
      const addAttempts = queryStoreId => {
        attempts.push(() => requestCandidate(
          queryStoreId ? 'product/pn-list(store)' : 'product/pn-list(global)', queryStoreId,
          '/product/pn-list' + toQuery({ keyword, storeId: queryStoreId, page: 1, pageSize: 20 })
        ));
        attempts.push(() => requestCandidate(
          queryStoreId ? 'product/search(store)' : 'product/search(global)', queryStoreId,
          '/product/search' + toQuery({ keyword, storeId: queryStoreId, page: 1, pageSize: 20 })
        ));
        attempts.push(() => requestCandidate(
          queryStoreId ? 'product/list(store)' : 'product/list(global)', queryStoreId,
          '/product/list' + toQuery({ keyword, storeId: queryStoreId, page: 1, pageSize: 20 })
        ));
      };
      addAttempts(storeId);
      if (storeId) addAttempts('');
      return attempts.reduce((promise, request) => promise.then(result => result || request()), Promise.resolve(null))
        .then(product => ({ product, diagnostics }));
    },
    getGoodsByPN(pn, storeId = '') {
      const keyword = String(pn || '').trim();
      if (!keyword) return Promise.resolve(null);
      const normalizedKeyword = keyword.toLowerCase();
      const splitPnValues = value => String(value || '')
        .split(/[,\s，、;；]+/)
        .map(code => code.trim().toLowerCase())
        .filter(Boolean);
      const getItemPnCodes = item => [
        item && item.pnCode,
        ...(Array.isArray(item && item.pnOptions) ? item.pnOptions : [])
      ].reduce((codes, value) => codes.concat(splitPnValues(value)), []);
      const findExactPn = result => {
        const list = getListPayload(result).map(normalizeProduct);
        const matched = list.find(item => getItemPnCodes(item).includes(normalizedKeyword));
        if (!matched) return null;
        // 后续归档校验使用精确命中的 PN，避免 manufacturer_code 中包含多个编码时误比对整串文本。
        return Object.assign({}, matched, { pnCode: normalizePnCode(keyword) });
      };
      const requests = [
        '/product/pn-list' + toQuery({ keyword, storeId, page: 1, pageSize: 20 }),
        // PN主表没有记录时，搜索接口仍会从在库SN的PN快照中返回商品，兼容历史PN数据。
        '/product/search' + toQuery({ keyword, storeId, page: 1, pageSize: 20 }),
        '/product/list' + toQuery({ keyword, storeId, page: 1, pageSize: 20 })
      ];
      const tryNext = index => {
        if (index >= requests.length) return Promise.resolve(null);
        return http.request(requests[index])
          .then(findExactPn)
          .then(product => product || tryNext(index + 1))
          .catch(() => tryNext(index + 1));
      };
      return tryNext(0);
    },
    getGoodsBySNDetailed(sn, storeId = '', productId = '') {
      const keyword = String(sn || '').trim();
      const diagnostics = { keyword, storeId: storeId || '', productId: productId || '', attempts: [], candidates: [] };
      if (!keyword) return Promise.resolve({ product: null, diagnostics });
      const requestCandidate = (source, queryStoreId, status) => http.request('/inventory/sn-list' + toQuery({
        snCode: keyword,
        storeId: queryStoreId,
        productId,
        status,
        page: 1,
        pageSize: 10
      })).then(result => {
        const list = getListPayload(result).map(normalizeProduct);
        const candidates = list.map(item => ({
          snCode: item.snCode || '',
          pnCode: item.pnCode || '',
          status: item.status || item.inventoryStatus || '',
          storeId: item.storeId || ''
        }));
        diagnostics.candidates = diagnostics.candidates.concat(candidates).slice(0, 20);
        diagnostics.attempts.push({ source, storeId: queryStoreId || '', status: status || 'all', rowCount: list.length });
        const matched = list.find(item => String(item.snCode || '').trim().toLowerCase() === keyword.toLowerCase());
        return matched || null;
      }).catch(err => {
        diagnostics.attempts.push({
          source,
          storeId: queryStoreId || '',
          status: status || 'all',
          error: err && (err.message || err.errMsg || '接口请求失败'),
          statusCode: err && err.statusCode
        });
        return null;
      });
      const attempts = [
        () => requestCandidate('inventory/sn-list(store,in_stock)', storeId, 'in_stock'),
        () => requestCandidate('inventory/sn-list(store,all)', storeId, '')
      ];
      if (storeId) {
        attempts.push(() => requestCandidate('inventory/sn-list(global,in_stock)', '', 'in_stock'));
        attempts.push(() => requestCandidate('inventory/sn-list(global,all)', '', ''));
      }
      return attempts.reduce((promise, request) => promise.then(result => result || request()), Promise.resolve(null))
        .then(product => ({ product, diagnostics }));
    },
    getGoodsBySN(sn, storeId = '', productId = '', params = {}) {
      const keyword = String(sn || '').trim();
      if (!keyword) return Promise.resolve(null);

      const findMatch = result => {
        const list = getListPayload(result).map(normalizeProduct);
        return list.find(item => String(item.snCode || '').toLowerCase() === keyword.toLowerCase()) || null;
      };

      const requestSnList = queryParams => http.request('/inventory/sn-list' + toQuery(Object.assign({
        snCode: keyword,
        storeId,
        productId,
        page: 1,
        pageSize: 10
      }, params, queryParams))).then(findMatch);

      return requestSnList({ status: 'in_stock' })
        .then(item => item || requestSnList({}))
        .catch(() => requestSnList({}));
    },
    searchByName(keyword) {
      return api.product.search(keyword, { page: 1, pageSize: 50 });
    },
    getByStore(storeId) {
      return http.request('/inventory/list' + toQuery({ storeId, page: 1, pageSize: 100 }))
        .then(result => ({ code: 200, data: getListPayload(result).map(normalizeProduct) }));
    },
    getSnList(params = {}) {
      return http.request('/inventory/sn-list' + toQuery(Object.assign({ page: 1, pageSize: 100 }, params)))
        .then(result => {
          const payload = result || {};
          const nestedPayload = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
            ? payload.data
            : {};
          return {
            code: 200,
            data: getListPayload(payload).map(normalizeSnInventoryRow),
            pagination: payload.pagination || nestedPayload.pagination || payload.pageInfo || nestedPayload.pageInfo || {},
            raw: result
          };
        });
    },
    getSnInventoryList(params = {}) {
      return http.request('/inventory/sn-inventory-list' + toQuery(Object.assign({ page: 1, pageSize: 100 }, params)))
        .then(result => ({ code: 200, data: getListPayload(result).map(normalizeSnInventoryRow), raw: result }));
    },
    getProductSns(productId, storeId = '') {
      if (!productId) return Promise.reject(new Error('商品ID不能为空'));
      return api.inventory.getSnList({
        productId,
        storeId,
        page: 1,
        pageSize: 100
      });
    },
    inboundList(params = {}) {
      return http.request('/inventory/inbound-list' + toQuery(Object.assign({ page: 1, pageSize: 20 }, params)))
        .then(result => ({
          code: 200,
          data: getListPayload(result).map(normalizeInbound),
          pagination: result && (result.pagination || result.pageInfo) || {},
          raw: result
        }));
    },
    inboundDetail(inboundId) {
      return http.request('/inventory/inbound-detail/' + encodeURIComponent(inboundId))
        .then(normalizeInbound);
    },
    executeInbound(data) {
      const payload = Object.assign({}, data);
      if (Array.isArray(payload.items)) {
        payload.items = payload.items.map(item => Object.assign({}, item, {
          pnCode: normalizePnCode(readExternalPnCode(item))
        }));
      }
      return http.request({ url: '/inventory/execute-inbound', method: 'POST', data: payload });
    },
    returnList(params = {}) {
      return http.request('/inventory/return-list' + toQuery(Object.assign({ page: 1, pageSize: 100 }, params)))
        .then(result => ({
          code: 200,
          data: getListPayload(result),
          pagination: result && (result.pagination || result.pageInfo) || {},
          raw: result
        }));
    },
    approveReturn(data) {
      return http.request({ url: '/inventory/approve-return', method: 'POST', data });
    },
    resourceClaimList(params = {}) {
      return http.request('/inventory/resource-rights/changes' + toQuery(Object.assign({
        approvalStatus: 'pending_finance',
        page: 1,
        pageSize: 100
      }, params))).then(result => ({
        code: 200,
        data: getListPayload(result),
        pagination: result && (result.pagination || result.pageInfo) || {},
        raw: result
      }));
    },
    resourceRights(params = {}) {
      return http.request('/inventory/resource-rights' + toQuery(Object.assign({ page: 1, pageSize: 100 }, params))).then(result => ({
        code: 200,
        data: getListPayload(result),
        pagination: result && (result.pagination || result.pageInfo) || {},
        raw: result
      }));
    },
    snResourceRights(snId) {
      return http.request('/inventory/sn/' + encodeURIComponent(snId) + '/resource-rights');
    },
    reviewResourceClaim(changeId, data) {
      return http.request({
        url: '/inventory/resource-rights/claim/' + encodeURIComponent(changeId) + '/review',
        method: 'POST',
        data
      });
    },
    transfer(data) {
      const payload = Object.assign({}, data);
      const normalizeItems = items => Array.isArray(items)
        ? items.map(item => Object.assign({}, item, { pnCode: normalizePnCode(readExternalPnCode(item)) }))
        : items;
      payload.items = normalizeItems(payload.items);
      payload.requestedItems = normalizeItems(payload.requestedItems);
      return http.request({
        url: '/inventory/transfer',
        method: 'POST',
        data: Object.assign({ scope: 'transfer' }, payload)
      });
    },
    transferList(params = {}) {
      return http.request('/inventory/transfer-list' + toQuery(Object.assign({ page: 1, pageSize: 50 }, params)))
        .then(result => ({ code: 200, data: getListPayload(result).map(normalizeTransfer), raw: result }));
    },
    transferDetail(transferId) {
      return http.request('/inventory/transfer/' + encodeURIComponent(transferId));
    },
    confirmTransferOut(transferId, data = {}) {
      const payload = Object.assign({}, data, {
        items: Array.isArray(data.items)
          ? data.items.map(item => Object.assign({}, item, { pnCode: normalizePnCode(readExternalPnCode(item)) }))
          : data.items
      });
      return http.request({
        url: '/inventory/transfer/confirm-out',
        method: 'POST',
        data: Object.assign({ transferId, scope: 'transfer' }, payload)
      });
    },
    confirmTransferIn(transferId, data = {}) {
      return http.request({
        url: '/inventory/transfer/confirm-in',
        method: 'POST',
        data: Object.assign({ transferId, scope: 'transfer' }, data)
      });
    },
    revokeTransfer(transferId, data = {}) {
      if (!transferId) return Promise.reject(new Error('调拨单ID不能为空'));
      return http.request({
        url: '/inventory/transfer/revoke',
        method: 'POST',
        data: Object.assign({ transferId }, data)
      });
    },
    rejectTransfer(transferId, data = {}) {
      if (!transferId) return Promise.reject(new Error('调拨单ID不能为空'));
      return http.request({
        url: '/inventory/transfer/reject',
        method: 'POST',
        data: Object.assign({ transferId }, data)
      });
    },
    returnTransfer(transferId, data = {}) {
      if (!transferId) return Promise.reject(new Error('调拨单ID不能为空'));
      return http.request({
        url: '/inventory/transfer/return',
        method: 'POST',
        data: Object.assign({ transferId, scope: 'transfer' }, data)
      });
    },
    getLocations(storeId, params = {}) {
      return http.request('/inventory/locations/' + encodeURIComponent(storeId) + toQuery(params))
        .then(result => ({
          code: 200,
          data: getListPayload(result).map(normalizeLocation),
          raw: result
        }));
    }
  },

  product: {
    list(params = {}) {
      return http.request('/product/list' + toQuery(Object.assign({ page: 1, pageSize: 100 }, params)))
        .then(result => getListPayload(result).map(normalizeProduct))
        .catch(() => http.request('/inventory/list' + toQuery(Object.assign({ page: 1, pageSize: 100 }, params)))
          .then(result => getListPayload(result).map(normalizeProduct)));
    },
    search(keyword, params = {}) {
      return searchProductsWithFallback(keyword, params);
    },
    getPns(productId, storeId = '', params = {}) {
      if (!productId) return Promise.resolve([]);
      return http.request('/product/pn-list' + toQuery(Object.assign({ productId, storeId, page: 1, pageSize: 100 }, params)))
        .then(result => getListPayload(result).map(normalizeProduct));
    },
    create(data) {
      const payload = Object.assign({}, data);
      const pnCode = normalizePnCode(readExternalPnCode(data));
      if (pnCode || data.pnCode !== undefined || data.pn_code !== undefined) payload.pnCode = pnCode;
      if (Array.isArray(data.barcodes)) {
        payload.barcodes = data.barcodes.map(barcode => {
          const next = Object.assign({}, barcode);
          if (next.code !== undefined) next.code = normalizePnCode(next.code);
          return next;
        });
      }
      return http.request({ url: '/product/application', method: 'POST', data: payload });
    },
    update(productId, data) {
      return http.request({ url: '/product/update/' + encodeURIComponent(productId), method: 'PUT', data });
    },
    setPrice(productId, price) {
      const standardPrice = Number(price || 0);
      return http.request({
        url: '/product/price/set',
        method: 'POST',
        data: { productId, standardPrice, retailPrice: standardPrice, minSalePrice: standardPrice }
      });
    },
    addPn(productId, pnCode) {
      const normalizedPnCode = normalizePnCode(pnCode);
      if (!productId || !normalizedPnCode) return Promise.resolve(null);
      return http.request({
        url: '/product/pn',
        method: 'POST',
        data: { productId, pnCode: normalizedPnCode, barcode: normalizedPnCode, isPrimary: false }
      }).catch(err => {
        if (err && String(err.message || '').indexOf('已存在') >= 0) return null;
        throw err;
      });
    },
    saveLegacyGoods(goodsData = {}) {
      const name = goodsData.name || goodsData.NAME || goodsData.productName || '';
      const pnCode = normalizePnCode(goodsData.pnCode);
      const price = Number(goodsData.price || goodsData.PRICE || 0);
      const productId = goodsData.productId || goodsData.product_id || goodsData._id;
      const payload = {
        name,
        categoryId: goodsData.categoryId || '',
        config: goodsData.mtmCode || goodsData.MTM || goodsData.config || '',
        needSn: !!(goodsData.snCode || goodsData.SN || goodsData.needSn),
        needImei: !!goodsData.needImei,
        remark: goodsData.remark || '',
        attributes: { category: goodsData.category || goodsData.CATEGORY || '' }
      };

      const saveBase = productId
        ? api.product.update(productId, payload).then(() => ({ productId }))
        : api.product.create(Object.assign({}, payload, {
          barcodes: pnCode ? [{ type: 'manufacturer', code: pnCode }] : []
        })).then(res => ({ productId: res.productId || res.product_id || productId }));

      return saveBase.then(res => {
        const id = res.productId || productId;
        const tasks = [];
        if (id && pnCode) tasks.push(api.product.addPn(id, pnCode));
        if (id) tasks.push(api.product.setPrice(id, price));
        return Promise.all(tasks).then(() => res);
      });
    },
    getCategoryTree() {
      return http.request('/product/category/tree');
    },
    getCategoryFieldConfig(categoryId) {
      return http.request('/product/category/field-config' + toQuery({ categoryId }));
    },
    getApplications(params = {}) {
      return http.request('/product/application-list' + toQuery(Object.assign({ page: 1, pageSize: 100 }, params)));
    },
    applicationDetail(applicationId) {
      return http.request('/product/application/' + encodeURIComponent(applicationId));
    },
    reviewApplication(applicationId, data) {
      return http.request({
        url: '/product/application/' + encodeURIComponent(applicationId) + '/review',
        method: 'POST',
        data
      });
    },
    revokeApplication(applicationId, data = {}) {
      return http.request({
        url: '/product/application/' + encodeURIComponent(applicationId) + '/revoke',
        method: 'POST',
        data
      });
    }
  },

  purchase: {
    list(params = {}) {
      return http.request('/purchase/request-list' + toQuery(Object.assign({ page: 1, pageSize: 100 }, params)));
    },
    detail(requestId) {
      return http.request('/purchase/request-detail/' + encodeURIComponent(requestId));
    },
    findByRequestNo(requestNo) {
      const value = String(requestNo || '').trim();
      if (!value) return Promise.resolve(null);
      return http.request('/purchase/request-list' + toQuery({
        requestNo: value,
        request_no: value,
        page: 1,
        pageSize: 20
      })).then(result => {
        const rows = getListPayload(result);
        return rows.find(row => String(row.request_no || row.requestNo || '').trim() === value) || null;
      });
    },
    create(data) {
      return http.request({ url: '/purchase/create-request', method: 'POST', data });
    },
    approve(requestId, data) {
      return http.request({
        url: '/purchase/approve-request/' + encodeURIComponent(requestId),
        method: 'POST',
        data
      });
    },
    revoke(requestId, data = {}) {
      return http.request({
        url: '/purchase/revoke-request/' + encodeURIComponent(requestId),
        method: 'POST',
        data
      });
    },
    suppliers(params = {}) {
      return http.request('/purchase/supplier-list' + toQuery(Object.assign({ page: 1, pageSize: 200, status: 1 }, params)));
    },
    allSuppliers() {
      return http.request('/purchase/supplier-all');
    },
    goodsTypes() {
      return http.request('/inventory/goods-types?activeOnly=1');
    },
    resourceCategories() {
      return http.request('/inventory/resource-categories?activeOnly=1');
    }
  },

  freight: {
    platforms(params = {}) {
      return http.request('/finance/freight/platforms' + toQuery(params)).then(result => result.data || result);
    }
  },

  order: {
    create(orderData) {
      const items = mapSalesItems(orderData.items || orderData.goods || []);
      const payments = mapSalesPayments(orderData.payments || orderData.paymentMethods || []);
      // PN/SN 的存在性校验和销售出库由归档流程负责，创建订单不附加库存状态操作。
      return http.request({
        url: '/sales/create',
        method: 'POST',
        data: mapSalesOrderPayload(Object.assign({}, orderData, {
          customerName: orderData.customerName || '',
          customerPhone: orderData.customerPhone || '',
          customerSource: orderData.customerSource || '',
          customerSourceDetail: orderData.customerSourceDetail || '',
          items,
          payments,
          totalAmount: Number(orderData.totalAmount || 0),
          discountAmount: Number(orderData.discountAmount || 0),
          nationalSubsidy: Number(orderData.nationalSubsidy || 0),
          computerAmount: orderData.computerAmount || '',
          mobileAmount: orderData.mobileAmount || '',
          educationSubsidy: Number(orderData.educationSubsidy || 0),
          actualPayment: Number(orderData.actualPayment || orderData.actualAmount || 0),
          paymentTotal: Number(orderData.paymentTotal || orderData.actualPayment || orderData.actualAmount || 0),
          depositItems: orderData.depositItems || orderData.deposits || [],
          depositDeductionTotal: Number(orderData.depositDeductionTotal || 0),
          depositAction: (orderData.depositItems || orderData.deposits || []).length ? 'reserve' : '',
          invoiceStatus: orderData.invoiceStatus || '',
          invoiceInfo: orderData.invoiceInfo || '',
          invoiceAmount: orderData.invoiceAmount || '',
          subsidyStatus: orderData.subsidyStatus || '',
          subsidyPerson: orderData.subsidyPerson || '',
          subsidyId: orderData.subsidyId || '',
          subsidyPhotos: orderData.subsidyPhotos || [],
          productPhotoUrls: orderData.productPhotoUrls || [],
          educationSubsidyPhotoUrl: orderData.educationSubsidyPhotoUrl || '',
          educationSubsidyCouponCode: orderData.educationSubsidyCouponCode || '',
          educationSubsidyOcrText: orderData.educationSubsidyOcrText || '',
          personalInfoPhoto: orderData.personalInfoPhoto || '',
          auxiliarySalesList: orderData.auxiliarySalesList || [],
          remark: orderData.remark || '',
          storeId: orderData.storeId || '',
          storeName: orderData.storeName || '',
          createUser: orderData.createUser || '',
          createUserPhone: orderData.createUserPhone || '',
          // 新建订单只保存 PN/SN 文本，不占用或校验库存；库存校验及出库动作在归档时执行。
          snStatusAction: orderData.snStatusAction || '',
          targetSnStatus: orderData.targetSnStatus || '',
          inventoryStatusAction: orderData.inventoryStatusAction || '',
          targetInventoryStatus: orderData.targetInventoryStatus || '',
          status: orderData.status || orderData.orderStatus || '未归档',
          orderStatus: orderData.orderStatus || orderData.status || '未归档'
        }))
      });
    },
    getDetails(orderId) {
      return http.request('/sales/' + encodeURIComponent(orderId)).then(result => {
        return normalizeOrder(result);
      });
    },
    queryList(params = {}) {
      return http.request('/sales/list' + toQuery({
        storeId: params.storeId,
        startDate: params.startDate,
        endDate: params.endDate,
        dateStart: params.startDate,
        dateEnd: params.endDate,
        createStartDate: params.startDate,
        createEndDate: params.endDate,
        createTimeStart: params.startDate,
        createTimeEnd: params.endDate,
        orderNo: params.orderNo,
        customerPhone: params.customerPhone,
        status: params.status,
        scope: params.scope,
        approvalStatus: params.approvalStatus,
        resourceType: params.resourceType,
        resourceStatus: params.resourceStatus,
        createUser: params.createUser,
        pnCode: params.pnCode,
        snCode: params.snCode,
        invoiceInfo: params.invoiceInfo,
        page: params.page || 1,
        pageSize: params.pageSize || params.limit || 50
      })).then(result => {
        const rows = getListPayload(result);
        const data = rows.map(normalizeOrder);
        return { code: 200, data, raw: result };
      });
    },
    update(orderId, data) {
      return http.request({ url: '/sales/' + encodeURIComponent(orderId), method: 'PUT', data: mapSalesOrderPayload(data) });
    },
    archive(orderId, data) {
      if (!orderId) return Promise.reject(new Error('订单ID不能为空'));
      return http.request({
        url: '/sales/' + encodeURIComponent(orderId),
        method: 'PUT',
        data
      });
    },
    archiveByOrderNo(orderNo, data) {
      return api.order.queryList({ orderNo, page: 1, pageSize: 1 }).then(res => {
        const order = res.data && res.data[0];
        if (!order) throw new Error('未找到需要归档的订单');
        return api.order.archive(order.orderId || order._id, data);
      });
    },
    approve(orderId) {
      return http.request({
        url: '/sales/' + encodeURIComponent(orderId) + '/approve',
        method: 'POST'
      });
    },
    reject(orderId, reason) {
      return http.request({
        url: '/sales/' + encodeURIComponent(orderId) + '/reject',
        method: 'POST',
        data: { reason: reason || '' }
      });
    },
    requestReturn(orderId, data = {}) {
      if (!orderId) return Promise.reject(new Error('订单ID不能为空'));
      return http.request({
        url: '/sales/' + encodeURIComponent(orderId) + '/return-request',
        method: 'POST',
        data: Object.assign({
          returnType: 'full',
          return_type: 'full',
          postToDailyStatement: true,
          post_to_daily_statement: true,
          createNegativeDailyStatement: true,
          create_negative_daily_statement: true
        }, data)
      });
    },
    returnList(params = {}) {
      return http.request('/sales/return-requests' + toQuery(Object.assign({ page: 1, pageSize: 100 }, params)))
        .then(result => ({
          code: 200,
          data: getListPayload(result),
          pagination: result && (result.pagination || result.pageInfo) || {},
          raw: result
        }));
    },
    reviewReturn(returnId, data = {}) {
      if (!returnId) return Promise.reject(new Error('退单申请ID不能为空'));
      return http.request({
        url: '/sales/return-requests/' + encodeURIComponent(returnId) + '/review',
        method: 'POST',
        data: Object.assign({
          postToDailyStatement: true,
          post_to_daily_statement: true,
          createNegativeDailyStatement: true,
          create_negative_daily_statement: true
        }, data)
      });
    },
    refundList(params = {}) {
      return http.request('/sales/refunds' + toQuery(Object.assign({ page: 1, pageSize: 100 }, params)))
        .then(result => ({
          code: 200,
          data: getListPayload(result),
          pagination: result && (result.pagination || result.pageInfo) || {},
          raw: result
        }));
    },
    refundAccounts(storeId = '') {
      return http.request('/finance/refund-accounts' + toQuery({ storeId }))
        .then(result => getListPayload(result));
    },
    executeRefund(refundId, data = {}) {
      if (!refundId) return Promise.reject(new Error('退款单ID不能为空'));
      return http.request({
        url: '/sales/refunds/' + encodeURIComponent(refundId) + '/execute',
        method: 'POST',
        data: Object.assign({
          postToDailyStatement: true,
          post_to_daily_statement: true,
          createNegativeDailyStatement: true,
          create_negative_daily_statement: true
        }, data)
      });
    },
    updateByOrderNo(orderNo, data) {
      return api.order.queryList({ orderNo, page: 1, pageSize: 1 })
        .then(res => {
          const order = res.data && res.data[0];
          if (!order) throw new Error('Order not found');
          const orderId = order.orderId || order._id;
          return enrichPayloadWithExistingOrderItems(orderId, data)
            .then(enrichedData => {
              const shouldSyncItemsFirst = pickOrderItemsForSnDebug(enrichedData).some(item =>
                getComparableItemValue(item, ['itemId', 'item_id', 'orderItemId', 'order_item_id', 'ITEM_ID', '_id', 'id']) &&
                (
                  getComparableItemValue(item, ['inventoryId', 'inventory_id', 'INVENTORY_ID', 'snId', 'sn_id', 'inventorySnId', 'inventory_sn_id']) ||
                  getComparableItemValue(item, ['snCode', 'sn_code', 'SN_CODE', 'sn', 'SN', 'serialNo', 'serial_no', 'productSn', 'product_sn'])
                )
              );
              const preSync = shouldSyncItemsFirst
                ? syncOrderItemsInventory(orderId, orderNo, enrichedData)
                : Promise.resolve([]);
              return preSync
                .then(() => {
                  return api.order.update(orderId, enrichedData);
                })
                .then(result => {
                  if (!shouldSyncItemsFirst) return result;
                  return syncOrderItemsInventory(orderId, orderNo, enrichedData).then(() => result);
                })
                .catch(err => {
                  err.requestData = enrichedData;
                  throw err;
                });
            });
        });
    },
    getGrossProfit(orderId) {
      return http.request('/sales/' + encodeURIComponent(orderId) + '/gross-profit');
    },
    updateSupplements(orderId, supplements) {
      return http.request({
        url: '/sales/' + encodeURIComponent(orderId) + '/supplements',
        method: 'PUT',
        data: { supplements: supplements || [] }
      });
    },
    getProductPns(storeId, productId) {
      if (!storeId || !productId) {
        return Promise.resolve({ code: 200, data: [] });
      }
      return http.request('/sales/product-pns/' + encodeURIComponent(storeId) + '/' + encodeURIComponent(productId))
        .then(result => ({ code: 200, data: getListPayload(result).map(item => typeof item === 'string' ? normalizePnCode(item) : normalizePnCode(item.pnCode || item.code || '')), raw: result }));
    },
    getProductSns(storeId, productId, pnCode) {
      if (!storeId || !productId) {
        return Promise.resolve({ code: 200, data: [] });
      }
      return http.request('/sales/product-sns/' + encodeURIComponent(storeId) + '/' + encodeURIComponent(productId) + toQuery({ pnCode }))
        .then(result => ({ code: 200, data: getListPayload(result).map(normalizeProduct), raw: result }));
    },
    getAuxiliaryStaff(params = {}) {
      return http.request('/sales/auxiliary-staff' + toQuery(params))
        .then(result => ({ code: 200, data: getListPayload(result).map(normalizeUser), raw: result }));
    }
  },

  deposit: {
    list(params = {}) {
      return http.request({
        url: '/sales/deposits' + toQuery(Object.assign({ page: 1, pageSize: 50 }, params)),
        silentErrors: true
      })
        .then(assertDepositApiResult)
        .then(result => ({ code: 200, data: getListPayload(result).map(normalizeDeposit), raw: result }))
        .catch(normalizeDepositApiError);
    },
    create(data) {
      return http.request({
        url: '/sales/deposits',
        method: 'POST',
        data,
        silentErrors: true
      }).then(result => {
        const response = { code: 200, data: result, raw: result };
        const depositId = result && (result.depositId || result.deposit_id || result.id);
        if (!depositId) return response;

        // 兼容仍采用“submitted -> archived”流程的旧后端：
        // 新后端直接写 available；旧后端则在提交后自动归档，不再要求人工点击。
        return api.deposit.list({
          storeId: data.storeId || data.store_id || '',
          customerPhone: data.customerPhone || data.customer_phone || '',
          page: 1,
          pageSize: 20
        }).then(listResult => {
          const created = (listResult.data || []).find(item => {
            return String(item.depositId || item.deposit_id || '') === String(depositId);
          });
          if (!created || String(created.status || '').toLowerCase() !== 'submitted') {
            return response;
          }
          return api.deposit.archive(depositId)
            .then(() => Object.assign(response, { activatedViaArchive: true }))
            .catch(err => {
              // 创建本身已经成功，归档兼容失败不能把成功结果误报为创建失败。
              console.warn('旧版定金自动归档失败，将由可用定金兼容查询处理:', err);
              return Object.assign(response, { activationWarning: true });
            });
        }).catch(err => {
          console.warn('定金创建后状态确认失败，将由可用定金兼容查询处理:', err);
          return Object.assign(response, { activationWarning: true });
        });
      })
        .catch(normalizeDepositApiError);
    },
    archive(depositId) {
      return http.request({
        url: '/sales/deposits/' + encodeURIComponent(depositId) + '/archive',
        method: 'POST',
        silentErrors: true
      }).then(result => ({ code: 200, data: result, raw: result }))
        .catch(normalizeDepositApiError);
    },
    refund(depositId, data = {}) {
      return http.request({
        url: '/sales/deposits/' + encodeURIComponent(depositId) + '/refund',
        method: 'POST',
        data,
        silentErrors: true
      }).then(result => ({ code: 200, data: result, raw: result }))
        .catch(normalizeDepositApiError);
    },
    transitionOrder(action, data = {}) {
      return http.request({
        url: '/sales/deposits/order-transition',
        method: 'POST',
        data: Object.assign({}, data, { action }),
        silentErrors: true
      }).then(result => ({ code: 200, data: result, raw: result }))
        .catch(normalizeDepositApiError);
    },
    available(params = {}) {
      const directRequest = http.request({
        url: '/sales/deposits/available' + toQuery(params),
        silentErrors: true
      })
        .then(assertDepositApiResult)
        .then(result => ({
          rows: getListPayload(result).map(normalizeDeposit),
          raw: result,
          error: null
        }))
        .catch(err => {
          return { rows: [], raw: null, error: err };
        });

      // 无论专用接口是否返回数据，都读取一次总表进行补充。
      // 旧后端的专用接口可能只返回 archived，从而漏掉刚创建的 submitted。
      const compatibilityRequest = api.deposit.list(buildAvailableDepositFallbackParams(params))
        .then(res => ({
          rows: res.data || [],
          raw: res.raw,
          error: null
        }))
        .catch(err => {
          return { rows: [], raw: null, error: err };
        });

      return Promise.all([directRequest, compatibilityRequest]).then(results => {
        const direct = results[0];
        const compatibility = results[1];
        const rows = mergeAvailableDeposits(direct.rows, compatibility.rows);

        if (rows.length || !direct.error || !compatibility.error) {
          return {
            code: 200,
            data: rows,
            raw: direct.raw || compatibility.raw,
            fallback: !!direct.error || compatibility.rows.length > direct.rows.length
          };
        }

        return normalizeDepositApiError(direct.error || compatibility.error);
      });
    }
  },

  customer: {
    save(customerData) {
      return Promise.resolve({ code: 200, data: customerData });
    },
    getByPhone() {
      return Promise.resolve({ code: 404, message: 'Customer API is not available' });
    },
    query() {
      return Promise.resolve({ code: 200, data: [] });
    }
  },

  expense: {
    types(activeOnly = true) {
      return http.request('/dict/expense-type/all' + toQuery({ activeOnly: activeOnly ? 1 : 0 }));
    },
    create(data) {
      return http.request({ url: '/finance/expense', method: 'POST', data });
    },
    list(params = {}) {
      return http.request('/finance/expense-list' + toQuery(Object.assign({ page: 1, pageSize: 100 }, params)));
    },
    detail(expenseId) {
      return http.request('/finance/expense/' + encodeURIComponent(expenseId));
    },
    review(expenseId, data) {
      return http.request({
        url: '/finance/expense/' + encodeURIComponent(expenseId) + '/review',
        method: 'POST',
        data
      });
    },
    revoke(expenseId, data = {}) {
      return http.request({
        url: '/finance/expense/' + encodeURIComponent(expenseId) + '/cancel',
        method: 'POST',
        data
      });
    }
  },

  finance: {
    settlementAccounts(params = {}) {
      return http.request('/finance/settlement-accounts/balance' + toQuery(Object.assign({ page: 1, pageSize: 100 }, params)));
    },
    payables(params = {}) {
      return http.request('/finance/payable-list' + toQuery(Object.assign({ page: 1, pageSize: 100 }, params)));
    },
    settlements(params = {}) {
      return http.request('/finance/settlement-list' + toQuery(Object.assign({ page: 1, pageSize: 100 }, params)));
    }
  },

  store: {
    list(params = {}) {
      return http.request('/store/list' + toQuery(Object.assign({ page: 1, pageSize: 100 }, params)))
        .then(result => ({ code: 200, data: getListPayload(result).map(normalizeStore), raw: result }));
    },
    getStores(distributorId) {
      return http.request('/store/all' + toQuery({ distributorId }))
        .then(result => ({ code: 200, data: getListPayload(result).map(normalizeStore) }))
        .catch(err => {
          // 仅在后端没有实现 /store/all 时尝试兼容接口。
          // 鉴权失败或网络异常继续重试只会让登录页等待更久。
          if (err && (err.statusCode === 404 || err.statusCode === 405)) {
            return api.store.list({ distributorId, page: 1, pageSize: 100 });
          }
          throw err;
        });
    },
    getTransferStores(distributorId, regionId) {
      return http.request('/store/transfer-options' + toQuery({ distributorId, regionId, scope: 'transfer' }))
        .then(result => ({ code: 200, data: getListPayload(result).map(normalizeStore), raw: result }))
        .catch(err => {
          // 兼容尚未部署 transfer-options 的旧服务；调拨场景仍携带 scope，
          // 由服务端按经销商范围返回门店，不依赖当前账号的门店查询权限。
          if (err && [403, 404, 405].includes(Number(err.statusCode))) {
            return http.request('/store/all' + toQuery({ distributorId, scope: 'transfer' }))
              .then(result => ({ code: 200, data: getListPayload(result).map(normalizeStore), raw: result }));
          }
          throw err;
        });
    },
    create(data) {
      return http.request({ url: '/store/create', method: 'POST', data });
    },
    update(storeId, data) {
      return http.request({ url: '/store/update/' + encodeURIComponent(storeId), method: 'PUT', data });
    },
    delete(storeId) {
      return http.request({ url: '/store/delete/' + encodeURIComponent(storeId), method: 'DELETE' });
    },
    getRegions() {
      return http.request('/store/regions');
    },
    getDistributor() {
      return Promise.resolve({ code: 200, data: null });
    }
  },

  system: {
    activateDatabase() {
      // 使用只读、小结果集查询同时唤醒云托管实例和 MySQL 连接。
      // 冷启动期间的 5xx/超时由 request 层按此处配置自动重试。
      return http.request({
        url: '/store/list' + toQuery({ page: 1, pageSize: 1 }),
        method: 'GET',
        timeout: 30000,
        retries: 2,
        retryDelay: 1000,
        silentErrors: true
      });
    },
    getUsers(params = {}) {
      return http.request('/system/users' + toQuery(Object.assign({ page: 1, pageSize: 100 }, params)))
        .then(result => ({ code: 200, data: getListPayload(result).map(normalizeUser), raw: result }));
    },
    createUser(data) {
      return http.request({ url: '/system/user', method: 'POST', data });
    },
    updateUser(staffId, data) {
      return http.request({ url: '/system/user/' + encodeURIComponent(staffId), method: 'PUT', data });
    },
    getRoles() {
      return http.request('/system/roles');
    }
  },

  approval: {
    tasks(params = {}) {
      return http.request('/approval/tasks' + toQuery(params));
    },
    instance(instanceId) {
      return http.request('/approval/instances/' + encodeURIComponent(instanceId));
    },
    action(instanceId, data = {}) {
      return http.request({
        url: '/approval/instances/' + encodeURIComponent(instanceId) + '/action',
        method: 'POST',
        data
      });
    }
  },

  report: {
    sales(params = {}) {
      return http.request('/report/sales' + toQuery(params));
    },
    inventory(params = {}) {
      return http.request('/report/inventory' + toQuery(params));
    },
    dashboardFilters() {
      return http.request('/report/dashboard/filters');
    },
    dashboardOverview(params = {}) {
      return http.request('/report/dashboard/overview' + toQuery(params));
    },
    monthlyTaskAchievement(params = {}) {
      return http.request('/report/monthly-task-achievement' + toQuery(params));
    },
    financeOverview(params = {}) {
      return http.request('/report/finance-overview' + toQuery(params));
    },
    dailySummary(params = {}) {
      const orderQuery = api.order.queryList(Object.assign({ page: 1, pageSize: 500 }, params));
      const refundQuery = api.order.refundList(Object.assign({ page: 1, pageSize: 500 }, params))
        .then(result => result.data || [])
        .catch(() => []);
      return Promise.all([orderQuery, refundQuery]).then(([res, refunds]) => {
        const list = res.data || [];
        const salesAmount = list.reduce((sum, item) => sum + Number(item.actualAmount || item.totalAmount || 0), 0);
        const refundAmount = refunds
          .filter(item => ['executed', 'completed', 'paid', 'refunded', 'success'].indexOf(String(item.status || '').toLowerCase()) >= 0)
          .reduce((sum, item) => sum + Math.abs(Number(item.refund_amount || item.refundAmount || item.amount || 0)), 0);
        return {
          list,
          refunds,
          totalOrders: list.length,
          salesAmount,
          refundAmount,
          totalAmount: salesAmount - refundAmount,
          netAmount: salesAmount - refundAmount
        };
      });
    },
    dailyStatements(params = {}) {
      return http.request('/report/daily-statements' + toQuery(Object.assign({ page: 1, pageSize: 100 }, params)))
        .then(result => ({
          code: 200,
          data: getListPayload(result),
          pagination: result && (result.pagination || result.pageInfo) || {},
          raw: result
        }));
    },
    profitAdjustments(params = {}) {
      return http.request('/report/profit-adjustments' + toQuery(Object.assign({
        scope: 'review',
        page: 1,
        pageSize: 100
      }, params))).then(result => ({
        code: 200,
        data: getListPayload(result),
        pagination: result && (result.pagination || result.pageInfo) || {},
        raw: result
      }));
    },
    reviewProfitAdjustment(adjustmentId, action, comment) {
      const operation = action === 'approved' ? 'approve' : 'reject';
      return http.request({
        url: '/report/profit-adjustments/' + encodeURIComponent(adjustmentId) + '/' + operation,
        method: 'POST',
        data: { comment: comment || '' }
      });
    }
  },

  dict: {
    getCustomerSources() {
      return http.request('/dict/customer-source/all')
        .then(rows => flattenCustomerSources(getListPayload(rows).length ? getListPayload(rows) : rows))
        .catch(() => http.request('/dict/customer-source/tree')
          .then(rows => flattenCustomerSources(getListPayload(rows).length ? getListPayload(rows) : rows)));
    },
    saveCustomerSource(sourceData) {
      const id = sourceData.id || sourceData._id || sourceData.sourceId;
      const data = {
        name: sourceData.name,
        parentId: sourceData.parentId || '',
        sortOrder: sourceData.sortOrder || 0,
        status: sourceData.isActive === false ? 0 : 1
      };
      if (id) {
        return http.request({ url: '/dict/customer-source/update/' + encodeURIComponent(id), method: 'PUT', data });
      }
      return http.request({ url: '/dict/customer-source/create', method: 'POST', data });
    },
    deleteCustomerSource(id) {
      return http.request({ url: '/dict/customer-source/delete/' + encodeURIComponent(id), method: 'DELETE' });
    },
    getPaymentMethods(storeId) {
      const path = storeId ? '/dict/payment-method/by-store' + toQuery({ storeId }) : '/dict/payment-method/all';
      return http.request(path).then(rows => getListPayload(rows).map(normalizePaymentMethod));
    },
    savePaymentMethod(methodData) {
      const id = methodData.id || methodData._id || methodData.methodId;
      const data = {
        name: methodData.name,
        code: methodData.code || methodData.name,
        sortOrder: methodData.sortOrder || 0,
        isGlobal: methodData.isGlobal !== false,
        status: methodData.isActive === false ? 0 : 1
      };
      if (methodData.defaultTaxRate !== undefined) {
        data.defaultTaxRate = Number(methodData.defaultTaxRate || 0);
      }
      if (id) {
        return http.request({ url: '/dict/payment-method/update/' + encodeURIComponent(id), method: 'PUT', data });
      }
      return http.request({ url: '/dict/payment-method/create', method: 'POST', data });
    },
    deletePaymentMethod(id) {
      return http.request({ url: '/dict/payment-method/delete/' + encodeURIComponent(id), method: 'DELETE' });
    },
    getSupplementItems() {
      return http.request('/dict/supplement-item/all').then(rows => getListPayload(rows).map(normalizeSupplementItem));
    },
    saveSupplementItem(itemData) {
      const id = itemData.id || itemData._id || itemData.itemId;
      const data = {
        name: itemData.name,
        code: itemData.code || itemData.name,
        amount: itemData.amount || 0,
        sortOrder: itemData.sortOrder || 0,
        isActive: itemData.isActive !== false,
        amountType: itemData.amountType || 'increase'
      };
      if (id) {
        return http.request({ url: '/dict/supplement-item/update/' + encodeURIComponent(id), method: 'PUT', data });
      }
      return http.request({ url: '/dict/supplement-item/create', method: 'POST', data });
    },
    deleteSupplementItem(id) {
      return http.request({ url: '/dict/supplement-item/delete/' + encodeURIComponent(id), method: 'DELETE' });
    }
  },

  _helpers: {
    normalizeProduct,
    normalizeOrder,
    normalizeStore,
    normalizeUser,
    normalizeSupplementItem,
    normalizeTransfer,
    getListPayload
  }
};

module.exports = api;
