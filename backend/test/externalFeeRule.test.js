const test = require('node:test');
const assert = require('node:assert/strict');
const GP = require('../src/modules/sales/grossProfit');

function line({ profitCostMode = 'PURCHASE_PRICE', uplift = 200, pricing = 100 } = {}) {
  return {
    quantity: 1,
    unitPricing: pricing,
    pricingAmount: pricing,
    isCompanyPriced: profitCostMode === 'COMPANY_PRICE',
    costModeSnapshot: profitCostMode,
    externalAdjustmentEligible: profitCostMode === 'PURCHASE_PRICE',
    grossProfitUpliftAmount: uplift
  };
}

function calculate(grossProfitBeforeFee, details = [line()]) {
  return GP.calculateGrossProfitValues({
    receivableAmount: grossProfitBeforeFee + details.reduce((sum, item) => sum + item.pricingAmount, 0),
    productPricingDetails: details,
    paymentDetails: [],
    supplementDetails: [],
    freightCostDetails: [],
    invoiceAmount: 0,
    invoiceStatus: '不开票'
  });
}

test('采购价商品按扣外调费前整单毛利分档收取一次外调费', () => {
  assert.equal(calculate(299).externalAdjustmentFee, 0);
  assert.equal(calculate(300).externalAdjustmentFee, 100);
  assert.equal(calculate(500).externalAdjustmentFee, 100);
  assert.equal(calculate(500.01).externalAdjustmentFee, 200);
});

test('公司定价商品和无上浮金额商品不收外调费', () => {
  assert.equal(calculate(1000, [line({ profitCostMode: 'COMPANY_PRICE' })]).externalAdjustmentFee, 0);
  assert.equal(calculate(1000, [line({ uplift: 0 })]).externalAdjustmentFee, 0);
});

test('混合订单只按采购价商品的上浮金额收一次外调费', () => {
  const result = calculate(600, [
    line({ profitCostMode: 'PURCHASE_PRICE', uplift: 200, pricing: 100 }),
    line({ profitCostMode: 'COMPANY_PRICE', uplift: 500, pricing: 100 })
  ]);
  assert.equal(result.externalAdjustmentAmount, 200);
  assert.equal(result.externalAdjustmentFee, 200);
});
