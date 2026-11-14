
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const M = require('../src/models');
const GP = require('../src/modules/sales/grossProfit');
const F = require('../src/modules/inventory/foundation');
const { summarizeProductSettlementItems } = require('../src/modules/report/productSettlement')._test;
const { recordBusinessAction } = require('../src/utils/businessActionLog');
const batch = 'ZERO-SERVICE-20261107-ORD202610061045475506';
const plain = value => JSON.parse(JSON.stringify(value));
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const user = { name: '用户明确确认（Codex会话）' };
const directory = path.resolve(__dirname, '../backup/order-corrections', batch);

(async () => {
  let backup, expected;
  await M.sequelize.transaction(async transaction => {
    const options = { transaction, lock: transaction.LOCK.UPDATE };
    const order = await M.Order.findOne({ where: { order_no: 'ORD202610061045475506' }, ...options });
    assert(order && !order.is_deleted);
    const store = await M.Store.findByPk(order.store_id, options);
    const closed = await M.sequelize.query("SELECT MONTH_KEY FROM T_FINANCIAL_PROFIT_PERIOD WHERE MONTH_KEY='2026-10' FOR UPDATE",
      { transaction, type: M.sequelize.QueryTypes.SELECT });
    assert.equal(closed.length, 0, 'Financial period closed');
    const period = await M.ExpenseAccountingPeriod.findOne({
      where: { distributor_id: store.distributor_id, month_key: '2026-10' }, ...options
    });
    assert(!period || period.status === 'open', 'Expense period closed');
    assert.equal(await M.SalesReturnRequest.count({ where: { order_id: order.order_id }, transaction }), 0);
    const adjustments = await M.PerformanceProfitAdjustment.findAll({ where: { order_id: order.order_id }, ...options });
    assert.equal(adjustments.length, 0, 'Existing adjustments require separate review');
    const items = await M.OrderItem.findAll({ where: { order_id: order.order_id }, ...options });
    assert.equal(items.length, 1);
    assert.equal(items[0].item_id, 45692);
    assert.equal(items[0].pn_code, 'ANY-FW-JCWX');
    assert.equal(Number(items[0].original_inventory_cost), 0);
    const snapshot = await M.OrderGrossProfit.findOne({ where: { order_id: order.order_id }, ...options });
    assert.equal(snapshot.snapshot_status, 'final');
    assert.equal(Number(snapshot.product_pricing_amount), 220);
    assert.equal(Number(snapshot.gross_profit_amount), -221.03);
    const settlement = await M.ProductSettlementOrder.findOne({ where: { source_order_id: order.order_id }, ...options });
    assert.equal(settlement.status, 'posted');
    const productItems = await M.ProductSettlementItem.findAll({ where: { settlement_id: settlement.settlement_id }, ...options });
    assert.equal(productItems.length, 1);
    assert.equal(productItems[0].source_order_item_id, 45692);
    assert.equal(Number(productItems[0].purchase_unit_cost), 0);
    assert.equal(Number(productItems[0].product_unit_price), 220);
    const ref = await M.InventoryFoundationRef.findByPk('order_item:45692', options);
    const basis = await M.InventoryFoundation.findByPk(ref.basis_id, options);
    assert.equal(basis.identity_key, 'import_sale:45692');
    assert.equal(await M.InventoryFoundationRef.count({ where: { basis_id: basis.basis_id }, transaction }), 1);
    assert.equal(Number(basis.purchase_cost), 220);
    const payments = await M.OrderPayment.findAll({ where: { order_id: order.order_id }, ...options });
    backup = { batch, order: plain(order), items: plain(items), snapshot: plain(snapshot),
      settlement: plain(settlement), productItems: plain(productItems), basis: plain(basis), payments: plain(payments) };
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'before.json'), JSON.stringify(backup, null, 2), { flag: 'wx' });

    const pricing = parse(snapshot.product_pricing_details).map(line => {
      assert.equal(Number(line.itemId), 45692);
      return { ...line, unitPricing: 0, pricingAmount: 0, purchasePrice: 0, purchasePriceKnown: true,
        source: 'user_confirmed_historical_purchase_cost', correctionBatch: batch };
    });
    const supplements = parse(snapshot.supplement_details);
    const values = GP.calculateGrossProfitValues({
      receivableAmount: snapshot.receivable_amount, invoiceAmount: snapshot.invoice_amount, invoiceStatus: order.invoice_status,
      productPricingDetails: pricing, paymentDetails: parse(snapshot.payment_fee_details),
      supplementDetails: supplements.filter(line => line.source !== 'freight_cost'),
      freightCostDetails: supplements.filter(line => line.source === 'freight_cost')
    });
    assert.equal(values.grossProfitAmount, -1.03);
    assert.equal(values.vatAmount, Number(snapshot.vat_amount));
    assert.equal(values.paymentFeeAmount, Number(snapshot.payment_fee_amount));
    assert.equal(values.freightCostAmount, Number(snapshot.freight_cost_amount));
    const catalog = (await F.currentCatalog([basis.toJSON()], transaction))[0];
    await F.update(basis.basis_id, { revision: basis.revision, invoiceType: basis.invoice_type,
      purchaseCost: 0, confirmZero: true, costMode: catalog.costMode, companyPrice: catalog.companyPrice,
      reason: '用户确认该笔检测维修实际成本为0元，原220元为当时价格错误，后续已修复；仅校正本单独立历史档案' }, user, transaction);
    await snapshot.update({ product_pricing_details: values.productPricingDetails, product_pricing_amount: values.productPricingAmount,
      gross_profit_amount: values.grossProfitAmount, calculated_by: batch, calculated_at: new Date() }, { transaction });
    await productItems[0].update({ product_unit_price: 0, gross_profit_amount: 0,
      product_price_source: 'user_confirmed_historical_purchase_cost' }, { transaction });
    const totals = summarizeProductSettlementItems(productItems.map(item => item.toJSON()));
    assert.equal(totals.productPricingAmount, 0);
    assert.equal(totals.grossProfitAmount, 0);
    await settlement.update({ product_pricing_amount: totals.productPricingAmount,
      gross_profit_amount: totals.grossProfitAmount }, { transaction });
    expected = { salesProfit: values.grossProfitAmount, productProfit: totals.grossProfitAmount };
    await recordBusinessAction({ businessType: 'sales_order', businessId: order.order_id, businessNo: order.order_no,
      action: 'correct_historical_zero_service_cost', user, comment: batch,
      detail: { authorization: '用户确认成本0元，历史商品价格错误，现已修复', beforeSalesProfit: -221.03,
        afterSalesProfit: expected.salesProfit, beforeProductProfit: 220, afterProductProfit: expected.productProfit,
        beforeCost: 220, afterCost: 0, preservedFreight: 11, preservedPaymentFee: 0.03 }, transaction });
  });
  const order = plain(await M.Order.findByPk(backup.order.order_id, { raw: true }));
  const items = plain(await M.OrderItem.findAll({ where: { order_id: backup.order.order_id }, raw: true }));
  const payments = plain(await M.OrderPayment.findAll({ where: { order_id: backup.order.order_id }, raw: true }));
  assert.deepEqual(order, backup.order);
  assert.deepEqual(items, backup.items);
  assert.deepEqual(payments, backup.payments);
  const snapshot = await M.OrderGrossProfit.findByPk(backup.snapshot.gross_profit_id, { raw: true });
  const product = await M.ProductSettlementOrder.findByPk(backup.settlement.settlement_id, { raw: true });
  const basis = await M.InventoryFoundation.findByPk(backup.basis.basis_id, { raw: true });
  assert.equal(Number(snapshot.product_pricing_amount), 0);
  assert.equal(Number(snapshot.gross_profit_amount), expected.salesProfit);
  assert.equal(Number(product.gross_profit_amount), expected.productProfit);
  assert.equal(Number(basis.purchase_cost), 0);
  const result = { batch, verified: true, cost: 0, salesProfit: expected.salesProfit,
    productProfit: expected.productProfit, freight: 11, paymentFee: 0.03 };
  fs.writeFileSync(path.join(directory, 'verified.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => M.sequelize.close());
