const { Op } = require('sequelize');
const {
  Expense,
  ExpensePerformanceAllocation,
  ExpenseAccountingPeriod,
  Staff,
  Store,
  sequelize
} = require('../../models');
const { generateUUID, formatPaginatedResult } = require('../../utils');
const { accessibleDistributorIds, canAccessDistributor } = require('../../utils/distributorScope');
const { getUserRoles } = require('../../middleware/permission');

const RECOGNIZED_EXPENSE_STATUSES = new Set([
  'pending_payment', 'pending', 'processing', 'approved', 'paid'
]);
const ACTIVE_ALLOCATION_STATUSES = ['pending_finance', 'pending_admin', 'approved'];

function money(value) {
  return Number((Number(value || 0)).toFixed(2));
}

function hasRole(user, role) {
  return getUserRoles(user).includes(role);
}

function hasAnyRole(user, roles) {
  const current = getUserRoles(user);
  return current.includes('boss') || current.includes('admin') || roles.some(role => current.includes(role));
}

function normalizeMonth(value, fieldName = '月份') {
  const month = String(value || '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    const error = new Error(`${fieldName}格式必须为 YYYY-MM`);
    error.status = 400;
    throw error;
  }
  return month;
}

function getAccessibleStoreIds(user) {
  return (user.accessibleStoreIds || []).map(String);
}

function assertStoreAccess(user, storeId) {
  const accessibleStoreIds = getAccessibleStoreIds(user);
  if (!accessibleStoreIds.includes('*') && !accessibleStoreIds.includes(String(storeId))) {
    const error = new Error('无权访问该门店费用记录');
    error.status = 403;
    throw error;
  }
}

async function assertPeriodOpen(distributorId, monthKey, transaction = null) {
  const period = await ExpenseAccountingPeriod.findOne({
    where: { distributor_id: distributorId, month_key: monthKey },
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined
  });
  if (period?.status === 'closed') {
    const error = new Error(`费用经营月份 ${monthKey} 已锁定，请通过冲销或调整流程处理`);
    error.status = 400;
    throw error;
  }
  return period;
}

async function getAccessibleExpense(expenseId, user, transaction = null) {
  const expense = await Expense.findOne({
    where: { expense_id: expenseId, is_deleted: 0 },
    include: [{ model: Store, attributes: ['store_id', 'name', 'distributor_id', 'region_id'] }],
    transaction
  });
  if (!expense) {
    const error = new Error('费用单不存在');
    error.status = 404;
    throw error;
  }
  assertStoreAccess(user, expense.store_id);
  if (!canAccessDistributor(user, expense.distributor_id)) {
    const error = new Error('无权访问该经销商费用记录');
    error.status = 403;
    throw error;
  }
  return expense;
}

