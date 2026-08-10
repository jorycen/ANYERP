const {
  Order,
  OrderItem,
  OrderPayment,
  OrderSupplement,
  OrderGrossProfit,
  DepositOrder,
  DepositRedemption,
  PaymentMethod,
  ProductPrice,
  Product,
  ProductSn,
  Supplier,
  FreightRecordItem,
  sequelize
} = require('../../models');
const { Op, QueryTypes } = require('sequelize');
const { generateUUID } = require('../../utils');

const FORMULA_VERSION = 'ORDER_GP_V8_20260810_FREIGHT';
const VAT_RATE = 0.13;
const NATIONAL_SUBSIDY_RECEIPT_TAX_RATE = 0.006;

function toNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function roundMoney(value) {
  return Math.round((toNumber(value) + Number.EPSILON) * 100) / 100;
}

function isExternalAdjustmentEligibleProduct({
  category = '',
  productName = '',
  accessoryType = '',
  isServiceProvider = true
} = {}) {
  if (isServiceProvider) return false;
  const text = `${category} ${productName} ${accessoryType}`.toLowerCase();
  if (/配件|维修|服务|安装|保养|耗材/.test(text)) return false;
  return /电脑|笔记本|台式机|一体机|主机|平板|ipad|手机|iphone/.test(text);
}

