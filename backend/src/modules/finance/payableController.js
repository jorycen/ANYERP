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
  PurchaseRequest,
  PurchaseRequestItem,
  PurchaseAdjustment,
  sequelize
} = require('../../models');
const { Op, col, where } = require('sequelize');
const { generateUUID, paginate, formatPaginatedResult, buildPendingFirstOrder } = require('../../utils');
const moment = require('moment');
const XLSX = require('xlsx');
const {
  actualUnitPrice,
  getSettlementItemAvailableAmount,
  getAllocationSummary,
  getPayableRemaining,
  refreshPayableState,
  refreshExpenseState
} = require('./settlementAllocation');
const { recordBusinessAction } = require('../../utils/businessActionLog');
const { sendExcel } = require('../../utils/excelExport');
const { accessibleDistributorIds, canAccessDistributor, distributorWhere } = require('../../utils/distributorScope');

function assertDistributorOperation(ctx, distributorId, message = '无权操作该经销商数据') {
  if (!canAccessDistributor(ctx.state.user, distributorId)) ctx.throw(403, message);
}

function applyDistributorFilter(whereObject, user) {
  const ids = accessibleDistributorIds(user);
  if (!ids.includes('*')) {
    const existing = whereObject[Op.and];
    whereObject[Op.and] = [
      ...(Array.isArray(existing) ? existing : (existing ? [existing] : [])),
      distributorWhere(user)
    ];
  }
  return whereObject;
}

function getPayableTaxStatus(invoiceType) {
  const value = String(invoiceType || '').trim().toLowerCase();
  if (!value) return 'UNKNOWN';
  if (value.includes('未税') || value.includes('untaxed')) return 'UNTAXED';
  if (value.includes('含税') || value.includes('增专票') || value.includes('tax_included')) return 'TAX_INCLUDED';
  return 'UNKNOWN';
}

function getCurrentPayableTotal(payable) {
  if (payable?.source_type !== 'purchase') return roundAmount(payable?.total_amount || 0);
  return roundAmount(Number(payable.total_amount || 0) - Number(payable.offset_amount || 0));
}

async function getPurchaseAdjustmentQuantityDeltas(requestIds, transaction = null) {
  const ids = [...new Set((requestIds || []).filter(Boolean).map(String))];
  const result = new Map();
  if (!ids.length) return result;
  const adjustments = await PurchaseAdjustment.findAll({
    where: { request_id: { [Op.in]: ids }, status: 'completed' },
    attributes: ['request_id'],
    include: [{
      association: 'items',
      attributes: ['request_item_id', 'quantity_delta']
    }],
    transaction
  });
  adjustments.forEach(adjustment => {
    (adjustment.items || []).forEach(item => {
      const key = String(item.request_item_id);
      result.set(key, Number(result.get(key) || 0) + Number(item.quantity_delta || 0));
    });
  });
  return result;
}

/**
 * 应付款列表
 */
function buildPayableListWhere(query, user) {
  const { supplierId, regionId, sourceType, sourceNo, status, startDate, endDate } = query;
  const where = {};

  if (supplierId) where.supplier_id = supplierId;
  if (regionId) where.region_id = regionId;
  if (sourceType) {
    const sourceTypes = String(sourceType).split(',').map(item => item.trim()).filter(Boolean);
    if (sourceTypes.length === 1) where.source_type = sourceTypes[0];
    if (sourceTypes.length > 1) where.source_type = { [Op.in]: sourceTypes };
  }
  if (sourceNo) {
    const keyword = String(sourceNo).trim();
    if (keyword) {
      where[Op.or] = [
        { source_no: { [Op.like]: `%${keyword}%` } },
        { request_no: { [Op.like]: `%${keyword}%` } }
      ];
    }
  }
  if (status) {
    where.status = status === 'unpaid'
      ? { [Op.in]: ['unpaid', 'partial_settled', 'settling', 'credit'] }
      : status;
  }
  if (startDate || endDate) {
    where.create_time = {};
    if (startDate) where.create_time[Op.gte] = new Date(`${startDate}T00:00:00.000+08:00`);
    if (endDate) where.create_time[Op.lte] = new Date(`${endDate}T23:59:59.999+08:00`);
  }
  applyDistributorFilter(where, user);
  return where;
}

