const { Op } = require('sequelize');
const {
  sequelize, Staff, Order, OrderItem, OrderGrossProfit, Product, ProductCategory,
  StaffCareCreditTransaction, ResourceRightChangeOrder, PerformanceProfitAdjustment
} = require('../../models');
const { generateUUID } = require('../../utils');
const { distributorWhere, canAccessDistributor } = require('../../utils/distributorScope');

const SALES_REPORT_CREDIT = 160;
const SALE_REPORT_SOURCE = 'SALE_REPORT_APPROVAL';
const CARE_ORDER_SOURCE = 'CARE_ORDER';

function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function isCareProduct(detail = {}) {
  const path = String(detail.categoryPath || detail.category_path_legacy || '').trim();
  const parts = path.split(/[\\/]/).map(part => part.trim().toLowerCase());
  return parts[0] === '售后' && parts[1] === 'care服务';
}

function parseDetails(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) { return []; }
}

async function careCostDetails(snapshot, transaction = null) {
  const details = parseDetails(snapshot?.product_pricing_details);
  const productIds = [...new Set(details.map(detail => detail.productId).filter(Boolean))];
  if (!productIds.length) return details.filter(isCareProduct);
  const [products, categories] = await Promise.all([
    Product.findAll({ where: { product_id: { [Op.in]: productIds } },
      attributes: ['product_id', 'category_id', 'category_path_legacy'], transaction, raw: true }),
    ProductCategory.findAll({ attributes: ['category_id', 'parent_id', 'name'], transaction, raw: true })
  ]);
  const productsById = new Map(products.map(product => [String(product.product_id), product]));
  const categoryById = new Map(categories.map(category => [String(category.category_id), category]));
  const careCategoryIds = new Set(categories.filter(category => {
    const parent = categoryById.get(String(category.parent_id || ''));
    return String(category.name || '').trim().toLowerCase() === 'care服务'
      && String(parent?.name || '').trim() === '售后';
  }).map(category => String(category.category_id)));
  function belongsToCareCategory(categoryId) {
    const visited = new Set();
    let currentId = String(categoryId || '');
    while (currentId && !visited.has(currentId)) {
      if (careCategoryIds.has(currentId)) return true;
      visited.add(currentId);
      currentId = String(categoryById.get(currentId)?.parent_id || '');
    }
    return false;
  }
  return details.filter(detail => {
    const product = productsById.get(String(detail.productId || ''));
    if (product?.category_id && categoryById.has(String(product.category_id))) {
      return belongsToCareCategory(product.category_id);
    }
    return isCareProduct(product || detail);
  });
}

async function lockStaff(staffId, transaction) {
  const staff = await Staff.findByPk(staffId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!staff || Number(staff.is_deleted || 0) === 1) {
    throw Object.assign(new Error('销售员账户不存在'), { status: 409 });
  }
  return staff;
}

function walletTotalsFromRows(rows) {
  const earned = money(rows.filter(row => row.type === 'income' && row.status === 'active')
    .reduce((sum, row) => sum + Number(row.amount || 0), 0));
  const spent = money(rows.filter(row => row.type === 'expense' && row.status === 'active')
    .reduce((sum, row) => sum + Number(row.amount || 0), 0));
  const reserved = money(rows.filter(row => row.type === 'expense' && row.status === 'reserved')
    .reduce((sum, row) => sum + Number(row.amount || 0), 0));
  return {
    earned, spent, reserved,
    available: money(Math.max(0, earned - spent - reserved)),
    recoveryDue: money(Math.max(0, spent + reserved - earned))
  };
}

async function walletTotals(staffId, transaction = null) {
  const rows = await StaffCareCreditTransaction.findAll({
    where: { staff_id: staffId, status: { [Op.in]: ['active', 'reserved'] } },
    attributes: ['type', 'amount', 'status'], transaction, raw: true
  });
  return walletTotalsFromRows(rows);
}

