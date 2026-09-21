const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../src/modules/finance/invoiceController');

test('采购发票按结算单合并多笔付款分摊', () => {
  const settlementMap = new Map([['SETTLEMENT_1', {
    settlement_no: 'S202609190001',
    total_amount: 1200,
    status: 'confirmed',
    payment_status: 'paid'
  }]]);
  const links = _test.buildInvoiceSettlementLinks([
    { settlement_id: 'SETTLEMENT_1', amount: 300.11 },
    { settlement_id: 'SETTLEMENT_1', amount: 699.89 }
  ], settlementMap);

  assert.deepEqual(links, [{
    settlement_id: 'SETTLEMENT_1',
    settlement_no: 'S202609190001',
    allocation_amount: 1000,
    settlement_total_amount: 1200,
    status: 'confirmed',
    payment_status: 'paid'
  }]);
});

test('采购发票导出逐结算单展示关联和分摊金额', () => {
  const rows = _test.invoiceExportRows([{
    supplier_name: '测试供应商',
    supplier_tax_no: '91510000TEST',
    invoice_code: 'INV-CODE',
    invoice_no: 'INV-NO',
    invoice_date: '2026-09-19',
    invoice_type: '增值税专用发票',
    tax_rate: 0.13,
    amount_without_tax: 884.96,
    tax_amount: 115.04,
    total_amount: 1000,
    settlement_links: [
      { settlement_no: 'S202609190001', allocation_amount: 600 },
      { settlement_no: 'S202609190002', allocation_amount: 400 }
    ],
    create_user: '财务员',
    create_time: '2026-09-19 10:00:00',
    remark: '测试'
  }]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].关联结算单, 'S202609190001');
  assert.equal(rows[0].本票分摊金额, 600);
  assert.equal(rows[1].关联结算单, 'S202609190002');
  assert.equal(rows[1].本票分摊金额, 400);
  assert.equal(rows[0].税率, '13%');
  assert.equal(Object.hasOwn(rows[0], '发票代码'), false);
});

test('发票导入跳过空白行并要求税号与发票号码同时填写', () => {
  const result = _test.normalizeInvoiceImportRows([
    { 付款流水ID: 'PAY-1', 税号: '', 发票号码: '' },
    { 付款流水ID: 'PAY-2', 税号: '91510000TEST', 发票号码: 'INV-2' },
    { 付款流水ID: 'PAY-3', 税号: '91510000ONLY', 发票号码: '' }
  ]);

  assert.deepEqual(result.selected, [{ row: 3, paymentId: 'PAY-2', supplierTaxNo: '91510000TEST', invoiceNo: 'INV-2' }]);
  assert.deepEqual(result.errors, [{ row: 4, message: '税号和发票号码必须同时填写' }]);
});

test('发票导入拒绝重复付款流水', () => {
  const result = _test.normalizeInvoiceImportRows([
    { 付款流水ID: 'PAY-1', 税号: 'TAX-1', 发票号码: 'INV-1' },
    { 付款流水ID: 'PAY-1', 税号: 'TAX-1', 发票号码: 'INV-1' }
  ]);

  assert.equal(result.selected.length, 1);
  assert.deepEqual(result.errors, [{ row: 3, message: '付款流水ID重复' }]);
});
