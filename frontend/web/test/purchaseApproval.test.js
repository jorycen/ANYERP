import test from 'node:test'
import assert from 'node:assert/strict'
import { purchaseApprovalForm, purchaseApprovalPayload } from '../src/utils/purchaseApproval.js'
test('approval form loads current per-item basis and emits a limited payload without pricing or quantities', () => {
  const form = purchaseApprovalForm({ invoice_type: '收据', payment_method: 'COMPANY_CREDIT', items: [
    { item_id: 7, product_name: 'A', unit_price: 100, quantity: 3, gross_profit_cost_mode: 'COMPANY_PRICE' }
  ] })
  assert.equal(form.items[0].grossProfitCostMode, 'COMPANY_PRICE')
  form.invoiceType = '专票13%'
  form.paymentMethod = 'PERSONAL_ADVANCE'
  const payload = purchaseApprovalPayload(form)
  assert.deepEqual(payload, { invoiceType: '专票13%', paymentMethod: 'PERSONAL_ADVANCE', items: [{ itemId: 7, grossProfitCostMode: 'COMPANY_PRICE' }] })
})
