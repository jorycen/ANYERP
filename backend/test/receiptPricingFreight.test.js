const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const GP = require('../src/modules/sales/grossProfit');

test('sales may precede purchase approval: freight cutoff is archive time and later changes stay excluded', () => {
  const base = { orderStoreId: 'store', orderCreatedAt: '2026-10-19T14:19:31+08:00',
    orderArchiveAt: '2026-10-19T18:50:27+08:00', storeId: 'store', sourceType: 'purchase',
    sourceCreatedAt: '2026-10-19T14:13:21+08:00', sourceUpdatedAt: '2026-10-19T14:52:21+08:00' };
  assert.equal(GP.isFreightRecordApplicableToOrder(base), true);
  assert.equal(GP.isFreightRecordApplicableToOrder({ ...base, sourceUpdatedAt: '2026-10-20T10:00:00+08:00' }), false);
  assert.equal(GP.isFreightRecordApplicableToOrder({ ...base, storeId: 'other' }), false);
});

test('台机 is a computer category for the independent external fee; repair accessories remain excluded', () => {
  assert.equal(GP.isExternalAdjustmentEligibleProduct({ category: '台机', productName: '小新 27-AKP' }), true);
  assert.equal(GP.isExternalAdjustmentEligibleProduct({ category: '电脑配件', productName: '维修配件' }), false);
});

test('transfers carry original SN pricing mode, unit cost and fee snapshot across stores', async t => {
  t.mock.method(M.ProductSn, 'findByPk', async () => ({ gross_profit_use_standard_price: 0,
    inbound_price: 4500, gross_profit_uplift_amount: 200 }));
  t.mock.method(M.Product, 'findByPk', async () => ({ gross_profit_cost_mode: 'COMPANY_PRICE' }));
  const result = await require('../src/modules/inventory/controller')._test.readTransferPricing({ product_id: 'p', sn_id: 's' }, 'from', {});
  assert.deepEqual(result, { gross_profit_use_standard_price: 0, gross_profit_uplift_amount: 200, unit_price: 4500 });
});

test('two SN of same product retain different receipt modes and original uplift despite master changes', async t => {
  const items = [{ item_id: 1, product_id: 'p', sn_id: 'external', sn_code: 'EXT', quantity: 1 },
    { item_id: 2, product_id: 'p', sn_id: 'company', sn_code: 'OWN', quantity: 1 }];
  t.mock.method(M.Order, 'findByPk', async () => ({ order_id: 'o', store_id: 'store', create_time: new Date() }));
  t.mock.method(M.OrderItem, 'findAll', async () => items.map(row => ({ ...row, toJSON: () => row })));
  t.mock.method(M.Product, 'findAll', async () => [{ product_id: 'p', category: '台机', gross_profit_cost_mode: 'COMPANY_PRICE' }]);
  t.mock.method(M.ProductPrice, 'findAll', async () => [{ product_id: 'p', status: 1, standard_price: 4249 }]);
  t.mock.method(M.ProductSn, 'findAll', async () => [
    { sn_id: 'external', sn_code: 'EXT', supplier_id: 's', inbound_price: 4500, gross_profit_use_standard_price: 0, gross_profit_uplift_amount: 200 },
    { sn_id: 'company', sn_code: 'OWN', supplier_id: 's', inbound_price: 4000, gross_profit_use_standard_price: 1, gross_profit_uplift_amount: 0 }
  ]);
  t.mock.method(M.Supplier, 'findAll', async () => [{ supplier_id: 's', gross_profit_uplift_amount: 999 }]);
  t.mock.method(M.SnDistributorPrice, 'findAll', async () => []);
  t.mock.method(M.sequelize, 'query', async () => []);
  const rows = await GP.buildProductPricingDetails('o');
  assert.equal(rows[0].unitPricing, 4500);
  assert.equal(rows[0].isCompanyPriced, false);
  assert.equal(rows[0].grossProfitUpliftAmount, 200);
  assert.equal(rows[1].unitPricing, 4249);
  assert.equal(rows[1].grossProfitUpliftAmount, 0);
});

