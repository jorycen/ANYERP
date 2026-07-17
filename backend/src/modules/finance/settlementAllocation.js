const {
  Payable,
  Expense,
  Settlement,
  SettlementItem,
  SettlementPaymentRecord
} = require('../../models');
const { Op } = require('sequelize');

function roundAmount(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function roundQuantity(value) {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}

function actualUnitPrice(item) {
  const quantity = Number(item?.quantity || 0);
  const unitPrice = Number(item?.unit_price || 0);
  const rebate = Number(item?.rebate_deduction || 0);
  return roundQuantity(quantity > 0 ? unitPrice - rebate / quantity : unitPrice);
}

function getOpenPayableStatus(total, settled, paid = 0) {
  const totalAmount = Number(total || 0);
  const settledAmount = Number(settled || 0);
  const paidAmount = Number(paid || 0);
  if (paidAmount >= totalAmount - 0.005 && totalAmount > 0) return 'paid';
  if (settledAmount >= totalAmount - 0.005 && totalAmount > 0) return 'settling';
  if (settledAmount > 0) return 'partial_settled';
  return 'unpaid';
}

function getExpenseStatus(total, settled, paid, currentStatus = 'approved') {
  const totalAmount = Number(total || 0);
  const settledAmount = Number(settled || 0);
  const paidAmount = Number(paid || 0);
  if (paidAmount >= totalAmount - 0.005 && totalAmount > 0) return 'paid';
  if (settledAmount >= totalAmount - 0.005 && totalAmount > 0) return 'processing';
  if (settledAmount > 0) return 'partial_reimbursement';
  return currentStatus;
}

async function getActiveSettlementState(payableId, transaction = null) {
  const items = await SettlementItem.findAll({
    where: { payable_id: payableId },
    transaction
  });
  if (!items.length) return { settledAmount: 0, paidAmount: 0, items: [] };

  const settlementIds = [...new Set(items.map(item => item.settlement_id))];
  const settlements = await Settlement.findAll({
    where: {
      settlement_id: { [Op.in]: settlementIds },
      status: { [Op.ne]: 'voided' }
    },
    transaction
  });
  const settlementMap = new Map(settlements.map(item => [item.settlement_id, item]));
  const activeItems = items.filter(item => settlementMap.has(item.settlement_id));
  if (!activeItems.length) return { settledAmount: 0, paidAmount: 0, items: [] };

  const payments = await SettlementPaymentRecord.findAll({
    attributes: ['settlement_id', 'amount'],
    where: {
      settlement_id: { [Op.in]: [...settlementMap.keys()] },
      status: 'active'
    },
    transaction
  });
  const paidMap = new Map();
  payments.forEach(payment => {
    paidMap.set(payment.settlement_id, (paidMap.get(payment.settlement_id) || 0) + Number(payment.amount || 0));
  });

  let settledAmount = 0;
  let paidAmount = 0;
  activeItems.forEach(item => {
    const amount = Number(item.amount || 0);
    const settlement = settlementMap.get(item.settlement_id);
    const settlementTotal = Number(settlement.total_amount || 0);
    const settlementPaid = Math.min(settlementTotal, paidMap.get(item.settlement_id) || 0);
    const paidRatio = settlementTotal > 0 ? settlementPaid / settlementTotal : 0;
    settledAmount += amount;
    paidAmount += amount * paidRatio;
  });

  return {
    settledAmount: roundAmount(settledAmount),
    paidAmount: roundAmount(paidAmount),
    items: activeItems,
    settlementMap,
    paidMap
  };
}

async function refreshPayableState(payableId, transaction = null) {
  const payable = await Payable.findByPk(payableId, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!payable) return null;
  const state = await getActiveSettlementState(payableId, transaction);
  const status = getOpenPayableStatus(payable.total_amount, state.settledAmount, state.paidAmount);
  await payable.update({
    settled_amount: state.settledAmount,
    paid_amount: state.paidAmount,
    status
  }, { transaction });
  return { payable, ...state, status };
}

async function refreshExpenseState(expenseId, transaction = null) {
  const expense = await Expense.findByPk(expenseId, { transaction });
  if (!expense || !expense.payable_id) return expense;
  const state = await refreshPayableState(expense.payable_id, transaction);
  const status = getExpenseStatus(expense.amount, state?.settledAmount, state?.paidAmount, expense.status);
  await expense.update({
    settled_amount: state?.settledAmount || 0,
    status,
    settled_at: status === 'paid' ? new Date() : null,
    update_time: new Date()
  }, { transaction });
  return expense;
}

async function getAllocationSummary(payableIds, transaction = null) {
  const ids = [...new Set((payableIds || []).filter(Boolean).map(String))];
  const result = new Map(ids.map(id => [id, { amount: 0, quantityByItem: new Map(), amountByItem: new Map() }]));
  if (!ids.length) return result;
  const items = await SettlementItem.findAll({
    where: { payable_id: { [Op.in]: ids } },
    transaction
  });
  const settlementIds = [...new Set(items.map(item => item.settlement_id))];
  if (!settlementIds.length) return result;
  const active = await Settlement.findAll({
    where: { settlement_id: { [Op.in]: settlementIds }, status: { [Op.ne]: 'voided' } },
    attributes: ['settlement_id'],
    transaction
  });
  const activeIds = new Set(active.map(item => item.settlement_id));
  items.filter(item => activeIds.has(item.settlement_id)).forEach(item => {
    const row = result.get(String(item.payable_id));
    if (!row) return;
    const amount = Number(item.amount || 0);
    row.amount += amount;
    if (item.request_item_id !== null && item.request_item_id !== undefined) {
      const key = String(item.request_item_id);
      row.quantityByItem.set(key, (row.quantityByItem.get(key) || 0) + Number(item.quantity || 0));
      row.amountByItem.set(key, (row.amountByItem.get(key) || 0) + amount);
    }
  });
  result.forEach(row => { row.amount = roundAmount(row.amount); });
  return result;
}

module.exports = {
  roundAmount,
  roundQuantity,
  actualUnitPrice,
  getOpenPayableStatus,
  getExpenseStatus,
  getActiveSettlementState,
  getAllocationSummary,
  refreshPayableState,
  refreshExpenseState
};
