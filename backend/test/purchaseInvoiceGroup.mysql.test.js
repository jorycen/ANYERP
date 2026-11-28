const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const M = require('../src/models');
const C = require('../src/modules/finance/invoiceController');
test('MySQL temporary tables: multi-number registration, duplicate protection, whole-group return and reregistration',
  { skip: process.env.RUN_MYSQL_INVOICE_TEST !== '1' }, async t => {
  const runTransaction = M.sequelize.transaction.bind(M.sequelize);
  const names = ['T_PURCHASE_INVOICE', 'T_PURCHASE_INVOICE_ALLOCATION', 'T_SETTLEMENT_PAYMENT_RECORD', 'T_SETTLEMENT', 'T_BUSINESS_ACTION_LOG'];
  const all = [...names, 'T_PURCHASE_INVOICE_NUMBER'];
  try {
    await runTransaction(async outer => {
      const query = sql => M.sequelize.query(sql, { transaction: outer });
      try {
        for (const name of names) {
          const [schemaRows] = await query(`SHOW CREATE TABLE ${name}`);
          const ddl = schemaRows[0]['Create Table'];
          await query(ddl.replace(/^CREATE TABLE/, 'CREATE TEMPORARY TABLE'));
        }
        await query('ALTER TABLE T_PURCHASE_INVOICE MODIFY COLUMN SUPPLIER_TAX_NO VARCHAR(64) NULL');
        const migration = fs.readFileSync(require.resolve('../src/utils/dbMigration'), 'utf8');
        const ddl = migration.match(/checkAndCreateTable\('T_PURCHASE_INVOICE_NUMBER', `([^`]+)`\)/)[1];
        await query(ddl.replace('CREATE TABLE', 'CREATE TEMPORARY TABLE'));
        // ALTER TABLE implicitly commits in MySQL; start the test transaction
        // only after all temporary schema preparation has finished.
        await query('START TRANSACTION');
        t.mock.method(M.sequelize, 'transaction', callback => runTransaction({ transaction: outer }, callback));
        await M.Settlement.create({ settlement_id: 'TEST-S', settlement_no: 'TEST-S', distributor_id: 'TEST-D', supplier_name: 'test supplier',
          total_amount: 226, status: 'confirmed', tax_status: 'TAX_INCLUDED' }, { transaction: outer });
        for (const id of ['TEST-P1', 'TEST-P2']) await M.SettlementPaymentRecord.create({ payment_id: id, batch_id: 'TEST-B', settlement_id: 'TEST-S',
          settlement_no: 'TEST-S', supplier_name: 'test supplier', distributor_id: 'TEST-D', account_id: 'TEST-A', amount: 113, status: 'active' }, { transaction: outer });
        const request = paymentId => ({ invoiceNumbers: ['TEST-N1', 'TEST-N2'], invoiceDate: '2026-10-29', invoiceType: 'VAT',
          taxRate: 0.13, totalAmount: 113, allocations: [{ paymentId, amount: 113 }] });
        const ctx = body => ({ request: { body }, state: { user: { roles: ['boss'], staffId: 1, name: 'test' } },
          throw(status, message) { throw Object.assign(new Error(message), { status }); } });
        await C.createInvoice(ctx(request('TEST-P1')));
        let headers = await M.PurchaseInvoice.findAll({ transaction: outer });
        assert.equal(headers.length, 1); assert.equal(Number(headers[0].total_amount), 113);
        assert.equal(Number(headers[0].tax_amount), 13); assert.equal(headers[0].supplier_tax_no, null);
        assert.equal(await M.PurchaseInvoiceNumber.count({ transaction: outer }), 2);
        await assert.rejects(C.createInvoice(ctx({ ...request('TEST-P2'), invoiceNumbers: ['TEST-N2', 'TEST-N3'] })), /已登记/);
        const invoiceId = headers[0].invoice_id;
        await C.returnInvoice({ ...ctx({ reason: 'test correction' }), params: { invoiceId } });
        assert.equal(await C._test.activeInvoiceAmount('TEST-P1', outer), 0);
        await C.createInvoice(ctx(request('TEST-P1')));
        headers = await M.PurchaseInvoice.findAll({ transaction: outer });
        assert.equal(headers.length, 1); assert.equal(headers[0].invoice_id, invoiceId);
        assert.equal(await M.PurchaseInvoiceNumber.count({ transaction: outer }), 2);
        assert.equal(Number(await M.PurchaseInvoiceAllocation.sum('amount', { transaction: outer })), 113);
        const failAudit = t.mock.method(M.BusinessActionLog, 'create', async () => { throw new Error('audit failure after number insertion'); });
        await assert.rejects(C.createInvoice(ctx({ ...request('TEST-P2'), invoiceNumbers: ['TEST-N3', 'TEST-N4'] })), /audit failure/);
        failAudit.mock.restore();
        assert.equal(await M.PurchaseInvoice.count({ transaction: outer }), 1);
        assert.equal(await M.PurchaseInvoiceNumber.count({ transaction: outer }), 2);
        assert.equal(Number(await M.PurchaseInvoiceAllocation.sum('amount', { transaction: outer })), 113);
        const listContext = { query: { keyword: 'TEST-N2' }, state: ctx({}).state };
        // Force the list's read calls onto the connection that owns the temporary tables.
        const originalQuery = M.sequelize.query.bind(M.sequelize);
        t.mock.method(M.sequelize, 'query', (sql, options) => originalQuery(sql, { ...options, transaction: options?.transaction || outer }));
        await C.listInvoices(listContext);
        assert.equal(listContext.body.data.list.length, 1);
        assert.equal(listContext.body.data.list[0].get('invoice_numbers').length, 2);
      } finally {
        for (const name of all.reverse()) await query(`DROP TEMPORARY TABLE IF EXISTS ${name}`);
      }
    });
  } finally { await M.sequelize.close(); }
});
