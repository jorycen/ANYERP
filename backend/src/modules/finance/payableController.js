/**
 * 应付管理控制器
 */
const { Payable, Settlement, SettlementItem, Supplier, SupplierPaymentAccount, Inbound, PurchaseRequest, SettlementAccount, SettlementAccountTransaction, sequelize } = require('../../models');
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
      status: 'unpaid',
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
        paid_amount: payable.total_amount
      }, { transaction });
    }

    await created.update({ total_amount: totalAmount }, { transaction });
    return created;
  });

  ctx.body = { code: 0, message: '结算单创建成功', data: settlement };
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

  ctx.body = formatPaginatedResult(normalizeSettlements(rows), { page, pageSize, count });
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
