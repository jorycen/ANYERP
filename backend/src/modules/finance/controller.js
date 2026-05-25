/**
 * 财务管理控制器
 */
const { DailyStatement, DailyStatementDetail, Expense, Store, Order, OrderPayment, SettlementAccount, SettlementAccountTransaction } = require('../../models');
const { Op, Sequelize, fn, col } = require('sequelize');
const { generateUUID, paginate, formatPaginatedResult } = require('../../utils');

/**
 * 日结清单（逐条显示 - 按收款方式）
 * 直接查询 DailyStatementDetail 平铺展示
 */
async function getDailyDetails(ctx) {
  const { storeId, startDate, endDate, settled, paymentMethod, settlementAccountId, page = 1, pageSize = 20 } = ctx.query;
  const user = ctx.state.user;

  const where = {};
  if (settled !== undefined && settled !== '') {
    where.settled = parseFloat(settled) > 0 ? { [Op.gt]: 0 } : 0;
  }
  if (paymentMethod) {
    where.payment_method = paymentMethod;
  }
  if (settlementAccountId) {
    where.settlement_account_id = settlementAccountId;
  }

  const statementWhere = {};
  if (startDate && endDate) {
    statementWhere.statement_date = { [Op.gte]: startDate, [Op.lte]: endDate };
  }

  const storeWhere = {};
  if (!user.regionCodes.includes('*')) {
    storeWhere.region_id = user.regionCodes;
  }
  if (storeId) {
    storeWhere.store_id = storeId;
  }

  const stores = await Store.findAll({ where: storeWhere });
  const storeIds = stores.map(s => s.store_id);
  if (storeIds.length === 0) {
    ctx.body = formatPaginatedResult([], { page, pageSize, count: 0 });
    return;
  }
  statementWhere.store_id = storeIds;

  const statements = await DailyStatement.findAll({
    where: statementWhere,
    attributes: ['statement_id', 'statement_date', 'store_id']
  });
  const statementIds = statements.map(s => s.statement_id);
  if (statementIds.length === 0) {
    ctx.body = formatPaginatedResult([], { page, pageSize, count: 0 });
    return;
  }
  where.statement_id = statementIds;

  const { count, rows } = await DailyStatementDetail.findAndCountAll({
    where,
    order: [['detail_id', 'DESC']],
    ...paginate({}, { page, pageSize })
  });

  const amountResult = await DailyStatementDetail.findOne({
    where,
    attributes: [[Sequelize.fn('SUM', Sequelize.col('amount')), 'total_amount']],
    raw: true
  });
  const totalAmount = parseFloat(amountResult?.total_amount || 0);

  const statementMap = {};
  for (const s of statements) {
    statementMap[s.statement_id] = s;
  }
  const storeMap = {};
  for (const s of stores) {
    storeMap[s.store_id] = s;
  }

  const detailIds = rows.map(r => r.settlement_account_id).filter(Boolean);
  const accountMap = {};
  if (detailIds.length > 0) {
    const accounts = await SettlementAccount.findAll({
      where: { account_id: detailIds }
    });
    for (const a of accounts) {
      accountMap[a.account_id] = a.toJSON();
    }
  }

  const list = rows.map(d => {
    const stmt = statementMap[d.statement_id];
    const store = stmt ? storeMap[stmt.store_id] : null;
    return {
      ...d.toJSON(),
      statement_date: stmt ? stmt.statement_date : null,
      store_name: store ? store.name : null,
      store_id: stmt ? stmt.store_id : null,
      settlementAccount: d.settlement_account_id ? accountMap[d.settlement_account_id] || null : null
    };
  });

  ctx.body = formatPaginatedResult(list, { page, pageSize, count });
  ctx.body.totalAmount = totalAmount;
  ctx.body.totalCount = count;
}

/**
 * 日结列表
 */