async function createCreditEntry({ staffId, staffName, type, amount, sourceType, sourceId,
  order, item = null, resourceType = null, remark, transaction }) {
  const existing = await StaffCareCreditTransaction.findOne({
    where: { source_type: sourceType, source_id: sourceId }, transaction
  });
  if (existing) return existing;
  const totals = await walletTotals(staffId, transaction);
  const signedAmount = type === 'income' ? amount : -amount;
  return StaffCareCreditTransaction.create({
    transaction_id: generateUUID(), staff_id: staffId, staff_name: staffName,
    type, amount, balance_after: money(totals.earned - totals.spent - totals.reserved + signedAmount),
    source_type: sourceType, source_id: sourceId,
    order_id: order?.order_id || null, order_no: order?.order_no || null,
    order_item_id: item?.item_id || null, sn_id: item?.sn_id || null,
    sn_code: item?.sn_code || null, product_id: item?.product_id || null,
    resource_type: resourceType, status: 'active', remark
  }, { transaction });
}

async function creditSalesReport({ task, order, item, transaction }) {
  const selected = parseDetails(item?.selected_resource_types);
  if (!item || (!Number(item.use_sales_report || 0) && !selected.includes('SALES_REPORT'))
    || String(item.sn_id || '') !== String(task.sn_id || '')) {
    throw Object.assign(new Error('销售报号任务未关联具备资格的订单商品'), { status: 409 });
  }
  const staffId = Number(order.create_staff_id || 0);
  if (!staffId) throw Object.assign(new Error('订单缺少销售员ID，无法发放奖励'), { status: 409 });
  const staff = await lockStaff(staffId, transaction);
  return createCreditEntry({
    staffId, staffName: order.create_user || staff.name, type: 'income', amount: SALES_REPORT_CREDIT,
    sourceType: SALE_REPORT_SOURCE, sourceId: task.change_id,
    order, item, resourceType: 'SALES_REPORT',
    remark: `销售报号图片审核通过，奖励${SALES_REPORT_CREDIT}元`, transaction
  });
}

async function orderCareQuote(order, transaction = null) {
  const snapshot = await OrderGrossProfit.findOne({ where: { order_id: order.order_id }, transaction });
  const details = await careCostDetails(snapshot, transaction);
  return {
    careCost: money(details.reduce((sum, row) => sum + Number(row.pricingAmount || 0), 0)),
    careItems: details.map(row => ({ itemId: row.itemId, productName: row.productName,
      quantity: row.quantity, cost: money(row.pricingAmount) }))
  };
}

function assertOwnOrder(ctx, order) {
  if (!order) ctx.throw(404, '销售订单不存在');
  if (String(order.create_staff_id || '') !== String(ctx.state.user?.staffId || '')) {
    ctx.throw(403, '仅订单销售员可使用本人CARE可用金');
  }
}

async function getMyCareCredit(ctx) {
  const staffId = Number(ctx.state.user?.staffId || 0);
  if (!staffId) ctx.throw(401, '请先登录员工账号');
  ctx.body = await readCareWallet(staffId, ctx.query?.page);
}

async function readCareWallet(staffId, requestedPage = 1) {
  const page = Math.max(1, Math.min(10000, Number.parseInt(requestedPage, 10) || 1));
  const pageSize = 50;
  const [totals, rows] = await Promise.all([
    walletTotals(staffId),
    StaffCareCreditTransaction.findAll({ where: { staff_id: staffId },
      order: [['create_time', 'DESC'], ['transaction_id', 'DESC']],
      limit: pageSize + 1, offset: (page - 1) * pageSize })
  ]);
  return { ...totals, page, hasMore: rows.length > pageSize,
    transactions: rows.slice(0, pageSize) };
}

async function findAccessibleStaff(ctx, staffId) {
  const staff = await Staff.findByPk(staffId);
  if (!staff || Number(staff.is_deleted || 0) === 1) ctx.throw(404, '员工不存在');
  if (!canAccessDistributor(ctx.state.user || {}, staff.distributor_id)) ctx.throw(403, '无权查看该员工账户');
  return staff;
}

async function listStaffCareCredit(ctx) {
  const staff = await Staff.findAll({ where: { ...distributorWhere(ctx.state.user || {}), is_deleted: 0 },
    attributes: ['staff_id', 'name', 'store_id'], order: [['name', 'ASC']], raw: true });
  const ids = staff.map(row => row.staff_id);
  const entries = ids.length ? await StaffCareCreditTransaction.findAll({
    where: { staff_id: { [Op.in]: ids }, status: { [Op.in]: ['active', 'reserved'] } },
    attributes: ['staff_id', 'type', 'amount', 'status'], raw: true
  }) : [];
  const byStaff = new Map();
  for (const entry of entries) {
    const key = String(entry.staff_id);
    if (!byStaff.has(key)) byStaff.set(key, []);
    byStaff.get(key).push(entry);
  }
  ctx.body = staff.map(row => ({ staffId: row.staff_id, name: row.name,
    storeId: row.store_id, ...walletTotalsFromRows(byStaff.get(String(row.staff_id)) || []) }));
}

