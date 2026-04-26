/**
 * 报表管理控制器
 */
const { Order, OrderItem, ProductSn, Product, Store } = require('../../models');
const { Op, sequelize } = require('sequelize');

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
    include: [{
      model: Order,
      where,
      attributes: []
    }],
    attributes: [
      [sequelize.col('Product.category'), 'category'],
      [sequelize.fn('COUNT', sequelize.col('order_item.item_id')), 'itemCount'],
      [sequelize.fn('SUM', sequelize.col('order_item.quantity')), 'totalQuantity'],
      [sequelize.fn('SUM', sequelize.col('order_item.subtotal')), 'totalAmount']
    ],
    include: [{
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

module.exports = { getSalesReport, getInventoryReport };
