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
});