async function getStaffCareCredit(ctx) {
  const staff = await findAccessibleStaff(ctx, ctx.params.staffId);
  ctx.body = { staffId: staff.staff_id, name: staff.name,
    ...await readCareWallet(staff.staff_id, ctx.query?.page) };
}

async function adjustStaffCareCredit(ctx) {
  const amount = Number(ctx.request.body?.amount);
  const reason = String(ctx.request.body?.reason || '').trim();
  const operationId = String(ctx.request.body?.operationId || '').trim();
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1000000
    || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001) ctx.throw(400, '调整金额须为非零金额，最多两位小数，且单次不超过100万元');
  if (reason.length < 2 || reason.length > 200) ctx.throw(400, '请填写2至200字的调整原因');
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(operationId)) ctx.throw(400, '金额调整请求编号无效');
  const staff = await findAccessibleStaff(ctx, ctx.params.staffId);
  const record = await sequelize.transaction(async transaction => {
    await lockStaff(staff.staff_id, transaction);
    const sourceId = `${staff.staff_id}:${operationId}`;
    const existing = await StaffCareCreditTransaction.findOne({
      where: { source_type: 'MANUAL_ADJUST', source_id: sourceId }, transaction
    });
    if (existing && (existing.type !== (amount > 0 ? 'income' : 'expense')
      || money(existing.amount) !== money(Math.abs(amount)))) ctx.throw(409, '该调整请求编号已用于不同金额');
    if (existing) return existing;
    return createCreditEntry({ staffId: staff.staff_id, staffName: staff.name,
      type: amount > 0 ? 'income' : 'expense', amount: money(Math.abs(amount)),
      sourceType: 'MANUAL_ADJUST', sourceId,
      remark: `管理员${ctx.state.user.name || ctx.state.user.staffId}（ID:${ctx.state.user.staffId}）调整：${reason}`,
      transaction });
  });
  ctx.body = { transactionId: record.transaction_id, ...await readCareWallet(staff.staff_id) };
}

async function getOrderCareCredit(ctx) {
  const order = await Order.findByPk(ctx.params.orderId);
  assertOwnOrder(ctx, order);
  const [quote, totals, applied] = await Promise.all([
    orderCareQuote(order), walletTotals(order.create_staff_id),
    StaffCareCreditTransaction.findOne({ where: { source_type: CARE_ORDER_SOURCE, source_id: order.order_id } })
  ]);
  const appliedAmount = ['reserved', 'active'].includes(applied?.status) ? money(applied.amount) : 0;
  ctx.body = { orderId: order.order_id, orderStatus: order.order_status, ...quote,
    ...totals, appliedAmount, careCostAfterCredit: money(Math.max(0, quote.careCost - appliedAmount)),
    appliedStatus: applied?.status || '' };
}

