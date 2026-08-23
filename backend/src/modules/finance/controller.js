/**
 * 财务管理控制器
 */
const {
  sequelize, DailyStatement, DailyStatementDetail, Expense, ExpenseType, PurchaseRequest, Store, Region, Order, OrderPayment, Supplier,
  SettlementAccount, SettlementAccountTransaction, SubsidyAccountRoute, SubsidyReceipt,
  SubsidyReceiptAllocation, SubsidyReceivableAdjustment
} = require('../../models');
const { Op, Sequelize, fn, col } = require('sequelize');
const { generateUUID, paginate, formatPaginatedResult, buildPendingFirstOrder } = require('../../utils');
const { sendExcel } = require('../../utils/excelExport');
const { getUserRoles } = require('../../middleware/permission');
const { ensureExpensePayable, cancelExpenseRecord } = require('./expenseService');

function buildDailyPaymentMethodWhere(paymentMethod) {
  const method = String(paymentMethod || '').trim();
  if (!method) return null;

  if (method.startsWith('国补POS') && !method.endsWith('-客户实收') && !method.endsWith('-政策补贴应收')) {
    return { [Op.or]: [method, `${method}-客户实收`] };
  }
  return method;
}

async function getAccountBalance(accountId, transaction = null) {
  const [incomeAmount, expenseAmount] = await Promise.all([
    SettlementAccountTransaction.sum('amount', { where: { account_id: accountId, type: 'income' }, transaction }),
    SettlementAccountTransaction.sum('amount', { where: { account_id: accountId, type: 'expense' }, transaction })
  ]);
  return Math.round((Number(incomeAmount || 0) - Number(expenseAmount || 0)) * 100) / 100;
}

/**
 * 日结清单（逐条显示 - 按收款方式）
 * 直接查询 DailyStatementDetail 平铺展示
 */
