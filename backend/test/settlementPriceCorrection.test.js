const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const GP = require('../src/modules/sales/grossProfit');
const C = require('../src/modules/report/settlementPriceCorrection');
const controller = require('../src/modules/report/profitAdjustmentController');
const runtime = require('../src/modules/approval/businessRuntime');
const tx = { LOCK: { UPDATE: 'UPDATE' } };
function row(value) { return { ...value, toJSON() { return JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(this).filter(([, value]) => typeof value !== 'function')))); }, async update(patch, options) { assert.equal(options.transaction, tx); Object.assign(this, patch); } }; }
function context(body = {}) { return { state: { user: { staffId: 7, name: '审核人', roles: ['admin'], accessibleStoreIds: ['S'] } }, query: {}, params: {}, files: [], request: { body }, throw(status, message) { throw Object.assign(new Error(message), { status }); } }; }
function fixture(t, extra = {}) {
  const line = { itemId: 9, productName: '笔记本', snCode: 'SN1', quantity: 1, unitPricing: 5500, pricingAmount: 5500, isCompanyPriced: true, source: 'product_standard_price', grossProfitUpliftAmount: 0, externalAdjustmentRuleVersion: 'SUPPLIER_UPLIFT_V2' };
  const computed = GP.calculateGrossProfitValues({ receivableAmount: 6000, productPricingDetails: [line] });
  const snapshot = row({ gross_profit_id: 'GP', order_id: 'O', formula_version: GP.FORMULA_VERSION, snapshot_status: 'final',
    receivable_amount: 6000, gross_profit_amount: computed.grossProfitAmount, payment_fee_amount: 0,
    payment_fee_details: [], product_pricing_details: [line], product_pricing_amount: 5500,
    invoice_amount: 0, vat_taxable_amount: 0, vat_amount: 0, supplement_amount: 0, freight_cost_amount: 0, supplement_details: [] });
  const order = row({ order_id: 'O', order_no: 'ORDER', order_status: '已归档', store_id: 'S', create_user: '员工', create_time: '2026-10-01T01:00:00Z', is_deleted: 0 });
  const settlement = row({ settlement_id: 'PS', source_order_id: 'O', business_date: '2026-10-01T01:00:00Z', status: 'posted', gross_profit_amount: 500, product_pricing_amount: 5500, purchase_cost_amount: 5000 });
  const item = row({ settlement_item_id: 1, source_order_item_id: 9, quantity: 1, product_unit_price: 5500, purchase_unit_cost: 5000, purchase_cost_amount: 5000, gross_profit_amount: 500, cost_status: 'ready' });
  const original = row({ item_id: 9, product_id: 'P', product_name: '笔记本', sn_code: 'SN1', quantity: 1, subtotal: 6000, sales_settlement_cost: 5500, sales_gross_profit: 500 });
  const logs = [];
  t.mock.method(M.Order, 'findByPk', async () => order);
  t.mock.method(M.Order, 'findOne', async () => order);
  t.mock.method(M.Store, 'findByPk', async () => row({ store_id: 'S' }));
  t.mock.method(M.SalesReturnRequest, 'findAll', async () => extra.returns || []);
  t.mock.method(M.OrderGrossProfit, 'findOne', async () => snapshot);
  t.mock.method(M.ProductSettlementOrder, 'findOne', async () => settlement);
  t.mock.method(M.ProductSettlementItem, 'findAll', async () => [item]);
  t.mock.method(M.OrderItem, 'findAll', async () => [original]);
  t.mock.method(M.sequelize, 'query', async () => extra.closed ? [{ MONTH_KEY: '2026-10' }] : []);
  t.mock.method(M.BusinessActionLog, 'create', async (value, options) => { assert.equal(options.transaction, tx); logs.push(value); return value; });
  t.mock.method(M.sequelize, 'transaction', async fn => {
    const tracked = [snapshot, settlement, item, original, ...(extra.tracked || [])];
    const saved = tracked.map(value => value.toJSON());
    try { return await fn(tx); } catch (error) {
      tracked.forEach((value, index) => { for (const key of Object.keys(value)) if (typeof value[key] !== 'function') delete value[key]; Object.assign(value, saved[index]); });
      logs.length = 0;
      throw error;
    }
  });
  return { snapshot, order, settlement, item, original, logs };
}
async function adjustmentFor(ctx) {
  const input = C.validate({ itemId: 9, unitPrice: 5300 });
  const selected = await C.select(ctx, 'O', input);
  return row({ adjustment_id: 'A', adjustment_no: 'PPA1', adjustment_type: C.TYPE, order_id: 'O', store_id: 'S',
    signed_amount: 0, status: 'pending_finance', reason: '原定价通知录错',
    correction_data: { input, evidence: '定价通知001', previewHash: selected.previewHash, result: selected.result } });
}

