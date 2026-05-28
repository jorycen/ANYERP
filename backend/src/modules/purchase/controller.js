/**
 * 采购管理控制器
 */
const { sequelize, PurchaseRequest, PurchaseRequestItem, Supplier, SupplierPaymentAccount, Store, Product, Inbound, InboundItem, Payable, SupplierRebate } = require('../../models');
const { Op } = require('sequelize');
const { generateRequestNo, generateUUID, generateId, generateInboundNo, paginate, formatPaginatedResult } = require('../../utils');
const { recordRebateDeduction, _getRebateBalance } = require('../finance/rebateController');

/**
 * 采购申请列表
 */
async function getRequestList(ctx) {
  const { status, page = 1, pageSize = 20 } = ctx.query;
  const user = ctx.state.user;

  const where = {};
  const whereStore = {};

  // 区域权限过滤
  if (!user.regionCodes.includes('*')) {
    whereStore.region_id = user.regionCodes;
  }

  const stores = await Store.findAll({ where: whereStore });
  const storeIds = stores.map(s => s.store_id);
  if (storeIds.length > 0) {
    where.store_id = storeIds;
  }

  if (status) where.status = status;

  const { count, rows } = await PurchaseRequest.findAndCountAll({
    where,
    include: [
      { model: Store },
      { model: Supplier },
      { model: PurchaseRequestItem, as: 'items' }
    ],
    order: [
      [sequelize.literal("FIELD(PurchaseRequest.status, 'pending', 'approved', 'revoked')"), 'ASC'],
      ['create_time', 'DESC']
    ],
    ...paginate({}, { page, pageSize })
  });

  const formattedRows = rows.map(row => {
    const result = row.toJSON();
    result.store_name = result.Store?.name || '';
    result.supplier_name = result.Supplier?.name || '';
    
    // 汇总商品名称和数量用于前端展示
    if (result.items && result.items.length > 0) {
      result.items_summary = result.items.map(item => 
        `${item.product_name || item.product_id} x ${item.quantity}`
      ).join('; ');
    } else {
      result.items_summary = '';
    }
    
    return result;
  });

  ctx.body = formatPaginatedResult(formattedRows, { page, pageSize, count });
}

/**
 * 获取采购申请详情
 */
async function getRequestDetail(ctx) {
  const { requestId } = ctx.params;

  const request = await PurchaseRequest.findOne({
    where: { request_id: requestId },
    include: [
      { model: Store },
      { model: Supplier },
      { model: PurchaseRequestItem, as: 'items' },
      { model: Inbound, include: [{ model: InboundItem, as: 'items' }] }
    ]
  });

  if (!request) {
    ctx.throw(404, '采购申请不存在');
  }

  const result = request.toJSON();
  result.store_name = result.Store?.name || '';
  result.supplier_name = result.Supplier?.name || '';

  // 解析门店分配，并关联门店名称
  if (result.items && result.items.length > 0) {
    // 获取所有门店
    const stores = await Store.findAll();
    const storeMap = new Map();
    stores.forEach(s => storeMap.set(s.store_id, s.name));

    result.items = result.items.map(item => {
      const itemJson = item;
      let storeAllocations = [];
      if (itemJson.store_allocations) {
        try {
          storeAllocations = JSON.parse(itemJson.store_allocations);
        } catch (e) {
          // ignore
        }
      }
      // 添加门店名称
      itemJson.store_allocations_parsed = storeAllocations.map(alloc => ({
        ...alloc,
        storeName: storeMap.get(alloc.storeId) || alloc.storeId
      }));
      return itemJson;
    });
  }

  ctx.body = { code: 0, data: result };
}

/**
 * 创建采购申请
 */
