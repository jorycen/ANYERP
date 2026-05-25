/**
 * 销售管理控制器
 */
const { Order, OrderItem, OrderPayment, OrderAttachment, Store, Staff, Product, ProductPn, ProductSn, ProductPrice, Inventory, PaymentMethod, sequelize } = require('../../models');
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

  if (!user.regionCodes.includes('*')) {
    whereStore.region_id = user.regionCodes;
  }
  if (storeId) whereStore.store_id = storeId;

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
 * 检查销售价格是否需要审批（价格从ProductPrice表读取）
 */
async function checkPriceApproval(items) {
  const productIds = [...new Set(items.map(i => i.productId).filter(Boolean))];
  if (productIds.length === 0) return [];

  const productPrices = await ProductPrice.findAll({
    where: { product_id: { [Op.in]: productIds } }
  });
  const priceMap = new Map();
  productPrices.forEach(p => priceMap.set(p.product_id, p));

  const belowPriceItems = [];
  for (const item of items) {
    const price = priceMap.get(item.productId);
    if (!price || !price.min_sale_price || parseFloat(price.min_sale_price) <= 0) continue;
    const minPrice = parseFloat(price.min_sale_price);
    if (parseFloat(item.salePrice) < minPrice) {
      belowPriceItems.push({
        productId: item.productId,
        productName: item.productName,
        salePrice: item.salePrice,
        standardPrice: price.standard_price,
        minSalePrice: price.min_sale_price
      });
    }
  }
  return belowPriceItems;
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
    invoiceStatus = '不开票', remark, storeId
  } = ctx.request.body;

  const orderNo = generateOrderNo();
  const orderId = generateUUID();
  const actualStoreId = storeId || user.storeId || '';

  const totalAmount = items.reduce((sum, item) => sum + Number(item.subtotal || 0), 0);
  const actualPayment = totalAmount - Number(discountAmount) - Number(nationalSubsidy) - Number(educationSubsidy);

  const belowPriceItems = await checkPriceApproval(items);
  const needsApproval = belowPriceItems.length > 0;

  const productIds = [...new Set(items.map(i => i.productId).filter(Boolean))];
  const products = await Product.findAll({
    where: { product_id: { [Op.in]: productIds } }
  });
  const productMap = new Map();
  products.forEach(p => productMap.set(p.product_id, p));

  for (const item of items) {
    const product = productMap.get(item.productId);
    if (!product) {
      ctx.throw(400, `商品 ${item.productId} 不存在`);
    }

    const quantity = item.quantity || 1;

    if (product.need_sn === 1) {
      if (!item.snCode || item.snCode.trim() === '') {
        ctx.throw(400, `商品 ${item.productName} 需要SN管理，请选择SN码`);
      }

      const snRecord = await ProductSn.findOne({
        where: {
          sn_code: item.snCode.trim(),
          product_id: item.productId,
          store_id: actualStoreId,
          status: 'in_stock',
          is_deleted: 0
        }
      });
      if (!snRecord) {
        ctx.throw(400, `SN码 [${item.snCode}] 在当前门店不存在或已售出`);
      }

      if (item.pnCode && snRecord.pn_code && item.pnCode.trim() !== snRecord.pn_code) {
        ctx.throw(400, `SN码 [${item.snCode}] 的厂商编码(${snRecord.pn_code})与所选编码(${item.pnCode})不一致`);
      }

      item.snId = snRecord.sn_id;
      item.inventoryType = snRecord.inventory_type || 'normal_qty';
    } else {
      if (actualStoreId) {
        const inv = await Inventory.findOne({
          where: { product_id: item.productId, store_id: actualStoreId }
        });
        const totalStock = inv ? ((inv.normal_qty || 0) + (inv.display_qty || 0)) : 0;
        if (totalStock < quantity) {
          ctx.throw(400, `商品 ${item.productName} 库存不足(可用:${totalStock}, 需要:${quantity})`);
        }
      }
    }

    if (item.pnCode && item.pnCode.trim()) {
      const pnExists = await ProductPn.findOne({
        where: { product_id: item.productId, pn_code: item.pnCode.trim(), is_deleted: 0 }
      });
      if (!pnExists) {
        const pnInSn = await ProductSn.findOne({
          where: { product_id: item.productId, pn_code: item.pnCode.trim(), status: 'in_stock', is_deleted: 0 }
        });
        if (!pnInSn) {
          ctx.throw(400, `厂商编码 [${item.pnCode}] 在商品 ${item.productName} 中不存在`);
        }
      }
    }
  }

  const orderStatus = needsApproval ? 'pending_approval' : 'completed';

  const order = await Order.create({
    order_id: orderId,
    order_no: orderNo,
    store_id: actualStoreId,
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
    order_status: orderStatus,
    remark: remark || (needsApproval ? '售价低于定价, 待审批' : '')
  });

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

  // 不需要审批的订单直接扣减库存
  if (!needsApproval) {
    for (const item of items) {
      const product = productMap.get(item.productId);
      const quantity = item.quantity || 1;

      if (product && product.need_sn === 1) {
        if (item.snId) {
          await ProductSn.update(
            { status: 'sold' },
            { where: { sn_id: item.snId } }
          );
        }
      }

      if (actualStoreId) {
        await _deductInventory(item.productId, actualStoreId, item.inventoryType || 'normal_qty', quantity);
      }
    }
  }

  for (const payment of payments) {
    await OrderPayment.create({
      order_id: orderId,
      payment_method: payment.method,
      amount: payment.amount
    });
  }

  if (!needsApproval) {
    syncToDailyStatement(orderId, actualStoreId).catch(err => console.error('[DailySync] create error:', err.message));
  }

  ctx.body = {
    orderId, orderNo,
    needsApproval,
    belowPriceItems,
    message: needsApproval ? '订单已创建，售价低于定价需要审批' : '订单创建成功'
  };
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
 * 审批通过
 */