function calculateNationalSubsidyCustomerReceiptAmount({
  nationalAmount = 0,
  subsidyAmount = 0,
  nationalSubsidyAmount = 0
} = {}) {
  const totalNationalAmount = Math.max(0, toNumber(nationalAmount));
  const receivableSubsidyAmount = Math.max(0, toNumber(subsidyAmount));
  const configuredNationalSubsidy = Math.max(0, toNumber(nationalSubsidyAmount));
  const taxBase = Math.max(0, totalNationalAmount - configuredNationalSubsidy);
  return roundMoney(
    totalNationalAmount
      - receivableSubsidyAmount
      - taxBase * NATIONAL_SUBSIDY_RECEIPT_TAX_RATE
  );
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

function calculateOrderReceivable(order = {}) {
  return roundMoney(Math.max(
    0,
    toNumber(order.total_amount) - toNumber(order.discount_amount)
  ));
}

function resolveUnitProductPricing(productPrice = {}, orderItem = {}, supplier = null) {
  const configuredPricing = toNumber(productPrice.standard_price);
  const isServiceProvider = !supplier || Number(supplier.is_service_provider) !== 0;
  const sourcePurchasePrice = toNumber(orderItem.purchasePrice) ||
    toNumber(orderItem.original_pickup_price) ||
    toNumber(orderItem.original_inventory_cost);
  const purchasePrice = sourcePurchasePrice || toNumber(productPrice.cost_price);
  const result = (unitPricing, source) => supplier
    ? {
        unitPricing: roundMoney(unitPricing),
        source,
        purchasePrice: roundMoney(purchasePrice),
        isServiceProvider
      }
    : { unitPricing: roundMoney(unitPricing), source };

  if (isServiceProvider && configuredPricing > 0) {
    return result(configuredPricing, 'product_standard_price');
  }

  if (!isServiceProvider && purchasePrice > 0) {
    return result(purchasePrice, 'purchase_price');
  }

  if (isServiceProvider && toNumber(productPrice.cost_price) > 0) {
    return result(toNumber(productPrice.cost_price), 'product_cost_fallback');
  }

  return result(configuredPricing || purchasePrice, isServiceProvider ? 'product_standard_price_fallback' : 'purchase_price_fallback');
}

function calculateGrossProfitValues({
  receivableAmount = 0,
  paymentDetails = [],
  productPricingDetails = [],
  supplementDetails = [],
  invoiceAmount = 0,
  externalAdjustmentEligible = false
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
  const grossProfitBeforeExternalAdjustment = roundMoney(
    normalizedReceivableAmount - productPricingAmount - paymentFeeAmount - vatAmount + supplementAmount
  );
  const externalAdjustmentFee = externalAdjustmentEligible && grossProfitBeforeExternalAdjustment > 500 ? 200 : 0;
  const grossProfitAmount = roundMoney(grossProfitBeforeExternalAdjustment - externalAdjustmentFee);

  return {
    receivableAmount: normalizedReceivableAmount,
    productPricingAmount,
    paymentFeeAmount,
    invoiceAmount: normalizedInvoiceAmount,
    vatTaxableAmount,
    vatAmount,
    supplementAmount,
    grossProfitBeforeExternalAdjustment,
    externalAdjustmentEligible: !!externalAdjustmentEligible,
    externalAdjustmentFee,
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

function snapshotToResponse(snapshot, order = null) {
  const row = snapshot && typeof snapshot.toJSON === 'function' ? snapshot.toJSON() : (snapshot || {});
  const orderRow = order && typeof order.toJSON === 'function' ? order.toJSON() : order;
  const receivableAmount = roundMoney(
    row.receivable_amount !== undefined ? row.receivable_amount : row.received_amount
  );
  const productPricingAmount = roundMoney(
    row.product_pricing_amount !== undefined
      ? row.product_pricing_amount
      : row.settlement_cost_amount
  );
  const paymentFeeAmount = roundMoney(row.payment_fee_amount);
  const vatAmount = roundMoney(row.vat_amount);
  const supplementAmount = roundMoney(row.supplement_amount);
  const freightCostAmount = roundMoney(row.freight_cost_amount);
  const grossProfitBeforeExternalAdjustment = roundMoney(
    receivableAmount - productPricingAmount - paymentFeeAmount - vatAmount + supplementAmount
  );
  const productPricingDetails = parseJsonArray(
    row.product_pricing_details || row.settlement_cost_details
  );
  const externalAdjustmentEligible = productPricingDetails.some(item =>
    item.externalAdjustmentEligible === true || item.external_adjustment_eligible === true ||
    isExternalAdjustmentEligibleProduct(item)
  );
  const externalAdjustmentFee = externalAdjustmentEligible && grossProfitBeforeExternalAdjustment > 500 ? 200 : 0;
  return {
    grossProfitId: row.gross_profit_id,
    orderId: row.order_id,
    orderNo: row.order_no,
    storeId: row.store_id,
    formulaVersion: row.formula_version,
    receivableAmount,
    ...(orderRow ? {
      orderTotalAmount: roundMoney(orderRow.total_amount),
      discountAmount: roundMoney(orderRow.discount_amount),
      nationalSubsidy: roundMoney(orderRow.national_subsidy),
      educationSubsidy: roundMoney(orderRow.education_subsidy)
    } : {}),
    productPricingAmount,
    paymentFeeAmount,
    invoiceAmount: roundMoney(row.invoice_amount),
    vatTaxableAmount: roundMoney(row.vat_taxable_amount),
    vatRate: VAT_RATE,
    vatAmount,
    supplementAmount,
    freightCostAmount,
    grossProfitBeforeExternalAdjustment,
    externalAdjustmentEligible,
    externalAdjustmentFee,
    grossProfitAmount: roundMoney(row.gross_profit_amount),
    paymentDetails: parseJsonArray(row.payment_fee_details),
    productPricingDetails,
    supplementDetails: parseJsonArray(row.supplement_details),
    snapshotStatus: row.snapshot_status,
    calculatedBy: row.calculated_by || '',
    calculatedAt: row.calculated_at,
    formula: '用户应收 - 服务商商品定价/非服务商本次采购价 - 支付手续费 - 增值税 + 补录净额；非服务商的电脑、手机或平板且基础毛利超过500元时另扣200元外调费'
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

async function resolveSupplierContext(items, order, transaction) {
  const productIds = [...new Set(items.map(item => item.product_id).filter(Boolean))];
  const itemSupplierIds = new Set(items.map(item => item.supplier_id).filter(Boolean).map(String));
  const snIds = [...new Set(items.map(item => item.sn_id).filter(Boolean))];
  const snCodes = [...new Set(items.map(item => item.sn_code).filter(Boolean))];
  const snRows = snIds.length || snCodes.length
    ? await ProductSn.findAll({
        where: {
          [Op.or]: [
            ...(snIds.length ? [{ sn_id: { [Op.in]: snIds } }] : []),
            ...(snCodes.length ? [{ sn_code: { [Op.in]: snCodes } }] : [])
          ]
        },
        raw: true,
        transaction
      })
    : [];
  const snMap = new Map();
  snRows.forEach(row => {
    if (row.sn_id) snMap.set(`id:${row.sn_id}`, row);
    if (row.sn_code) snMap.set(`code:${row.sn_code}`, row);
  });

  const latestInboundRows = productIds.length
    ? await sequelize.query(
        `SELECT ii.PRODUCT_ID AS product_id, ii.UNIT_PRICE AS inbound_price,
                pr.SUPPLIER_ID AS supplier_id,
                s.NAME AS supplier_name, s.IS_SERVICE_PROVIDER AS is_service_provider,
                s.GROSS_PROFIT_UPLIFT_AMOUNT AS gross_profit_uplift_amount
           FROM T_INBOUND_ITEM ii
           INNER JOIN T_INBOUND i ON i.INBOUND_ID = ii.INBOUND_ID
           LEFT JOIN T_PURCHASE_REQUEST pr ON pr.REQUEST_ID = i.PURCHASE_REQUEST_ID
           LEFT JOIN T_SUPPLIER s ON s.SUPPLIER_ID = pr.SUPPLIER_ID AND s.IS_DELETED = 0
          WHERE i.STORE_ID = :storeId
            AND i.STATUS = 'completed'
            AND ii.PRODUCT_ID IN (:productIds)
          ORDER BY i.CREATE_TIME DESC, i.INBOUND_ID DESC`,
        { replacements: { storeId: order.store_id, productIds }, type: QueryTypes.SELECT, transaction }
      )
    : [];
  const latestInboundByProduct = new Map();
  latestInboundRows.forEach(row => {
    if (!latestInboundByProduct.has(String(row.product_id)) && (row.supplier_id || toNumber(row.inbound_price) > 0)) {
      latestInboundByProduct.set(String(row.product_id), row);
    }
  });

  latestInboundByProduct.forEach(row => itemSupplierIds.add(String(row.supplier_id)));
  const suppliers = itemSupplierIds.size
    ? await Supplier.findAll({ where: { supplier_id: { [Op.in]: [...itemSupplierIds] }, is_deleted: 0 }, raw: true, transaction })
    : [];
  const supplierMap = new Map(suppliers.map(row => [String(row.supplier_id), row]));

  return { snMap, latestInboundByProduct, supplierMap };
}

async function buildProductPricingDetails(orderId, transaction) {
  const order = await Order.findByPk(orderId, { transaction, raw: true });
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
  const products = productIds.length
    ? await Product.findAll({
        where: { product_id: productIds },
        attributes: ['product_id', 'name', 'category', 'accessory_type'],
        transaction,
        raw: true
      })
    : [];
  const productById = new Map(products.map(product => [String(product.product_id), product]));
  const supplierContext = await resolveSupplierContext(items.map(item => item.toJSON()), order || {}, transaction);
  return items.map(item => {
    const row = item.toJSON();
    const productPrice = priceByProduct.get(String(row.product_id || ''));
    const product = productById.get(String(row.product_id || '')) || {};
    const snRow = supplierContext.snMap.get(`id:${row.sn_id}`) || supplierContext.snMap.get(`code:${row.sn_code}`);
    const inboundSupplier = supplierContext.latestInboundByProduct.get(String(row.product_id || ''));
    const supplierId = row.supplier_id || snRow?.supplier_id || inboundSupplier?.supplier_id || '';
    const supplier = supplierId ? supplierContext.supplierMap.get(String(supplierId)) : null;
    const purchasePrice = toNumber(row.original_inventory_cost)
      || toNumber(row.original_pickup_price)
      || toNumber(snRow?.inbound_price)
      || toNumber(inboundSupplier?.inbound_price);
    const pricing = resolveUnitProductPricing(productPrice, { ...row, purchasePrice }, supplier);
    const quantity = Number(row.quantity || 1);
    const isServiceProvider = pricing.isServiceProvider ?? true;
    return {
      itemId: row.item_id,
      productId: row.product_id || '',
      productName: row.product_name || '',
      category: product.category || '',
      accessoryType: product.accessory_type || '',
      pnCode: row.pn_code || '',
      snCode: row.sn_code || '',
      quantity,
      unitPricing: pricing.unitPricing,
      pricingAmount: roundMoney(pricing.unitPricing * quantity),
      purchasePrice: pricing.purchasePrice ?? roundMoney(purchasePrice),
      grossProfitUpliftAmount: pricing.grossProfitUpliftAmount ?? 0,
      supplierId: supplier?.supplier_id || supplierId,
      supplierName: supplier?.name || row.supplier_name || inboundSupplier?.supplier_name || '',
      isServiceProvider,
      externalAdjustmentEligible: isExternalAdjustmentEligibleProduct({
        category: product.category,
        productName: row.product_name || product.name,
        accessoryType: product.accessory_type,
        isServiceProvider
      }),
      source: pricing.source
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

async function buildFreightCostDetails(orderId, transaction) {
  const orderItems = await OrderItem.findAll({ where: { order_id: orderId }, transaction, raw: true });
  const details = [];
  for (const item of orderItems) {
    const productId = String(item.product_id || '').trim();
    const snId = String(item.sn_id || '').trim();
    const snCode = String(item.sn_code || '').trim();
    if (!productId && !snId && !snCode) continue;
    const where = {
      [Op.or]: [
        ...(productId ? [{ product_id: productId }] : []),
        ...(snId ? [{ sn_id: snId }] : []),
        ...(snCode ? [{ sn_code: snCode }] : [])
      ]
    };
    const rows = await FreightRecordItem.findAll({
      where,
      include: [{
        association: 'freightRecord',
        required: true,
        where: { status: 'active' },
        attributes: ['freight_id', 'source_type', 'source_no', 'platform_name', 'create_time']
      }],
      order: [['create_time', 'DESC'], ['item_id', 'DESC']],
      transaction
    });
    if (!rows.length) continue;
    const exactRows = rows.filter(row => {
      const value = row.toJSON();
      return (snId && String(value.sn_id || '') === snId) || (snCode && String(value.sn_code || '') === snCode);
    });
    const selected = (exactRows.length ? exactRows : rows)[0].toJSON();
    const source = selected.freightRecord || {};
    const quantity = Math.max(1, Number(item.quantity || 1));
    const unitAmount = roundMoney(selected.unit_amount || (Number(selected.allocated_amount || 0) / Math.max(1, Number(selected.quantity || 1))));
    const amount = roundMoney(unitAmount * quantity);
    if (amount <= 0) continue;
    details.push({
      source: 'freight_cost',
      itemId: item.item_id,
      productId,
      snCode,
      quantity,
      unitAmount,
      amount,
      amountType: 'decrease',
      sourceType: source.source_type || '',
      sourceNo: source.source_no || '',
      platformName: source.platform_name || '',
      freightId: source.freight_id || ''
    });
  }
  return details;
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

  const [paymentDetails, productPricingDetails, supplementDetails, freightCostDetails] = await Promise.all([
    buildPaymentDetails(order, existing, transaction),
    buildProductPricingDetails(orderId, transaction),
    buildSupplementDetails(orderId, transaction),
    buildFreightCostDetails(orderId, transaction)
  ]);
  const allSupplementDetails = [...supplementDetails, ...freightCostDetails];
  const values = calculateGrossProfitValues({
    receivableAmount: calculateOrderReceivable(order),
    paymentDetails,
    productPricingDetails,
    supplementDetails: allSupplementDetails,
    invoiceAmount: order.invoice_amount,
    externalAdjustmentEligible: productPricingDetails.some(item => item.externalAdjustmentEligible)
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
    freight_cost_amount: roundMoney(freightCostDetails.reduce((sum, item) => sum + item.amount, 0)),
    gross_profit_amount: values.grossProfitAmount,
    payment_fee_details: values.paymentDetails,
    product_pricing_details: values.productPricingDetails,
    supplement_details: values.supplementDetails,
    snapshot_status: archived ? 'final' : 'draft',
    calculated_by: calculatedBy || 'system',
    calculated_at: new Date(),
    update_time: new Date()
  };

  await Promise.all(freightCostDetails.map(detail => OrderItem.update(
    { freight_cost: detail.amount },
    { where: { item_id: detail.itemId }, transaction }
  )));

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

async function refreshOutdatedGrossProfitSnapshots() {
  const snapshots = await OrderGrossProfit.findAll({
    where: { formula_version: { [Op.ne]: FORMULA_VERSION } },
    attributes: ['order_id', 'snapshot_status'],
    raw: true
  });
  let refreshed = 0;
  let failed = 0;
  for (const snapshot of snapshots) {
    try {
      await calculateAndSaveOrderGrossProfit(snapshot.order_id, {
        calculatedBy: 'formula_migration',
        force: true,
        final: snapshot.snapshot_status === 'final'
      });
      refreshed += 1;
    } catch (error) {
      failed += 1;
      console.error(
        `[GrossProfit] failed to migrate order ${snapshot.order_id}:`,
        error.message
      );
    }
  }
  return { total: snapshots.length, refreshed, failed };
}

module.exports = {
  FORMULA_VERSION,
  VAT_RATE,
  roundMoney,
  isExternalAdjustmentEligibleProduct,
  calculateNationalSubsidyCustomerReceiptAmount,
  normalizeMethodName,
  isPolicySubsidyReceivable,
  calculateOrderReceivable,
  resolveUnitProductPricing,
  calculateGrossProfitValues,
  calculateAndSaveOrderGrossProfit,
  refreshOutdatedGrossProfitSnapshots,
  snapshotToResponse
};
