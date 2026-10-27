const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
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
    const tracked = [order, snapshot, settlement, item, original, ...(extra.tracked || [])];
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

function invoiceFixture(t, extra = {}) {
  const f = fixture(t, extra);
  Object.assign(f.order, { invoice_amount: 0, invoice_status: '专票13%', total_amount: 6000, actual_payment: 6000 });
  return f;
}
async function invoiceAdjustment(ctx, amount = 6000) {
  const input = C.validate({ adjustmentType: C.INVOICE_TYPE, invoiceAmount: amount, confirmZero: amount === 0 });
  const selected = await C.select(ctx, 'O', input);
  return row({ adjustment_id: 'IA', adjustment_no: 'PPA-INV', adjustment_type: C.INVOICE_TYPE, order_id: 'O', store_id: 'S',
    status: 'pending_finance', signed_amount: 0, reason: '原开票金额录入错误', correction_data: { input, evidence: '发票001', previewHash: selected.previewHash, result: selected.result } });
}

test('开票金额格式、零元确认及存储长度明确校验', () => {
  assert.ok(C.INVOICE_TYPE.length <= 16);
  for (const invoiceAmount of [-1, true, '', null, '1.234', '1e3', Infinity, [6000], {}]) assert.throws(() => C.validate({adjustmentType:C.INVOICE_TYPE,invoiceAmount}), /开票金额/);
  assert.throws(() => C.validate({ adjustmentType:C.INVOICE_TYPE, invoiceAmount:0 }), /须明确确认/);
  assert.deepEqual(C.validate({ adjustmentType:C.INVOICE_TYPE, invoiceAmount:'0.00', confirmZero:'true' }), {type:C.INVOICE_TYPE,invoiceAmount:0});
});

test('开票预览按冻结金额重算税费及销售毛利，产品端、收款与定价保持', async t => {
  const f=invoiceFixture(t), ctx=context();
  const selected=await C.select(ctx,'O',{type:C.INVOICE_TYPE,invoiceAmount:6000});
  assert.equal(selected.result.vatAfter,65);
  assert.equal(selected.result.salesAfter,435);
  assert.equal(selected.result.salesDelta,-65);
  assert.equal(selected.result.productDelta,0);
  assert.equal(f.order.invoice_amount,0); assert.equal(f.snapshot.gross_profit_amount,500); assert.equal(f.logs.length,0);
  f.snapshot.product_pricing_details[0].isCompanyPriced=false;
  assert.equal((await C.select(ctx,'O',{type:C.INVOICE_TYPE,invoiceAmount:6000})).result.salesAfter,435);
});

test('开票纠错不因产品端待核算而补算采购成本，未知毛利不冒充零', async t => {
  const f=invoiceFixture(t),ctx=context();
  f.settlement.status='cost_pending';f.item.cost_status='pending';f.item.purchase_unit_cost=null;
  const selected=await C.select(ctx,'O',{type:C.INVOICE_TYPE,invoiceAmount:6000});
  assert.equal(selected.result.salesAfter,435);assert.equal(selected.result.productBefore,null);assert.equal(selected.result.productAfter,null);
  assert.equal(selected.result.productDelta,0);
  const a=await invoiceAdjustment(ctx);await C.apply(ctx,a,tx);
  assert.equal(f.item.purchase_unit_cost,null);assert.equal(f.settlement.status,'cost_pending');
  t.mock.method(M.ProductSettlementOrder,'findOne',async()=>null);
  const back=await C.select(ctx,'O',{type:C.INVOICE_TYPE,invoiceAmount:0});
  assert.equal(back.result.productBefore,null);assert.equal(back.result.salesAfter,500);
});

test('开票最终审批事务更新订单与快照，不重复叠加调整，产品端保持', async t => {
  const f=invoiceFixture(t),ctx=context(),a=await invoiceAdjustment(ctx);
  const productBefore=JSON.stringify(f.settlement.toJSON()),itemBefore=JSON.stringify(f.item.toJSON()),orderItemBefore=JSON.stringify(f.original.toJSON());
  t.mock.method(M.PerformanceProfitAdjustment,'findByPk',async()=>a);
  t.mock.method(runtime,'advance',async()=>true);
  ctx.params.adjustmentId='IA';await controller.approveProfitAdjustment(ctx);
  assert.equal(f.order.invoice_amount,6000);assert.equal(f.snapshot.invoice_amount,6000);
  assert.equal(f.snapshot.vat_amount,65);assert.equal(f.snapshot.gross_profit_amount,435);
  assert.equal(a.status,'approved');assert.equal(a.signed_amount,0);
  assert.equal(f.order.actual_payment,6000);assert.equal(f.order.invoice_status,'专票13%');
  assert.equal(JSON.stringify(f.settlement.toJSON()),productBefore);assert.equal(JSON.stringify(f.item.toJSON()),itemBefore);assert.equal(JSON.stringify(f.original.toJSON()),orderItemBefore);
  assert.equal(f.logs.length,1);assert.equal(a.correction_data.result.before.order.invoice_amount,0);
  const view=C.display(a.toJSON(),ctx.state.user);
  assert.equal(view.correction_type_name,'开票金额错误');assert.equal(view.correction_after_invoice_amount,6000);
  assert.equal(view.correction_before_price,undefined);assert.equal(view.correction_data,undefined);
});

