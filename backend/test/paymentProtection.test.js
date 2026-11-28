const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const C = require('../src/modules/finance/payableController');
const context = body => ({ request: { body }, state: { user: { roles: ['boss'], name: 'tester' } },
  throw(status, message) { throw Object.assign(new Error(message), { status }); } });

test('posted payment batch cannot be reversed or write account transactions', async t => {
  t.mock.method(M.SettlementPaymentBatch, 'findByPk', async () => ({ status: 'active', distributor_id: 'D' }));
  t.mock.method(M.sequelize, 'transaction', async () => assert.fail('No balance changes allowed'));
  await assert.rejects(C.voidPaymentBatch(context({ batchId: 'B' })), /已支付的金额不能撤销/);
});

test('negative settlement validates and preserves account snapshots and other account evidence', async t => {
  t.mock.method(M.sequelize, 'query', async () => assert.fail('No live database access'));
  t.mock.method(M.sequelize, 'transaction', async fn => fn({ LOCK: { UPDATE: 'UPDATE' } }));
  t.mock.method(M.Supplier, 'findByPk', async () => ({ name: 'Supplier' }));
  t.mock.method(M.Payable, 'findAll', async () => [{ payable_id: 'P', supplier_id: 'SUP', distributor_id: 'D', source_type: 'purchase_return', total_amount: -50, offset_amount: 0 }]);
  t.mock.method(M.SettlementItem, 'findAll', async () => []);
  t.mock.method(M.SupplierPaymentAccount, 'findOne', async ({ where }) => {
    assert.equal(where.supplier_id, 'SUP');
    return { account_id: 'A', bank_name: 'Bank', account_number: '001234' };
  });
  let captured;
  const stop = new Error('snapshot captured');
  t.mock.method(M.Settlement, 'create', async values => { captured = values; throw stop; });
  const body = { supplierId: 'SUP', payableIds: ['P'], allocations: [{ payableId: 'P', amount: -50 }] };
  await assert.rejects(C.createSettlement(context(body)), /请选择供应商付款账户/);
  await assert.rejects(C.createSettlement(context({ ...body, supplierAccountId: 'A' })), error => error === stop);
  assert.equal(captured.total_amount, -50);
  assert.equal(captured.payment_status, 'pending_refund');
  assert.equal(captured.supplier_account_id, 'A');
  assert.equal(JSON.parse(captured.supplier_account_snapshot).accountNumber, '001234');
  await assert.rejects(C.createSettlement(context({ ...body, paymentAccountType: 'other' })), /说明并上传凭证/);
  await assert.rejects(C.createSettlement(context({ ...body, paymentAccountType: 'other', otherPaymentRemark: 'refund', otherPaymentImage: 'image' })), error => error === stop);
  assert.equal(captured.other_payment_remark, 'refund');
  assert.equal(captured.other_payment_image, 'image');
  await assert.rejects(C.createSettlement(context({ ...body, paymentAccountType: 'rebate' })), /负额结算不能使用返款/);
});