async function getStatementDetails(ctx, businessWhere) {
  const { storeId, startDate, endDate, settled, paymentMethod, settlementAccountId, page = 1, pageSize = 20 } = ctx.query;
  const user = ctx.state.user;
  const exportMode = Boolean(ctx.state.exportMode);

  const where = {};
  if (businessWhere) where[Op.or] = businessWhere;
  if (settled !== undefined && settled !== '') {
    where.settled = parseFloat(settled) > 0 ? { [Op.gt]: 0 } : 0;
  }
  if (paymentMethod) {
    where.payment_method = buildDailyPaymentMethodWhere(paymentMethod);
  }
  if (settlementAccountId) {
    where.settlement_account_id = settlementAccountId;
  }

  const statementWhere = {};
  if (startDate && endDate) {
    statementWhere.statement_date = { [Op.gte]: startDate, [Op.lte]: endDate };
  }

  const storeWhere = {};
  if (!user.accessibleStoreIds.includes('*')) {
    storeWhere.store_id = user.accessibleStoreIds;
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

  const detailQuery = {
    where,
    order: [
      [Sequelize.literal('CASE WHEN `DailyStatementDetail`.`settled` = 0 THEN 0 ELSE 1 END'), 'ASC'],
      [Sequelize.literal(`
        COALESCE(
          (SELECT o.create_time FROM T_ORDER o
            WHERE o.order_id = \`DailyStatementDetail\`.\`order_id\` LIMIT 1),
          (SELECT d.create_time FROM T_DEPOSIT_ORDER d
            WHERE d.deposit_id = \`DailyStatementDetail\`.\`order_id\` LIMIT 1),
          (SELECT s.statement_date FROM T_DAILY_STATEMENT s
            WHERE s.statement_id = \`DailyStatementDetail\`.\`statement_id\` LIMIT 1)
        )
      `), 'DESC'],
      ['detail_id', 'DESC']
    ]
  };
  const result = exportMode
    ? { count: 0, rows: await DailyStatementDetail.findAll(detailQuery) }
    : await DailyStatementDetail.findAndCountAll({ ...detailQuery, ...paginate({}, { page, pageSize }) });
  const { count, rows } = result;

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

  const accountIds = rows.map(r => r.settlement_account_id).filter(Boolean);
  const accountMap = {};
  if (accountIds.length > 0) {
    const accounts = await SettlementAccount.findAll({
      where: { account_id: accountIds }
    });
    for (const a of accounts) {
      accountMap[a.account_id] = a.toJSON();
    }
  }
  const approvedAdjustments = rows.length
    ? await SubsidyReceivableAdjustment.findAll({
        attributes: ['detail_id', [Sequelize.fn('SUM', Sequelize.col('amount')), 'approved_amount']],
        where: { detail_id: rows.map(row => row.detail_id), status: 'APPROVED' },
        group: ['detail_id'],
        raw: true
      })
    : [];
  const adjustmentMap = new Map(approvedAdjustments.map(row => [row.detail_id, Number(row.approved_amount || 0)]));

  const list = rows.map(d => {
    const stmt = statementMap[d.statement_id];
    const store = stmt ? storeMap[stmt.store_id] : null;
    const remainingAmount = Math.max(0, Number(d.amount || 0) - Number(d.settled || 0));
    const adjustmentAmount = adjustmentMap.get(d.detail_id) || 0;
    return {
      ...d.toJSON(),
      statement_date: stmt ? stmt.statement_date : null,
      store_name: store ? store.name : null,
      store_id: stmt ? stmt.store_id : null,
      region_id: store ? store.region_id : null,
      remaining_amount: remainingAmount,
      approved_adjustment_amount: adjustmentAmount,
      receipt_status: remainingAmount <= 0 && adjustmentAmount > 0
        ? 'ADJUSTED'
        : Number(d.settled || 0) <= 0
        ? 'PENDING'
        : (remainingAmount <= 0 ? 'RECEIVED' : 'PARTIAL'),
      settlementAccount: d.settlement_account_id ? accountMap[d.settlement_account_id] || null : null
    };
  });

  ctx.body = formatPaginatedResult(list, { page, pageSize, count });
  ctx.body.totalAmount = totalAmount;
  ctx.body.totalCount = count;
}

async function getDailyDetails(ctx) {
  return getStatementDetails(ctx, [
    { business_type: { [Op.ne]: 'national_subsidy_receivable' } },
    {
      business_type: { [Op.is]: null },
      payment_method: { [Op.notLike]: '国补POS%-政策补贴应收' }
    }
  ]);
}

async function getNationalSubsidyReceivables(ctx) {
  return getStatementDetails(ctx, [
    { business_type: 'national_subsidy_receivable' },
    {
      business_type: { [Op.is]: null },
      payment_method: { [Op.like]: '国补POS%-政策补贴应收' }
    }
  ]);
}

async function exportDailyDetails(ctx) {
  ctx.state.exportMode = true;
  await getDailyDetails(ctx);
  const rows = ctx.body?.list || [];
  const data = rows.map(row => ({
    日期: row.statement_date || '',
    业务单号: row.order_no || row.order_id || '',
    业务类型: row.business_type || '',
    客户: row.customer_name || '',
    收款方式: row.payment_method || '',
    收款金额: Number(row.amount || 0),
    已下账金额: Number(row.settled || 0),
    结算账号: row.settlementAccount?.account_name || '',
    门店: row.store_name || '',
    状态: Number(row.settled || 0) > 0 ? '已下账' : '未下账',
    下账时间: row.settled_at || ''
  }));
  sendExcel(ctx, data, [
    '日期', '业务单号', '业务类型', '客户', '收款方式', '收款金额',
    '已下账金额', '结算账号', '门店', '状态', '下账时间'
  ], `日结单_${new Date().toISOString().slice(0, 10)}.xlsx`, '日结单');
}

async function exportNationalSubsidyReceivables(ctx) {
  ctx.state.exportMode = true;
  await getNationalSubsidyReceivables(ctx);
  const rows = ctx.body?.list || [];
  const data = rows.map(row => ({
    应收日期: row.statement_date || '',
    订单号: row.order_no || row.order_id || '',
    国补客户: row.customer_name || '',
    国补类型: row.payment_method || '',
    应收金额: Number(row.amount || 0),
    累计核销: Number(row.settled || 0),
    剩余应收: Number(row.remaining_amount || 0),
    应收账户: row.settlementAccount?.account_name || '',
    门店: row.store_name || '',
    状态: row.receipt_status === 'ADJUSTED'
      ? '差额结清'
      : Number(row.remaining_amount || 0) <= 0
        ? '已到账'
        : Number(row.settled || 0) > 0 ? '部分到账' : '待回款',
    结清时间: row.settled_at || ''
  }));
  sendExcel(ctx, data, [
    '应收日期', '订单号', '国补客户', '国补类型', '应收金额', '累计核销',
    '剩余应收', '应收账户', '门店', '状态', '结清时间'
  ], `国补应收单_${new Date().toISOString().slice(0, 10)}.xlsx`, '国补应收单');
}

/**
 * 日结列表
 */
async function getDailyStatement(ctx) {
  const { storeId, startDate, endDate, status, page = 1, pageSize = 20 } = ctx.query;
  const user = ctx.state.user;

  const where = {};
  const whereStore = {};

  if (!user.accessibleStoreIds.includes('*')) {
    whereStore.store_id = user.accessibleStoreIds;
  }
  if (storeId) {
    const allowedStoreIds = (user.accessibleStoreIds || []).map(String);
    if (!allowedStoreIds.includes('*') && !allowedStoreIds.includes(String(storeId))) {
      ctx.throw(403, '无权访问该门店日结记录');
    }
    whereStore.store_id = storeId;
  }

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
    order: buildPendingFirstOrder(sequelize, {
      statusColumn: 'DailyStatement.status',
      pendingStatuses: ['pending', 'partial'],
      dateColumns: ['DailyStatement.statement_date'],
      idColumn: 'DailyStatement.statement_id'
    }),
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
  if (!record || record.is_deleted) ctx.throw(404, '支出记录不存在');
  if (record.status === 'draft') {
    if (!canManageExpenseDraft(user, record)) ctx.throw(403, '只有费用单创建人、店长或管理员可以提交');
    await sequelize.transaction(async transaction => {
      if (record.payment_method === 'CORPORATE') {
        const payable = await ensureExpensePayable(record, { sourceType: 'expense', status: 'unpaid' }, transaction);
        await record.update({ status: 'pending_payment', payable_id: payable.payable_id, submit_user: user.name, update_time: new Date() }, { transaction });
      } else {
        await record.update({ status: 'pending_approval', submit_user: user.name, update_time: new Date() }, { transaction });
      }
    });
    ctx.body = { code: 0, message: '费用单已提交', status: record.status };
    return;
  }
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
    const currentBalance = await getAccountBalance(settleAccountId);
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
async function settleStatementDetails(ctx, businessType) {
  const { detailIds } = ctx.request.body;
  const user = ctx.state.user;

  if (!detailIds || !Array.isArray(detailIds) || detailIds.length === 0) {
    ctx.throw(400, '请选择要下账的记录');
  }

  const businessWhere = businessType === 'national_subsidy_receivable'
    ? [
      { business_type: 'national_subsidy_receivable' },
      {
        business_type: { [Op.is]: null },
        payment_method: { [Op.like]: '国补POS%-政策补贴应收' }
      }
    ]
    : [
      { business_type: { [Op.ne]: 'national_subsidy_receivable' } },
      {
        business_type: { [Op.is]: null },
        payment_method: { [Op.notLike]: '国补POS%-政策补贴应收' }
      }
    ];
  let totalSettledAmount = 0;
  let settledCount = 0;
  await sequelize.transaction(async transaction => {
    const details = await DailyStatementDetail.findAll({
      where: {
        detail_id: detailIds,
        settled: 0,
        [Op.or]: businessWhere
      },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (details.length === 0) {
      ctx.throw(400, '没有可下账的记录');
    }
    const unassignedDetails = details.filter(detail => !detail.settlement_account_id);
    if (unassignedDetails.length > 0) {
      const methods = [...new Set(unassignedDetails.map(detail => detail.payment_method).filter(Boolean))];
      ctx.throw(400, `存在未配置下账账户的收款记录：${methods.join('、') || '未知收款方式'}`);
    }

    const now = new Date();
    const statementSettledMap = {};
    const accountSettledMap = {};
    settledCount = details.length;

    for (const detail of details) {
      const amount = parseFloat(detail.amount) || 0;
      totalSettledAmount += amount;
      await detail.update({ settled: detail.amount, settled_at: now }, { transaction });

      if (!statementSettledMap[detail.statement_id]) {
        statementSettledMap[detail.statement_id] = 0;
      }
      statementSettledMap[detail.statement_id] += amount;

      if (!accountSettledMap[detail.settlement_account_id]) {
        accountSettledMap[detail.settlement_account_id] = 0;
      }
      accountSettledMap[detail.settlement_account_id] += amount;
    }

    for (const [statementId, settledAmount] of Object.entries(statementSettledMap)) {
      const statement = await DailyStatement.findByPk(statementId, {
        transaction,
        lock: transaction.LOCK.UPDATE
      });
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
      }, { transaction });
    }

    for (const [accountId, settledAmount] of Object.entries(accountSettledMap)) {
      await SettlementAccount.findByPk(accountId, {
        transaction,
        lock: transaction.LOCK.UPDATE
      });
      const currentBalance = await getAccountBalance(accountId, transaction);
      const balanceAfter = currentBalance + settledAmount;

      await SettlementAccountTransaction.create({
        transaction_id: generateUUID(),
        account_id: accountId,
        type: 'income',
        amount: settledAmount,
        balance_after: balanceAfter,
        description: businessType === 'national_subsidy_receivable'
          ? `国补应收单批量下账（${details.length}笔）`
          : `日结单批量下账（${details.length}笔）`,
        related_ref: `${businessType === 'national_subsidy_receivable' ? 'SUBSIDY' : 'DAILY'}_SETTLE_${details.map(d => d.detail_id).join(',')}`,
        create_user: user.name
      }, { transaction });
    }
  });

  ctx.body = { code: 0, message: `下账成功，共 ${settledCount} 笔，金额: ¥${totalSettledAmount.toFixed(2)}` };
}

async function batchSettle(ctx) {
  return settleStatementDetails(ctx, 'daily');
}

async function settleNationalSubsidyReceivables(ctx) {
  ctx.throw(400, '国补应收请使用银行到账登记和核销流程');
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
  const {
    storeId, expenseTypeId, expenseParty, amount, paymentMethod,
    hasInvoice, invoiceType, invoiceNo, expenseDate, attachmentUrls,
    relatedOrderNo, remark, saveDraft = false, expenseId
  } = ctx.request.body;
  const isDraft = Boolean(saveDraft);
  const targetStoreId = storeId || user.storeId;
  if (!targetStoreId) ctx.throw(400, '请选择门店');
  const allowed = user.accessibleStoreIds || [];
  if (!allowed.includes('*') && !allowed.map(String).includes(String(targetStoreId))) ctx.throw(403, '无权操作该门店');
  if (!expenseTypeId) ctx.throw(400, '请选择报销类型');
  if (!String(expenseParty || '').trim()) ctx.throw(400, '请填写费用发生方');
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) ctx.throw(400, '费用金额必须大于0');
  if (!['CORPORATE', 'PERSONAL_ADVANCE'].includes(paymentMethod)) ctx.throw(400, '支付方式无效');

  const [expenseType, store] = await Promise.all([
    ExpenseType.findOne({ where: { type_id: expenseTypeId, status: 1 } }),
    Store.findByPk(targetStoreId, { include: [{ model: Region }] })
  ]);
  if (!expenseType) ctx.throw(400, '报销类型不存在或已停用');
  if (!store) ctx.throw(404, '门店不存在');

  let existingRecord = null;
  if (expenseId) {
    existingRecord = await Expense.findOne({ where: { expense_id: expenseId, is_deleted: 0 } });
    if (!existingRecord) ctx.throw(404, '费用单不存在');
    if (existingRecord.status !== 'draft') ctx.throw(400, '只有草稿状态的费用单可以编辑');
    if (!canManageExpenseDraft(user, existingRecord)) ctx.throw(403, '只有费用单创建人、店长或管理员可以编辑');
    if (String(existingRecord.store_id || '') !== String(targetStoreId || '')) ctx.throw(400, '费用单草稿不可更换门店');
  }

  const expenseNo = existingRecord?.expense_no || `EXP${Date.now()}${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`;
  const currentExpenseId = existingRecord?.expense_id || expenseId || generateUUID();
  let record;
  await sequelize.transaction(async transaction => {
    const expensePayload = {
      expense_id: currentExpenseId,
      expense_no: expenseNo,
      store_id: targetStoreId,
      region_id: store.region_id || null,
      region_name: store.Region?.name || '',
      expense_type_id: expenseType.type_id,
      expense_type: expenseType.name,
      expense_party: String(expenseParty).trim(),
      amount: Number(amount),
      payment_method: paymentMethod,
      has_invoice: hasInvoice ? 1 : 0,
      invoice_type: hasInvoice ? String(invoiceType || '').trim() : '',
      invoice_no: hasInvoice ? String(invoiceNo || '').trim() : '',
      expense_date: expenseDate || new Date(),
      attachment_urls: JSON.stringify(Array.isArray(attachmentUrls) ? attachmentUrls : []),
      status: isDraft ? 'draft' : (paymentMethod === 'CORPORATE' ? 'pending_payment' : 'pending_approval'),
      applicant_staff_id: existingRecord?.applicant_staff_id || user.staffId || user.id || null,
      applicant_name: existingRecord?.applicant_name || user.name || user.phone || '',
      source_type: 'expense',
      source_id: currentExpenseId,
      source_no: expenseNo,
      related_order_no: relatedOrderNo || '',
      remark: String(remark || '').trim(),
      create_user: existingRecord?.create_user || user.name || user.phone || '',
      create_time: existingRecord?.create_time || new Date(),
      update_time: new Date()
    };
    if (existingRecord) {
      record = await existingRecord.update(expensePayload, { transaction });
    } else {
      record = await Expense.create(expensePayload, { transaction });
    }

    if (!isDraft && paymentMethod === 'CORPORATE') {
      const payable = await ensureExpensePayable(record, { sourceType: 'expense' }, transaction);
      await record.update({ payable_id: payable.payable_id }, { transaction });
    }
  });

  ctx.body = {
    code: 0,
    expenseId: currentExpenseId,
    expenseNo,
    status: isDraft ? 'draft' : (paymentMethod === 'CORPORATE' ? 'pending_payment' : 'pending_approval'),
    message: isDraft ? '费用单草稿已保存' : (paymentMethod === 'CORPORATE'
      ? '费用已提交，并生成应付待付款记录'
      : '报销单已提交审批')
  };
}

function canManageExpenseDraft(user, record) {
  const roles = getUserRoles(user);
  const privileged = roles.some(role => ['boss', 'admin', 'manager', 'store_manager'].includes(role));
  return privileged
    || String(user?.staffId || user?.id || '') === String(record.applicant_staff_id || '')
    || String(user?.name || '') === String(record.applicant_name || record.create_user || '');
}

async function saveExpenseDraft(ctx) {
  ctx.request.body = { ...(ctx.request.body || {}), saveDraft: true };
  return createExpense(ctx);
}

async function updateExpenseDraft(ctx) {
  ctx.request.body = { ...(ctx.request.body || {}), saveDraft: true, expenseId: ctx.params.id };
  return createExpense(ctx);
}

async function deleteExpenseDraft(ctx) {
  const user = ctx.state.user;
  const record = await Expense.findOne({ where: { expense_id: ctx.params.id, is_deleted: 0 } });
  if (!record) ctx.throw(404, '费用单不存在');
  if (record.status !== 'draft') ctx.throw(400, '只有草稿状态的费用单可以删除');
  if (!canManageExpenseDraft(user, record)) ctx.throw(403, '只有费用单创建人、店长或管理员可以删除');
  await record.update({ is_deleted: 1, update_time: new Date() });
  ctx.body = { code: 0, message: '费用单草稿已删除', expenseId: record.expense_id };
}

/**
 * 支出列表
 */
async function getExpenseList(ctx) {
  const { storeId, expenseType, status, scope, startDate, endDate, page = 1, pageSize = 20 } = ctx.query;
  const user = ctx.state.user;
  const exportMode = Boolean(ctx.state.exportMode);

  const where = { is_deleted: 0 };
  const whereStore = {};

  if (!user.accessibleStoreIds.includes('*')) {
    whereStore.store_id = user.accessibleStoreIds;
  }
  if (storeId) {
    const allowedStoreIds = (user.accessibleStoreIds || []).map(String);
    if (!allowedStoreIds.includes('*') && !allowedStoreIds.includes(String(storeId))) {
      ctx.throw(403, '无权访问该门店费用记录');
    }
    whereStore.store_id = storeId;
  }

  const stores = await Store.findAll({ where: whereStore });
  const storeIds = stores.map(s => s.store_id);
  where.store_id = storeIds;

  if (expenseType) where.expense_type = expenseType;
  if (scope === 'my') where.applicant_staff_id = user.staffId || user.id || -1;
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

  const expenseQuery = {
    where,
    include: [
      { model: Store },
      { model: SettlementAccount, as: 'SettlementAccount', attributes: ['account_id', 'account_name', 'bank_name', 'account_number'] }
    ],
    order: buildPendingFirstOrder(sequelize, {
      statusColumn: 'Expense.status',
      pendingStatuses: ['draft', 'pending_approval', 'pending_payment', 'pending', 'processing'],
      dateColumns: ['Expense.create_time'],
      idColumn: 'Expense.expense_id'
    })
  };
  const result = exportMode
    ? { count: 0, rows: await Expense.findAll(expenseQuery) }
    : await Expense.findAndCountAll({ ...expenseQuery, ...paginate({}, { page, pageSize }) });
  const { count, rows } = result;

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

async function exportExpenseList(ctx) {
  ctx.state.exportMode = true;
  await getExpenseList(ctx);
  const rows = ctx.body?.list || [];
  const data = rows.map(row => {
    const item = row.toJSON ? row.toJSON() : row;
    return {
      费用单号: item.expense_no || '',
      时间: item.create_time || '',
      费用日期: item.expense_date || '',
      费用类型: item.expense_type || '',
      费用发生方: item.expense_party || '',
      金额: Number(item.amount || 0),
      已结算金额: Number(item.settled_amount || 0),
      门店: item.Store?.name || item.store_name || '',
      制单人: item.create_user || item.applicant_name || '',
      发起人: item.submit_user || '',
      状态: item.status || '',
      付款方式: item.payment_method || '',
      备注: item.remark || ''
    };
  });
  sendExcel(ctx, data, [
    '费用单号', '时间', '费用日期', '费用类型', '费用发生方', '金额', '已结算金额',
    '门店', '制单人', '发起人', '状态', '付款方式', '备注'
  ], `费用管理_${new Date().toISOString().slice(0, 10)}.xlsx`, '费用管理');
}

async function getExpenseDetail(ctx) {
  const user = ctx.state.user;
  const record = await Expense.findByPk(ctx.params.id, { include: [{ model: Store }] });
  if (!record || record.is_deleted) ctx.throw(404, '报销单不存在');

  const staffId = user.staffId || user.id;
  const isApplicant = Number(record.applicant_staff_id) === Number(staffId)
    || (!record.applicant_staff_id && [record.applicant_name, record.create_user].includes(user.name || user.phone));
  const roles = getUserRoles(user);
  const canViewAll = roles.some(role => ['finance', 'admin', 'boss'].includes(role));
  if (!isApplicant && !canViewAll) ctx.throw(403, '无权查看该报销申请');
  if (!user.accessibleStoreIds.includes('*') && !user.accessibleStoreIds.includes(record.store_id) && !canViewAll) {
    ctx.throw(403, '无权查看该门店的报销申请');
  }

  ctx.body = { code: 0, data: record.toJSON() };
}

function assertPurchaseExpenseReviewAllowed(action, sourceType, purchase) {
  // 采购被拒后，关联的采购垫付报销仍必须能够走“拒绝”结案；
  // 只有报销通过时才要求采购申请已经通过。
  if (action !== 'approved' || sourceType !== 'purchase') return;
  if (!purchase || purchase.status !== 'approved') throw new Error('关联采购申请尚未审批通过');
}

async function reviewExpense(ctx) {
  const user = ctx.state.user;
  const { action, comment } = ctx.request.body;
  if (!['approved', 'rejected'].includes(action)) ctx.throw(400, '审批动作无效');
  const record = await Expense.findByPk(ctx.params.id);
  if (!record || record.is_deleted) ctx.throw(404, '报销单不存在');
  if (record.status !== 'pending_approval') ctx.throw(400, '当前报销单不可审批');
  if (record.source_type === 'purchase') {
    const purchase = await PurchaseRequest.findByPk(record.source_id);
    try {
      assertPurchaseExpenseReviewAllowed(action, record.source_type, purchase);
    } catch (error) {
      ctx.throw(400, error.message);
    }
  }

  await sequelize.transaction(async transaction => {
    await record.update({
      status: action,
      review_staff_id: user.staffId || user.id || null,
      review_user_name: user.name || user.phone || '',
      review_comment: String(comment || '').trim(),
      review_time: new Date(),
      update_time: new Date()
    }, { transaction });
    if (action === 'approved') {
      await ensureExpensePayable(record, {
        sourceType: record.payment_method === 'PERSONAL_ADVANCE' ? 'reimbursement' : 'expense',
        status: 'unpaid'
      }, transaction);
    }
  });
  ctx.body = {
    code: 0,
    message: action === 'approved' ? '审批通过，已进入待结算列表' : '报销申请已拒绝',
    data: null
  };
}

async function cancelExpense(ctx) {
  const user = ctx.state.user;
  const { reason = '报销申请已撤销' } = ctx.request.body || {};
  const staffId = user.staffId || user.id;

  await sequelize.transaction(async transaction => {
    const record = await Expense.findByPk(ctx.params.id, {
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!record || record.is_deleted) ctx.throw(404, '报销单不存在');
    const isApplicant = Number(record.applicant_staff_id) === Number(staffId)
      || (!record.applicant_staff_id && [record.applicant_name, record.create_user].includes(user.name || user.phone));
    if (!isApplicant) ctx.throw(403, '只有申请人可以撤销该报销');
    if (!['pending_approval', 'approved', 'pending_payment', 'pending', 'processing'].includes(record.status)) {
      ctx.throw(400, '当前报销状态不允许撤销');
    }
    await cancelExpenseRecord(record, user, transaction, String(reason || '').trim() || '报销申请已撤销');
  });

  ctx.body = { code: 0, expenseId: ctx.params.id, status: 'cancelled', message: '报销申请已撤销' };
}

/**
 * 应付列表
 */
// ==============================================
// 结算账户流水管理
// ==============================================

async function getSettlementAccountsWithBalance(ctx) {
  try {
    const { page = 1, pageSize = 20, regionId } = ctx.query;
    const accountWhere = { status: 1 };
    if (regionId) accountWhere.region_id = regionId;

    const { count, rows } = await SettlementAccount.findAndCountAll({
      where: accountWhere,
      include: [{ model: Region, attributes: ['region_id', 'region_code', 'name'] }],
      order: [['sort_order', 'ASC']],
      ...paginate({}, { page, pageSize })
    });

    const supplierIds = [...new Set(rows.map(row => row.supplier_id).filter(Boolean))];
    const suppliers = supplierIds.length > 0
      ? await Supplier.findAll({ where: { supplier_id: supplierIds }, attributes: ['supplier_id', 'name'], raw: true })
      : [];
    const supplierNameMap = new Map(suppliers.map(supplier => [supplier.supplier_id, supplier.name]));

    const accountIds = rows.map(a => a.account_id);
    const balanceMap = {};

    if (accountIds.length > 0) {
      try {
        const accountTransactions = await SettlementAccountTransaction.findAll({
          attributes: ['account_id', 'type', 'amount'],
          where: { account_id: accountIds },
          raw: true
        });

        for (const tx of accountTransactions) {
          const amount = Number(tx.amount) || 0;
          balanceMap[tx.account_id] = (balanceMap[tx.account_id] || 0) + (tx.type === 'income' ? amount : -amount);
        }
      } catch (e) {
        console.error('查询账户余额失败(表可能尚未创建):', e.message);
      }
    }

    const policyAccountIds = rows.filter(row => row.account_type === 'POLICY_RECEIVABLE').map(row => row.account_id);
    if (policyAccountIds.length > 0) {
      const receivables = await DailyStatementDetail.findAll({
        attributes: [
          'settlement_account_id',
          [Sequelize.fn('SUM', Sequelize.literal('GREATEST(AMOUNT - SETTLED, 0)')), 'outstanding']
        ],
        where: {
          settlement_account_id: policyAccountIds,
          [Op.or]: [
            { business_type: 'national_subsidy_receivable' },
            { payment_method: { [Op.like]: '国补POS%-政策补贴应收' } }
          ]
        },
        group: ['settlement_account_id'],
        raw: true
      });
      for (const row of receivables) balanceMap[row.settlement_account_id] = Number(row.outstanding || 0);
    }

    const list = rows.map(row => ({
      ...row.toJSON(),
      supplier_name: row.supplier_id ? (supplierNameMap.get(row.supplier_id) || '') : '',
      balance: Math.round((balanceMap[row.account_id] || 0) * 100) / 100
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

  const currentBalance = await getAccountBalance(accountId);

  ctx.body = {
    code: 0,
    data: {
      account,
      currentBalance,
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
  if (account.account_type === 'SUPPLIER_REBATE') ctx.throw(400, '供应商返利请在返利管理中上账、抵扣或冲销');

  const currentBalance = await getAccountBalance(accountId);
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

const money = value => Math.round(Number(value || 0) * 100) / 100;
const userIdOf = user => String(user?.staffId || user?.staff_id || user?.id || '');

async function updateStatementSettled(statementId, delta, user, transaction) {
  const statement = await DailyStatement.findByPk(statementId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!statement) return;
  const totalSettled = money(Number(statement.total_settled || 0) + Number(delta || 0));
  const totalRevenue = money(statement.total_revenue);
  await statement.update({
    total_settled: totalSettled,
    status: totalSettled >= totalRevenue ? 'settled' : (totalSettled > 0 ? 'partial' : 'pending'),
    confirm_staff: user.name || userIdOf(user)
  }, { transaction });
}

async function getSubsidyAccountRoutes(ctx) {
  const regions = await Region.findAll({ where: { status: 1 }, order: [['sort_order', 'ASC']] });
  const routes = await SubsidyAccountRoute.findAll();
  const routeMap = new Map(routes.map(row => [row.region_id, row]));
  const accountIds = routes.map(row => row.account_id).filter(Boolean);
  const accounts = accountIds.length
    ? await SettlementAccount.findAll({ where: { account_id: accountIds, status: 1, account_type: 'FUND' } })
    : [];
  const accountMap = new Map(accounts.map(row => [row.account_id, row]));
  ctx.body = {
    code: 0,
    data: regions.map(region => {
      const route = routeMap.get(region.region_id);
      return {
        region_id: region.region_id,
        region_name: region.name,
        account_id: route?.account_id || '',
        account: route?.account_id ? accountMap.get(route.account_id) || null : null,
        update_user: route?.update_user || '',
        update_time: route?.update_time || null
      };
    })
  };
}

async function saveSubsidyAccountRoute(ctx) {
  const { regionId, accountId = '' } = ctx.request.body || {};
  const region = await Region.findByPk(regionId);
  if (!region) ctx.throw(404, '区域不存在');
  if (accountId) {
    const account = await SettlementAccount.findOne({ where: { account_id: accountId, account_type: 'FUND', status: 1 } });
    if (!account) ctx.throw(400, '国补到账账户必须是启用的资金账户');
  }
  await SubsidyAccountRoute.upsert({
    region_id: regionId,
    account_id: accountId || null,
    update_user: ctx.state.user.name || userIdOf(ctx.state.user),
    update_time: new Date()
  });
  ctx.body = { code: 0, message: accountId ? '区域到账账户已保存' : '区域到账账户已清空' };
}

async function validateSubsidyDetails(detailIds, transaction, user = null) {
  const details = await DailyStatementDetail.findAll({
    where: {
      detail_id: detailIds,
      [Op.or]: [
        { business_type: 'national_subsidy_receivable' },
        { payment_method: { [Op.like]: '国补POS%-政策补贴应收' } }
      ]
    },
    transaction,
    lock: transaction.LOCK.UPDATE
  });
  if (details.length !== detailIds.length) ctxThrow(400, '存在无效的国补应收单');
  const statements = await DailyStatement.findAll({
    where: { statement_id: [...new Set(details.map(row => row.statement_id))] },
    transaction
  });
  const statementMap = new Map(statements.map(row => [row.statement_id, row]));
  const storeIds = [...new Set(statements.map(row => row.store_id))];
  const stores = await Store.findAll({ where: { store_id: storeIds }, transaction });
  const storeMap = new Map(stores.map(row => [row.store_id, row]));
  if (user && Array.isArray(user.accessibleStoreIds) && !user.accessibleStoreIds.includes('*')) {
    const allowed = new Set((user.accessibleStoreIds || []).map(String));
    if (stores.some(store => !allowed.has(String(store.store_id)))) ctxThrow(403, '无权核销所选门店的国补应收');
  }
  const regionIds = [...new Set(details.map(row => {
    const statement = statementMap.get(row.statement_id);
    return storeMap.get(statement?.store_id)?.region_id || '';
  }))];
  if (regionIds.length !== 1 || !regionIds[0]) ctxThrow(400, '所选应收单必须属于同一且已配置的区域');
  return { details, regionId: regionIds[0] };
}

function ctxThrow(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

async function createSubsidyReceipt(ctx) {
  const user = ctx.state.user;
  const { receiptDate, bankReference = '', amount, allocations = [], remark = '', accountId = '' } = ctx.request.body || {};
  const receiptAmount = money(amount);
  if (!receiptDate) ctx.throw(400, '请选择到账日期');
  if (receiptAmount <= 0) ctx.throw(400, '到账金额必须大于0');
  if (!Array.isArray(allocations) || allocations.length === 0) ctx.throw(400, '请至少选择一笔国补应收进行核销');
  const normalized = allocations.map(row => ({ detailId: row.detailId, amount: money(row.amount) })).filter(row => row.detailId && row.amount > 0);
  if (normalized.length !== allocations.length) ctx.throw(400, '核销明细金额必须大于0');
  const detailIds = [...new Set(normalized.map(row => row.detailId))];
  if (detailIds.length !== normalized.length) ctx.throw(400, '同一应收单不能重复分配');
  const allocatedAmount = money(normalized.reduce((sum, row) => sum + row.amount, 0));
  if (allocatedAmount > receiptAmount) ctx.throw(400, '分配金额不得超过银行实际到账金额');

  let result;
  await sequelize.transaction(async transaction => {
    const { details, regionId } = await validateSubsidyDetails(detailIds, transaction, user);
    const route = await SubsidyAccountRoute.findByPk(regionId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!route?.account_id) ctx.throw(400, '该区域尚未配置国补到账资金账户');
    const effectiveAccountId = accountId || route.account_id;
    const account = await SettlementAccount.findOne({
      where: { account_id: effectiveAccountId, account_type: 'FUND', status: 1 },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!account) ctx.throw(400, '到账资金账户不存在、已停用或不是资金账户');
    const normalizedBankReference = String(bankReference || '').trim();
    if (normalizedBankReference) {
      const duplicateReceipt = await SubsidyReceipt.findOne({
        where: { account_id: account.account_id, bank_reference: normalizedBankReference },
        transaction
      });
      if (duplicateReceipt) ctx.throw(400, '该资金账户下的银行流水号已登记');
    }

    const detailMap = new Map(details.map(row => [row.detail_id, row]));
    for (const item of normalized) {
      const detail = detailMap.get(item.detailId);
      const remaining = money(Number(detail.amount || 0) - Number(detail.settled || 0));
      if (item.amount > remaining) ctx.throw(400, `订单 ${detail.order_no || detail.detail_id} 的核销金额超过剩余应收`);
    }

    const receiptId = generateUUID();
    const receiptNo = `GBDZ${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;
    const receipt = await SubsidyReceipt.create({
      receipt_id: receiptId,
      receipt_no: receiptNo,
      region_id: regionId,
      account_id: account.account_id,
      account_name_snapshot: account.account_name,
      receipt_date: receiptDate,
      bank_reference: normalizedBankReference || null,
      amount: receiptAmount,
      allocated_amount: allocatedAmount,
      refunded_amount: 0,
      status: allocatedAmount >= receiptAmount ? 'ALLOCATED' : 'PARTIAL',
      remark,
      create_user: user.name || userIdOf(user)
    }, { transaction });

    for (const item of normalized) {
      const detail = detailMap.get(item.detailId);
      const newSettled = money(Number(detail.settled || 0) + item.amount);
      await SubsidyReceiptAllocation.create({
        allocation_id: generateUUID(),
        receipt_id: receiptId,
        detail_id: detail.detail_id,
        amount: item.amount,
        create_user: user.name || userIdOf(user)
      }, { transaction });
      await detail.update({
        settled: newSettled,
        settled_at: newSettled >= Number(detail.amount || 0) ? new Date() : null
      }, { transaction });
      await updateStatementSettled(detail.statement_id, item.amount, user, transaction);
    }

    const currentBalance = await getAccountBalance(account.account_id, transaction);
    await SettlementAccountTransaction.create({
      transaction_id: generateUUID(),
      account_id: account.account_id,
      type: 'income',
      amount: receiptAmount,
      balance_after: money(currentBalance + receiptAmount),
      description: `国补银行到账 ${receiptNo}`,
      related_ref: receiptNo,
      create_user: user.name || userIdOf(user)
    }, { transaction });
    result = receipt;
  });
  ctx.body = { code: 0, message: '国补到账登记成功', data: result };
}

async function getSubsidyReceipts(ctx) {
  const { page = 1, pageSize = 20, regionId } = ctx.query;
  const where = {};
  if (regionId) where.region_id = regionId;
  const { count, rows } = await SubsidyReceipt.findAndCountAll({
    where,
    order: [['receipt_date', 'DESC'], ['create_time', 'DESC']],
    ...paginate({}, { page, pageSize })
  });
  const list = rows.map(row => ({
    ...row.toJSON(),
    unallocated_amount: row.status === 'REVERSED'
      ? 0
      : money(Number(row.amount || 0) - Number(row.allocated_amount || 0) - Number(row.refunded_amount || 0))
  }));
  ctx.body = formatPaginatedResult(list, { page, pageSize, count });
}

async function allocateSubsidyReceipt(ctx) {
  const user = ctx.state.user;
  const { id } = ctx.params;
  const { allocations = [] } = ctx.request.body || {};
  const normalized = allocations.map(row => ({ detailId: row.detailId, amount: money(row.amount) })).filter(row => row.detailId && row.amount > 0);
  if (!normalized.length) ctx.throw(400, '请填写核销明细');
  await sequelize.transaction(async transaction => {
    const receipt = await SubsidyReceipt.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!receipt) ctx.throw(404, '到账单不存在');
    const total = money(normalized.reduce((sum, row) => sum + row.amount, 0));
    const available = money(Number(receipt.amount) - Number(receipt.allocated_amount) - Number(receipt.refunded_amount));
    if (total > available) ctx.throw(400, '核销金额超过到账单未分配金额');
    const { details, regionId } = await validateSubsidyDetails(normalized.map(row => row.detailId), transaction, user);
    if (regionId !== receipt.region_id) ctx.throw(400, '到账单与应收单区域不一致');
    const detailMap = new Map(details.map(row => [row.detail_id, row]));
    for (const item of normalized) {
      const detail = detailMap.get(item.detailId);
      const remaining = money(Number(detail.amount) - Number(detail.settled));
      if (item.amount > remaining) ctx.throw(400, `订单 ${detail.order_no || detail.detail_id} 的核销金额超过剩余应收`);
      await SubsidyReceiptAllocation.create({
        allocation_id: generateUUID(), receipt_id: id, detail_id: item.detailId, amount: item.amount,
        create_user: user.name || userIdOf(user)
      }, { transaction });
      const settled = money(Number(detail.settled) + item.amount);
      await detail.update({ settled, settled_at: settled >= Number(detail.amount) ? new Date() : null }, { transaction });
      await updateStatementSettled(detail.statement_id, item.amount, user, transaction);
    }
    const allocated = money(Number(receipt.allocated_amount) + total);
    await receipt.update({
      allocated_amount: allocated,
      status: allocated + Number(receipt.refunded_amount) >= Number(receipt.amount) ? 'ALLOCATED' : 'PARTIAL'
    }, { transaction });
  });
  ctx.body = { code: 0, message: '未分配到账款核销成功' };
}

async function refundSubsidyReceipt(ctx) {
  const user = ctx.state.user;
  const { id } = ctx.params;
  const { amount, remark = '' } = ctx.request.body || {};
  const refundAmount = money(amount);
  if (refundAmount <= 0) ctx.throw(400, '退款金额必须大于0');
  await sequelize.transaction(async transaction => {
    const receipt = await SubsidyReceipt.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!receipt) ctx.throw(404, '到账单不存在');
    const available = money(Number(receipt.amount) - Number(receipt.allocated_amount) - Number(receipt.refunded_amount));
    if (refundAmount > available) ctx.throw(400, '退款金额超过未分配到账款');
    const account = await SettlementAccount.findByPk(receipt.account_id, { transaction, lock: transaction.LOCK.UPDATE });
    const currentBalance = await getAccountBalance(receipt.account_id, transaction);
    await SettlementAccountTransaction.create({
      transaction_id: generateUUID(), account_id: receipt.account_id, type: 'expense', amount: refundAmount,
      balance_after: money(currentBalance - refundAmount), description: `国补未分配到账款退款 ${receipt.receipt_no} ${remark}`,
      related_ref: `${receipt.receipt_no}_REFUND`, create_user: user.name || userIdOf(user)
    }, { transaction });
    const refunded = money(Number(receipt.refunded_amount) + refundAmount);
    await receipt.update({
      refunded_amount: refunded,
      status: Number(receipt.allocated_amount) + refunded >= Number(receipt.amount) ? 'CLOSED' : 'PARTIAL'
    }, { transaction });
  });
  ctx.body = { code: 0, message: '退款登记成功' };
}

async function reverseSubsidyReceipt(ctx) {
  const user = ctx.state.user;
  const { id } = ctx.params;
  const { reason } = ctx.request.body || {};
  if (!String(reason || '').trim()) ctx.throw(400, '请填写冲销原因');
  await sequelize.transaction(async transaction => {
    const receipt = await SubsidyReceipt.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!receipt) ctx.throw(404, '到账单不存在');
    if (receipt.status === 'REVERSED') ctx.throw(400, '该到账单已冲销');
    if (Number(receipt.refunded_amount || 0) > 0) ctx.throw(400, '已发生退款的到账单不能直接冲销');
    const allocations = await SubsidyReceiptAllocation.findAll({ where: { receipt_id: id }, transaction });
    for (const allocation of allocations) {
      const detail = await DailyStatementDetail.findByPk(allocation.detail_id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!detail) continue;
      const settled = Math.max(0, money(Number(detail.settled) - Number(allocation.amount)));
      await detail.update({ settled, settled_at: null }, { transaction });
      await updateStatementSettled(detail.statement_id, -Number(allocation.amount), user, transaction);
    }
    const account = await SettlementAccount.findByPk(receipt.account_id, { transaction, lock: transaction.LOCK.UPDATE });
    const currentBalance = await getAccountBalance(receipt.account_id, transaction);
    await SettlementAccountTransaction.create({
      transaction_id: generateUUID(), account_id: receipt.account_id, type: 'expense', amount: receipt.amount,
      balance_after: money(currentBalance - Number(receipt.amount)), description: `冲销国补到账 ${receipt.receipt_no}：${reason}`,
      related_ref: `${receipt.receipt_no}_REVERSE`, create_user: user.name || userIdOf(user)
    }, { transaction });
    await receipt.update({
      status: 'REVERSED', reverse_reason: String(reason).trim(),
      reversed_by: user.name || userIdOf(user), reversed_at: new Date()
    }, { transaction });
  });
  ctx.body = { code: 0, message: '到账单已冲销' };
}

async function submitSubsidyAdjustment(ctx) {
  const user = ctx.state.user;
  const { detailId, adjustmentType, amount, financeCategory, reason } = ctx.request.body || {};
  const adjustmentAmount = money(amount);
  if (!['FEE', 'WRITEOFF'].includes(adjustmentType)) ctx.throw(400, '差额类型无效');
  if (adjustmentAmount <= 0) ctx.throw(400, '差额金额必须大于0');
  if (!String(financeCategory || '').trim()) ctx.throw(400, '请填写财务处理科目');
  if (!String(reason || '').trim()) ctx.throw(400, '请填写差额原因');
  await sequelize.transaction(async transaction => {
    const detail = await DailyStatementDetail.findByPk(detailId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!detail) ctx.throw(404, '国补应收单不存在');
    await validateSubsidyDetails([detailId], transaction, user);
    const pending = Number(await SubsidyReceivableAdjustment.sum('amount', {
      where: { detail_id: detailId, status: 'PENDING' },
      transaction
    }) || 0);
    const remaining = money(Number(detail.amount) - Number(detail.settled) - pending);
    if (adjustmentAmount > remaining) ctx.throw(400, '差额金额超过剩余应收');
    await SubsidyReceivableAdjustment.create({
      adjustment_id: generateUUID(), detail_id: detailId, adjustment_type: adjustmentType,
      amount: adjustmentAmount, finance_category: String(financeCategory).trim(),
      reason: String(reason).trim(), status: 'PENDING',
      applicant_id: userIdOf(user), applicant_name: user.name || userIdOf(user)
    }, { transaction });
  });
  ctx.body = { code: 0, message: '差额审批已提交' };
}

async function getSubsidyAdjustments(ctx) {
  const { status = 'PENDING', page = 1, pageSize = 20 } = ctx.query;
  const where = {};
  if (status) where.status = status;
  const { count, rows } = await SubsidyReceivableAdjustment.findAndCountAll({
    where, order: [['create_time', 'DESC']], ...paginate({}, { page, pageSize })
  });
  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

async function reviewSubsidyAdjustment(ctx) {
  const user = ctx.state.user;
  const { id } = ctx.params;
  const { action, comment = '' } = ctx.request.body || {};
  if (!getUserRoles(user).some(role => ['admin', 'boss'].includes(role))) ctx.throw(403, '只有 admin 或 BOSS 可以审批国补差额');
  if (!['approve', 'reject'].includes(action)) ctx.throw(400, '审批动作无效');
  await sequelize.transaction(async transaction => {
    const adjustment = await SubsidyReceivableAdjustment.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!adjustment) ctx.throw(404, '差额审批不存在');
    if (adjustment.status !== 'PENDING') ctx.throw(400, '该差额已审批');
    if (action === 'approve') {
      const detail = await DailyStatementDetail.findByPk(adjustment.detail_id, { transaction, lock: transaction.LOCK.UPDATE });
      const remaining = money(Number(detail.amount) - Number(detail.settled));
      if (Number(adjustment.amount) > remaining) ctx.throw(400, '差额金额超过当前剩余应收');
      const settled = money(Number(detail.settled) + Number(adjustment.amount));
      await detail.update({ settled, settled_at: settled >= Number(detail.amount) ? new Date() : null }, { transaction });
      await updateStatementSettled(detail.statement_id, adjustment.amount, user, transaction);
    }
    await adjustment.update({
      status: action === 'approve' ? 'APPROVED' : 'REJECTED',
      reviewer_id: userIdOf(user), reviewer_name: user.name || userIdOf(user),
      review_comment: comment, review_time: new Date()
    }, { transaction });
  });
  ctx.body = { code: 0, message: action === 'approve' ? '差额审批通过' : '差额审批已拒绝' };
}

async function reverseSubsidyAdjustment(ctx) {
  const user = ctx.state.user;
  const { id } = ctx.params;
  const { reason } = ctx.request.body || {};
  if (!getUserRoles(user).some(role => ['admin', 'boss'].includes(role))) ctx.throw(403, '只有 admin 或 BOSS 可以冲销国补差额');
  if (!String(reason || '').trim()) ctx.throw(400, '请填写冲销原因');
  await sequelize.transaction(async transaction => {
    const adjustment = await SubsidyReceivableAdjustment.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!adjustment) ctx.throw(404, '差额审批不存在');
    if (adjustment.status !== 'APPROVED') ctx.throw(400, '只有已通过差额可以冲销');
    const detail = await DailyStatementDetail.findByPk(adjustment.detail_id, { transaction, lock: transaction.LOCK.UPDATE });
    const settled = Math.max(0, money(Number(detail.settled) - Number(adjustment.amount)));
    await detail.update({ settled, settled_at: null }, { transaction });
    await updateStatementSettled(detail.statement_id, -Number(adjustment.amount), user, transaction);
    await adjustment.update({
      status: 'REVERSED', reviewer_id: userIdOf(user), reviewer_name: user.name || userIdOf(user),
      review_comment: `冲销：${String(reason).trim()}`, review_time: new Date()
    }, { transaction });
  });
  ctx.body = { code: 0, message: '差额已冲销' };
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
  buildDailyPaymentMethodWhere,
  getDailyDetails,
  getNationalSubsidyReceivables,
  exportDailyDetails,
  exportNationalSubsidyReceivables,
  getDailyStatement,
  getDailyStatementDetail,
  batchSettle,
  settleNationalSubsidyReceivables,
  getSettlementSummary,
  createExpense,
  saveExpenseDraft,
  updateExpenseDraft,
  deleteExpenseDraft,
  getExpenseList,
  exportExpenseList,
  getExpenseDetail,
  assertPurchaseExpenseReviewAllowed,
  reviewExpense,
  cancelExpense,
  submitExpense,
  payExpense,
  getPayableList,
  getSettlementAccountsWithBalance,
  getAccountTransactions,
  addAccountTransaction,
  getSubsidyAccountRoutes,
  saveSubsidyAccountRoute,
  createSubsidyReceipt,
  getSubsidyReceipts,
  allocateSubsidyReceipt,
  refundSubsidyReceipt,
  reverseSubsidyReceipt,
  submitSubsidyAdjustment,
  getSubsidyAdjustments,
  reviewSubsidyAdjustment,
  reverseSubsidyAdjustment
};
