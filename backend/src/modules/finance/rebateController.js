/**
 * 供应商返利管理控制器
 */
const {
  SupplierRebate,
  RebatePostingOrder,
  RebateSettlementAllocation,
  ResourceSettlement,
  Supplier,
  Product,
  ManufacturerRebatePolicy,
  ManufacturerPriceHistory,
  RebateEstimate,
  SalesSettlementCostAdjustment,
  SettlementAccount,
  SettlementAccountTransaction,
  sequelize
} = require('../../models');
const { Op } = require('sequelize');
const { generateUUID, paginate, formatPaginatedResult, buildPendingFirstOrder } = require('../../utils');

function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const normalized = String(value).replace(/[¥,\s]/g, '');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function businessNo(prefix = 'RPO') {
  const date = new Date();
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0')
  ].join('');
  return `${prefix}${stamp}${generateUUID().slice(-6).toUpperCase()}`;
}

function chinaDateBoundary(dateText, endOfDay = false) {
  if (!dateText) return null;
  const value = String(dateText).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+08:00`);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function recordSupplierRebateAccountTransaction(supplierId, type, amount, description, relatedRef, user, transaction = null) {
  const account = await SettlementAccount.findOne({ where: { account_type: 'SUPPLIER_REBATE', supplier_id: supplierId, status: 1 }, transaction });
  if (!account) return;
  const income = Number(await SettlementAccountTransaction.sum('amount', { where: { account_id: account.account_id, type: 'income' }, transaction }) || 0);
  const expense = Number(await SettlementAccountTransaction.sum('amount', { where: { account_id: account.account_id, type: 'expense' }, transaction }) || 0);
  const numericAmount = Number(amount || 0);
  await SettlementAccountTransaction.create({
    transaction_id: generateUUID(), account_id: account.account_id, type, amount: numericAmount,
    balance_after: income - expense + (type === 'income' ? numericAmount : -numericAmount),
    description, related_ref: relatedRef || '', create_user: user
  }, { transaction });
}

/**
 * 返利上账
 */
async function addRebate(ctx) {
  const body = ctx.request.body || {};
  const supplierId = body.supplierId || body.supplier_id;
  const amount = Math.round(toNumber(body.amount) * 100) / 100;
  const remark = String(body.remark || '').trim();
  const postingDate = body.postingDate || body.posting_date || new Date().toISOString().slice(0, 10);
  if (!supplierId) ctx.throw(400, '请选择供应商');
  if (!Number.isFinite(amount) || amount <= 0) ctx.throw(400, '请输入正确的上账金额');
  if (!remark) ctx.throw(400, '返利上账必须填写备注');
  if (!parseDate(postingDate)) ctx.throw(400, '请选择正确的上账日期');

  const supplier = await Supplier.findOne({
    where: { supplier_id: supplierId, status: 1, is_deleted: 0 }
  });
  if (!supplier) ctx.throw(404, '供应商不存在或已停用');
  const account = await SettlementAccount.findOne({
    where: { account_type: 'SUPPLIER_REBATE', supplier_id: supplierId, status: 1 }
  });
  if (!account) ctx.throw(409, `未配置${supplier.name || '该供应商'}的供应商返利账户`);

  const user = ctx.state.user || {};
  let postingOrder;
  await sequelize.transaction(async transaction => {
    const latest = await SupplierRebate.findOne({
      where: { supplier_id: supplierId },
      order: [['create_time', 'DESC'], ['rebate_id', 'DESC']],
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    const postingId = generateUUID();
    const postingNo = businessNo();
    const rebateId = generateUUID();
    const balance = Number(latest?.balance || 0) + amount;
    postingOrder = await RebatePostingOrder.create({
      posting_id: postingId,
      posting_no: postingNo,
      supplier_id: supplier.supplier_id,
      supplier_name: supplier.name,
      posting_date: postingDate,
      amount,
      matched_amount: 0,
      status: 'UNMATCHED',
      rebate_id: rebateId,
      create_staff_id: user.staffId || null,
      create_user: user.name || user.phone || '',
      remark
    }, { transaction });
    await SupplierRebate.create({
      rebate_id: rebateId,
      supplier_id: supplier.supplier_id,
      supplier_name: supplier.name,
      type: 'credit',
      amount,
      balance,
      related_no: postingNo,
      remark,
      status: 'active',
      source_type: 'posting_order',
      source_id: postingId,
      create_user: user.name || user.phone || ''
    }, { transaction });
    await recordSupplierRebateAccountTransaction(
      supplierId,
      'income',
      amount,
      `返利上账：${remark}`,
      postingNo,
      user.name || user.phone || '',
      transaction
    );
  });
  ctx.body = { code: 0, message: '返利上账单已生效，可立即用于采购抵扣', data: postingOrder };
}

async function reverseRebate(ctx) {
  ctx.throw(410, '返利流水不允许直接冲销，请从返利上账单发起冲销');
}

async function getRebatePostingOrders(ctx) {
  const {
    supplierId, status, remark, startDate, endDate, unmatchedOnly,
    page = 1, pageSize = 20
  } = ctx.query;
  const where = {};
  if (supplierId) where.supplier_id = supplierId;
  if (status) where.status = status;
  if (remark) where.remark = { [Op.like]: `%${remark}%` };
  if (String(unmatchedOnly || '') === '1') {
    where.status = { [Op.in]: ['UNMATCHED', 'PARTIALLY_MATCHED'] };
  }
  const start = chinaDateBoundary(startDate, false);
  const end = chinaDateBoundary(endDate, true);
  if (start || end) {
    where.posting_date = {};
    if (start) where.posting_date[Op.gte] = start;
    if (end) where.posting_date[Op.lte] = end;
  }
  const { count, rows } = await RebatePostingOrder.findAndCountAll({
    where,
    include: [{
      model: RebateSettlementAllocation,
      as: 'Allocations',
      required: false,
      where: { status: 'ACTIVE' },
      include: [{
        model: ResourceSettlement,
        as: 'Settlement',
        required: false,
        attributes: ['settlement_id', 'settlement_no', 'amount', 'status', 'remark']
      }]
    }],
    order: buildPendingFirstOrder(sequelize, {
      statusColumn: 'RebatePostingOrder.status',
      pendingStatuses: ['UNMATCHED', 'PARTIALLY_MATCHED'],
      dateColumns: ['RebatePostingOrder.posting_date', 'RebatePostingOrder.create_time'],
      idColumn: 'RebatePostingOrder.posting_id'
    }),
    distinct: true,
    ...paginate({}, { page, pageSize })
  });
  const list = rows.map(row => {
    const item = row.toJSON();
    item.remaining_amount = Math.max(0, Number(item.amount || 0) - Number(item.matched_amount || 0));
    return item;
  });
  ctx.body = formatPaginatedResult(list, { page, pageSize, count });
}

async function reverseRebatePostingOrder(ctx) {
  const reason = String(ctx.request.body?.reason || '').trim();
  if (!reason) ctx.throw(400, '请输入冲销原因');
  await sequelize.transaction(async transaction => {
    const order = await RebatePostingOrder.findByPk(ctx.params.postingId, {
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!order) ctx.throw(404, '返利上账单不存在');
    if (order.status === 'REVERSED') ctx.throw(409, '该返利上账单已冲销');
    if (Number(order.matched_amount || 0) > 0) {
      ctx.throw(409, '该上账单已有下账核销记录，请先撤销对应核销');
    }
    const latest = await SupplierRebate.findOne({
      where: { supplier_id: order.supplier_id },
      order: [['create_time', 'DESC'], ['rebate_id', 'DESC']],
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    const amount = Number(order.amount || 0);
    const balance = Number(latest?.balance || 0);
    const activePostingAmount = Number(await RebatePostingOrder.sum('amount', {
      where: {
        supplier_id: order.supplier_id,
        status: { [Op.ne]: 'REVERSED' }
      },
      transaction
    }) || 0);
    if (balance + 0.0001 < activePostingAmount) {
      ctx.throw(
        409,
        `该供应商仍有 ¥${(activePostingAmount - balance).toFixed(2)} 返利被采购占用；请先完成采购退单`
      );
    }
    const originalRebate = await SupplierRebate.findOne({
      where: {
        source_type: 'posting_order',
        source_id: order.posting_id,
        type: 'credit',
        status: 'active'
      },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!originalRebate) ctx.throw(409, '未找到上账单对应的返利余额流水');
    await SupplierRebate.create({
      rebate_id: generateUUID(),
      supplier_id: order.supplier_id,
      supplier_name: order.supplier_name,
      type: 'debit',
      amount,
      balance: balance - amount,
      related_no: order.posting_no,
      remark: `返利上账单冲销：${reason}`,
      status: 'active',
      source_type: 'posting_order_reversal',
      source_id: order.posting_id,
      reversal_of: originalRebate.rebate_id,
      create_user: ctx.state.user.name || ctx.state.user.phone || ''
    }, { transaction });
    await recordSupplierRebateAccountTransaction(
      order.supplier_id,
      'expense',
      amount,
      `返利上账单冲销：${reason}`,
      `${order.posting_no}:REV`,
      ctx.state.user.name || ctx.state.user.phone || '',
      transaction
    );
    await originalRebate.update({ status: 'reversed' }, { transaction });
    await order.update({
      status: 'REVERSED',
      reversed_at: new Date(),
      reversed_by: ctx.state.user.staffId || null,
      reversed_by_name: ctx.state.user.name || '',
      reversal_reason: reason
    }, { transaction });
  });
  ctx.body = { code: 0, message: '返利上账单已冲销' };
}

/**
 * 返利清单查询
 */
async function getRebateList(ctx) {
  const { supplierId, type, page = 1, pageSize = 20 } = ctx.query;
  const where = {};

  if (supplierId) where.supplier_id = supplierId;
  if (type) where.type = type;

  const { count, rows } = await SupplierRebate.findAndCountAll({
    where,
    order: [['create_time', 'DESC']],
    ...paginate({}, { page, pageSize })
  });

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

/**
 * 获取供应商返利余额
 */
async function getRebateBalance(ctx) {
  const { supplierId } = ctx.query;
  if (!supplierId) ctx.throw(400, '请选择供应商');

  const balance = await _getRebateBalance(supplierId);

  ctx.body = { code: 0, data: { supplier_id: supplierId, balance } };
}

/**
 * 内部：计算某个供应商的返利余额（取最新记录）
 */
async function getRebateSummary(ctx) {
  const rows = await SupplierRebate.findAll({
    order: [
      ['supplier_id', 'ASC'],
      ['create_time', 'DESC']
    ]
  });

  const latestMap = new Map();
  for (const row of rows) {
    const item = row.get({ plain: true });
    if (!latestMap.has(item.supplier_id)) {
      latestMap.set(item.supplier_id, item);
    }
  }

  const summary = Array.from(latestMap.values())
    .filter(item => parseFloat(item.balance || 0) > 0);
  const supplierIds = summary.map(item => item.supplier_id).filter(Boolean);
  const suppliers = supplierIds.length > 0
    ? await Supplier.findAll({ where: { supplier_id: { [Op.in]: supplierIds } } })
    : [];
  const supplierNameMap = new Map(suppliers.map(item => [item.supplier_id, item.name]));

  const list = summary
    .map(item => ({
      supplier_id: item.supplier_id,
      supplier_name: supplierNameMap.get(item.supplier_id) || item.supplier_name || '',
      balance: parseFloat(item.balance || 0),
      last_time: item.create_time
    }))
    .sort((a, b) => b.balance - a.balance || new Date(b.last_time) - new Date(a.last_time));

  const totalBalance = list.reduce((sum, item) => sum + item.balance, 0);

  ctx.body = { code: 0, data: { list, totalBalance } };
}

async function _getRebateBalance(supplierId, transaction = null) {
  const result = await SupplierRebate.findOne({
    attributes: ['balance'],
    where: { supplier_id: supplierId },
    order: [['create_time', 'DESC']],
    transaction
  });
  return parseFloat(result?.get('balance') || 0);
}

/**
 * 记录返利抵扣（采购申请用）
 */
async function recordRebateDeduction(supplierId, supplierName, amount, relatedNo, remark, user) {
  return sequelize.transaction(async transaction => {
    const currentBalance = await _getRebateBalance(supplierId, transaction);
    const newBalance = currentBalance - parseFloat(amount);
    await SupplierRebate.create({
      rebate_id: generateUUID(), supplier_id: supplierId, supplier_name: supplierName,
      type: 'debit', amount: parseFloat(amount), balance: newBalance, related_no: relatedNo,
      remark: remark || '', status: 'active', source_type: 'purchase', create_user: user
    }, { transaction });
    await recordSupplierRebateAccountTransaction(supplierId, 'expense', amount, '采购返利抵扣', relatedNo, user, transaction);
    return newBalance;
  });
}

async function createManufacturerPolicy(ctx) {
  const user = ctx.state.user;
  const body = ctx.request.body || {};
  const supplierId = body.supplierId || body.supplier_id;
  const policyName = body.policyName || body.policy_name;

  if (!supplierId) ctx.throw(400, '请选择供应商/厂家');
  if (!policyName) ctx.throw(400, '请输入政策名称');

  const supplier = await Supplier.findByPk(supplierId);
  if (!supplier) ctx.throw(404, '供应商不存在');

  const policy = await ManufacturerRebatePolicy.create({
    policy_id: generateUUID(),
    supplier_id: supplierId,
    supplier_name: supplier.name,
    policy_name: policyName,
    policy_type: body.policyType || body.policy_type || 'activity',
    product_id: body.productId || body.product_id || null,
    product_name: body.productName || body.product_name || '',
    pn: body.pn || body.pnCode || body.pn_code || '',
    model: body.model || '',
    start_date: parseDate(body.startDate || body.start_date),
    end_date: parseDate(body.endDate || body.end_date),
    rebate_calculation_type: body.rebateCalculationType || body.rebate_calculation_type || 'fixed_amount',
    rebate_amount: toNumber(body.rebateAmount || body.rebate_amount),
    rebate_rate: toNumber(body.rebateRate || body.rebate_rate),
    affect_sales_settlement_cost: body.affectSalesSettlementCost || body.affect_sales_settlement_cost ? 1 : 0,
    cost_adjustment_type: body.costAdjustmentType || body.cost_adjustment_type || 'fixed_amount',
    cost_adjustment_value: toNumber(body.costAdjustmentValue || body.cost_adjustment_value),
    max_cost_adjustment_amount: body.maxCostAdjustmentAmount || body.max_cost_adjustment_amount ? toNumber(body.maxCostAdjustmentAmount || body.max_cost_adjustment_amount) : null,
    cost_adjustment_remark: body.costAdjustmentRemark || body.cost_adjustment_remark || '',
    remark: body.remark || '',
    status: body.status === 0 ? 0 : 1,
    create_user: user.name || user.phone
  });

  ctx.body = { code: 0, message: '厂家政策已保存', data: policy };
}

async function updateManufacturerPolicy(ctx) {
  const { policyId } = ctx.params;
  const user = ctx.state.user;
  const body = ctx.request.body || {};
  const policy = await ManufacturerRebatePolicy.findByPk(policyId);
  if (!policy) ctx.throw(404, '厂家政策不存在');

  let supplierName = policy.supplier_name;
  const supplierId = body.supplierId || body.supplier_id || policy.supplier_id;
  if (supplierId !== policy.supplier_id) {
    const supplier = await Supplier.findByPk(supplierId);
    if (!supplier) ctx.throw(404, '供应商不存在');
    supplierName = supplier.name;
  }

  await policy.update({
    supplier_id: supplierId,
    supplier_name: supplierName,
    policy_name: body.policyName || body.policy_name || policy.policy_name,
    policy_type: body.policyType || body.policy_type || policy.policy_type,
    product_id: body.productId || body.product_id || null,
    product_name: body.productName || body.product_name || '',
    pn: body.pn || body.pnCode || body.pn_code || '',
    model: body.model || '',
    start_date: parseDate(body.startDate || body.start_date),
    end_date: parseDate(body.endDate || body.end_date),
    rebate_calculation_type: body.rebateCalculationType || body.rebate_calculation_type || policy.rebate_calculation_type,
    rebate_amount: toNumber(body.rebateAmount || body.rebate_amount),
    rebate_rate: toNumber(body.rebateRate || body.rebate_rate),
    affect_sales_settlement_cost: body.affectSalesSettlementCost || body.affect_sales_settlement_cost ? 1 : 0,
    cost_adjustment_type: body.costAdjustmentType || body.cost_adjustment_type || policy.cost_adjustment_type,
    cost_adjustment_value: toNumber(body.costAdjustmentValue || body.cost_adjustment_value),
    max_cost_adjustment_amount: body.maxCostAdjustmentAmount || body.max_cost_adjustment_amount ? toNumber(body.maxCostAdjustmentAmount || body.max_cost_adjustment_amount) : null,
    cost_adjustment_remark: body.costAdjustmentRemark || body.cost_adjustment_remark || '',
    remark: body.remark || '',
    status: body.status === 0 ? 0 : 1,
    update_user: user.name || user.phone,
    update_time: new Date()
  });

  ctx.body = { code: 0, message: '厂家政策已更新', data: policy };
}

async function getManufacturerPolicyList(ctx) {
  const { supplierId, pn, policyType, page = 1, pageSize = 20 } = ctx.query;
  const where = {};
  if (supplierId) where.supplier_id = supplierId;
  if (pn) where.pn = { [Op.like]: `%${pn}%` };
  if (policyType) where.policy_type = policyType;

  const { count, rows } = await ManufacturerRebatePolicy.findAndCountAll({
    where,
    order: [['create_time', 'DESC']],
    ...paginate({}, { page, pageSize })
  });

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

function getRowValue(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
  }
  return '';
}

async function importManufacturerPrices(ctx) {
  const user = ctx.state.user;
  const { rows = [], sourceFileUrl = '' } = ctx.request.body || {};
  if (!Array.isArray(rows) || rows.length === 0) ctx.throw(400, '没有可导入的价格数据');

  const batchNo = `MP${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
  const errors = [];
  const validRows = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] || {};
    const rowNo = index + 2;
    const supplierName = String(getRowValue(row, ['供应商', '厂家', 'supplier_name', 'manufacturer_name'])).trim();
    const supplierId = String(getRowValue(row, ['供应商ID', '厂家ID', 'supplier_id', 'manufacturer_id'])).trim();
    const pn = String(getRowValue(row, ['PN', 'pn', 'pn_code', '厂商编码'])).trim();
    const model = String(getRowValue(row, ['型号', 'model'])).trim();
    const productName = String(getRowValue(row, ['商品名称', 'product_name'])).trim();
    const effectiveDate = parseDate(getRowValue(row, ['生效日期', 'effective_date']));
    const expireDate = parseDate(getRowValue(row, ['失效日期', 'expire_date']));
    const pickupPrice = toNumber(getRowValue(row, ['提货价', 'pickup_price']));
    const p0Price = toNumber(getRowValue(row, ['P0价', 'p0_price']));

    if (!supplierId && !supplierName) {
      errors.push({ row: rowNo, message: '供应商/厂家不能为空' });
      continue;
    }
    if (!pn) {
      errors.push({ row: rowNo, message: 'PN不能为空' });
      continue;
    }
    if (!effectiveDate) {
      errors.push({ row: rowNo, pn, message: '生效日期格式错误' });
      continue;
    }
    if (!pickupPrice || pickupPrice <= 0) {
      errors.push({ row: rowNo, pn, message: '提货价必须大于0' });
      continue;
    }

    let supplier = null;
    if (supplierId) supplier = await Supplier.findByPk(supplierId);
    if (!supplier && supplierName) supplier = await Supplier.findOne({ where: { name: supplierName } });
    if (!supplier) {
      errors.push({ row: rowNo, pn, message: '供应商不存在' });
      continue;
    }

    const product = await Product.findOne({
      where: {
        [Op.or]: [
          { manufacturer_code: { [Op.like]: `%${pn}%` } },
          ...(productName ? [{ name: { [Op.like]: `%${productName}%` } }] : [])
        ]
      }
    });

    validRows.push({
      id: generateUUID(),
      supplier_id: supplier.supplier_id,
      supplier_name: supplier.name,
      product_id: product?.product_id || null,
      product_name: product?.name || productName,
      pn,
      model,
      effective_date: effectiveDate,
      expire_date: expireDate,
      pickup_price: pickupPrice,
      p0_price: p0Price || null,
      import_batch_no: batchNo,
      source_file_url: sourceFileUrl,
      remark: String(getRowValue(row, ['备注', 'remark'])).trim(),
      created_by: user.name || user.phone
    });
  }

  if (errors.length > 0) {
    ctx.body = { code: 400, message: '导入校验失败，整批未处理', data: { errors } };
    return;
  }

  await ManufacturerPriceHistory.bulkCreate(validRows);
  ctx.body = { code: 0, message: '厂家价格导入成功', data: { batchNo, count: validRows.length } };
}