async function getPayableList(ctx) {
  const { page = 1, pageSize = 20 } = ctx.query;
  const where = buildPayableListWhere(ctx.query, ctx.state.user);

  const { count, rows } = await Payable.findAndCountAll({
    where,
    order: buildPendingFirstOrder(sequelize, {
      statusColumn: 'Payable.status',
      pendingStatuses: ['unpaid', 'partial_settled'],
      dateColumns: ['Payable.create_time'],
      idColumn: 'Payable.payable_id'
    }),
    ...paginate({}, { page, pageSize })
  });

  const requestIds = [...new Set(rows.map(row => row.request_id).filter(Boolean))];
  const expenseIds = [...new Set(rows
    .filter(row => ['expense', 'reimbursement'].includes(row.source_type) && row.source_id)
    .map(row => row.source_id))];
  const [requests, expenses] = await Promise.all([
    requestIds.length
      ? PurchaseRequest.findAll({
        where: { request_id: { [Op.in]: requestIds } },
        attributes: [
          'request_id',
          'invoice_type',
          'total_amount',
          'rebate_deduction',
          'apply_user',
          'submit_user',
          'create_user'
        ]
      })
      : [],
    expenseIds.length
      ? Expense.findAll({
        where: { expense_id: { [Op.in]: expenseIds } },
        attributes: ['expense_id', 'invoice_type']
      })
      : []
  ]);
  const requestSnapshots = new Map(requests.map(item => [String(item.request_id), item]));
  const expenseInvoiceTypes = new Map(expenses.map(item => [String(item.expense_id), item.invoice_type]));
  rows.forEach(row => {
    const request = requestSnapshots.get(String(row.request_id));
    const invoiceType = request?.invoice_type
      || expenseInvoiceTypes.get(String(row.source_id))
      || '';
    row.setDataValue('invoice_type', invoiceType);
    row.setDataValue('tax_status', getPayableTaxStatus(invoiceType));
  });

  const summaryRows = await Payable.findAll({
    where,
    attributes: ['payable_id', 'total_amount']
  });
  const allocationSummary = await getAllocationSummary(summaryRows.map(row => row.payable_id));
  const summary = summaryRows.reduce((result, row) => {
    const allocated = allocationSummary.get(String(row.payable_id))?.amount || 0;
    result.totalAmount += Math.max(0, getPayableRemaining(row.total_amount, allocated, row.offset_amount));
    return result;
  }, { totalCount: summaryRows.length, totalAmount: 0 });
  rows.forEach(row => {
    const allocated = allocationSummary.get(String(row.payable_id))?.amount || 0;
    const request = requestSnapshots.get(String(row.request_id));
    const isPurchaseRelated = ['purchase', 'purchase_adjustment'].includes(row.source_type);
    row.setDataValue('settled_amount', roundAmount(allocated));
    row.setDataValue('remaining_amount', getPayableRemaining(row.total_amount, allocated, row.offset_amount));
    row.setDataValue('current_total_amount', getCurrentPayableTotal(row));
    row.setDataValue('purchase_original_amount', row.source_type === 'purchase' ? request?.total_amount ?? null : null);
    row.setDataValue('purchase_rebate_deduction', row.source_type === 'purchase' ? request?.rebate_deduction ?? null : null);
    row.setDataValue(
      'purchase_initiator',
      isPurchaseRelated
        ? request?.apply_user || request?.submit_user || request?.create_user || ''
        : ''
    );
  });

  const result = formatPaginatedResult(rows, { page, pageSize, count });
  result.summary = {
    totalCount: summary.totalCount,
    totalAmount: roundAmount(summary.totalAmount)
  };
  ctx.body = result;
}

async function exportPayableList(ctx) {
  const where = buildPayableListWhere(ctx.query, ctx.state.user);
  const rows = await Payable.findAll({
    where,
    order: buildPendingFirstOrder(sequelize, {
      statusColumn: 'Payable.status',
      pendingStatuses: ['unpaid', 'partial_settled', 'settling', 'credit'],
      dateColumns: ['Payable.create_time'],
      idColumn: 'Payable.payable_id'
    })
  });
  const requestIds = [...new Set(rows
    .filter(row => ['purchase', 'purchase_adjustment'].includes(row.source_type) && row.request_id)
    .map(row => row.request_id))];
  const requests = requestIds.length
    ? await PurchaseRequest.findAll({
      where: { request_id: { [Op.in]: requestIds } },
      attributes: ['request_id', 'total_amount', 'rebate_deduction', 'apply_user', 'submit_user', 'create_user']
    })
    : [];
  const requestSnapshots = new Map(requests.map(item => [String(item.request_id), item]));
  const allocationSummary = await getAllocationSummary(rows.map(row => row.payable_id));
  const data = rows.map(row => {
    const item = row.toJSON();
    const allocated = allocationSummary.get(String(item.payable_id))?.amount || 0;
    const request = item.source_type === 'purchase' ? requestSnapshots.get(String(item.request_id)) : null;
    return {
      来源单号: item.source_no || item.request_no || '',
      来源类型: item.source_type || '',
      收款方: item.payee_name || item.supplier_name || '',
      采购原价: request ? Number(request.total_amount || 0) : '',
      返利抵扣: request ? Number(request.rebate_deduction || 0) : '',
      应付金额: Number(item.total_amount || 0),
      已结算金额: Number(allocated || 0),
      剩余应付金额: getPayableRemaining(item.total_amount, allocated, item.offset_amount),
      已付金额: Number(item.paid_amount || 0),
      状态: item.status || '',
      采购发起人: ['purchase', 'purchase_adjustment'].includes(item.source_type)
        ? request?.apply_user || request?.submit_user || request?.create_user || ''
        : '',
      创建时间: item.create_time || ''
    };
  });
  sendExcel(ctx, data, [
    '来源单号', '来源类型', '收款方', '采购原价', '返利抵扣', '应付金额', '已结算金额', '剩余应付金额',
    '已付金额', '状态', '采购发起人', '创建时间'
  ], `应付管理_${new Date().toISOString().slice(0, 10)}.xlsx`, '应付管理');
}

/**
 * 获取供应商未结算的应付款列表
 */
async function getUnpaidBySupplier(ctx) {
  const { supplierId, distributorId } = ctx.query;

  if (!supplierId) {
    ctx.throw(400, '请选择供应商');
  }

  if (distributorId) assertDistributorOperation(ctx, distributorId);
  const where = {
    supplier_id: supplierId,
    status: { [Op.in]: ['unpaid', 'partial_settled', 'settling'] }
  };
  if (distributorId) where.distributor_id = distributorId;
  applyDistributorFilter(where, ctx.state.user);
  const rows = await Payable.findAll({
    where,
    order: [['create_time', 'DESC']]
  });

  rows.forEach(row => row.setDataValue('current_total_amount', getCurrentPayableTotal(row)));

  ctx.body = { code: 0, data: rows };
}

/**
 * 创建结算单
 */
