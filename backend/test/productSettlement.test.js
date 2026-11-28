const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../src/modules/report/productSettlement');

test('confirmed zero purchase snapshot survives positive fallback and missing pricing remains pending', () => {
  const input = { item: { item_id: 1, quantity: 1, sn_id: 's', original_inventory_cost: 500 },
    product: { need_sn: 1 }, productPrice: { standard_price: 100, cost_price: 500 },
    productPricingDetail: { unitPricing: 100, purchasePrice: 0, purchasePriceKnown: true, source: 'purchase_price' } };
  const ready = _test.buildProductSettlementItem(input);
  assert.equal(ready.purchase_unit_cost, 0);
  assert.equal(ready.cost_status, 'ready');
  assert.equal(ready.gross_profit_amount, 100);
  input.productPricingDetail.source = 'missing_company_price';
  input.productPricingDetail.unitPricing = 0;
  assert.equal(_test.buildProductSettlementItem(input).cost_status, 'pending');
});

test('SN 产品端结算使用订单产品定价和 SN 实际采购成本', () => {
  const item = _test.buildProductSettlementItem({
    item: {
      item_id: 1,
      product_id: 'P1',
      product_name: '笔记本',
      sn_id: 'SN1',
      sn_code: 'ABC',
      quantity: 1,
      original_inventory_cost: 4300
    },
    product: { product_id: 'P1', need_sn: 1 },
    productPrice: { standard_price: 4800, cost_price: 4300 },
    productPricingDetail: { itemId: 1, unitPricing: 5000, source: 'sn_special_price' },
    sn: { sn_id: 'SN1', sn_code: 'ABC', inbound_price: 4200 }
  });

  assert.equal(item.cost_method, 'sn_actual_cost');
  assert.equal(item.product_unit_price, 5000);
  assert.equal(item.purchase_unit_cost, 4300);
  assert.equal(item.gross_profit_amount, 700);
  assert.equal(item.cost_status, 'ready');
});

test('非 SN 产品端结算按归档时的加权平均成本计算', () => {
  const item = _test.buildProductSettlementItem({
    item: { item_id: 2, product_id: 'P2', quantity: 2, original_inventory_cost: 100 },
    product: { product_id: 'P2', need_sn: 0 },
    productPrice: { standard_price: 120, cost_price: 100 },
    productPricingDetail: { itemId: 2, unitPricing: 120, source: 'product_standard_price' }
  });

  assert.equal(item.cost_method, 'weighted_average');
  assert.equal(item.purchase_cost_amount, 200);
  assert.equal(item.gross_profit_amount, 40);
});

test('缺少成本时产品端结算进入待补成本，不生成虚假毛利', () => {
  const item = _test.buildProductSettlementItem({
    item: { item_id: 3, product_id: 'P3', quantity: 1 },
    product: { product_id: 'P3', need_sn: 0 },
    productPrice: { standard_price: 300, cost_price: 0 },
    productPricingDetail: { itemId: 3, unitPricing: 300 }
  });
  const summary = _test.summarizeProductSettlementItems([item]);

  assert.equal(summary.status, 'cost_pending');
  assert.equal(summary.grossProfitAmount, 0);
  assert.equal(summary.costPendingAmount, 300);
});

test('产品端退货负向明细的金额可以与正向结算相抵', () => {
  const summary = _test.summarizeProductSettlementItems([
    { quantity: -1, product_unit_price: 5000, purchase_cost_amount: -4300, cost_status: 'ready' }
  ]);

  assert.equal(summary.productPricingAmount, -5000);
  assert.equal(summary.purchaseCostAmount, -4300);
  assert.equal(summary.grossProfitAmount, -700);
});

test('产品端毛利清单查询同时覆盖销售结算和退货调整并支持业务筛选', () => {
  const query = _test.buildProductSettlementEntrySql({
    storeIds: ['STORE1'],
    status: 'posted',
    entryType: 'return',
    keyword: 'SN001',
    settlementNo: 'PSET',
    sourceOrderNo: 'SO'
  });

  assert.match(query.sql, /FROM T_PRODUCT_SETTLEMENT_ORDER/);
  assert.match(query.sql, /FROM T_PRODUCT_SETTLEMENT_ADJUSTMENT/);
  assert.match(query.sql, /T_PRODUCT_SETTLEMENT_ADJUSTMENT_ITEM/);
  assert.match(query.sql, /entries\.ENTRY_TYPE = :entryType/);
  assert.equal(query.replacements.entryType, 'return');
  assert.equal(query.replacements.storeIds[0], 'STORE1');
  assert.equal(query.replacements.itemKeyword, '%SN001%');
});

test('待补说明区分零定价与零成本，已确认零成本仍展示计算', () => {
  const pending = _test.explainSettlementItem({ cost_status: 'pending', product_unit_price: 0, purchase_unit_cost: 0, quantity: 1 });
  assert.match(pending.pendingReason, /零元定价/);
  assert.match(pending.pendingReason, /采购成本/);
  const ready = _test.explainSettlementItem({ cost_status: 'ready', product_unit_price: 100, purchase_unit_cost: 0, quantity: 2, gross_profit_amount: 200, cost_source: 'locked_zero_inventory_cost' });
  assert.equal(ready.pendingReason, '');
  assert.match(ready.calculation, /200/);
  const returned = _test.explainSettlementItem({ cost_status: 'ready', product_unit_price: 100, purchase_unit_cost: 80, quantity: -2, gross_profit_amount: -40 });
  assert.match(returned.calculation, /-40/);
});
