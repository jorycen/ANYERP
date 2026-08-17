const moment = require('moment');
const {
  OrderPayment,
  PaymentMethod,
  DailyStatement,
  DailyStatementDetail,
  SalesReturnSettlement,
  SalesReturnSettlementItem,
  SalesReturnRedInvoice,
  sequelize
} = require('../../models');
const { Op } = require('sequelize');
const { generateUUID } = require('../../utils');

function money(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return String(value).split(/[,，;；]/).map(item => item.trim()).filter(Boolean);
  }
}

function selectedResources(item) {
  const values = [
    ...parseArray(item?.selected_resource_types || item?.selectedResourceTypes),
    item?.use_gov_subsidy ? 'GOV_SUBSIDY' : '',
    item?.use_edu_subsidy ? 'EDU_SUBSIDY' : ''
  ].map(value => String(value || '').trim().toUpperCase());
  return [...new Set(values.filter(Boolean))];
}

function isSubsidyEligibleItem(item) {
  const resources = selectedResources(item);
  if (resources.includes('GOV_SUBSIDY') || resources.includes('EDU_SUBSIDY')) return true;
  const text = `${item?.product_name || ''} ${item?.category || ''}`.toLowerCase();
  if (/(配件|鼠标|键盘|手柄|支架|摄像头|保护夹|保护壳|贴膜|充电器|耳机|数据线|u盘|硬盘|内存|打印机)/i.test(text)) return false;
  return /(电脑|笔记本|台式机|手机|平板|ipad|iphone|computer|laptop|tablet|phone)/i.test(text);
}

function orderReceivable(order) {
  return Math.max(0, money(Number(order?.total_amount || 0) - Number(order?.discount_amount || 0)));
}

function lineGross(item) {
  return Math.max(0, money(Number(item?.unit_price ?? item?.sale_price ?? 0) * Number(item?.quantity || 0)));
}

function chinaDate() {
  return moment().format('YYYY-MM-DD');
}

async function getOrCreateDailyStatement(storeId, transaction) {
  const [statement] = await DailyStatement.findOrCreate({
    where: { store_id: storeId, statement_date: chinaDate() },
    defaults: {
      statement_id: generateUUID(),
      store_id: storeId,
      statement_date: chinaDate(),
      total_revenue: 0,
      total_order_count: 0,
      total_settled: 0,
      status: 'pending'
    },
    transaction
  });
  return statement;
}

async function addDailyDetail({ statement, order, returnRequest, paymentMethod, paymentCode, businessType, amount, transaction }) {
  if (amount <= 0) return null;
  return DailyStatementDetail.create({
    detail_id: generateUUID(),
    statement_id: statement.statement_id,
    order_id: returnRequest.return_id,
    order_no: returnRequest.return_no,
    customer_name: order.customer_name || '',
    payment_method: paymentMethod,
    payment_code: paymentCode || paymentMethod,
    business_type: businessType,
    amount: -money(amount),
    settled: 0
  }, { transaction });
}

async function refreshDailyStatementTotals(statement, transaction) {
  const details = await DailyStatementDetail.findAll({
    where: { statement_id: statement.statement_id },
    attributes: ['order_id', 'amount'],
    transaction
  });
  const orderIds = [...new Set(details.map(detail => detail.order_id))];
  const totalRevenue = details.reduce((sum, detail) => sum + Number(detail.amount || 0), 0);
  await statement.update({
    total_revenue: money(totalRevenue),
    total_order_count: orderIds.length
  }, { transaction });
}

