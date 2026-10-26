const {
  Order,
  OrderItem,
  OrderPayment,
  OrderSupplement,
  OrderGrossProfit,
  SalesReturnRequestItem,
  SalesReturnGrossProfitLedger,
  DepositOrder,
  DepositRedemption,
  PaymentMethod,
  PaymentMethodStore,
  ProductPrice,
  Product,
  ProductSn,
  SnDistributorPrice,
  Store,
  Supplier,
  FreightRecordItem,
  sequelize
} = require('../../models');
const { Op, QueryTypes } = require('sequelize');
const { generateUUID } = require('../../utils');

const FORMULA_VERSION = 'ORDER_GP_V11_PRODUCT_COST_MODE';
const { allocateProfit } = require('../report/performanceAllocation');
const VAT_RATE = 0.13;
const NATIONAL_SUBSIDY_RECEIPT_TAX_RATE = 0.006;
// Approved historical cost basis for sales made on October 1–7, 2026 (China time).
// Keep this in the calculation path so a forced refresh cannot undo the snapshots.
const EARLY_OCTOBER_2026_PN_COST = new Map([
  ['ZAJA0009CN', 5400],
  ['ZAJA0007CN', 4500],
  ['ZAJA0001CN', 5400],
  ['ZAJA0002CN', 4500],
  ['ZAJA0012CN', 4500]
]);
const EARLY_OCTOBER_START = Date.parse('2026-10-01T00:00:00+08:00');
const EARLY_OCTOBER_END = Date.parse('2026-10-08T00:00:00+08:00');

function historicalPnCost(order, pnCode) {
  const soldAt = new Date(order?.create_time).getTime();
  if (!(soldAt >= EARLY_OCTOBER_START && soldAt < EARLY_OCTOBER_END)) return null;
  return EARLY_OCTOBER_2026_PN_COST.get(String(pnCode || '').trim().toUpperCase()) ?? null;
}

function toNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function roundMoney(value) {
  return Math.round((toNumber(value) + Number.EPSILON) * 100) / 100;
}

