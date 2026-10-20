const test = require('node:test');
const assert = require('node:assert/strict');
const { applyPurchaseApprovalEdits } = require('../src/modules/purchase/approvalEdits');
function fixture(edits, options = {}) {
  const writes = [], logs = [], transaction = { id: 'transaction' };
  const item = { item_id: 7, product_id: 'product', product_name: 'Laptop', gross_profit_cost_mode: 'PURCHASE_PRICE',
    is_used_product: options.used ? 1 : 0, async update(patch, opts) { assert.equal(opts.transaction, transaction); writes.push(patch); Object.assign(this, patch); } };
  const request = { request_id: 'r', request_no: 'PR1', supplier_id: 's', invoice_type: '收据', payment_method: 'COMPANY_CREDIT', items: [item],
    async update(patch, opts) { assert.equal(opts.transaction, transaction); writes.push(patch); Object.assign(this, patch); } };
  const ctx = { request: { body: { purchaseEdits: edits } }, state: { user: { staffId: 1 } }, throw(status, message) { throw Object.assign(new Error(message), { status }); } };
  const deps = { Supplier: { async findByPk() { return { purchase_cost_mode_allowed: options.allowed || 'COMPANY_PRICE,PURCHASE_PRICE' }; } },
    ProductPrice: { async findOne() { return { standard_price: options.price ?? 100 }; } } };
  return { request, item, writes, logs, run: () => applyPurchaseApprovalEdits(ctx, request, transaction, deps, async log => logs.push(log)) };
}
test('approval edits persist payment, invoice and item cost mode in one transaction with before/after audit', async () => {
  const f = fixture({ paymentMethod: 'PERSONAL_ADVANCE', invoiceType: '专票13%', items: [{ itemId: 7, grossProfitCostMode: 'COMPANY_PRICE' }] });
  await f.run();
  assert.equal(f.request.payment_method, 'PERSONAL_ADVANCE');
  assert.equal(f.request.invoice_type, '专票13%');
  assert.equal(f.item.gross_profit_cost_mode, 'COMPANY_PRICE');
  assert.equal(f.logs[0].detail.fields.invoice_type.before, '收据');
  assert.equal(f.logs[0].detail.items[0].before, 'PURCHASE_PRICE');
});
test('company-price edits reject missing prices before any write', async () => {
  const f = fixture({ invoiceType: '专票13%', items: [{ itemId: 7, grossProfitCostMode: 'COMPANY_PRICE' }] }, { price: 0 });
  await assert.rejects(f.run, /未维护有效公司定价/);
  assert.equal(f.writes.length, 0);
});
test('supplier restrictions and used product cost rules cannot be bypassed', async () => {
  for (const options of [{ allowed: 'PURCHASE_PRICE' }, { used: true }]) {
    const f = fixture({ items: [{ itemId: 7, grossProfitCostMode: 'COMPANY_PRICE' }] }, options);
    await assert.rejects(f.run, error => error.status === 400);
    assert.equal(f.writes.length, 0);
  }
});
test('foreign or duplicate item IDs, extra financial fields and invalid header enums are rejected', async () => {
  for (const edit of [{ items: [{ itemId: 999, grossProfitCostMode: 'PURCHASE_PRICE' }] },
    { items: [{ itemId: 7, grossProfitCostMode: 'PURCHASE_PRICE' }, { itemId: 7, grossProfitCostMode: 'PURCHASE_PRICE' }] },
    { totalAmount: 1 }, { paymentMethod: 'BAD' }, { invoiceType: 'BAD' }]) {
    const f = fixture(edit);
    await assert.rejects(f.run, error => error.status === 400);
    assert.equal(f.writes.length, 0);
  }
});
test('unchanged fields do not create writes or audit entries', async () => {
  const f = fixture({ invoiceType: '收据', paymentMethod: 'COMPANY_CREDIT', items: [{ itemId: 7, grossProfitCostMode: 'PURCHASE_PRICE' }] });
  await f.run(); assert.equal(f.writes.length, 0); assert.equal(f.logs.length, 0);
});