test('开票提交与中间审批不改业务，同订单两类待审批纠错相互排斥', async t => {
  const f=invoiceFixture(t),ctx=context(),a=await invoiceAdjustment(ctx),saved=[];
  t.mock.method(M.PerformanceProfitAdjustment,'findOne',async options=>{ assert.deepEqual(options.where.adjustment_type[Op.in],[C.TYPE,C.INVOICE_TYPE]);return null; });
  t.mock.method(M.PerformanceProfitAdjustment,'create',async value=>{saved.push(value);return row(value);});
  ctx.request.body={orderId:'O',adjustmentType:C.INVOICE_TYPE,invoiceAmount:6000,reason:'金额错误',evidence:'发票001',previewHash:a.correction_data.previewHash};
  await controller.createProfitAdjustment(ctx);
  assert.equal(saved[0].product_id,null);assert.equal(saved[0].signed_amount,0);assert.equal(saved[0].amount,65);
  assert.equal(f.order.invoice_amount,0);assert.equal(f.snapshot.gross_profit_amount,500);
  t.mock.method(M.PerformanceProfitAdjustment,'findOne',async()=>({adjustment_type:C.TYPE}));
  await assert.rejects(controller.createProfitAdjustment(ctx),/已有待审批业务纠错/);
  t.mock.method(M.PerformanceProfitAdjustment,'findByPk',async()=>a);t.mock.method(runtime,'advance',async()=>false);
  ctx.params.adjustmentId='IA';await controller.approveProfitAdjustment(ctx);
  assert.equal(f.order.invoice_amount,0);assert.equal(a.status,'pending_finance');
});

test('开票纠错拒绝关账、退货、缺失原金额、不开票、未变化及过期依据', async t => {
  for(const extra of [{closed:true},{returns:[{return_id:'R'}]}])await t.test(JSON.stringify(extra),async sub=>{
    invoiceFixture(sub,extra);await assert.rejects(C.select(context(),'O',{type:C.INVOICE_TYPE,invoiceAmount:6000}));
  });
  const f=invoiceFixture(t),ctx=context();
  await assert.rejects(C.select(ctx,'O',{type:C.INVOICE_TYPE,invoiceAmount:0}),/相同/);
  f.order.invoice_amount=null;await assert.rejects(C.select(ctx,'O',{type:C.INVOICE_TYPE,invoiceAmount:6000}),/不一致/);
  f.order.invoice_amount=0;f.order.invoice_status='不开票';await assert.rejects(C.select(ctx,'O',{type:C.INVOICE_TYPE,invoiceAmount:6000}),/不开票/);
  f.order.invoice_status='专票13%';const a=await invoiceAdjustment(ctx);f.order.actual_payment=5999;
  await assert.rejects(C.apply(ctx,a,tx),/已变化/);assert.equal(f.order.invoice_amount,0);
});

test('开票纠错写快照失败时订单金额一并回滚，反向纠错可恢复零元', async t => {
  await t.test('rollback',async sub=>{
    const f=invoiceFixture(sub),ctx=context(),a=await invoiceAdjustment(ctx);
    sub.mock.method(M.PerformanceProfitAdjustment,'findByPk',async()=>a);sub.mock.method(runtime,'advance',async()=>true);
    sub.mock.method(f.snapshot,'update',async()=>{throw Error('snapshot failed');});
    ctx.params.adjustmentId='IA';await assert.rejects(controller.approveProfitAdjustment(ctx),/snapshot failed/);
    assert.equal(f.order.invoice_amount,0);assert.equal(f.snapshot.invoice_amount,0);assert.equal(a.status,'pending_finance');
  });
  await t.test('reversal',async sub=>{
    const f=invoiceFixture(sub),ctx=context(),a=await invoiceAdjustment(ctx);
    await C.apply(ctx,a,tx);const reverse=await invoiceAdjustment(ctx,0);await C.apply(ctx,reverse,tx);
    assert.equal(f.order.invoice_amount,0);assert.equal(f.snapshot.gross_profit_amount,500);assert.equal(f.settlement.gross_profit_amount,500);
  });
});

test('Web切换纠错类型或开票金额使旧预览失效，延迟响应不得覆盖新输入', async () => {
  const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
  const view=fs.readFileSync(path.join(__dirname,'../../frontend/web/src/views/Reports.vue'),'utf8');
  const start=view.indexOf('watch(() => [adjustmentForm.adjustmentType');
  const watcher=view.slice(start,view.indexOf('const adjustmentParams',start));
  const requests=[];let observed,changed;
  const ctx={adjustmentForm:{adjustmentType:'price_correction',invoiceAmount:6000},correctionRequestVersion:0,
    correctionPreview:{value:{previewHash:'OLD'}},correctionPreviewing:{value:false},adjustmentApplyVisible:{value:true},
    adjustmentOrder:{value:{orderId:'O'}},watch:(source,callback)=>{observed=source;changed=callback;},
    api:{previewProfitCorrection:()=>new Promise(resolve=>requests.push(resolve))},ElMessage:{error(){throw Error('unexpected error');}}};
  vm.runInNewContext(watcher,ctx);
  const fnStart=view.indexOf('const previewCorrection = async () =>');
  const fn=view.slice(fnStart,view.indexOf('const resetAdjustmentForm',fnStart));
  vm.runInNewContext(fn+'\nglobalThis.runPreview=previewCorrection;',ctx);
  const pending=ctx.runPreview();
  ctx.adjustmentForm.adjustmentType='invoice_amount';ctx.adjustmentForm.invoiceAmount=6100;
  assert.ok(observed().includes('invoice_amount'));assert.ok(observed().includes(6100));
  changed();assert.equal(ctx.correctionPreview.value,null);
  requests[0]({data:{previewHash:'STALE'}});await pending;
  assert.equal(ctx.correctionPreview.value,null);
});
