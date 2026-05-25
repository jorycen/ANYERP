/**
 * 供应商返利管理控制器
 */
const { SupplierRebate, Supplier, sequelize } = require('../../models');
const { Op } = require('sequelize');
const { generateUUID, paginate, formatPaginatedResult } = require('../../utils');

/**
 * 返利上账
 */
async function addRebate(ctx) {
  const { supplierId, amount, remark } = ctx.request.body;
  const user = ctx.state.user;

  if (!supplierId) ctx.throw(400, '请选择供应商');
  if (!amount || parseFloat(amount) <= 0) ctx.throw(400, '请输入正确的金额');

  const supplier = await Supplier.findByPk(supplierId);
  if (!supplier) ctx.throw(404, '供应商不存在');

  const currentBalance = await _getRebateBalance(supplierId);
  const newBalance = currentBalance + parseFloat(amount);

  await SupplierRebate.create({
    rebate_id: generateUUID(),
    supplier_id: supplierId,
    supplier_name: supplier.name,
    type: 'credit',
    amount: parseFloat(amount),
    balance: newBalance,
    remark: remark || '',
    create_user: user.name || user.phone
  });

  ctx.body = { code: 0, message: '返利上账成功', data: { balance: newBalance } };
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
async function _getRebateBalance(supplierId) {
  const result = await SupplierRebate.findOne({
    attributes: ['balance'],
    where: { supplier_id: supplierId },
    order: [['create_time', 'DESC']]
  });
  return parseFloat(result?.get('balance') || 0);
}

/**
 * 记录返利抵扣（采购申请用）
 */
async function recordRebateDeduction(supplierId, supplierName, amount, relatedNo, remark, user) {
  const currentBalance = await _getRebateBalance(supplierId);
  const newBalance = currentBalance - parseFloat(amount);

  await SupplierRebate.create({
    rebate_id: generateUUID(),
    supplier_id: supplierId,
    supplier_name: supplierName,
    type: 'debit',
    amount: parseFloat(amount),
    balance: newBalance,
    related_no: relatedNo,
    remark: remark || '',
    create_user: user
  });

  return newBalance;
}

module.exports = {
  addRebate,
  getRebateList,
  getRebateBalance,
  recordRebateDeduction,
  _getRebateBalance
};