test('non-SN receipt snapshot overrides product defaults and carries exact freight provenance', async t => {
  const item = { item_id: 1, product_id: 'p', quantity: 1 };
  t.mock.method(M.Order, 'findByPk', async () => ({ order_id: 'o', store_id: 'store', create_time: new Date() }));
  t.mock.method(M.OrderItem, 'findAll', async () => [{ ...item, toJSON: () => item }]);
  t.mock.method(M.Product, 'findAll', async () => [{ product_id: 'p', category: '选件', gross_profit_cost_mode: 'COMPANY_PRICE' }]);
  t.mock.method(M.ProductPrice, 'findAll', async () => [{ product_id: 'p', status: 1, standard_price: 999 }]);
  t.mock.method(M.ProductSn, 'findAll', async () => []);
  t.mock.method(M.Supplier, 'findAll', async () => []);
  t.mock.method(M.SnDistributorPrice, 'findAll', async () => []);
  t.mock.method(M.sequelize, 'query', async () => [{ product_id: 'p', inbound_price: 80, pricing_mode_snapshot: 0,
    receipt_item_id: 7, source_type: 'purchase', purchase_request_id: 'PR', receipt_source_no: 'PRNO', uplift_snapshot: 0 }]);
  const rows = await GP.buildProductPricingDetails('o');
  assert.equal(rows[0].unitPricing, 80);
  assert.equal(rows[0].pricingOrigin.sourceId, 'PR');
  t.mock.method(M.FreightRecordItem, 'findAll', async () => [{ toJSON: () => ({ product_id: 'p', quantity: 1, unit_amount: 12,
    freightRecord: { source_type: 'purchase', source_id: 'PR', source_no: 'PRNO', store_id: 'store', create_time: new Date(0) } }) }]);
  const freight = await GP.buildFreightCostDetails({ order_id: 'o', store_id: 'store', create_time: new Date() }, null, rows);
  assert.equal(freight[0].amount, 12);
});

test('forced supplement recalculation preserves final pricing and freight without querying live masters', async t => {
  const line = { itemId: 1, productId: 'p', quantity: 1, unitPricing: 80, pricingAmount: 80, source: 'purchase_price' };
  const freight = { source: 'freight_cost', amount: 19.75 };
  t.mock.method(M.Order, 'findByPk', async () => ({ order_id: 'o', order_no: 'O', store_id: 'store', order_status: '已归档',
    total_amount: 200, invoice_status: '不开票' }));
  t.mock.method(M.OrderGrossProfit, 'findOne', async () => ({ snapshot_status: 'final', product_pricing_details: [line], supplement_details: [freight] }));
  for (const model of [M.OrderPayment, M.DepositRedemption, M.PaymentMethod, M.PaymentMethodStore, M.OrderSupplement])
    t.mock.method(model, 'findAll', async () => []);
  t.mock.method(M.Product, 'findAll', async () => { throw new Error('must not reread live product pricing'); });
  t.mock.method(M.FreightRecordItem, 'findAll', async () => { throw new Error('must not reread edited freight'); });
  const result = await GP.calculateAndSaveOrderGrossProfit('o', { persist: false, force: true, final: false, requireComplete: true });
  assert.equal(result.product_pricing_amount, 80);
  assert.equal(result.freight_cost_amount, 19.75);
  assert.equal(result.snapshot_status, 'final');
});

test('freight list links archived sales through the frozen freight id instead of matching another purchase of same product', async t => {
  const row = id => ({ freight_id: id, items: [{ product_id: 'p' }] });
  const rows = [row('actual'), row('unrelated')];
  t.mock.method(M.FreightRecord, 'findAndCountAll', async () => ({ rows, count: 2 }));
  t.mock.method(M.OrderItem, 'findAll', async () => [{ item_id: 1, order_id: 'o', product_id: 'p',
    Order: { order_id: 'o', order_no: 'ORDER', store_id: 'store', archive_time: new Date() } }]);
  t.mock.method(M.OrderGrossProfit, 'findAll', async () => [{ order_id: 'o',
    supplement_details: [{ source: 'freight_cost', itemId: 1, freightId: 'actual', amount: 19.75 }] }]);
  const result = await require('../src/modules/finance/freightService').listFreightRecords({ user: { accessibleStoreIds: ['store'] } });
  assert.deepEqual(result.rows[0].related_order_nos, ['ORDER']);
  assert.deepEqual(result.rows[1].related_order_nos, []);
});

test('approved purchase-price correction preserves purchase mode and external fee on forced recalculation', async t => {
  const line = { itemId: 1, quantity: 1, unitPricing: 5800, pricingAmount: 5800, purchasePriceKnown: true,
    source: 'approved_purchase_price_correction', correctionId: 'batch', isCompanyPriced: false,
    costModeSnapshot: 'PURCHASE_PRICE', grossProfitUpliftAmount: 200, externalAdjustmentEligible: true };
  t.mock.method(M.Order, 'findByPk', async () => ({ order_id: 'o', order_no: 'O', store_id: 's', order_status: '已归档', total_amount: 7000, invoice_status: '不开票' }));
  t.mock.method(M.OrderGrossProfit, 'findOne', async () => ({ snapshot_status: 'final', product_pricing_details: [line], supplement_details: [{source:'freight_cost',amount:35}] }));
  for (const model of [M.OrderPayment, M.DepositRedemption, M.PaymentMethod, M.PaymentMethodStore, M.OrderSupplement]) t.mock.method(model, 'findAll', async () => []);
  const result = await GP.calculateAndSaveOrderGrossProfit('o', {force:true,persist:false});
  assert.equal(result.product_pricing_details[0].isCompanyPriced,false);
  assert.equal(result.gross_profit_amount,965);
});