async function getManufacturerPriceHistory(ctx) {
  const { supplierId, pn, productId, page = 1, pageSize = 20 } = ctx.query;
  const where = {};
  if (supplierId) where.supplier_id = supplierId;
  if (pn) where.pn = { [Op.like]: `%${pn}%` };
  if (productId) where.product_id = productId;

  const { count, rows } = await ManufacturerPriceHistory.findAndCountAll({
    where,
    order: [['effective_date', 'DESC'], ['created_at', 'DESC'], ['id', 'DESC']],
    ...paginate({}, { page, pageSize })
  });

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

async function getRebateEstimateList(ctx) {
  const { orderNo, supplierId, status, page = 1, pageSize = 20 } = ctx.query;
  const where = {};
  if (orderNo) where.sales_order_no = { [Op.like]: `%${orderNo}%` };
  if (supplierId) where.supplier_id = supplierId;
  if (status) where.status = status;
  const { count, rows } = await RebateEstimate.findAndCountAll({
    where,
    order: buildPendingFirstOrder(sequelize, {
      statusColumn: 'RebateEstimate.status',
      pendingStatuses: ['estimated'],
      dateColumns: ['RebateEstimate.created_at'],
      idColumn: 'RebateEstimate.estimate_id'
    }),
    ...paginate({}, { page, pageSize })
  });
  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

async function getCostAdjustmentList(ctx) {
  const { orderNo, supplierId, pn, page = 1, pageSize = 20 } = ctx.query;
  const where = {};
  if (orderNo) where.sales_order_no = { [Op.like]: `%${orderNo}%` };
  if (supplierId) where.supplier_id = supplierId;
  if (pn) where.pn = { [Op.like]: `%${pn}%` };
  const { count, rows } = await SalesSettlementCostAdjustment.findAndCountAll({
    where,
    order: [['created_at', 'DESC']],
    ...paginate({}, { page, pageSize })
  });
  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

module.exports = {
  addRebate,
  getRebateList,
  getRebateBalance,
  getRebateSummary,
  reverseRebate,
  getRebatePostingOrders,
  reverseRebatePostingOrder,
  createManufacturerPolicy,
  updateManufacturerPolicy,
  getManufacturerPolicyList,
  importManufacturerPrices,
  getManufacturerPriceHistory,
  getRebateEstimateList,
  getCostAdjustmentList,
  recordRebateDeduction,
  recordSupplierRebateAccountTransaction,
  _getRebateBalance
};