function allocationNo() {
  return `EPA${Date.now()}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
}

async function listExpensePerformanceAllocations(ctx) {
  const user = ctx.state.user;
  const { expenseId, scope = 'expense', status, performanceMonth, page = 1, pageSize = 20 } = ctx.query;
  const accessibleStoreIds = getAccessibleStoreIds(user);
  const where = {};
  if (!accessibleStoreIds.includes('*')) {
    where.store_id = accessibleStoreIds.length ? { [Op.in]: accessibleStoreIds } : '__NO_STORE__';
  }
  if (expenseId) {
    const expense = await getAccessibleExpense(expenseId, user);
    where.expense_id = expense.expense_id;
  } else if (scope === 'review') {
    const reviewStatuses = [];
    if (hasAnyRole(user, ['finance'])) reviewStatuses.push('pending_finance');
    if (hasAnyRole(user, ['admin'])) reviewStatuses.push('pending_admin');
    where.status = reviewStatuses.length ? { [Op.in]: reviewStatuses } : '__NO_REVIEW_ACCESS__';
  } else if (scope === 'mine') {
    where.applicant_staff_id = user.staffId || user.id || -1;
  }
  if (status) {
    const statuses = String(status).split(',').map(item => item.trim()).filter(Boolean);
    where.status = statuses.length > 1 ? { [Op.in]: statuses } : statuses[0];
  }
  if (performanceMonth) where.performance_month = normalizeMonth(performanceMonth, '绩效月份');

  const currentPage = Math.max(Number(page) || 1, 1);
  const currentPageSize = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const result = await ExpensePerformanceAllocation.findAndCountAll({
    where,
    include: [
      { model: Expense, as: 'Expense', attributes: ['expense_id', 'expense_no', 'expense_type', 'accounting_month', 'amount'] },
      { model: Staff, as: 'Staff', attributes: ['staff_id', 'name', 'store_id'] }
    ],
    order: [['create_time', 'DESC'], ['allocation_id', 'DESC']],
    offset: (currentPage - 1) * currentPageSize,
    limit: currentPageSize,
    distinct: true
  });
  ctx.body = formatPaginatedResult(result.rows, {
    page: currentPage,
    pageSize: currentPageSize,
    count: result.count
  });
}

async function listExpensePerformanceStaffOptions(ctx) {
  const user = ctx.state.user;
  const expense = await getAccessibleExpense(ctx.params.id, user);
  const staffRows = await Staff.findAll({
    where: {
      distributor_id: expense.distributor_id,
      status: 1,
      is_deleted: 0
    },
    attributes: ['staff_id', 'name', 'phone', 'store_id', 'distributor_id'],
    order: [['name', 'ASC'], ['staff_id', 'ASC']],
    raw: true
  });

  ctx.body = {
    code: 0,
    data: {
      employees: staffRows.map(row => ({
        staffId: String(row.staff_id),
        name: row.name,
        phone: row.phone || '',
        storeId: row.store_id || '',
        distributorId: row.distributor_id || ''
      }))
    }
  };
}

async function createExpensePerformanceAllocations(ctx) {
  const user = ctx.state.user;
  const expense = await getAccessibleExpense(ctx.params.id, user);
  if (!RECOGNIZED_EXPENSE_STATUSES.has(String(expense.status || ''))) {
    ctx.throw(400, '费用单提交或审批完成后才可以分摊员工绩效毛利');
  }
  if (!Number(expense.affects_store_profit ?? 1)) ctx.throw(400, '该费用未计入门店经营费用，不允许作为绩效扣减来源');

  const body = ctx.request.body || {};
  const performanceMonth = normalizeMonth(body.performanceMonth || expense.accounting_month, '绩效月份');
  const rows = Array.isArray(body.allocations) ? body.allocations : [];
  if (!rows.length) ctx.throw(400, '请至少填写一名员工的分摊金额');
  if (rows.length > 50) ctx.throw(400, '单笔费用最多分摊给50名员工');
  const reason = String(body.reason || '').trim();
  const staffIds = [...new Set(rows.map(row => String(row.staffId || row.staff_id || '').trim()).filter(Boolean))];
  if (!staffIds.length) ctx.throw(400, '请选择员工');
  const staffRows = await Staff.findAll({
    where: { staff_id: { [Op.in]: staffIds }, status: 1, is_deleted: 0 },
    attributes: ['staff_id', 'name', 'store_id', 'distributor_id'],
    raw: true
  });
  const staffMap = new Map(staffRows.map(row => [String(row.staff_id), row]));
  const normalizedRows = rows.map(row => {
    const staffId = String(row.staffId || row.staff_id || '').trim();
    const staff = staffMap.get(staffId);
    const amount = money(row.amount);
    const rowReason = String(row.reason || reason).trim();
    if (!staff) ctx.throw(400, `员工不存在或已停用：${staffId}`);
    if (String(staff.distributor_id || '') !== String(expense.distributor_id || '')) ctx.throw(400, `员工不属于费用所属经销商：${staff.name}`);
    if (amount <= 0) ctx.throw(400, `员工 ${staff.name} 的分摊金额必须大于0`);
    if (!rowReason) ctx.throw(400, `请填写员工 ${staff.name} 的扣减原因`);
    if (rowReason.length > 1000) ctx.throw(400, '扣减原因不能超过1000字');
    return { staffId, staff, amount, reason: rowReason };
  });
  const requestedAmount = money(normalizedRows.reduce((sum, row) => sum + row.amount, 0));

  await sequelize.transaction(async transaction => {
    await assertPeriodOpen(expense.distributor_id, expense.accounting_month, transaction);
    await assertPeriodOpen(expense.distributor_id, performanceMonth, transaction);
    const active = await ExpensePerformanceAllocation.sum('amount', {
      where: { expense_id: expense.expense_id, status: { [Op.in]: ACTIVE_ALLOCATION_STATUSES } },
      transaction
    });
    const remaining = money(Number(expense.amount || 0) - Number(active || 0));
    if (requestedAmount > remaining + 0.005) {
      const error = new Error(`本次分摊金额超过费用剩余可分摊金额 ¥${remaining.toFixed(2)}`);
      error.status = 400;
      throw error;
    }
    await ExpensePerformanceAllocation.bulkCreate(normalizedRows.map(row => ({
      allocation_id: generateUUID(),
      allocation_no: allocationNo(),
      expense_id: expense.expense_id,
      expense_no: expense.expense_no,
      distributor_id: expense.distributor_id,
      region_id: expense.region_id,
      store_id: expense.store_id,
      performance_month: performanceMonth,
      staff_id: row.staff.staff_id,
      staff_name: row.staff.name,
      amount: row.amount,
      reason: row.reason,
      status: 'pending_finance',
      applicant_staff_id: user.staffId || user.id,
      applicant_name: user.name || user.phone || ''
    })), { transaction });
  });

  ctx.body = { code: 0, message: '员工绩效毛利扣减已提交，待财务初审', data: { amount: requestedAmount } };
}

async function reviewExpensePerformanceAllocation(ctx) {
  const user = ctx.state.user;
  const action = String(ctx.request.body?.action || '').trim();
  const comment = String(ctx.request.body?.comment || '').trim();
  if (!['approve', 'reject'].includes(action)) ctx.throw(400, '审核动作无效');
  if (action === 'reject' && !comment) ctx.throw(400, '拒绝时必须填写原因');
  if (comment.length > 512) ctx.throw(400, '审核意见不能超过512字');

  let result;
  await sequelize.transaction(async transaction => {
    const allocation = await ExpensePerformanceAllocation.findByPk(ctx.params.allocationId, {
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!allocation) ctx.throw(404, '费用绩效分摊记录不存在');
    assertStoreAccess(user, allocation.store_id);
    if (!canAccessDistributor(user, allocation.distributor_id)) ctx.throw(403, '无权审核该费用绩效分摊');
    const now = new Date();
    if (allocation.status === 'pending_finance') {
      if (!hasAnyRole(user, ['finance'])) ctx.throw(403, '当前阶段仅财务账号可审核');
      await allocation.update({
        status: action === 'approve' ? 'pending_admin' : 'rejected',
        finance_reviewer_id: user.staffId || user.id,
        finance_reviewer_name: user.name || user.phone || '',
        finance_review_comment: comment,
        finance_review_time: now,
        reject_stage: action === 'reject' ? 'finance' : null,
        update_time: now
      }, { transaction });
    } else if (allocation.status === 'pending_admin') {
      if (!hasAnyRole(user, ['admin'])) ctx.throw(403, '当前阶段仅 admin 账号可审核');
      await allocation.update({
        status: action === 'approve' ? 'approved' : 'rejected',
        admin_reviewer_id: user.staffId || user.id,
        admin_reviewer_name: user.name || user.phone || '',
        admin_review_comment: comment,
        admin_review_time: now,
        reject_stage: action === 'reject' ? 'admin' : null,
        update_time: now
      }, { transaction });
    } else {
      ctx.throw(400, '当前费用绩效分摊记录不可审核');
    }
    result = allocation;
  });
  ctx.body = { code: 0, message: action === 'approve' ? '审核通过' : '费用绩效分摊已拒绝', data: result };
}

async function listExpenseAccountingPeriods(ctx) {
  const user = ctx.state.user;
  const ids = accessibleDistributorIds(user);
  const where = ids.includes('*') ? {} : { distributor_id: ids.length ? { [Op.in]: ids } : '__NO_DISTRIBUTOR__' };
  if (ctx.query.monthKey) where.month_key = normalizeMonth(ctx.query.monthKey, '月份');
  if (ctx.query.status) where.status = ctx.query.status;
  const rows = await ExpenseAccountingPeriod.findAll({ where, order: [['month_key', 'DESC']] });
  ctx.body = { code: 0, data: rows };
}

async function changeExpenseAccountingPeriod(ctx, action) {
  const user = ctx.state.user;
  const monthKey = normalizeMonth(ctx.params.monthKey, '月份');
  const availableDistributorIds = accessibleDistributorIds(user);
  const distributorId = String(
    ctx.request.body?.distributorId
      || user.distributorId
      || (availableDistributorIds.length === 1 ? availableDistributorIds[0] : '')
  ).trim();
  if (!distributorId || !canAccessDistributor(user, distributorId)) ctx.throw(403, '无权操作该经销商费用月份');
  if (action === 'reopen' && !hasAnyRole(user, ['admin'])) ctx.throw(403, '只有 admin 或 BOSS 可以重新打开费用月份');

  let period;
  await sequelize.transaction(async transaction => {
    period = await ExpenseAccountingPeriod.findOne({
      where: { distributor_id: distributorId, month_key: monthKey },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    const now = new Date();
    const patch = action === 'close'
      ? { status: 'closed', closed_staff_id: user.staffId || user.id, closed_user: user.name || user.phone || '', closed_time: now, reopened_staff_id: null, reopened_user: null, reopened_time: null }
      : { status: 'open', reopened_staff_id: user.staffId || user.id, reopened_user: user.name || user.phone || '', reopened_time: now };
    if (period) {
      await period.update({ ...patch, update_time: now }, { transaction });
    } else {
      period = await ExpenseAccountingPeriod.create({
        period_id: generateUUID(),
        distributor_id: distributorId,
        month_key: monthKey,
        ...patch,
        create_time: now,
        update_time: now
      }, { transaction });
    }
  });
  ctx.body = { code: 0, message: action === 'close' ? `费用月份 ${monthKey} 已锁定` : `费用月份 ${monthKey} 已重新打开`, data: period };
}

module.exports = {
  listExpensePerformanceAllocations,
  listExpensePerformanceStaffOptions,
  createExpensePerformanceAllocations,
  reviewExpensePerformanceAllocation,
  listExpenseAccountingPeriods,
  closeExpenseAccountingPeriod: ctx => changeExpenseAccountingPeriod(ctx, 'close'),
  reopenExpenseAccountingPeriod: ctx => changeExpenseAccountingPeriod(ctx, 'reopen'),
  assertPeriodOpen,
  RECOGNIZED_EXPENSE_STATUSES
};
