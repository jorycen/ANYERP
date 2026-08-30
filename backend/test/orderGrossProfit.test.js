const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calculateGrossProfitValues,
  calculateNationalSubsidyCustomerReceiptAmount,
  normalizeMethodName,
  isPolicySubsidyReceivable,
  calculateOrderReceivable,
  isFreightRecordApplicableToOrder,
  resolveUnitProductPricing,
  isExternalAdjustmentEligibleProduct
} = require('../src/modules/sales/grossProfit');

test('订单毛利按应收、产品定价、应收税率费用、增值税和补录净额计算', () => {
  const result = calculateGrossProfitValues({
    receivableAmount: 1200,
    paymentDetails: [
      { method: '微信', amount: 1000, taxRate: 0.6 },
      { method: '现金定金', amount: 200, taxRate: 0.2 },
      { method: '国补POS（电脑）-政策补贴应收', amount: 300, taxRate: 9 }
    ],
    productPricingDetails: [
      { productName: '电脑', quantity: 1, unitPricing: 900, pricingAmount: 900 }
    ],
    supplementDetails: [
      { itemName: '提货运费', amount: 50, amountType: 'increase' },
      { itemName: '教育优惠', amount: 20, amountType: 'decrease' }
    ],
    invoiceAmount: 1000
  });

  assert.equal(result.receivableAmount, 1200);
  assert.equal(result.productPricingAmount, 900);
  assert.equal(result.paymentFeeAmount, 6.4);
  assert.equal(result.vatTaxableAmount, 100);
  assert.equal(result.vatAmount, 13);
  assert.equal(result.supplementAmount, 30);
  assert.equal(result.grossProfitAmount, 310.6);
  assert.equal(result.paymentDetails.length, 2);
});

test('开票金额低于产品定价时增值税计税差额核为零', () => {
  const result = calculateGrossProfitValues({
    receivableAmount: 800,
    paymentDetails: [{ method: '现金', amount: 800, taxRate: 0 }],
    productPricingDetails: [{ quantity: 1, unitPricing: 900, pricingAmount: 900 }],
    invoiceAmount: 700
  });

  assert.equal(result.vatTaxableAmount, 0);
  assert.equal(result.vatAmount, 0);
  assert.equal(result.grossProfitAmount, -100);
});

test('国补收款后缀用于税率匹配且政策补贴应收不属于用户应收分配', () => {
  assert.equal(normalizeMethodName('国补POS（电脑）-客户实收'), '国补POS（电脑）');
  assert.equal(isPolicySubsidyReceivable('国补POS（电脑）-政策补贴应收'), true);
  assert.equal(isPolicySubsidyReceivable('国补POS（电脑）-客户实收'), false);
});

test('收款方式费用按用户应收分配额而不是实际收款额计算', () => {
  const result = calculateGrossProfitValues({
    receivableAmount: 1200,
    paymentDetails: [{ method: '银行卡', amount: 1000, taxRate: 1 }],
    productPricingDetails: [],
    supplementDetails: [],
    invoiceAmount: 0
  });

  assert.equal(result.paymentDetails[0].receivableAmount, 1200);
  assert.equal(result.paymentFeeAmount, 12);
  assert.equal(result.grossProfitAmount, 1188);
});

test('毛利商品成本优先使用产品定价，未定价时才回退采购成本', () => {
  assert.deepEqual(
    resolveUnitProductPricing(
      { standard_price: 950, cost_price: 800 },
      { original_inventory_cost: 700, sales_settlement_cost: 600 }
    ),
    { unitPricing: 950, source: 'product_standard_price' }
  );
  assert.deepEqual(
    resolveUnitProductPricing(
      { standard_price: 0, cost_price: 800 },
      { original_inventory_cost: 700, sales_settlement_cost: 600 }
    ),
    { unitPricing: 800, source: 'product_cost_fallback' }
  );
});

test('特价SN商品毛利使用SN特价替代产品定价', () => {
  assert.deepEqual(
    resolveUnitProductPricing(
      { standard_price: 950, cost_price: 800 },
      { specialPrice: 799 }
    ),
    { unitPricing: 799, source: 'sn_special_price' }
  );
});

test('非服务商毛利成本按本次采购价', () => {
  assert.deepEqual(
    resolveUnitProductPricing(
      { standard_price: 5000, cost_price: 4500 },
      { original_inventory_cost: 4500 },
      { supplier_id: 'SUP_1', is_service_provider: 0, gross_profit_uplift_amount: 200 }
    ),
    {
      unitPricing: 4500,
      source: 'purchase_price',
      purchasePrice: 4500,
      isServiceProvider: false
    }
  );
});

test('用户应收保留国补和教育补贴，只扣除普通折扣', () => {
  assert.equal(calculateOrderReceivable({
    total_amount: 1500,
    discount_amount: 100,
    national_subsidy: 300,
    education_subsidy: 200
  }), 1400);
});

