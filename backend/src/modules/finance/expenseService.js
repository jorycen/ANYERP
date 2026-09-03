const {
  Expense,
  Payable,
  Settlement,
  SettlementItem,
  ExpensePerformanceAllocation,
  ResourceSettlement,
  ApprovalFlowDefinition
} = require('../../models');
const { Op } = require('sequelize');
const { generateUUID } = require('../../utils');
const moment = require('moment');
const { roundAmount, getAllocationSummary, refreshExpenseState } = require('./settlementAllocation');

const EXPENSE_ATTRIBUTION_TYPES = new Set(['PERSONAL', 'STORE', 'PRODUCT_SIDE', 'COMPANY', 'REBATE']);

function normalizeAttributionType(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (raw === 'PRODUCT' || raw === 'PRODUCT_DEPARTMENT' || raw === 'PRODUCT端') return 'PRODUCT_SIDE';
  if (raw === 'PERSON' || raw === 'EMPLOYEE') return 'PERSONAL';
  return EXPENSE_ATTRIBUTION_TYPES.has(raw) ? raw : 'STORE';
}

function parseJson(value, fallback = null) {
  if (value && typeof value === 'object') return value;
  try { return value ? JSON.parse(value) : fallback; } catch (_) { return fallback; }
}

function money(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function normalizeAttribution({
  attributionType,
  attributionMethod = 'AVERAGE',
  allocationDetails,
  totalAmount,
  applicantStaffId,
  applicantName,
  sourceStoreId,
  sourceStoreName,
  companyTargetType,
  companyTargetId,
  companyTargetName,
  rebateSupplierId,
  rebateSupplierName
}) {
  const type = normalizeAttributionType(attributionType);
  const total = money(totalAmount);
  const method = String(attributionMethod || 'AVERAGE').trim().toUpperCase() === 'MANUAL' ? 'MANUAL' : 'AVERAGE';
  const input = Array.isArray(allocationDetails) ? allocationDetails : [];
  let details;

  if (type === 'PERSONAL') {
    if (!applicantStaffId) throw new Error('个人归属缺少申请人');
    details = [{ target_type: 'staff', target_id: String(applicantStaffId), target_name: applicantName || '', amount: total }];
  } else if (type === 'PRODUCT_SIDE') {
    details = [{ target_type: 'product_side', target_id: 'PRODUCT_SIDE', target_name: '产品端', amount: total }];
  } else if (type === 'COMPANY') {
    const targetType = String(companyTargetType || input[0]?.targetType || input[0]?.target_type || '').trim().toLowerCase();
    const targetId = companyTargetId || input[0]?.targetId || input[0]?.target_id;
    const targetName = companyTargetName || input[0]?.targetName || input[0]?.target_name || '';
    if (!['store', 'distributor'].includes(targetType) || !targetId) {
      throw new Error('公司归属必须选择门店或经销商');
    }
    details = [{ target_type: targetType, target_id: String(targetId), target_name: targetName, amount: total }];
  } else if (type === 'REBATE') {
    if (!rebateSupplierId) throw new Error('返利归属必须选择供应商');
    details = [{ target_type: 'supplier', target_id: String(rebateSupplierId), target_name: rebateSupplierName || '', amount: total }];
  } else {
    details = input.map(item => ({
      target_type: 'store',
      target_id: String(item.targetId || item.target_id || item.storeId || item.store_id || '').trim(),
      target_name: String(item.targetName || item.target_name || item.storeName || item.store_name || '').trim(),
      amount: item.amount === '' || item.amount === null || item.amount === undefined ? null : money(item.amount)
    })).filter(item => item.target_id);
    if (!details.length && sourceStoreId) {
      details = [{ target_type: 'store', target_id: String(sourceStoreId), target_name: sourceStoreName || '', amount: total }];
    }
    if (!details.length) throw new Error('归属门店至少选择一家门店');
    const hasEmptyAmount = details.some(item => item.amount === null);
    if (hasEmptyAmount) {
      if (method !== 'AVERAGE') throw new Error('请填写每个门店的分摊金额');
      const base = Math.floor((total / details.length) * 100) / 100;
      let remainder = money(total - base * details.length);
      details = details.map(item => {
        const amount = money(base + (remainder > 0 ? Math.min(0.01, remainder) : 0));
        remainder = money(remainder - Math.max(0, amount - base));
        return { ...item, amount };
      });
    }
  }

  const sum = money(details.reduce((result, item) => result + money(item.amount), 0));
  if (sum <= 0 || Math.abs(sum - total) > 0.01) {
    throw new Error(`费用分摊金额必须等于费用总额 ¥${total.toFixed(2)}`);
  }
  return {
    type,
    method: type === 'STORE' && method === 'AVERAGE' && input.some(item => item.amount !== undefined && item.amount !== null && item.amount !== '') ? 'MANUAL' : method,
    details: details.map(item => ({ ...item, amount: money(item.amount) }))
  };
}

async function ensureExpenseApprovalFlow(transaction = null) {
  const flowCode = 'expense_attribution';
  const existing = await ApprovalFlowDefinition.findOne({
    where: { flow_code: flowCode, business_type: 'expense', status: 'published' },
    order: [['version', 'DESC']],
    transaction
  });
  if (existing) return existing;
  return ApprovalFlowDefinition.create({
    definition_id: generateUUID(),
    flow_code: flowCode,
    name: '费用归属报销审批',
    business_type: 'expense',
    subject_type: 'staff',
    version: 1,
    status: 'published',
    config_json: JSON.stringify({
      nodes: [
        { name: '直属领导审核', signMode: 'serial', approvers: [{ type: 'direct_supervisor', scope: 'subject_store' }] },
        { name: '财务审核', signMode: 'or', approvers: [{ type: 'role', roleCode: 'finance', scope: 'subject_distributor' }] },
        { name: '经销商总账号审核', signMode: 'or', approvers: [
          { type: 'role', roleCode: 'admin', scope: 'subject_distributor' },
          { type: 'role', roleCode: 'boss', scope: 'subject_distributor' }
        ] }
      ]
    }),
    create_time: new Date(),
    update_time: new Date()
  }, { transaction });
}

async function startExpenseApproval(expense, user, transaction) {
  await ensureExpenseApprovalFlow(transaction);
  const { startInstance } = require('../approval/service');
  return startInstance({
    flowCode: 'expense_attribution',
    businessType: 'expense',
    businessId: expense.expense_id,
    subjectStaffId: expense.applicant_staff_id,
    title: `${expense.expense_type || '费用'} · ${expense.expense_party || ''}`,
    summary: `费用归属：${expense.attribution_type || 'STORE'}，金额 ¥${money(expense.amount).toFixed(2)}`,
    payload: {
      expenseId: expense.expense_id,
      expenseNo: expense.expense_no,
      amount: money(expense.amount),
      accountingMonth: expense.accounting_month,
      attributionType: expense.attribution_type,
      attributionMethod: expense.attribution_method,
      allocationDetails: parseJson(expense.attribution_details_json, [])
    }
  }, user, transaction);
}

async function applyExpenseApproval(instance, transaction, actor, action, comment = '') {
  const expense = await Expense.findByPk(instance.business_id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!expense || expense.is_deleted) throw new Error('报销单不存在');
  if (expense.source_type !== 'expense') return expense;
  if (!['pending_approval', 'processing'].includes(expense.status) && action === 'approved') return expense;
  if (action === 'rejected') {
    await expense.update({
      status: 'rejected',
      review_staff_id: actor?.staffId || null,
      review_user_name: actor?.name || actor?.phone || '',
      review_comment: String(comment || '').trim(),
      review_time: new Date(),
      update_time: new Date()
    }, { transaction });
    return expense;
  }

  const attribution = parseJson(expense.attribution_details_json, []);
  const attributionType = String(expense.attribution_type || 'STORE').toUpperCase();
  const affectsStoreProfit = ['STORE', 'PRODUCT_SIDE', 'COMPANY'].includes(attributionType) ? 1 : 0;
  await expense.update({
    status: 'processing',
    affects_store_profit: affectsStoreProfit,
    review_staff_id: actor?.staffId || null,
    review_user_name: actor?.name || actor?.phone || '',
    review_comment: String(comment || '').trim(),
    review_time: new Date(),
    update_time: new Date()
  }, { transaction });

  if (attributionType === 'PERSONAL') {
    const line = attribution[0];
    const existing = await ExpensePerformanceAllocation.findOne({ where: { expense_id: expense.expense_id }, transaction, lock: transaction.LOCK.UPDATE });
    const values = {
      expense_no: expense.expense_no,
      distributor_id: expense.distributor_id || null,
      region_id: expense.region_id || null,
      store_id: expense.store_id,
      performance_month: expense.accounting_month,
      staff_id: Number(line?.target_id || expense.applicant_staff_id),
      staff_name: line?.target_name || expense.applicant_name || '',
      amount: money(line?.amount || expense.amount),
      reason: `费用归属个人：${expense.expense_no}`,
      status: 'approved',
      applicant_staff_id: expense.applicant_staff_id,
      applicant_name: expense.applicant_name || '',
      finance_reviewer_id: actor?.staffId || null,
      finance_reviewer_name: actor?.name || actor?.phone || '',
      finance_review_time: new Date(),
      admin_reviewer_id: actor?.staffId || null,
      admin_reviewer_name: actor?.name || actor?.phone || '',
      admin_review_time: new Date(),
      update_time: new Date()
    };
    if (existing) await existing.update(values, { transaction });
    else await ExpensePerformanceAllocation.create({ allocation_id: generateUUID(), allocation_no: `EPA${Date.now()}${Math.floor(Math.random() * 1000)}`, ...values, create_time: new Date() }, { transaction });
  }

  if (attributionType === 'REBATE') {
    const line = attribution[0];
    const existing = await ResourceSettlement.findOne({ where: { source_type: 'EXPENSE_REBATE', source_id: expense.expense_id, resource_type: 'EXPENSE_REBATE' }, transaction, lock: transaction.LOCK.UPDATE });
    const rebateSettlement = existing || await ResourceSettlement.create({
        settlement_id: generateUUID(),
        settlement_no: `RST${Date.now()}${Math.floor(Math.random() * 1000)}`,
        source_type: 'EXPENSE_REBATE',
        source_id: expense.expense_id,
        resource_type: 'EXPENSE_REBATE',
        counterparty_id: line?.target_id || null,
        counterparty_name: line?.target_name || '',
        amount: money(line?.amount || expense.amount),
        matched_amount: 0,
        status: 'PENDING',
        create_staff_id: expense.applicant_staff_id || null,
        create_user: expense.applicant_name || expense.create_user || '',
        remark: `费用返利待核销：${expense.expense_no}`,
        create_time: new Date(),
        update_time: new Date()
      }, { transaction });
    await expense.update({ rebate_settlement_id: rebateSettlement.settlement_id }, { transaction });
  }
  return expense;
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
    region_id: expense.region_id || null,
    distributor_id: expense.distributor_id || null,
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
    const error = new Error('报销金额超过剩余可结算金额');
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
    region_id: payable.region_id || expense.region_id || null,
    distributor_id: payable.distributor_id || expense.distributor_id || null,
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
    distributor_id: request.distributor_id || null,
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
    distributor_id: settlement.distributor_id || null,
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
  if (expense.source_type === 'expense' && expense.attribution_type === 'REBATE') {
    await ResourceSettlement.update(
      { status: 'CANCELLED', cancelled_at: new Date(), cancelled_by: operator?.staffId || null, cancelled_by_name: operator?.name || operator?.phone || '', correction_reason: reason, update_time: new Date() },
      { where: { source_type: 'EXPENSE_REBATE', source_id: expense.expense_id, status: { [Op.in]: ['PENDING', 'PARTIALLY_SETTLED'] } }, transaction }
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
  normalizeAttribution,
  ensureExpenseApprovalFlow,
  startExpenseApproval,
  applyExpenseApproval,
  ensureExpensePayable,
  createReimbursementSettlement,
  createPurchaseReimbursement,
  createSettlementReversal,
  cancelExpenseRecord
};
