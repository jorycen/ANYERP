/**
 * 字典管理控制器
 * 客户来源 / 收款方式 / 结算账号 / 金额补录项目
 */
const { CustomerSource, PaymentMethod, PaymentMethodStore, SupplementItem, SettlementAccount, Store } = require('../../models');
const { Op } = require('sequelize');
const { generateUUID, paginate, formatPaginatedResult } = require('../../utils');

// ==============================================
// 客户来源管理（一级/二级联动）
// ==============================================

async function getCustomerSourceList(ctx) {
  const { keyword, page = 1, pageSize = 20 } = ctx.query;
  const where = { status: 1 };
  if (keyword) {
    where.name = { [Op.like]: `%${keyword}%` };
  }

  const { count, rows } = await CustomerSource.findAndCountAll({
    where,
    order: [['sort_order', 'ASC']],
    ...paginate({}, { page, pageSize })
  });

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

async function getAllCustomerSources(ctx) {
  const rows = await CustomerSource.findAll({
    where: { status: 1 },
    order: [['sort_order', 'ASC']]
  });
  ctx.body = { code: 0, data: rows };
}

async function getCustomerSourceTree(ctx) {
  const rows = await CustomerSource.findAll({
    where: { status: 1 },
    order: [['sort_order', 'ASC']]
  });
  const level1 = rows.filter(r => r.level === 1);
  const level2 = rows.filter(r => r.level === 2);
  const tree = level1.map(l1 => ({
    ...l1.toJSON(),
    children: level2.filter(l2 => l2.parent_id === l1.source_id)
  }));
  ctx.body = { code: 0, data: tree };
}

async function createCustomerSource(ctx) {
  const { name, parentId, sortOrder } = ctx.request.body;
  if (!name) ctx.throw(400, '名称不能为空');

  try {
    await CustomerSource.create({
      source_id: generateUUID(),
      name,
      parent_id: parentId || null,
      level: parentId ? 2 : 1,
      sort_order: sortOrder || 0,
      status: 1
    });
    ctx.body = { code: 0, message: '创建成功' };
  } catch (error) {
    console.error('[Dict] createCustomerSource Error:', error.message, error.parent?.sqlMessage);
    ctx.throw(500, error.parent?.sqlMessage || error.message || '创建失败');
  }
}

async function updateCustomerSource(ctx) {
  const { id } = ctx.params;
  const { name, parentId, sortOrder, status } = ctx.request.body;

  const record = await CustomerSource.findByPk(id);
  if (!record) ctx.throw(404, '记录不存在');

  const updates = {};
  if (name !== undefined) updates.name = name;
  if (parentId !== undefined) {
    updates.parent_id = parentId;
    updates.level = parentId ? 2 : 1;
  }
  if (sortOrder !== undefined) updates.sort_order = sortOrder;
  if (status !== undefined) updates.status = status;

  await record.update(updates);
  ctx.body = { code: 0, message: '更新成功' };
}

async function deleteCustomerSource(ctx) {
  const { id } = ctx.params;
  const record = await CustomerSource.findByPk(id);
  if (!record) ctx.throw(404, '记录不存在');

  const children = await CustomerSource.findAll({ where: { parent_id: id, status: 1 } });
  for (const child of children) {
    await child.update({ status: 0 });
  }

  await record.update({ status: 0 });
  ctx.body = { code: 0, message: '删除成功' };
}

async function sortCustomerSources(ctx) {
  const { items } = ctx.request.body;
  if (!items || !Array.isArray(items)) ctx.throw(400, '排序数据格式无效');

  for (const item of items) {
    await CustomerSource.update(
      { sort_order: item.sortOrder },
      { where: { source_id: item.id } }
    );
  }

  ctx.body = { code: 0, message: '排序更新成功' };
}

// ==============================================
// 收款方式管理（支持按门店配置不同结算账号）
// ==============================================

async function getPaymentMethodList(ctx) {
  const { keyword, page = 1, pageSize = 20, storeId } = ctx.query;
  const where = { status: 1 };
  if (keyword) {
    where.name = { [Op.like]: `%${keyword}%` };
  }

  const include = [{
    model: SettlementAccount,
    attributes: ['account_id', 'account_name', 'bank_name', 'account_number']
  }, {
    model: PaymentMethodStore,
    include: [
      {
        model: Store,
        attributes: ['store_id', 'name'],
        ...(storeId ? { where: { store_id: storeId }, required: false } : {})
      },
      {
        model: SettlementAccount,
        attributes: ['account_id', 'account_name', 'bank_name', 'account_number']
      }
    ],
    ...(storeId ? { where: { store_id: storeId }, required: false } : {})
  }];

  const { count, rows } = await PaymentMethod.findAndCountAll({
    where,
    include,
    order: [['sort_order', 'ASC']],
    ...paginate({}, { page, pageSize })
  });

  // 兼容前端旧格式：把 PaymentMethodStore 映射到 Stores 上
  const mappedRows = rows.map(row => {
    const plain = row.toJSON();
    plain.Stores = (plain.PaymentMethodStores || []).map(pms => ({
      ...pms.Store,
      PaymentMethodStore: {
        settlement_account_id: pms.settlement_account_id,
        SettlementAccount: pms.SettlementAccount
      }
    })).filter(s => s.store_id);
    delete plain.PaymentMethodStores;
    return plain;
  });

  ctx.body = formatPaginatedResult(mappedRows, { page, pageSize, count });
}

async function getAllPaymentMethods(ctx) {
  const { storeId } = ctx.query;
  const where = { status: 1 };

  const include = [{
    model: SettlementAccount,
    attributes: ['account_id', 'account_name', 'bank_name', 'account_number']
  }, {
    model: PaymentMethodStore,
    include: [
      {
        model: Store,
        attributes: ['store_id', 'name'],
        ...(storeId ? { where: { store_id: storeId }, required: false } : {})
      },
      {
        model: SettlementAccount,
        attributes: ['account_id', 'account_name', 'bank_name', 'account_number']
      }
    ],
    ...(storeId ? { where: { store_id: storeId }, required: false } : {})
  }];

  const rows = await PaymentMethod.findAll({
    where,
    include,
    order: [['sort_order', 'ASC']]
  });

  // 兼容前端旧格式：把 PaymentMethodStore 映射到 Stores 上
  const mappedRows = rows.map(row => {
    const plain = row.toJSON();
    plain.Stores = (plain.PaymentMethodStores || []).map(pms => ({
      ...pms.Store,
      PaymentMethodStore: {
        settlement_account_id: pms.settlement_account_id,
        SettlementAccount: pms.SettlementAccount
      }
    })).filter(s => s.store_id);
    delete plain.PaymentMethodStores;
    return plain;
  });

  ctx.body = { code: 0, data: mappedRows };
}

async function getPaymentMethodsByStore(ctx) {
  const { storeId } = ctx.query;
  if (!storeId) ctx.throw(400, '门店ID不能为空');

  const globalMethods = await PaymentMethod.findAll({
    where: { status: 1, is_global: 1 },
    include: [{
      model: SettlementAccount,
      attributes: ['account_id', 'account_name', 'bank_name', 'account_number']
    }],
    order: [['sort_order', 'ASC']]
  });

  const storeConfigs = await PaymentMethodStore.findAll({
    where: { store_id: storeId },
    include: [
      {
        model: PaymentMethod,
        where: { status: 1 },
        attributes: ['method_id', 'name', 'code', 'icon', 'sort_order']
      },
      { model: SettlementAccount, attributes: ['account_id', 'account_name', 'bank_name', 'account_number'] }
    ]
  });

  const storeMethodMap = new Map();
  for (const cfg of storeConfigs) {
    if (cfg.PaymentMethod) {
      storeMethodMap.set(cfg.PaymentMethod.method_id, {
        settlement_account_id: cfg.settlement_account_id,
        SettlementAccount: cfg.SettlementAccount
      });
    }
  }

  const result = globalMethods.map(m => {
    const storeCfg = storeMethodMap.get(m.method_id);
    return {
      ...m.toJSON(),
      store_settlement_account_id: storeCfg?.settlement_account_id || null,
      storeSettlementAccount: storeCfg?.SettlementAccount || null
    };
  });

  for (const cfg of storeConfigs) {
    if (cfg.PaymentMethod && !globalMethods.find(m => m.method_id === cfg.PaymentMethod.method_id)) {
      result.push({
        method_id: cfg.PaymentMethod.method_id,
        name: cfg.PaymentMethod.name,
        code: cfg.PaymentMethod.code,
        icon: cfg.PaymentMethod.icon,
        sort_order: cfg.PaymentMethod.sort_order,
        settlement_account_id: null,
        is_global: 0,
        store_settlement_account_id: cfg.settlement_account_id,
        storeSettlementAccount: cfg.SettlementAccount
      });
    }
  }

  ctx.body = { code: 0, data: result };
}

async function createPaymentMethod(ctx) {
  const { name, code, icon, isGlobal, storeConfigs, sortOrder, settlementAccountId } = ctx.request.body;
  if (!name) ctx.throw(400, '名称不能为空');

  const t = await (require('../../models').sequelize).transaction();
  try {
    const method = await PaymentMethod.create({
      method_id: generateUUID(),
      name,
      code: code || name,
      icon: icon || null,
      is_global: isGlobal ? 1 : 0,
      settlement_account_id: settlementAccountId || null,
      sort_order: sortOrder || 0,
      status: 1
    }, { transaction: t });

    if (!isGlobal && Array.isArray(storeConfigs) && storeConfigs.length > 0) {
      for (const cfg of storeConfigs) {
        if (cfg.storeId) {
          await PaymentMethodStore.create({
            method_id: method.method_id,
            store_id: cfg.storeId,
            settlement_account_id: cfg.settlementAccountId || null
          }, { transaction: t });
        }
      }
    }

    await t.commit();
    ctx.body = { code: 0, message: '创建成功' };
  } catch (error) {
    await t.rollback();
    console.error('[Dict] createPaymentMethod Error:', error.message, error.parent?.sqlMessage);
    ctx.throw(500, error.parent?.sqlMessage || error.message || '创建失败');
  }
}

async function updatePaymentMethod(ctx) {
  const { id } = ctx.params;
  const { name, code, icon, isGlobal, storeConfigs, sortOrder, status, settlementAccountId } = ctx.request.body;

  const record = await PaymentMethod.findByPk(id);
  if (!record) ctx.throw(404, '记录不存在');

  const t = await (require('../../models').sequelize).transaction();
  try {
    const updates = {};
    if (name !== undefined) { updates.name = name; updates.code = name; }
    if (code !== undefined) updates.code = code;
    if (icon !== undefined) updates.icon = icon;
    if (isGlobal !== undefined) updates.is_global = isGlobal ? 1 : 0;
    if (sortOrder !== undefined) updates.sort_order = sortOrder;
    if (status !== undefined) updates.status = status;
    if (settlementAccountId !== undefined) updates.settlement_account_id = settlementAccountId || null;

    await record.update(updates, { transaction: t });

    if (storeConfigs !== undefined) {
      await PaymentMethodStore.destroy({ where: { method_id: id }, transaction: t });
      if (Array.isArray(storeConfigs) && storeConfigs.length > 0) {
        for (const cfg of storeConfigs) {
          if (cfg.storeId) {
            await PaymentMethodStore.create({
              method_id: id,
              store_id: cfg.storeId,
              settlement_account_id: cfg.settlementAccountId || null
            }, { transaction: t });
          }
        }
      }
    }

    await t.commit();
    ctx.body = { code: 0, message: '更新成功' };
  } catch (error) {
    await t.rollback();
    console.error('[Dict] updatePaymentMethod Error:', error.message, error.parent?.sqlMessage);
    ctx.throw(500, error.parent?.sqlMessage || error.message || '更新失败');
  }
}

async function deletePaymentMethod(ctx) {
  const { id } = ctx.params;
  const record = await PaymentMethod.findByPk(id);
  if (!record) ctx.throw(404, '记录不存在');

  const t = await (require('../../models').sequelize).transaction();
  try {
    await PaymentMethodStore.destroy({ where: { method_id: id }, transaction: t });
    await record.update({ status: 0 }, { transaction: t });
    await t.commit();
    ctx.body = { code: 0, message: '删除成功' };
  } catch (error) {
    await t.rollback();
    throw error;
  }
}

async function sortPaymentMethods(ctx) {
  const { items } = ctx.request.body;
  if (!items || !Array.isArray(items)) ctx.throw(400, '排序数据格式无效');

  for (const item of items) {
    await PaymentMethod.update(
      { sort_order: item.sortOrder },
      { where: { method_id: item.id } }
    );
  }

  ctx.body = { code: 0, message: '排序更新成功' };
}

// ==============================================
// 结算账号管理
// ==============================================

async function getSettlementAccountList(ctx) {
  const { keyword, page = 1, pageSize = 20 } = ctx.query;
  const where = { status: 1 };
  if (keyword) {
    where[Op.or] = [
      { account_name: { [Op.like]: `%${keyword}%` } },
      { bank_name: { [Op.like]: `%${keyword}%` } },
      { account_number: { [Op.like]: `%${keyword}%` } }
    ];
  }

  const { count, rows } = await SettlementAccount.findAndCountAll({
    where,
    order: [['sort_order', 'ASC']],
    ...paginate({}, { page, pageSize })
  });

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

async function getAllSettlementAccounts(ctx) {
  const rows = await SettlementAccount.findAll({
    where: { status: 1 },
    order: [['sort_order', 'ASC']]
  });
  ctx.body = { code: 0, data: rows };
}

async function createSettlementAccount(ctx) {
  const { accountName, bankName, accountNumber, sortOrder } = ctx.request.body;
  if (!accountName) ctx.throw(400, '账号名称不能为空');

  try {
    await SettlementAccount.create({
      account_id: generateUUID(),
      account_name: accountName,
      bank_name: bankName || '',
      account_number: accountNumber || '',
      sort_order: sortOrder || 0,
      status: 1
    });
    ctx.body = { code: 0, message: '创建成功' };
  } catch (error) {
    console.error('[Dict] createSettlementAccount Error:', error.message, error.parent?.sqlMessage);
    ctx.throw(500, error.parent?.sqlMessage || error.message || '创建失败');
  }
}

async function updateSettlementAccount(ctx) {
  const { id } = ctx.params;
  const { accountName, bankName, accountNumber, sortOrder, status } = ctx.request.body;

  const record = await SettlementAccount.findByPk(id);
  if (!record) ctx.throw(404, '记录不存在');

  const updates = {};
  if (accountName !== undefined) updates.account_name = accountName;
  if (bankName !== undefined) updates.bank_name = bankName;
  if (accountNumber !== undefined) updates.account_number = accountNumber;
  if (sortOrder !== undefined) updates.sort_order = sortOrder;
  if (status !== undefined) updates.status = status;

  await record.update(updates);
  ctx.body = { code: 0, message: '更新成功' };
}

async function deleteSettlementAccount(ctx) {
  const { id } = ctx.params;
  const record = await SettlementAccount.findByPk(id);
  if (!record) ctx.throw(404, '记录不存在');
  await record.update({ status: 0 });
  ctx.body = { code: 0, message: '删除成功' };
}

async function sortSettlementAccounts(ctx) {
  const { items } = ctx.request.body;
  if (!items || !Array.isArray(items)) ctx.throw(400, '排序数据格式无效');

  for (const item of items) {
    await SettlementAccount.update(
      { sort_order: item.sortOrder },
      { where: { account_id: item.id } }
    );
  }

  ctx.body = { code: 0, message: '排序更新成功' };
}

// ==============================================
// 金额补录项目管理
// ==============================================

async function getSupplementItemList(ctx) {
  const { keyword, page = 1, pageSize = 20 } = ctx.query;
  const where = { is_active: 1 };
  if (keyword) {
    where.name = { [Op.like]: `%${keyword}%` };
  }

  const { count, rows } = await SupplementItem.findAndCountAll({
    where,
    order: [['sort_order', 'ASC']],
    ...paginate({}, { page, pageSize })
  });

  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

async function getAllSupplementItems(ctx) {
  const rows = await SupplementItem.findAll({
    where: { is_active: 1 },
    order: [['sort_order', 'ASC']]
  });
  ctx.body = { code: 0, data: rows };
}

async function createSupplementItem(ctx) {
  const { name, amount, sortOrder } = ctx.request.body;
  if (!name) ctx.throw(400, '名称不能为空');

  try {
    await SupplementItem.create({
      item_id: generateUUID(),
      name,
      amount: amount || 0,
      is_active: 1,
      sort_order: sortOrder || 0
    });
    ctx.body = { code: 0, message: '创建成功' };
  } catch (error) {
    console.error('[Dict] createSupplementItem Error:', error.message, error.parent?.sqlMessage);
    ctx.throw(500, error.parent?.sqlMessage || error.message || '创建失败');
  }
}

async function updateSupplementItem(ctx) {
  const { id } = ctx.params;
  const { name, amount, sortOrder, isActive } = ctx.request.body;

  const record = await SupplementItem.findByPk(id);
  if (!record) ctx.throw(404, '记录不存在');

  const updates = {};
  if (name !== undefined) updates.name = name;
  if (amount !== undefined) updates.amount = amount;
  if (sortOrder !== undefined) updates.sort_order = sortOrder;
  if (isActive !== undefined) updates.is_active = isActive;

  await record.update(updates);
  ctx.body = { code: 0, message: '更新成功' };
}

async function deleteSupplementItem(ctx) {
  const { id } = ctx.params;
  const record = await SupplementItem.findByPk(id);
  if (!record) ctx.throw(404, '记录不存在');
  await record.update({ is_active: 0 });
  ctx.body = { code: 0, message: '删除成功' };
}

async function sortSupplementItems(ctx) {
  const { items } = ctx.request.body;
  if (!items || !Array.isArray(items)) ctx.throw(400, '排序数据格式无效');

  for (const item of items) {
    await SupplementItem.update(
      { sort_order: item.sortOrder },
      { where: { item_id: item.id } }
    );
  }

  ctx.body = { code: 0, message: '排序更新成功' };
}

module.exports = {
  getCustomerSourceList,
  getAllCustomerSources,
  getCustomerSourceTree,
  createCustomerSource,
  updateCustomerSource,
  deleteCustomerSource,
  sortCustomerSources,
  getPaymentMethodList,
  getAllPaymentMethods,
  getPaymentMethodsByStore,
  createPaymentMethod,
  updatePaymentMethod,
  deletePaymentMethod,
  sortPaymentMethods,
  getSettlementAccountList,
  getAllSettlementAccounts,
  createSettlementAccount,
  updateSettlementAccount,
  deleteSettlementAccount,
  sortSettlementAccounts,
  getSupplementItemList,
  getAllSupplementItems,
  createSupplementItem,
  updateSupplementItem,
  deleteSupplementItem,
  sortSupplementItems
};