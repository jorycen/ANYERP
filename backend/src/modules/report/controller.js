/**
 * 报表管理控制器
 */
const { Order, OrderItem, ProductSn, Product, ProductPrice, Store, sequelize } = require('../../models');
const { Op } = require('sequelize');

function toNumber(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
}

function roundMoney(value) {
  return Number(toNumber(value).toFixed(2));
}

function calcRate(value, base) {
  const denominator = toNumber(base);
  if (denominator === 0) return 0;
  return Number(((toNumber(value) / denominator) * 100).toFixed(2));
}

/**
 * 销售报表
 */
async function getSalesReport(ctx) {
  const { storeId, startDate, endDate } = ctx.query;
  const user = ctx.state.user;

  const whereStore = {};
  if (!user.regionCodes.includes('*')) {
    whereStore.region_id = user.regionCodes;
  }
  if (storeId) whereStore.store_id = storeId;

  const stores = await Store.findAll({ where: whereStore });
  const storeIds = stores.map(s => s.store_id);

  const where = {
    is_deleted: 0,
    store_id: storeIds
  };

  if (startDate && endDate) {
    where.create_time = {
      [Op.gte]: new Date(startDate),
      [Op.lte]: new Date(endDate + ' 23:59:59')
    };
  }

  // 按门店统计
  const statsByStore = await Order.findAll({
    where,
    attributes: [
      'store_id',
      [sequelize.fn('COUNT', sequelize.col('order_id')), 'orderCount'],
      [sequelize.fn('SUM', sequelize.col('total_amount')), 'totalAmount'],
      [sequelize.fn('SUM', sequelize.col('actual_payment')), 'actualPayment'],
      [sequelize.fn('SUM', sequelize.col('national_subsidy')), 'nationalSubsidy'],
      [sequelize.fn('SUM', sequelize.col('education_subsidy')), 'educationSubsidy']
    ],
    include: [{ model: Store, attributes: ['name'] }],
    group: ['store_id'],
    raw: true
  });

  // 按商品类别统计
  const statsByCategory = await OrderItem.findAll({
    where: { '$Order.store_id$': storeIds },
    attributes: [
      [sequelize.col('Product.category'), 'category'],
      [sequelize.fn('COUNT', sequelize.col('OrderItem.item_id')), 'itemCount'],
      [sequelize.fn('SUM', sequelize.col('OrderItem.quantity')), 'totalQuantity'],
      [sequelize.fn('SUM', sequelize.col('OrderItem.subtotal')), 'totalAmount']
    ],
    include: [{
      model: Order,
      where,
      attributes: []
    }, {
      model: Product,
      as: 'Product',
      attributes: []
    }],
    group: [sequelize.col('Product.category')],
    raw: true
  });

  // 按日期统计
  const statsByDate = await Order.findAll({
    where,
    attributes: [
      [sequelize.fn('DATE', sequelize.col('create_time')), 'date'],
      [sequelize.fn('COUNT', sequelize.col('order_id')), 'orderCount'],
      [sequelize.fn('SUM', sequelize.col('total_amount')), 'totalAmount']
    ],
    group: [sequelize.fn('DATE', sequelize.col('create_time'))],
    order: [[sequelize.fn('DATE', sequelize.col('create_time')), 'DESC']],
    raw: true
  });

  // 汇总
  const summary = await Order.findAll({
    where,
    attributes: [
      [sequelize.fn('COUNT', sequelize.col('order_id')), 'totalOrders'],
      [sequelize.fn('SUM', sequelize.col('total_amount')), 'totalSales'],
      [sequelize.fn('SUM', sequelize.col('actual_payment')), 'totalPayment']
    ],
    raw: true
  });

  ctx.body = {
    summary: summary[0] || {},
    statsByStore,
    statsByCategory,
    statsByDate
  };
}

/**
 * 库存报表
 */
