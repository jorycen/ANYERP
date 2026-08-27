const {
  Op
} = require('sequelize');
const {
  PurchaseAdjustment,
  PurchaseAdjustmentItem,
  PurchaseRequest,
  PurchaseRequestItem,
  Inbound,
  InboundItem,
  ReturnStockItem,
  Payable,
  Store,
  Supplier
} = require('../../models');
const { generateUUID } = require('../../utils');
const {
  getAllocationSummary,
  getPayableRemaining,
  refreshPayableState
} = require('../finance/settlementAllocation');

function money(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
}

function getRequestItemMatches(requestItems, inboundItem) {
  const exact = requestItems.filter(item => String(item.item_id) === String(inboundItem?.purchase_request_item_id || ''));
  if (exact.length) return exact;
  return requestItems.filter(item => String(item.product_id || '') === String(inboundItem?.product_id || ''));
}

function buildReturnAdjustmentItems({ requestItems, inboundItems, returnItems, returnNo }) {
  const inboundMap = new Map(inboundItems.map(item => [String(item.item_id), item]));
  const usedInboundQuantities = new Map();
  const rows = [];

  for (const returnItem of returnItems || []) {
    const explicitInboundItem = returnItem.inbound_item_id
      ? inboundMap.get(String(returnItem.inbound_item_id))
      : null;
    let inboundItem = explicitInboundItem;
    if (!inboundItem) {
      const candidates = inboundItems.filter(item => {
        if (String(item.product_id || '') !== String(returnItem.product_id || '')) return false;
        if (returnItem.pn_code && item.pn_code && String(returnItem.pn_code).trim() !== String(item.pn_code).trim()) return false;
        const used = Number(usedInboundQuantities.get(String(item.item_id)) || 0);
        return used < Math.max(0, Number(item.quantity || 0));
      });
      if (candidates.length !== 1) {
        throw new Error(`退库 ${returnNo} 无法唯一匹配原入库明细 ${returnItem.item_id || returnItem.product_id || ''}`);
      }
      inboundItem = candidates[0];
    }

    const requestMatches = getRequestItemMatches(requestItems, inboundItem);
    if (requestMatches.length !== 1) {
      throw new Error(`退库 ${returnNo} 无法唯一匹配原采购明细 ${inboundItem.purchase_request_item_id || inboundItem.product_id || ''}`);
    }
    const requestItem = requestMatches[0];
    const quantity = Math.max(0, Number(returnItem.quantity || 0));
    const originalQuantity = Math.max(0, Number(requestItem.quantity || 0));
    const unitPrice = Number(returnItem.unit_price ?? requestItem.unit_price ?? inboundItem.unit_price ?? 0);
    const rebatePerUnit = originalQuantity > 0
      ? Number(requestItem.rebate_deduction || 0) / originalQuantity
      : 0;
    const amountDelta = money(-quantity * (unitPrice - rebatePerUnit));
    const used = Number(usedInboundQuantities.get(String(inboundItem.item_id)) || 0);
    usedInboundQuantities.set(String(inboundItem.item_id), used + quantity);

    rows.push({
      request_item_id: requestItem.item_id,
      inbound_id: inboundItem.inbound_id,
      inbound_item_id: inboundItem.item_id,
      store_id: inboundItem.store_id,
      product_id: requestItem.product_id,
      product_name: requestItem.product_name || inboundItem.product_name || returnItem.product_name || '',
      unit_price: money(unitPrice),
      original_quantity: originalQuantity,
      received_quantity: Math.max(0, Number(inboundItem.quantity || inboundItem.received_quantity || 0)),
      pending_quantity_before: 0,
      target_quantity: 0,
      quantity_delta: -quantity,
      amount_delta: amountDelta,
      remark: `stock_return:${returnNo}`
    });
  }
  return rows;
}