async function createCustomerNegativeDetails({ order, returnRequest, customerRefundAmount, transaction }) {
  if (customerRefundAmount <= 0) return [];
  const payments = await OrderPayment.findAll({ where: { order_id: order.order_id }, transaction });
  const codes = payments.map(row => row.payment_method).filter(Boolean);
  const methods = codes.length
    ? await PaymentMethod.findAll({ where: { code: { [Op.in]: codes } }, transaction })
    : [];
  const names = new Map(methods.map(row => [row.code, row.name]));
  const customerPayments = payments.filter(row => {
    const name = names.get(row.payment_method) || row.payment_method || '';
    return !String(name).includes('政策补贴应收') && String(name) !== '定金' && String(name) !== '定金抵扣';
  });
  const sourceTotal = customerPayments.reduce((sum, row) => sum + Math.max(0, Number(row.amount || 0)), 0);
  const statement = await getOrCreateDailyStatement(order.store_id, transaction);
  const details = [];
  if (!customerPayments.length || sourceTotal <= 0) {
    const detail = await addDailyDetail({
      statement,
      order,
      returnRequest,
      paymentMethod: '销售退单-客户实收',
      paymentCode: 'SALES_RETURN_CUSTOMER_RECEIPT',
      businessType: 'sales_return_customer_receipt',
      amount: customerRefundAmount,
      transaction
    });
    if (detail) details.push(detail);
  } else {
    let allocated = 0;
    for (let index = 0; index < customerPayments.length; index += 1) {
      const payment = customerPayments[index];
      const amount = index === customerPayments.length - 1
        ? money(customerRefundAmount - allocated)
        : money(customerRefundAmount * Number(payment.amount || 0) / sourceTotal);
      allocated = money(allocated + amount);
      const detail = await addDailyDetail({
        statement,
        order,
        returnRequest,
        paymentMethod: names.get(payment.payment_method) || payment.payment_method,
        paymentCode: payment.payment_method,
        businessType: 'sales_return_customer_receipt',
        amount,
        transaction
      });
      if (detail) details.push(detail);
    }
  }
  return details;
}

async function ensurePolicyNegativeDetail({ order, returnRequest, policyAmount, transaction }) {
  if (policyAmount <= 0) return null;
  const existing = await DailyStatementDetail.findAll({
    where: {
      order_id: returnRequest.return_id,
      business_type: 'national_subsidy_return'
    },
    transaction
  });
  const existingAmount = money(existing.reduce((sum, row) => sum + Math.abs(Number(row.amount || 0)), 0));
  const remaining = money(policyAmount - existingAmount);
  if (remaining <= 0) return existing[0] || null;
  const statement = await getOrCreateDailyStatement(order.store_id, transaction);
  return addDailyDetail({
    statement,
    order,
    returnRequest,
    paymentMethod: '国补POS-政策补贴应收',
    paymentCode: 'NATIONAL_SUBSIDY_POLICY_RECEIVABLE',
    businessType: 'national_subsidy_return',
    amount: remaining,
    transaction
  });
}