async function reserveOrderCareCredit(ctx) {
  const amount = money(ctx.request.body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) ctx.throw(400, '抵扣金额必须大于0');
  const result = await sequelize.transaction(async transaction => {
    const order = await Order.findByPk(ctx.params.orderId, { transaction, lock: transaction.LOCK.UPDATE });
    assertOwnOrder(ctx, order);
    if (order.order_status !== '未归档') ctx.throw(409, '仅未归档订单可申请CARE成本抵扣');
    await lockStaff(order.create_staff_id, transaction);
    const quote = await orderCareQuote(order, transaction);
    if (quote.careCost <= 0) ctx.throw(409, '订单没有可抵扣成本的CARE延保商品');
    if (amount > quote.careCost) ctx.throw(400, '抵扣金额不能超过CARE商品成本');
    const existing = await StaffCareCreditTransaction.findOne({
      where: { source_type: CARE_ORDER_SOURCE, source_id: order.order_id },
      transaction, lock: transaction.LOCK.UPDATE
    });
    if (existing && existing.status === 'active') ctx.throw(409, '该订单CARE抵扣已入账');
    const totals = await walletTotals(order.create_staff_id, transaction);
    const usable = money(totals.available + (existing?.status === 'reserved' ? Number(existing.amount || 0) : 0));
    if (amount > usable) ctx.throw(409, `CARE可用金不足，当前可用${usable.toFixed(2)}元`);
    const balanceAfter = money(totals.earned - totals.spent - totals.reserved
      + (existing?.status === 'reserved' ? Number(existing.amount || 0) : 0) - amount);
    if (existing) await existing.update({ amount, status: 'reserved', balance_after: balanceAfter,
      remark: `订单${order.order_no} CARE延保成本待抵扣` }, { transaction });
    else await StaffCareCreditTransaction.create({
      transaction_id: generateUUID(), staff_id: order.create_staff_id,
      staff_name: order.create_user || ctx.state.user.name || '', type: 'expense', amount,
      balance_after: balanceAfter, source_type: CARE_ORDER_SOURCE, source_id: order.order_id,
      order_id: order.order_id, order_no: order.order_no, status: 'reserved',
      remark: `订单${order.order_no} CARE延保成本待抵扣`
    }, { transaction });
    return { reservedAmount: amount, careCost: quote.careCost, available: money(usable - amount) };
  });
  ctx.body = result;
}

async function releaseOrderCareCredit(orderId, transaction) {
  const record = await StaffCareCreditTransaction.findOne({
    where: { source_type: CARE_ORDER_SOURCE, source_id: orderId }, transaction,
    lock: transaction.LOCK.UPDATE
  });
  if (record?.status === 'reserved') await record.update({ status: 'cancelled', remark: 'CARE订单未归档，已释放抵扣额度' }, { transaction });
}

async function cancelOrderCareCredit(ctx) {
  await sequelize.transaction(async transaction => {
    const order = await Order.findByPk(ctx.params.orderId, { transaction, lock: transaction.LOCK.UPDATE });
    assertOwnOrder(ctx, order);
    if (order.order_status !== '未归档') ctx.throw(409, '仅未归档订单可撤销CARE抵扣');
    await lockStaff(order.create_staff_id, transaction);
    await releaseOrderCareCredit(order.order_id, transaction);
  });
  ctx.body = { message: 'CARE抵扣额度已释放' };
}

async function activateOrderCareCredit(order, transaction) {
  const record = await StaffCareCreditTransaction.findOne({
    where: { source_type: CARE_ORDER_SOURCE, source_id: order.order_id }, transaction,
    lock: transaction.LOCK.UPDATE
  });
  if (record?.status !== 'reserved') return;
  const quote = await orderCareQuote(order, transaction);
  if (money(record.amount) > quote.careCost) {
    throw Object.assign(new Error('CARE商品成本已变化，请重新设置可用金抵扣'), { status: 409 });
  }
  const adjustmentNo = `AUTO-CARE-${order.order_id}`;
  await PerformanceProfitAdjustment.findOrCreate({
    where: { adjustment_no: adjustmentNo },
    defaults: {
      adjustment_id: generateUUID(), adjustment_no: adjustmentNo,
      order_id: order.order_id, order_no: order.order_no, store_id: order.store_id,
      employee_name: order.create_user || record.staff_name,
      adjustment_type: 'increase', amount: money(record.amount), signed_amount: money(record.amount),
      base_gross_profit: 0, reason: '个人CARE可用金抵扣本单延保成本', status: 'approved',
      applicant_staff_id: 0, applicant_name: 'system', finance_reviewer_id: 0,
      finance_reviewer_name: 'system', finance_review_time: new Date(),
      admin_reviewer_id: 0, admin_reviewer_name: 'system', admin_review_time: new Date(),
      create_time: new Date(), update_time: new Date()
    }, transaction
  });
  await record.update({ status: 'active', remark: `订单${order.order_no} CARE延保成本已抵扣` }, { transaction });
}

