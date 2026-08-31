const {
  Order,
  OrderItem,
  OrderGrossProfit,
  SalesReturnRequestItem,
  Product,
  ProductPrice,
  ProductSn,
  Store,
  ProductSettlementOrder,
  ProductSettlementItem,
  ProductSettlementAdjustment,
  ProductSettlementAdjustmentItem,
  sequelize
} = require('../../models');
const { Op, QueryTypes } = require('sequelize');
const { generateUUID } = require('../../utils');

const PRODUCT_SETTLEMENT_FORMULA_VERSION = 'PRODUCT_GP_V1_20260831';
const ARCHIVED_ORDER_STATUSES = new Set(['已归档', 'completed', 'archived']);

function toNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function money(value) {
  return Number(toNumber(value).toFixed(2));
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

function normalizePricingDetails(snapshot) {
  const rows = parseJsonArray(snapshot?.product_pricing_details || snapshot?.settlement_cost_details);
  return new Map(rows.map(row => [String(row.itemId ?? row.item_id ?? ''), row]));
}

function buildProductSettlementItem({ item, product, productPrice, productPricingDetail, sn }) {
  const quantity = Math.max(1, Math.trunc(toNumber(item.quantity) || 1));
  const productUnitPrice = money(
    productPricingDetail?.unitPricing
      ?? productPricingDetail?.unit_pricing
      ?? productPrice?.standard_price
  );
  const productPriceSource = String(
    productPricingDetail?.source
      || (productPricingDetail?.isSpecialPrice ? 'sn_special_price' : 'product_standard_price')
  );

  const isSn = Boolean(item.sn_id || item.sn_code || Number(product?.need_sn) === 1);
  const rawCost = isSn
    ? toNumber(item.original_inventory_cost) || toNumber(item.original_pickup_price)
      || toNumber(sn?.inbound_price) || toNumber(sn?.original_pickup_price)
    : toNumber(item.original_inventory_cost) || toNumber(productPrice?.cost_price);
  const purchaseUnitCost = money(rawCost);
  const costStatus = productUnitPrice > 0 && purchaseUnitCost > 0 ? 'ready' : 'pending';
  const costMethod = isSn ? 'sn_actual_cost' : 'weighted_average';
  const costSource = isSn
    ? (item.original_inventory_cost > 0 || item.original_pickup_price > 0 || sn?.inbound_price > 0
      ? 'order_item_or_sn_inbound_cost' : 'missing_sn_cost')
    : (item.original_inventory_cost > 0 ? 'order_item_cost_snapshot' : 'product_price_cost_price');
  const productPricingAmount = money(productUnitPrice * quantity);
  const purchaseCostAmount = money(purchaseUnitCost * quantity);

  return {
    source_order_item_id: item.item_id,
    product_id: item.product_id || null,
    product_name: item.product_name || product?.name || '',
    pn_code: item.pn_code || '',
    sn_id: item.sn_id || sn?.sn_id || null,
    sn_code: item.sn_code || sn?.sn_code || '',
    quantity,
    product_unit_price: productUnitPrice,
    product_price_source: productPriceSource,
    purchase_unit_cost: purchaseUnitCost,
    purchase_cost_amount: purchaseCostAmount,
    cost_method: costMethod,
    cost_source: costSource,
    cost_status: costStatus,
    gross_profit_amount: costStatus === 'ready'
      ? money(productPricingAmount - purchaseCostAmount)
      : 0
  };
}

function summarizeProductSettlementItems(items) {
  const productPricingAmount = money(items.reduce((sum, item) => sum + toNumber(item.product_unit_price) * toNumber(item.quantity), 0));
  const purchaseCostAmount = money(items.reduce((sum, item) => sum + toNumber(item.purchase_cost_amount), 0));
  const costPendingAmount = money(items
    .filter(item => item.cost_status !== 'ready')
    .reduce((sum, item) => sum + toNumber(item.product_unit_price) * toNumber(item.quantity), 0));
  const grossProfitAmount = items.some(item => item.cost_status !== 'ready')
    ? 0
    : money(productPricingAmount - purchaseCostAmount);
  return {
    productPricingAmount,
    purchaseCostAmount,
    costPendingAmount,
    grossProfitAmount,
    status: items.some(item => item.cost_status !== 'ready') ? 'cost_pending' : 'posted'
  };
}

async function createProductSettlementOrder({ orderId, transaction = null, createdBy = 'system' } = {}) {
  const existing = await ProductSettlementOrder.findOne({
    where: { source_order_id: orderId },
    transaction,
    lock: transaction?.LOCK?.UPDATE
  });
  if (existing) return existing;

  const order = await Order.findByPk(orderId, { transaction, raw: true });
  if (!order) throw new Error(`销售订单不存在：${orderId}`);
  if (!ARCHIVED_ORDER_STATUSES.has(String(order.order_status || ''))) {
    throw new Error('只有最终归档的销售订单可以生成产品端结算单');
  }

  const [items, snapshot, store] = await Promise.all([
    OrderItem.findAll({ where: { order_id: orderId }, transaction, raw: true }),
    OrderGrossProfit.findOne({ where: { order_id: orderId }, transaction, raw: true }),
    Store.findByPk(order.store_id, { attributes: ['store_id', 'distributor_id', 'region_id'], transaction, raw: true })
  ]);
  const productIds = [...new Set(items.map(item => item.product_id).filter(Boolean))];
  const snCodes = [...new Set(items.map(item => item.sn_code).filter(Boolean))];
  const [products, prices, sns] = await Promise.all([
    productIds.length ? Product.findAll({ where: { product_id: { [Op.in]: productIds } }, transaction, raw: true }) : [],
    productIds.length ? ProductPrice.findAll({ where: { product_id: { [Op.in]: productIds } }, transaction, raw: true }) : [],
    snCodes.length ? ProductSn.findAll({ where: { sn_code: { [Op.in]: snCodes } }, transaction, raw: true }) : []
  ]);
  const productMap = new Map(products.map(product => [String(product.product_id), product]));
  const priceMap = new Map(prices.map(price => [String(price.product_id), price]));
  const snMap = new Map(sns.map(sn => [String(sn.sn_code), sn]));
  const pricingMap = normalizePricingDetails(snapshot);
  const settlementItems = items.map(item => buildProductSettlementItem({
    item,
    product: productMap.get(String(item.product_id || '')),
    productPrice: priceMap.get(String(item.product_id || '')),
    productPricingDetail: pricingMap.get(String(item.item_id)) || null,
    sn: snMap.get(String(item.sn_code || '')) || null
  }));
  const summary = summarizeProductSettlementItems(settlementItems);
  const settlementId = generateUUID();
  const settlement = await ProductSettlementOrder.create({
    settlement_id: settlementId,
    settlement_no: `PSET${String(order.order_no || settlementId).replace(/[^A-Za-z0-9]/g, '').slice(-24)}`,
    source_order_id: order.order_id,
    source_order_no: order.order_no,
    distributor_id: store?.distributor_id || null,
    region_id: store?.region_id || null,
    store_id: order.store_id,
    business_date: order.create_time || new Date(),
    product_pricing_amount: summary.productPricingAmount,
    purchase_cost_amount: summary.purchaseCostAmount,
    gross_profit_amount: summary.grossProfitAmount,
    cost_pending_amount: summary.costPendingAmount,
    status: summary.status,
    formula_version: PRODUCT_SETTLEMENT_FORMULA_VERSION,
    create_user: createdBy,
    create_time: new Date(),
    update_time: new Date()
  }, { transaction });
  await ProductSettlementItem.bulkCreate(
    settlementItems.map(item => ({ settlement_id: settlementId, create_time: new Date(), ...item })),
    { transaction }
  );
  return settlement;
}

async function createProductSettlementReturnAdjustment({ returnRequest, transaction = null, createdBy = 'system' } = {}) {
  if (!returnRequest?.return_id || !returnRequest?.order_id) return null;
  const existing = await ProductSettlementAdjustment.findOne({
    where: { source_return_id: returnRequest.return_id },
    transaction,
    lock: transaction?.LOCK?.UPDATE
  });
  if (existing) return existing;

  const sourceSettlement = await ProductSettlementOrder.findOne({
    where: { source_order_id: returnRequest.order_id },
    include: [{ model: ProductSettlementItem, as: 'items' }],
    transaction,
    lock: transaction?.LOCK?.UPDATE
  });
  if (!sourceSettlement) return null;
  const returnItems = await SalesReturnRequestItem.findAll({
    where: { return_id: returnRequest.return_id },
    transaction,
    raw: true
  });
  const sourceItems = new Map((sourceSettlement.items || []).map(item => [String(item.source_order_item_id), item]));
  const adjustmentItems = [];
  for (const returnItem of returnItems) {
    const sourceItem = sourceItems.get(String(returnItem.order_item_id));
    if (!sourceItem) continue;
    const quantity = Math.min(
      Math.max(1, Math.trunc(toNumber(returnItem.quantity) || 1)),
      Math.max(1, Math.trunc(toNumber(sourceItem.quantity) || 1))
    );
    const productPricingAmount = -money(toNumber(sourceItem.product_unit_price) * quantity);
    const purchaseCostAmount = sourceItem.cost_status === 'ready'
      ? -money(toNumber(sourceItem.purchase_unit_cost) * quantity)
      : 0;
    adjustmentItems.push({
      source_return_item_id: returnItem.item_id,
      source_order_item_id: sourceItem.source_order_item_id,
      product_id: sourceItem.product_id,
      product_name: sourceItem.product_name,
      pn_code: sourceItem.pn_code,
      sn_id: sourceItem.sn_id,
      sn_code: sourceItem.sn_code,
      quantity: -quantity,
      product_unit_price: sourceItem.product_unit_price,
      product_pricing_amount: productPricingAmount,
      purchase_unit_cost: sourceItem.purchase_unit_cost,
      purchase_cost_amount: purchaseCostAmount,
      cost_method: sourceItem.cost_method,
      cost_status: sourceItem.cost_status,
      gross_profit_amount: sourceItem.cost_status === 'ready'
        ? money(productPricingAmount - purchaseCostAmount)
        : 0
    });
  }
  if (!adjustmentItems.length) return null;

  const ready = adjustmentItems.every(item => item.cost_status === 'ready');
  const summary = {
    productPricingAmount: money(adjustmentItems.reduce((sum, item) => sum + toNumber(item.product_pricing_amount), 0)),
    purchaseCostAmount: money(adjustmentItems.reduce((sum, item) => sum + toNumber(item.purchase_cost_amount), 0)),
    grossProfitAmount: ready ? money(adjustmentItems.reduce((sum, item) => sum + toNumber(item.gross_profit_amount), 0)) : 0,
    costPendingAmount: ready ? 0 : money(adjustmentItems.reduce((sum, item) => sum + Math.abs(toNumber(item.product_pricing_amount)), 0)),
    status: ready ? 'posted' : 'cost_pending'
  };
  const adjustmentId = generateUUID();
  const adjustment = await ProductSettlementAdjustment.create({
    adjustment_id: adjustmentId,
    adjustment_no: `PSET-RET-${String(returnRequest.return_no || adjustmentId).replace(/[^A-Za-z0-9]/g, '').slice(-22)}`,
    source_return_id: returnRequest.return_id,
    source_return_no: returnRequest.return_no,
    source_order_id: sourceSettlement.source_order_id,
    source_order_no: sourceSettlement.source_order_no,
    distributor_id: sourceSettlement.distributor_id,
    region_id: sourceSettlement.region_id,
    store_id: sourceSettlement.store_id,
    business_date: returnRequest.update_time || returnRequest.create_time || new Date(),
    product_pricing_amount: summary.productPricingAmount,
    purchase_cost_amount: summary.purchaseCostAmount,
    gross_profit_amount: summary.grossProfitAmount,
    cost_pending_amount: summary.costPendingAmount,
    status: summary.status,
    formula_version: PRODUCT_SETTLEMENT_FORMULA_VERSION,
    create_user: createdBy,
    create_time: new Date()
  }, { transaction });
  await ProductSettlementAdjustmentItem.bulkCreate(
    adjustmentItems.map(item => ({ adjustment_id: adjustmentId, create_time: new Date(), ...item })),
    { transaction }
  );
  return adjustment;
}

async function queryProductSettlementSummary({ startDate, endDate, storeIds = [] } = {}) {
  if (!storeIds.length) return {
    productPricingAmount: 0,
    purchaseCostAmount: 0,
    grossProfitAmount: 0,
    orderCount: 0,
    costPendingOrderCount: 0,
    costPendingAmount: 0
  };
  try {
    const rows = await sequelize.query(
      `SELECT
          ROUND(COALESCE(SUM(CASE WHEN STATUS = 'posted' THEN PRODUCT_PRICING_AMOUNT ELSE 0 END), 0), 2) AS productPricingAmount,
          ROUND(COALESCE(SUM(CASE WHEN STATUS = 'posted' THEN PURCHASE_COST_AMOUNT ELSE 0 END), 0), 2) AS purchaseCostAmount,
          ROUND(COALESCE(SUM(CASE WHEN STATUS = 'posted' THEN GROSS_PROFIT_AMOUNT ELSE 0 END), 0), 2) AS grossProfitAmount,
          COUNT(CASE WHEN STATUS = 'posted' THEN 1 END) AS orderCount,
          COUNT(CASE WHEN STATUS = 'cost_pending' THEN 1 END) AS costPendingOrderCount,
          ROUND(COALESCE(SUM(COST_PENDING_AMOUNT), 0), 2) AS costPendingAmount
       FROM (
         SELECT STORE_ID, BUSINESS_DATE, STATUS, PRODUCT_PRICING_AMOUNT, PURCHASE_COST_AMOUNT, GROSS_PROFIT_AMOUNT, COST_PENDING_AMOUNT
           FROM T_PRODUCT_SETTLEMENT_ORDER
          UNION ALL
         SELECT STORE_ID, BUSINESS_DATE, STATUS, PRODUCT_PRICING_AMOUNT, PURCHASE_COST_AMOUNT, GROSS_PROFIT_AMOUNT, COST_PENDING_AMOUNT
           FROM T_PRODUCT_SETTLEMENT_ADJUSTMENT
       ) entries
      WHERE STORE_ID IN (:storeIds)
        AND BUSINESS_DATE >= :startDate
        AND BUSINESS_DATE < DATE_ADD(:endDate, INTERVAL 1 DAY)`,
      { replacements: { storeIds, startDate, endDate }, type: QueryTypes.SELECT }
    );
    const row = rows[0] || {};
    return {
      productPricingAmount: money(row.productPricingAmount),
      purchaseCostAmount: money(row.purchaseCostAmount),
      grossProfitAmount: money(row.grossProfitAmount),
      orderCount: Number(row.orderCount || 0),
      costPendingOrderCount: Number(row.costPendingOrderCount || 0),
      costPendingAmount: money(row.costPendingAmount)
    };
  } catch (error) {
    // 兼容尚未完成数据库迁移的旧实例，不能阻断原有财务总览。
    if (/doesn't exist|不存在|unknown table|no such table/i.test(String(error.message || ''))) {
      return {
        productPricingAmount: 0,
        purchaseCostAmount: 0,
        grossProfitAmount: 0,
        orderCount: 0,
        costPendingOrderCount: 0,
        costPendingAmount: 0
      };
    }
    throw error;
  }
}

async function listProductSettlementOrders({ storeIds = [], startDate, endDate, status, page = 1, pageSize = 20 } = {}) {
  const where = { store_id: { [Op.in]: storeIds.length ? storeIds : ['__NO_STORE__'] } };
  if (status) where.status = status;
  if (startDate || endDate) {
    where.business_date = {};
    if (startDate) where.business_date[Op.gte] = startDate;
    if (endDate) where.business_date[Op.lt] = endDate;
  }
  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safePageSize = Math.min(100, Math.max(1, Number.parseInt(pageSize, 10) || 20));
  const { count, rows } = await ProductSettlementOrder.findAndCountAll({
    where,
    order: [['business_date', 'DESC'], ['settlement_id', 'DESC']],
    limit: safePageSize,
    offset: (safePage - 1) * safePageSize,
    raw: true
  });
  return {
    items: rows.map(row => ({
      settlementId: row.settlement_id,
      settlementNo: row.settlement_no,
      sourceOrderId: row.source_order_id,
      sourceOrderNo: row.source_order_no,
      distributorId: row.distributor_id,
      regionId: row.region_id,
      storeId: row.store_id,
      businessDate: row.business_date,
      productPricingAmount: money(row.product_pricing_amount),
      purchaseCostAmount: money(row.purchase_cost_amount),
      grossProfitAmount: money(row.gross_profit_amount),
      costPendingAmount: money(row.cost_pending_amount),
      status: row.status,
      formulaVersion: row.formula_version
    })),
    total: count,
    page: safePage,
    pageSize: safePageSize
  };
}

module.exports = {
  PRODUCT_SETTLEMENT_FORMULA_VERSION,
  createProductSettlementOrder,
  createProductSettlementReturnAdjustment,
  queryProductSettlementSummary,
  listProductSettlementOrders,
  _test: {
    buildProductSettlementItem,
    summarizeProductSettlementItems,
    normalizePricingDetails
  }
};