async function getPayableSettlementItems(ctx) {
  const { supplierId, payableIds, distributorId } = ctx.query;
  const ids = payableIds
    ? String(payableIds).split(',').map(item => item.trim()).filter(Boolean)
    : null;
  const where = {
      status: { [Op.in]: ['unpaid', 'partial_settled', 'settling'] },
    source_type: { [Op.notIn]: ['expense', 'reimbursement'] }
  };
  if (supplierId) where.supplier_id = supplierId;
  if (ids?.length) where.payable_id = { [Op.in]: ids };
  if (distributorId) {
    assertDistributorOperation(ctx, distributorId);
    where.distributor_id = distributorId;
  }
  applyDistributorFilter(where, ctx.state.user);
  const payables = await Payable.findAll({ where, order: [['create_time', 'DESC']] });
  const summary = await getAllocationSummary(payables.map(item => item.payable_id));
  const requestIds = [...new Set(payables.map(item => item.request_id).filter(Boolean))];
  const requestItems = requestIds.length
    ? await PurchaseRequestItem.findAll({ where: { request_id: { [Op.in]: requestIds } } })
    : [];
  const adjustmentQuantityDeltas = await getPurchaseAdjustmentQuantityDeltas(requestIds);
  const itemMap = new Map();
  requestItems.forEach(item => {
    const key = String(item.request_id);
    if (!itemMap.has(key)) itemMap.set(key, []);
    itemMap.get(key).push(item);
  });
  const rows = [];
  payables.forEach(payable => {
    const allocated = summary.get(String(payable.payable_id)) || {
      amount: 0,
      quantityByItem: new Map(),
      amountByItem: new Map()
    };
    const items = payable.source_type === 'purchase' && (
      Number(allocated.amount || 0) <= 0 ||
      allocated.quantityByItem.size > 0 ||
      allocated.amountByItem.size > 0
    )
      ? (itemMap.get(String(payable.request_id)) || [])
      : [];
    if (items.length) {
      const payableRemaining = getPayableRemaining(payable.total_amount, allocated.amount, payable.offset_amount);
      let itemRemaining = Math.max(0, payableRemaining);
      items.forEach(item => {
        const adjustedQuantity = Math.max(0, Number(item.quantity || 0) + Number(adjustmentQuantityDeltas.get(String(item.item_id)) || 0));
        const unitPrice = actualUnitPrice(item);
        const usedAmount = Number(allocated.amountByItem.get(String(item.item_id)) || 0);
        const availableQuantity = Math.max(
          0,
          adjustedQuantity - Number(allocated.quantityByItem.get(String(item.item_id)) || 0)
        );
        const availableItemAmount = getSettlementItemAvailableAmount(
          item,
          usedAmount,
          adjustmentQuantityDeltas.get(String(item.item_id))
        );
        if (availableItemAmount <= 0) return;
        const availableAmount = Math.min(availableItemAmount, itemRemaining);
        if (availableAmount <= 0) return;
        rows.push({
          payable_id: payable.payable_id,
          request_id: payable.request_id,
          request_no: payable.request_no,
          supplier_id: payable.supplier_id,
          supplier_name: payable.supplier_name,
          source_type: payable.source_type,
          total_amount: itemRemaining,
          settled_amount: allocated.amount,
          remaining_amount: itemRemaining,
          request_item_id: item.item_id,
          product_id: item.product_id,
          product_name: item.product_name,
          available_quantity: availableQuantity,
          available_amount: availableAmount,
          unit_price: unitPrice,
          create_time: payable.create_time
        });
        itemRemaining = roundAmount(itemRemaining - availableAmount);
      });
      return;
    }
    const remaining = getPayableRemaining(payable.total_amount, allocated.amount, payable.offset_amount);
    if (remaining > 0) rows.push({
      payable_id: payable.payable_id,
      request_id: payable.request_id,
      request_no: payable.request_no,
      supplier_id: payable.supplier_id,
      supplier_name: payable.supplier_name,
      source_type: payable.source_type,
      total_amount: payable.total_amount,
      settled_amount: allocated.amount,
        remaining_amount: remaining,
      product_name: payable.source_type === 'purchase_adjustment' ? '采购调整' : '整单金额',
      available_quantity: null,
      available_amount: remaining,
      unit_price: null,
      create_time: payable.create_time
    });
  });
  ctx.body = { code: 0, data: rows };
}

