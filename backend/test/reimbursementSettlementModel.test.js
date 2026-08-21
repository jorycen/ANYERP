const test = require('node:test');
const assert = require('node:assert/strict');
const { Settlement } = require('../src/models');

test('个人报销结算允许不关联供应商并保留收款方信息', async () => {
  const settlement = Settlement.build({
    settlement_id: 'SETTLEMENT_TEST',
    settlement_no: 'RB_TEST',
    supplier_id: null,
    settlement_type: 'reimbursement',
    payee_type: 'employee',
    payee_id: 'STAFF_TEST',
    payee_name: '测试员工',
    source_type: 'expense',
    source_id: 'EXPENSE_TEST',
    source_no: 'EXP_TEST',
    total_amount: 100
  });

  await assert.doesNotReject(() => settlement.validate());
  assert.equal(settlement.supplier_id, null);
  assert.equal(settlement.payee_type, 'employee');
  assert.equal(settlement.source_type, 'expense');
});

test('应付抵扣字段只映射到应付款模型', () => {
  const { Payable, Settlement } = require('../src/models');

  assert.ok(Payable.rawAttributes.offset_amount);
  assert.ok(Payable.rawAttributes.offset_payable_id);
  assert.equal(Settlement.rawAttributes.offset_amount, undefined);
  assert.equal(Settlement.rawAttributes.offset_payable_id, undefined);
});
