const { Op } = require('sequelize');
const {
  sequelize, Product, ProductSn, InventoryResourceRight, ResourceRightChangeOrder,
  ProductResourceCostConfig, InventoryResourceCostAdjustment, ResourceCategory,
  ResourceSettlement, SettlementAccount, SettlementAccountTransaction, SupplierRebate, RebateEstimate, Supplier
} = require('../../models');
const { generateUUID, paginate, formatPaginatedResult } = require('../../utils');

const LEGACY_RESOURCE_TYPES = ['GOV_SUBSIDY', 'EDU_SUBSIDY', 'SALES_REPORT'];
const SOURCE_TYPES = ['REGULAR_TAX', 'UNTAXED', 'CHANNEL_RESOURCE', 'PROMOTION_RESOURCE', 'SPECIAL_PRICE', 'OTHER'];
const RIGHT_STATUSES = ['AVAILABLE', 'LOCKED', 'USED', 'CLAIMED_BACK', 'NOT_APPLICABLE', 'EXCEPTION'];
const RESOURCE_LABELS = { GOV_SUBSIDY: '国补', EDU_SUBSIDY: '教育补贴', SALES_REPORT: '销量报号' };
const STATUS_LABELS = {
  AVAILABLE: '可用', LOCKED: '已锁定', USED: '已核销', CLAIMED_BACK: '已套回',
  NOT_APPLICABLE: '不适用', EXCEPTION: '异常'
};

function roles(user) {
  if (Array.isArray(user?.roles) && user.roles.length > 0) return user.roles;
  return String(user?.roleCode || '').split(',').map(value => value.trim()).filter(Boolean);
}

function requireAnyRole(ctx, allowed, message = '无权执行该操作') {
  if (!roles(ctx.state.user).some(role => allowed.includes(role))) ctx.throw(403, message);
}

function businessNo(prefix = 'RRC') {
  const date = new Date();
  const stamp = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'),
    String(date.getHours()).padStart(2, '0'), String(date.getMinutes()).padStart(2, '0'), String(date.getSeconds()).padStart(2, '0')].join('');
  return `${prefix}${stamp}${generateUUID().slice(-6).toUpperCase()}`;
}

async function getResourceCategories({ activeOnly = true, usableOnly = true, transaction = null } = {}) {
  const where = activeOnly ? { status: 1 } : {};
  if (usableOnly) where[Op.or] = [{ supports_sale_use: 1 }, { supports_company_claim: 1 }];
  return ResourceCategory.findAll({ where, order: [['sort_order', 'ASC'], ['name', 'ASC']], transaction });
}

function categoryMap(categories = []) {
  return new Map(categories.map(category => [category.category_code, category]));
}

function normalizeRights(rows = [], categories = []) {
  const map = new Map(rows.map(row => [row.resource_type, row.toJSON ? row.toJSON() : row]));
  const configuredTypes = categories.map(category => category.category_code);
  const types = [...new Set([...(configuredTypes.length ? configuredTypes : LEGACY_RESOURCE_TYPES), ...rows.map(row => row.resource_type)])];
  return types.map(resourceType => map.get(resourceType) || {
    resource_type: resourceType,
    current_status: 'NOT_APPLICABLE',
    initial_status: 'NOT_APPLICABLE',
    amount: 0
  });
}