async function getDailyStatement(ctx) {
  const { storeId, startDate, endDate, status, page = 1, pageSize = 20 } = ctx.query;
  const user = ctx.state.user;

  const where = {};
  const whereStore = {};

  if (!user.regionCodes.includes('*')) {
    whereStore.region_id = user.regionCodes;
  }
  if (storeId) whereStore.store_id = storeId;

  const stores = await Store.findAll({ where: whereStore });
  const storeIds = stores.map(s => s.store_id);
  where.store_id = storeIds;

  if (startDate && endDate) {
    where.statement_date = { [Op.gte]: startDate, [Op.lte]: endDate };
  }
  if (status) where.status = status;

  const { count, rows } = await DailyStatement.findAndCountAll({
    where,
    include: [{ model: Store }, { model: DailyStatementDetail, as: 'Details' }],
    order: [['statement_date', 'DESC']],
    ...paginate({}, { page, pageSize })
  });

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

/**
 * 提交报销申请（发起人报销）
 */
async function submitExpense(ctx) {
  const user = ctx.state.user;
  const { id } = ctx.params;

  const record = await Expense.findByPk(id);
  if (!record) ctx.throw(404, '支出记录不存在');
  if (record.status !== 'pending') ctx.throw(400, '当前状态不可提交报销');

  await record.update({
    status: 'processing',
    submit_user: user.name
  });

  ctx.body = { code: 0, message: '报销申请已提交' };
}

/**
 * 出纳确认付款
 */
async function payExpense(ctx) {
  const user = ctx.state.user;
  const { id } = ctx.params;
  const { paymentMethod, settlementAccountId } = ctx.request.body;

  const record = await Expense.findByPk(id);
  if (!record) ctx.throw(404, '支出记录不存在');
  if (record.status !== 'processing') ctx.throw(400, '当前状态不可付款');

  const settleAccountId = settlementAccountId || record.settlement_account_id;

  await record.update({
    status: 'paid',
    settle_user: user.name,
    settled_payment_method: paymentMethod || record.payment_method,
    settlement_account_id: settleAccountId || null,
    settled_at: new Date()
  });

  if (settleAccountId) {
    const amount = parseFloat(record.amount) || 0;
    const latestTx = await SettlementAccountTransaction.findOne({
      attributes: ['balance_after'],
      where: { account_id: settleAccountId },
      order: [['create_time', 'DESC'], ['transaction_id', 'DESC']],
      raw: true
    });
    const currentBalance = latestTx ? (Number(latestTx.balance_after) || 0) : 0;
    const balanceAfter = currentBalance - amount;

    await SettlementAccountTransaction.create({
      transaction_id: generateUUID(),
      account_id: settleAccountId,
      type: 'expense',
      amount,
      balance_after: balanceAfter,
      description: `费用支出：${record.expense_type || '其他'} ${record.remark || ''}`,
      related_ref: record.expense_no || record.expense_id,
      create_user: user.name
    });
  }

  ctx.body = { code: 0, message: '付款完成' };
}

/**
 * 日结单详情（含订单明细）
 */
async function getDailyStatementDetail(ctx) {
  const { id } = ctx.params;

  const statement = await DailyStatement.findByPk(id, {
    include: [
      { model: Store },
      { model: DailyStatementDetail, as: 'Details' }
    ]
  });

  if (!statement) ctx.throw(404, '日结单不存在');

  const detailsWithAccount = [];
  for (const d of statement.Details || []) {
    const detail = d.toJSON();
    if (d.settlement_account_id) {
      const acc = await SettlementAccount.findByPk(d.settlement_account_id);
      if (acc) detail.settlementAccount = acc.toJSON();
    }
    detailsWithAccount.push(detail);
  }

  ctx.body = {
    code: 0,
    data: {
      ...statement.toJSON(),
      Details: detailsWithAccount
    }
  };
}

/**
 * 批量下账
 * 按收款账户汇总和批量标记下账
 */
async function batchSettle(ctx) {
  const { detailIds } = ctx.request.body;
  const user = ctx.state.user;

  if (!detailIds || !Array.isArray(detailIds) || detailIds.length === 0) {
    ctx.throw(400, '请选择要下账的记录');
  }

  const details = await DailyStatementDetail.findAll({
    where: { detail_id: detailIds, settled: 0 }
  });
  if (details.length === 0) {
    ctx.throw(400, '没有可下账的记录');
  }

  const now = new Date();
  let totalSettledAmount = 0;
  const statementSettledMap = {};
  const accountSettledMap = {};

  for (const detail of details) {
    const amount = parseFloat(detail.amount) || 0;
    totalSettledAmount += amount;
    await detail.update({ settled: detail.amount, settled_at: now });

    if (!statementSettledMap[detail.statement_id]) {
      statementSettledMap[detail.statement_id] = 0;
    }
    statementSettledMap[detail.statement_id] += amount;

    if (detail.settlement_account_id) {
      if (!accountSettledMap[detail.settlement_account_id]) {
        accountSettledMap[detail.settlement_account_id] = 0;
      }
      accountSettledMap[detail.settlement_account_id] += amount;
    }
  }

  for (const [statementId, settledAmount] of Object.entries(statementSettledMap)) {
    const statement = await DailyStatement.findByPk(statementId);
    if (!statement) continue;
    const newSettled = parseFloat(statement.total_settled || 0) + settledAmount;
    const totalRevenue = parseFloat(statement.total_revenue || 0);
    let newStatus = 'pending';
    if (newSettled >= totalRevenue) {
      newStatus = 'settled';
    } else if (newSettled > 0) {
      newStatus = 'partial';
    }
    await statement.update({
      total_settled: newSettled,
      status: newStatus,
      confirm_staff: user.name
    });
  }

  for (const [accountId, settledAmount] of Object.entries(accountSettledMap)) {
    const latestTx = await SettlementAccountTransaction.findOne({
      attributes: ['balance_after'],
      where: { account_id: accountId },
      order: [['create_time', 'DESC'], ['transaction_id', 'DESC']],
      raw: true
    });
    const currentBalance = latestTx ? (Number(latestTx.balance_after) || 0) : 0;
    const balanceAfter = currentBalance + settledAmount;

    await SettlementAccountTransaction.create({
      transaction_id: generateUUID(),
      account_id: accountId,
      type: 'income',
      amount: settledAmount,
      balance_after: balanceAfter,
      description: `日结单批量下账（${details.length}笔）`,
      related_ref: `DAILY_SETTLE_${details.map(d => d.detail_id).join(',')}`,
      create_user: user.name
    });
  }

  ctx.body = { code: 0, message: `下账成功，共 ${details.length} 笔，金额: ¥${totalSettledAmount.toFixed(2)}` };
}

/**
 * 按收款账户汇总下账金额
 */
async function getSettlementSummary(ctx) {
  const { statementId } = ctx.query;
  if (!statementId) ctx.throw(400, '日结单ID不能为空');

  const details = await DailyStatementDetail.findAll({
    where: { statement_id: statementId, settled: 0 }
  });

  const summaryMap = {};
  for (const d of details) {
    const accId = d.settlement_account_id || '__unassigned__';
    if (!summaryMap[accId]) {
      summaryMap[accId] = { account_id: accId, total: 0, count: 0, detailIds: [] };
      if (d.settlement_account_id) {
        const acc = await SettlementAccount.findByPk(d.settlement_account_id);
        if (acc) summaryMap[accId].account = acc.toJSON();
      }
    }
    summaryMap[accId].total += parseFloat(d.amount) || 0;
    summaryMap[accId].count += 1;
    summaryMap[accId].detailIds.push(d.detail_id);
  }

  ctx.body = {
    code: 0,
    data: Object.values(summaryMap)
  };
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
  const { storeId, expenseType, status, startDate, endDate, page = 1, pageSize = 20 } = ctx.query;
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
  if (status) {
    const statuses = status.split(',').map(s => s.trim());
    where.status = statuses.length > 1 ? { [Op.in]: statuses } : statuses[0];
  }
  if (startDate && endDate) {
    where.create_time = {
      [Op.gte]: new Date(startDate),
      [Op.lte]: new Date(endDate + ' 23:59:59')
    };
  }

  const { count, rows } = await Expense.findAndCountAll({
    where,
    include: [
      { model: Store },
      { model: SettlementAccount, as: 'SettlementAccount', attributes: ['account_id', 'account_name', 'bank_name', 'account_number'] }
    ],
    order: [['create_time', 'DESC']],
    ...paginate({}, { page, pageSize })
  });

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

/**
 * 应付列表
 */
// ==============================================
// 结算账户流水管理
// ==============================================

async function getSettlementAccountsWithBalance(ctx) {
  try {
    const { page = 1, pageSize = 20 } = ctx.query;

    const { count, rows } = await SettlementAccount.findAndCountAll({
      where: { status: 1 },
      order: [['sort_order', 'ASC']],
      ...paginate({}, { page, pageSize })
    });

    const accountIds = rows.map(a => a.account_id);
    const balanceMap = {};

    if (accountIds.length > 0) {
      try {
        const latestTxs = await SettlementAccountTransaction.findAll({
          attributes: ['account_id', 'balance_after', 'create_time'],
          where: { account_id: accountIds },
          order: [['create_time', 'DESC'], ['transaction_id', 'DESC']],
          raw: true
        });

        for (const tx of latestTxs) {
          if (!(tx.account_id in balanceMap)) {
            balanceMap[tx.account_id] = Number(tx.balance_after) || 0;
          }
        }
      } catch (e) {
        console.error('查询账户余额失败(表可能尚未创建):', e.message);
      }
    }

    const list = rows.map(row => ({
      ...row.toJSON(),
      balance: balanceMap[row.account_id] || 0
    }));

    ctx.body = formatPaginatedResult(list, { page, pageSize, count });
  } catch (err) {
    console.error('getSettlementAccountsWithBalance error:', err);
    ctx.throw(500, '查询结算账户失败');
  }
}

async function getAccountTransactions(ctx) {
  const { accountId } = ctx.params;
  const { page = 1, pageSize = 20 } = ctx.query;

  const account = await SettlementAccount.findByPk(accountId);
  if (!account) ctx.throw(404, '结算账户不存在');

  const { count, rows } = await SettlementAccountTransaction.findAndCountAll({
    where: { account_id: accountId },
    order: [['create_time', 'DESC']],
    ...paginate({}, { page, pageSize })
  });

  const latestTx = await SettlementAccountTransaction.findOne({
    attributes: ['balance_after'],
    where: { account_id: accountId },
    order: [['create_time', 'DESC'], ['transaction_id', 'DESC']],
    raw: true
  });

  ctx.body = {
    code: 0,
    data: {
      account,
      currentBalance: latestTx ? (Number(latestTx.balance_after) || 0) : 0,
      list: rows,
      pagination: {
        total: count,
        page: Number(page),
        pageSize: Number(pageSize),
        totalPages: Math.ceil(count / pageSize)
      }
    }
  };
}

async function addAccountTransaction(ctx) {
  const user = ctx.state.user;
  const { accountId, type, amount, description, relatedRef } = ctx.request.body;

  if (!accountId) ctx.throw(400, '请选择结算账户');
  if (!type || !['income', 'expense'].includes(type)) ctx.throw(400, '类型必须是 income 或 expense');
  if (!amount || amount <= 0) ctx.throw(400, '金额必须大于0');

  const account = await SettlementAccount.findByPk(accountId);
  if (!account) ctx.throw(404, '结算账户不存在');

  const latestTx = await SettlementAccountTransaction.findOne({
    attributes: ['balance_after'],
    where: { account_id: accountId },
    order: [['create_time', 'DESC'], ['transaction_id', 'DESC']],
    raw: true
  });

  const currentBalance = latestTx ? (Number(latestTx.balance_after) || 0) : 0;
  const balanceAfter = type === 'income'
    ? currentBalance + Number(amount)
    : currentBalance - Number(amount);

  await SettlementAccountTransaction.create({
    transaction_id: generateUUID(),
    account_id: accountId,
    type,
    amount,
    balance_after: balanceAfter,
    description: description || '',
    related_ref: relatedRef || '',
    create_user: user.name || user.staffId
  });

  ctx.body = { code: 0, message: '操作成功', data: { balanceAfter } };
}

async function getPayableList(ctx) {
  const { Payable } = require('../../models');
  const { page = 1, pageSize = 20 } = ctx.query;

  const { count, rows } = await Payable.findAndCountAll({
    where: { status: 'unpaid' },
    order: [['create_time', 'DESC']],
    ...paginate({}, { page, pageSize })
  });

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

module.exports = {
  getDailyDetails,
  getDailyStatement,
  getDailyStatementDetail,
  batchSettle,
  getSettlementSummary,
  createExpense,
  getExpenseList,
  submitExpense,
  payExpense,
  getPayableList,
  getSettlementAccountsWithBalance,
  getAccountTransactions,
  addAccountTransaction
};