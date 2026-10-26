const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const { validPrice, resolveUnitProductPricing, calculateAndSaveOrderGrossProfit, snapshotToResponse } = require('../src/modules/sales/grossProfit');
const { applyCostPreview, applyFrozenCostDisplay } = require('../src/modules/sales/costPreview');

test('archived detail repairs legacy zero subtotals and uses frozen purchase and pricing costs without mutation', () => {
  const order = { OrderItems: [
    { item_id: 1, sale_price: '2200', quantity: 1, subtotal: '0', original_inventory_cost: 900 },
    { item_id: 2, sale_price: '0', quantity: 1, subtotal: '0', original_inventory_cost: 0 }
  ] };
  const snapshot = { snapshot_status: 'final', product_pricing_details: JSON.stringify([
    { itemId: 1, purchasePrice: 900, unitPricing: 900, source: 'purchase_price' },
    { itemId: 2, purchasePrice: 36, unitPricing: 38, source: 'product_standard_price' }
  ]) };
  const result = applyFrozenCostDisplay(order, snapshot);
  assert.equal(result.OrderItems[0].subtotal, 2200);
  assert.equal(result.OrderItems[0].sales_gross_profit, 1300);
  assert.equal(result.OrderItems[1].original_inventory_cost, 36);
  assert.equal(result.OrderItems[1].sales_settlement_cost, 38);
  assert.equal(result.OrderItems[1].subtotal, '0');
  assert.equal(order.OrderItems[0].subtotal, '0');
  assert.equal(order.OrderItems[1].original_inventory_cost, 0);
  assert.equal(applyFrozenCostDisplay(order, { ...snapshot, snapshot_status: 'draft' }).OrderItems[1].original_inventory_cost, 0);
  assert.equal(applyFrozenCostDisplay({ OrderItems: [{ sale_price: 100, quantity: 2, subtotal: 180 }] }, null).OrderItems[0].subtotal, 180);
});

test('zero company price is valid; missing, invalid or inactive prices are not zero prices', () => {
  const company = { costMode: 'COMPANY_PRICE' };
  assert.equal(resolveUnitProductPricing({ standard_price: '0.00', status: 1 }, { purchasePrice: 1500 }, null, company).source, 'product_standard_price');
  assert.equal(resolveUnitProductPricing({ standard_price: 0, status: 1 }, { purchasePrice: 1500 }, null, company).unitPricing, 0);
  for (const value of [null, undefined, '', ' ', 'bad', -1, Infinity, true]) {
    assert.equal(validPrice(value), null);
    assert.equal(resolveUnitProductPricing({ standard_price: value }, {}, null, company).source, 'missing_company_price');
  }
  assert.equal(resolveUnitProductPricing({ standard_price: 0, status: 0 }, {}, null, company).source, 'missing_company_price');
});

test('explicit zero SN special price and zero actual purchase cost do not fall back', () => {
  const special = resolveUnitProductPricing({ standard_price: 1500 }, { specialPrice: 0 }, null, { costMode: 'COMPANY_PRICE' });
  assert.equal(special.unitPricing, 0);
  assert.equal(special.source, 'sn_special_price');
  const purchase = resolveUnitProductPricing({ cost_price: 1500 }, { purchasePrice: 0 }, null, { costMode: 'PURCHASE_PRICE' });
  assert.equal(purchase.unitPricing, 0);
  assert.equal(purchase.source, 'purchase_price');
  assert.equal(resolveUnitProductPricing({}, { purchasePrice: null, original_inventory_cost: 0 }).source, 'missing_purchase_price');
});

function fixture(t, standardPrice) {
  const item = { item_id: 1, product_id: 'product', product_name: 'item', quantity: 1,
    subtotal: 1800, original_inventory_cost: 0, original_pickup_price: 0 };
  item.toJSON = () => ({ ...item });
  const order = { order_id: 'order', order_no: 'ORD', order_status: '未归档', store_id: 'store',
    total_amount: 1800, invoice_status: '不开票', create_time: '2026-10-22' };
  t.mock.method(M.Order, 'findByPk', async () => order);
  t.mock.method(M.OrderGrossProfit, 'findOne', async () => null);
  t.mock.method(M.OrderItem, 'findAll', async () => [item]);
  t.mock.method(M.Product, 'findAll', async () => [{ product_id: 'product', category: '二手', gross_profit_cost_mode: 'COMPANY_PRICE' }]);
  t.mock.method(M.ProductPrice, 'findAll', async () => [{ product_id: 'product', standard_price: standardPrice, status: 1, cost_price: 1500 }]);
  t.mock.method(M.sequelize, 'query', async () => []);
  t.mock.method(M.OrderPayment, 'findAll', async () => [{ payment_id: 1, payment_method: 'QR', amount: 1800 }]);
  t.mock.method(M.PaymentMethod, 'findAll', async () => [{ method_id: 'qr', name: 'QR', default_tax_rate: 0.3 }]);
  for (const model of [M.DepositRedemption, M.PaymentMethodStore, M.OrderSupplement, M.FreightRecordItem])
    t.mock.method(model, 'findAll', async () => []);
  for (const model of [M.OrderGrossProfit, M.OrderItem]) for (const method of ['create', 'update'])
    t.mock.method(model, method, () => { throw new Error('Preview must never write'); });
  for (const model of [M.SalesSettlementCostAdjustment, M.RebateEstimate, M.ResourceSettlement])
    if (model) t.mock.method(model, 'create', () => { throw new Error('Preview must not create settlement/rebate records'); });
  return { order, item };
}