function buildSalesResourceSummary(sn, rows = [], categories = []) {
  const rights = normalizeRights(rows, categories);
  const names = new Map(categories.map(category => [category.category_code, category.short_name || category.name]));
  const resourceName = type => names.get(type) || RESOURCE_LABELS[type] || type;
  const available = rights.filter(row => row.current_status === 'AVAILABLE').map(row => resourceName(row.resource_type));
  const unavailable = rights.filter(row => row.current_status !== 'AVAILABLE').map(row => `${resourceName(row.resource_type)}${STATUS_LABELS[row.current_status] || row.current_status}`);
  const consumed = rights.filter(row => ['USED', 'CLAIMED_BACK'].includes(row.current_status));
  let label = '普通现货';
  let warning = '';
  if (rights.some(row => row.current_status === 'EXCEPTION')) {
    label = '异常资源货';
    warning = '资源状态异常，请联系运营或财务确认。';
  } else if (sn?.tax_type === 'UNTAXED') {
    label = '未税货';
    warning = '该机器为未税库存，开票和成本核算需按未税规则处理。';
  } else if (consumed.length) {
    label = '资源已消耗货';
    warning = consumed.map(row => `${resourceName(row.resource_type)}${row.current_status === 'USED' ? '已核销' : '已套回'}，不可再使用。`).join(' ');
  } else if (categories.length > 0 && categories.every(category => rights.some(row => row.resource_type === category.category_code && row.current_status === 'AVAILABLE'))) {
    label = '全资源货';
  } else if (available.length > 0) {
    label = `${available.join('+')}货`;
  }
  return {
    sales_resource_label: label,
    available_resource_summary: available.join(' / ') || '无',
    unavailable_resource_summary: unavailable.join(' / ') || '无',
    warning_message: warning,
    tax_type: sn?.tax_type || 'UNKNOWN',
    rights
  };
}

async function summariesForSns(snRows, transaction = null) {
  const ids = snRows.map(row => row.sn_id).filter(Boolean);
  const rights = ids.length ? await InventoryResourceRight.findAll({ where: { sn_id: { [Op.in]: ids } }, transaction }) : [];
  const grouped = new Map();
  for (const right of rights) {
    if (!grouped.has(right.sn_id)) grouped.set(right.sn_id, []);
    grouped.get(right.sn_id).push(right);
  }
  const categories = await getResourceCategories({ transaction });
  return new Map(snRows.map(sn => [sn.sn_id, buildSalesResourceSummary(sn, grouped.get(sn.sn_id) || [], categories)]));
}