async function createRequest(ctx) {
  const user = ctx.state.user;
  const { supplierId, remark, items, storeId, invoiceType, productType, rebateDeduction } = ctx.request.body;

  if (!items || items.length === 0) {
    ctx.throw(400, '请添加商品明细');
  }

  if (!supplierId) {
    ctx.throw(400, '请选择供应商');
  }

  const requestNo = generateRequestNo();
  const requestId = generateUUID();

  const totalAmount = items.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);
  const deduction = Math.min(parseFloat(rebateDeduction || 0), totalAmount);
  const actualTotal = totalAmount - deduction;

  // 如果有返利抵扣，验证并记录
  if (deduction > 0) {
    const currentBalance = await _getRebateBalance(supplierId);
    
    if (deduction > currentBalance) {
      ctx.throw(400, `返利余额不足，当前余额 ¥${currentBalance.toFixed(2)}`);
    }
    
    await recordRebateDeduction(
      supplierId,
      '',
      deduction,
      requestNo,
      `采购申请 ${requestNo} 返利抵扣`,
      user.name || user.phone
    );
  }

  // 如果用户没有 storeId，尝试从门店分配中获取第一个，或者使用默认值
  const targetStoreId = storeId || user.storeId;
  
  // 查找第一个有效的门店
  let finalStoreId = targetStoreId;
  if (!finalStoreId) {
    for (const item of items) {
      if (item.storeAllocations && item.storeAllocations.length > 0) {
        finalStoreId = item.storeAllocations[0].storeId;
        break;
      }
    }
  }
  
  // 如果还是没有，尝试从用户的区域权限查找一个门店
  if (!finalStoreId) {
    const whereStore = {};
    if (!user.regionCodes.includes('*')) {
      whereStore.region_id = user.regionCodes;
    }
    const stores = await Store.findAll({ where: whereStore, limit: 1 });
    if (stores.length > 0) {
      finalStoreId = stores[0].store_id;
    } else {
      finalStoreId = 'DEFAULT_STORE';
    }
  }

  const now = new Date();
  await PurchaseRequest.create({
    request_id: requestId,
    request_no: requestNo,
    store_id: finalStoreId,
    supplier_id: supplierId,
    invoice_type: invoiceType || '',
    reason: remark || '',
    total_amount: totalAmount,
    rebate_deduction: deduction,
    actual_total: actualTotal,
    status: 'pending',
    apply_user: user.name,
    create_time: now,
    update_time: now
  });

  // 创建明细
  for (const item of items) {
    const productId = item.productId || '';
    const quantity = item.quantity || 0;
    const unitPrice = item.price || 0;
    const subtotal = unitPrice * quantity;

    await PurchaseRequestItem.create({
      request_id: requestId,
      product_id: productId,
      product_name: item.productName || '',
      pn_code: item.pnCode || '',
      quantity: quantity,
      unit_price: unitPrice,
      subtotal: subtotal,
      product_type: productType || item.productType || '',
      store_allocations: item.storeAllocations ? JSON.stringify(item.storeAllocations) : null
    });
  }

  ctx.body = { code: 0, message: '采购申请提交成功', requestId, requestNo };
}

/**
 * 审批采购申请
 */
async function approveRequest(ctx) {
  const { requestId } = ctx.params;
  const { status, comment } = ctx.request.body;
  const user = ctx.state.user;

  const request = await PurchaseRequest.findByPk(requestId, {
    include: [{ model: PurchaseRequestItem, as: 'items' }]
  });
  if (!request) {
    ctx.throw(404, '采购申请不存在');
  }

  await request.update({
    status,
    approve_user: user.name,
    approve_comment: comment,
    update_time: new Date()
  });

  // 如果审批通过，自动生成入库单
  if (status === 'approved' && request.items && request.items.length > 0) {
    // 获取所有商品信息备用
    const productIds = request.items.map(item => item.product_id);
    const products = await Product.findAll({
      where: { product_id: { [Op.in]: productIds } }
    });
    const productMap = new Map();
    products.forEach(p => productMap.set(p.product_id, p));

    // 按照门店分配创建入库单
    const storeItemsMap = new Map();

    // 解析门店分配并按门店分组
    for (const item of request.items) {
      let allocations = [];
      if (item.store_allocations) {
        try {
          allocations = JSON.parse(item.store_allocations);
        } catch (e) {
          // 解析失败，默认分配到申请门店
          allocations = [{ storeId: request.store_id, quantity: item.quantity }];
        }
      }

      // 如果没有分配，默认分配到申请门店
      if (allocations.length === 0) {
        allocations = [{ storeId: request.store_id, quantity: item.quantity }];
      }

      // 确保商品名称存在
      let productName = item.product_name;
      if (!productName || productName.trim() === '') {
        const product = productMap.get(item.product_id);
        if (product) {
          productName = product.name;
        }
      }

      for (const alloc of allocations) {
        const storeId = alloc.storeId || request.store_id;
        if (!storeItemsMap.has(storeId)) {
          storeItemsMap.set(storeId, []);
        }
        storeItemsMap.get(storeId).push({
          ...item.toJSON(),
          product_name: productName,
          allocatedQuantity: alloc.quantity || item.quantity
        });
      }
    }

    // 为每个门店创建入库单
    for (const [storeId, items] of storeItemsMap.entries()) {
      const inboundNo = generateInboundNo();
      const inboundId = generateUUID();

      const totalQuantity = items.reduce((sum, item) => sum + (item.allocatedQuantity || item.quantity), 0);
      const totalAmount = items.reduce((sum, item) => 
        sum + (item.unit_price || 0) * (item.allocatedQuantity || item.quantity), 0);

      // 创建入库单
      await Inbound.create({
        inbound_id: inboundId,
        inbound_no: inboundNo,
        store_id: storeId,
        source_type: 'purchase',
        source_no: request.request_no,
        purchase_request_id: request.request_id,
        total_amount: totalAmount,
        total_quantity: totalQuantity,
        status: 'pending',
        create_user: user.name,
        create_time: new Date(),
        update_time: new Date()
      });

      // 创建入库明细
      for (const item of items) {
        await InboundItem.create({
          inbound_id: inboundId,
          product_id: item.product_id,
          product_name: item.product_name,
          pn_code: item.pn_code,
          unit_price: item.unit_price,
          quantity: item.allocatedQuantity || item.quantity,
          product_type: item.product_type || '',
          store_allocations: JSON.stringify([{
            storeId: storeId,
            quantity: item.allocatedQuantity || item.quantity
          }])
        });
      }
    }
  }

  ctx.body = { code: 0, message: '审批完成' };
}

