const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calculateGrossProfitValues,
  normalizeMethodName,
  isPolicySubsidyReceivable
} = require('../src/modules/sales/grossProfit');

test('订单毛利按实收、结算成本、收款税率、增值税和补录净额计算', () => {
  const result = calculateGrossProfitValues({
    paymentDetails: [
      { method: '微信', amount: 1000, taxRate: 0.6 },
      { method: '现金定金', amount: 200, taxRate: 0.2 },
      { method: '国补POS（电脑）-政策补贴应收', amount: 300, taxRate: 9 }
    ],
    settlementCostDetails: [
      { productName: '电脑', quantity: 1, unitCost: 900, costAmount: 900 }
    ],
    supplementDetails: [
      { itemName: '提货运费', amount: 50, amountType: 'increase' },
      { itemName: '教育优惠', amount: 20, amountType: 'decrease' }
    ],
    invoiceAmount: 1000
  });

  assert.equal(result.receivedAmount, 1200);
  assert.equal(result.settlementCostAmount, 900);
  assert.equal(result.paymentFeeAmount, 6.4);
  assert.equal(result.vatTaxableAmount, 100);
  assert.equal(result.vatAmount, 13);
  assert.equal(result.supplementAmount, 30);
  assert.equal(result.grossProfitAmount, 310.6);
  assert.equal(result.paymentDetails.length, 2);
});

test('开票金额低于销售结算成本时增值税计税差额核为零', () => {
  const result = calculateGrossProfitValues({
    paymentDetails: [{ method: '现金', amount: 800, taxRate: 0 }],
    settlementCostDetails: [{ quantity: 1, unitCost: 900, costAmount: 900 }],
    invoiceAmount: 700
  });

  assert.equal(result.vatTaxableAmount, 0);
  assert.equal(result.vatAmount, 0);
  assert.equal(result.grossProfitAmount, -100);
});

test('国补收款后缀用于税率匹配且政策补贴应收不属于用户实收', () => {
  assert.equal(normalizeMethodName('国补POS（电脑）-客户实收'), '国补POS（电脑）');
  assert.equal(isPolicySubsidyReceivable('国补POS（电脑）-政策补贴应收'), true);
  assert.equal(isPolicySubsidyReceivable('国补POS（电脑）-客户实收'), false);
});
