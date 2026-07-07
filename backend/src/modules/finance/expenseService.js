const {
  Expense,
  Payable,
  Settlement,
  SettlementItem
} = require('../../models');
const { generateUUID } = require('../../utils');
const moment = require('moment');

function money(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

async function ensureExpensePayable(expense, options = {}, transaction = null) {
  const sourceType = options.sourceType || (expense.payment_method === 'PERSONAL_ADVANCE' ? 'reimbursement' : 'expense');
  let payable = await Payable.findOne({
    where: { source_type: sourceType, source_id: expense.expense_id },
    transaction
  });
  const payeeName = options.payeeName || (
    sourceType === 'reimbursement'
      ? (expense.applicant_name || expense.create_user || '垫付员工')
      : expense.expense_party
  );
  const values = {
    supplier_id: null,
    supplier_name: payeeName,
    request_id: null,
    request_no: expense.expense_no,
    payee_type: sourceType === 'reimbursement' ? 'employee' : 'counterparty',
    payee_id: sourceType === 'reimbursement' ? String(expense.applicant_staff_id || '') : '',
    payee_name: payeeName,
    source_type: sourceType,
    source_id: expense.expense_id,
    source_no: expense.expense_no,
    total_amount: money(expense.amount),
    paid_amount: 0,
    status: options.status || 'unpaid'
  };

  if (payable) {
    if (payable.status !== 'paid') await payable.update(values, { transaction });
  } else {
    payable = await Payable.create({
      payable_id: generateUUID(),
      ...values,
      create_time: new Date()
    }, { transaction });
  }
  return payable;
}

async function createReimbursementSettlement(expense, operator, transaction = null) {
  if (expense.settlement_id) {
    return Settlement.findByPk(expense.settlement_id, { transaction });
  }

  const payable = await ensureExpensePayable(expense, {
    sourceType: 'reimbursement',
    status: 'settling'
  }, transaction);
  const settlementNo = `RB${moment().format('YYYYMMDDHHmmss')}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
  const payeeName = expense.applicant_name || expense.create_user || '垫付员工';
  const settlement = await Settlement.create({
    settlement_id: generateUUID(),
    settlement_no: settlementNo,
    supplier_id: null,
    supplier_name: payeeName,
    settlement_type: 'reimbursement',
    payee_type: 'employee',
    payee_id: String(expense.applicant_staff_id || ''),
    payee_name: payeeName,
    source_type: expense.source_type || 'expense',
    source_id: expense.expense_id,
    source_no: expense.source_no || expense.expense_no,
    total_amount: money(expense.amount),
    paid_amount: 0,
    status: 'draft',
    payment_status: 'unpaid',
    create_user: operator?.name || operator?.phone || operator || ''
  }, { transaction });

  await SettlementItem.create({
    settlement_id: settlement.settlement_id,
    payable_id: payable.payable_id,
    request_no: expense.expense_no,
    amount: money(expense.amount)
  }, { transaction });
  await expense.update({
    payable_id: payable.payable_id,
    settlement_id: settlement.settlement_id,
    status: 'approved',
    update_time: new Date()
  }, { transaction });
  return settlement;
}

async function createPurchaseReimbursement(request, user, transaction = null) {
  const existing = await Expense.findOne({
    where: { source_type: 'purchase', source_id: request.request_id },
    transaction
  });
  if (existing) return existing;

  const amount = money(request.actual_total !== null && request.actual_total !== undefined
    ? request.actual_total
    : request.total_amount);
  return Expense.create({
    expense_id: generateUUID(),
    expense_no: `RB${Date.now()}${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`,
    store_id: request.store_id,
    expense_type: '采购垫付',
    expense_party: request.Supplier?.name || '采购供应商',
    amount,
    payment_method: 'PERSONAL_ADVANCE',
    has_invoice: request.invoice_type ? 1 : 0,
    invoice_type: request.invoice_type || '',
    expense_date: new Date(),
    status: 'pending_approval',
    applicant_staff_id: user.staffId || user.id || null,
    applicant_name: user.name || user.phone || '',
    source_type: 'purchase',
    source_id: request.request_id,
    source_no: request.request_no,
    related_order_no: request.request_no,
    remark: request.reason || '',
    create_user: user.name || user.phone || '',
    create_time: new Date(),
    update_time: new Date()
  }, { transaction });
}

module.exports = {
  ensureExpensePayable,
  createReimbursementSettlement,
  createPurchaseReimbursement
};
