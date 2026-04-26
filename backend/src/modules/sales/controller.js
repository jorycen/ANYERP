/**
 * 销售管理控制器
 */
const { Order, OrderItem, OrderPayment, OrderAttachment, Store, Staff } = require('../../models');
const { Op } = require('sequelize');
const { generateOrderNo, generateUUID, paginate, formatPaginatedResult } = require('../../utils');

/**
 * 销售订单列表
 */
async function list(ctx) {
  const { storeId, startDate, endDate, customerPhone, page = 1, pageSize = 20 } = ctx.query;
  const user = ctx.state.user;

  const where = { is_deleted: 0 };
  const whereStore = {};

  // 区域权限过滤
  if (!user.regionCodes.includes('*')) {
    whereStore.region_id = user.regionCodes;
  }
  if (storeId) whereStore.store_id = storeId;

  // 日期范围
  if (startDate) {
    where.create_time = { [Op.gte]: new Date(startDate) };
  }
  if (endDate) {
    where.create_time = { ...where.create_time, [Op.lte]: new Date(endDate + ' 23:59:59') };
  }
  if (customerPhone) {
    where.customer_phone = { [Op.like]: `%${customerPhone}%` };
  }

  const stores = await Store.findAll({ where: whereStore });
  const storeIds = stores.map(s => s.store_id);
  where.store_id = storeIds;

  const { count, rows } = await Order.findAndCountAll({
    where,
    include: [
      { model: Store },
      { model: OrderItem },
      { model: OrderPayment }
    ],
    order: [['create_time', 'DESC']],
    ...paginate({}, { page, pageSize })
  });

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

/**
 * 创建销售订单
 */
async function create(ctx) {
  const user = ctx.state.user;
  const {
    customerName, customerPhone, customerSource,
    items, payments, discountAmount = 0,
    nationalSubsidy = 0, educationSubsidy = 0,
    invoiceStatus = '不开票', remark
  } = ctx.request.body;

  // 生成订单号
  const orderNo = generateOrderNo();
  const orderId = generateUUID();

  // 计算订单总金额
  const totalAmount = items.reduce((sum, item) => sum + Number(item.subtotal), 0);
  const actualPayment = totalAmount - Number(discountAmount) - Number(nationalSubsidy) - Number(educationSubsidy);

  // 创建订单
  const order = await Order.create({
    order_id: orderId,
    order_no: orderNo,
    store_id: user.storeId || ctx.request.body.storeId,
    create_user: user.name,
    customer_name: customerName,
    customer_phone: customerPhone,
    customer_source: customerSource,
    total_amount: totalAmount,
    discount_amount: discountAmount,
    national_subsidy: nationalSubsidy,
    education_subsidy: educationSubsidy,
    actual_payment: actualPayment,
    invoice_status: invoiceStatus,
    order_status: 'completed',
    remark
  });

  // 创建订单明细
  for (const item of items) {
    await OrderItem.create({
      order_id: orderId,
      product_id: item.productId,
      product_name: item.productName,
      pn_code: item.pnCode,
      sn_id: item.snId,
      sn_code: item.snCode,
      imei1: item.imei1,
      imei2: item.imei2,
      sale_price: item.salePrice,
      quantity: item.quantity || 1,
      subtotal: item.subtotal
    });
  }

  // 创建支付记录
  for (const payment of payments) {
    await OrderPayment.create({
      order_id: orderId,
      payment_method: payment.method,
      amount: payment.amount
    });
  }

  ctx.body = { orderId, orderNo, message: '订单创建成功' };
}

/**
 * 订单详情
 */
async function detail(ctx) {
  const { orderId } = ctx.params;

  const order = await Order.findByPk(orderId, {
    include: [
      { model: Store },
      { model: OrderItem },
      { model: OrderPayment },
      { model: OrderAttachment }
    ]
  });

  if (!order) {
    ctx.throw(404, '订单不存在');
  }

  ctx.body = order;
}

/**
 * 更新订单
 */
async function update(ctx) {
  const { orderId } = ctx.params;
  const data = ctx.request.body;

  const order = await Order.findByPk(orderId);
  if (!order) {
    ctx.throw(404, '订单不存在');
  }

  await order.update(data);
  ctx.body = { message: '订单更新成功' };
}

/**
 * 销售统计
 */
async function stats(ctx) {
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
      [sequelize.fn('SUM', sequelize.col('actual_payment')), 'actualPayment']
    ],
    include: [{ model: Store, attributes: ['name'] }],
    group: ['store_id'],
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

  ctx.body = { statsByStore, statsByDate };
}

module.exports = { list, create, detail, update, stats };