async function getInventoryReport(ctx) {
  const { storeId, category } = ctx.query;
  const user = ctx.state.user;

  const whereStore = {};
  if (!user.regionCodes.includes('*')) {
    whereStore.region_id = user.regionCodes;
  }
  if (storeId) whereStore.store_id = storeId;

  const stores = await Store.findAll({ where: whereStore });
  const storeIds = stores.map(s => s.store_id);

  const whereSn = { is_deleted: 0, status: 'in_stock' };
  if (storeId) whereSn.store_id = storeId;

  // 在库统计
  const inStockStats = await ProductSn.findAll({
    where: whereSn,
    attributes: [
      'product_id',
      [sequelize.fn('COUNT', sequelize.col('sn_id')), 'inStockCount']
    ],
    include: [{
      model: Product,
      attributes: ['name', 'category']
    }],
    group: ['product_id'],
    raw: true
  });

  // 按类别汇总
  const categoryStats = await ProductSn.findAll({
    where: whereSn,
    attributes: [
      [sequelize.col('Product.category'), 'category'],
      [sequelize.fn('COUNT', sequelize.col('sn_id')), 'totalCount']
    ],
    include: [{
      model: Product,
      attributes: []
    }],
    group: [sequelize.col('Product.category')],
    raw: true
  });

  ctx.body = { inStockStats, categoryStats };
}