async function approve(ctx) {
  const { orderId } = ctx.params;
  const user = ctx.state.user;

  const allowedRoles = ['boss', 'admin', 'manager'];
  if (!allowedRoles.includes(user.roleCode)) {
    ctx.throw(403, '仅店长或经销商总账号可以审批');
  }

  const order = await Order.findByPk(orderId);
  if (!order) ctx.throw(404, '订单不存在');
  if (order.order_status !== 'pending_approval') {
    ctx.throw(400, '该订单无需审批');
  }

  // 扣减库存
  const items = await OrderItem.findAll({ where: { order_id: orderId } });
  const productIds = [...new Set(items.map(i => i.product_id))];
  const products = await Product.findAll({ where: { product_id: { [Op.in]: productIds } } });
  const productMap = new Map();
  products.forEach(p => productMap.set(p.product_id, p));

  for (const item of items) {
    const product = productMap.get(item.product_id);
    const quantity = item.quantity || 1;

    let inventoryType = 'normal_qty';

    if (product && product.need_sn === 1) {
      if (item.sn_id) {
        const snRecord = await ProductSn.findByPk(item.sn_id);
        if (snRecord) {
          inventoryType = snRecord.inventory_type || 'normal_qty';
          await snRecord.update({ status: 'sold' });
        }
      }
    }

    if (order.store_id) {
      await _deductInventory(item.product_id, order.store_id, inventoryType, quantity);
    }
  }

  await order.update({
    order_status: 'completed',
    remark: (order.remark || '') + '\n已审批通过',
    update_time: new Date()
  });

  syncToDailyStatement(orderId, order.store_id).catch(err => console.error('[DailySync] approve error:', err.message));

  ctx.body = { code: 0, message: '审批通过，订单已完成' };
}

/**
 * 审批拒绝
 */
async function reject(ctx) {
  const { orderId } = ctx.params;
  const user = ctx.state.user;

  const allowedRoles = ['boss', 'admin', 'manager'];
  if (!allowedRoles.includes(user.roleCode)) {
    ctx.throw(403, '仅店长或经销商总账号可以审批');
  }

  const order = await Order.findByPk(orderId);
  if (!order) ctx.throw(404, '订单不存在');
  if (order.order_status !== 'pending_approval') {
    ctx.throw(400, '该订单无需审批');
  }

  const { reason } = ctx.request.body;

  await order.update({
    order_status: 'cancelled',
    remark: (order.remark || '') + '\n审批拒绝: ' + (reason || '无'),
    update_time: new Date()
  });

  ctx.body = { code: 0, message: '已拒绝' };
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

  ctx.body = { statsByStore };
}

/**
 * 获取支付方式列表
 */
async function paymentMethods(ctx) {
  const methods = await PaymentMethod.findAll({
    where: { status: 1 },
    order: [['sort_order', 'ASC']]
  });
  ctx.body = { code: 0, data: methods, message: 'success' };
}

async function getProductPns(ctx) {
  const { storeId, productId } = ctx.params;

  const pnRecords = await ProductPn.findAll({
    where: { product_id: productId, is_deleted: 0 }
  });

  let snPns = [];
  if (storeId) {
    const snRecords = await ProductSn.findAll({
      where: {
        product_id: productId,
        store_id: storeId,
        status: 'in_stock',
        is_deleted: 0
      },
      attributes: ['pn_code'],
      group: ['pn_code'],
      raw: true
    });
    snPns = snRecords.map(s => s.pn_code).filter(Boolean);
  }

  const allPnCodes = new Set();
  for (const pn of pnRecords) {
    if (pn.pn_code) allPnCodes.add(pn.pn_code);
  }
  for (const code of snPns) {
    allPnCodes.add(code);
  }

  ctx.body = { code: 0, data: [...allPnCodes] };
}