test('非SN获赠与有价物料混库时冻结平均成本，不把最新获赠0元当作全库存成本',async t=>{
  fixture(t,250);
  t.mock.method(M.ProductPrice,'findAll',async()=>[{product_id:'product',standard_price:250,status:1,cost_price:100}]);
  t.mock.method(M.sequelize,'query',async sql=>sql.includes('ii.PRODUCT_ID AS product_id')?[{product_id:'product',inbound_price:0,source_type:'GIFT'}]:[]);
  const result=snapshotToResponse(await calculateAndSaveOrderGrossProfit('order',{persist:false,final:false}));
  assert.equal(result.productPricingDetails[0].purchasePrice,100);
  assert.equal(result.productPricingDetails[0].nonPurchaseSource,'GIFT');
  assert.equal(result.productPricingDetails[0].unitPricing,250);
});

test('有SN回收配件按公司定价展示销售毛利，同时冻结逐件回收成本',async t=>{
  const {item}=fixture(t,250);item.sn_id='SN';item.sn_code='RAM1';
  t.mock.method(M.ProductSn,'findAll',async()=>[{sn_id:'SN',sn_code:'RAM1',inbound_price:200,source_type:'SALES_COMPONENT_RECOVERY',gross_profit_use_standard_price:1}]);
  t.mock.method(M.Store,'findOne',async()=>null);
  const result=snapshotToResponse(await calculateAndSaveOrderGrossProfit('order',{persist:false,final:false}));
  assert.equal(result.productPricingDetails[0].purchasePrice,200);
  assert.equal(result.productPricingDetails[0].unitPricing,250);
  assert.equal(result.productPricingDetails[0].nonPurchaseSource,'SALES_COMPONENT_RECOVERY');
});

test('raw inbound cutoff uses Shanghai business time independently of container timezone', async t => {
  const { order } = fixture(t, 1500);
  order.create_time = new Date('2026-10-22T06:45:41.000Z');
  let checked = false;
  t.mock.method(M.sequelize, 'query', async (sql, options) => {
    if (sql.includes('i.CREATE_TIME <= :orderTime')) {
      assert.equal(options.replacements.orderTime, '2026-10-22 14:45:41.000');
      checked = true;
    }
    return [];
  });
  await calculateAndSaveOrderGrossProfit('order', { persist: false, final: false });
  assert.equal(checked, true);
});

test('unlocked default zero purchase cost is pending; explicitly locked zero is valid', async t => {
  fixture(t, 16050);
  t.mock.method(M.Product, 'findAll', async () => [{ product_id: 'product', category: '笔记本', gross_profit_cost_mode: 'PURCHASE_PRICE' }]);
  let locked = 0;
  t.mock.method(M.ProductPrice, 'findAll', async () => [{ product_id: 'product', standard_price: 16050, status: 1, cost_price: 0, cost_price_locked: locked }]);
  let preview = snapshotToResponse(await calculateAndSaveOrderGrossProfit('order', { persist: false, final: false }), {});
  assert.equal(preview.pricingComplete, false);
  assert.equal(preview.grossProfitAmount, null);
  locked = 1;
  preview = snapshotToResponse(await calculateAndSaveOrderGrossProfit('order', { persist: false, final: false }), {});
  assert.equal(preview.pricingComplete, true);
  assert.equal(preview.productPricingAmount, 0);
});

test('unarchived preview reads 1500 cost, returns 294.60 profit and leaves stored item zeroes untouched', async t => {
  const { order, item } = fixture(t, 1500);
  const snapshot = await calculateAndSaveOrderGrossProfit('order', { persist: false, final: false });
  const result = applyCostPreview({ ...order, OrderItems: [item] }, snapshot);
  assert.equal(result.cost_preview.grossProfitAmount, 294.6);
  assert.equal(result.OrderItems[0].sales_settlement_cost, 1500);
  assert.equal(result.OrderItems[0].sales_gross_profit, 300);
  assert.equal(item.original_inventory_cost, 0);
  assert.equal(item.sales_settlement_cost, undefined);
});

