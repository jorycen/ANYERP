function firstNumber(source, keys) {
  for (let i = 0; i < keys.length; i += 1) {
    const value = source && source[keys[i]];
    if (value === undefined || value === null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function firstPositiveNumber(source, keys) {
  for (let i = 0; i < keys.length; i += 1) {
    const value = source && source[keys[i]];
    if (value === undefined || value === null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function isServiceProviderItem(item = {}) {
  const supplier = item.Supplier || item.supplier || {};
  const value = item.isServiceProvider !== undefined
    ? item.isServiceProvider
    : (item.is_service_provider !== undefined
      ? item.is_service_provider
      : (supplier.isServiceProvider !== undefined ? supplier.isServiceProvider : supplier.is_service_provider));
  if (value === undefined || value === null || value === '') return true;
  return !(value === false || value === 0 || value === '0' || String(value).toLowerCase() === 'false');
}

function isExternalAdjustmentEligibleItem(item = {}) {
  if (isServiceProviderItem(item)) return false;
  const product = item.Product || item.product || {};
  const text = [
    item.category,
    item.productCategory,
    item.product_category,
    product.category,
    item.productName,
    item.product_name,
    product.name,
    item.accessoryType,
    item.accessory_type,
    product.accessoryType,
    product.accessory_type
  ].filter(Boolean).join(' ').toLowerCase();
  if (/配件|维修|服务|安装|保养|耗材/.test(text)) return false;
  return /电脑|笔记本|台式机|一体机|主机|平板|ipad|手机|iphone/.test(text);
}

function getItemCost(item = {}) {
  const product = item.Product || item.product || {};
  const priceInfo = item.ProductPrice || item.productPrice || product.ProductPrice || product.productPrice || {};
  const purchase = firstPositiveNumber(item, [
    'purchasePrice', 'purchase_price', 'originalPickupPrice', 'original_pickup_price',
    'originalInventoryCost', 'original_inventory_cost', 'inboundPrice', 'inbound_price',
    'costPrice', 'cost_price', 'importPrice', 'import_price', 'cost'
  ]) || firstPositiveNumber(priceInfo, [
    'purchasePrice', 'purchase_price', 'originalPickupPrice', 'original_pickup_price',
    'originalInventoryCost', 'original_inventory_cost', 'inboundPrice', 'inbound_price',
    'costPrice', 'cost_price', 'importPrice', 'import_price', 'cost'
  ]);
  const standard = firstPositiveNumber(item, [
    'standardPrice', 'standard_price', 'productStandardPrice', 'product_standard_price'
  ]) || firstPositiveNumber(priceInfo, [
    'standardPrice', 'standard_price', 'productStandardPrice', 'product_standard_price'
  ]) || firstPositiveNumber(product, [
    'standardPrice', 'standard_price', 'productStandardPrice', 'product_standard_price'
  ]);
  if (isServiceProviderItem(item) && standard !== null) return standard;
  if (!isServiceProviderItem(item) && purchase !== null) return purchase;

  const direct = firstPositiveNumber(item, [
    'costPrice', 'cost_price', 'purchasePrice', 'purchase_price',
    'importPrice', 'import_price', 'cost', 'settlementPrice', 'settlement_price'
  ]);
  const sale = firstPositiveNumber(item, ['unitPrice', 'unit_price', 'salePrice', 'sale_price', 'price']);
  // 部分旧页面为了兼容库存商品，会把销售价复制到 costPrice/settlementPrice。
  // 没有独立定价且两者相等时不能把销售价再次当成商品定价。
  if (direct !== null && (sale === null || Math.abs(direct - sale) > 0.005)) return direct;
  if (purchase !== null) return purchase;
  return firstPositiveNumber(item.ProductPrice || item.productPrice, [
    'standardPrice', 'standard_price', 'productStandardPrice', 'product_standard_price',
    'costPrice', 'cost_price', 'purchasePrice', 'purchase_price', 'importPrice', 'import_price'
  ]) || firstPositiveNumber(product, [
    'standardPrice', 'standard_price', 'productStandardPrice', 'product_standard_price',
    'costPrice', 'cost_price', 'purchasePrice', 'purchase_price', 'importPrice', 'import_price'
  ]) || firstPositiveNumber(priceInfo, [
    'standardPrice', 'standard_price', 'productStandardPrice', 'product_standard_price',
    'costPrice', 'cost_price', 'purchasePrice', 'purchase_price', 'importPrice', 'import_price'
  ]);
}

function getItemMinimumSalePrice(item = {}) {
  const direct = firstPositiveNumber(item, [
    'minSalePrice', 'min_sale_price', 'minimumSalePrice', 'minimum_sale_price',
    'minimumPrice', 'minimum_price', 'minPrice', 'min_price',
    'lowestSalePrice', 'lowest_sale_price', 'lowestPrice', 'lowest_price',
    'floorPrice', 'floor_price', 'lowPrice', 'low_price'
  ]);
  if (direct !== null) return direct;
  const product = item.Product || item.product || {};
  const priceInfo = item.ProductPrice || item.productPrice || product.ProductPrice || product.productPrice || {};
  return firstPositiveNumber(priceInfo, [
    'minSalePrice', 'min_sale_price', 'minimumSalePrice', 'minimum_sale_price',
    'minimumPrice', 'minimum_price', 'minPrice', 'min_price', 'lowestSalePrice', 'lowest_sale_price',
    'lowestPrice', 'lowest_price', 'floorPrice', 'floor_price', 'lowPrice', 'low_price'
  ]) || firstPositiveNumber(product, [
    'minSalePrice', 'min_sale_price', 'minimumSalePrice', 'minimum_sale_price',
    'minimumPrice', 'minimum_price', 'minPrice', 'min_price', 'lowestSalePrice', 'lowest_sale_price',
    'lowestPrice', 'lowest_price', 'floorPrice', 'floor_price', 'lowPrice', 'low_price'
  ]);
}

function getItemQuantity(item = {}) {
  const quantity = Number(item.quantity);
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
}

function calculateOrderProfit(order = {}, items) {
  const rows = Array.isArray(items) ? items : (order.items || order.goods || []);
  let pricingTotal = 0;
  let minimumSalePriceTotal = 0;
  let hasPricing = rows.length > 0;
  let hasMinimumSalePrice = rows.length > 0;
  let hasExternalAdjustmentEligibleItem = false;

  rows.forEach(item => {
    if (isExternalAdjustmentEligibleItem(item)) hasExternalAdjustmentEligibleItem = true;
    const pricing = getItemCost(item);
    const minimumSalePrice = getItemMinimumSalePrice(item);
    if (pricing === null) {
      hasPricing = false;
    } else {
      pricingTotal += pricing * getItemQuantity(item);
    }
    if (minimumSalePrice === null) {
      hasMinimumSalePrice = false;
    } else {
      minimumSalePriceTotal += minimumSalePrice * getItemQuantity(item);
    }
    if (pricing === null || minimumSalePrice === null) {
      return;
    }
  });

  const explicitPreSubsidyReceivable = firstNumber(order, [
    'receivableBeforeSubsidy', 'receivable_before_subsidy', 'preSubsidyReceivable', 'pre_subsidy_receivable'
  ]);
  const totalAmount = firstNumber(order, ['totalAmount', 'total_amount']);
  const discount = firstNumber(order, ['discount', 'discountAmount', 'discount_amount']) || 0;
  // 最低售价审批和毛利测算统一使用国补、教育优惠前的应收金额。
  // 订单总额已经是商品销售价合计，普通折扣仍应计入，国补和教育优惠不应计入。
  const receivable = explicitPreSubsidyReceivable !== null
    ? explicitPreSubsidyReceivable
    : (totalAmount !== null
      ? Math.max(0, totalAmount - discount)
      : firstNumber(order, [
        'actualAmount', 'actualPayment', 'actual_payment', 'actual_amount', 'receivableAmount', 'receivable_amount'
      ]));
  const grossProfitBeforeExternalAdjustment = receivable === null || !hasPricing
    ? null
    : receivable - pricingTotal;
  const externalAdjustmentFee = hasExternalAdjustmentEligibleItem && grossProfitBeforeExternalAdjustment !== null && grossProfitBeforeExternalAdjustment > 500
    ? 200
    : 0;
  const grossProfit = grossProfitBeforeExternalAdjustment === null
    ? null
    : grossProfitBeforeExternalAdjustment - externalAdjustmentFee;
  const isBelowMinimum = receivable !== null && hasMinimumSalePrice &&
    receivable < minimumSalePriceTotal - 0.005;

  return {
    receivable: receivable === null ? 0 : receivable,
    pricingTotal,
    // 保留旧字段，兼容现有接口和历史数据。
    costTotal: pricingTotal,
    minimumSalePriceTotal,
    grossProfitBeforeExternalAdjustment,
    externalAdjustmentEligible: hasExternalAdjustmentEligibleItem,
    externalAdjustmentFee,
    grossProfit,
    hasPricing,
    hasCost: hasPricing,
    hasMinimumSalePrice,
    isBelowMinimum,
    // 兼容旧调用方；审批条件已改为最低销售价校验。
    isNegative: isBelowMinimum
  };
}

module.exports = {
  getItemCost,
  getItemMinimumSalePrice,
  isExternalAdjustmentEligibleItem,
  calculateOrderProfit
};