async function getProductSns(ctx) {
  const { storeId, productId } = ctx.params;
  const { pnCode } = ctx.query;

  const where = {
    product_id: productId,
    store_id: storeId,
    status: 'in_stock',
    is_deleted: 0
  };
  if (pnCode) {
    where.pn_code = pnCode;
  }

  const snRecords = await ProductSn.findAll({
    where,
    attributes: ['sn_id', 'sn_code', 'pn_code', 'inventory_type'],
    order: [['sn_code', 'ASC']]
  });

  ctx.body = {
    code: 0,
    data: snRecords.map(s => ({
      sn_id: s.sn_id,
      sn_code: s.sn_code,
      pn_code: s.pn_code,
      inventory_type: s.inventory_type
    }))
  };
}

module.exports = { list, create, detail, update, stats, approve, reject, paymentMethods, getProductPns, getProductSns };

const INVENTORY_COLUMN_MAP = {
  normal_qty: 'normal_qty',
  display_qty: 'display_qty',
  demo_qty: 'demo_qty',
  unsellable_qty: 'unsellable_qty',
  pending_qty: 'pending_qty'
};

async function _deductInventory(productId, storeId, inventoryType, quantity) {
  const column = INVENTORY_COLUMN_MAP[inventoryType] || 'normal_qty';
  const inv = await Inventory.findOne({
    where: { product_id: productId, store_id: storeId }
  });
  if (inv) {
    const currentVal = inv[column] || 0;
    const newVal = Math.max(0, currentVal - quantity);
    await inv.update({ [column]: newVal });
  }
}

/**
 * 同步已完成订单到日结单
 */
async function syncToDailyStatement(orderId, storeId) {
  try {
    const { DailyStatement, DailyStatementDetail, PaymentMethodStore, SettlementAccount, PaymentMethod } = require('../../models');
    const order = await Order.findByPk(orderId, {
      include: [{ model: OrderPayment }, { model: OrderItem }]
    });
    if (!order) return;

    const dateStr = new Date().toISOString().slice(0, 10);

    // 加载所有支付方式字典
    const paymentMethods = await PaymentMethod.findAll({ where: { status: 1 } });
    const paymentMethodMap = {};
    for (const pm of paymentMethods) {
      paymentMethodMap[pm.code] = pm.name;
    }

    const [statement] = await DailyStatement.findOrCreate({
      where: { store_id: storeId, statement_date: dateStr },
      defaults: {
        statement_id: generateUUID(),
        store_id: storeId,
        statement_date: dateStr,
        total_revenue: 0,
        total_order_count: 0,
        total_settled: 0,
        status: 'pending'
      }
    });

    for (const payment of order.OrderPayments || []) {
      const settleAccountId = await resolveSettlementAccount(storeId, payment.payment_method);
      const paymentMethodName = paymentMethodMap[payment.payment_method] || payment.payment_method;

      const existing = await DailyStatementDetail.findOne({
      where: { statement_id: statement.statement_id, order_id: orderId, payment_code: paymentMethodName }
    });
    if (existing) {
      await existing.update({
        amount: payment.amount,
        settlement_account_id: settleAccountId,
        payment_method: paymentMethodName,
        payment_code: paymentMethodName,
          customer_name: order.customer_name,
          order_no: order.order_no
        });
      } else {
        await DailyStatementDetail.create({
          detail_id: generateUUID(),
          statement_id: statement.statement_id,
          order_id: orderId,
          order_no: order.order_no,
          customer_name: order.customer_name || '',
          payment_method: paymentMethodName,
          payment_code: paymentMethodName,
          amount: payment.amount,
          settlement_account_id: settleAccountId,
          settled: 0
        });
      }
    }

    const details = await DailyStatementDetail.findAll({
      where: { statement_id: statement.statement_id },
      attributes: ['order_id', 'amount']
    });
    const orderIds = [...new Set(details.map(d => d.order_id))];
    const totalRevenue = details.reduce((s, d) => s + parseFloat(d.amount || 0), 0);

    await statement.update({
      total_revenue: totalRevenue,
      total_order_count: orderIds.length
    });
  } catch (err) {
    console.error('[DailySync] Error:', err.message);
  }
}

async function resolveSettlementAccount(storeId, paymentMethodName) {
  try {
    const { PaymentMethod, PaymentMethodStore } = require('../../models');
    const pm = await PaymentMethod.findOne({ where: { name: paymentMethodName, status: 1 } });
    if (!pm) return null;

    if (pm.is_global === 1) return pm.settlement_account_id || null;

    const storeCfg = await PaymentMethodStore.findOne({
      where: { method_id: pm.method_id, store_id: storeId }
    });
    return storeCfg?.settlement_account_id || null;
  } catch (err) {
    console.error('[resolveSettlementAccount] Error:', err.message);
    return null;
  }
}