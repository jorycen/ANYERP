const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { calculateOrder, resolveFinancialCost, summarize, queryFinancialProfit } = require('../src/modules/report/financialProfitController');
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

test('已确认0元采购成本保留0元，不回退到其他成本', () => {
  const result = calculateOrder([baseRow({ purchaseUnitCost: '0.00', purchaseCostStatus: 'ready',
    originalInventoryCost: 80, currentCostPrice: 90 })]);
  assert.equal(result.status, 'estimated');
  assert.equal(result.grossCost, 0);
  assert.equal(result.bookCost, 0);
  assert.equal(result.grossProfit, 100);
});

test('当前档案锁定零元不能替代历史依据，默认零值和空值仍为待补', () => {
  const locked = calculateOrder([baseRow({ purchaseUnitCost: 0, purchaseCostStatus: 'pending',
    originalInventoryCost: 0, currentCostPrice: 0, costPriceLocked: 1, currentPriceStatus: 1 })]);
  assert.equal(locked.status, 'cost_pending');
  assert.equal(locked.grossProfit, null);
  for (const value of [null, undefined, '', ' ', -1, 'invalid', Infinity, true]) {
    const pending = calculateOrder([baseRow({ productName: '待补商品', purchaseUnitCost: value,
      originalInventoryCost: null, currentCostPrice: null })]);
    assert.equal(pending.status, 'cost_pending');
    assert.equal(pending.grossProfit, null);
    assert.match(pending.pendingCostReason, /待补商品/);
  }
});

test('冻结采购成本优先于当前成本，0元公司定价不作为0元实际采购证明', () => {
  const row = { itemId: 1, purchaseUnitCost: 0, purchaseCostStatus: 'pending', originalInventoryCost: 0,
    frozenPricingDetails: [{ itemId: 1, unitPricing: 0, purchasePrice: 1500, source: 'product_standard_price' }], currentCostPrice: 9999 };
  assert.equal(resolveFinancialCost(row).unitCost, 1500);
  const zero = resolveFinancialCost({ ...row, frozenPricingDetails: JSON.stringify([{ itemId: 1, purchasePrice: 0, purchasePriceKnown: true }]) });
  assert.equal(zero.unitCost, 0);
  const unknown = resolveFinancialCost({ ...row, currentCostPrice: 0,
    frozenPricingDetails: [{ itemId: 1, unitPricing: 0, purchasePrice: 0 }] });
  assert.equal(unknown.unitCost, null);
});

test('部分退货按有效0元成本冲减，整单退完不再因缺成本挂待补', () => {
  const partial = calculateOrder([baseRow({ totalAmount: 226, subtotal: 226, quantity: 2,
    purchaseUnitCost: 0, purchaseCostStatus: 'ready', returnedQuantity: -1, returnedReceivable: -113 })]);
  assert.equal(partial.status, 'estimated');
  assert.equal(partial.netRevenue, 100);
  assert.equal(partial.grossProfit, 100);
  const full = calculateOrder([baseRow({ purchaseUnitCost: null, returnedQuantity: -1, returnedReceivable: -113 })]);
  assert.equal(full.status, 'estimated');
  assert.equal(full.grossProfit, 0);
});

test('汇总将合法零成本纳入毛利、真实缺成本维持待补计数', () => {
  const ready = calculateOrder([baseRow({ purchaseUnitCost: 0, purchaseCostStatus: 'ready' })]);
  const pending = calculateOrder([baseRow({ purchaseUnitCost: null })]);
  const result = summarize([ready, pending], 0);
  assert.equal(result.pendingOrderCount, 1);
  assert.equal(result.grossProfit, 100);
});

test('财务查询带出确认状态与冻结成本，且只读不写回历史订单', async t => {
  const { sequelize } = require('../src/models');
  const queries = [];
  t.mock.method(sequelize, 'query', async sql => { queries.push(sql); return []; });
  await queryFinancialProfit({ storeIds: ['store'], startDate: '2026-10-01', endDate: '2026-10-22' });
  const salesQuery = queries.find(sql => sql.includes('FROM T_ORDER o'));
  assert.match(salesQuery, /COST_STATUS AS purchaseCostStatus/);
  assert.match(salesQuery, /PRODUCT_PRICING_DETAILS AS frozenPricingDetails/);
  assert.match(salesQuery, /COALESCE\(o.ARCHIVE_TIME,o.CREATE_TIME\)/);
  assert.ok(queries.every(sql => !/\b(?:UPDATE|INSERT|DELETE)\b/i.test(sql)));
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
  assert.match(migration, /20261023_financial_profit_control\.sql/);
  assert.match(migration, /finance_profit_statement/);
  assert.match(routes, /financial-profit-orders\/export/);
  assert.match(routes, /financial-profit-orders'/);
});
