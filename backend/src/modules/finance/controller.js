/**
 * 财务管理控制器
 */
const { DailyStatement, Expense, Store } = require('../../models');
const { Op } = require('sequelize');
const { generateUUID, paginate, formatPaginatedResult } = require('../../utils');

/**
 * 日结列表
 */
async function getDailyStatement(ctx) {
  const { storeId, startDate, endDate, status, page = 1, pageSize = 20 } = ctx.query;
  const user = ctx.state.user;

  const where = {};
  const whereStore = {};

  // 区域权限过滤
  if (!user.regionCodes.includes('*')) {
    whereStore.region_id = user.regionCodes;
  }
  if (storeId) whereStore.store_id = storeId;

  const stores = await Store.findAll({ where: whereStore });
  const storeIds = stores.map(s => s.store_id);
  where.store_id = storeIds;

  if (startDate && endDate) {
    where.statement_date = {
      [Op.gte]: startDate,
      [Op.lte]: endDate
    };
  }
  if (status) where.status = status;

  const { count, rows } = await DailyStatement.findAndCountAll({
    where,
    include: [{ model: Store }],
    order: [['statement_date', 'DESC']],
    ...paginate({}, { page, pageSize })
  });

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

/**
 * 创建支出记录
 */
async function createExpense(ctx) {
  const user = ctx.state.user;
  const { storeId, expenseType, amount, paymentMethod, relatedOrderNo, remark } = ctx.request.body;

  const expenseNo = `EXP${Date.now()}`;
  const expenseId = generateUUID();

  await Expense.create({
    expense_id: expenseId,
    expense_no: expenseNo,
    store_id: storeId || user.storeId,
    expense_type: expenseType,
    amount,
    payment_method: paymentMethod,
    related_order_no: relatedOrderNo,
    remark,
    create_user: user.name
  });

  ctx.body = { expenseId, expenseNo, message: '支出记录创建成功' };
}

/**
 * 支出列表
 */
async function getExpenseList(ctx) {
  const { storeId, expenseType, startDate, endDate, page = 1, pageSize = 20 } = ctx.query;
  const user = ctx.state.user;

  const where = { is_deleted: 0 };
  const whereStore = {};

  if (!user.regionCodes.includes('*')) {
    whereStore.region_id = user.regionCodes;
  }
  if (storeId) whereStore.store_id = storeId;

  const stores = await Store.findAll({ where: whereStore });
  const storeIds = stores.map(s => s.store_id);
  where.store_id = storeIds;

  if (expenseType) where.expense_type = expenseType;
  if (startDate && endDate) {
    where.create_time = {
      [Op.gte]: new Date(startDate),
      [Op.lte]: new Date(endDate + ' 23:59:59')
    };
  }

  const { count, rows } = await Expense.findAndCountAll({
    where,
    include: [{ model: Store }],
    order: [['create_time', 'DESC']],
    ...paginate({}, { page, pageSize })
  });

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

module.exports = { getDailyStatement, createExpense, getExpenseList };
