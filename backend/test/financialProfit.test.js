const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { calculateOrder } = require('../src/modules/report/financialProfitController');
const { ProductPrice } = require('../src/models');

function baseRow(overrides = {}) {
  return {
    orderId: 'order-1',
    orderNo: 'ORD-1',
    businessDate: '2026-09-19',
    storeId: 'store-1',
    storeName: '测试门店',
    customerName: '客户',
    totalAmount: 113,
    discountAmount: 0,
    quantity: 1,
    subtotal: 113,
    purchaseUnitCost: 56.5,
    outputTaxRate: 0.13,
    inputTaxRate: 0.13,
    inputTaxDeductible: 1,
    ...overrides
  };
}

test('可抵扣进项税时按不含税收入减不含税成本计算财务毛利', () => {
  const result = calculateOrder([baseRow()]);
  assert.equal(result.netRevenue, 100);
  assert.equal(result.outputVat, 13);
  assert.equal(result.bookCost, 50);
  assert.equal(result.deductibleInputVat, 6.5);
  assert.equal(result.grossProfit, 50);
  assert.equal(result.grossMargin, 50);
  assert.equal(result.status, 'estimated');
});

test('进项税不可抵扣时含税金额全额计入成本', () => {
  const result = calculateOrder([baseRow({ inputTaxDeductible: 0 })]);
  assert.equal(result.bookCost, 56.5);
  assert.equal(result.deductibleInputVat, 0);
  assert.equal(result.grossProfit, 43.5);
});

test('缺少库存成本时标记待补成本且不输出虚假毛利', () => {
  const result = calculateOrder([baseRow({ purchaseUnitCost: 0, originalInventoryCost: 0, currentCostPrice: 0 })]);
  assert.equal(result.status, 'cost_pending');
  assert.equal(result.grossProfit, null);
  assert.equal(result.grossMargin, null);
});

test('已完成部分退单按负向收入和退回数量冲减原订单', () => {
  const result = calculateOrder([baseRow({
    totalAmount: 226,
    subtotal: 226,
    quantity: 2,
    returnedQuantity: -1,
    returnedReceivable: -113
  })]);
  assert.equal(result.grossRevenue, 113);
  assert.equal(result.netRevenue, 100);
  assert.equal(result.bookCost, 50);
  assert.equal(result.grossProfit, 50);
});

test('财务利润表的税务字段、迁移和导出路由均已注册', () => {
  assert.ok(ProductPrice.rawAttributes.output_tax_rate);
  assert.ok(ProductPrice.rawAttributes.input_tax_rate);
  assert.ok(ProductPrice.rawAttributes.input_tax_deductible);
  const migration = fs.readFileSync(path.join(__dirname, '../src/utils/dbMigration.js'), 'utf8');
  const routes = fs.readFileSync(path.join(__dirname, '../src/modules/report/routes.js'), 'utf8');
  assert.match(migration, /OUTPUT_TAX_RATE/);
  assert.match(migration, /finance_profit_statement/);
  assert.match(routes, /financial-profit-orders\/export/);
  assert.match(routes, /financial-profit-orders'/);
});
