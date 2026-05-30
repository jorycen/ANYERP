/**
 * 应付管理控制器
 */
const { Payable, Settlement, SettlementItem, Supplier, Inbound, PurchaseRequest, SettlementAccount, SettlementAccountTransaction, sequelize } = require('../../models');
const { Op } = require('sequelize');
const { generateUUID, paginate, formatPaginatedResult } = require('../../utils');
const moment = require('moment');

/**
 * 应付款列表
 */
async function getPayableList(ctx) {
  const { supplierId, status, page = 1, pageSize = 20 } = ctx.query;
  const where = {};

  if (supplierId) where.supplier_id = supplierId;
  if (status) where.status = status;

  const { count, rows } = await Payable.findAndCountAll({
    where,
    order: [['create_time', 'DESC']],
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
  const { supplierId, payableIds } = ctx.request.body;
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

  const settlementId = generateUUID();
  const dateStr = moment().format('YYYYMMDD');
  const seq = `S${dateStr}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
  let totalAmount = 0;

  const settlement = await Settlement.create({
    settlement_id: settlementId,
    settlement_no: seq,
    supplier_id: supplierId,
    supplier_name: supplier.name,
    total_amount: 0,
    status: 'unpaid',
    create_user: user.name || user.phone
  });

  for (const payable of payables) {
    totalAmount += parseFloat(payable.total_amount);

    await SettlementItem.create({
      settlement_id: settlementId,
      payable_id: payable.payable_id,
      request_no: payable.request_no,
      amount: payable.total_amount
    });

    await payable.update({
      status: 'settling',
      paid_amount: payable.total_amount
    });
  }

  await settlement.update({ total_amount: totalAmount });

  ctx.body = { code: 0, message: '结算单创建成功', data: settlement };
}

/**
 * 结算单列表
 */
async function getSettlementList(ctx) {
  const { supplierId, status, page = 1, pageSize = 20 } = ctx.query;
  const where = {};

  if (supplierId) where.supplier_id = supplierId;
  if (status) where.status = status;

  const order = status
    ? [['create_time', 'DESC']]
    : [[sequelize.literal("FIELD(status,'unpaid','paid')"), 'ASC'], ['create_time', 'DESC']];

  const { count, rows } = await Settlement.findAndCountAll({
    where,
    include: [{ model: SettlementItem, as: 'items' }],
    order,
    ...paginate({}, { page, pageSize })
  });

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

/**
 * 确认付款
 */
async function confirmPayment(ctx) {
  const { settlementId, settlementAccountId } = ctx.request.body;
  const user = ctx.state.user;

  if (!settlementId) {
    ctx.throw(400, '结算单ID不能为空');
  }

  const settlement = await Settlement.findByPk(settlementId, {
    include: [{ model: SettlementItem, as: 'items' }]
  });

  if (!settlement) {
    ctx.throw(404, '结算单不存在');
  }

  if (settlement.status === 'paid') {
    ctx.throw(400, '该结算单已付款');
  }

  const items = settlement.items || [];
  for (const item of items) {
    const payable = await Payable.findByPk(item.payable_id);
    if (payable) {
      await payable.update({ status: 'paid' });
    }
  }

  await settlement.update({
    status: 'paid',
    paid_time: new Date()
  });

  if (settlementAccountId) {
    const amount = parseFloat(settlement.total_amount) || 0;
    const latestTx = await SettlementAccountTransaction.findOne({
      attributes: ['balance_after'],
      where: { account_id: settlementAccountId },
      order: [['create_time', 'DESC'], ['transaction_id', 'DESC']],
      raw: true
    });
    const currentBalance = latestTx ? (Number(latestTx.balance_after) || 0) : 0;
    const balanceAfter = currentBalance - amount;

    await SettlementAccountTransaction.create({
      transaction_id: generateUUID(),
      account_id: settlementAccountId,
      type: 'expense',
      amount,
      balance_after: balanceAfter,
      description: `应付结算：${settlement.settlement_no || ''} 供应商：${settlement.supplier_name || ''}`,
      related_ref: settlement.settlement_no || settlement.settlement_id,
      create_user: user.name
    });
  }

  ctx.body = { code: 0, message: '付款确认成功' };
}

module.exports = {
  getPayableList,
  getUnpaidBySupplier,
  createSettlement,
  getSettlementList,
  confirmPayment
};
