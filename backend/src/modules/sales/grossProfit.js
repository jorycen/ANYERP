const {
  Order,
  OrderItem,
  OrderPayment,
  OrderSupplement,
  OrderGrossProfit,
  DepositOrder,
  DepositRedemption,
  PaymentMethod
} = require('../../models');
const { generateUUID } = require('../../utils');
const { loadLegacyCostMaps, calculateItemBaseProfit } = require('../report/profitCalculation');

const FORMULA_VERSION = 'ORDER_GP_V2_20260705';
const VAT_RATE = 0.13;

function toNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function roundMoney(value) {
  return Math.round((toNumber(value) + Number.EPSILON) * 100) / 100;
}

function normalizeMethodName(value) {
  return String(value || '')
    .replace(/-(客户实收|政策补贴应收)$/, '')
    .trim();
}

function isPolicySubsidyReceivable(value) {
  return String(value || '').includes('政策补贴应收');
}

function normalizeAmountType(value) {
  return value === 'decrease' ? 'decrease' : 'increase';
}

function calculateGrossProfitValues({
  paymentDetails = [],
  settlementCostDetails = [],
  supplementDetails = [],
  invoiceAmount = 0
} = {}) {
  const normalizedPayments = paymentDetails
    .filter(item => !isPolicySubsidyReceivable(item.method))
    .map(item => {
      const amount = roundMoney(item.amount);
      const taxRate = Math.max(0, toNumber(item.taxRate));
      return {
        ...item,
        amount,
        taxRate,
        fee: roundMoney(amount * taxRate / 100)
      };
    });
  const normalizedCosts = settlementCostDetails.map(item => ({
    ...item,
    quantity: toNumber(item.quantity || 1),
    unitCost: roundMoney(item.unitCost),
    costAmount: roundMoney(item.costAmount)
  }));
  const normalizedSupplements = supplementDetails.map(item => {
    const amount = roundMoney(Math.abs(toNumber(item.amount)));
    const amountType = normalizeAmountType(item.amountType);
    return {
      ...item,
      amount,
      amountType,
      signedAmount: amountType === 'decrease' ? -amount : amount
    };
  });

  const receivedAmount = roundMoney(normalizedPayments.reduce((sum, item) => sum + item.amount, 0));
  const settlementCostAmount = roundMoney(normalizedCosts.reduce((sum, item) => sum + item.costAmount, 0));
  const paymentFeeAmount = roundMoney(normalizedPayments.reduce((sum, item) => sum + item.fee, 0));
  const normalizedInvoiceAmount = roundMoney(invoiceAmount);
  const vatTaxableAmount = roundMoney(Math.max(0, normalizedInvoiceAmount - settlementCostAmount));
  const vatAmount = roundMoney(vatTaxableAmount * VAT_RATE);
  const supplementAmount = roundMoney(normalizedSupplements.reduce((sum, item) => sum + item.signedAmount, 0));
  const grossProfitAmount = roundMoney(
    receivedAmount - settlementCostAmount - paymentFeeAmount - vatAmount + supplementAmount
  );

  return {
    receivedAmount,
    settlementCostAmount,
    paymentFeeAmount,
    invoiceAmount: normalizedInvoiceAmount,
    vatTaxableAmount,
    vatAmount,
    supplementAmount,
    grossProfitAmount,
    paymentDetails: normalizedPayments,
    settlementCostDetails: normalizedCosts,
    supplementDetails: normalizedSupplements
  };
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function snapshotToResponse(snapshot) {
  const row = snapshot && typeof snapshot.toJSON === 'function' ? snapshot.toJSON() : (snapshot || {});
  return {
    grossProfitId: row.gross_profit_id,
    orderId: row.order_id,
    orderNo: row.order_no,
    storeId: row.store_id,
    formulaVersion: row.formula_version,
    receivedAmount: roundMoney(row.received_amount),
    settlementCostAmount: roundMoney(row.settlement_cost_amount),
    paymentFeeAmount: roundMoney(row.payment_fee_amount),
    invoiceAmount: roundMoney(row.invoice_amount),
    vatTaxableAmount: roundMoney(row.vat_taxable_amount),
    vatRate: VAT_RATE,
    vatAmount: roundMoney(row.vat_amount),
    supplementAmount: roundMoney(row.supplement_amount),
    grossProfitAmount: roundMoney(row.gross_profit_amount),
    paymentDetails: parseJsonArray(row.payment_fee_details),
    settlementCostDetails: parseJsonArray(row.settlement_cost_details),
    supplementDetails: parseJsonArray(row.supplement_details),
    snapshotStatus: row.snapshot_status,
    calculatedBy: row.calculated_by || '',
    calculatedAt: row.calculated_at,
    formula: '用户实收 - 销售结算成本 - 收款税率费用 - 增值税 + 补录净额'
  };
}

async function buildPaymentDetails(order, existingSnapshot, transaction) {
  const [payments, redemptions, methods] = await Promise.all([
    OrderPayment.findAll({ where: { order_id: order.order_id }, transaction, raw: true }),
    DepositRedemption.findAll({
      where: { order_id: order.order_id },
      include: [{ model: DepositOrder, attributes: ['deposit_id', 'deposit_no', 'payment_method'] }],
      transaction
    }),
    PaymentMethod.findAll({ transaction, raw: true })
  ]);

  const taxRateByMethod = new Map();
  methods.forEach(method => {
    const rate = toNumber(method.default_tax_rate);
    taxRateByMethod.set(normalizeMethodName(method.name), rate);
    taxRateByMethod.set(normalizeMethodName(method.code), rate);
  });

  // 已封存订单重算其他组成项时继续沿用原收款税率快照。
  if (existingSnapshot?.snapshot_status === 'final') {
    parseJsonArray(existingSnapshot.payment_fee_details).forEach(detail => {
      taxRateByMethod.set(normalizeMethodName(detail.method), toNumber(detail.taxRate));
    });
  }

  const details = payments
    .filter(payment => !isPolicySubsidyReceivable(payment.payment_method))
    .map(payment => ({
      source: 'order_payment',
      paymentId: payment.payment_id,
      method: payment.payment_method,
      amount: roundMoney(payment.amount),
      taxRate: taxRateByMethod.get(normalizeMethodName(payment.payment_method)) || 0
    }));

  redemptions
    .filter(redemption => String(redemption.status || '') !== 'voided')
    .forEach(redemption => {
      const row = redemption.toJSON();
      const deposit = row.DepositOrder || {};
      const method = deposit.payment_method || '定金抵扣';
      details.push({
        source: 'deposit',
        paymentId: row.redemption_id,
        depositId: row.deposit_id,
        depositNo: deposit.deposit_no || '',
        method,
        amount: roundMoney(row.amount),
        taxRate: taxRateByMethod.get(normalizeMethodName(method)) || 0
      });
    });

  return details;
}

async function buildSettlementCostDetails(orderId, transaction) {
  const items = await OrderItem.findAll({ where: { order_id: orderId }, transaction });
  const legacyMaps = await loadLegacyCostMaps(items);
  return items.map(item => {
    const row = item.toJSON();
    const calculation = calculateItemBaseProfit(row, legacyMaps);
    return {
      itemId: row.item_id,
      productId: row.product_id || '',
      productName: row.product_name || '',
      pnCode: row.pn_code || '',
      snCode: row.sn_code || '',
      quantity: Number(row.quantity || 1),
      unitCost: calculation.unitCost,
      costAmount: calculation.costAmount,
      source: calculation.source
    };
  });
}

async function buildSupplementDetails(orderId, transaction) {
  const rows = await OrderSupplement.findAll({
    where: { order_id: orderId, is_deleted: 0 },
    order: [['create_time', 'ASC'], ['supplement_id', 'ASC']],
    transaction,
    raw: true
  });
  return rows.map(row => ({
    supplementId: row.supplement_id,
    itemId: row.item_id || '',
    itemName: row.item_name,
    amount: roundMoney(row.amount),
    amountType: normalizeAmountType(row.amount_type),
    content: row.content || ''
  }));
}

async function calculateAndSaveOrderGrossProfit(orderId, {
  transaction = null,
  calculatedBy = 'system',
  force = false,
  final = null
} = {}) {
  const order = await Order.findByPk(orderId, { transaction });
  if (!order) {
    const error = new Error('订单不存在');
    error.status = 404;
    throw error;
  }

  const existing = await OrderGrossProfit.findOne({ where: { order_id: orderId }, transaction });
  if (existing && existing.snapshot_status === 'final' && !force) {
    return existing;
  }

  const [paymentDetails, settlementCostDetails, supplementDetails] = await Promise.all([
    buildPaymentDetails(order, existing, transaction),
    buildSettlementCostDetails(orderId, transaction),
    buildSupplementDetails(orderId, transaction)
  ]);
  const values = calculateGrossProfitValues({
    paymentDetails,
    settlementCostDetails,
    supplementDetails,
    invoiceAmount: order.invoice_amount
  });
  const archived = final === null
    ? ['已归档', 'completed', 'archived'].includes(String(order.order_status || ''))
    : !!final;
  const payload = {
    order_id: order.order_id,
    order_no: order.order_no,
    store_id: order.store_id,
    formula_version: FORMULA_VERSION,
    received_amount: values.receivedAmount,
    settlement_cost_amount: values.settlementCostAmount,
    payment_fee_amount: values.paymentFeeAmount,
    invoice_amount: values.invoiceAmount,
    vat_taxable_amount: values.vatTaxableAmount,
    vat_amount: values.vatAmount,
    supplement_amount: values.supplementAmount,
    gross_profit_amount: values.grossProfitAmount,
    payment_fee_details: values.paymentDetails,
    settlement_cost_details: values.settlementCostDetails,
    supplement_details: values.supplementDetails,
    snapshot_status: archived ? 'final' : 'draft',
    calculated_by: calculatedBy || 'system',
    calculated_at: new Date(),
    update_time: new Date()
  };

  if (existing) {
    await existing.update(payload, { transaction });
    return existing;
  }
  return OrderGrossProfit.create({
    gross_profit_id: generateUUID(),
    create_time: new Date(),
    ...payload
  }, { transaction });
}

module.exports = {
  FORMULA_VERSION,
  VAT_RATE,
  roundMoney,
  normalizeMethodName,
  isPolicySubsidyReceivable,
  calculateGrossProfitValues,
  calculateAndSaveOrderGrossProfit,
  snapshotToResponse
};