test('商品运费只匹配订单门店对应的调拨目的门店', () => {
  assert.equal(isFreightRecordApplicableToOrder({
    orderStoreId: 'STORE_TIANFU',
    orderCreatedAt: '2026-08-29T10:00:00+08:00',
    sourceType: 'transfer',
    storeId: 'STORE_LONGQUAN',
    toStoreId: 'STORE_LONGQUAN',
    sourceCreatedAt: '2026-08-27T10:00:00+08:00'
  }), false);
  assert.equal(isFreightRecordApplicableToOrder({
    orderStoreId: 'STORE_LONGQUAN',
    orderCreatedAt: '2026-08-29T10:00:00+08:00',
    sourceType: 'transfer',
    storeId: 'STORE_LONGQUAN',
    toStoreId: 'STORE_LONGQUAN',
    sourceCreatedAt: '2026-08-27T10:00:00+08:00'
  }), true);
});

test('商品运费不使用订单生成之后的运费记录', () => {
  assert.equal(isFreightRecordApplicableToOrder({
    orderStoreId: 'STORE_1',
    orderCreatedAt: '2026-08-29T10:00:00+08:00',
    sourceType: 'purchase',
    storeId: 'STORE_1',
    sourceCreatedAt: '2026-08-29T09:00:00+08:00',
    sourceUpdatedAt: '2026-08-29T10:00:01+08:00'
  }), false);
});

test('采购运费只匹配采购归属门店', () => {
  assert.equal(isFreightRecordApplicableToOrder({
    orderStoreId: 'STORE_1',
    sourceType: 'purchase',
    storeId: 'STORE_2'
  }), false);
  assert.equal(isFreightRecordApplicableToOrder({
    orderStoreId: 'STORE_1',
    sourceType: 'purchase',
    storeId: 'STORE_1'
  }), true);
});

test('非服务商电脑基础毛利超过500元时扣除200元外调费', () => {
  const result = calculateGrossProfitValues({
    receivableAmount: 1000,
    productPricingDetails: [{
      productName: '笔记本电脑',
      quantity: 1,
      unitPricing: 400,
      pricingAmount: 400,
      isServiceProvider: false,
      externalAdjustmentEligible: true
    }],
    externalAdjustmentEligible: true
  });
  assert.equal(result.grossProfitBeforeExternalAdjustment, 600);
  assert.equal(result.externalAdjustmentFee, 200);
  assert.equal(result.grossProfitAmount, 400);
});

test('纯配件或维修商品即使基础毛利超过500元也不扣外调费', () => {
  const accessory = calculateGrossProfitValues({
    receivableAmount: 1000,
    productPricingDetails: [{ productName: '电脑鼠标配件', quantity: 1, pricingAmount: 400 }],
    externalAdjustmentEligible: false
  });
  const repair = calculateGrossProfitValues({
    receivableAmount: 1000,
    productPricingDetails: [{ productName: '手机维修服务', quantity: 1, pricingAmount: 400 }],
    externalAdjustmentEligible: false
  });
  assert.equal(accessory.externalAdjustmentFee, 0);
  assert.equal(accessory.grossProfitAmount, 600);
  assert.equal(repair.externalAdjustmentFee, 0);
  assert.equal(repair.grossProfitAmount, 600);
});

test('外调费资格只接受非服务商电脑、手机或平板', () => {
  assert.equal(isExternalAdjustmentEligibleProduct({ productName: '笔记本电脑', isServiceProvider: false }), true);
  assert.equal(isExternalAdjustmentEligibleProduct({ productName: '手机', isServiceProvider: false }), true);
  assert.equal(isExternalAdjustmentEligibleProduct({ productName: '平板', isServiceProvider: false }), true);
  assert.equal(isExternalAdjustmentEligibleProduct({ productName: '笔记本电脑', isServiceProvider: true }), false);
  assert.equal(isExternalAdjustmentEligibleProduct({ productName: '电脑配件', isServiceProvider: false }), false);
  assert.equal(isExternalAdjustmentEligibleProduct({ productName: '电脑维修', isServiceProvider: false }), false);
});

test('国补POS客户实收到账金额扣除0.6%税', () => {
  assert.equal(calculateNationalSubsidyCustomerReceiptAmount({
    nationalAmount: 10000,
    subsidyAmount: 3000,
    nationalSubsidyAmount: 3000
  }), 6958);
});

test('国补POS客户实收到账金额按两位小数保留', () => {
  assert.equal(calculateNationalSubsidyCustomerReceiptAmount({
    nationalAmount: 5000,
    subsidyAmount: 1200,
    nationalSubsidyAmount: 1000
  }), 3776);
});
