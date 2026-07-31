const {
  Expense,
  Payable,
  Settlement,
  SettlementItem
} = require('../../models');
const { Op } = require('sequelize');
const { generateUUID } = require('../../utils');
const moment = require('moment');
const { roundAmount, getAllocationSummary, refreshExpenseState } = require('./settlementAllocation');

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

async function createReimbursementSettlement(expense, operator, transaction = null, requestedAmount = null) {
  const payable = await ensureExpensePayable(expense, {
    sourceType: 'reimbursement'
  }, transaction);
  const allocation = (await getAllocationSummary([payable.payable_id], transaction)).get(String(payable.payable_id));
  const remainingAmount = roundAmount(Number(payable.total_amount || 0) - Number(allocation?.amount || 0));
  const amount = requestedAmount === null || requestedAmount === undefined
    ? remainingAmount
    : roundAmount(requestedAmount);
  if (amount <= 0 || amount > remainingAmount + 0.005) {
    const error = new Error('reimbursement amount exceeds remaining amount');
    error.status = 400;
    throw error;
  }
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
    total_amount: amount,
    paid_amount: 0,
    status: 'draft',
    payment_status: 'unpaid',
    create_user: operator?.name || operator?.phone || operator || ''
  }, { transaction });

  await SettlementItem.create({
    settlement_id: settlement.settlement_id,
    payable_id: payable.payable_id,
    request_no: expense.expense_no,
    amount
  }, { transaction });
  await expense.update({
    payable_id: payable.payable_id,
    settlement_id: settlement.settlement_id,
    update_time: new Date()
  }, { transaction });
  await refreshExpenseState(expense.expense_id, transaction);
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

function reversalError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function settlementIsPaid(settlement) {
  return settlement && (
    Number(settlement.paid_amount || 0) > 0 ||
    settlement.payment_status === 'paid' ||
    settlement.status === 'confirmed'
  );
}

/**
 * 为已经生成的结算单生成一张负结算单。
 * 原结算单保留，负单通过明细金额抵销原结算金额，便于后台审计和后续对账。
 */
async function createSettlementReversal(settlement, operator, transaction = null, reason = '业务申请撤销') {
  if (!settlement) return null;
  if (settlementIsPaid(settlement)) {
    throw reversalError('该结算单已付款或已确认，无法撤销');
  }

  const existing = await Settlement.findOne({
    where: { source_type: 'settlement_reversal', source_id: settlement.settlement_id },
    transaction
  });
  if (existing) return existing;

  const items = await SettlementItem.findAll({
    where: { settlement_id: settlement.settlement_id },
    transaction
  });
  const reversal = await Settlement.create({
    settlement_id: generateUUID(),
    settlement_no: `RV${Date.now()}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`,
    supplier_id: settlement.supplier_id,
    supplier_name: settlement.supplier_name,
    settlement_type: settlement.settlement_type,
    payee_type: settlement.payee_type,
    payee_id: settlement.payee_id,
    payee_name: settlement.payee_name,
    source_type: 'settlement_reversal',
    source_id: settlement.settlement_id,
    source_no: settlement.settlement_no,
    total_amount: -Math.abs(Number(settlement.total_amount || 0)),
    paid_amount: 0,
    status: 'draft',
    payment_status: 'unpaid',
    is_deleted: 0,
    remark: `${reason}，冲销结算单 ${settlement.settlement_no}`,
    create_user: operator?.name || operator?.phone || operator || '',
    create_time: new Date()
  }, { transaction });

  if (items.length > 0) {
    for (const item of items) {
      await SettlementItem.create({
        settlement_id: reversal.settlement_id,
        payable_id: item.payable_id,
        request_item_id: item.request_item_id,
        product_id: item.product_id,
        product_name: item.product_name,
        quantity: item.quantity === null || item.quantity === undefined ? item.quantity : -Math.abs(Number(item.quantity)),
        unit_price: item.unit_price,
        request_no: item.request_no,
        amount: -Math.abs(Number(item.amount || 0))
      }, { transaction });
    }
  }
  return reversal;
}

async function cancelExpenseRecord(expense, operator, transaction = null, reason = '报销申请已撤销') {
  if (!expense || expense.is_deleted) return null;
  if (expense.status === 'paid') {
    throw reversalError('该报销已进入付款或结算流程，无法撤销');
  }

  const settlements = [];
  if (expense.settlement_id) {
    const linked = await Settlement.findByPk(expense.settlement_id, { transaction });
    if (linked && !linked.is_deleted && linked.status !== 'voided') settlements.push(linked);
  }
  if (settlements.length === 0) {
    const sourceSettlements = await Settlement.findAll({
      where: {
        source_type: expense.source_type || 'expense',
        source_id: expense.expense_id,
        is_deleted: 0,
        status: { [Op.ne]: 'voided' }
      },
      transaction
    });
    sourceSettlements.forEach(item => {
      if (!settlements.some(existing => existing.settlement_id === item.settlement_id)) settlements.push(item);
    });
  }

  if (settlements.length === 0 && Number(expense.settled_amount || 0) > 0) {
    throw reversalError('该报销已进入结算流程，无法撤销');
  }

  for (const settlement of settlements) {
    await createSettlementReversal(settlement, operator, transaction, reason);
  }

  if (expense.payable_id) {
    await Payable.update(
      { status: 'cancelled' },
      { where: { payable_id: expense.payable_id }, transaction }
    );
  }
  await expense.update({
    status: 'cancelled',
    review_comment: reason,
    update_time: new Date()
  }, { transaction });
  return expense;
}

module.exports = {
  ensureExpensePayable,
  createReimbursementSettlement,
  createPurchaseReimbursement,
  createSettlementReversal,
  cancelExpenseRecord
};