async function createSalesReturnSettlement({ returnRequest, order, requestItems, user, transaction }) {
  const existing = await SalesReturnSettlement.findOne({
    where: { return_id: returnRequest.return_id },
    include: [{ model: SalesReturnSettlementItem, as: 'items' }],
    transaction,
    lock: transaction?.LOCK?.UPDATE
  });
  if (existing) return existing;

  const orderItems = order.OrderItems || [];
  const orderGross = money(orderItems.reduce((sum, item) => sum + lineGross({ ...item, unit_price: item.sale_price }), 0));
  const returnGross = money(requestItems.reduce((sum, item) => sum + lineGross(item), 0));
  const returnedReceivable = orderGross > 0
    ? money(orderReceivable(order) * Math.min(1, returnGross / orderGross))
    : 0;
  const eligibleOrderGross = money(orderItems
    .filter(isSubsidyEligibleItem)
    .reduce((sum, item) => sum + lineGross({ ...item, unit_price: item.sale_price }), 0));
  const eligibleReturnGross = money(requestItems
    .filter(isSubsidyEligibleItem)
    .reduce((sum, item) => sum + lineGross(item), 0));
  const subsidyRatio = eligibleOrderGross > 0 ? Math.min(1, eligibleReturnGross / eligibleOrderGross) : 0;
  const policyAmount = money(Number(order.national_subsidy || 0) * subsidyRatio);
  const educationAmount = money(Number(order.education_subsidy || 0) * subsidyRatio);
  const customerRefundAmount = money(Math.min(
    Number(order.actual_payment || 0),
    Math.max(0, returnedReceivable - policyAmount - educationAmount)
  ));
  const settlementId = generateUUID();
  const settlement = await SalesReturnSettlement.create({
    settlement_id: settlementId,
    settlement_no: `SRS${moment().format('YYYYMMDDHHmmss')}${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
    return_id: returnRequest.return_id,
    return_no: returnRequest.return_no,
    order_id: order.order_id,
    order_no: order.order_no,
    store_id: order.store_id,
    user_receivable_amount: -returnedReceivable,
    customer_received_amount: -customerRefundAmount,
    policy_subsidy_receivable_amount: -policyAmount,
    education_subsidy_amount: -educationAmount,
    customer_refund_amount: customerRefundAmount,
    settlement_status: customerRefundAmount > 0 ? 'pending_refund' : 'offset',
    red_invoice_status: String(order.invoice_status || '') === '不开票' ? 'not_required' : 'pending',
    snapshot_json: JSON.stringify({
      formula: '用户应收=订单商品总额-普通折扣；国补/教育补贴沿用订单快照按适用商品比例分摊；15%国补后返为既有固定标准，不新增配置',
      orderReceivable: orderReceivable(order),
      orderGross,
      returnGross,
      eligibleOrderGross,
      eligibleReturnGross,
      policyAmount,
      educationAmount,
      customerRefundAmount
    }),
    create_user: user?.name || user?.staffId || 'system',
    create_time: new Date(),
    update_time: new Date()
  }, { transaction });

  let allocatedUser = 0;
  let allocatedCustomer = 0;
  let allocatedPolicy = 0;
  let allocatedEducation = 0;
  for (let index = 0; index < requestItems.length; index += 1) {
    const item = requestItems[index];
    const gross = lineGross(item);
    const isLast = index === requestItems.length - 1;
    const itemUser = isLast ? money(returnedReceivable - allocatedUser) : money(returnedReceivable * gross / Math.max(returnGross, 0.01));
    const eligibleRatio = eligibleReturnGross > 0 && isSubsidyEligibleItem(item) ? gross / eligibleReturnGross : 0;
    const itemPolicy = isLast && eligibleReturnGross > 0 ? money(policyAmount - allocatedPolicy) : money(policyAmount * eligibleRatio);
    const itemEducation = isLast && eligibleReturnGross > 0 ? money(educationAmount - allocatedEducation) : money(educationAmount * eligibleRatio);
    const itemCustomer = isLast ? money(customerRefundAmount - allocatedCustomer) : money(customerRefundAmount * Math.max(0, itemUser - itemPolicy - itemEducation) / Math.max(returnedReceivable - policyAmount - educationAmount, 0.01));
    allocatedUser = money(allocatedUser + itemUser);
    allocatedCustomer = money(allocatedCustomer + itemCustomer);
    allocatedPolicy = money(allocatedPolicy + itemPolicy);
    allocatedEducation = money(allocatedEducation + itemEducation);
    await SalesReturnSettlementItem.create({
      settlement_item_id: generateUUID(),
      settlement_id: settlementId,
      return_id: returnRequest.return_id,
      order_item_id: item.order_item_id,
      product_id: item.product_id,
      product_name: item.product_name,
      quantity: item.quantity,
      user_receivable_amount: -itemUser,
      customer_received_amount: -Math.max(0, itemCustomer),
      policy_subsidy_receivable_amount: -Math.max(0, itemPolicy),
      education_subsidy_amount: -Math.max(0, itemEducation),
      create_time: new Date()
    }, { transaction });
  }

  await createCustomerNegativeDetails({ order, returnRequest, customerRefundAmount, transaction });
  await ensurePolicyNegativeDetail({ order, returnRequest, policyAmount, transaction });
  if (educationAmount > 0) {
    const statement = await getOrCreateDailyStatement(order.store_id, transaction);
    await addDailyDetail({
      statement,
      order,
      returnRequest,
      paymentMethod: '教育补贴退回',
      paymentCode: 'EDUCATION_SUBSIDY_RETURN',
      businessType: 'education_subsidy_return',
      amount: educationAmount,
      transaction
    });
  }
  if (settlement.red_invoice_status === 'pending') {
    const redInvoice = await SalesReturnRedInvoice.create({
      red_invoice_id: generateUUID(),
      return_id: returnRequest.return_id,
      settlement_id: settlementId,
      order_id: order.order_id,
      order_no: order.order_no,
      amount: returnedReceivable,
      status: 'pending',
      create_user: user?.name || user?.staffId || 'system',
      create_time: new Date()
    }, { transaction });
    await settlement.update({ red_invoice_id: redInvoice.red_invoice_id }, { transaction });
  }
  await refreshDailyStatementTotals(await getOrCreateDailyStatement(order.store_id, transaction), transaction);
  return settlement;
}

module.exports = {
  createSalesReturnSettlement,
  isSubsidyEligibleItem,
  orderReceivable
};