function isExternalAdjustmentEligibleProduct(item = {}) {
  if (Object.prototype.hasOwnProperty.call(item, 'externalAdjustmentEligible')) {
    return item.externalAdjustmentEligible === true;
  }
  if (Object.prototype.hasOwnProperty.call(item, 'external_adjustment_eligible')) {
    return item.external_adjustment_eligible === true;
  }
  const { category = '', productName = '', accessoryType = '' } = item;
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

function normalizeReferenceId(value) {
  return String(value || '').trim();
}

function isFreightRecordApplicableToOrder({
  orderStoreId,
  orderCreatedAt,
  sourceType,
  storeId,
  toStoreId,
  sourceCreatedAt,
  sourceUpdatedAt
} = {}) {
  const orderStore = normalizeReferenceId(orderStoreId);
  if (!orderStore) return false;

  const sourceStore = normalizeReferenceId(storeId);
  const destinationStore = normalizeReferenceId(toStoreId);
  const normalizedSourceType = normalizeReferenceId(sourceType).toLowerCase();
  const applicableStore = normalizedSourceType === 'transfer'
    ? (destinationStore || sourceStore)
    : sourceStore;
  if (!applicableStore || applicableStore !== orderStore) return false;

  const sourceEffectiveAt = sourceUpdatedAt || sourceCreatedAt;
  if (orderCreatedAt && sourceEffectiveAt) {
    const orderTime = new Date(orderCreatedAt).getTime();
    const sourceTime = new Date(sourceEffectiveAt).getTime();
    if (Number.isFinite(orderTime) && Number.isFinite(sourceTime) && sourceTime > orderTime) {
      return false;
    }
  }
  return true;
}

function validPrice(value) {
  if (value === null || value === undefined || typeof value === 'boolean' || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function pricingCompleteness(details) {
  const missingCostItems = parseJsonArray(details).filter(item =>
    String(item.source || '').startsWith('missing_') || validPrice(item.unitPricing) === null
  );
  return {
    pricingComplete: missingCostItems.length === 0,
    pricingStatus: missingCostItems.length ? 'pending' : 'complete',
    pricingMessage: missingCostItems.length ? '成本待补，毛利预估不完整' : '',
    missingCostItems: missingCostItems.map(item => ({ itemId: item.itemId, productName: item.productName, source: item.source }))
  };
}

function resolveUnitProductPricing(
  productPrice = {},
  orderItem = {},
  supplier = null,
  { purchaseUpliftAmount = null, costMode = 'PURCHASE_PRICE' } = {}
) {
  const configuredPricing = productPrice.status !== undefined && Number(productPrice.status) !== 1
    ? null : validPrice(productPrice.standard_price);
  const specialPrice = validPrice(orderItem.specialPrice ?? orderItem.special_price);
  const companyPricing = specialPrice ?? configuredPricing;
  const isCompanyPriced = String(costMode || '').toUpperCase() === 'COMPANY_PRICE';
  const grossProfitUpliftAmount = isCompanyPriced
    ? 0
    : Math.max(0, roundMoney(purchaseUpliftAmount ?? supplier?.gross_profit_uplift_amount ?? 0));
  const purchasePrice = Object.prototype.hasOwnProperty.call(orderItem, 'purchasePrice')
    ? validPrice(orderItem.purchasePrice)
    : (validPrice(orderItem.original_pickup_price) ??
      validPrice(orderItem.original_inventory_cost) ??
      (productPrice.status !== undefined && Number(productPrice.status) !== 1 ? null : validPrice(productPrice.cost_price)));
  const result = (unitPricing, source) => ({
    unitPricing: roundMoney(unitPricing),
    source,
    purchasePrice: roundMoney(purchasePrice),
    grossProfitUpliftAmount,
    isCompanyPriced
  });

  if (isCompanyPriced) {
    return companyPricing !== null
      ? result(companyPricing, specialPrice !== null ? 'sn_special_price' : 'product_standard_price')
      : result(0, 'missing_company_price');
  }
  if (purchasePrice !== null) return result(purchasePrice, 'purchase_price');
  return result(0, 'missing_purchase_price');
}

function calculateGrossProfitValues({
  receivableAmount = 0,
  paymentDetails = [],
  productPricingDetails = [],
  supplementDetails = [],
  freightCostDetails = [],
  invoiceAmount = 0,
  invoiceStatus = '',
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
  const normalizedFreightCosts = freightCostDetails.map(item => ({
    ...item,
    amount: roundMoney(Math.abs(toNumber(item.amount)))
  }));

  const productPricingAmount = roundMoney(
    normalizedProductPricing.reduce((sum, item) => sum + item.pricingAmount, 0)
  );
  const paymentFeeAmount = roundMoney(normalizedPayments.reduce((sum, item) => sum + item.fee, 0));
  const invoiceNotRequired = String(invoiceStatus || '').trim() === '不开票';
  const normalizedInvoiceAmount = invoiceNotRequired ? 0 : roundMoney(invoiceAmount);
  const vatTaxableAmount = invoiceNotRequired
    ? 0
    : roundMoney(Math.max(0, normalizedInvoiceAmount - productPricingAmount));
  const vatAmount = roundMoney(vatTaxableAmount * VAT_RATE);
  const supplementAmount = roundMoney(normalizedSupplements.reduce((sum, item) => sum + item.signedAmount, 0));
  const freightCostAmount = roundMoney(normalizedFreightCosts.reduce((sum, item) => sum + item.amount, 0));
  const grossProfitBeforeExternalAdjustment = roundMoney(
    normalizedReceivableAmount - productPricingAmount - paymentFeeAmount - vatAmount + supplementAmount - freightCostAmount
  );
  const externalAdjustmentAmount = roundMoney(normalizedProductPricing.reduce((sum, item) => {
    const eligible = item.externalAdjustmentEligible === true || item.external_adjustment_eligible === true ||
      isExternalAdjustmentEligibleProduct(item);
    if (!eligible) return sum;
    return sum + roundMoney(item.grossProfitUpliftAmount ?? item.gross_profit_uplift_amount) * item.quantity;
  }, 0));
  const hasEligibleExternalAdjustmentProduct = externalAdjustmentEligible || normalizedProductPricing.some(item =>
    item.externalAdjustmentEligible === true || item.external_adjustment_eligible === true ||
    isExternalAdjustmentEligibleProduct(item)
  );
  const externalAdjustmentFee = hasEligibleExternalAdjustmentProduct && grossProfitBeforeExternalAdjustment > 500
    ? externalAdjustmentAmount
    : 0;
  const grossProfitAmount = roundMoney(grossProfitBeforeExternalAdjustment - externalAdjustmentFee);

  return {
    receivableAmount: normalizedReceivableAmount,
    productPricingAmount,
    paymentFeeAmount,
    invoiceAmount: normalizedInvoiceAmount,
    vatTaxableAmount,
    vatAmount,
    supplementAmount,
    freightCostAmount,
    grossProfitBeforeExternalAdjustment,
    externalAdjustmentEligible: !!hasEligibleExternalAdjustmentProduct,
    externalAdjustmentAmount,
    externalAdjustmentFee,
    grossProfitAmount,
    paymentDetails: normalizedPayments,
    productPricingDetails: normalizedProductPricing,
    supplementDetails: normalizedSupplements,
    freightCostDetails: normalizedFreightCosts
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
    receivableAmount - productPricingAmount - paymentFeeAmount - vatAmount + supplementAmount - freightCostAmount
  );
  const productPricingDetails = parseJsonArray(
    row.product_pricing_details || row.settlement_cost_details
  );
  const externalAdjustmentEligible = productPricingDetails.some(item =>
    item.externalAdjustmentEligible === true || item.external_adjustment_eligible === true ||
    isExternalAdjustmentEligibleProduct(item)
  );
  const externalAdjustmentAmount = roundMoney(productPricingDetails.reduce((sum, item) => {
    const eligible = item.externalAdjustmentEligible === true || item.external_adjustment_eligible === true ||
      isExternalAdjustmentEligibleProduct(item);
    if (!eligible) return sum;
    return sum + roundMoney(item.grossProfitUpliftAmount ?? item.gross_profit_uplift_amount) *
      toNumber(item.quantity || 1);
  }, 0));
  const usesSupplierUpliftRule = productPricingDetails.some(item =>
    String(item.externalAdjustmentRuleVersion || '').startsWith('SUPPLIER_UPLIFT_')
  );
  const externalAdjustmentFee = externalAdjustmentEligible && grossProfitBeforeExternalAdjustment > 500
    ? (usesSupplierUpliftRule ? externalAdjustmentAmount : 200)
    : 0;
  const storedAdjustmentDetails = parseJsonArray(row.supplement_details);
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
    externalAdjustmentAmount,
    externalAdjustmentFee,
    grossProfitAmount: pricingCompleteness(productPricingDetails).pricingComplete || row.snapshot_status === 'final'
      ? roundMoney(row.gross_profit_amount) : null,
    ...pricingCompleteness(productPricingDetails),
    paymentDetails: parseJsonArray(row.payment_fee_details),
    productPricingDetails,
    supplementDetails: storedAdjustmentDetails.filter(item => item.source !== 'freight_cost'),
    freightCostDetails: storedAdjustmentDetails.filter(item => item.source === 'freight_cost'),
    snapshotStatus: row.snapshot_status,
    calculatedBy: row.calculated_by || '',
    calculatedAt: row.calculated_at,
    formula: '用户应收 - 按商品毛利成本口径标签取公司定价（SN特价优先）或实际采购价 - 支付手续费 - 增值税 + 补录净额 - 运费 - 采购价口径且符合条件商品按供应商毛利上浮额度计算外调费'
  };
}

async function buildPaymentDetails(order, existingSnapshot, transaction) {
  const [payments, redemptions, methods] = await Promise.all([
    OrderPayment.findAll({ where: { order_id: order.order_id }, transaction, raw: true }),
    DepositRedemption.findAll({
      where: { order_id: order.order_id },
      include: [{ model: DepositOrder, attributes: ['deposit_id', 'deposit_no', 'payment_method', 'store_id'] }],
      transaction
    }),
    PaymentMethod.findAll({ transaction, raw: true })
  ]);

  const methodIdByName = new Map();
  const defaultTaxRateByMethod = new Map();
  methods.forEach(method => {
    const rate = toNumber(method.default_tax_rate);
    const methodId = String(method.method_id || '');
    methodIdByName.set(normalizeMethodName(method.name), methodId);
    methodIdByName.set(normalizeMethodName(method.code), methodId);
    defaultTaxRateByMethod.set(normalizeMethodName(method.name), rate);
    defaultTaxRateByMethod.set(normalizeMethodName(method.code), rate);
  });

  const storeIds = new Set([String(order.store_id || '')]);
  redemptions.forEach(redemption => {
    const depositStoreId = redemption.DepositOrder?.store_id;
    if (depositStoreId) storeIds.add(String(depositStoreId));
  });
  const taxOverrides = await PaymentMethodStore.findAll({
    where: { store_id: { [Op.in]: [...storeIds].filter(Boolean) } },
    attributes: ['method_id', 'store_id', 'tax_rate_override'],
    transaction,
    raw: true
  });
  const taxOverrideByStoreMethod = new Map(
    taxOverrides
      .filter(item => item.tax_rate_override !== null && item.tax_rate_override !== undefined)
      .map(item => [`${item.store_id}:${item.method_id}`, toNumber(item.tax_rate_override)])
  );

  // 已封存订单重算其他组成项时继续沿用原收款税率快照。
  const snapshotTaxRateByMethod = new Map();
  if (existingSnapshot?.snapshot_status === 'final') {
    parseJsonArray(existingSnapshot.payment_fee_details).forEach(detail => {
      snapshotTaxRateByMethod.set(normalizeMethodName(detail.method), toNumber(detail.taxRate));
    });
  }

  const resolveTaxRate = (method, storeId) => {
    const normalizedMethod = normalizeMethodName(method);
    if (snapshotTaxRateByMethod.has(normalizedMethod)) return snapshotTaxRateByMethod.get(normalizedMethod);
    const methodId = methodIdByName.get(normalizedMethod);
    const overrideKey = `${storeId || ''}:${methodId || ''}`;
    if (methodId && taxOverrideByStoreMethod.has(overrideKey)) return taxOverrideByStoreMethod.get(overrideKey);
    return defaultTaxRateByMethod.get(normalizedMethod) || 0;
  };

  const details = payments
    .filter(payment => !isPolicySubsidyReceivable(payment.payment_method))
    .map(payment => ({
      source: 'order_payment',
      paymentId: payment.payment_id,
      method: payment.payment_method,
      amount: roundMoney(payment.amount),
      taxRate: resolveTaxRate(payment.payment_method, order.store_id)
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
        taxRate: resolveTaxRate(method, deposit.store_id || order.store_id)
      });
    });

  return details;
}

function resolveInventoryCostMode(product = {}, sn = {}, price = {}, orderTime = new Date()) {
  // An explicit per-inventory instruction wins over all category defaults.
  if (String(sn?.gross_profit_use_standard_price) === '1') return 'COMPANY_PRICE';
  if (String(sn?.gross_profit_use_standard_price) === '0') return 'PURCHASE_PRICE';
  if (product.category === '售后' && product.brand === 'Care服务') {
    return new Date(orderTime).getTime() >= Date.UTC(2026, 9, 1) ? 'COMPANY_PRICE' : 'PURCHASE_PRICE';
  }
  if (product.category === '选件' && Number(price?.status) === 1 && validPrice(price?.standard_price) !== null) return 'COMPANY_PRICE';
  return product.gross_profit_cost_mode === 'COMPANY_PRICE' ? 'COMPANY_PRICE' : 'PURCHASE_PRICE';
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
    if (row.supplier_id) itemSupplierIds.add(String(row.supplier_id));
  });

  const latestInboundRows = productIds.length
    ? await sequelize.query(
        `SELECT ii.PRODUCT_ID AS product_id, ii.UNIT_PRICE AS inbound_price, i.SOURCE_TYPE AS source_type,
                EXISTS (SELECT 1 FROM T_INBOUND_ITEM recovered_item
                  INNER JOIN T_INBOUND recovered_inbound ON recovered_inbound.INBOUND_ID = recovered_item.INBOUND_ID
                  WHERE recovered_item.PRODUCT_ID = ii.PRODUCT_ID AND recovered_inbound.SOURCE_TYPE = 'SALES_COMPONENT_RECOVERY'
                    AND recovered_inbound.STATUS = 'completed' AND recovered_inbound.RECEIVE_TIME <= :orderTime) AS has_recovery_cost,
                pr.SUPPLIER_ID AS supplier_id,
                s.NAME AS supplier_name,
                s.GROSS_PROFIT_UPLIFT_AMOUNT AS supplier_gross_profit_uplift_amount
           FROM T_INBOUND_ITEM ii
           INNER JOIN T_INBOUND i ON i.INBOUND_ID = ii.INBOUND_ID
           LEFT JOIN T_PURCHASE_REQUEST pr ON pr.REQUEST_ID = i.PURCHASE_REQUEST_ID
           LEFT JOIN T_SUPPLIER s ON s.SUPPLIER_ID = pr.SUPPLIER_ID AND s.IS_DELETED = 0
          WHERE i.STORE_ID = :storeId
            AND i.STATUS = 'completed'
            AND i.CREATE_TIME <= :orderTime
            AND (COALESCE(i.SOURCE_TYPE, '') NOT IN ('GIFT','SALES_COMPONENT_RECOVERY') OR i.RECEIVE_TIME <= :orderTime)
            AND ii.PRODUCT_ID IN (:productIds)
          ORDER BY i.CREATE_TIME DESC, i.INBOUND_ID DESC`,
        // Raw replacements format Date using the host timezone. MySQL business
        // DATETIME values use +08:00, including when the container runs in UTC.
        { replacements: { storeId: order.store_id, orderTime: new Date(new Date(order.create_time).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 23).replace('T', ' '), productIds }, type: QueryTypes.SELECT, transaction }
      )
    : [];
  const latestInboundByProduct = new Map();
  latestInboundRows.forEach(row => {
    if (!latestInboundByProduct.has(String(row.product_id)) && (row.supplier_id || validPrice(row.inbound_price) !== null)) {
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
        attributes: ['product_id', 'name', 'category', 'brand', 'accessory_type', 'gross_profit_cost_mode'],
        transaction,
        raw: true
      })
    : [];
  const productById = new Map(products.map(product => [String(product.product_id), product]));
  const supplierContext = await resolveSupplierContext(items.map(item => item.toJSON()), order || {}, transaction);
  const snIds = [...new Set(items.map(item => item.sn_id).filter(Boolean))];
  const snCodes = [...new Set(items.map(item => item.sn_code).filter(Boolean))];
  const store = snIds.length || snCodes.length
    ? await Store.findOne({
        where: { store_id: order?.store_id, is_deleted: 0 },
        attributes: ['store_id', 'distributor_id'],
        raw: true,
        transaction
      })
    : null;
  const specialPrices = store?.distributor_id && (snIds.length || snCodes.length)
    ? await SnDistributorPrice.findAll({
        where: {
          distributor_id: store.distributor_id,
          status: 1,
          [Op.or]: [
            ...(snIds.length ? [{ sn_id: { [Op.in]: snIds } }] : []),
            ...(snCodes.length ? [{ sn_code: { [Op.in]: snCodes } }] : [])
          ]
        },
        attributes: ['sn_id', 'sn_code', 'special_price'],
        raw: true,
        transaction
      })
    : [];
  const specialPriceBySnId = new Map();
  const specialPriceBySnCode = new Map();
  specialPrices.forEach(row => {
    const price = validPrice(row.special_price);
    if (price === null) return;
    if (row.sn_id) specialPriceBySnId.set(String(row.sn_id), price);
    if (row.sn_code) specialPriceBySnCode.set(String(row.sn_code).trim().toUpperCase(), price);
  });
  return items.map(item => {
    const row = item.toJSON();
    const productPrice = priceByProduct.get(String(row.product_id || ''));
    const product = productById.get(String(row.product_id || '')) || {};
    const snRow = supplierContext.snMap.get(`id:${row.sn_id}`) || supplierContext.snMap.get(`code:${row.sn_code}`);
    const inboundSupplier = supplierContext.latestInboundByProduct.get(String(row.product_id || ''));
    const receiptSource = snRow ? snRow.source_type : inboundSupplier?.source_type;
    const isNonPurchase = ['GIFT', 'SALES_COMPONENT_RECOVERY'].includes(receiptSource);
    const nonSnReceiptCost = !snRow && isNonPurchase ? validPrice(productPrice?.cost_price) : null;
    const supplierId = row.supplier_id || snRow?.supplier_id || inboundSupplier?.supplier_id || '';
    const supplier = supplierId ? supplierContext.supplierMap.get(String(supplierId)) : null;
    // Unarchived order-item zeroes are defaults, not evidence of actual cost.
    const purchasePrice = nonSnReceiptCost ?? (toNumber(row.original_inventory_cost) > 0 ? validPrice(row.original_inventory_cost) : null)
      ?? (toNumber(row.original_pickup_price) > 0 ? validPrice(row.original_pickup_price) : null)
      ?? validPrice(snRow?.inbound_price)
      ?? validPrice(inboundSupplier?.inbound_price)
      ?? (productPrice && Number(productPrice.status ?? 1) === 1
        && (Number(productPrice.cost_price) > 0 || Number(productPrice.cost_price_locked) === 1)
        ? validPrice(productPrice.cost_price) : null);
    const specialPrice = specialPriceBySnId.get(String(snRow?.sn_id || row.sn_id || ''))
      ?? specialPriceBySnCode.get(String(snRow?.sn_code || row.sn_code || '').trim().toUpperCase())
      ?? null;
    const pricing = resolveUnitProductPricing(
      productPrice,
      { ...row, purchasePrice, specialPrice },
      supplier,
      {
        purchaseUpliftAmount: supplier?.gross_profit_uplift_amount ?? inboundSupplier?.supplier_gross_profit_uplift_amount,
        costMode: isNonPurchase ? 'COMPANY_PRICE' : resolveInventoryCostMode(product, snRow, productPrice, order.create_time)
      }
    );
    const fixedCost = historicalPnCost(order, row.pn_code);
    const effectivePricing = fixedCost === null ? pricing : {
      ...pricing,
      unitPricing: fixedCost,
      source: 'historical_pn_cost_override',
      grossProfitUpliftAmount: 0,
      isCompanyPriced: true
    };
    const quantity = Number(row.quantity || 1);
    const externalAdjustmentEligible = !effectivePricing.isCompanyPriced && effectivePricing.grossProfitUpliftAmount > 0 &&
      isExternalAdjustmentEligibleProduct({
        category: product.category,
        productName: row.product_name || product.name,
        accessoryType: product.accessory_type
      });
    return {
      itemId: row.item_id,
      productId: row.product_id || '',
      productName: row.product_name || '',
      category: product.category || '',
      accessoryType: product.accessory_type || '',
      pnCode: row.pn_code || '',
      snCode: row.sn_code || '',
      quantity,
      unitPricing: effectivePricing.unitPricing,
      pricingAmount: roundMoney(effectivePricing.unitPricing * quantity),
      specialPrice: fixedCost === null && specialPrice !== null ? roundMoney(specialPrice) : null,
      isSpecialPrice: fixedCost === null && specialPrice !== null,
      purchasePrice: effectivePricing.purchasePrice ?? roundMoney(purchasePrice),
      purchasePriceKnown: purchasePrice !== null,
      nonPurchaseSource: isNonPurchase ? receiptSource : null,
      recoveryFinancialAllocationPending: snRow ? receiptSource === 'SALES_COMPONENT_RECOVERY' : Number(inboundSupplier?.has_recovery_cost) === 1,
      grossProfitUpliftAmount: effectivePricing.grossProfitUpliftAmount ?? 0,
      supplierId: supplier?.supplier_id || supplierId,
      supplierName: supplier?.name || row.supplier_name || inboundSupplier?.supplier_name || '',
      isCompanyPriced: effectivePricing.isCompanyPriced,
      externalAdjustmentEligible,
      externalAdjustmentRuleVersion: 'SUPPLIER_UPLIFT_V2',
      source: effectivePricing.source
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

function normalizeGrossProfitParticipants(order = {}) {
  const participants = [];
  const seen = new Set();
  const add = (staffId, name, role, allocation = {}) => {
    const normalizedStaffId = staffId === null || staffId === undefined || staffId === '' ? null : String(staffId);
    const normalizedName = String(name || '').trim() || '未命名员工';
    const key = normalizedStaffId ? `id:${normalizedStaffId}` : `name:${normalizedName}`;
    if (seen.has(key)) return;
    seen.add(key);
    participants.push({
      key,
      staffId: normalizedStaffId,
      employeeName: normalizedName,
      participantRole: role,
      profitAmount: allocation.profitAmount ?? allocation.profit_amount ?? '',
      ratio: allocation.ratio ?? ''
    });
  };

  add(order.create_staff_id, order.create_user, 'primary');
  parseJsonArray(order.auxiliary_sales_list).forEach(item => {
    if (!item || typeof item !== 'object') return;
    add(
      item.staffId ?? item.staff_id ?? item.id,
      item.name ?? item.staffName ?? item.staff_name ?? item.selected,
      'auxiliary', item
    );
  });
  return participants;
}

/**
 * Create an immutable negative gross-profit row for every original order
 * participant after the return inbound is completed. The unique key on
 * (return_id, participant_key) makes retries and repeated callbacks safe.
 */
async function createSalesReturnGrossProfitLedger({ returnRequest, transaction = null, createdBy = 'system' } = {}) {
  if (!returnRequest?.return_id || !returnRequest?.order_id) return [];

  const existing = await SalesReturnGrossProfitLedger.findAll({
    where: { return_id: returnRequest.return_id },
    transaction,
    lock: transaction?.LOCK?.UPDATE
  });
  if (existing.length > 0) return existing;

  const order = await Order.findByPk(returnRequest.order_id, { transaction, lock: transaction?.LOCK?.UPDATE });
  if (!order) throw new Error(`销售退单对应的原订单不存在：${returnRequest.order_id}`);
  const returnItems = await SalesReturnRequestItem.findAll({
    where: { return_id: returnRequest.return_id },
    transaction,
    lock: transaction?.LOCK?.UPDATE
  });
  if (!returnItems.length) return [];

  let snapshot = await OrderGrossProfit.findOne({ where: { order_id: order.order_id }, transaction });
  if (!snapshot) {
    // Historical returns must never reprice the original sale using today's costs.
    const archivedItems = await OrderItem.findAll({ where: { order_id: order.order_id }, transaction });
    snapshot = { gross_profit_amount: roundMoney(archivedItems.reduce(
      (sum, item) => sum + toNumber(item.sales_gross_profit), 0)) };
  }

  const returnedSalesAmount = roundMoney(returnItems.reduce(
    (sum, item) => sum + toNumber(item.unit_price) * Math.max(0, toNumber(item.quantity)),
    0
  ));
  if (returnedSalesAmount <= 0) return [];

  const orderTotalAmount = toNumber(order.total_amount);
  const snapshotGrossProfit = toNumber(snapshot?.gross_profit_amount);
  const reversedGrossProfit = roundMoney(orderTotalAmount > 0
    ? snapshotGrossProfit * returnedSalesAmount / orderTotalAmount
    : returnItems.reduce((sum, item) => sum + toNumber(item.subtotal), 0));
  const negativeSalesAmount = -returnedSalesAmount;
  const negativeGrossProfit = -reversedGrossProfit;
  const participants = normalizeGrossProfitParticipants(order);
  if (!participants.length) return [];
  const originalShares = allocateProfit(participants, snapshotGrossProfit);
  let allocatedReturnProfit = 0;
  const returnProfitShares = participants.map((_, index) => {
    const isLast = index === participants.length - 1;
    const amount = isLast
      ? roundMoney(negativeGrossProfit - allocatedReturnProfit)
      : snapshotGrossProfit
        ? roundMoney(negativeGrossProfit * originalShares[index] / snapshotGrossProfit)
        : roundMoney(negativeGrossProfit / participants.length);
    allocatedReturnProfit = roundMoney(allocatedReturnProfit + amount);
    return amount;
  });

  const reason = `销售退单 ${returnRequest.return_no} 完成，冲减原订单毛利`;
  const rows = [];
  let allocatedSales = 0;
  for (let index = 0; index < participants.length; index += 1) {
    const participant = participants[index];
    const isLast = index === participants.length - 1;
    const salesAmount = isLast
      ? roundMoney(negativeSalesAmount - allocatedSales)
      : roundMoney(negativeSalesAmount / participants.length);
    const grossProfitAmount = returnProfitShares[index];
    allocatedSales = roundMoney(allocatedSales + salesAmount);
    rows.push(await SalesReturnGrossProfitLedger.create({
      ledger_id: generateUUID(),
      return_id: returnRequest.return_id,
      return_no: returnRequest.return_no,
      order_id: order.order_id,
      order_no: order.order_no,
      store_id: order.store_id,
      participant_key: participant.key,
      staff_id: participant.staffId,
      employee_name: participant.employeeName,
      participant_role: participant.participantRole,
      returned_sales_amount: salesAmount,
      gross_profit_amount: grossProfitAmount,
      reason,
      create_user: createdBy,
      create_time: new Date()
    }, { transaction }));
  }
  return rows;
}

// Product identity alone never proves which purchase/transfer paid for a sold unit.
function matchesFreightOrigin(item, value, origins = []) {
  const productId = normalizeReferenceId(item.product_id);
  if (normalizeReferenceId(value.product_id) !== productId) return false;
  const snId = normalizeReferenceId(item.sn_id);
  const snCode = normalizeReferenceId(item.sn_code);
  const rowSnId = normalizeReferenceId(value.sn_id);
  const rowSnCode = normalizeReferenceId(value.sn_code);
  if (rowSnId || rowSnCode) {
    // An explicit different SN must never fall back to a product/batch match.
    return rowSnId && snId ? rowSnId === snId : !!snCode && rowSnCode === snCode;
  }
  const source = value.freightRecord || {};
  return origins.some(origin =>
    String(origin.source_type || '').toLowerCase() === String(source.source_type || '').toLowerCase() &&
    ((source.source_id && origin.source_id && String(source.source_id) === String(origin.source_id)) ||
      (source.source_no && origin.source_no && String(source.source_no) === String(origin.source_no)))
  );
}

async function resolveFreightOrigins(item, transaction) {
  if (!item.sn_id && (!item.sn_code || String(item.sn_code).trim() === '0')) return [];
  // Immutable receipt links survive SN edits and sales returns. Legacy receipt fields
  // are used only where no immutable link exists for that inbound item.
  return sequelize.query(`
    SELECT DISTINCT LOWER(i.SOURCE_TYPE) AS source_type,
           i.PURCHASE_REQUEST_ID AS source_id, i.SOURCE_NO AS source_no
      FROM T_INBOUND i
      JOIN T_INBOUND_ITEM ii ON ii.INBOUND_ID = i.INBOUND_ID
      LEFT JOIN T_INBOUND_ITEM_SN ins ON ins.INBOUND_ITEM_ID = ii.ITEM_ID
     WHERE i.STATUS = 'completed' AND ii.PRODUCT_ID = :productId
       AND (
         (:snId <> '' AND ins.SN_ID = :snId)
         OR (:snId = '' AND :snCode <> '' AND ins.SN_CODE = :snCode)
         OR (ins.INBOUND_ITEM_SN_ID IS NULL AND (
           (:snId <> '' AND ii.SN_ID = :snId)
           OR ((ii.SN_ID IS NULL OR ii.SN_ID = '' OR :snId = '') AND :snCode <> '' AND (
             ii.SN_CODE = :snCode
             OR (JSON_VALID(ii.RECEIVED_SN_CODES) AND
                 JSON_CONTAINS(IF(JSON_VALID(ii.RECEIVED_SN_CODES), ii.RECEIVED_SN_CODES, '[]'), JSON_QUOTE(:snCode)))
           ))
         ))
       )`, {
    replacements: { productId: item.product_id, snId: item.sn_id || '', snCode: item.sn_code || '' },
    type: QueryTypes.SELECT, transaction
  });
}

async function buildFreightCostDetails(order, transaction) {
  const orderId = order.order_id;
  const orderItems = await OrderItem.findAll({ where: { order_id: orderId }, transaction, raw: true });
  const details = [];
  for (const item of orderItems) {
    const productId = String(item.product_id || '').trim();
    const snId = String(item.sn_id || '').trim();
    const snCode = String(item.sn_code || '').trim();
    if (!productId && !snId && !snCode) continue;
    const origins = await resolveFreightOrigins(item, transaction);
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
        attributes: [
          'freight_id', 'source_type', 'source_id', 'source_no', 'platform_name',
          'store_id', 'to_store_id', 'create_time', 'update_time'
        ]
      }],
      order: [['create_time', 'DESC'], ['item_id', 'DESC']],
      transaction
    });
    const applicableRows = rows.filter(row => {
      const value = row.toJSON();
      const source = value.freightRecord || {};
      return matchesFreightOrigin(item, value, origins) && isFreightRecordApplicableToOrder({
        orderStoreId: order.store_id,
        orderCreatedAt: order.create_time,
        sourceType: source.source_type,
        storeId: source.store_id,
        toStoreId: source.to_store_id,
        sourceCreatedAt: source.create_time,
        sourceUpdatedAt: source.update_time
      });
    });
    if (!applicableRows.length) continue;
    const exactRows = applicableRows.filter(row => {
      const value = row.toJSON();
      return (snId && String(value.sn_id || '') === snId) || (snCode && String(value.sn_code || '') === snCode);
    });
    const selected = (exactRows.length ? exactRows : applicableRows)[0].toJSON();
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
  final = null,
  persist = true,
  requireComplete = false
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
    (existing.formula_version === FORMULA_VERSION || !persist) &&
    !force
  ) {
    return existing;
  }

  const [paymentDetails, productPricingDetails, supplementDetails, freightCostDetails] = await Promise.all([
    buildPaymentDetails(order, existing, transaction),
    buildProductPricingDetails(orderId, transaction),
    buildSupplementDetails(orderId, transaction),
    buildFreightCostDetails(order, transaction)
  ]);
  if (existing?.snapshot_status === 'final' && existing.formula_version !== FORMULA_VERSION) {
    const previousLines = new Map(parseJsonArray(existing.product_pricing_details)
      .map(line => [String(line.itemId), line]));
    const missingPriceLines = productPricingDetails.filter(line =>
      String(line.source || '').startsWith('missing_') &&
      Number(line.quantity || 1) > 0 &&
      Number(previousLines.get(String(line.itemId))?.unitPricing || 0) > 0
    );
    if (missingPriceLines.length) {
      throw new Error('商品缺少可用的定价或采购价，保留原归档毛利快照，待补价后重算');
    }
  }
  const values = calculateGrossProfitValues({
    receivableAmount: calculateOrderReceivable(order),
    paymentDetails,
    productPricingDetails,
    supplementDetails,
    freightCostDetails,
    invoiceAmount: order.invoice_amount,
    invoiceStatus: order.invoice_status,
    externalAdjustmentEligible: productPricingDetails.some(item => item.externalAdjustmentEligible)
  });
  const archived = final === null
    ? ['已归档', 'completed', 'archived'].includes(String(order.order_status || ''))
    : !!final;
  const completeness = pricingCompleteness(productPricingDetails);
  if (!completeness.pricingComplete && (archived || requireComplete)) {
    const error = new Error(`成本待补，不能归档：${completeness.missingCostItems.map(item => item.productName || item.itemId).join('、')}`);
    error.status = 400;
    error.code = 'ORDER_COST_PENDING';
    throw error;
  }
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
    freight_cost_amount: values.freightCostAmount,
    // Numeric placeholder only; public responses mask incomplete draft profit.
    gross_profit_amount: completeness.pricingComplete ? values.grossProfitAmount : 0,
    payment_fee_details: values.paymentDetails,
    product_pricing_details: values.productPricingDetails,
    supplement_details: [...values.supplementDetails, ...values.freightCostDetails],
    snapshot_status: archived ? 'final' : 'draft',
    calculated_by: calculatedBy || 'system',
    calculated_at: new Date(),
    update_time: new Date()
  };

  if (!persist) return { gross_profit_id: existing?.gross_profit_id || null, ...payload };

  await OrderItem.update(
    { freight_cost: 0 },
    { where: { order_id: orderId }, transaction }
  );
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

async function refreshOutdatedGrossProfitSnapshots({ onProgress } = {}) {
  onProgress?.({ phase: 'load_outdated_snapshots' });
  const snapshots = await OrderGrossProfit.findAll({
    where: { formula_version: { [Op.ne]: FORMULA_VERSION } },
    attributes: ['order_id', 'snapshot_status'],
    raw: true
  });
  onProgress?.({ phase: 'load_missing_snapshots' });
  const missingSnapshots = await sequelize.query(
    `SELECT o.ORDER_ID AS order_id
       FROM T_ORDER o
       LEFT JOIN T_ORDER_GROSS_PROFIT gp
         ON gp.ORDER_ID = o.ORDER_ID
        AND gp.FORMULA_VERSION = :formulaVersion
      WHERE o.IS_DELETED = 0
        AND o.ORDER_STATUS IN (:archivedStatuses)
        AND gp.GROSS_PROFIT_ID IS NULL`,
    {
      replacements: {
        formulaVersion: FORMULA_VERSION,
        archivedStatuses: ['已归档', 'completed', 'archived', 'returned']
      },
      type: QueryTypes.SELECT
    }
  );
  const snapshotIds = new Set(snapshots.map(snapshot => String(snapshot.order_id)));
  missingSnapshots.forEach(snapshot => {
    if (!snapshotIds.has(String(snapshot.order_id))) {
      snapshots.push({ order_id: snapshot.order_id, snapshot_status: 'final' });
    }
  });
  let refreshed = 0;
  let failed = 0;
  onProgress?.({ phase: 'refreshing', total: snapshots.length, refreshed, failed });
  for (const snapshot of snapshots) {
    try {
      await calculateAndSaveOrderGrossProfit(snapshot.order_id, {
        calculatedBy: 'formula_migration',
        force: true,
        final: snapshot.snapshot_status === 'final'
      });
      refreshed += 1;
      if (refreshed % 10 === 0 || refreshed === snapshots.length) {
        onProgress?.({ phase: 'refreshing', total: snapshots.length, refreshed, failed });
      }
    } catch (error) {
      failed += 1;
      onProgress?.({ phase: 'failed', total: snapshots.length, refreshed, failed, orderId: snapshot.order_id, message: error.message });
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
  matchesFreightOrigin,
  resolveFreightOrigins,
  buildFreightCostDetails,
  isFreightRecordApplicableToOrder,
  resolveUnitProductPricing,
  resolveInventoryCostMode,
  calculateGrossProfitValues,
  calculateAndSaveOrderGrossProfit,
  validPrice,
  pricingCompleteness,
  createSalesReturnGrossProfitLedger,
  refreshOutdatedGrossProfitSnapshots,
  snapshotToResponse
};
