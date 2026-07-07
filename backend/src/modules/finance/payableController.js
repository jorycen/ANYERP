/**
 * 应付管理控制器
 */
const {
  Payable,
  Settlement,
  SettlementItem,
  SettlementPaymentBatch,
  SettlementPaymentRecord,
  Expense,
  Supplier,
  SupplierPaymentAccount,
  SettlementAccount,
  SettlementAccountTransaction,
  sequelize
} = require('../../models');
const { Op, col, where } = require('sequelize');
const { generateUUID, paginate, formatPaginatedResult, buildPendingFirstOrder } = require('../../utils');
const moment = require('moment');
const XLSX = require('xlsx');

/**
 * 应付款列表
 */
async function getPayableList(ctx) {
  const { supplierId, status, startDate, endDate, page = 1, pageSize = 20 } = ctx.query;
  const where = {};

  if (supplierId) where.supplier_id = supplierId;
  if (status) where.status = status;
  if (startDate || endDate) {
    where.create_time = {};
    if (startDate) where.create_time[Op.gte] = new Date(`${startDate}T00:00:00.000+08:00`);
    if (endDate) where.create_time[Op.lte] = new Date(`${endDate}T23:59:59.999+08:00`);
  }

  const { count, rows } = await Payable.findAndCountAll({
    where,
    order: buildPendingFirstOrder(sequelize, {
      statusColumn: 'Payable.status',
      pendingStatuses: ['unpaid'],
      dateColumns: ['Payable.create_time'],
      idColumn: 'Payable.payable_id'
    }),
    ...paginate({}, { page, pageSize })
  });

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

/**
 * 获取供应商未结算的应付款列表
 */
async function getUnpaidBySupplier(ctx) {
  const { supplierId } = ctx.query;

  if (!supplierId) {
    ctx.throw(400, '请选择供应商');
  }

  const rows = await Payable.findAll({
    where: {
      supplier_id: supplierId,
      status: 'unpaid'
    },
    order: [['create_time', 'DESC']]
  });

  ctx.body = { code: 0, data: rows };
}

/**
 * 创建结算单
 */
async function createSettlement(ctx) {
  const {
    supplierId,
    payableIds,
    supplierAccountId,
    paymentAccountType = 'saved',
    otherPaymentRemark,
    otherPaymentImage
  } = ctx.request.body;
  const user = ctx.state.user;

  if (!supplierId) {
    ctx.throw(400, '请选择供应商');
  }

  if (!payableIds || payableIds.length === 0) {
    ctx.throw(400, '请选择需要结算的应付款项');
  }

  const supplier = await Supplier.findByPk(supplierId);
  if (!supplier) {
    ctx.throw(404, '供应商不存在');
  }

  const payables = await Payable.findAll({
    where: {
      payable_id: { [Op.in]: payableIds },
      supplier_id: supplierId,
      status: 'unpaid'
    }
  });

  if (payables.length === 0) {
    ctx.throw(400, '没有可结算的应付款项');
  }

  let supplierAccountSnapshot = null;
  let finalSupplierAccountId = null;
  let finalOtherPaymentRemark = null;
  let finalOtherPaymentImage = null;

  if (paymentAccountType === 'other') {
    if (!otherPaymentRemark || !String(otherPaymentRemark).trim()) {
      ctx.throw(400, '请选择其他账户时必须填写说明');
    }
    if (!otherPaymentImage) {
      ctx.throw(400, '请选择其他账户时必须上传凭证图片');
    }
    finalOtherPaymentRemark = String(otherPaymentRemark).trim();
    finalOtherPaymentImage = otherPaymentImage;
  } else {
    if (!supplierAccountId) {
      ctx.throw(400, '请选择供应商付款账户');
    }

    const supplierAccount = await SupplierPaymentAccount.findOne({
      where: {
        account_id: supplierAccountId,
        supplier_id: supplierId,
        status: 1,
        is_deleted: 0
      }
    });

    if (!supplierAccount) {
      ctx.throw(404, '供应商付款账户不存在或已停用');
    }

    finalSupplierAccountId = supplierAccount.account_id;
    supplierAccountSnapshot = JSON.stringify({
      accountId: supplierAccount.account_id,
      companyName: supplierAccount.company_name || '',
      taxNo: supplierAccount.tax_no || '',
      bankName: supplierAccount.bank_name || '',
      accountNumber: supplierAccount.account_number || '',
      remark: supplierAccount.remark || ''
    });
  }

  const settlementId = generateUUID();
  const dateStr = moment().format('YYYYMMDD');
  const seq = `S${dateStr}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
  let totalAmount = 0;

  const settlement = await sequelize.transaction(async (transaction) => {
    const created = await Settlement.create({
      settlement_id: settlementId,
      settlement_no: seq,
      supplier_id: supplierId,
      supplier_name: supplier.name,
      supplier_account_id: finalSupplierAccountId,
      supplier_account_snapshot: supplierAccountSnapshot,
      other_payment_remark: finalOtherPaymentRemark,
      other_payment_image: finalOtherPaymentImage,
      total_amount: 0,
      status: 'draft',
      payment_status: 'unpaid',
      create_user: user.name || user.phone
    }, { transaction });

    for (const payable of payables) {
      totalAmount += parseFloat(payable.total_amount);

      await SettlementItem.create({
        settlement_id: settlementId,
        payable_id: payable.payable_id,
        request_no: payable.request_no,
        amount: payable.total_amount
      }, { transaction });

      await payable.update({
        status: 'settling',
        paid_amount: 0
      }, { transaction });
    }

    await created.update({ total_amount: totalAmount }, { transaction });
    return created;
  });

  ctx.body = { code: 0, message: '结算单创建成功', data: settlement };
}

async function createExpenseSettlement(ctx) {
  const { payableId } = ctx.request.body;
  const user = ctx.state.user;
  if (!payableId) ctx.throw(400, '应付款ID不能为空');

  let settlement;
  await sequelize.transaction(async transaction => {
    const payable = await Payable.findByPk(payableId, {
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!payable || payable.source_type !== 'expense') ctx.throw(404, '费用应付款不存在');
    if (payable.status !== 'unpaid') ctx.throw(400, '当前费用应付款已生成结算单');

    settlement = await Settlement.create({
      settlement_id: generateUUID(),
      settlement_no: `EXS${moment().format('YYYYMMDDHHmmss')}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`,
      supplier_id: null,
      supplier_name: payable.payee_name || payable.supplier_name || '费用发生方',
      settlement_type: 'expense',
      payee_type: payable.payee_type || 'counterparty',
      payee_id: payable.payee_id || '',
      payee_name: payable.payee_name || payable.supplier_name || '',
      source_type: 'expense',
      source_id: payable.source_id,
      source_no: payable.source_no || payable.request_no,
      other_payment_remark: '财务对公费用',
      total_amount: payable.total_amount,
      paid_amount: 0,
      status: 'draft',
      payment_status: 'unpaid',
      create_user: user.name || user.phone || ''
    }, { transaction });
    await SettlementItem.create({
      settlement_id: settlement.settlement_id,
      payable_id: payable.payable_id,
      request_no: payable.source_no || payable.request_no,
      amount: payable.total_amount
    }, { transaction });
    await payable.update({ status: 'settling', paid_amount: 0 }, { transaction });
    if (payable.source_id) {
      await Expense.update({
        settlement_id: settlement.settlement_id,
        update_time: new Date()
      }, {
        where: { expense_id: payable.source_id },
        transaction
      });
    }
  });
  ctx.body = { code: 0, message: '费用结算单已生成', data: settlement };
}

function parseJsonText(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (err) {
    return fallback;
  }
}

function normalizeSettlement(row) {
  const data = row.toJSON ? row.toJSON() : row;
  return {
    ...data,
    supplier_account_snapshot_parsed: parseJsonText(data.supplier_account_snapshot)
  };
}

function normalizeSettlements(rows) {
  return rows.map(normalizeSettlement);
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const normalized = String(value).replace(/[¥,\s]/g, '');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : NaN;
}

function roundAmount(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function getRemainingAmount(settlement) {
  return roundAmount(Number(settlement.total_amount || 0) - Number(settlement.paid_amount || 0));
}

function getPaymentStatus(totalAmount, paidAmount) {
  const total = roundAmount(totalAmount);
  const paid = roundAmount(paidAmount);
  if (paid <= 0) return 'unpaid';
  if (paid < total) return 'partial_paid';
  return 'paid';
}

function getImportValue(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
      return row[key];
    }
  }
  return '';
}

function makePaymentImportKey(settlement) {
  return `${settlement.settlement_id}:${settlement.settlement_no}:${Number(settlement.total_amount || 0)}:${Number(settlement.paid_amount || 0)}`;
}

async function getCurrentAccountBalance(accountId, transaction = null) {
  const [incomeAmount, expenseAmount] = await Promise.all([
    SettlementAccountTransaction.sum('amount', {
      where: { account_id: accountId, type: 'income' },
      transaction
    }),
    SettlementAccountTransaction.sum('amount', {
      where: { account_id: accountId, type: 'expense' },
      transaction
    })
  ]);
  return roundAmount(Number(incomeAmount || 0) - Number(expenseAmount || 0));
}

async function refreshSettlementPaymentState(settlement, transaction = null) {
  const totalPaid = await SettlementPaymentRecord.sum('amount', {
    where: {
      settlement_id: settlement.settlement_id,
      status: 'active'
    },
    transaction
  });
  const paidAmount = roundAmount(totalPaid || 0);
  const paymentStatus = getPaymentStatus(settlement.total_amount, paidAmount);

  await settlement.update({
    paid_amount: paidAmount,
    payment_status: paymentStatus,
    paid_time: paymentStatus === 'paid' ? new Date() : null
  }, { transaction });

  const items = settlement.items || await SettlementItem.findAll({
    where: { settlement_id: settlement.settlement_id },
    transaction
  });

  for (const item of items) {
    const payable = await Payable.findByPk(item.payable_id, { transaction });
    if (!payable) continue;
    await payable.update({
      status: paymentStatus === 'paid' ? 'paid' : 'settling',
      paid_amount: paymentStatus === 'paid' ? payable.total_amount : 0
    }, { transaction });
  }

  if (paymentStatus === 'paid' && settlement.source_id && ['expense', 'reimbursement'].includes(settlement.settlement_type)) {
    await Expense.update({
      status: 'paid',
      settled_at: new Date(),
      update_time: new Date()
    }, {
      where: { expense_id: settlement.source_id },
      transaction
    });
  }

  return { paidAmount, paymentStatus };
}

/**
 * 结算单列表
 */
async function getSettlementList(ctx) {
  const { supplierId, settlementType, status, paymentStatus, page = 1, pageSize = 20 } = ctx.query;
  const where = {};

  if (supplierId) where.supplier_id = supplierId;
  if (settlementType) {
    const settlementTypes = String(settlementType).split(',').map(item => item.trim()).filter(Boolean);
    where.settlement_type = settlementTypes.length > 1 ? { [Op.in]: settlementTypes } : settlementTypes[0];
  }
  if (status) where.status = status;
  if (paymentStatus) where.payment_status = paymentStatus;

  const order = [
    [
      sequelize.literal(
        "CASE WHEN `Settlement`.`status` = 'draft' OR " +
        "(`Settlement`.`status` = 'confirmed' AND `Settlement`.`payment_status` IN ('unpaid', 'partial')) " +
        'THEN 0 ELSE 1 END'
      ),
      'ASC'
    ],
    [sequelize.literal('`Settlement`.`create_time`'), 'DESC'],
    [sequelize.literal('`Settlement`.`settlement_id`'), 'DESC']
  ];

  const { count, rows } = await Settlement.findAndCountAll({
    where,
    include: [{ model: SettlementItem, as: 'items' }],
    order,
    ...paginate({}, { page, pageSize })
  });

  ctx.body = formatPaginatedResult(normalizeSettlements(rows), { page, pageSize, count });
}

/**
 * 结算单详情
 */
async function getSettlementDetail(ctx) {
  const { id } = ctx.params;
  const settlement = await Settlement.findByPk(id, {
    include: [
      { model: SettlementItem, as: 'items' },
      { model: SettlementPaymentRecord, as: 'payments', where: { status: 'active' }, required: false }
    ]
  });

  if (!settlement) {
    ctx.throw(404, '结算单不存在');
  }

  ctx.body = { code: 0, data: normalizeSettlement(settlement) };
}

async function getSettlementById(settlementId) {
  if (!settlementId) {
    const error = new Error('结算单ID不能为空');
    error.status = 400;
    throw error;
  }

  const settlement = await Settlement.findByPk(settlementId, {
    include: [{ model: SettlementItem, as: 'items' }]
  });

  if (!settlement) {
    const error = new Error('结算单不存在');
    error.status = 404;
    throw error;
  }

  return settlement;
}

function throwStatusError(ctx, error) {
  ctx.throw(error.status || 500, error.message || '操作失败');
}

/**
 * 草稿提交后直接形成正式应付款，进入付款管理待处理。
 */
async function submitSettlement(ctx) {
  try {
    const { settlementId } = ctx.request.body;
    const settlement = await getSettlementById(settlementId);

    if (settlement.status !== 'draft') {
      ctx.throw(400, '只有草稿状态的结算单可以提交');
    }

    await settlement.update({
      status: 'confirmed',
      confirmed_time: new Date()
    });
    ctx.body = { code: 0, message: '结算单已提交，已进入待付款' };
  } catch (error) {
    throwStatusError(ctx, error);
  }
}

/**
 * 兼容旧确认接口。新流程已删除待确认状态，草稿提交即进入待付款。
 */
async function confirmSettlement(ctx) {
  try {
    const { settlementId } = ctx.request.body;
    const settlement = await getSettlementById(settlementId);

    if (settlement.status === 'draft') {
      await settlement.update({
        status: 'confirmed',
        confirmed_time: new Date()
      });
      ctx.body = { code: 0, message: '结算单已提交，已进入待付款' };
      return;
    }

    if (settlement.status !== 'confirmed') {
      ctx.throw(400, '当前结算单状态不可确认');
    }

    ctx.body = { code: 0, message: '结算单已是待付款状态' };
  } catch (error) {
    throwStatusError(ctx, error);
  }
}

/**
 * 作废结算单。作废后不退回待付款清单。
 */
async function voidSettlement(ctx) {
  try {
    const { settlementId } = ctx.request.body;
    const settlement = await getSettlementById(settlementId);

    if (settlement.status === 'voided') {
      ctx.throw(400, '结算单已作废');
    }

    await settlement.update({
      status: 'voided',
      voided_time: new Date()
    });
    ctx.body = { code: 0, message: '结算单已作废' };
  } catch (error) {
    throwStatusError(ctx, error);
  }
}

/**
 * 确认付款
 */
async function confirmPayment(ctx) {
  ctx.throw(400, '应付结算暂不支持付款功能');
}

/**
 * 取消付款，结算单内的应付款退回待付款清单
 */
async function cancelPayment(ctx) {
  await voidSettlement(ctx);
}

function buildPaymentCandidateWhere(query = {}) {
  const candidateWhere = {
    status: 'confirmed',
    payment_status: { [Op.ne]: 'paid' },
    [Op.and]: where(col('total_amount'), Op.gt, col('paid_amount'))
  };
  if (query.supplierId) candidateWhere.supplier_id = query.supplierId;
  if (query.paymentStatus) candidateWhere.payment_status = query.paymentStatus;
  if (query.startDate || query.endDate) {
    candidateWhere.create_time = {};
    if (query.startDate) candidateWhere.create_time[Op.gte] = new Date(`${query.startDate}T00:00:00.000+08:00`);
    if (query.endDate) candidateWhere.create_time[Op.lte] = new Date(`${query.endDate}T23:59:59.999+08:00`);
  }
  return candidateWhere;
}

async function getPaymentCandidates(ctx) {
  const { page = 1, pageSize = 20 } = ctx.query;
  const where = buildPaymentCandidateWhere(ctx.query);
  const { count, rows } = await Settlement.findAndCountAll({
    where,
    order: [['confirmed_time', 'DESC'], ['create_time', 'DESC'], ['settlement_id', 'DESC']],
    ...paginate({}, { page, pageSize })
  });

  const list = normalizeSettlements(rows).map(row => ({
    ...row,
    remaining_amount: getRemainingAmount(row),
    import_key: makePaymentImportKey(row)
  }));

  ctx.body = formatPaginatedResult(list, { page, pageSize, count });
}

async function exportPaymentCandidates(ctx) {
  const where = buildPaymentCandidateWhere(ctx.query);
  const rows = await Settlement.findAll({
    where,
    order: [['confirmed_time', 'DESC'], ['create_time', 'DESC']]
  });

  const data = normalizeSettlements(rows).map(row => ({
    结算单号: row.settlement_no,
    供应商: row.supplier_name || '',
    结算金额: Number(row.total_amount || 0),
    已付金额: Number(row.paid_amount || 0),
    剩余应付金额: getRemainingAmount(row),
    本次付款金额: getRemainingAmount(row),
    付款时间: moment().format('YYYY-MM-DD'),
    备注: '',
    导入标识: makePaymentImportKey(row)
  }));

  const workbook = XLSX.utils.book_new();
  const paymentHeaders = ['结算单号', '供应商', '结算金额', '已付金额', '剩余应付金额', '本次付款金额', '付款时间', '备注', '导入标识'];
  const worksheet = XLSX.utils.json_to_sheet(data, { header: paymentHeaders });
  if (worksheet['!cols']) {
    worksheet['!cols'][8] = { hidden: true };
  } else {
    worksheet['!cols'] = [{}, {}, {}, {}, {}, {}, {}, {}, { hidden: true }];
  }
  XLSX.utils.book_append_sheet(workbook, worksheet, '实际付款');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const fileName = encodeURIComponent(`应付实际付款_${moment().format('YYYYMMDD_HHmmss')}.xlsx`);

  ctx.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  ctx.set('Content-Disposition', `attachment; filename*=UTF-8''${fileName}`);
  ctx.body = buffer;
}

async function validatePaymentImportRows(rows, accountId) {
  const errors = [];
  const validRows = [];
  const seenSettlementNos = new Set();
  const seenImportKeys = new Set();

  if (!accountId) {
    errors.push({ row: 0, message: '请选择付款账户' });
  } else {
    const account = await SettlementAccount.findOne({ where: { account_id: accountId, status: 1 } });
    if (!account) errors.push({ row: 0, message: '付款账户不存在或已停用' });
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    errors.push({ row: 0, message: '导入文件没有可处理的数据' });
    return { errors, validRows, totalAmount: 0 };
  }

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] || {};
    const rowNo = index + 2;
    const settlementNo = String(getImportValue(row, ['结算单号', 'settlement_no', 'settlementNo'])).trim();
    const amount = toNumber(getImportValue(row, ['本次付款金额', 'amount', 'paymentAmount']));
    const paymentTimeText = String(getImportValue(row, ['付款时间', 'payment_time', 'paymentTime'])).trim();
    const paymentTime = paymentTimeText ? new Date(paymentTimeText) : new Date();
    const remark = String(getImportValue(row, ['备注', 'remark'])).trim();
    const importKey = String(getImportValue(row, ['导入标识', 'import_key', 'importKey'])).trim();

    if (!settlementNo) {
      errors.push({ row: rowNo, message: '结算单号不能为空' });
      continue;
    }
    if (seenSettlementNos.has(settlementNo)) {
      errors.push({ row: rowNo, settlementNo, message: '同一文件中结算单重复' });
      continue;
    }
    seenSettlementNos.add(settlementNo);

    if (!Number.isFinite(amount) || amount <= 0) {
      errors.push({ row: rowNo, settlementNo, message: '本次付款金额必须大于0' });
      continue;
    }
    if (Number.isNaN(paymentTime.getTime())) {
      errors.push({ row: rowNo, settlementNo, message: '付款时间格式错误' });
      continue;
    }

    if (!importKey) {
      errors.push({ row: rowNo, settlementNo, message: '导入标识缺失，请使用系统导出的模板' });
      continue;
    }
    if (seenImportKeys.has(importKey)) {
      errors.push({ row: rowNo, settlementNo, message: '同一文件中导入标识重复' });
      continue;
    }
    seenImportKeys.add(importKey);

    const existedPayment = await SettlementPaymentRecord.findOne({
      where: { import_key: importKey, status: 'active' }
    });
    if (existedPayment) {
      errors.push({ row: rowNo, settlementNo, message: '该行已导入过，禁止重复扣款' });
      continue;
    }

    const settlement = await Settlement.findOne({
      where: { settlement_no: settlementNo },
      include: [{ model: SettlementItem, as: 'items' }]
    });
    if (!settlement) {
      errors.push({ row: rowNo, settlementNo, message: '结算单不存在' });
      continue;
    }
    if (settlement.status !== 'confirmed') {
      errors.push({ row: rowNo, settlementNo, message: '结算单未提交为待付款或已作废' });
      continue;
    }
    if (settlement.payment_status === 'paid') {
      errors.push({ row: rowNo, settlementNo, message: '结算单已付清' });
      continue;
    }

    const remainingAmount = getRemainingAmount(settlement);
    if (roundAmount(amount) > remainingAmount) {
      errors.push({ row: rowNo, settlementNo, message: `本次付款金额超过剩余未付款金额 ${remainingAmount}` });
      continue;
    }

    validRows.push({
      row: rowNo,
      settlementId: settlement.settlement_id,
      settlementNo,
      supplierName: settlement.supplier_name || '',
      totalAmount: Number(settlement.total_amount || 0),
      paidAmount: Number(settlement.paid_amount || 0),
      remainingAmount,
      amount: roundAmount(amount),
      paymentTime,
      remark,
      importKey
    });
  }

  return {
    errors,
    validRows,
    totalAmount: roundAmount(validRows.reduce((sum, row) => sum + row.amount, 0))
  };
}

async function validatePaymentImport(ctx) {
  const { accountId, rows } = ctx.request.body;
  const account = accountId ? await SettlementAccount.findByPk(accountId) : null;
  const result = await validatePaymentImportRows(rows, accountId);
  ctx.body = {
    code: result.errors.length > 0 ? 400 : 0,
    message: result.errors.length > 0 ? '导入校验失败，整批未处理' : '导入校验通过',
    data: {
      account,
      errors: result.errors,
      list: result.validRows,
      totalAmount: result.totalAmount,
      totalCount: result.validRows.length
    }
  };
}

async function commitPaymentImport(ctx) {
  const { accountId, rows, remark } = ctx.request.body;
  const user = ctx.state.user;
  const account = await SettlementAccount.findOne({ where: { account_id: accountId, status: 1 } });
  if (!account) ctx.throw(400, '付款账户不存在或已停用');

  const result = await validatePaymentImportRows(rows, accountId);
  if (result.errors.length > 0) {
    ctx.body = {
      code: 400,
      message: '导入校验失败，整批未处理',
      data: { errors: result.errors }
    };
    return;
  }

  const batchId = generateUUID();
  const batchNo = `PB${moment().format('YYYYMMDDHHmmss')}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;

  await sequelize.transaction(async (transaction) => {
    const lockedAccount = await SettlementAccount.findOne({
      where: { account_id: accountId, status: 1 },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!lockedAccount) ctx.throw(400, '付款账户不存在或已停用');
    let balance = await getCurrentAccountBalance(accountId, transaction);

    await SettlementPaymentBatch.create({
      batch_id: batchId,
      batch_no: batchNo,
      account_id: accountId,
      account_name: account.account_name,
      total_amount: result.totalAmount,
      total_count: result.validRows.length,
      status: 'active',
      remark: remark || '',
      create_user: user.name || user.staffId
    }, { transaction });

    for (const row of result.validRows) {
      const settlement = await Settlement.findByPk(row.settlementId, {
        transaction,
        lock: transaction.LOCK.UPDATE
      });
      if (!settlement || settlement.status !== 'confirmed' || settlement.payment_status === 'paid') {
        ctx.throw(400, `结算单 ${row.settlementNo} 当前状态不可付款`);
      }

      const activePaidAmount = await SettlementPaymentRecord.sum('amount', {
        where: { settlement_id: row.settlementId, status: 'active' },
        transaction
      });
      const remainingAmount = roundAmount(Number(settlement.total_amount || 0) - Number(activePaidAmount || 0));
      if (row.amount > remainingAmount) {
        ctx.throw(400, `结算单 ${row.settlementNo} 本次付款金额超过剩余未付款金额 ${remainingAmount}`);
      }

      const transactionId = generateUUID();
      balance = roundAmount(balance - row.amount);

      await SettlementAccountTransaction.create({
        transaction_id: transactionId,
        account_id: accountId,
        type: 'expense',
        amount: row.amount,
        balance_after: balance,
        description: `应付付款：${row.settlementNo} 供应商：${row.supplierName}`,
        related_ref: batchNo,
        create_user: user.name || user.staffId
      }, { transaction });

      await SettlementPaymentRecord.create({
        payment_id: generateUUID(),
        batch_id: batchId,
        settlement_id: row.settlementId,
        settlement_no: row.settlementNo,
        supplier_name: row.supplierName,
        account_id: accountId,
        amount: row.amount,
        payment_time: row.paymentTime,
        remark: row.remark,
        import_key: row.importKey,
        transaction_id: transactionId,
        status: 'active',
        create_user: user.name || user.staffId
      }, { transaction });

      await refreshSettlementPaymentState(settlement, transaction);
    }
  });

  ctx.body = {
    code: 0,
    message: '付款导入成功',
    data: { batchId, batchNo, totalAmount: result.totalAmount, totalCount: result.validRows.length }
  };
}

async function createDirectPayment(ctx) {
  const { settlementId, accountId, amount } = ctx.request.body;
  const user = ctx.state.user;
  const paymentAmount = roundAmount(amount);

  if (!settlementId) ctx.throw(400, '结算单ID不能为空');
  if (!accountId) ctx.throw(400, '请选择付款账户');
  if (!Number.isFinite(Number(amount)) || paymentAmount <= 0) {
    ctx.throw(400, '本次付款金额必须大于0');
  }

  const batchId = generateUUID();
  const paymentId = generateUUID();
  const batchNo = `PB${moment().format('YYYYMMDDHHmmss')}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
  let result = null;

  await sequelize.transaction(async (transaction) => {
    const account = await SettlementAccount.findOne({
      where: { account_id: accountId, status: 1 },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!account) ctx.throw(400, '付款账户不存在或已停用');

    const settlement = await Settlement.findByPk(settlementId, {
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!settlement) ctx.throw(404, '结算单不存在');
    if (settlement.status !== 'confirmed' || settlement.payment_status === 'paid') {
      ctx.throw(400, '当前结算单不可付款');
    }

    const activePaidAmount = await SettlementPaymentRecord.sum('amount', {
      where: { settlement_id: settlementId, status: 'active' },
      transaction
    });
    const remainingAmount = roundAmount(Number(settlement.total_amount || 0) - Number(activePaidAmount || 0));
    if (paymentAmount > remainingAmount) {
      ctx.throw(400, `本次付款金额超过剩余未付款金额 ${remainingAmount}`);
    }

    const balanceBefore = roundAmount(await getCurrentAccountBalance(accountId, transaction));
    const balanceAfter = roundAmount(balanceBefore - paymentAmount);
    const transactionId = generateUUID();
    const operator = user.name || user.staffId;

    await SettlementPaymentBatch.create({
      batch_id: batchId,
      batch_no: batchNo,
      account_id: accountId,
      account_name: account.account_name,
      total_amount: paymentAmount,
      total_count: 1,
      status: 'active',
      remark: '单笔立即付款',
      create_user: operator
    }, { transaction });

    await SettlementAccountTransaction.create({
      transaction_id: transactionId,
      account_id: accountId,
      type: 'expense',
      amount: paymentAmount,
      balance_after: balanceAfter,
      description: `应付付款：${settlement.settlement_no} 供应商：${settlement.supplier_name || ''}`,
      related_ref: batchNo,
      create_user: operator
    }, { transaction });

    await SettlementPaymentRecord.create({
      payment_id: paymentId,
      batch_id: batchId,
      settlement_id: settlementId,
      settlement_no: settlement.settlement_no,
      supplier_name: settlement.supplier_name || '',
      account_id: accountId,
      amount: paymentAmount,
      payment_time: new Date(),
      remark: '单笔立即付款',
      import_key: `DIRECT:${paymentId}`,
      transaction_id: transactionId,
      status: 'active',
      create_user: operator
    }, { transaction });

    const paymentState = await refreshSettlementPaymentState(settlement, transaction);
    result = {
      batchId,
      batchNo,
      paymentId,
      amount: paymentAmount,
      balanceBefore,
      balanceAfter,
      paymentStatus: paymentState.paymentStatus
    };
  });

  ctx.body = {
    code: 0,
    message: result.balanceAfter < 0 ? '付款登记成功，账户余额已为负数' : '付款登记成功',
    data: result
  };
}

async function getPaymentBatches(ctx) {
  const { page = 1, pageSize = 20, status } = ctx.query;
  const where = {};
  if (status) where.status = status;

  const { count, rows } = await SettlementPaymentBatch.findAndCountAll({
    where,
    include: [{ model: SettlementPaymentRecord, as: 'records', required: false }],
    distinct: true,
    order: [['create_time', 'DESC'], ['batch_id', 'DESC']],
    ...paginate({}, { page, pageSize })
  });

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

async function getPaymentBatchDetail(ctx) {
  const { id } = ctx.params;
  const batch = await SettlementPaymentBatch.findByPk(id, {
    include: [{ model: SettlementPaymentRecord, as: 'records' }]
  });
  if (!batch) ctx.throw(404, '付款批次不存在');
  ctx.body = { code: 0, data: batch };
}

async function voidPaymentBatch(ctx) {
  const { batchId, reason } = ctx.request.body;
  const user = ctx.state.user;
  if (!batchId) ctx.throw(400, '付款批次ID不能为空');

  const batch = await SettlementPaymentBatch.findByPk(batchId, {
    include: [{ model: SettlementPaymentRecord, as: 'records', where: { status: 'active' }, required: false }]
  });
  if (!batch) ctx.throw(404, '付款批次不存在');
  if (batch.status === 'voided') ctx.throw(400, '付款批次已撤销');

  await sequelize.transaction(async (transaction) => {
    await SettlementAccount.findByPk(batch.account_id, {
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    let balance = await getCurrentAccountBalance(batch.account_id, transaction);
    const records = batch.records || [];

    for (const record of records) {
      const voidTransactionId = generateUUID();
      const amount = Number(record.amount || 0);
      balance = roundAmount(balance + amount);

      await SettlementAccountTransaction.create({
        transaction_id: voidTransactionId,
        account_id: batch.account_id,
        type: 'income',
        amount,
        balance_after: balance,
        description: `撤销应付付款：${record.settlement_no} 批次：${batch.batch_no}`,
        related_ref: batch.batch_no,
        create_user: user.name || user.staffId
      }, { transaction });

      await record.update({
        status: 'voided',
        void_transaction_id: voidTransactionId
      }, { transaction });

      const settlement = await Settlement.findByPk(record.settlement_id, {
        transaction,
        lock: transaction.LOCK.UPDATE
      });
      if (settlement) {
        await refreshSettlementPaymentState(settlement, transaction);
      }
    }

    await batch.update({
      status: 'voided',
      void_user: user.name || user.staffId,
      void_time: new Date(),
      void_reason: reason || ''
    }, { transaction });
  });

  ctx.body = { code: 0, message: '付款批次已撤销' };
}

module.exports = {
  getPayableList,
  getUnpaidBySupplier,
  createSettlement,
  createExpenseSettlement,
  getSettlementList,
  getSettlementDetail,
  submitSettlement,
  confirmSettlement,
  voidSettlement,
  getPaymentCandidates,
  exportPaymentCandidates,
  validatePaymentImport,
  commitPaymentImport,
  createDirectPayment,
  getPaymentBatches,
  getPaymentBatchDetail,
  voidPaymentBatch,
  confirmPayment,
  cancelPayment
};
