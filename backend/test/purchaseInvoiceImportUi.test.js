const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('发票管理提供未登记清单导出和登记导入', () => {
  const routes = read('backend/src/modules/finance/routes.js');
  const api = read('frontend/web/src/api/index.js');
  const view = read('frontend/web/src/views/PurchaseInvoiceManagement.vue');

  assert.match(routes, /purchase-invoices\/candidates\/export/);
  assert.match(routes, /purchase-invoices\/import/);
  assert.match(api, /exportPurchaseInvoiceCandidates/);
  assert.match(api, /importPurchaseInvoices/);
  assert.match(view, /导出未登记发票/);
  assert.match(view, /导入发票登记/);
  assert.doesNotMatch(view, /v-model="form\.invoiceCode"/);
});