/**
 * 撤销采购申请
 */
async function revokeRequest(ctx) {
  const { requestId } = ctx.params;
  const { comment } = ctx.request.body;
  const user = ctx.state.user;

  const request = await PurchaseRequest.findOne({
    where: { request_id: requestId },
    include: [{ model: Inbound, include: [{ model: InboundItem, as: 'items' }] }]
  });

  if (!request) {
    ctx.throw(404, '采购申请不存在');
  }

  if (request.status !== 'approved') {
    ctx.throw(400, '只有已通过的采购申请才能撤销');
  }

  if (request.Inbounds && request.Inbounds.length > 0) {
    const completedInbounds = request.Inbounds.filter(i => i.status === 'completed');
    if (completedInbounds.length > 0) {
      ctx.throw(400, '该采购申请已有商品入库，无法撤销，请先办理退库');
    }
  }

  const transaction = await sequelize.transaction();
  try {
    if (request.Inbounds && request.Inbounds.length > 0) {
      for (const inbound of request.Inbounds) {
        await InboundItem.destroy({
          where: { inbound_id: inbound.inbound_id },
          transaction
        });
        await Inbound.destroy({
          where: { inbound_id: inbound.inbound_id },
          transaction
        });
      }
    }

    await Payable.destroy({
      where: { request_id: requestId },
      transaction
    });

    if (request.rebate_deduction && parseFloat(request.rebate_deduction) > 0) {
      const currentBalance = await _getRebateBalance(request.supplier_id);
      const newBalance = currentBalance + parseFloat(request.rebate_deduction);
      const supplier = await Supplier.findByPk(request.supplier_id);
      await SupplierRebate.create({
        rebate_id: generateUUID(),
        supplier_id: request.supplier_id,
        supplier_name: (supplier && supplier.name) || '',
        type: 'credit',
        amount: parseFloat(request.rebate_deduction),
        balance: newBalance,
        related_no: request.request_no,
        remark: `采购申请 ${request.request_no} 撤销，退回返利抵扣`,
        create_user: user.name || user.phone
      }, { transaction });
    }

    await request.update({
      status: 'revoked',
      approve_user: request.approve_user,
      approve_comment: request.approve_comment,
      revoke_user: user.name,
      revoke_comment: comment,
      update_time: new Date()
    }, { transaction });

    await transaction.commit();

    ctx.body = { code: 0, message: '撤销成功' };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

/**
 * 供应商列表
 */
async function getSupplierList(ctx) {
  const { keyword, page = 1, pageSize = 20 } = ctx.query;

  const where = { is_deleted: 0 };
  if (keyword) {
    where[Op.or] = [
      { name: { [Op.like]: `%${keyword}%` } },
      { contact: { [Op.like]: `%${keyword}%` } }
    ];
  }

  const { count, rows } = await Supplier.findAndCountAll({
    where,
    include: [{ model: SupplierPaymentAccount, as: 'paymentAccounts', where: { is_deleted: 0 }, required: false }],
    order: [['create_time', 'DESC']],
    distinct: true,
    ...paginate({}, { page, pageSize })
  });

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

/**
 * 获取所有供应商（不分页，用于下拉选择）
 */
async function getAllSuppliers(ctx) {
  const where = { is_deleted: 0 };

  const rows = await Supplier.findAll({
    where,
    include: [{ model: SupplierPaymentAccount, as: 'paymentAccounts', where: { is_deleted: 0 }, required: false }],
    order: [['create_time', 'DESC']]
  });

  ctx.body = { code: 0, data: rows };
}

/**
 * 创建供应商
 */
async function createSupplier(ctx) {
  const { name, contact, phone, address, invoiceType, remark, status = 1, paymentAccounts = [] } = ctx.request.body;

  if (!name) {
    ctx.throw(400, '供应商名称不能为空');
  }

  const supplierId = generateId('SP');

  await sequelize.transaction(async (transaction) => {
    await Supplier.create({
      supplier_id: supplierId,
      name,
      contact: contact || '',
      phone: phone || '',
      address: address || '',
      invoice_type: invoiceType || '',
      remark: remark || '',
      status,
      create_time: new Date(),
      update_time: new Date()
    }, { transaction });

    await saveSupplierPaymentAccounts(supplierId, paymentAccounts, transaction);
  });

  ctx.body = { code: 0, message: '创建成功' };
}

/**
 * 更新供应商
 */
async function updateSupplier(ctx) {
  const { id } = ctx.params;
  const { name, contact, phone, address, invoiceType, remark, status, paymentAccounts } = ctx.request.body;

  const supplier = await Supplier.findOne({
    where: { supplier_id: id, is_deleted: 0 }
  });

  if (!supplier) {
    ctx.throw(404, '供应商不存在');
  }

  await sequelize.transaction(async (transaction) => {
    await supplier.update({
      name: name || supplier.name,
      contact: contact !== undefined ? contact : supplier.contact,
      phone: phone !== undefined ? phone : supplier.phone,
      address: address !== undefined ? address : supplier.address,
      invoice_type: invoiceType !== undefined ? invoiceType : supplier.invoice_type,
      remark: remark !== undefined ? remark : supplier.remark,
      status: status !== undefined ? status : supplier.status,
      update_time: new Date()
    }, { transaction });

    if (Array.isArray(paymentAccounts)) {
      await saveSupplierPaymentAccounts(id, paymentAccounts, transaction);
    }
  });

  ctx.body = { code: 0, message: '更新成功' };
}

async function saveSupplierPaymentAccounts(supplierId, paymentAccounts, transaction) {
  await SupplierPaymentAccount.update(
    { is_deleted: 1, status: 0, update_time: new Date() },
    { where: { supplier_id: supplierId }, transaction }
  );

  const validAccounts = (paymentAccounts || []).filter(acc =>
    acc.companyName || acc.company_name || acc.taxNo || acc.tax_no || acc.bankName || acc.bank_name || acc.accountNumber || acc.account_number || acc.remark
  );

  for (const [index, acc] of validAccounts.entries()) {
    await SupplierPaymentAccount.create({
      account_id: generateUUID(),
      supplier_id: supplierId,
      company_name: acc.companyName || acc.company_name || '',
      tax_no: acc.taxNo || acc.tax_no || '',
      bank_name: acc.bankName || acc.bank_name || '',
      account_number: acc.accountNumber || acc.account_number || '',
      remark: acc.remark || '',
      sort_order: index,
      status: 1,
      is_deleted: 0,
      create_time: new Date(),
      update_time: new Date()
    }, { transaction });
  }
}

/**
 * 删除供应商
 */
async function deleteSupplier(ctx) {
  const { id } = ctx.params;

  const supplier = await Supplier.findOne({
    where: { supplier_id: id, is_deleted: 0 }
  });

  if (!supplier) {
    ctx.throw(404, '供应商不存在');
  }

  await supplier.update({ is_deleted: 1 });
  ctx.body = { code: 0, message: '删除成功' };
}

module.exports = {
  getRequestList,
  getRequestDetail,
  createRequest,
  approveRequest,
  revokeRequest,
  getSupplierList,
  getAllSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier
};