async function createSettlement(ctx) {
  const {
    supplierId,
    payableIds = [],
    allocations = [],
    supplierAccountId,
    paymentAccountType = 'saved',
    otherPaymentRemark,
    otherPaymentImage,
    remark,
    distributorId
  } = ctx.request.body;
  const user = ctx.state.user;
  if (!supplierId) ctx.throw(400, 'supplier is required');
  const selectedIds = [...new Set([
    ...payableIds,
    ...allocations.map(item => item.payableId || item.payable_id)
  ].filter(Boolean).map(String))];
  if (!selectedIds.length) ctx.throw(400, 'select payable items first');
  if (distributorId) assertDistributorOperation(ctx, distributorId);
  const supplier = await Supplier.findByPk(supplierId);
  if (!supplier) ctx.throw(404, 'supplier not found');

  let supplierAccountSnapshot = null;
  let finalSupplierAccountId = null;
  if (paymentAccountType === 'other') {
    if (!String(otherPaymentRemark || '').trim()) ctx.throw(400, 'other payment remark is required');
    if (!otherPaymentImage) ctx.throw(400, 'other payment evidence is required');
  } else {
    if (!supplierAccountId) ctx.throw(400, 'supplier payment account is required');
    const supplierAccount = await SupplierPaymentAccount.findOne({
      where: { account_id: supplierAccountId, supplier_id: supplierId, status: 1, is_deleted: 0 }
    });
    if (!supplierAccount) ctx.throw(404, 'supplier payment account is unavailable');
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

  let settlement;
  await sequelize.transaction(async transaction => {
    const payableWhere = {
        payable_id: { [Op.in]: selectedIds },
        supplier_id: supplierId,
        source_type: { [Op.notIn]: ['expense', 'reimbursement'] },
        status: { [Op.in]: ['unpaid', 'partial_settled', 'settling'] }
      };
    if (distributorId) payableWhere.distributor_id = distributorId;
    applyDistributorFilter(payableWhere, user);
    const payables = await Payable.findAll({
      where: payableWhere,
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (payables.length !== selectedIds.length) ctx.throw(400, 'some payable items are unavailable');
    const payableDistributorIds = [...new Set(payables.map(item => item.distributor_id).filter(Boolean).map(String))];
    if (payableDistributorIds.length !== 1) ctx.throw(400, '结算单必须只包含一个经销商的应付款，不能合并结算');
    if (distributorId && payableDistributorIds[0] !== String(distributorId)) ctx.throw(400, '结算经销商与应付款所属经销商不一致');
    const payableMap = new Map(payables.map(item => [String(item.payable_id), item]));
    const summary = await getAllocationSummary(selectedIds, transaction);
    const requestItemIds = [...new Set(allocations.map(item => item.requestItemId || item.request_item_id).filter(Boolean).map(String))];
    const requestItems = requestItemIds.length
      ? await PurchaseRequestItem.findAll({ where: { item_id: { [Op.in]: requestItemIds } }, transaction, lock: transaction.LOCK.UPDATE })
      : [];
    const adjustmentQuantityDeltas = await getPurchaseAdjustmentQuantityDeltas(
      payables.map(item => item.request_id),
      transaction
    );
    const requestItemMap = new Map(requestItems.map(item => [String(item.item_id), item]));
    const sourceAllocations = allocations.length ? allocations : [];
    const rows = [];
    if (sourceAllocations.length) {
      for (const allocation of sourceAllocations) {
        const payableId = String(allocation.payableId || allocation.payable_id || '');
        const payable = payableMap.get(payableId);
        if (!payable) ctx.throw(400, 'payable does not belong to supplier');
        const requestItemId = allocation.requestItemId || allocation.request_item_id;
        const item = requestItemId ? requestItemMap.get(String(requestItemId)) : null;
        let used = summary.get(payableId);
        if (!used) {
          used = { amount: 0, quantityByItem: new Map(), amountByItem: new Map() };
          summary.set(payableId, used);
        }
        if (item) {
          if (String(item.request_id) !== String(payable.request_id)) ctx.throw(400, 'purchase item does not belong to payable');
          const unitPrice = actualUnitPrice(item);
          const amountValue = allocation.amount ?? allocation.settleAmount ?? allocation.settle_amount;
          if (amountValue !== undefined && amountValue !== null && amountValue !== '') {
            const amount = roundAmount(amountValue);
            const usedAmount = Number(used.amountByItem.get(String(item.item_id)) || 0);
            const itemRemaining = getSettlementItemAvailableAmount(
              item,
              usedAmount,
              adjustmentQuantityDeltas.get(String(item.item_id))
            );
            const payableRemaining = getPayableRemaining(
              payable.total_amount,
              used.amount,
              payable.offset_amount
            );
            if (amount <= 0 || amount > itemRemaining + 0.005 || amount > payableRemaining + 0.005) {
              ctx.throw(400, 'settlement amount exceeds remaining amount');
            }
            rows.push({ payable, requestItem: item, quantity: null, unitPrice, amount });
            used.amountByItem.set(String(item.item_id), usedAmount + amount);
            used.amount = Number(used.amount || 0) + amount;
          } else {
            const quantity = Number(allocation.quantity || allocation.settleQuantity || allocation.settle_quantity || 0);
            const usedQuantity = Number(used.quantityByItem.get(String(item.item_id)) || 0);
            const adjustedQuantity = Math.max(0, Number(item.quantity || 0) + Number(adjustmentQuantityDeltas.get(String(item.item_id)) || 0));
            const availableQuantity = adjustedQuantity - usedQuantity;
            if (quantity <= 0 || quantity > availableQuantity + 0.00005) ctx.throw(400, 'settlement quantity exceeds remaining quantity');
            const amount = roundAmount(quantity * unitPrice);
            rows.push({ payable, requestItem: item, quantity, unitPrice, amount });
            used.quantityByItem.set(String(item.item_id), usedQuantity + quantity);
            used.amountByItem.set(String(item.item_id), Number(used.amountByItem.get(String(item.item_id)) || 0) + amount);
            used.amount = Number(used.amount || 0) + amount;
          }
        } else {
          const remaining = getPayableRemaining(payable.total_amount, used.amount, payable.offset_amount);
          const amountValue = allocation.amount ?? allocation.settleAmount ?? allocation.settle_amount;
          const amount = roundAmount(amountValue);
          if (amount <= 0 || amount > remaining + 0.005) ctx.throw(400, 'settlement amount exceeds remaining amount');
          rows.push({ payable, requestItem: null, quantity: null, unitPrice: null, amount });
          used.amount = Number(used.amount || 0) + amount;
        }
      }
    } else {
      for (const payable of payables) {
        const used = summary.get(String(payable.payable_id)) || { amount: 0 };
        const remaining = getPayableRemaining(payable.total_amount, used.amount, payable.offset_amount);
        if (remaining > 0) rows.push({ payable, requestItem: null, quantity: null, unitPrice: null, amount: remaining });
      }
    }
    const creditRows = await Payable.findAll({
      where: {
        supplier_id: supplierId,
        status: 'credit',
        total_amount: { [Op.lt]: 0 },
        distributor_id: payableDistributorIds[0]
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
      order: [['create_time', 'ASC']]
    });
    let creditRemaining = creditRows.reduce((sum, payable) => sum + Math.max(0, Math.abs(Number(payable.total_amount || 0)) - Number(payable.offset_amount || 0)), 0);
    for (const row of rows) {
      if (creditRemaining <= 0 || row.amount <= 0) continue;
      const offset = Math.min(row.amount, creditRemaining);
      row.amount = roundAmount(row.amount - offset);
      row.offsetAmount = roundAmount((row.offsetAmount || 0) + offset);
      creditRemaining = roundAmount(creditRemaining - offset);
      let creditToApply = offset;
      for (const credit of creditRows) {
        if (creditToApply <= 0) break;
        const availableCredit = Math.max(0, Math.abs(Number(credit.total_amount || 0)) - Number(credit.offset_amount || 0));
        if (availableCredit <= 0) continue;
        const creditUsed = Math.min(creditToApply, availableCredit);
        credit.offset_amount = roundAmount(Number(credit.offset_amount || 0) + creditUsed);
        creditToApply = roundAmount(creditToApply - creditUsed);
        if (Math.abs(Number(credit.total_amount || 0)) - Number(credit.offset_amount || 0) <= 0.005) {
          credit.status = 'offset';
        }
        await credit.save({ transaction, fields: ['offset_amount', 'status'] });
      }
    }
    for (const row of rows) {
      if (row.offsetAmount > 0) {
        row.payable.offset_amount = roundAmount(Number(row.payable.offset_amount || 0) + row.offsetAmount);
        await row.payable.save({ transaction, fields: ['offset_amount'] });
      }
    }
    const finalRows = rows.filter(row => row.amount > 0);
    const totalAmount = roundAmount(finalRows.reduce((sum, row) => sum + row.amount, 0));
    if (totalAmount <= 0) ctx.throw(400, 'settlement amount must be greater than zero');
    const regionIds = [...new Set(finalRows.map(row => row.payable.region_id).filter(Boolean).map(String))];
    settlement = await Settlement.create({
      settlement_id: generateUUID(),
      settlement_no: `S${moment().format('YYYYMMDDHHmmss')}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`,
      supplier_id: supplierId,
      supplier_name: supplier.name,
      supplier_account_id: finalSupplierAccountId,
      supplier_account_snapshot: supplierAccountSnapshot,
      other_payment_remark: paymentAccountType === 'other' ? String(otherPaymentRemark).trim() : null,
      other_payment_image: paymentAccountType === 'other' ? otherPaymentImage : null,
      settlement_type: 'supplier',
      region_id: regionIds.length === 1 ? regionIds[0] : null,
      distributor_id: payableDistributorIds[0],
      total_amount: totalAmount,
      status: 'draft',
      payment_status: 'unpaid',
      remark: String(remark || '').trim().slice(0, 512) || null,
      create_user: user?.name || user?.phone || ''
    }, { transaction });
    for (const row of finalRows) {
      await SettlementItem.create({
        settlement_id: settlement.settlement_id,
        payable_id: row.payable.payable_id,
        request_item_id: row.requestItem?.item_id || null,
        product_id: row.requestItem?.product_id || null,
        product_name: row.requestItem?.product_name || null,
        quantity: row.quantity,
        unit_price: row.unitPrice,
        request_no: row.payable.request_no,
        amount: row.amount
      }, { transaction });
    }
    for (const payableId of new Set(finalRows.map(row => row.payable.payable_id))) {
      await refreshPayableState(payableId, transaction);
    }
  });
  ctx.body = { code: 0, message: 'settlement created', data: settlement };
}

async function createSettlementLegacy(ctx) {
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
  const legacyDistributorIds = [...new Set(payables.map(item => item.distributor_id).filter(Boolean).map(String))];
  if (legacyDistributorIds.length !== 1) ctx.throw(400, '结算单必须只包含一个经销商的应付款，不能合并结算');
  assertDistributorOperation(ctx, legacyDistributorIds[0]);

  const settlementTotal = roundAmount(payables.reduce((sum, payable) => sum + Number(payable.total_amount || 0), 0));
  if (settlementTotal <= 0) {
    ctx.throw(400, '结算总金额必须大于0；负向采购调整需与正向应付款一并抵扣');
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
    const regionIds = [...new Set(payables.map(payable => payable.region_id).filter(Boolean).map(String))];
    const created = await Settlement.create({
      settlement_id: settlementId,
      settlement_no: seq,
      supplier_id: supplierId,
      supplier_name: supplier.name,
      supplier_account_id: finalSupplierAccountId,
      supplier_account_snapshot: supplierAccountSnapshot,
      other_payment_remark: finalOtherPaymentRemark,
      other_payment_image: finalOtherPaymentImage,
      region_id: regionIds.length === 1 ? regionIds[0] : null,
      distributor_id: legacyDistributorIds[0],
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
  const { payableId, amount: requestedAmount, remark } = ctx.request.body;
  const user = ctx.state.user;
  if (!payableId) ctx.throw(400, 'payableId is required');
  let settlement;
  await sequelize.transaction(async transaction => {
    const payable = await Payable.findByPk(payableId, {
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!payable || !['expense', 'reimbursement'].includes(payable.source_type)) ctx.throw(404, 'expense payable not found');
    assertDistributorOperation(ctx, payable.distributor_id);
    if (!['unpaid', 'partial_settled', 'settling'].includes(payable.status)) ctx.throw(400, 'expense payable is unavailable');
    const allocation = (await getAllocationSummary([payableId], transaction)).get(String(payableId));
    const remaining = roundAmount(Number(payable.total_amount || 0) - Number(allocation?.amount || 0));
    const amount = requestedAmount === undefined || requestedAmount === null || requestedAmount === ''
      ? remaining
      : roundAmount(requestedAmount);
    if (amount <= 0 || amount > remaining + 0.005) ctx.throw(400, 'reimbursement amount exceeds remaining amount');
    settlement = await Settlement.create({
      settlement_id: generateUUID(),
      settlement_no: `EXS${moment().format('YYYYMMDDHHmmss')}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`,
      supplier_id: null,
      supplier_name: payable.payee_name || payable.supplier_name || 'employee',
      settlement_type: payable.source_type === 'reimbursement' ? 'reimbursement' : 'expense',
      payee_type: payable.payee_type || 'counterparty',
      payee_id: payable.payee_id || '',
      payee_name: payable.payee_name || payable.supplier_name || '',
      source_type: payable.source_type,
      source_id: payable.source_id,
      source_no: payable.source_no || payable.request_no,
      region_id: payable.region_id || null,
      distributor_id: payable.distributor_id,
      other_payment_remark: payable.source_type === 'reimbursement' ? 'personal advance reimbursement' : 'expense settlement',
      total_amount: amount,
      paid_amount: 0,
      status: 'draft',
      payment_status: 'unpaid',
      remark: String(remark || '').trim().slice(0, 512) || null,
      create_user: user?.name || user?.phone || ''
    }, { transaction });
    await SettlementItem.create({
      settlement_id: settlement.settlement_id,
      payable_id: payable.payable_id,
      request_no: payable.source_no || payable.request_no,
      amount
    }, { transaction });
    if (payable.source_id) {
      await Expense.update({ payable_id: payable.payable_id, settlement_id: settlement.settlement_id, update_time: new Date() }, {
        where: { expense_id: payable.source_id },
        transaction
      });
    }
    await refreshPayableState(payableId, transaction);
    if (payable.source_id) await refreshExpenseState(payable.source_id, transaction);
  });
  ctx.body = { code: 0, message: 'expense settlement created', data: settlement };
}

async function createExpenseSettlementLegacy(ctx) {
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
      region_id: payable.region_id || null,
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

  for (const payableId of new Set(items.map(item => item.payable_id).filter(Boolean))) {
    await refreshPayableState(payableId, transaction);
  }

  if (settlement.source_id && ['expense', 'reimbursement'].includes(settlement.settlement_type)) {
    await refreshExpenseState(settlement.source_id, transaction);
  }

  return { paidAmount, paymentStatus };
}

/**
 * 结算单列表
 */
function buildSettlementListWhere(query, user) {
  const { supplierId, regionId, settlementType, status, paymentStatus } = query;
  const where = { is_deleted: 0 };

  if (supplierId) where.supplier_id = supplierId;
  if (regionId) where.region_id = regionId;
  if (settlementType) {
    const settlementTypes = String(settlementType).split(',').map(item => item.trim()).filter(Boolean);
    where.settlement_type = settlementTypes.length > 1 ? { [Op.in]: settlementTypes } : settlementTypes[0];
  }
  if (status) where.status = status;
  if (paymentStatus) where.payment_status = paymentStatus;
  applyDistributorFilter(where, user);
  return where;
}

async function getSettlementList(ctx) {
  const { page = 1, pageSize = 20 } = ctx.query;
  const where = buildSettlementListWhere(ctx.query, ctx.state.user);

  const order = [
    [
      sequelize.literal(
        "CASE WHEN `Settlement`.`status` IN ('draft', 'pending_approval') OR " +
        "(`Settlement`.`status` = 'confirmed' AND `Settlement`.`payment_status` IN ('unpaid', 'partial_paid')) " +
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

async function exportSettlementList(ctx) {
  const where = buildSettlementListWhere(ctx.query, ctx.state.user);
  const rows = await Settlement.findAll({
    where,
    include: [{ model: SettlementItem, as: 'items' }],
    order: [
      [sequelize.literal(
        "CASE WHEN `Settlement`.`status` IN ('draft', 'pending_approval') OR " +
        "(`Settlement`.`status` = 'confirmed' AND `Settlement`.`payment_status` IN ('unpaid', 'partial_paid')) " +
        'THEN 0 ELSE 1 END'
      ), 'ASC'],
      [sequelize.literal('`Settlement`.`create_time`'), 'DESC'],
      [sequelize.literal('`Settlement`.`settlement_id`'), 'DESC']
    ]
  });
  const data = normalizeSettlements(rows).map(row => ({
    结算单号: row.settlement_no || '',
    收款方: row.payee_name || row.supplier_name || '',
    来源单号: row.source_no || '',
    结算类型: row.settlement_type || '',
    结算金额: Number(row.total_amount || 0),
    已付金额: Number(row.paid_amount || 0),
    状态: row.status || '',
    付款状态: row.payment_status || '',
    经手人: row.operator_name || '',
    制单人: row.create_user || '',
    备注: row.remark || '',
    创建时间: row.create_time || '',
    确认时间: row.confirmed_time || ''
  }));
  sendExcel(ctx, data, [
    '结算单号', '收款方', '来源单号', '结算类型', '结算金额', '已付金额',
    '状态', '付款状态', '经手人', '制单人', '备注', '创建时间', '确认时间'
  ], `应付结算单_${new Date().toISOString().slice(0, 10)}.xlsx`, '应付结算单');
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

  if (!settlement || settlement.is_deleted) {
    ctx.throw(404, '结算单不存在');
  }
  assertDistributorOperation(ctx, settlement.distributor_id);

  ctx.body = { code: 0, data: normalizeSettlement(settlement) };
}

async function getSettlementById(settlementId, user = null) {
  if (!settlementId) {
    const error = new Error('结算单ID不能为空');
    error.status = 400;
    throw error;
  }

  const settlement = await Settlement.findByPk(settlementId, {
    include: [{ model: SettlementItem, as: 'items' }]
  });

  if (!settlement || settlement.is_deleted) {
    const error = new Error('结算单不存在');
    error.status = 404;
    throw error;
  }
  if (user && !canAccessDistributor(user, settlement.distributor_id)) {
    const error = new Error('无权操作该经销商结算单');
    error.status = 403;
    throw error;
  }

  return settlement;
}

/**
 * 删除从未提交过的结算单草稿，保留单据和明细用于审计。
 */
async function deleteSettlementDraft(ctx) {
  const { id } = ctx.params;
  const user = ctx.state.user;

  await sequelize.transaction(async transaction => {
    const settlement = await Settlement.findOne({
      where: { settlement_id: id, is_deleted: 0 },
      include: [{ model: SettlementItem, as: 'items' }],
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!settlement) ctx.throw(404, '结算单不存在');
    if (settlement.status !== 'draft' || settlement.submit_time) {
      ctx.throw(400, '只有从未提交过的结算单草稿可以删除');
    }
    if (settlement.payment_status !== 'unpaid' || Number(settlement.paid_amount || 0) > 0) {
      ctx.throw(400, '已有付款记录的结算单不能删除');
    }

    const payableIds = new Set((settlement.items || []).map(item => item.payable_id).filter(Boolean));
    await settlement.update({ is_deleted: 1 }, { transaction });

    for (const payableId of payableIds) {
      await refreshPayableState(payableId, transaction);
    }
    if (settlement.source_id && ['expense', 'reimbursement'].includes(settlement.settlement_type)) {
      await Expense.update({ settlement_id: null, update_time: new Date() }, {
        where: { expense_id: settlement.source_id, settlement_id: settlement.settlement_id },
        transaction
      });
      await refreshExpenseState(settlement.source_id, transaction);
    }

    await recordBusinessAction({
      businessType: 'payable_settlement',
      businessId: settlement.settlement_id,
      businessNo: settlement.settlement_no,
      action: 'deleted',
      fromStatus: 'draft',
      toStatus: 'deleted',
      user,
      transaction
    });
  });

  ctx.body = { code: 0, message: '结算单草稿已删除', settlementId: id };
}

function throwStatusError(ctx, error) {
  ctx.throw(error.status || 500, error.message || '操作失败');
}

/**
 * 草稿提交后进入审批，审批通过后进入付款管理待处理。
 */
async function submitSettlement(ctx) {
  try {
    const { settlementId } = ctx.request.body;
    const settlement = await getSettlementById(settlementId, ctx.state.user);

    if (settlement.status !== 'draft') {
      ctx.throw(400, '只有草稿状态的结算单可以提交');
    }

    await settlement.update({
      status: 'pending_approval',
      submit_time: new Date(),
      approval_user: null,
      approval_time: null,
      approval_comment: null
    });
    ctx.body = { code: 0, message: '结算单已提交，等待审批' };
  } catch (error) {
    throwStatusError(ctx, error);
  }
}

/**
 * 审批通过结算单，进入付款管理待处理。
 */
async function confirmSettlement(ctx) {
  try {
    const { settlementId, comment = '' } = ctx.request.body;
    const user = ctx.state.user;
    const settlement = await getSettlementById(settlementId, ctx.state.user);

    if (settlement.status === 'pending_approval') {
      const operator = user?.name || user?.phone || '';
      await settlement.update({
        status: 'confirmed',
        confirmed_time: new Date(),
        approval_user: operator,
        approval_time: new Date(),
        approval_comment: String(comment || '').trim().slice(0, 512) || null
      });
      ctx.body = { code: 0, message: '结算单审批通过，已进入待付款' };
      return;
    }

    if (settlement.status === 'confirmed') {
      ctx.body = { code: 0, message: '结算单已审批通过' };
      return;
    }

    if (settlement.status !== 'pending_approval') {
      ctx.throw(400, '当前结算单状态不可确认');
    }
  } catch (error) {
    throwStatusError(ctx, error);
  }
}

/**
 * 审批拒绝后退回草稿，保留审批意见，允许重新提交。
 */
async function rejectSettlement(ctx) {
  try {
    const { settlementId, comment = '' } = ctx.request.body;
    const user = ctx.state.user;
    const settlement = await getSettlementById(settlementId, ctx.state.user);
    if (settlement.status !== 'pending_approval') {
      ctx.throw(400, '只有待审批结算单可以拒绝');
    }
    const operator = user?.name || user?.phone || '';

    await settlement.update({
      status: 'draft',
      approval_user: operator,
      approval_time: new Date(),
      approval_comment: String(comment || '').trim().slice(0, 512) || null
    });
    ctx.body = { code: 0, message: '结算单已退回草稿' };
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
    await sequelize.transaction(async transaction => {
      const settlement = await Settlement.findByPk(settlementId, {
        include: [{ model: SettlementItem, as: 'items' }],
        transaction,
        lock: transaction.LOCK.UPDATE
      });
      if (!settlement || settlement.is_deleted) ctx.throw(404, 'settlement not found');
      if (settlement.status === 'voided') ctx.throw(400, 'settlement already voided');
      if (settlement.payment_status !== 'unpaid') ctx.throw(400, 'paid settlement cannot be voided');
      await settlement.update({ status: 'voided', voided_time: new Date() }, { transaction });
      for (const payableId of new Set((settlement.items || []).map(item => item.payable_id).filter(Boolean))) {
        await refreshPayableState(payableId, transaction);
      }
      if (settlement.source_id && ['expense', 'reimbursement'].includes(settlement.settlement_type)) {
        await refreshExpenseState(settlement.source_id, transaction);
      }
    });
    ctx.body = { code: 0, message: 'settlement voided' };
  } catch (error) {
    throwStatusError(ctx, error);
  }
}

async function voidSettlementLegacy(ctx) {
  try {
    const { settlementId } = ctx.request.body;
    const settlement = await getSettlementById(settlementId, ctx.state.user);

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

function buildPaymentCandidateWhere(query = {}, user = null) {
  const candidateWhere = {
    status: 'confirmed',
    is_deleted: 0,
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
  if (user) applyDistributorFilter(candidateWhere, user);
  return candidateWhere;
}

async function getPaymentCandidates(ctx) {
  const { page = 1, pageSize = 20 } = ctx.query;
  const where = buildPaymentCandidateWhere(ctx.query, ctx.state.user);
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
  const where = buildPaymentCandidateWhere(ctx.query, ctx.state.user);
  const rows = await Settlement.findAll({
    where,
    order: [['confirmed_time', 'DESC'], ['create_time', 'DESC']]
  });

  const data = normalizeSettlements(rows).map(row => ({
    对方公司: row.supplier_account_snapshot_parsed?.companyName || '',
    对方开户行: row.supplier_account_snapshot_parsed?.bankName || '',
    对方账号: row.supplier_account_snapshot_parsed?.accountNumber || '',
    对方账户备注: row.supplier_account_snapshot_parsed?.remark || row.other_payment_remark || '',
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
  const paymentHeaders = [
    '对方公司', '对方开户行', '对方账号', '对方账户备注',
    '结算单号', '供应商', '结算金额', '已付金额', '剩余应付金额', '本次付款金额', '付款时间', '备注', '导入标识'
  ];
  const worksheet = XLSX.utils.json_to_sheet(data, { header: paymentHeaders });
  worksheet['!cols'] = paymentHeaders.map((header, index) => index === paymentHeaders.length - 1 ? { hidden: true } : {});
  XLSX.utils.book_append_sheet(workbook, worksheet, '实际付款');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const fileName = encodeURIComponent(`应付实际付款_${moment().format('YYYYMMDD_HHmmss')}.xlsx`);

  ctx.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  ctx.set('Content-Disposition', `attachment; filename*=UTF-8''${fileName}`);
  ctx.body = buffer;
}

async function validatePaymentImportRows(rows, accountId, user = null) {
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
      where: { settlement_no: settlementNo, is_deleted: 0 },
      include: [{ model: SettlementItem, as: 'items' }]
    });
    if (!settlement) {
      errors.push({ row: rowNo, settlementNo, message: '结算单不存在' });
      continue;
    }
    if (user && !canAccessDistributor(user, settlement.distributor_id)) {
      errors.push({ row: rowNo, settlementNo, message: '无权付款该经销商结算单' });
      continue;
    }
    const account = accountId
      ? await SettlementAccount.findOne({ where: { account_id: accountId, status: 1 } })
      : null;
    if (!account || String(account.distributor_id || '') !== String(settlement.distributor_id || '')) {
      errors.push({ row: rowNo, settlementNo, message: '付款账户与结算单所属经销商不一致' });
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
      distributorId: settlement.distributor_id,
      supplierName: settlement.supplier_name || '',
      supplierAccountId: settlement.supplier_account_id || '',
      supplierAccount: parseJsonText(settlement.supplier_account_snapshot),
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
  const result = await validatePaymentImportRows(rows, accountId, ctx.state.user);
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
  if (!canAccessDistributor(ctx.state.user, account.distributor_id)) ctx.throw(403, '无权使用该经销商付款账户');

  const result = await validatePaymentImportRows(rows, accountId, user);
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
      distributor_id: account.distributor_id,
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
      if (!settlement || settlement.is_deleted || settlement.status !== 'confirmed' || settlement.payment_status === 'paid') {
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
        distributor_id: row.distributorId,
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
    if (!canAccessDistributor(user, settlement.distributor_id)) ctx.throw(403, '无权付款该经销商结算单');
    if (String(account.distributor_id || '') !== String(settlement.distributor_id || '')) {
      ctx.throw(400, '付款账户与结算单所属经销商不一致');
    }
    if (settlement.is_deleted || settlement.status !== 'confirmed' || settlement.payment_status === 'paid') {
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
      distributor_id: settlement.distributor_id,
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
      distributor_id: settlement.distributor_id,
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
  applyDistributorFilter(where, ctx.state.user);

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
  assertDistributorOperation(ctx, batch.distributor_id);
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
  assertDistributorOperation(ctx, batch.distributor_id);
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
  exportPayableList,
  getPayableTaxStatus,
  getUnpaidBySupplier,
  getPayableSettlementItems,
  createSettlement,
  createExpenseSettlement,
  getSettlementList,
  exportSettlementList,
  getSettlementDetail,
  deleteSettlementDraft,
  submitSettlement,
  confirmSettlement,
  rejectSettlement,
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
