const { Op } = require('sequelize');
const {
  sequelize, Product, ProductSn, InventoryResourceRight, ResourceRightChangeOrder,
  ProductResourceCostConfig, InventoryResourceCostAdjustment, ResourceCategory,
  ResourceSettlement, SettlementAccount, SettlementAccountTransaction, SupplierRebate, RebateEstimate, Supplier,
  StaffCareCreditTransaction, PerformanceProfitAdjustment
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

function parseJsonArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function money(value) {
  const number = Number(value || 0);
  return Math.round(number * 100) / 100;
}

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
  if (usableOnly) where[Op.or] = [{ supports_sale_use: 1 }, { supports_company_claim: 1 }, { supports_purchase_select: 1 }, { trigger_on_sale: 1 }];
  return ResourceCategory.findAll({ where, order: [['sort_order', 'ASC'], ['name', 'ASC']], transaction });
}

async function getPurchaseSelectableResourceCategories({ transaction = null } = {}) {
  return ResourceCategory.findAll({
    where: { status: 1, supports_purchase_select: 1 },
    order: [['sort_order', 'ASC'], ['name', 'ASC']],
    transaction
  });
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

async function batchAdjustRights(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance', 'manager']);
  const { snCodes = [], productId, resourceTypes = [], status = 'AVAILABLE', amount = 0, remark = '' } = ctx.request.body || {};
  const normalizedTypes = [...new Set(resourceTypes.filter(Boolean))];
  if (normalizedTypes.length === 0) ctx.throw(400, '请选择需要调整的资源权益');
  if (!['AVAILABLE', 'NOT_APPLICABLE', 'EXCEPTION'].includes(status)) ctx.throw(400, '批量调整只允许设置为可用、不适用或异常');
  const categories = await getPurchaseSelectableResourceCategories();
  const validTypes = new Set(categories.map(row => row.category_code));
  for (const type of normalizedTypes) if (!validTypes.has(type)) ctx.throw(400, `资源权益 ${type} 无效或已停用`);
  const where = { is_deleted: 0, status: 'in_stock' };
  if (Array.isArray(snCodes) && snCodes.length > 0) where.sn_code = { [Op.in]: snCodes };
  if (productId) where.product_id = productId;
  if (!where.sn_code && !where.product_id) ctx.throw(400, '请按SN或商品指定批量调整范围');

  let affected = 0;
  await sequelize.transaction(async transaction => {
    const sns = await ProductSn.findAll({ where, transaction });
    for (const sn of sns) {
      for (const resourceType of normalizedTypes) {
        let right = await InventoryResourceRight.findOne({ where: { sn_id: sn.sn_id, resource_type: resourceType }, transaction, lock: transaction.LOCK.UPDATE });
        const before = right?.current_status || 'NOT_APPLICABLE';
        if (['LOCKED', 'USED', 'CLAIMED_BACK'].includes(before)) continue;
        if (!right) {
          right = await InventoryResourceRight.create({
            right_id: generateUUID(), sn_id: sn.sn_id, sn_code: sn.sn_code, product_id: sn.product_id,
            resource_type: resourceType, initial_status: status, current_status: status,
            amount: money(amount), source: 'BATCH_ADJUST', remark
          }, { transaction });
        } else {
          await right.update({ current_status: status, amount: money(amount), source: 'BATCH_ADJUST', remark, version: Number(right.version || 0) + 1 }, { transaction });
        }
        await ResourceRightChangeOrder.create({
          change_id: generateUUID(), change_order_no: businessNo(), sn_id: sn.sn_id, sn_code: sn.sn_code,
          product_id: sn.product_id, resource_type: resourceType, before_status: before, after_status: status,
          change_amount: money(amount), change_reason: 'BATCH_ADJUST', approval_status: 'approved',
          applicant_staff_id: ctx.state.user.staffId, applicant_name: ctx.state.user.name,
          reviewer_staff_id: ctx.state.user.staffId, reviewer_name: ctx.state.user.name,
          review_time: new Date(), remark
        }, { transaction });
        affected += 1;
      }
    }
  });
  ctx.body = { message: '批量权益调整完成', affected };
}

async function batchRefreshRights(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance', 'manager']);
  const { productId, resourceTypes = [], snCodes = [] } = ctx.request.body || {};
  const normalizedTypes = [...new Set(resourceTypes.filter(Boolean))];
  if (!productId && (!Array.isArray(snCodes) || snCodes.length === 0)) ctx.throw(400, '请按商品或SN指定刷新范围');
  const where = { is_deleted: 0, status: 'in_stock' };
  if (productId) where.product_id = productId;
  if (Array.isArray(snCodes) && snCodes.length > 0) where.sn_code = { [Op.in]: snCodes };
  let affected = 0;
  await sequelize.transaction(async transaction => {
    const sns = await ProductSn.findAll({ where, transaction });
    const snIds = sns.map(sn => sn.sn_id);
    if (snIds.length === 0) return;
    const snById = new Map(sns.map(sn => [sn.sn_id, sn]));
    const rightWhere = {
      sn_id: { [Op.in]: snIds },
      current_status: { [Op.in]: ['AVAILABLE', 'NOT_APPLICABLE', 'EXCEPTION'] }
    };
    if (normalizedTypes.length > 0) rightWhere.resource_type = { [Op.in]: normalizedTypes };
    const rights = await InventoryResourceRight.findAll({ where: rightWhere, transaction, lock: transaction.LOCK.UPDATE });
    for (const right of rights) {
      const rule = await findResourceRule({
        productId: right.product_id,
        resourceType: right.resource_type,
        supplierId: right.supplier_id || '',
        saleDate: new Date(),
        transaction
      });
      if (!rule) continue;
      await right.update({
        rule_config_id: rule.config_id,
        amount: calculatePreSaleRuleAmount(rule, snById.get(right.sn_id)),
        version: Number(right.version || 0) + 1,
        remark: right.remark || '按当前权益规则批量刷新'
      }, { transaction });
      affected += 1;
    }
  });
  ctx.body = { message: '资源权益规则刷新完成；已归档销售单未受影响', affected };
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
  const {
    productId, resourceType, costAmount, remark, supplierId = '', supplierName = '',
    calculationType = 'fixed_amount', calculationValue, effectiveStart, effectiveEnd,
    triggerCondition = 'sale_archived', affectsPerformanceProfit = false, performanceProfitRatio = 100,
    ruleConfigJson = null
  } = ctx.request.body || {};
  const category = await ResourceCategory.findOne({ where: { category_code: resourceType, status: 1 } });
  if (!category) ctx.throw(400, '资源类型无效或已停用');
  const amount = Number(costAmount);
  if (!Number.isFinite(amount) || amount < 0) ctx.throw(400, '资源成本必须大于或等于0');
  const product = await Product.findByPk(productId);
  if (!product || product.is_deleted) ctx.throw(404, '商品不存在');
  const [config, created] = await ProductResourceCostConfig.findOrCreate({
    where: { product_id: productId, resource_type: resourceType, supplier_id: supplierId || '' },
    defaults: {
      config_id: generateUUID(), supplier_id: supplierId || '', supplier_name: supplierName || '',
      cost_amount: amount, calculation_type: calculationType, calculation_value: Number(calculationValue ?? amount),
      effective_start: effectiveStart || null, effective_end: effectiveEnd || null,
      trigger_condition: triggerCondition, affects_performance_profit: affectsPerformanceProfit ? 1 : 0,
      performance_profit_ratio: Number(performanceProfitRatio || 100),
      rule_config_json: ruleConfigJson ? JSON.stringify(ruleConfigJson) : null,
      status: 1, remark: remark || '', create_user: ctx.state.user.name, update_user: ctx.state.user.name
    }
  });
  if (!created) await config.update({
    supplier_id: supplierId || '', supplier_name: supplierName || '',
    cost_amount: amount, calculation_type: calculationType, calculation_value: Number(calculationValue ?? amount),
    effective_start: effectiveStart || null, effective_end: effectiveEnd || null,
    trigger_condition: triggerCondition, affects_performance_profit: affectsPerformanceProfit ? 1 : 0,
    performance_profit_ratio: Number(performanceProfitRatio || 100),
    rule_config_json: ruleConfigJson ? JSON.stringify(ruleConfigJson) : config.rule_config_json,
    status: 1, remark: remark || '', update_user: ctx.state.user.name, update_time: new Date()
  });
  ctx.body = { message: '商品资源权益规则已保存' };
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
    resource_kind: String(body.resourceKind || body.resource_kind || 'SALE_USE').trim(),
    default_account_id: body.defaultAccountId || null,
    supports_purchase_select: body.supportsPurchaseSelect === false ? 0 : 1,
    supports_sale_use: body.supportsSaleUse === false ? 0 : 1,
    supports_company_claim: body.supportsCompanyClaim === false ? 0 : 1,
    trigger_on_sale: body.triggerOnSale === true ? 1 : 0,
    generates_settlement: body.generatesSettlement === false ? 0 : 1,
    generates_staff_care_credit: body.generatesStaffCareCredit === true ? 1 : 0,
    affects_performance_profit: body.affectsPerformanceProfit === true ? 1 : 0,
    performance_profit_ratio: Number(body.performanceProfitRatio ?? 100),
    rule_config_json: body.ruleConfigJson ? JSON.stringify(body.ruleConfigJson) : (body.ruleConfigText || body.rule_config_json || null),
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
  if (Number(category.generates_settlement) === 0) return null;
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

async function findResourceRule({ productId, resourceType, supplierId = '', saleDate = new Date(), transaction = null }) {
  const rows = await ProductResourceCostConfig.findAll({
    where: {
      product_id: productId,
      resource_type: resourceType,
      status: 1,
      [Op.or]: [{ supplier_id: supplierId || '' }, { supplier_id: null }, { supplier_id: '' }]
    },
    order: [['update_time', 'DESC']],
    transaction
  });
  rows.sort((left, right) => {
    const leftPriority = String(left.supplier_id || '') === String(supplierId || '') ? 0 : 1;
    const rightPriority = String(right.supplier_id || '') === String(supplierId || '') ? 0 : 1;
    return leftPriority - rightPriority;
  });
  const ts = new Date(saleDate || new Date()).getTime();
  return rows.find(row => {
    const start = row.effective_start ? new Date(row.effective_start).getTime() : null;
    const end = row.effective_end ? new Date(row.effective_end).getTime() : null;
    return (!start || ts >= start) && (!end || ts <= end);
  }) || null;
}

function calculatePreSaleRuleAmount(rule, sn) {
  if (!rule) return 0;
  const calcType = rule.calculation_type || 'fixed_amount';
  const calcValue = Number(rule.calculation_value || 0);
  if (calcType === 'percentage_inventory_cost') return money(Number(sn?.inbound_price || 0) * calcValue / 100);
  if (calcType === 'percentage_sale_amount') return 0;
  return money(calcValue || rule.cost_amount || 0);
}

function calculateRuleAmount({ rule, right, item }) {
  const calcType = rule?.calculation_type || 'fixed_amount';
  const calcValue = Number(rule?.calculation_value || 0);
  if (calcType === 'percentage_inventory_cost') return money(Number(item.original_inventory_cost || 0) * calcValue / 100);
  if (calcType === 'percentage_sale_amount') return money(Number(item.subtotal || 0) * calcValue / 100);
  return money(calcValue || rule?.cost_amount || right?.amount || 0);
}

function ruleTriggerMatches({ rule, right, saleDate }) {
  if (!rule || rule.trigger_condition !== 'sold_within_days') return true;
  const config = parseJsonObject(rule.rule_config_json);
  const days = Number(config.saleWithinDays || config.withinDays || 0);
  if (!Number.isFinite(days) || days <= 0 || !right?.create_time) return false;
  const deadline = new Date(right.create_time).getTime() + days * 24 * 60 * 60 * 1000;
  return new Date(saleDate).getTime() <= deadline;
}

async function createStaffCareCredit({ order, item, resourceType, amount, transaction }) {
  if (amount <= 0) return null;
  const staffName = order.create_user || 'UNKNOWN';
  const staffWhere = order.create_staff_id ? { staff_id: order.create_staff_id } : { staff_name: staffName };
  const income = Number(await StaffCareCreditTransaction.sum('amount', { where: { ...staffWhere, type: 'income', status: 'active' }, transaction }) || 0);
  const expense = Number(await StaffCareCreditTransaction.sum('amount', { where: { ...staffWhere, type: 'expense', status: 'active' }, transaction }) || 0);
  const sourceId = `${String(order.order_id).slice(0, 16)}:${String(item.item_id).slice(0, 12)}:${String(resourceType).slice(0, 24)}`;
  const [record] = await StaffCareCreditTransaction.findOrCreate({
    where: { source_type: 'SALE_RESOURCE', source_id: sourceId },
    defaults: {
      transaction_id: generateUUID(),
      staff_id: order.create_staff_id || null,
      staff_name: staffName,
      type: 'income',
      amount,
      balance_after: money(income - expense + amount),
      source_type: 'SALE_RESOURCE',
      source_id: sourceId,
      order_id: order.order_id,
      order_no: order.order_no,
      order_item_id: item.item_id,
      sn_id: item.sn_id,
      sn_code: item.sn_code,
      product_id: item.product_id,
      resource_type: resourceType,
      remark: `销售订单 ${order.order_no} 产生销售个人Care可用金`
    },
    transaction
  });
  return record;
}

async function createPerformanceProfitAdjustment({ order, item, resourceType, amount, ratio, transaction }) {
  const signedAmount = money(amount * Number(ratio || 100) / 100);
  if (signedAmount <= 0) return null;
  const adjustmentNo = `AUTO-${String(order.order_id).slice(0, 12)}-${item.item_id}-${String(resourceType).slice(0, 16)}`;
  const existing = await PerformanceProfitAdjustment.findOne({ where: { adjustment_no: adjustmentNo }, transaction });
  if (existing) return existing;
  return PerformanceProfitAdjustment.create({
    adjustment_id: generateUUID(),
    adjustment_no: adjustmentNo,
    order_id: order.order_id,
    order_no: order.order_no,
    store_id: order.store_id,
    employee_name: order.create_user || '',
    adjustment_type: 'increase',
    amount: signedAmount,
    signed_amount: signedAmount,
    base_gross_profit: item.sales_gross_profit || 0,
    reason: `${resourceType} 销售归档自动计入员工业绩毛利`,
    status: 'approved',
    applicant_staff_id: 0,
    applicant_name: 'system',
    finance_reviewer_id: 0,
    finance_reviewer_name: 'system',
    finance_review_time: new Date(),
    admin_reviewer_id: 0,
    admin_reviewer_name: 'system',
    admin_review_time: new Date(),
    create_time: new Date(),
    update_time: new Date()
  }, { transaction });
}

async function initializeSnResourceRightsFromInbound({ sn, inbound, inboundItem, supplier = null, transaction }) {
  const resourceTypes = parseJsonArray(inboundItem.selected_resource_types);
  if (!sn || resourceTypes.length === 0) return [];
  const categories = await getPurchaseSelectableResourceCategories({ transaction });
  const validTypes = new Set(categories.map(row => row.category_code));
  const created = [];
  for (const resourceType of [...new Set(resourceTypes)]) {
    if (!validTypes.has(resourceType)) continue;
    const rule = await findResourceRule({
      productId: sn.product_id,
      resourceType,
      supplierId: supplier?.supplier_id || '',
      saleDate: new Date(),
      transaction
    });
    const amount = calculatePreSaleRuleAmount(rule, sn);
    const [right, wasCreated] = await InventoryResourceRight.findOrCreate({
      where: { sn_id: sn.sn_id, resource_type: resourceType },
      defaults: {
        right_id: generateUUID(),
        sn_id: sn.sn_id,
        sn_code: sn.sn_code,
        product_id: sn.product_id,
        resource_type: resourceType,
        rule_config_id: rule?.config_id || null,
        source_request_id: inbound?.purchase_request_id || null,
        source_request_item_id: inboundItem.purchase_request_item_id || null,
        source_inbound_id: inbound?.inbound_id || null,
        supplier_id: supplier?.supplier_id || null,
        supplier_name: supplier?.name || null,
        initial_status: 'AVAILABLE',
        current_status: 'AVAILABLE',
        amount,
        source: 'PURCHASE_INBOUND',
        remark: `采购入库 ${inbound?.inbound_no || ''} 自动生成`
      },
      transaction
    });
    if (wasCreated) {
      await ResourceRightChangeOrder.create({
        change_id: generateUUID(),
        change_order_no: businessNo(),
        sn_id: sn.sn_id,
        sn_code: sn.sn_code,
        product_id: sn.product_id,
        resource_type: resourceType,
        before_status: 'NOT_APPLICABLE',
        after_status: 'AVAILABLE',
        change_amount: amount,
        change_reason: 'PURCHASE_INBOUND',
        approval_status: 'approved',
        related_order_id: inbound?.inbound_id || null,
        applicant_name: inbound?.create_user || '',
        reviewer_name: inbound?.create_user || '',
        review_time: new Date(),
        remark: `采购申请 ${inbound?.source_no || ''} 勾选权益`
      }, { transaction });
      created.push(right);
    }
  }
  return created;
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

async function triggerSaleResourceBenefits(order, items, transaction) {
  const snItems = items.filter(item => item.sn_id);
  if (snItems.length === 0) return;
  const categories = await ResourceCategory.findAll({
    where: { status: 1, trigger_on_sale: 1 },
    transaction
  });
  const categoriesByCode = categoryMap(categories);
  if (categories.length === 0) return;

  const rights = await InventoryResourceRight.findAll({
    where: {
      sn_id: { [Op.in]: snItems.map(item => item.sn_id) },
      resource_type: { [Op.in]: categories.map(category => category.category_code) },
      current_status: 'AVAILABLE'
    },
    transaction,
    lock: transaction.LOCK.UPDATE
  });
  const rightsBySnType = new Map(rights.map(row => [`${row.sn_id}:${row.resource_type}`, row]));

  for (const item of snItems) {
    for (const category of categories) {
      if (Number(category.supports_sale_use) === 1 && selectedResources(item).includes(category.category_code)) continue;
      const right = rightsBySnType.get(`${item.sn_id}:${category.category_code}`);
      if (!right) continue;
      const rule = await findResourceRule({
        productId: item.product_id,
        resourceType: category.category_code,
        supplierId: right.supplier_id || '',
        saleDate: new Date(),
        transaction
      });
      const requiresRule = ['PO_REWARD', 'CARE_CREDIT', 'REBATE'].includes(category.resource_kind);
      const eligible = (!requiresRule || Boolean(rule)) && ruleTriggerMatches({ rule, right, saleDate: new Date() });
      if (!eligible) {
        await ResourceRightChangeOrder.create({
          change_id: generateUUID(),
          change_order_no: businessNo(),
          sn_id: item.sn_id,
          sn_code: item.sn_code,
          product_id: item.product_id,
          resource_type: category.category_code,
          before_status: 'AVAILABLE',
          after_status: 'NOT_APPLICABLE',
          change_amount: 0,
          change_reason: 'SALE_TRIGGER_NOT_ELIGIBLE',
          approval_status: 'approved',
          related_sale_order_id: order.order_id,
          applicant_name: order.create_user,
          reviewer_name: 'system',
          review_time: new Date(),
          remark: `销售订单 ${order.order_no} 未满足${category.name}条件`
        }, { transaction });
        await right.update({
          current_status: 'NOT_APPLICABLE',
          locked_source_type: null,
          locked_source_id: null,
          version: Number(right.version || 0) + 1
        }, { transaction });
        continue;
      }
      const amount = calculateRuleAmount({ rule, right, item });
      const change = await ResourceRightChangeOrder.create({
        change_id: generateUUID(),
        change_order_no: businessNo(),
        sn_id: item.sn_id,
        sn_code: item.sn_code,
        product_id: item.product_id,
        resource_type: category.category_code,
        before_status: 'AVAILABLE',
        after_status: 'USED',
        change_amount: amount,
        change_reason: 'SALE_TRIGGER',
        approval_status: 'approved',
        related_sale_order_id: order.order_id,
        applicant_name: order.create_user,
        reviewer_name: 'system',
        review_time: new Date(),
        remark: `销售订单 ${order.order_no} 归档触发${category.name}`
      }, { transaction });
      await right.update({
        current_status: 'USED',
        amount,
        locked_source_type: null,
        locked_source_id: null,
        version: Number(right.version || 0) + 1
      }, { transaction });

      if (Number(category.generates_staff_care_credit) === 1) {
        await createStaffCareCredit({ order, item, resourceType: category.category_code, amount, transaction });
      }
      let rebateEstimate = null;
      if (category.resource_kind === 'PO_REWARD' && amount > 0) {
        [rebateEstimate] = await RebateEstimate.findOrCreate({
          where: { source_type: 'resource_right', source_id: change.change_id },
          defaults: {
            estimate_id: generateUUID(),
            sales_order_id: order.order_id,
            sales_order_no: order.order_no,
            sales_order_item_id: item.item_id,
            supplier_id: right.supplier_id || '',
            supplier_name: right.supplier_name || '',
            product_id: item.product_id,
            product_name: item.product_name,
            pn: item.pn_code,
            sn: item.sn_code,
            policy_id: rule?.config_id || null,
            policy_name: category.name,
            policy_type: 'PO_REWARD',
            rebate_estimate_amount: amount,
            status: 'estimated',
            source_type: 'resource_right',
            source_id: change.change_id,
            remark: `销售订单 ${order.order_no} 达成PO奖励条件`
          },
          transaction
        });
      }
      if (Number(category.generates_settlement) === 1 && amount > 0) {
        await createPendingSettlement({
          sourceType: rebateEstimate ? 'MANUFACTURER_REBATE' : 'SALE_TRIGGER',
          sourceId: rebateEstimate?.estimate_id || change.change_id,
          sn: { sn_id: item.sn_id, sn_code: item.sn_code, product_id: item.product_id },
          resourceType: category.category_code,
          amount,
          counterpartyId: right.supplier_id || null,
          counterpartyName: right.supplier_name || '',
          remark: `销售订单 ${order.order_no} 触发${category.name}`,
          transaction
        });
      }
      const affectsProfit = Number(rule?.affects_performance_profit ?? category.affects_performance_profit) === 1;
      if (affectsProfit) {
        await createPerformanceProfitAdjustment({
          order,
          item,
          resourceType: category.category_code,
          amount,
          ratio: rule?.performance_profit_ratio ?? category.performance_profit_ratio,
          transaction
        });
      }
    }
  }
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
  listRights, snRights, saveSnRights, batchAdjustRights, batchRefreshRights, submitClaim, reviewClaim, listChanges, listCostConfigs, listCostAdjustments, saveCostConfig,
  listResourceCategories, saveResourceCategory, listResourceSettlements, settleResource, createPendingSettlement,
  initializeSnResourceRightsFromInbound, triggerSaleResourceBenefits,
  lockSaleRights, finishSaleRights, releaseSaleRights
};
