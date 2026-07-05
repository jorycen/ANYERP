const {
  Order,
  OrderItem,
  OrderPayment,
  OrderSupplement,
  OrderGrossProfit,
  DepositOrder,
  DepositRedemption,
  PaymentMethod,
  ProductPrice
} = require('../../models');
const { generateUUID } = require('../../utils');

const FORMULA_VERSION = 'ORDER_GP_V4_20260706';
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

function resolveUnitProductPricing(productPrice = {}, orderItem = {}) {
  const configuredPricing = toNumber(productPrice.standard_price);
  if (configuredPricing > 0) {
    return {
      unitPricing: roundMoney(configuredPricing),
      source: 'product_standard_price'
    };
  }
  return {
    unitPricing: roundMoney(
      toNumber(productPrice.cost_price) || toNumber(orderItem.original_inventory_cost)
    ),
    source: 'purchase_price_fallback'
  };
}

function calculateGrossProfitValues({
  receivableAmount = 0,
  paymentDetails = [],
  productPricingDetails = [],
  supplementDetails = [],
  invoiceAmount = 0
} = {}) {
  const basePayments = paymentDetails
    .filter(item => !isPolicySubsidyReceivable(item.method))
    .map(item => {
      const amount = roundMoney(item.amount);
      const taxRate = Math.max(0, toNumber(item.taxRate));
      return {
        ...item,
        amount,
        taxRate
      };
    });
  const normalizedReceivableAmount = roundMoney(Math.max(0, receivableAmount));
  const paymentAmountTotal = roundMoney(basePayments.reduce((sum, item) => sum + item.amount, 0));
  let allocatedReceivable = 0;
  const normalizedPayments = basePayments.map((item, index) => {
    const isLast = index === basePayments.length - 1;
    const allocation = paymentAmountTotal > 0
      ? (isLast
        ? roundMoney(normalizedReceivableAmount - allocatedReceivable)
        : roundMoney(normalizedReceivableAmount * item.amount / paymentAmountTotal))
      : 0;
    allocatedReceivable = roundMoney(allocatedReceivable + allocation);
    return {
      ...item,
      receivableAmount: allocation,
      fee: roundMoney(allocation * item.taxRate / 100)
    };
  });
  const normalizedProductPricing = productPricingDetails.map(item => ({
    ...item,
    quantity: toNumber(item.quantity || 1),
    unitPricing: roundMoney(item.unitPricing),
    pricingAmount: roundMoney(item.pricingAmount)
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

  const productPricingAmount = roundMoney(
    normalizedProductPricing.reduce((sum, item) => sum + item.pricingAmount, 0)
  );
  const paymentFeeAmount = roundMoney(normalizedPayments.reduce((sum, item) => sum + item.fee, 0));
  const normalizedInvoiceAmount = roundMoney(invoiceAmount);
  const vatTaxableAmount = roundMoney(Math.max(0, normalizedInvoiceAmount - productPricingAmount));
  const vatAmount = roundMoney(vatTaxableAmount * VAT_RATE);
  const supplementAmount = roundMoney(normalizedSupplements.reduce((sum, item) => sum + item.signedAmount, 0));
  const grossProfitAmount = roundMoney(
    normalizedReceivableAmount - productPricingAmount - paymentFeeAmount - vatAmount + supplementAmount
  );

  return {
    receivableAmount: normalizedReceivableAmount,
    productPricingAmount,
    paymentFeeAmount,
    invoiceAmount: normalizedInvoiceAmount,
    vatTaxableAmount,
    vatAmount,
    supplementAmount,
    grossProfitAmount,
    paymentDetails: normalizedPayments,
    productPricingDetails: normalizedProductPricing,
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
    receivableAmount: roundMoney(
      row.receivable_amount !== undefined ? row.receivable_amount : row.received_amount
    ),
    productPricingAmount: roundMoney(
      row.product_pricing_amount !== undefined
        ? row.product_pricing_amount
        : row.settlement_cost_amount
    ),
    paymentFeeAmount: roundMoney(row.payment_fee_amount),
    invoiceAmount: roundMoney(row.invoice_amount),
    vatTaxableAmount: roundMoney(row.vat_taxable_amount),
    vatRate: VAT_RATE,
    vatAmount: roundMoney(row.vat_amount),
    supplementAmount: roundMoney(row.supplement_amount),
    grossProfitAmount: roundMoney(row.gross_profit_amount),
    paymentDetails: parseJsonArray(row.payment_fee_details),
    productPricingDetails: parseJsonArray(
      row.product_pricing_details || row.settlement_cost_details
    ),
    supplementDetails: parseJsonArray(row.supplement_details),
    snapshotStatus: row.snapshot_status,
    calculatedBy: row.calculated_by || '',
    calculatedAt: row.calculated_at,
    formula: '用户应收 - 产品定价 - 应收税率费用 - 增值税 + 补录净额'
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

async function buildProductPricingDetails(orderId, transaction) {
  const items = await OrderItem.findAll({ where: { order_id: orderId }, transaction });
  const productIds = [...new Set(items.map(item => item.product_id).filter(Boolean))];
  const prices = productIds.length
    ? await ProductPrice.findAll({
        where: { product_id: productIds },
        transaction,
        raw: true
      })
    : [];
  const priceByProduct = new Map(prices.map(price => [String(price.product_id), price]));
  return items.map(item => {
    const row = item.toJSON();
    const productPrice = priceByProduct.get(String(row.product_id || ''));
    const { unitPricing, source } = resolveUnitProductPricing(productPrice, row);
    const quantity = Number(row.quantity || 1);
    return {
      itemId: row.item_id,
      productId: row.product_id || '',
      productName: row.product_name || '',
      pnCode: row.pn_code || '',
      snCode: row.sn_code || '',
      quantity,
      unitPricing,
      pricingAmount: roundMoney(unitPricing * quantity),
      source
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
  if (
    existing &&
    existing.snapshot_status === 'final' &&
    existing.formula_version === FORMULA_VERSION &&
    !force
  ) {
    return existing;
  }

  const [paymentDetails, productPricingDetails, supplementDetails] = await Promise.all([
    buildPaymentDetails(order, existing, transaction),
    buildProductPricingDetails(orderId, transaction),
    buildSupplementDetails(orderId, transaction)
  ]);
  const values = calculateGrossProfitValues({
    receivableAmount: Math.max(
      0,
      toNumber(order.total_amount)
        - toNumber(order.discount_amount)
        - toNumber(order.national_subsidy)
        - toNumber(order.education_subsidy)
    ),
    paymentDetails,
    productPricingDetails,
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
    receivable_amount: values.receivableAmount,
    product_pricing_amount: values.productPricingAmount,
    payment_fee_amount: values.paymentFeeAmount,
    invoice_amount: values.invoiceAmount,
    vat_taxable_amount: values.vatTaxableAmount,
    vat_amount: values.vatAmount,
    supplement_amount: values.supplementAmount,
    gross_profit_amount: values.grossProfitAmount,
    payment_fee_details: values.paymentDetails,
    product_pricing_details: values.productPricingDetails,
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
  resolveUnitProductPricing,
  calculateGrossProfitValues,
  calculateAndSaveOrderGrossProfit,
  snapshotToResponse
};