async function reverseForSalesReturn({ request, order, requestItems, orderItemMap, transaction }) {
  const staffId = Number(order.create_staff_id || 0);
  if (!staffId) return;
  const staff = await lockStaff(staffId, transaction);
  for (const requestItem of requestItems) {
    const sourceItem = orderItemMap.get(String(requestItem.order_item_id || ''));
    if (!sourceItem) continue;
    await ResourceRightChangeOrder.update({ approval_status: 'cancelled', remark: `退货单${request.return_no}已取消报号任务` }, {
      where: { related_sale_order_id: order.order_id, sn_id: sourceItem.sn_id,
        resource_type: 'SALES_REPORT', change_reason: 'SALE_RESOURCE_TASK',
        approval_status: { [Op.in]: ['pending_submit', 'pending_manager_review', 'rejected'] } }, transaction
    });
    const credit = await StaffCareCreditTransaction.findOne({
      where: { order_item_id: sourceItem.item_id, source_type: SALE_REPORT_SOURCE, status: 'active' }, transaction
    });
    if (!credit) continue;
    const alreadyReversed = await StaffCareCreditTransaction.findOne({
      where: { order_item_id: sourceItem.item_id, source_type: 'SALE_REPORT_RETURN', status: 'active' }, transaction
    });
    if (alreadyReversed) continue;
    await createCreditEntry({ staffId, staffName: order.create_user || staff.name,
      type: 'expense', amount: money(credit.amount), sourceType: 'SALE_REPORT_RETURN',
      sourceId: `${request.return_id}:${sourceItem.item_id}`, order, item: sourceItem,
      resourceType: 'SALES_REPORT', remark: `销售退货${request.return_no}冲回报号奖励`, transaction });
  }

  const used = await StaffCareCreditTransaction.findOne({
    where: { source_type: CARE_ORDER_SOURCE, source_id: order.order_id, status: 'active' }, transaction
  });
  if (!used) return;
  const snapshot = await OrderGrossProfit.findOne({ where: { order_id: order.order_id }, transaction });
  const details = await careCostDetails(snapshot, transaction);
  const totalCost = money(details.reduce((sum, detail) => sum + Number(detail.pricingAmount || 0), 0));
  const returnedCost = money(requestItems.reduce((sum, requestItem) => {
    const detail = details.find(row => String(row.itemId) === String(requestItem.order_item_id));
    return sum + (detail ? Number(detail.unitPricing || 0) * Number(requestItem.quantity || 0) : 0);
  }, 0));
  if (totalCost <= 0 || returnedCost <= 0) return;
  const priorRefunds = await StaffCareCreditTransaction.sum('amount', {
    where: { source_type: 'CARE_ORDER_RETURN', order_id: order.order_id, status: 'active' }, transaction
  });
  const refund = money(Math.min(Number(used.amount || 0) - Number(priorRefunds || 0),
    Number(used.amount || 0) * returnedCost / totalCost));
  if (refund <= 0) return;
  await createCreditEntry({ staffId, staffName: order.create_user || staff.name,
    type: 'income', amount: refund, sourceType: 'CARE_ORDER_RETURN', sourceId: request.return_id,
    order, remark: `销售退货${request.return_no}返还CARE抵扣`, transaction });
  const adjustmentNo = `AUTO-CARE-RET-${request.return_id}`;
  await PerformanceProfitAdjustment.findOrCreate({
    where: { adjustment_no: adjustmentNo },
    defaults: {
      adjustment_id: generateUUID(), adjustment_no: adjustmentNo,
      order_id: order.order_id, order_no: order.order_no, store_id: order.store_id,
      employee_name: order.create_user || staff.name,
      adjustment_type: 'decrease', amount: refund, signed_amount: -refund,
      base_gross_profit: 0, reason: `销售退货${request.return_no}返还个人CARE抵扣`, status: 'approved',
      applicant_staff_id: 0, applicant_name: 'system', finance_reviewer_id: 0,
      finance_reviewer_name: 'system', finance_review_time: new Date(),
      admin_reviewer_id: 0, admin_reviewer_name: 'system', admin_review_time: new Date(),
      create_time: new Date(), update_time: new Date()
    }, transaction
  });
}

module.exports = {
  SALES_REPORT_CREDIT, isCareProduct, walletTotals, creditSalesReport,
  getMyCareCredit, listStaffCareCredit, getStaffCareCredit, adjustStaffCareCredit,
  getOrderCareCredit, reserveOrderCareCredit, cancelOrderCareCredit,
  activateOrderCareCredit, releaseOrderCareCredit, reverseForSalesReturn,
  _test: { careCostDetails, money }
};