async function getEmployeePerformanceReport(ctx) {
  const { storeId, staffName, startDate, endDate, page = 1, pageSize = 20 } = ctx.query;
  const user = ctx.state.user;

  const whereStore = {};
  if (!user.regionCodes.includes('*')) {
    whereStore.region_id = user.regionCodes;
  }
  if (storeId) whereStore.store_id = storeId;

  const stores = await Store.findAll({ where: whereStore });
  const storeIds = stores.map(s => s.store_id);
  if (storeIds.length === 0) {
    ctx.body = { list: [], summary: {}, employees: [], pagination: { total: 0, page, pageSize, totalPages: 0 } };
    return;
  }

  const where = {
    is_deleted: 0,
    store_id: { [Op.in]: storeIds },
    order_status: { [Op.notIn]: ['cancelled', 'rejected'] }
  };
  if (staffName) where.create_user = staffName;
  if (startDate && endDate) {
    where.create_time = {
      [Op.gte]: new Date(startDate),
      [Op.lte]: new Date(`${endDate} 23:59:59`)
    };
  }

  const employees = await Order.findAll({
    where: {
      is_deleted: 0,
      store_id: { [Op.in]: storeIds },
      create_user: { [Op.ne]: null }
    },
    attributes: [[sequelize.fn('DISTINCT', sequelize.col('create_user')), 'name']],
    raw: true
  });

  const { count, rows: orders } = await Order.findAndCountAll({
    where,
    include: [
      { model: Store, attributes: ['store_id', 'name'] },
      { model: OrderItem }
    ],
    order: [['create_time', 'DESC']],
    offset: (Math.max(Number(page) || 1, 1) - 1) * Math.max(Number(pageSize) || 20, 1),
    limit: Math.max(Number(pageSize) || 20, 1),
    distinct: true
  });

  const allProductIds = [...new Set(orders.flatMap(order => (order.OrderItems || []).map(item => item.product_id)).filter(Boolean))];
  const allSnIds = [...new Set(orders.flatMap(order => (order.OrderItems || []).map(item => item.sn_id)).filter(Boolean))];
  const allSnCodes = [...new Set(orders.flatMap(order => (order.OrderItems || []).map(item => item.sn_code)).filter(Boolean))];

  const prices = allProductIds.length
    ? await ProductPrice.findAll({ where: { product_id: { [Op.in]: allProductIds } }, raw: true })
    : [];
  const priceMap = new Map(prices.map(price => [price.product_id, price]));

  const snWhere = { is_deleted: 0 };
  if (allSnIds.length > 0 && allSnCodes.length > 0) {
    snWhere[Op.or] = [{ sn_id: { [Op.in]: allSnIds } }, { sn_code: { [Op.in]: allSnCodes } }];
  } else if (allSnIds.length > 0) {
    snWhere.sn_id = { [Op.in]: allSnIds };
  } else if (allSnCodes.length > 0) {
    snWhere.sn_code = { [Op.in]: allSnCodes };
  }

  const snRows = (allSnIds.length > 0 || allSnCodes.length > 0)
    ? await ProductSn.findAll({ where: snWhere, raw: true })
    : [];
  const snMapById = new Map(snRows.map(sn => [sn.sn_id, sn]));
  const snMapByCode = new Map(snRows.map(sn => [sn.sn_code, sn]));

  const list = orders.map(order => {
    const orderJson = order.toJSON();
    const items = orderJson.OrderItems || [];
    const totalAmount = roundMoney(orderJson.total_amount);
    const actualPayment = roundMoney(orderJson.actual_payment);
    const totalReduction = roundMoney(totalAmount - actualPayment);

    let totalCost = 0;
    const itemCalculations = items.map(item => {
      const quantity = Number(item.quantity || 1);
      const saleSubtotal = roundMoney(item.subtotal || (toNumber(item.sale_price) * quantity));
      const revenueRatio = totalAmount > 0 ? saleSubtotal / totalAmount : 0;
      const allocatedReduction = roundMoney(totalReduction * revenueRatio);
      const allocatedRevenue = roundMoney(saleSubtotal - allocatedReduction);
      const sn = item.sn_id ? snMapById.get(item.sn_id) : snMapByCode.get(item.sn_code);
      const price = priceMap.get(item.product_id);
      const unitCost = roundMoney(sn?.inbound_price || price?.cost_price || 0);
      const costAmount = roundMoney(unitCost * quantity);
      const grossProfit = roundMoney(allocatedRevenue - costAmount);
      totalCost += costAmount;
      return {
        productName: item.product_name,
        pnCode: item.pn_code || '',
        snCode: item.sn_code || '',
        quantity,
        salePrice: roundMoney(item.sale_price),
        saleSubtotal,
        allocatedReduction,
        allocatedRevenue,
        unitCost,
        costAmount,
        grossProfit,
        formula: `${allocatedRevenue.toFixed(2)} - (${unitCost.toFixed(2)} × ${quantity}) = ${grossProfit.toFixed(2)}`
      };
    });

    totalCost = roundMoney(totalCost);
    const grossProfit = roundMoney(actualPayment - totalCost);
    return {
      orderId: orderJson.order_id,
      orderNo: orderJson.order_no,
      orderTime: orderJson.create_time,
      employeeName: orderJson.create_user || '-',
      storeName: orderJson.Store?.name || '',
      customerName: orderJson.customer_name || '',
      totalAmount,
      discountAmount: roundMoney(orderJson.discount_amount),
      nationalSubsidy: roundMoney(orderJson.national_subsidy),
      educationSubsidy: roundMoney(orderJson.education_subsidy),
      actualPayment,
      totalCost,
      grossProfit,
      grossRate: calcRate(grossProfit, actualPayment),
      calculation: {
        orderFormula: `${actualPayment.toFixed(2)} - ${totalCost.toFixed(2)} = ${grossProfit.toFixed(2)}`,
        revenueNote: `实收 ${actualPayment.toFixed(2)} = 销售额 ${totalAmount.toFixed(2)} - 优惠/补贴 ${totalReduction.toFixed(2)}`,
        items: itemCalculations
      }
    };
  });

  const summaryRows = await Order.findAll({
    where,
    attributes: [
      'create_user',
      [sequelize.fn('COUNT', sequelize.col('order_id')), 'orderCount'],
      [sequelize.fn('SUM', sequelize.col('total_amount')), 'totalAmount'],
      [sequelize.fn('SUM', sequelize.col('actual_payment')), 'actualPayment']
    ],
    group: ['create_user'],
    raw: true
  });

  const summary = {
    orderCount: summaryRows.reduce((sum, row) => sum + Number(row.orderCount || 0), 0),
    totalAmount: roundMoney(summaryRows.reduce((sum, row) => sum + toNumber(row.totalAmount), 0)),
    actualPayment: roundMoney(summaryRows.reduce((sum, row) => sum + toNumber(row.actualPayment), 0)),
    pageGrossProfit: roundMoney(list.reduce((sum, row) => sum + toNumber(row.grossProfit), 0))
  };

  ctx.body = {
    list,
    summary,
    employees: employees.map(item => item.name).filter(Boolean).sort(),
    pagination: {
      total: count,
      page: Number(page),
      pageSize: Number(pageSize),
      totalPages: Math.ceil(count / Number(pageSize || 20))
    }
  };
}

module.exports = { getSalesReport, getInventoryReport, getEmployeePerformanceReport };