function getReturnAdjustmentSummary(rows) {
  return rows.reduce((result, row) => {
    result.totalQuantityDelta += Number(row.quantity_delta || 0);
    result.totalAmountDelta = money(result.totalAmountDelta + Number(row.amount_delta || 0));
    return result;
  }, { totalQuantityDelta: 0, totalAmountDelta: 0 });
}

function canOffsetOriginalPayable(originalPayable, allocationAmount) {
  if (!originalPayable) return false;
  if (Number(allocationAmount || 0) > 0.005) return false;
  if (Number(originalPayable.paid_amount || 0) > 0.005) return false;
  return originalPayable.status !== 'paid';
}

async function ensurePurchaseReturnAccounting({ returnStock, transaction, userName = '' }) {
  const inbound = await Inbound.findByPk(returnStock.inbound_id, {
    include: [{ model: InboundItem, as: 'items' }],
    transaction
  });
  if (!inbound) throw new Error(`退库 ${returnStock.return_no} 关联入库单不存在`);

  const requestId = returnStock.purchase_request_id || inbound.purchase_request_id;
  const request = requestId
    ? await PurchaseRequest.findByPk(requestId, {
      include: [{ model: PurchaseRequestItem, as: 'items' }, { model: Supplier }],
      transaction,
      lock: transaction.LOCK.UPDATE
    })
    : null;
  if (!request) throw new Error(`退库 ${returnStock.return_no} 未关联原采购申请，无法生成采购调整`);

  const returnItems = await ReturnStockItem.findAll({
    where: { return_id: returnStock.return_id },
    transaction,
    lock: transaction.LOCK.UPDATE
  });
  if (!returnItems.length) throw new Error(`退库 ${returnStock.return_no} 没有商品明细`);

  const adjustmentRows = buildReturnAdjustmentItems({
    requestItems: request.items || [],
    inboundItems: inbound.items || [],
    returnItems,
    returnNo: returnStock.return_no
  });
  const summary = getReturnAdjustmentSummary(adjustmentRows);
  if (summary.totalQuantityDelta >= 0) throw new Error(`退库 ${returnStock.return_no} 的数量变化无效`);

  let adjustment = await PurchaseAdjustment.findOne({
    where: { adjustment_no: returnStock.return_no },
    include: [{ model: PurchaseAdjustmentItem, as: 'items' }],
    transaction,
    lock: transaction.LOCK.UPDATE
  });
  if (!adjustment) {
    const store = returnStock.store_id
      ? await Store.findByPk(returnStock.store_id, { attributes: ['region_id', 'distributor_id'], transaction })
      : null;
    adjustment = await PurchaseAdjustment.create({
      adjustment_id: generateUUID(),
      adjustment_no: returnStock.return_no,
      request_id: request.request_id,
      request_no: request.request_no,
      store_id: returnStock.store_id || request.store_id,
      distributor_id: request.distributor_id || store?.distributor_id || null,
      supplier_id: request.supplier_id,
      supplier_name: request.Supplier?.name || returnStock.supplier_name || '',
      total_quantity_delta: summary.totalQuantityDelta,
      total_amount_delta: summary.totalAmountDelta,
      reason: returnStock.reason || '',
      status: 'completed',
      create_user: returnStock.create_user || userName,
      create_time: returnStock.execute_time || returnStock.create_time || new Date()
    }, { transaction });
    for (const row of adjustmentRows) {
      await PurchaseAdjustmentItem.create({ adjustment_id: adjustment.adjustment_id, ...row }, { transaction });
    }
  } else if (String(adjustment.request_id) !== String(request.request_id)) {
    throw new Error(`退库 ${returnStock.return_no} 已关联其他采购申请，需人工核对`);
  }

  let payable = await Payable.findOne({
    where: { source_type: 'purchase_return', source_id: returnStock.return_id },
    transaction,
    lock: transaction.LOCK.UPDATE
  });
  const store = returnStock.store_id
    ? await Store.findByPk(returnStock.store_id, { attributes: ['region_id', 'distributor_id'], transaction })
    : null;
  const payableValues = {
    supplier_id: request.supplier_id,
    supplier_name: request.Supplier?.name || returnStock.supplier_name || '',
    request_id: request.request_id,
    request_no: request.request_no,
    payee_type: 'supplier',
    payee_id: request.supplier_id,
    payee_name: request.Supplier?.name || returnStock.supplier_name || '',
    source_type: 'purchase_return',
    source_id: returnStock.return_id,
    source_no: returnStock.return_no,
    region_id: store?.region_id || null,
    distributor_id: request.distributor_id || store?.distributor_id || null
  };
  if (!payable) {
    payable = await Payable.create({
      payable_id: generateUUID(),
      ...payableValues,
      total_amount: summary.totalAmountDelta,
      settled_amount: 0,
      offset_amount: 0,
      paid_amount: 0,
      status: 'credit',
      create_time: returnStock.execute_time || returnStock.create_time || new Date()
    }, { transaction });
  } else {
    const payableAllocation = (await getAllocationSummary([payable.payable_id], transaction)).get(String(payable.payable_id));
    if (Number(payableAllocation?.amount || 0) > 0.005 && Math.abs(Number(payable.total_amount || 0) - summary.totalAmountDelta) > 0.005) {
      throw new Error(`退库 ${returnStock.return_no} 的负向应付款已有结算记录，金额不能自动改写`);
    }
    await payable.update({
      ...payableValues,
      total_amount: summary.totalAmountDelta,
      status: 'credit'
    }, { transaction });
  }

  const originalPayable = await Payable.findOne({
    where: { request_id: request.request_id, source_type: 'purchase', total_amount: { [Op.gt]: 0 } },
    order: [['create_time', 'ASC']],
    transaction,
    lock: transaction.LOCK.UPDATE
  });
  const allocation = originalPayable
    ? ((await getAllocationSummary([originalPayable.payable_id], transaction)).get(String(originalPayable.payable_id)) || { amount: 0 })
    : { amount: 0 };
  let offsetAmount = Number(payable.offset_amount || 0);
  if (canOffsetOriginalPayable(originalPayable, allocation.amount) && offsetAmount <= 0.005) {
    const remaining = Math.max(0, getPayableRemaining(originalPayable.total_amount, allocation.amount, originalPayable.offset_amount));
    offsetAmount = Math.min(Math.abs(summary.totalAmountDelta), remaining);
    if (offsetAmount > 0) {
      await originalPayable.update({
        offset_amount: money(Number(originalPayable.offset_amount || 0) + offsetAmount)
      }, { transaction });
      await refreshPayableState(originalPayable.payable_id, transaction);
    }
  }
  await payable.update({
    offset_amount: money(offsetAmount),
    offset_payable_id: offsetAmount > 0 && originalPayable ? originalPayable.payable_id : payable.offset_payable_id || null,
    status: Math.abs(summary.totalAmountDelta) <= offsetAmount + 0.005 ? 'offset' : 'credit'
  }, { transaction });
  await returnStock.update({
    purchase_request_id: request.request_id,
    supplier_id: request.supplier_id,
    supplier_name: request.Supplier?.name || returnStock.supplier_name || '',
    distributor_id: request.distributor_id || store?.distributor_id || null,
    payable_id: payable.payable_id
  }, { transaction });

  return {
    adjustmentId: adjustment.adjustment_id,
    adjustmentNo: adjustment.adjustment_no,
    payableId: payable.payable_id,
    totalQuantityDelta: summary.totalQuantityDelta,
    totalAmountDelta: summary.totalAmountDelta,
    offsetAmount
  };
}

module.exports = {
  money,
  buildReturnAdjustmentItems,
  getReturnAdjustmentSummary,
  canOffsetOriginalPayable,
  ensurePurchaseReturnAccounting
};