test('price validation rejects missing, signed, excess precision, exponent and unconfirmed zero', () => {
  for (const unitPrice of [undefined, null, '', true, -1, '1.001', '1e3']) assert.throws(() => C.validate({ itemId: 9, unitPrice }));
  assert.throws(() => C.validate({ itemId: 9, unitPrice: 0 }), /零元/);
  assert.equal(C.validate({ itemId: 9, unitPrice: 0, confirmZero: true }).unitPrice, 0);
});
test('read-only preview conserves internal transfer and does not touch prices or snapshots', async t => {
  const f = fixture(t), ctx = context();
  const selected = await C.select(ctx, 'O', { itemId: '9', unitPrice: 5300 });
  assert.equal(selected.result.salesDelta, 200); assert.equal(selected.result.productDelta, -200);
  assert.equal(selected.result.salesAfter + selected.result.productAfter, 1000);
  assert.equal(f.snapshot.gross_profit_amount, 500); assert.equal(f.item.product_unit_price, 5500);
  assert.equal(f.logs.length, 0);
  f.settlement.gross_profit_amount = 999;
  await assert.rejects(C.select(ctx, 'O', { itemId: '9', unitPrice: 5300 }), /明细与汇总金额不一致/);
  f.settlement.gross_profit_amount = 500; f.item.purchase_unit_cost = null;
  await assert.rejects(C.select(ctx, 'O', { itemId: '9', unitPrice: 5300 }), /未完整确认/);
});
test('preview preserves archived fee rates, invoices, supplements and freight; recalculates tax dependencies', () => {
  const lines = [{ itemId: 9, quantity: 2, unitPricing: 5500, pricingAmount: 11000, source: 'product_standard_price', isCompanyPriced: true }];
  const payments = [{ method: '微信', amount: 12000, taxRate: 0.6 }];
  const supplements = [{ amount: 100, amountType: 'increase' }], freight = [{ amount: 20, source: 'freight_cost' }];
  const v = GP.calculateGrossProfitValues({ receivableAmount: 12000, invoiceAmount: 12000, productPricingDetails: lines, paymentDetails: payments, supplementDetails: supplements, freightCostDetails: freight });
  const frozen = { formula_version: GP.FORMULA_VERSION, snapshot_status: 'final', receivable_amount: 12000, invoice_amount: 12000,
    product_pricing_details: lines, payment_fee_details: payments, supplement_details: [...supplements, ...freight],
    gross_profit_amount: v.grossProfitAmount, product_pricing_amount: v.productPricingAmount, vat_taxable_amount: v.vatTaxableAmount,
    supplement_amount: v.supplementAmount, freight_cost_amount: v.freightCostAmount, payment_fee_amount: v.paymentFeeAmount, vat_amount: v.vatAmount };
  const patch = C.snapshotPatch(frozen, 9, 5300);
  assert.equal(patch.product_pricing_amount, 10600); assert.equal(patch.vat_amount, 182);
  assert.equal(patch.gross_profit_amount - frozen.gross_profit_amount, 348);
  assert.equal(frozen.product_pricing_details[0].unitPricing, 5500);
  assert.throws(() => C.snapshotPatch({ ...frozen, gross_profit_amount: 999 }, 9, 5300), /归档计算依据/);
  assert.throws(() => C.snapshotPatch({ ...frozen, formula_version: 'OLD' }, 9, 5300), /现行归档/);
  assert.throws(() => C.snapshotPatch({ ...frozen, vat_amount: null }, 9, 5300), /不完整/);
  assert.throws(() => C.snapshotPatch({ ...frozen, payment_fee_details: 'invalid' }, 9, 5300), /不完整/);
});
test('unknown cost, purchase-price mode, closed period, returns and forbidden stores fail closed', async t => {
  for (const extra of [{ closed: true }, { returns: [{ return_id: 'R' }] }]) await t.test(JSON.stringify(extra), async sub => {
    fixture(sub, extra); await assert.rejects(C.select(context(), 'O', { itemId: '9', unitPrice: 5300 }));
  });
  await t.test('scope', async sub => { fixture(sub); const ctx = context(); ctx.state.user.accessibleStoreIds = ['OTHER']; await assert.rejects(C.select(ctx, 'O'), /无权/); });
  await t.test('unknown cost', async sub => { const f = fixture(sub); f.item.cost_status = 'pending'; await assert.rejects(C.select(context(), 'O'), /未完整确认/); });
  await t.test('purchase price', async sub => { const f = fixture(sub); f.snapshot.product_pricing_details[0].isCompanyPriced = false; await assert.rejects(C.select(context(), 'O', { itemId: '9', unitPrice: 5300 }), /采购价口径/); });
});
test('final approval updates both profit sources atomically, records original facts and never stacks a signed adjustment', async t => {
  const f = fixture(t), ctx = context(), a = await adjustmentFor(ctx);
  t.mock.method(M.PerformanceProfitAdjustment, 'findByPk', async () => a);
  t.mock.method(runtime, 'advance', async () => true);
  ctx.params.adjustmentId = a.adjustment_id;
  await controller.approveProfitAdjustment(ctx);
  assert.equal(a.status, 'approved'); assert.equal(a.signed_amount, 0);
  assert.equal(f.snapshot.gross_profit_amount, 700); assert.equal(f.settlement.gross_profit_amount, 300);
  assert.equal(f.original.sales_settlement_cost, 5300); assert.equal(f.item.product_unit_price, 5300);
  assert.equal(f.item.purchase_unit_cost, 5000); assert.equal(a.correction_data.result.before.snapshot.gross_profit_amount, 500);
  assert.equal(f.snapshot.product_pricing_details[0].correctionId, 'A'); assert.equal(f.logs.length, 1);
  const displayed = C.display(a.toJSON(), ctx.state.user); assert.equal(displayed.correction_sales_delta, 200); assert.equal(displayed.correction_product_delta, -200);
  assert.equal(displayed.correction_data, undefined);
  const restricted = C.display(a.toJSON(), { roles: ['clerk'] });
  assert.equal(restricted.correction_product_delta, null); assert.equal(restricted.correction_data, undefined);
  assert.equal(restricted.correction_sales_delta, 200);
  const publicPreview = C.previewResponse(a.correction_data.result, { roles: ['manager'] });
  assert.equal(publicPreview.productBefore, null); assert.equal(publicPreview.before, undefined); assert.equal(publicPreview.after, undefined);
});
test('intermediate approval and rejection do not change either profit source', async t => {
  const f = fixture(t), ctx = context(), a = await adjustmentFor(ctx);
  t.mock.method(M.PerformanceProfitAdjustment, 'findByPk', async () => a);
  ctx.params.adjustmentId = a.adjustment_id;
  t.mock.method(runtime, 'advance', async () => false);
  await controller.approveProfitAdjustment(ctx);
  assert.equal(f.snapshot.gross_profit_amount, 500); assert.equal(f.settlement.gross_profit_amount, 500); assert.equal(a.status, 'pending_finance');
  t.mock.method(runtime, 'advance', async () => true);
  ctx.request.body.comment = '依据不足'; await controller.rejectProfitAdjustment(ctx);
  assert.equal(a.status, 'rejected'); assert.equal(f.snapshot.gross_profit_amount, 500); assert.equal(f.logs.length, 0);
});
test('stale prices or failed product update roll back final approval effects', async t => {
  await t.test('stale', async sub => {
    const f = fixture(sub), ctx = context(), a = await adjustmentFor(ctx);
    f.snapshot.update_time = 'changed';
    await assert.rejects(C.apply(ctx, a, tx), /已变化/); assert.equal(f.snapshot.gross_profit_amount, 500);
  });
  await t.test('rollback', async sub => {
    const f = fixture(sub), ctx = context(), a = await adjustmentFor(ctx);
    sub.mock.method(M.PerformanceProfitAdjustment, 'findByPk', async () => a);
    sub.mock.method(runtime, 'advance', async () => true);
    sub.mock.method(f.item, 'update', async () => { throw new Error('write failed'); });
    ctx.params.adjustmentId = 'A'; await assert.rejects(controller.approveProfitAdjustment(ctx), /write failed/);
    assert.equal(f.snapshot.gross_profit_amount, 500); assert.equal(f.settlement.gross_profit_amount, 500); assert.equal(a.status, 'pending_finance');
  });
});
test('manual arbitrary increase is rejected; existing manual pending applications cannot be approved', async t => {
  const ctx = context({ orderId: 'O', adjustmentType: 'increase', amount: 100, reason: '奖励' });
  await assert.rejects(controller.createProfitAdjustment(ctx), /不再支持/);
  fixture(t);
  t.mock.method(M.PerformanceProfitAdjustment, 'findByPk', async () => row({ adjustment_type: 'increase', store_id: 'S', status: 'pending_finance' }));
  await assert.rejects(controller.approveProfitAdjustment(ctx), /历史手工增减/);
});
test('submission uses server preview, requires evidence, rejects stale or duplicate pending requests without changing profit', async t => {
  const f = fixture(t), ctx = context();
  const input = { itemId: '9', unitPrice: 5300 };
  const preview = await C.select(ctx, 'O', input);
  const saved = [];
  t.mock.method(M.PerformanceProfitAdjustment, 'findOne', async () => null);
  t.mock.method(M.PerformanceProfitAdjustment, 'create', async value => { saved.push(value); return row(value); });
  ctx.request.body = { orderId: 'O', adjustmentType: C.TYPE, ...input, reason: '原定价录错', evidence: '定价通知001', previewHash: preview.previewHash };
  await controller.createProfitAdjustment(ctx);
  assert.equal(saved.length, 1); assert.equal(saved[0].signed_amount, 0); assert.equal(saved[0].amount, 200);
  assert.equal(saved[0].correction_data.evidence, '定价通知001');
  assert.equal(f.snapshot.gross_profit_amount, 500); assert.equal(f.settlement.gross_profit_amount, 500);
  ctx.request.body.evidence = ''; await assert.rejects(controller.createProfitAdjustment(ctx), /定价依据/);
  ctx.request.body.evidence = '凭据001'; ctx.request.body.previewHash = 'old'; await assert.rejects(controller.createProfitAdjustment(ctx), /已变化/);
  ctx.request.body.previewHash = preview.previewHash;
  t.mock.method(M.PerformanceProfitAdjustment, 'findOne', async () => saved[0]);
  await assert.rejects(controller.createProfitAdjustment(ctx), /已有待审批/); assert.equal(saved.length, 1);
});
test('reversal is another evidenced price correction; original approved facts remain traceable', async t => {
  const f = fixture(t), ctx = context(), a = await adjustmentFor(ctx);
  await C.apply(ctx, a, tx);
  const selected = await C.select(ctx, 'O', { itemId: '9', unitPrice: 5500 });
  const reversal = row({ ...a.toJSON(), adjustment_id: 'B', adjustment_no: 'PPA2', correction_data: {
    input: { itemId: '9', unitPrice: 5500 }, evidence: '原定价通知重新核实', previewHash: selected.previewHash, result: selected.result
  } });
  await C.apply(ctx, reversal, tx);
  assert.equal(f.snapshot.gross_profit_amount, 500); assert.equal(f.settlement.gross_profit_amount, 500);
  assert.equal(a.correction_data.result.beforeUnitPrice, 5500); assert.equal(a.correction_data.result.afterUnitPrice, 5300);
  assert.equal(f.logs.length, 2);
});
