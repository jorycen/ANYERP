const { QueryTypes, Op } = require('sequelize');

function monthsBetween(start, end) {
  const valid = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ''));
  if (!valid(start) || !valid(end) || start > end) {
    throw Object.assign(new Error('请填写有效的摊销起止月份，结束月份不能早于开始月份'), { status: 400 });
  }
  const index = value => Number(value.slice(0, 4)) * 12 + Number(value.slice(5)) - 1;
  const count = index(end) - index(start) + 1;
  if (count > 120) throw Object.assign(new Error('单笔费用摊销期间不能超过120个月'), { status: 400 });
  return Array.from({ length: count }, (_, offset) => {
    const n = index(start) + offset;
    return `${Math.floor(n / 12)}-${String(n % 12 + 1).padStart(2, '0')}`;
  });
}

// Both month totals and each store's full-period share are conserved to the cent.
function splitSchedule(allocations, start, end) {
  const months = monthsBetween(start, end);
  const remaining = allocations.map(row => Math.round(Number(row.amount) * 100));
  if (remaining.some(value => !Number.isSafeInteger(value) || value < 0)) throw Object.assign(new Error('费用分摊金额无效'), { status: 400 });
  const total = remaining.reduce((sum, value) => sum + value, 0);
  const base = Math.floor(total / months.length), extra = total % months.length;
  let balance = total;
  return months.map((month, index) => {
    const cents = base + (index < extra ? 1 : 0);
    const shares = remaining.map(value => balance ? cents * value / balance : 0);
    const assigned = shares.map(Math.floor);
    const order = shares.map((value, i) => ({ i, remainder: value - assigned[i] }))
      .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
    let left = cents - assigned.reduce((sum, value) => sum + value, 0);
    for (const item of order) { if (!left) break; assigned[item.i]++; left--; }
    assigned.forEach((value, i) => { remaining[i] -= value; });
    balance -= cents;
    return { month, amount: cents / 100, allocations: allocations.map((row, i) => ({ ...row, amount: assigned[i] / 100 })) };
  });
}

function expandExpenseRows(rows, { dateMode, startDate, endDate, monthKeys = [] }) {
  return rows.flatMap(row => {
    if (!row.amortizationStartMonth && !row.amortizationEndMonth) return [row];
    let details = row.attributionDetails;
    if (typeof details === 'string') details = JSON.parse(details || '[]');
    details = Array.isArray(details) ? details : [];
    const allocations = details.length ? details : [{ target_id: row.sourceStoreId, target_type: 'store', amount: row.amount }];
    const total = Math.round(allocations.reduce((sum, item) => sum + Number(item.amount || 0), 0) * 100);
    if (total !== Math.round(Number(row.amount) * 100)) throw Object.assign(new Error(`费用 ${row.expenseId} 分摊金额与原费用不一致`), { status: 400 });
    return splitSchedule(allocations, row.amortizationStartMonth, row.amortizationEndMonth)
      .filter(part => dateMode === 'accounting_month' ? monthKeys.includes(part.month)
        : `${part.month}-01` >= startDate && `${part.month}-01` <= endDate)
      .map(part => ({ ...row, amount: part.amount, businessDate: `${part.month}-01`, amortizationMonth: part.month,
        attributionDetails: part.allocations }));
  });
}

function expenseEventKey(row) {
  return `expense:${row.expenseId}:${row.storeId || 'company'}${row.amortizationMonth ? `:${row.amortizationMonth}` : ''}`;
}

async function assertScheduleOpen(expense, months, transaction) {
  const { sequelize, Store } = require('../../models');
  const { assertPeriodOpen } = require('./expenseAccountingController');
  let details; try { details = JSON.parse(expense.attribution_details_json || '[]'); } catch (_) { details = []; }
  if (!Array.isArray(details)) details = [];
  const storeIds = [...new Set([expense.store_id, ...details.filter(row => String(row.target_type || 'store') === 'store').map(row => row.target_id)].filter(Boolean).map(String))].sort();
  const stores = await Store.findAll({ where: { store_id: { [Op.in]: storeIds } }, attributes: ['store_id', 'distributor_id'], order: [['store_id', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
  const distributors = [...new Set([expense.distributor_id, ...stores.map(row => row.distributor_id)].filter(Boolean))].sort();
  for (const distributor of distributors) for (const month of [...new Set(months)].sort()) await assertPeriodOpen(distributor, month, transaction);
  const closed = await sequelize.query('SELECT MONTH_KEY FROM T_FINANCIAL_PROFIT_PERIOD WHERE MONTH_KEY IN (:months) FOR UPDATE',
    { replacements: { months }, type: QueryTypes.SELECT, transaction });
  if (closed.length) throw Object.assign(new Error('摊销期间包含已关账月份，请通过开放月份调整处理'), { status: 400 });
}

async function update(ctx) {
  const M = require('../../models');
  const { recordBusinessAction } = require('../../utils/businessActionLog');
  const body = ctx.request.body || {};
  const reason = String(body.reason || '').trim();
  if (!reason || reason.length > 512) ctx.throw(400, '请填写调整原因（最多512字）');
  const start = String(body.startMonth || '').trim(), end = String(body.endMonth || '').trim();
  const requestedMonths = start || end ? monthsBetween(start, end) : [];
  await M.sequelize.transaction(async transaction => {
    const expense = await M.Expense.findByPk(ctx.params.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!expense || Number(expense.is_deleted)) ctx.throw(404, '费用不存在');
    const ids = (ctx.state.user.accessibleStoreIds || []).map(String);
    if (!ids.includes('*') && !ids.includes(String(expense.store_id))) ctx.throw(403, '无权修改该门店费用');
    if (!['approved', 'pending_payment', 'pending', 'processing', 'paid'].includes(expense.status)) ctx.throw(400, '费用审批通过后才能设置分月摊销');
    if (['PERSONAL', 'REBATE'].includes(expense.attribution_type)) ctx.throw(400, '个人承担或返利冲抵费用不参与经营摊销');
    if (/电费/.test(expense.expense_type || '') && requestedMonths.length &&
      (requestedMonths.length !== 1 || start !== (expense.accounting_month || String(expense.expense_date || '').slice(0, 7)))) ctx.throw(400, '电费应计入原费用所属当月，不允许跨月摊销或改期');
    const before = { startMonth: expense.amortization_start_month || '', endMonth: expense.amortization_end_month || '' };
    const previous = before.startMonth ? monthsBetween(before.startMonth, before.endMonth) : [expense.accounting_month || String(expense.expense_date || '').slice(0, 7)];
    const next = requestedMonths.length ? requestedMonths : [expense.accounting_month || String(expense.expense_date || '').slice(0, 7)];
    if ([...previous, ...next].some(month => !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))) ctx.throw(400, '请先补齐原费用归属月份或费用日期');
    await assertScheduleOpen(expense, [...new Set([...previous, ...next])], transaction);
    await expense.update({ amortization_start_month: start || null, amortization_end_month: end || null, update_time: new Date() }, { transaction });
    await recordBusinessAction({ businessType: 'expense', businessId: expense.expense_id, businessNo: expense.expense_no,
      action: 'update_amortization', fromStatus: expense.status, toStatus: expense.status, user: ctx.state.user,
      comment: reason, detail: { before, after: { startMonth: start, endMonth: end } }, transaction });
  });
  ctx.body = { code: 0, message: '费用摊销期间已保存；门店比例沿用原审批分摊' };
}

module.exports = { monthsBetween, splitSchedule, expandExpenseRows, expenseEventKey, assertScheduleOpen, update };