async function listRights(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance', 'manager']);
  const { snCode, productId, resourceType, status, page = 1, pageSize = 20 } = ctx.query;
  const where = {};
  if (snCode) where.sn_code = { [Op.like]: `%${snCode}%` };
  if (productId) where.product_id = productId;
  if (resourceType) where.resource_type = resourceType;
  if (status) where.current_status = status;
  const { count, rows } = await InventoryResourceRight.findAndCountAll({
    where,
    include: [{ model: Product, attributes: ['name', 'product_code'] }],
    order: [['update_time', 'DESC']], distinct: true,
    ...paginate({}, { page, pageSize })
  });
  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

async function snRights(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance', 'manager']);
  const sn = await ProductSn.findByPk(ctx.params.snId, { include: [{ model: Product, attributes: ['name', 'product_code'] }] });
  if (!sn || sn.is_deleted) ctx.throw(404, 'SN不存在');
  const rows = await InventoryResourceRight.findAll({ where: { sn_id: sn.sn_id }, order: [['resource_type', 'ASC']] });
  const categories = await getResourceCategories();
  const adjustments = await InventoryResourceCostAdjustment.findAll({ where: { sn_id: sn.sn_id }, order: [['create_time', 'DESC']] });
  ctx.body = { sn, ...buildSalesResourceSummary(sn, rows, categories), cost_adjustments: adjustments };
}

async function saveSnRights(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance', 'manager']);
  const { taxType = 'UNKNOWN', sourceType = 'OTHER', rights: inputRights = [] } = ctx.request.body || {};
  if (!['TAX_INCLUDED', 'UNTAXED', 'UNKNOWN'].includes(taxType)) ctx.throw(400, '税务属性无效');
  if (!SOURCE_TYPES.includes(sourceType)) ctx.throw(400, '货源性质无效');
  const sn = await ProductSn.findByPk(ctx.params.snId);
  if (!sn || sn.is_deleted) ctx.throw(404, 'SN不存在');
  const categories = await getResourceCategories();
  const validTypes = new Set(categories.map(category => category.category_code));
  const categoriesByCode = categoryMap(categories);
  await sequelize.transaction(async transaction => {
    await sn.update({ tax_type: taxType, source_type: sourceType || 'OTHER' }, { transaction });
    for (const input of inputRights) {
      if (!validTypes.has(input.resourceType)) ctx.throw(400, '资源类型无效或已停用');
      if (!RIGHT_STATUSES.includes(input.status)) ctx.throw(400, '资源状态无效');
      if (!Number.isFinite(Number(input.amount || 0)) || Number(input.amount || 0) < 0) ctx.throw(400, '权益金额不得小于0');
      let right = await InventoryResourceRight.findOne({
        where: { sn_id: sn.sn_id, resource_type: input.resourceType }, transaction, lock: transaction.LOCK.UPDATE
      });
      if (right && right.current_status === 'LOCKED') ctx.throw(409, `${categoriesByCode.get(input.resourceType)?.name || input.resourceType}已锁定，不能维护`);
      const before = right?.current_status || 'NOT_APPLICABLE';
      if (right && ['USED', 'CLAIMED_BACK'].includes(before) && input.status !== before) ctx.throw(409, '已核销或已套回权益只能通过冲销流程处理');
      if (['LOCKED', 'USED', 'CLAIMED_BACK'].includes(input.status) && input.status !== before) ctx.throw(400, '该状态不能通过人工维护直接设置');
      if (!right) {
        right = await InventoryResourceRight.create({
          right_id: generateUUID(), sn_id: sn.sn_id, sn_code: sn.sn_code, product_id: sn.product_id,
          resource_type: input.resourceType, initial_status: input.status, current_status: input.status,
          amount: Number(input.amount || 0), source: input.source || 'MANUAL', remark: input.remark || ''
        }, { transaction });
      } else {
        await right.update({ current_status: input.status, amount: Number(input.amount || 0), source: input.source || right.source, remark: input.remark || '', version: Number(right.version || 0) + 1 }, { transaction });
      }
      if (before !== input.status) await ResourceRightChangeOrder.create({
        change_id: generateUUID(), change_order_no: businessNo(), sn_id: sn.sn_id, sn_code: sn.sn_code,
        product_id: sn.product_id, resource_type: input.resourceType, before_status: before, after_status: input.status,
        change_amount: Number(input.amount || 0), change_reason: 'MANUAL_ADJUST', approval_status: 'approved',
        applicant_staff_id: ctx.state.user.staffId, applicant_name: ctx.state.user.name,
        reviewer_staff_id: ctx.state.user.staffId, reviewer_name: ctx.state.user.name, review_time: new Date(), remark: input.remark || ''
      }, { transaction });
    }
  });
  ctx.body = { message: 'SN资源权益已保存' };
}

async function submitClaim(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance', 'manager']);
  const { snId, resourceType, amount, attachmentUrl, remark } = ctx.request.body || {};
  const category = await ResourceCategory.findOne({ where: { category_code: resourceType, status: 1 } });
  if (!category || !category.supports_company_claim) ctx.throw(400, '请选择允许公司套回的资源类型');
  const result = await sequelize.transaction(async transaction => {
    const sn = await ProductSn.findByPk(snId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!sn || sn.is_deleted) ctx.throw(404, 'SN不存在');
    const right = await InventoryResourceRight.findOne({ where: { sn_id: snId, resource_type: resourceType }, transaction, lock: transaction.LOCK.UPDATE });
    if (!right || right.current_status !== 'AVAILABLE') ctx.throw(409, `${category.name}当前不可套回`);
    const config = await ProductResourceCostConfig.findOne({ where: { product_id: sn.product_id, resource_type: resourceType, status: 1 }, transaction });
    const requestedAmount = Number(amount || 0);
    const claimAmount = requestedAmount > 0 ? requestedAmount : Number(config?.cost_amount || 0);
    if (!Number.isFinite(claimAmount) || claimAmount <= 0) ctx.throw(400, '套回金额必须大于0');
    const prior = await InventoryResourceCostAdjustment.sum('adjustment_amount', { where: { sn_id: snId }, transaction });
    const currentProductCost = Number(sn.inbound_price || 0) + Number(prior || 0);
    if (currentProductCost - claimAmount < 0) ctx.throw(400, '资源成本调整后不得小于0');
    const change = await ResourceRightChangeOrder.create({
      change_id: generateUUID(), change_order_no: businessNo(), sn_id: sn.sn_id, sn_code: sn.sn_code,
      product_id: sn.product_id, resource_type: resourceType, before_status: 'AVAILABLE', after_status: 'CLAIMED_BACK',
      change_amount: claimAmount, change_reason: 'COMPANY_CLAIMED_BACK', approval_status: 'pending_finance',
      attachment_url: attachmentUrl || '', applicant_staff_id: ctx.state.user.staffId,
      applicant_name: ctx.state.user.name, remark: remark || ''
    }, { transaction });
    await right.update({ current_status: 'LOCKED', locked_source_type: 'CLAIM', locked_source_id: change.change_id, version: Number(right.version || 0) + 1 }, { transaction });
    return change;
  });
  ctx.body = { changeId: result.change_id, changeOrderNo: result.change_order_no, message: '资源套回申请已提交财务审批' };
}

async function reviewClaim(ctx) {
  requireAnyRole(ctx, ['finance'], '仅财务账号可以审批资源套回');
  const { action, comment } = ctx.request.body || {};
  if (!['approve', 'reject'].includes(action)) ctx.throw(400, '审批操作无效');
  await sequelize.transaction(async transaction => {
    const change = await ResourceRightChangeOrder.findByPk(ctx.params.changeId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!change) ctx.throw(404, '套回申请不存在');
    if (change.approval_status !== 'pending_finance') ctx.throw(409, '该申请已处理');
    if (String(change.applicant_staff_id || '') === String(ctx.state.user.staffId || '')) ctx.throw(403, '申请人不得审批自己的套回申请');
    const right = await InventoryResourceRight.findOne({ where: { sn_id: change.sn_id, resource_type: change.resource_type }, transaction, lock: transaction.LOCK.UPDATE });
    if (!right || right.current_status !== 'LOCKED' || right.locked_source_type !== 'CLAIM' || right.locked_source_id !== change.change_id) ctx.throw(409, '权益锁定状态已变化，请人工核查');
    if (action === 'reject') {
      await right.update({ current_status: 'AVAILABLE', locked_source_type: null, locked_source_id: null, version: Number(right.version || 0) + 1 }, { transaction });
      await change.update({ approval_status: 'rejected', reviewer_staff_id: ctx.state.user.staffId, reviewer_name: ctx.state.user.name, review_comment: comment || '', review_time: new Date() }, { transaction });
      return;
    }
    const sn = await ProductSn.findByPk(change.sn_id, { transaction, lock: transaction.LOCK.UPDATE });
    const prior = await InventoryResourceCostAdjustment.sum('adjustment_amount', { where: { sn_id: change.sn_id }, transaction });
    const beforeCost = Number(sn.inbound_price || 0) + Number(prior || 0);
    const amount = Number(change.change_amount || 0);
    if (beforeCost - amount < 0) ctx.throw(400, '资源成本调整后不得小于0');
    await InventoryResourceCostAdjustment.create({
      adjustment_id: generateUUID(), sn_id: change.sn_id, sn_code: change.sn_code, product_id: change.product_id,
      resource_type: change.resource_type, adjustment_amount: -amount, before_product_cost: beforeCost,
      after_product_cost: beforeCost - amount, source_type: 'RESOURCE_CLAIM', source_id: change.change_id,
      affect_sales_settlement_cost: 0, operator_id: ctx.state.user.staffId, operator_name: ctx.state.user.name,
      remark: '资源套回审批确认；不影响销售结算成本'
    }, { transaction });
    await right.update({ current_status: 'CLAIMED_BACK', amount, locked_source_type: null, locked_source_id: null, version: Number(right.version || 0) + 1 }, { transaction });
    await change.update({ approval_status: 'approved', reviewer_staff_id: ctx.state.user.staffId, reviewer_name: ctx.state.user.name, review_comment: comment || '', review_time: new Date() }, { transaction });
    await createPendingSettlement({
      sourceType: 'COMPANY_CLAIM', sourceId: change.change_id, sn,
      resourceType: change.resource_type, amount, remark: `资源套回 ${change.change_order_no}`,
      transaction
    });
  });
  ctx.body = { message: action === 'approve' ? '资源套回已审批并计入产品资源成本' : '资源套回申请已拒绝并释放权益' };
}

async function listChanges(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance', 'manager']);
  const { snCode, resourceType, approvalStatus, reason, startDate, endDate, page = 1, pageSize = 20 } = ctx.query;
  const where = {};
  if (snCode) where.sn_code = { [Op.like]: `%${snCode}%` };
  if (resourceType) where.resource_type = resourceType;
  if (approvalStatus) where.approval_status = approvalStatus;
  if (reason) where.change_reason = reason;
  if (startDate || endDate) {
    where.create_time = {};
    if (startDate) where.create_time[Op.gte] = new Date(`${startDate}T00:00:00+08:00`);
    if (endDate) where.create_time[Op.lte] = new Date(`${endDate}T23:59:59+08:00`);
  }
  const { count, rows } = await ResourceRightChangeOrder.findAndCountAll({ where, order: [['create_time', 'DESC']], ...paginate({}, { page, pageSize }) });
  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

async function listCostConfigs(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance', 'manager']);
  const where = {};
  if (ctx.query.productId) where.product_id = ctx.query.productId;
  const rows = await ProductResourceCostConfig.findAll({ where, include: [{ model: Product, attributes: ['name', 'product_code'] }], order: [['update_time', 'DESC']] });
  ctx.body = rows;
}

async function listCostAdjustments(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance', 'manager']);
  const { snCode, productId, resourceType, page = 1, pageSize = 20 } = ctx.query;
  const where = {};
  if (snCode) where.sn_code = { [Op.like]: `%${snCode}%` };
  if (productId) where.product_id = productId;
  if (resourceType) where.resource_type = resourceType;
  const { count, rows } = await InventoryResourceCostAdjustment.findAndCountAll({
    where, order: [['create_time', 'DESC']], ...paginate({}, { page, pageSize })
  });
  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

async function saveCostConfig(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance']);
  const { productId, resourceType, costAmount, remark } = ctx.request.body || {};
  const category = await ResourceCategory.findOne({ where: { category_code: resourceType, status: 1 } });
  if (!category) ctx.throw(400, '资源类型无效或已停用');
  const amount = Number(costAmount);
  if (!Number.isFinite(amount) || amount < 0) ctx.throw(400, '资源成本必须大于或等于0');
  const product = await Product.findByPk(productId);
  if (!product || product.is_deleted) ctx.throw(404, '商品不存在');
  const [config, created] = await ProductResourceCostConfig.findOrCreate({
    where: { product_id: productId, resource_type: resourceType },
    defaults: { config_id: generateUUID(), cost_amount: amount, status: 1, remark: remark || '', create_user: ctx.state.user.name, update_user: ctx.state.user.name }
  });
  if (!created) await config.update({ cost_amount: amount, status: 1, remark: remark || '', update_user: ctx.state.user.name, update_time: new Date() });
  ctx.body = { message: '商品资源成本定义已保存' };
}

async function listResourceCategories(ctx) {
  const activeOnly = String(ctx.query.activeOnly || '') === '1';
  const rows = await ResourceCategory.findAll({
    where: activeOnly ? { status: 1 } : {},
    include: [{ model: SettlementAccount, as: 'DefaultAccount', required: false }],
    order: [['sort_order', 'ASC'], ['name', 'ASC']]
  });
  ctx.body = rows;
}

async function saveResourceCategory(ctx) {
  requireAnyRole(ctx, ['boss', 'admin']);
  const body = ctx.request.body || {};
  const name = String(body.name || '').trim();
  if (!name) ctx.throw(400, '请输入资源类别名称');
  if (body.defaultAccountId) {
    const account = await SettlementAccount.findOne({ where: { account_id: body.defaultAccountId, status: 1 } });
    if (!account) ctx.throw(400, '默认到账账户不存在或已停用');
  }
  const values = {
    name,
    short_name: String(body.shortName || name).trim(),
    default_account_id: body.defaultAccountId || null,
    supports_sale_use: body.supportsSaleUse === false ? 0 : 1,
    supports_company_claim: body.supportsCompanyClaim === false ? 0 : 1,
    sort_order: Number(body.sortOrder || 0),
    status: body.status === 0 ? 0 : 1,
    remark: String(body.remark || '').trim(),
    update_time: new Date()
  };
  let record;
  if (body.categoryId) {
    record = await ResourceCategory.findByPk(body.categoryId);
    if (!record) ctx.throw(404, '资源类别不存在');
    await record.update(values);
  } else {
    const id = generateUUID();
    record = await ResourceCategory.create({
      category_id: id,
      category_code: `RES_${id.slice(0, 28)}`,
      ...values
    });
  }
  ctx.body = { message: '资源类别已保存', categoryId: record.category_id };
}

async function createPendingSettlement({ sourceType, sourceId, sn, resourceType, amount, counterpartyId = null, counterpartyName = '', remark = '', transaction }) {
  const numericAmount = Number(amount || 0);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) return null;
  const category = await ResourceCategory.findOne({ where: { category_code: resourceType }, transaction });
  if (!category) throw Object.assign(new Error('资源类别配置不存在，无法生成待下账记录'), { status: 409 });
  const [record] = await ResourceSettlement.findOrCreate({
    where: { source_type: sourceType, source_id: sourceId, resource_type: resourceType },
    defaults: {
      settlement_id: generateUUID(), settlement_no: businessNo('RST'), source_type: sourceType,
      source_id: sourceId, sn_id: sn.sn_id, sn_code: sn.sn_code, product_id: sn.product_id,
      resource_type: resourceType, counterparty_id: counterpartyId, counterparty_name: counterpartyName,
      amount: numericAmount, status: 'PENDING',
      target_account_id: category.default_account_id || null, remark
    },
    transaction
  });
  return record;
}

async function listResourceSettlements(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance']);
  const { status, resourceType, snCode, page = 1, pageSize = 20 } = ctx.query;
  const where = {};
  if (status) where.status = status;
  if (resourceType) where.resource_type = resourceType;
  if (snCode) where.sn_code = { [Op.like]: `%${snCode}%` };
  const { count, rows } = await ResourceSettlement.findAndCountAll({
    where,
    include: [
      { model: ResourceCategory, as: 'ResourceCategory', required: false, include: [{ model: SettlementAccount, as: 'DefaultAccount', required: false }] },
      { model: SettlementAccount, as: 'TargetAccount', required: false }
    ],
    order: [['create_time', 'DESC']],
    distinct: true,
    ...paginate({}, { page, pageSize })
  });
  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

async function settleResource(ctx) {
  requireAnyRole(ctx, ['finance'], '仅财务账号可以执行资源下账');
  const accountOverride = ctx.request.body?.accountId || null;
  await sequelize.transaction(async transaction => {
    const record = await ResourceSettlement.findByPk(ctx.params.settlementId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!record) ctx.throw(404, '资源待下账记录不存在');
    if (record.status !== 'PENDING') ctx.throw(409, '该资源记录已完成下账');
    const category = await ResourceCategory.findOne({ where: { category_code: record.resource_type }, transaction });
    let accountId = accountOverride || record.target_account_id || category?.default_account_id;
    if (!accountId) ctx.throw(400, '该资源类别尚未配置到账账户');
    let account = await SettlementAccount.findOne({ where: { account_id: accountId, status: 1 }, transaction, lock: transaction.LOCK.UPDATE });
    if (!account) ctx.throw(400, '到账账户不存在或已停用');
    if (account.account_type === 'SUPPLIER_REBATE' && record.counterparty_id && account.supplier_id !== record.counterparty_id) {
      account = await SettlementAccount.findOne({
        where: { account_type: 'SUPPLIER_REBATE', supplier_id: record.counterparty_id, status: 1 },
        transaction, lock: transaction.LOCK.UPDATE
      });
      if (!account) ctx.throw(400, `未配置${record.counterparty_name || '该供应商'}的供应商返利账户`);
      accountId = account.account_id;
    }
    const income = Number(await SettlementAccountTransaction.sum('amount', { where: { account_id: accountId, type: 'income' }, transaction }) || 0);
    const expense = Number(await SettlementAccountTransaction.sum('amount', { where: { account_id: accountId, type: 'expense' }, transaction }) || 0);
    const amount = Number(record.amount || 0);
    await SettlementAccountTransaction.create({
      transaction_id: generateUUID(), account_id: accountId, type: 'income', amount,
      balance_after: income - expense + amount,
      description: `${category?.name || record.resource_type}下账（${{ SALE_USE: '销售使用', COMPANY_CLAIM: '公司套回', MANUFACTURER_REBATE: '厂商返利' }[record.source_type] || record.source_type}）`,
      related_ref: record.settlement_no, create_user: ctx.state.user.name
    }, { transaction });

    if (account.account_type === 'SUPPLIER_REBATE') {
      if (!account.supplier_id) ctx.throw(400, '供应商返利账户未绑定供应商');
      const supplier = await Supplier.findByPk(account.supplier_id, { transaction });
      if (!supplier) ctx.throw(400, '供应商返利账户绑定的供应商不存在');
      const latest = await SupplierRebate.findOne({
        where: { supplier_id: account.supplier_id }, order: [['create_time', 'DESC'], ['rebate_id', 'DESC']], transaction, lock: transaction.LOCK.UPDATE
      });
      await SupplierRebate.create({
        rebate_id: generateUUID(), supplier_id: supplier.supplier_id, supplier_name: supplier.name,
        type: 'credit', amount, balance: Number(latest?.balance || 0) + amount,
        related_no: record.settlement_no, remark: `${category?.name || record.resource_type}下账转入供应商返利`,
        status: 'active', source_type: 'resource_settlement', source_id: record.settlement_id,
        create_user: ctx.state.user.name
      }, { transaction });
    }

    await record.update({
      status: 'SETTLED', target_account_id: accountId, settled_at: new Date(),
      settled_by: ctx.state.user.staffId, settled_by_name: ctx.state.user.name
    }, { transaction });
    if (record.source_type === 'MANUFACTURER_REBATE') {
      await RebateEstimate.update({ status: 'received', updated_at: new Date() }, { where: { estimate_id: record.source_id }, transaction });
    }
  });
  ctx.body = { message: '资源权益已下账' };
}

function selectedResources(item) {
  let dynamic = [];
  try {
    dynamic = Array.isArray(item.selected_resource_types)
      ? item.selected_resource_types
      : JSON.parse(item.selected_resource_types || '[]');
  } catch (_) {
    dynamic = [];
  }
  return [...new Set([...dynamic,
    item.use_gov_subsidy ? 'GOV_SUBSIDY' : null,
    item.use_edu_subsidy ? 'EDU_SUBSIDY' : null,
    item.use_sales_report ? 'SALES_REPORT' : null
  ].filter(Boolean))];
}

async function lockSaleRights(order, items, transaction) {
  for (const item of items) {
    if (!item.sn_id) continue;
    for (const resourceType of selectedResources(item)) {
      const category = await ResourceCategory.findOne({ where: { category_code: resourceType, status: 1 }, transaction });
      if (!category || !category.supports_sale_use) throw Object.assign(new Error('所选资源类别不存在、已停用或不允许销售使用'), { status: 409 });
      const right = await InventoryResourceRight.findOne({ where: { sn_id: item.sn_id, resource_type: resourceType }, transaction, lock: transaction.LOCK.UPDATE });
      if (!right || right.current_status !== 'AVAILABLE') throw Object.assign(new Error(`SN ${item.sn_code} 的${category.name}不可用`), { status: 409 });
      await right.update({ current_status: 'LOCKED', locked_source_type: 'SALE_ORDER', locked_source_id: order.order_id, version: Number(right.version || 0) + 1 }, { transaction });
      await ResourceRightChangeOrder.create({
        change_id: generateUUID(), change_order_no: businessNo(), sn_id: item.sn_id, sn_code: item.sn_code,
        product_id: item.product_id, resource_type: resourceType, before_status: 'AVAILABLE', after_status: 'LOCKED',
        change_amount: 0, change_reason: 'ORDER_LOCKED', approval_status: 'approved', related_sale_order_id: order.order_id,
        applicant_name: order.create_user, remark: `销售订单 ${order.order_no} 占用`
      }, { transaction });
    }
  }
}

async function finishSaleRights(order, items, transaction) {
  for (const item of items) for (const resourceType of selectedResources(item)) {
    const category = await ResourceCategory.findOne({ where: { category_code: resourceType }, transaction });
    const right = await InventoryResourceRight.findOne({ where: { sn_id: item.sn_id, resource_type: resourceType }, transaction, lock: transaction.LOCK.UPDATE });
    if (!right || right.current_status !== 'LOCKED' || right.locked_source_type !== 'SALE_ORDER' || right.locked_source_id !== order.order_id) throw Object.assign(new Error(`SN ${item.sn_code} 的${category?.name || resourceType}锁定状态异常`), { status: 409 });
    await right.update({ current_status: 'USED', locked_source_type: null, locked_source_id: null, version: Number(right.version || 0) + 1 }, { transaction });
    const change = await ResourceRightChangeOrder.create({
      change_id: generateUUID(), change_order_no: businessNo(), sn_id: item.sn_id, sn_code: item.sn_code,
      product_id: item.product_id, resource_type: resourceType, before_status: 'LOCKED', after_status: 'USED',
      change_amount: 0, change_reason: 'SALE_USED', approval_status: 'approved', related_sale_order_id: order.order_id,
      applicant_name: order.create_user, remark: `销售订单 ${order.order_no} 归档核销`
    }, { transaction });
    await createPendingSettlement({
      sourceType: 'SALE_USE', sourceId: change.change_id,
      sn: { sn_id: item.sn_id, sn_code: item.sn_code, product_id: item.product_id },
      resourceType, amount: right.amount, remark: `销售订单 ${order.order_no} 使用权益`, transaction
    });
  }
}

async function releaseSaleRights(order, items, transaction) {
  for (const item of items) for (const resourceType of selectedResources(item)) {
    const right = await InventoryResourceRight.findOne({ where: { sn_id: item.sn_id, resource_type: resourceType }, transaction, lock: transaction.LOCK.UPDATE });
    if (!right || right.current_status !== 'LOCKED' || right.locked_source_type !== 'SALE_ORDER' || right.locked_source_id !== order.order_id) continue;
    await right.update({ current_status: 'AVAILABLE', locked_source_type: null, locked_source_id: null, version: Number(right.version || 0) + 1 }, { transaction });
    await ResourceRightChangeOrder.create({
      change_id: generateUUID(), change_order_no: businessNo(), sn_id: item.sn_id, sn_code: item.sn_code,
      product_id: item.product_id, resource_type: resourceType, before_status: 'LOCKED', after_status: 'AVAILABLE',
      change_amount: 0, change_reason: 'ORDER_CANCEL_RELEASE', approval_status: 'approved', related_sale_order_id: order.order_id,
      applicant_name: order.create_user, remark: `销售订单 ${order.order_no} 取消释放`
    }, { transaction });
  }
}

module.exports = {
  LEGACY_RESOURCE_TYPES, buildSalesResourceSummary, summariesForSns,
  listRights, snRights, saveSnRights, submitClaim, reviewClaim, listChanges, listCostConfigs, listCostAdjustments, saveCostConfig,
  listResourceCategories, saveResourceCategory, listResourceSettlements, settleResource, createPendingSettlement,
  lockSaleRights, finishSaleRights, releaseSaleRights
};