test('zero company cost remains a complete preview instead of using 1500 purchase cost', async t => {
  fixture(t, 0);
  const response = snapshotToResponse(await calculateAndSaveOrderGrossProfit('order', { persist: false, final: false }));
  assert.equal(response.pricingComplete, true);
  assert.equal(response.productPricingAmount, 0);
  assert.equal(response.grossProfitAmount, 1794.6);
});

test('zero actual SN cost and zero SN special price survive the full pricing lookup', async t => {
  const { item } = fixture(t, 1500);
  item.sn_id = 'sn';
  item.sn_code = 'SN';
  t.mock.method(M.ProductSn, 'findAll', async () => [{ sn_id: 'sn', sn_code: 'SN', inbound_price: 0 }]);
  t.mock.method(M.Store, 'findOne', async () => ({ distributor_id: 'dist' }));
  t.mock.method(M.SnDistributorPrice, 'findAll', async () => [{ sn_id: 'sn', sn_code: 'SN', special_price: 0 }]);
  let response = snapshotToResponse(await calculateAndSaveOrderGrossProfit('order', { persist: false, final: false }));
  assert.equal(response.productPricingAmount, 0);
  assert.equal(response.productPricingDetails[0].source, 'sn_special_price');
  assert.equal(response.productPricingDetails[0].purchasePrice, 0);
  t.mock.method(M.Product, 'findAll', async () => [{ product_id: 'product', gross_profit_cost_mode: 'PURCHASE_PRICE' }]);
  response = snapshotToResponse(await calculateAndSaveOrderGrossProfit('order', { persist: false, final: false }));
  assert.equal(response.productPricingDetails[0].source, 'purchase_price');
  assert.equal(response.productPricingAmount, 0);
  assert.equal(response.pricingComplete, true);
});

test('list suppresses invalid draft profit but preserves an explicit zero-priced item', () => {
  const { _test } = require('../src/modules/sales/controller');
  const result = _test.normalizeSalesOrderListRow({ grossProfitSnapshot: {
    gross_profit_amount: 1794.6, snapshot_status: 'draft',
    product_pricing_details: [{ itemId: 1, unitPricing: 0, source: 'missing_company_price' }]
  } });
  assert.equal(result.gross_profit_amount, null);
  assert.equal(result.pricing_status, 'pending');
  assert.equal(result.grossProfitSnapshot.product_pricing_details, undefined);
  assert.equal(result.grossProfitSnapshot.gross_profit_amount, null);
  const zero = _test.normalizeSalesOrderListRow({ grossProfitSnapshot: {
    gross_profit_amount: 1794.6, snapshot_status: 'draft',
    product_pricing_details: [{ itemId: 1, unitPricing: 0, source: 'product_standard_price' }]
  } });
  assert.equal(zero.gross_profit_amount, 1794.6);
  assert.equal(zero.pricing_status, 'complete');
});

test('missing price suppresses draft profit and blocks archive validation without writing', async t => {
  fixture(t, null);
  const snapshot = await calculateAndSaveOrderGrossProfit('order', { persist: false, final: false });
  const response = snapshotToResponse(snapshot);
  assert.equal(response.pricingComplete, false);
  assert.equal(response.grossProfitAmount, null);
  assert.equal(response.missingCostItems.length, 1);
  await assert.rejects(calculateAndSaveOrderGrossProfit('order', { persist: false, final: false, requireComplete: true }), { code: 'ORDER_COST_PENDING' });
  await assert.rejects(calculateAndSaveOrderGrossProfit('order', { persist: false, final: true }), { code: 'ORDER_COST_PENDING' });
});

test('reading an archived old formula snapshot does not reprice or migrate historical costs', async t => {
  const archived = { snapshot_status: 'final', formula_version: 'OLD', gross_profit_amount: 123, product_pricing_details: [] };
  t.mock.method(M.Order, 'findByPk', async () => ({ order_id: 'order', order_status: '已归档' }));
  t.mock.method(M.OrderGrossProfit, 'findOne', async () => archived);
  t.mock.method(M.ProductPrice, 'findAll', () => { throw new Error('Must not read current prices for frozen snapshot'); });
  const result = await calculateAndSaveOrderGrossProfit('order', { persist: false });
  assert.equal(result, archived);
  assert.equal(result.gross_profit_amount, 123);
});
