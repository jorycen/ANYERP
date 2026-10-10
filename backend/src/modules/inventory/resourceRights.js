const { Op } = require('sequelize');
const XLSX = require('xlsx');
const {
  sequelize, Product, ProductPn, ProductSn, OrderItem, InventoryResourceRight, ResourceRightChangeOrder,
  ProductResourceCostConfig, InventoryResourceCostAdjustment, ResourceCategory,
  GoodsType, GoodsTypeResource,
  ResourceSettlement, RebatePostingOrder, RebateSettlementAllocation,
  SettlementAccount, SettlementAccountTransaction, SupplierRebate, RebateEstimate, Supplier,
  StaffCareCreditTransaction, PerformanceProfitAdjustment, Order, ManufacturerPriceHistory,
  SalesCashRebatePolicy, SalesCashRebateClaim, SalesCashRebateClaimItem, SalesCashRebateReceipt
} = require('../../models');
const { generateUUID, paginate, formatPaginatedResult, buildPendingFirstOrder } = require('../../utils');

const LEGACY_RESOURCE_TYPES = ['GOV_SUBSIDY', 'EDU_SUBSIDY', 'SALES_REPORT'];
const SOURCE_TYPES = ['REGULAR_TAX', 'UNTAXED', 'CHANNEL_RESOURCE', 'PROMOTION_RESOURCE', 'SPECIAL_PRICE', 'OTHER'];
const RIGHT_STATUSES = ['AVAILABLE', 'LOCKED', 'USED', 'CLAIMED_BACK', 'NOT_APPLICABLE', 'EXCEPTION'];
const RESOURCE_LABELS = { GOV_SUBSIDY: '国补', EDU_SUBSIDY: '教育补贴', SALES_REPORT: '销量报号', OTHER_POLICY: '其他政策' };
const STATUS_LABELS = {
  AVAILABLE: '可用', LOCKED: '已锁定', USED: '已核销', CLAIMED_BACK: '已套回',
  NOT_APPLICABLE: '不适用', EXCEPTION: '异常'
};
const GOV_SUBSIDY_PRODUCT_CATEGORIES = new Set(['笔记本', '台机', '手机', '平板']);
const SALE_RESOURCE_TASK_TYPES = new Set(['EDU_SUBSIDY', 'SALES_REPORT', 'SALES_RED_PACKET', 'OTHER_POLICY']);
const SHARE_INCENTIVE_TYPE = 'SALES_RED_PACKET';
STATUS_LABELS.PENDING_EFFECTIVE = '未到生效日期';
STATUS_LABELS.EXPIRED = '已过期';

function isGovSubsidyEligibleCategory(category) {
  // 历史商品的 category 可能仍保存为完整路径（如“笔记本/联想/拯救者/R9000P”）。
  // 国补范围按一级商品分类判断，不能因为路径层级或分隔符而误判为不适用。
  const topLevel = String(category || '').trim().split(/[\\/>]+/)[0].trim();
  return GOV_SUBSIDY_PRODUCT_CATEGORIES.has(topLevel);
}

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

function chinaDateBoundary(dateText, endOfDay = false) {
  if (!dateText) return null;
  const value = String(dateText).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+08:00`);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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

function effectiveRightStatus(row, at = new Date()) {
  if (row?.current_status !== 'AVAILABLE') return row?.current_status || 'NOT_APPLICABLE';
  const timestamp = new Date(at).getTime();
  const start = row.effective_start ? new Date(row.effective_start).getTime() : null;
  const end = row.effective_end ? new Date(row.effective_end).getTime() : null;
  if (start && timestamp < start) return 'PENDING_EFFECTIVE';
  if (end && timestamp > end) return 'EXPIRED';
  return 'AVAILABLE';
}

function buildSalesResourceSummary(sn, rows = [], categories = []) {
  const rights = normalizeRights(rows, categories);
  const names = new Map(categories.map(category => [category.category_code, category.short_name || category.name]));
  const resourceName = type => names.get(type) || RESOURCE_LABELS[type] || type;
  const available = rights.filter(row => effectiveRightStatus(row) === 'AVAILABLE').map(row => row.resource_type === 'OTHER_POLICY' ? `其他政策：${row.remark || '待获取'}` : resourceName(row.resource_type));
  const unavailable = rights.filter(row => effectiveRightStatus(row) !== 'AVAILABLE').map(row => `${resourceName(row.resource_type)}${STATUS_LABELS[effectiveRightStatus(row)] || effectiveRightStatus(row)}`);
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
  } else if (categories.length > 0 && categories.every(category => rights.some(row => row.resource_type === category.category_code && effectiveRightStatus(row) === 'AVAILABLE'))) {
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
  const now = new Date();
  const pnCodes = [...new Set(snRows.map(sn => String(sn.pn_code || '').trim()).filter(Boolean))];
  const cashPolicies = pnCodes.length ? await SalesCashRebatePolicy.findAll({
    where: {
      pn_code: { [Op.in]: pnCodes }, status: 1,
      [Op.and]: [
        { [Op.or]: [{ effective_start: null }, { effective_start: { [Op.lte]: now } }] },
        { [Op.or]: [{ effective_end: null }, { effective_end: { [Op.gte]: now } }] }
      ]
    }, transaction
  }) : [];
  return new Map(snRows.map(sn => {
    const summary = buildSalesResourceSummary(sn, (grouped.get(sn.sn_id) || []).filter(row => row.resource_type !== 'SALES_CASH_REBATE'), categories);
    // 现金红包是销售政策，不是 SN 的库存权益台账。只对当前在库 SN
    // 展示可用政策；售出后的套回金额由订单归档与套回流程处理。
    if (String(sn.status || '').toLowerCase() !== 'in_stock') return [sn.sn_id, summary];
    const matching = cashPolicies.filter(policy => String(policy.pn_code) === String(sn.pn_code || '')
      && (!policy.supplier_id || String(policy.supplier_id) === String(sn.supplier_id || '')))
      .sort((a, b) => Number(Boolean(b.supplier_id)) - Number(Boolean(a.supplier_id))
        || String(b.effective_start || '').localeCompare(String(a.effective_start || '')));
    const policy = matching[0];
    if (policy) {
      const label = `销售红包${policy.rebate_type} ¥${money(policy.amount).toFixed(2)}`;
      summary.available_resource_summary = [summary.available_resource_summary === '无' ? '' : summary.available_resource_summary, label].filter(Boolean).join(' / ');
      summary.cash_rebate = { policyId: policy.policy_id, rebateType: policy.rebate_type, amount: money(policy.amount) };
    }
    return [sn.sn_id, summary];
  }));
}

async function listRights(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance', 'manager']);
  const { snCode, pnCode, productId, resourceType, status, page = 1, pageSize = 20 } = ctx.query;
  const where = {};
  if (snCode) where.sn_code = { [Op.like]: `%${snCode}%` };
  if (productId) where.product_id = productId;
  if (resourceType) where.resource_type = resourceType;
  if (status) where.current_status = status;
  const snInclude = { model: ProductSn, attributes: ['status', 'pn_code'] };
  if (pnCode) {
    snInclude.where = { pn_code: { [Op.like]: `%${pnCode}%` } };
    snInclude.required = true;
  }
  const { count, rows } = await InventoryResourceRight.findAndCountAll({
    where,
    include: [
      { model: Product, attributes: ['name', 'product_code'] },
      snInclude
    ],
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

const IMPORT_HEADER_ALIASES = {
  sn: ['sn', 'sn_code', 'sn码', '序列号'],
  pn: ['pn', 'pn_code', 'pn码', '厂商编码', '商品编码'],
  resourceType: ['resource_type', 'resourceType', '资源类型', '权益类型', '权益'],
  amount: ['amount', 'resource_amount', '资源金额', '权益金额', '金额'],
  status: ['status', '状态', '调整状态'],
  effectiveStart: ['effective_start', 'effectiveStart', '开始时间', '生效开始时间', '生效时间'],
  effectiveEnd: ['effective_end', 'effectiveEnd', '结束时间', '生效结束时间', '失效时间'],
  remark: ['remark', '备注', '说明']
};

function normalizeImportHeader(value) {
  return String(value ?? '').trim().replace(/[\s_\-()（）]/g, '').toLowerCase();
}

function normalizeImportRows(rows) {
  const aliases = new Map();
  for (const [field, names] of Object.entries(IMPORT_HEADER_ALIASES)) {
    for (const name of names) aliases.set(normalizeImportHeader(name), field);
  }
  return rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [aliases.get(normalizeImportHeader(key)) || key, value])));
}

function parseImportList(value) {
  return [...new Set(String(value ?? '').split(/[\s,，、;；]+/).map(item => item.trim()).filter(Boolean))];
}

function parseImportDate(value, fieldName, rowNumber) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  let date = value instanceof Date ? value : null;
  if (!date && typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) date = new Date(parsed.y, parsed.m - 1, parsed.d, parsed.H || 0, parsed.M || 0, Math.floor(parsed.S || 0));
  }
  if (!date) {
    const text = String(value).trim().replace(/年|月/g, '-').replace(/日/g, '').replace(/[./]/g, '-');
    date = new Date(/^\d{4}-\d{1,2}-\d{1,2}$/.test(text) ? `${text}T00:00:00` : text);
  }
  if (!date || Number.isNaN(date.getTime())) throw Object.assign(new Error(`第${rowNumber}行${fieldName}格式无效`), { status: 400 });
  return date;
}

function normalizeImportAmount(value, rowNumber) {
  if (value === undefined || value === null || String(value).trim() === '') return 0;
  const amount = Number(String(value).replace(/,/g, '').trim());
  if (!Number.isFinite(amount) || amount < 0) throw Object.assign(new Error(`第${rowNumber}行资源金额无效`), { status: 400 });
  return money(amount);
}

const IMPORT_STATUS_ALIASES = new Map([
  ['AVAILABLE', 'AVAILABLE'], ['可用', 'AVAILABLE'], ['有效', 'AVAILABLE'], ['正常', 'AVAILABLE'],
  ['NOT_APPLICABLE', 'NOT_APPLICABLE'], ['不适用', 'NOT_APPLICABLE'], ['无权益', 'NOT_APPLICABLE'],
  ['EXCEPTION', 'EXCEPTION'], ['异常', 'EXCEPTION']
].map(([label, value]) => [normalizeImportHeader(label), value]));

function normalizeImportStatus(value, rowNumber) {
  const input = String(value || '可用').trim();
  const status = IMPORT_STATUS_ALIASES.get(normalizeImportHeader(input));
  if (!status) throw Object.assign(new Error(`第${rowNumber}行状态“${input}”无效，请填写可用、不适用或异常`), { status: 400 });
  return status;
}

function buildImportResourceTypeAliases(categories) {
  const aliases = new Map();
  for (const category of categories) {
    const labels = [category.category_code, category.name, category.short_name, RESOURCE_LABELS[category.category_code]];
    for (const label of labels.filter(Boolean)) aliases.set(normalizeImportHeader(label), category.category_code);
  }
  return aliases;
}

function normalizeImportResourceTypes(value, categories, rowNumber) {
  const inputs = parseImportList(value);
  if (!inputs.length) throw Object.assign(new Error(`第${rowNumber}行资源类型不能为空`), { status: 400 });
  const aliases = buildImportResourceTypeAliases(categories);
  return [...new Set(inputs.map(input => {
    const resourceType = aliases.get(normalizeImportHeader(input));
    if (!resourceType) throw Object.assign(new Error(`第${rowNumber}行资源类型“${input}”无效或已停用，请填写系统中的中文资源名称`), { status: 400 });
    return resourceType;
  }))];
}

async function applyImportedRightRow({ row, rowNumber, user, categories }) {
  const snCodes = parseImportList(row.sn);
  const pnCodes = parseImportList(row.pn);
  if (!snCodes.length && !pnCodes.length) throw Object.assign(new Error(`第${rowNumber}行必须填写PN或SN`), { status: 400 });
  const resourceTypes = normalizeImportResourceTypes(row.resourceType, categories, rowNumber);
  const status = normalizeImportStatus(row.status, rowNumber);
  const amount = normalizeImportAmount(row.amount, rowNumber);
  const effectiveStart = parseImportDate(row.effectiveStart, '开始时间', rowNumber);
  const effectiveEnd = parseImportDate(row.effectiveEnd, '结束时间', rowNumber);
  if (effectiveStart && effectiveEnd && effectiveStart > effectiveEnd) throw Object.assign(new Error(`第${rowNumber}行开始时间不能晚于结束时间`), { status: 400 });
  const remark = String(row.remark || '').trim().slice(0, 512);
  return sequelize.transaction(async transaction => {
    const selector = snCodes.length ? { sn_code: { [Op.in]: snCodes } } : { pn_code: { [Op.in]: pnCodes } };
    const sns = await ProductSn.findAll({ where: { is_deleted: 0, status: 'in_stock', ...selector }, transaction, lock: transaction.LOCK.UPDATE });
    if (!sns.length) throw Object.assign(new Error(`第${rowNumber}行未找到在库SN`), { status: 404 });
    let affected = 0;
    let skipped = 0;
    for (const sn of sns) {
      for (const resourceType of resourceTypes) {
        let right = await InventoryResourceRight.findOne({ where: { sn_id: sn.sn_id, resource_type: resourceType }, transaction, lock: transaction.LOCK.UPDATE });
        const before = right?.current_status || 'NOT_APPLICABLE';
        if (['LOCKED', 'USED', 'CLAIMED_BACK'].includes(before)) { skipped += 1; continue; }
        const values = { current_status: status, amount, effective_start: effectiveStart, effective_end: effectiveEnd, source: 'EXCEL_IMPORT', remark, version: Number(right?.version || 0) + 1 };
        if (!right) {
          right = await InventoryResourceRight.create({ right_id: generateUUID(), sn_id: sn.sn_id, sn_code: sn.sn_code, product_id: sn.product_id, resource_type: resourceType, initial_status: status, ...values }, { transaction });
        } else {
          await right.update(values, { transaction });
        }
        await ResourceRightChangeOrder.create({
          change_id: generateUUID(), change_order_no: businessNo(), sn_id: sn.sn_id, sn_code: sn.sn_code, product_id: sn.product_id,
          resource_type: resourceType, before_status: before, after_status: status, change_amount: amount, change_reason: 'BATCH_ADJUST', approval_status: 'approved',
          applicant_staff_id: user.staffId, applicant_name: user.name, reviewer_staff_id: user.staffId, reviewer_name: user.name, review_time: new Date(), remark
        }, { transaction });
        affected += 1;
      }
    }
    return { affected, skipped, matched: sns.length };
  });
}

async function importBatchRights(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance', 'manager']);
  if (!ctx.file?.buffer) ctx.throw(400, '请上传Excel文件');
  const workbook = XLSX.read(ctx.file.buffer, { type: 'buffer', cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });
  if (!rawRows.length) ctx.throw(400, 'Excel没有可导入的数据');
  if (rawRows.length > 2000) ctx.throw(400, '单次最多导入2000行');
  const rows = normalizeImportRows(rawRows);
  const categories = await ResourceCategory.findAll({ where: { status: 1 } });
  const results = [];
  for (let index = 0; index < rows.length; index += 1) {
    const rowNumber = index + 2;
    try {
      const result = await applyImportedRightRow({ row: rows[index], rowNumber, user: ctx.state.user || {}, categories });
      results.push({ row: rowNumber, status: 'success', ...result });
    } catch (error) {
      results.push({ row: rowNumber, status: 'failed', message: error.message });
    }
  }
  const success = results.filter(item => item.status === 'success');
  ctx.body = { message: `导入完成：成功${success.length}行，失败${results.length - success.length}行`, affected: success.reduce((sum, item) => sum + item.affected, 0), skipped: success.reduce((sum, item) => sum + item.skipped, 0), results };
}

function normalizedEducationHeader(value) {
  return String(value ?? '').trim().replace(/[\s_\-()（）:：]/g, '').toLowerCase();
}

function educationHeaderIndexes(headers) {
  const values = headers.map(normalizedEducationHeader);
  const serviceStart = values.findIndex(value => value.includes('服务产品名称') || value.includes('服务产品编码'));
  const limit = serviceStart < 0 ? values.length : serviceStart;
  const beforeService = values.slice(0, limit);
  const productCode = beforeService.findIndex(value =>
    /商品编号|商品编码|物料编码|型号编码|pncode|^pn$|^mtm$/.test(value)
  );
  const start = beforeService.findIndex(value => value.includes('促销开始') || value.includes('开始时间') || value.includes('生效开始'));
  const end = beforeService.findIndex(value => value.includes('促销结束') || value.includes('结束时间') || value.includes('生效结束'));
  if (productCode < 0 || start < 0 || end < 0) return null;
  const studentDiscount = beforeService.findIndex((value, index) => index > productCode && (value.includes('学生优惠') || value.includes('教育优惠')));
  const resourceRecalculation = beforeService.findIndex((value, index) => index > productCode && (value.includes('资源回算') || value.includes('资源回算金额')));
  if (studentDiscount < 0 && resourceRecalculation < 0) return null;
  return { productCode, start, end, studentDiscount, resourceRecalculation };
}

function parseEducationDate(value, endOfDay = false) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  let parts = null;
  if (value instanceof Date) parts = [value.getFullYear(), value.getMonth() + 1, value.getDate()];
  else if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) parts = [parsed.y, parsed.m, parsed.d];
  } else {
    const text = String(value).trim();
    let match = text.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?$/);
    if (match) parts = match.slice(1).map(Number);
    if (!parts && (match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) parts = match.slice(1).map(Number);
    if (!parts && (match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/))) {
      const year = Number(match[3]) < 100 ? (Number(match[3]) >= 70 ? 1900 + Number(match[3]) : 2000 + Number(match[3])) : Number(match[3]);
      parts = [year, Number(match[1]), Number(match[2])];
    }
  }
  if (!parts) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) parts = [parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate()];
  }
  if (!parts) return null;
  const [year, month, day] = parts;
  const date = new Date(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+08:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseEducationAmount(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (/^(?:\/|—|--|不参与|无|n\/a)$/i.test(text)) return null;
  const amount = Number(text.replace(/[￥¥,，\s]/g, ''));
  return Number.isFinite(amount) && amount >= 0 ? money(amount) : null;
}

function extractEducationPolicies(workbook) {
  const policies = [];
  const errors = [];
  for (const sheetName of workbook.SheetNames || []) {
    const sheet = workbook.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
    const headerAt = matrix.findIndex(row => educationHeaderIndexes(row));
    if (headerAt < 0) continue;
    const columns = educationHeaderIndexes(matrix[headerAt]);
    let carriedStart = '';
    let carriedEnd = '';
    for (let index = headerAt + 1; index < matrix.length; index += 1) {
      const row = matrix[index] || [];
      if (String(row[columns.start] || '').trim()) carriedStart = row[columns.start];
      if (String(row[columns.end] || '').trim()) carriedEnd = row[columns.end];
      const productCode = String(row[columns.productCode] || '').trim().toUpperCase();
      if (!productCode) continue;
      const start = parseEducationDate(carriedStart);
      const end = parseEducationDate(carriedEnd, true);
      if (!start || !end || start > end) {
        errors.push({ sheet: sheetName, row: index + 1, productCode, message: '促销开始/结束时间无效' });
        continue;
      }
      const studentDiscount = columns.studentDiscount >= 0 ? parseEducationAmount(row[columns.studentDiscount]) : null;
      const recalculation = columns.resourceRecalculation >= 0 ? parseEducationAmount(row[columns.resourceRecalculation]) : null;
      const fallback = studentDiscount ?? recalculation;
      if (fallback === null) continue;
      policies.push({
        productCode,
        productName: String(row[columns.productCode + 1] || '').trim(),
        promotionStart: start,
        promotionEnd: end,
        studentDiscount: studentDiscount ?? fallback,
        resourceRecalculationAmount: recalculation ?? fallback,
        sourceSheet: sheetName,
        sourceRow: index + 1
      });
    }
  }
  return { policies, errors };
}

function chooseEducationPolicy(policies, at = new Date()) {
  const timestamp = new Date(at).getTime();
  const active = policies.filter(policy => new Date(policy.promotionStart).getTime() <= timestamp && new Date(policy.promotionEnd).getTime() >= timestamp);
  if (active.length) return active.sort((a, b) => new Date(b.promotionStart) - new Date(a.promotionStart))[0];
  const future = policies.filter(policy => new Date(policy.promotionStart).getTime() > timestamp);
  if (future.length) return future.sort((a, b) => new Date(a.promotionStart) - new Date(b.promotionStart))[0];
  return [...policies].sort((a, b) => new Date(b.promotionStart) - new Date(a.promotionStart))[0] || null;
}

async function clearExpiredEducationRights({ productId, now, user = {}, transaction }) {
  const rights = await InventoryResourceRight.findAll({
    where: {
      product_id: productId,
      resource_type: 'EDU_SUBSIDY',
      current_status: { [Op.in]: ['AVAILABLE', 'NOT_APPLICABLE'] },
      amount: { [Op.gt]: 0 },
      source: 'EDUCATION_POLICY_IMPORT',
      effective_end: { [Op.lt]: now }
    },
    transaction,
    lock: transaction.LOCK.UPDATE
  });
  for (const right of rights) {
    const amount = money(right.amount);
    await right.update({
      current_status: 'NOT_APPLICABLE',
      amount: 0,
      rule_config_id: null,
      effective_start: null,
      effective_end: null,
      source: 'EDUCATION_POLICY_EXPIRED',
      remark: '教育优惠政策已过期，导入时自动清理可用权益',
      version: Number(right.version || 0) + 1,
      update_time: now
    }, { transaction });
    await ResourceRightChangeOrder.create({
      change_id: generateUUID(),
      change_order_no: businessNo(),
      sn_id: right.sn_id,
      sn_code: right.sn_code,
      product_id: right.product_id,
      resource_type: 'EDU_SUBSIDY',
      before_status: right.current_status,
      after_status: 'NOT_APPLICABLE',
      change_amount: amount,
      change_reason: 'EDU_POLICY_EXPIRED',
      approval_status: 'approved',
      applicant_staff_id: user.staffId || null,
      applicant_name: user.name || '',
      reviewer_staff_id: user.staffId || null,
      reviewer_name: user.name || '',
      review_time: now,
      remark: '教育优惠政策到期，自动清理未使用权益'
    }, { transaction });
  }
  return rights.length;
}

async function cleanupExpiredEducationPolicies({ now, user = {} }) {
  let clearedRights = 0;
  await sequelize.transaction(async transaction => {
    const configs = await ProductResourceCostConfig.findAll({
      where: { resource_type: 'EDU_SUBSIDY', status: 1 },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    for (const config of configs) {
      const configJson = parseJsonObject(config.rule_config_json);
      const importedEducationPolicy = Array.isArray(configJson.educationPolicies)
        || String(config.remark || '').startsWith('教育优惠表格导入');
      if (!importedEducationPolicy) continue;
      const policies = Array.isArray(configJson.educationPolicies) ? configJson.educationPolicies : [];
      const hasCurrentPolicy = policies.some(policy =>
        new Date(policy.promotionStart).getTime() <= now.getTime()
        && new Date(policy.promotionEnd).getTime() >= now.getTime()
      ) || (!policies.length
        && config.effective_start && config.effective_end
        && new Date(config.effective_start).getTime() <= now.getTime()
        && new Date(config.effective_end).getTime() >= now.getTime());
      if (!hasCurrentPolicy) {
        await config.update({
          status: 0,
          cost_amount: 0,
          calculation_value: 0,
          update_user: user.name || '',
          update_time: now,
          remark: '教育优惠政策已过期，导入时自动停用'
        }, { transaction });
      }
    }

    const expiredProductRows = await InventoryResourceRight.findAll({
      attributes: ['product_id'],
      where: {
        resource_type: 'EDU_SUBSIDY',
        current_status: { [Op.in]: ['AVAILABLE', 'NOT_APPLICABLE'] },
        amount: { [Op.gt]: 0 },
        source: 'EDUCATION_POLICY_IMPORT',
        effective_end: { [Op.lt]: now }
      },
      group: ['product_id'],
      raw: true,
      transaction
    });
    for (const row of expiredProductRows) {
      clearedRights += await clearExpiredEducationRights({ productId: row.product_id, now, user, transaction });
    }
  });
  return clearedRights;
}

async function importEducationPolicies(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance', 'manager']);
  if (!ctx.file?.buffer) ctx.throw(400, '请上传教育优惠Excel文件');
  const workbook = XLSX.read(ctx.file.buffer, { type: 'buffer', cellDates: true });
  const extracted = extractEducationPolicies(workbook);
  if (!extracted.policies.length) ctx.throw(400, '没有识别到包含促销时间、商品编号和学生优惠/资源回算金额的明细表');
  const now = new Date();
  const grouped = new Map();
  for (const policy of extracted.policies) {
    const rows = grouped.get(policy.productCode) || [];
    const key = `${policy.promotionStart.toISOString().slice(0, 10)}|${policy.promotionEnd.toISOString().slice(0, 10)}`;
    const existingIndex = rows.findIndex(item => `${item.promotionStart.toISOString().slice(0, 10)}|${item.promotionEnd.toISOString().slice(0, 10)}` === key);
    if (existingIndex >= 0) rows[existingIndex] = policy;
    else rows.push(policy);
    grouped.set(policy.productCode, rows);
  }
  const category = await ResourceCategory.findOne({ where: { category_code: 'EDU_SUBSIDY', status: 1 } });
  if (!category) ctx.throw(409, '教育补贴资源类别未启用，请先在资源类别中启用教育补贴');
  const clearedExpiredRights = await cleanupExpiredEducationPolicies({ now, user: ctx.state.user || {} });
  const results = [];
  for (const [productCode, rows] of grouped.entries()) {
    try {
      let product = await Product.findOne({ where: { product_code: productCode, is_deleted: 0 } });
      if (!product) {
        const pn = await ProductPn.findOne({ where: { pn_code: productCode, is_deleted: 0, status: 1 } });
        if (pn) product = await Product.findByPk(pn.product_id);
      }
      if (!product || product.is_deleted) throw new Error('系统中未找到该商品编号');
      const currentRows = rows.filter(policy =>
        new Date(policy.promotionStart).getTime() <= now.getTime()
        && new Date(policy.promotionEnd).getTime() >= now.getTime()
      );
      if (!currentRows.length) {
        let clearedRights = 0;
        await sequelize.transaction(async transaction => {
          const configs = await ProductResourceCostConfig.findAll({
            where: { product_id: product.product_id, resource_type: 'EDU_SUBSIDY' },
            transaction,
            lock: transaction.LOCK.UPDATE
          });
          for (const config of configs) {
            const configJson = parseJsonObject(config.rule_config_json);
            const importedEducationPolicy = Array.isArray(configJson.educationPolicies)
              || String(config.remark || '').startsWith('教育优惠表格导入');
            if (importedEducationPolicy && Number(config.status) !== 0) {
              await config.update({
                status: 0,
                cost_amount: 0,
                calculation_value: 0,
                update_user: ctx.state.user.name || '',
                update_time: now,
                remark: '教育优惠政策已过期，导入时自动停用'
              }, { transaction });
            }
          }
          clearedRights = await clearExpiredEducationRights({ productId: product.product_id, now, user: ctx.state.user || {}, transaction });
        });
        results.push({
          productCode,
          status: 'skipped',
          policyCount: 0,
          affectedInventory: 0,
          clearedExpiredRights: clearedRights,
          message: `没有当前有效政策，已跳过导入并清理${clearedRights}条过期可用权益`
        });
        continue;
      }
      const policies = currentRows.map(policy => ({
        promotionStart: policy.promotionStart.toISOString(),
        promotionEnd: policy.promotionEnd.toISOString(),
        studentDiscount: policy.studentDiscount,
        resourceRecalculationAmount: policy.resourceRecalculationAmount,
        sourceSheet: policy.sourceSheet,
        sourceRow: policy.sourceRow
      })).sort((a, b) => new Date(a.promotionStart) - new Date(b.promotionStart));
      const selected = chooseEducationPolicy(currentRows, now);
      let affectedSnCount = 0;
      let clearedRights = 0;
      await sequelize.transaction(async transaction => {
        const configs = await ProductResourceCostConfig.findAll({
          where: { product_id: product.product_id, resource_type: 'EDU_SUBSIDY' },
          transaction,
          lock: transaction.LOCK.UPDATE
        });
        const values = {
          cost_amount: selected.resourceRecalculationAmount,
          calculation_type: 'fixed_amount',
          calculation_value: selected.resourceRecalculationAmount,
          effective_start: selected.promotionStart,
          effective_end: selected.promotionEnd,
          trigger_condition: 'sale_archived',
          affects_performance_profit: 1,
          performance_profit_ratio: 80,
          rule_config_json: JSON.stringify({ educationPolicies: policies }),
          status: 1,
          remark: `教育优惠表格导入，主表优惠 ¥${selected.studentDiscount.toFixed(2)}，资源回算 ¥${selected.resourceRecalculationAmount.toFixed(2)}`,
          update_user: ctx.state.user.name || '',
          update_time: new Date()
        };
        let policyConfigId = configs[0]?.config_id || '';
        if (configs.length) {
          for (const config of configs) await config.update(values, { transaction });
        } else {
          const createdConfig = await ProductResourceCostConfig.create({
            config_id: generateUUID(), product_id: product.product_id, resource_type: 'EDU_SUBSIDY',
            supplier_id: '', supplier_name: '', ...values, create_user: ctx.state.user.name || ''
          }, { transaction });
          policyConfigId = createdConfig.config_id;
        }

        clearedRights = await clearExpiredEducationRights({ productId: product.product_id, now, user: ctx.state.user || {}, transaction });

        const sns = await ProductSn.findAll({ where: { product_id: product.product_id, is_deleted: 0, status: { [Op.in]: ['in_stock', 'sold'] } }, transaction, lock: transaction.LOCK.UPDATE });
        for (const sn of sns) {
          let right = await InventoryResourceRight.findOne({ where: { sn_id: sn.sn_id, resource_type: 'EDU_SUBSIDY' }, transaction, lock: transaction.LOCK.UPDATE });
          if (right && !['AVAILABLE', 'NOT_APPLICABLE', 'EXCEPTION'].includes(right.current_status)) continue;
          const rightValues = {
            rule_config_id: policyConfigId || null,
            current_status: 'AVAILABLE', amount: selected.resourceRecalculationAmount,
            effective_start: selected.promotionStart, effective_end: selected.promotionEnd,
            source: 'EDUCATION_POLICY_IMPORT', supplier_id: sn.supplier_id || right?.supplier_id || null,
            supplier_name: sn.supplier_name || right?.supplier_name || '',
            remark: `教育优惠表格导入：${selected.sourceSheet} 第${selected.sourceRow}行`,
            version: Number(right?.version || 0) + 1, update_time: new Date()
          };
          if (right && right.current_status === 'EXCEPTION') continue;
          const unchanged = right
            && right.current_status === 'AVAILABLE'
            && money(right.amount) === selected.resourceRecalculationAmount
            && String(right.effective_start || '') === String(selected.promotionStart || '')
            && String(right.effective_end || '') === String(selected.promotionEnd || '')
            && right.source === 'EDUCATION_POLICY_IMPORT';
          if (unchanged) continue;
          const beforeStatus = right?.current_status || 'NOT_APPLICABLE';
          if (right) await right.update(rightValues, { transaction });
          else {
            right = await InventoryResourceRight.create({
              right_id: generateUUID(), sn_id: sn.sn_id, sn_code: sn.sn_code,
              product_id: product.product_id, resource_type: 'EDU_SUBSIDY', initial_status: 'AVAILABLE',
              ...rightValues
            }, { transaction });
          }
          await ResourceRightChangeOrder.create({
            change_id: generateUUID(), change_order_no: businessNo(), sn_id: sn.sn_id, sn_code: sn.sn_code,
            product_id: product.product_id, resource_type: 'EDU_SUBSIDY',
            before_status: beforeStatus,
            after_status: 'AVAILABLE', change_amount: selected.resourceRecalculationAmount,
            change_reason: 'BATCH_ADJUST', approval_status: 'approved',
            applicant_staff_id: ctx.state.user.staffId || null, applicant_name: ctx.state.user.name || '',
            reviewer_staff_id: ctx.state.user.staffId || null, reviewer_name: ctx.state.user.name || '', review_time: new Date(),
            remark: `教育优惠政策导入：${selected.sourceSheet} 第${selected.sourceRow}行`
          }, { transaction });
          affectedSnCount += 1;
        }
      });
      results.push({ productCode, status: 'success', policyCount: policies.length, affectedInventory: affectedSnCount, clearedExpiredRights: clearedRights });
    } catch (error) {
      results.push({ productCode, status: 'failed', message: error.message });
    }
  }
  const success = results.filter(item => item.status === 'success').length;
  const skipped = results.filter(item => item.status === 'skipped').length;
  ctx.body = {
    message: `教育优惠导入完成：成功${success}个商品，过期/未生效跳过${skipped}个商品，失败${results.length - success - skipped}个商品`,
    affectedProducts: success,
    clearedExpiredRights,
    results: results.concat(extracted.errors.map(error => ({ ...error, status: 'failed' })))
  };
}

function policyForSaleDate(rule, saleDate) {
  const date = new Date(saleDate || new Date()).getTime();
  const config = parseJsonObject(rule?.rule_config_json);
  const policies = Array.isArray(config.educationPolicies) ? config.educationPolicies : [];
  return policies.find(policy => {
    const start = new Date(policy.promotionStart).getTime();
    const end = new Date(policy.promotionEnd).getTime();
    return Number.isFinite(start) && Number.isFinite(end) && start <= date && date <= end;
  }) || null;
}

async function supplementEducationResource(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance', 'manager']);
  const orderNo = String(ctx.request.body?.orderNo || '').trim();
  const snId = String(ctx.request.body?.snId || '').trim();
  const attachmentUrl = String(ctx.request.body?.attachmentUrl || '').trim();
  if (!orderNo || !snId || !attachmentUrl) ctx.throw(400, '请填写销售单号并上传凭证图片');
  const result = await sequelize.transaction(async transaction => {
    const sn = await ProductSn.findByPk(snId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!sn || sn.is_deleted) ctx.throw(404, 'SN不存在');
    const order = await Order.findOne({ where: { order_no: orderNo, is_deleted: 0 }, transaction, lock: transaction.LOCK.UPDATE });
    if (!order || !['已归档', 'completed', 'archived'].includes(String(order.order_status || ''))) ctx.throw(409, '仅支持已归档的销售单');
    const item = await OrderItem.findOne({ where: { order_id: order.order_id, sn_id: sn.sn_id }, transaction, lock: transaction.LOCK.UPDATE });
    if (!item || String(item.product_id) !== String(sn.product_id)) ctx.throw(409, '销售单中没有对应的SN商品');
    if (selectedResources(item).includes('EDU_SUBSIDY')) ctx.throw(409, '该销售商品归档时已使用教育补贴，无需补录');

    const right = await InventoryResourceRight.findOne({ where: { sn_id: sn.sn_id, resource_type: 'EDU_SUBSIDY' }, transaction, lock: transaction.LOCK.UPDATE });
    if (!right || right.current_status !== 'AVAILABLE') ctx.throw(409, '该商品教育补贴权益已使用或不可补录');
    const existing = await ResourceRightChangeOrder.findOne({
      where: { sn_id: sn.sn_id, related_sale_order_id: order.order_id, resource_type: 'EDU_SUBSIDY', change_reason: { [Op.in]: ['SALE_USED', 'SALE_TRIGGER', 'EDU_SUBSIDY_SUPPLEMENT'] } },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (existing) ctx.throw(409, '该销售商品已有教育补贴资源记录，不能重复补录');

    const configs = await ProductResourceCostConfig.findAll({
      where: { product_id: sn.product_id, resource_type: 'EDU_SUBSIDY', status: 1 }, transaction
    });
    const orderedConfigs = configs.sort((a, b) => (String(a.supplier_id || '') === String(sn.supplier_id || '') ? -1 : 0) - (String(b.supplier_id || '') === String(sn.supplier_id || '') ? -1 : 0));
    let selected = null;
    let rule = null;
    for (const config of orderedConfigs) {
      selected = policyForSaleDate(config, order.create_time);
      if (selected) { rule = config; break; }
    }
    if (!rule) {
      rule = await findResourceRule({ productId: sn.product_id, resourceType: 'EDU_SUBSIDY', supplierId: sn.supplier_id || '', saleDate: order.create_time, transaction });
      selected = rule ? { studentDiscount: Number(rule.cost_amount || 0), resourceRecalculationAmount: Number(rule.cost_amount || 0) } : null;
    }
    if (!selected) ctx.throw(409, '没有找到该销售日期适用的教育优惠政策，请先导入教育优惠表');
    const studentDiscount = money(selected.studentDiscount);
    const fullAmount = money(selected.resourceRecalculationAmount ?? studentDiscount);
    if (studentDiscount <= 0 || fullAmount <= 0) ctx.throw(409, '该政策教育优惠或资源回算金额为0，无法补录');
    const supplierId = right.supplier_id || sn.supplier_id;
    const supplierName = right.supplier_name || sn.supplier_name || '';
    if (!supplierId) ctx.throw(409, '该SN缺少供应商归属，无法生成供应商返利待下账');

    const change = await ResourceRightChangeOrder.create({
      change_id: generateUUID(), change_order_no: businessNo('EDU'), sn_id: sn.sn_id, sn_code: sn.sn_code,
      product_id: sn.product_id, resource_type: 'EDU_SUBSIDY', before_status: 'AVAILABLE', after_status: 'USED',
      change_amount: fullAmount, change_reason: 'EDU_SUBSIDY_SUPPLEMENT', approval_status: 'approved',
      related_sale_order_id: order.order_id, attachment_url: attachmentUrl,
      applicant_staff_id: ctx.state.user.staffId || null, applicant_name: ctx.state.user.name || '',
      reviewer_staff_id: ctx.state.user.staffId || null, reviewer_name: ctx.state.user.name || '', review_time: new Date(),
      remark: `销售单 ${order.order_no} 归档后教育优惠资源补录；政策优惠 ¥${studentDiscount.toFixed(2)}，供应商回算 ¥${fullAmount.toFixed(2)}`
    }, { transaction });
    await right.update({ current_status: 'USED', amount: fullAmount, locked_source_type: null, locked_source_id: null, version: Number(right.version || 0) + 1, update_time: new Date() }, { transaction });
    await createPendingSettlement({
      sourceType: 'SALE_USE', sourceId: change.change_id,
      sn: { sn_id: sn.sn_id, sn_code: sn.sn_code, product_id: sn.product_id },
      resourceType: 'EDU_SUBSIDY', amount: fullAmount,
      counterpartyId: supplierId, counterpartyName: supplierName, forceSettlement: true,
      remark: `销售单 ${order.order_no} 教育优惠资源补录`, transaction
    });
    await createPerformanceProfitAdjustment({ order, item, resourceType: 'EDU_SUBSIDY', amount: studentDiscount, ratio: 80, transaction });
    return { changeOrderNo: change.change_order_no, supplierRebateAmount: fullAmount, performanceProfitAmount: money(studentDiscount * 0.8) };
  });
  ctx.body = { code: 0, data: result, message: `教育优惠资源补录完成；供应商待下账 ¥${result.supplierRebateAmount.toFixed(2)}，员工业绩毛利增加 ¥${result.performanceProfitAmount.toFixed(2)}` };
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

/**
 * 冲销已归档销售单核销的国补资格。
 *
 * 该操作只处理“原销售单已退单、SN已回库”的纠错场景，不改写原销售单、
 * 原收款或原核销流水，而是追加一条 USED -> AVAILABLE 的不可删除变更记录。
 */
async function reverseSaleUseResource(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance'], '仅财务、admin 或 BOSS 可以冲销国补资格');
  const { snId, resourceType = 'GOV_SUBSIDY', reason = '' } = ctx.request.body || {};
  const normalizedReason = String(reason || '').trim();
  if (!snId) ctx.throw(400, 'SN不能为空');
  if (resourceType !== 'GOV_SUBSIDY') ctx.throw(400, '该流程仅支持国补资格冲销');
  if (!normalizedReason) ctx.throw(400, '请输入冲销原因');
  if (normalizedReason.length > 512) ctx.throw(400, '冲销原因不能超过512个字符');

  const result = await sequelize.transaction(async transaction => {
    const sn = await ProductSn.findByPk(snId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!sn || sn.is_deleted) ctx.throw(404, 'SN不存在');
    if (sn.status !== 'in_stock') ctx.throw(409, '只有已回库的SN才可以冲销国补资格');

    const right = await InventoryResourceRight.findOne({
      where: { sn_id: sn.sn_id, resource_type: resourceType },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!right) ctx.throw(404, '该SN没有国补资格记录');
    if (right.current_status !== 'USED') ctx.throw(409, `当前国补资格状态为${STATUS_LABELS[right.current_status] || right.current_status}，不能执行核销冲销`);

    const sourceChange = await ResourceRightChangeOrder.findOne({
      where: {
        sn_id: sn.sn_id,
        resource_type: resourceType,
        after_status: 'USED',
        change_reason: 'SALE_USED',
        approval_status: 'approved'
      },
      order: [['create_time', 'DESC'], ['change_id', 'DESC']],
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!sourceChange?.related_sale_order_id) ctx.throw(409, '未找到原销售核销流水，无法冲销');

    const sourceOrder = await Order.findByPk(sourceChange.related_sale_order_id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!sourceOrder || !['returned', '已退单'].includes(String(sourceOrder.order_status || ''))) {
      ctx.throw(409, '原销售单尚未完成退单，不能冲销国补资格');
    }

    const existingReversal = await ResourceRightChangeOrder.findOne({
      where: {
        sn_id: sn.sn_id,
        resource_type: resourceType,
        change_reason: 'SALE_USE_REVERSAL',
        related_sale_order_id: sourceChange.related_sale_order_id,
        approval_status: 'approved'
      },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (existingReversal) ctx.throw(409, `原销售核销已冲销（${existingReversal.change_order_no}）`);

    const settlements = await ResourceSettlement.findAll({
      where: { source_type: 'SALE_USE', source_id: sourceChange.change_id, resource_type: resourceType },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    const activeSettlements = settlements.filter(record => !['CANCELLED', 'REVERSED'].includes(String(record.status || '').toUpperCase()));
    const settledSettlement = activeSettlements.find(record => String(record.status || '').toUpperCase() !== 'PENDING');
    if (settledSettlement) {
      ctx.throw(409, `原销售权益已有${settledSettlement.status === 'PARTIALLY_SETTLED' ? '部分' : ''}下账记录，请先冲销该下账记录`);
    }
    for (const settlement of activeSettlements) {
      await settlement.update({
        status: 'CANCELLED',
        cancelled_at: new Date(),
        cancelled_by: ctx.state.user.staffId || null,
        cancelled_by_name: ctx.state.user.name || ctx.state.user.staffId || '',
        correction_reason: `国补资格核销冲销：${normalizedReason}`,
        update_time: new Date()
      }, { transaction });
    }

    const now = new Date();
    await right.update({
      current_status: 'AVAILABLE',
      locked_source_type: null,
      locked_source_id: null,
      version: Number(right.version || 0) + 1,
      update_time: now
    }, { transaction });
    const change = await ResourceRightChangeOrder.create({
      change_id: generateUUID(),
      change_order_no: businessNo(),
      sn_id: sn.sn_id,
      sn_code: sn.sn_code,
      product_id: sn.product_id,
      resource_type: resourceType,
      before_status: 'USED',
      after_status: 'AVAILABLE',
      change_amount: Number(right.amount || 0),
      change_reason: 'SALE_USE_REVERSAL',
      approval_status: 'approved',
      related_sale_order_id: sourceChange.related_sale_order_id,
      applicant_staff_id: ctx.state.user.staffId || null,
      applicant_name: ctx.state.user.name || ctx.state.user.staffId || '',
      reviewer_staff_id: ctx.state.user.staffId || null,
      reviewer_name: ctx.state.user.name || ctx.state.user.staffId || '',
      review_time: now,
      remark: `冲销原核销单 ${sourceChange.change_order_no}；原销售单 ${sourceOrder.order_no} 已退单；${normalizedReason}`
    }, { transaction });

    return {
      changeId: change.change_id,
      changeOrderNo: change.change_order_no,
      snId: sn.sn_id,
      snCode: sn.sn_code,
      sourceChangeOrderNo: sourceChange.change_order_no,
      cancelledSettlementCount: activeSettlements.length
    };
  });

  ctx.body = {
    code: 0,
    data: result,
    message: `国补资格冲销成功，SN ${result.snCode} 已恢复为可用`
  };
}

async function submitClaim(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance', 'manager']);
  const { snId, resourceType, amount, attachmentUrl, remark } = ctx.request.body || {};
  const category = await ResourceCategory.findOne({ where: { category_code: resourceType, status: 1 } });
  if (!category) ctx.throw(400, '\u8d44\u6e90\u7c7b\u578b\u4e0d\u5b58\u5728\u6216\u5df2\u505c\u7528\uff0c\u8bf7\u5237\u65b0\u9875\u9762\u540e\u91cd\u8bd5');
  if (Number(category.supports_company_claim) !== 1) ctx.throw(400, `\u8d44\u6e90\u7c7b\u578b\u201c${category.name}\u201d\u672a\u5f00\u542f\u516c\u53f8\u5957\u56de\uff0c\u8bf7\u5728\u5e93\u5b58\u8d44\u6e90\u6743\u76ca\u7684\u6743\u76ca\u7c7b\u578b\u7ba1\u7406\u4e2d\u542f\u7528\u540e\u91cd\u8bd5`);
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

  const { action, comment } = ctx.request.body || {};
  if (!['approve', 'reject'].includes(action)) ctx.throw(400, '审批操作无效');
  await sequelize.transaction(async transaction => {
    const change = await ResourceRightChangeOrder.findByPk(ctx.params.changeId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!change) ctx.throw(404, '套回申请不存在');
    const accessibleStoreIds = Array.isArray(ctx.state.user?.accessibleStoreIds)
      ? ctx.state.user.accessibleStoreIds.map(String)
      : [];
    if (!accessibleStoreIds.includes('*')) {
      const sn = await ProductSn.findByPk(change.sn_id, { attributes: ['store_id'], transaction });
      if (!sn || !accessibleStoreIds.includes(String(sn.store_id || ''))) {
        ctx.throw(403, '无权审批该门店资源套回申请');
      }
    }
    if (change.approval_status !== 'pending_finance') ctx.throw(409, '该申请已处理');
    if (!await require('../approval/businessRuntime').advance(ctx, 'resource_claim', change, transaction, action, comment || '')) return;
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
    const supplierId = right.supplier_id || sn.supplier_id || null;
    const supplier = supplierId
      ? await Supplier.findByPk(supplierId, { attributes: ['supplier_id', 'name'], transaction })
      : null;
    await createPendingSettlement({
      sourceType: 'COMPANY_CLAIM', sourceId: change.change_id, sn,
      resourceType: change.resource_type, amount,
      counterpartyId: supplierId,
      counterpartyName: right.supplier_name || sn.supplier_name || supplier?.name || '',
      remark: `资源套回 ${change.change_order_no}`,
      transaction
    });
    await createClaimPriceProtection({ change, sn, transaction });
  });
  if (ctx.state.businessApproval?.status === 'pending') return;
  ctx.body = { message: action === 'approve' ? '资源套回已审批并计入产品资源成本' : '资源套回申请已拒绝并释放权益' };
}

async function listChanges(ctx) {
  if (await require('../approval/businessRuntime').reviewList(ctx, 'resource_claim')) return;
  requireAnyRole(ctx, ['boss', 'admin', 'finance', 'manager']);
  const { snCode, resourceType, approvalStatus, reason, startDate, endDate, scope, page = 1, pageSize = 20 } = ctx.query;
  const where = {};
  const user = ctx.state.user || {};
  const userRoles = roles(user);
  if (scope === 'review' && !userRoles.includes('finance') && !userRoles.includes('boss')) {
    where.change_id = '__NO_RESOURCE_APPROVAL_ACCESS__';
  }
  if (snCode) where.sn_code = { [Op.like]: `%${snCode}%` };
  if (resourceType) where.resource_type = resourceType;
  if (approvalStatus) where.approval_status = approvalStatus;
  if (reason) where.change_reason = reason;
  if (startDate || endDate) {
    where.create_time = {};
    if (startDate) where.create_time[Op.gte] = new Date(`${startDate}T00:00:00+08:00`);
    if (endDate) where.create_time[Op.lte] = new Date(`${endDate}T23:59:59+08:00`);
  }
  const accessibleStoreIds = Array.isArray(user.accessibleStoreIds)
    ? user.accessibleStoreIds.map(String).filter(Boolean)
    : [];
  const snScopeInclude = accessibleStoreIds.includes('*')
    ? { model: ProductSn, attributes: [], required: false }
    : {
      model: ProductSn,
      attributes: [],
      required: true,
      where: {
        is_deleted: 0,
        store_id: accessibleStoreIds.length ? { [Op.in]: accessibleStoreIds } : '__NO_STORE__'
      }
    };
  const { count, rows } = await ResourceRightChangeOrder.findAndCountAll({
    where,
    include: [snScopeInclude],
    order: buildPendingFirstOrder(sequelize, {
      statusColumn: 'ResourceRightChangeOrder.approval_status',
      pendingStatuses: ['pending'],
      dateColumns: ['ResourceRightChangeOrder.create_time'],
      idColumn: 'ResourceRightChangeOrder.change_id'
    }),
    ...paginate({}, { page, pageSize })
  });
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
  const resourceKind = String(body.resourceKind || body.resource_kind || 'SALE_USE').trim();
  if (!['SALE_USE', 'INTERNAL_MARKER', 'PO_REWARD', 'CARE_CREDIT', 'REBATE', 'OTHER'].includes(resourceKind)) ctx.throw(400, '权益类型无效');
  const values = {
    name,
    short_name: String(body.shortName || name).trim(),
    resource_kind: resourceKind,
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

async function deleteResourceCategory(ctx) {
  requireAnyRole(ctx, ['boss', 'admin']);
  const category = await ResourceCategory.findByPk(ctx.params.categoryId);
  if (!category) ctx.throw(404, '资源类别不存在');
  if (!String(category.category_code || '').startsWith('RES_')) ctx.throw(409, '系统内置权益类型被业务流程引用，不能删除；可停用或修改到账账户');
  await sequelize.transaction(async transaction => {
    await category.update({ status: 0, update_time: new Date() }, { transaction });
    await GoodsTypeResource.destroy({ where: { category_id: category.category_id }, transaction });
  });
  ctx.body = { message: '资源类别已删除，历史业务记录继续保留' };
}

async function listGoodsTypes(ctx) {
  const activeOnly = String(ctx.query.activeOnly || '') === '1';
  const rows = await GoodsType.findAll({
    where: activeOnly ? { status: 1 } : {},
    include: [{
      model: ResourceCategory,
      as: 'ResourceCategories',
      required: false,
      where: activeOnly ? { status: 1 } : undefined,
      through: { attributes: ['sort_order'] }
    }],
    order: [['sort_order', 'ASC'], ['name', 'ASC']]
  });
  ctx.body = rows.map(row => {
    const result = row.toJSON();
    result.ResourceCategories = (result.ResourceCategories || []).sort((a, b) =>
      Number(a.GoodsTypeResource?.sort_order || 0) - Number(b.GoodsTypeResource?.sort_order || 0)
    );
    result.resource_category_ids = result.ResourceCategories.map(item => item.category_id);
    return result;
  });
}

async function saveGoodsType(ctx) {
  requireAnyRole(ctx, ['boss', 'admin']);
  const body = ctx.request.body || {};
  const name = String(body.name || '').trim();
  if (!name) ctx.throw(400, '请输入货型名称');
  const categoryIds = [...new Set(
    (Array.isArray(body.resourceCategoryIds) ? body.resourceCategoryIds : [])
      .map(value => String(value || '').trim())
      .filter(Boolean)
  )];
  if (categoryIds.length) {
    const count = await ResourceCategory.count({ where: { category_id: { [Op.in]: categoryIds } } });
    if (count !== categoryIds.length) ctx.throw(400, '货型包含了不存在的资源子内容');
  }
  const duplicateWhere = { name };
  if (body.goodsTypeId) duplicateWhere.goods_type_id = { [Op.ne]: body.goodsTypeId };
  if (await GoodsType.count({ where: duplicateWhere })) ctx.throw(409, '货型名称已存在');

  let record;
  await sequelize.transaction(async transaction => {
    const values = {
      name,
      sort_order: Number(body.sortOrder || 0),
      status: body.status === 0 ? 0 : 1,
      remark: String(body.remark || '').trim(),
      update_time: new Date()
    };
    if (body.goodsTypeId) {
      record = await GoodsType.findByPk(body.goodsTypeId, { transaction });
      if (!record) ctx.throw(404, '货型不存在');
      await record.update(values, { transaction });
    } else {
      record = await GoodsType.create({
        goods_type_id: generateUUID(),
        ...values
      }, { transaction });
    }
    await GoodsTypeResource.destroy({ where: { goods_type_id: record.goods_type_id }, transaction });
    if (categoryIds.length) {
      await GoodsTypeResource.bulkCreate(categoryIds.map((categoryId, index) => ({
        goods_type_id: record.goods_type_id,
        category_id: categoryId,
        sort_order: index
      })), { transaction });
    }
  });
  ctx.body = { message: '货型已保存', goodsTypeId: record.goods_type_id };
}

async function deleteGoodsType(ctx) {
  requireAnyRole(ctx, ['boss', 'admin']);
  const record = await GoodsType.findByPk(ctx.params.goodsTypeId);
  if (!record) ctx.throw(404, '货型不存在');
  await record.update({ status: 0, update_time: new Date() });
  ctx.body = { message: '货型已删除，历史采购记录继续保留' };
}

async function createPendingSettlement({ sourceType, sourceId, sn, resourceType, amount, counterpartyId = null, counterpartyName = '', distributorId = null, remark = '', forceSettlement = false, transaction }) {
  const numericAmount = Number(amount || 0);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) return null;
  const category = await ResourceCategory.findOne({ where: { category_code: resourceType }, transaction });
  if (!category) throw Object.assign(new Error('资源类别配置不存在，无法生成待下账记录'), { status: 409 });
  if (!forceSettlement && Number(category.generates_settlement) === 0) return null;
  const [record] = await ResourceSettlement.findOrCreate({
    where: { source_type: sourceType, source_id: sourceId, resource_type: resourceType },
    defaults: {
      settlement_id: generateUUID(), settlement_no: businessNo('RST'), source_type: sourceType,
      source_id: sourceId, sn_id: sn.sn_id, sn_code: sn.sn_code, product_id: sn.product_id,
      distributor_id: distributorId,
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
  const {
    status, resourceType, sourceType, snCode, remark, supplierId,
    startDate, endDate, page = 1, pageSize = 20
  } = ctx.query;
  const where = {};
  if (status) where.status = status;
  if (String(ctx.query.linkableOnly || '') === '1') {
    where.status = { [Op.in]: ['PENDING', 'PARTIALLY_SETTLED'] };
    where.amount = { [Op.gt]: 0 };
  }
  if (resourceType) where.resource_type = resourceType;
  if (sourceType) where.source_type = sourceType;
  if (snCode) where.sn_code = { [Op.like]: `%${snCode}%` };
  if (remark) where.remark = { [Op.like]: `%${remark}%` };
  if (supplierId) where.counterparty_id = supplierId;
  const start = chinaDateBoundary(startDate, false);
  const end = chinaDateBoundary(endDate, true);
  if (start || end) {
    where.create_time = {};
    if (start) where.create_time[Op.gte] = start;
    if (end) where.create_time[Op.lte] = end;
  }
  const { count, rows } = await ResourceSettlement.findAndCountAll({
    where,
    include: [
      { model: ResourceCategory, as: 'ResourceCategory', required: false, include: [{ model: SettlementAccount, as: 'DefaultAccount', required: false }] },
      { model: SettlementAccount, as: 'TargetAccount', required: false },
      {
        model: RebateSettlementAllocation,
        as: 'Allocations',
        required: false,
        where: { status: 'ACTIVE' },
        include: [{ model: RebatePostingOrder, as: 'PostingOrder', required: false }]
      }
    ],
    order: buildPendingFirstOrder(sequelize, {
      statusColumn: 'ResourceSettlement.status',
      pendingStatuses: ['PENDING', 'PARTIALLY_SETTLED'],
      dateColumns: ['ResourceSettlement.create_time'],
      idColumn: 'ResourceSettlement.settlement_id'
    }),
    distinct: true,
    ...paginate({}, { page, pageSize })
  });
  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

async function createManualRebateSettlement(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance']);
  const { supplierId, amount, remark } = ctx.request.body || {};
  const numericAmount = money(amount);
  const normalizedRemark = String(remark || '').trim();
  if (!supplierId) ctx.throw(400, '请选择供应商');
  if (!Number.isFinite(numericAmount) || numericAmount === 0) ctx.throw(400, '返利金额不能为0');
  if (!normalizedRemark) ctx.throw(400, '手工返利必须填写备注');

  const supplier = await Supplier.findOne({
    where: { supplier_id: supplierId, status: 1, is_deleted: 0 }
  });
  if (!supplier) ctx.throw(404, '供应商不存在');
  const category = await ResourceCategory.findOne({
    where: { category_code: 'MANUAL_REBATE', status: 1 }
  });
  if (!category) ctx.throw(409, '手工返利类型未配置或已停用');
  const user = ctx.state.user || {};
  const sourceId = generateUUID();
  const record = await ResourceSettlement.create({
    settlement_id: generateUUID(),
    settlement_no: businessNo('RST'),
    source_type: 'MANUAL_REBATE',
    source_id: sourceId,
    sn_id: null,
    sn_code: null,
    product_id: null,
    resource_type: 'MANUAL_REBATE',
    counterparty_id: supplier.supplier_id,
    counterparty_name: supplier.name,
    amount: numericAmount,
    matched_amount: 0,
    status: 'PENDING',
    target_account_id: null,
    create_staff_id: user.staffId || null,
    create_user: user.name || user.phone || '',
    remark: normalizedRemark
  });
  ctx.body = {
    message: numericAmount < 0 ? '返利扣减下账单已添加' : '待核销返利下账单已添加',
    settlementId: record.settlement_id
  };
}

async function listNbPolicies(ctx) {
  const { pn, page = 1, pageSize = 20 } = ctx.query;
  const where = {};
  if (pn) where.pn = { [Op.like]: `%${pn}%` };
  const { count, rows } = await ManufacturerPriceHistory.findAndCountAll({
    where,
    order: [['effective_date', 'DESC'], ['created_at', 'DESC']],
    ...paginate({}, { page, pageSize })
  });
  ctx.body = formatPaginatedResult(rows, { page, pageSize, count });
}

async function exportRights(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance', 'manager']);
  const { snCode, pnCode, productId, resourceType, status } = ctx.query;
  const where = {};
  if (snCode) where.sn_code = { [Op.like]: `%${snCode}%` };
  if (productId) where.product_id = productId;
  if (resourceType) where.resource_type = resourceType;
  if (status) where.current_status = status;
  const snInclude = { model: ProductSn, attributes: ['status', 'pn_code'] };
  if (pnCode) {
    snInclude.where = { pn_code: { [Op.like]: `%${pnCode}%` } };
    snInclude.required = true;
  }
  const rows = await InventoryResourceRight.findAll({
    where,
    include: [
      { model: Product, attributes: ['name', 'product_code'] },
      snInclude
    ],
    order: [['update_time', 'DESC']]
  });
  const exportRows = rows.map(row => ({
    SN: row.sn_code,
    PN: row.ProductSn?.pn_code || '',
    商品名称: row.Product?.name || '',
    商品编码: row.Product?.product_code || '',
    权益类型: RESOURCE_LABELS[row.resource_type] || row.resource_type,
    状态: STATUS_LABELS[row.current_status] || row.current_status,
    确认金额: Number(row.amount || 0),
    更新时间: row.update_time || '',
    备注: row.remark || ''
  }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(exportRows), '库存资源权益');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  ctx.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  ctx.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('库存资源权益.xlsx')}`);
  ctx.body = buffer;
}

async function importNbPolicy(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance', 'manager']);
  return require('../finance/rebateController').importManufacturerOperations(ctx);
}

async function createClaimPriceProtection({ change, sn, transaction }) {
  if (!sn?.supplier_id || !sn?.pn_code) return null;
  const claimDate = new Date();
  const pickupDateValue = sn.original_inbound_time || sn.inbound_time || claimDate;
  const dateOnly = value => {
    const date = new Date(value);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  };
  const findPrice = effectiveDate => ManufacturerPriceHistory.findOne({
    where: {
      pn: sn.pn_code,
      [Op.and]: [
        { effective_date: { [Op.lte]: dateOnly(effectiveDate) } },
        { [Op.or]: [{ expire_date: null }, { expire_date: { [Op.gte]: dateOnly(effectiveDate) } }] },
        { [Op.or]: [{ product_id: sn.product_id }, { product_id: null }, { product_id: '' }] }
      ]
    },
    order: [['effective_date', 'DESC'], ['created_at', 'DESC']],
    transaction
  });
  const [pickupPolicy, currentPolicy, supplier] = await Promise.all([
    findPrice(pickupDateValue), findPrice(claimDate),
    Supplier.findByPk(sn.supplier_id, { attributes: ['supplier_id', 'is_service_provider'], transaction })
  ]);
  const isServiceProvider = Boolean(supplier && Number(supplier.is_service_provider) !== 0);
  const pickupSettlementPrice = Number(pickupPolicy?.settlement_price || (isServiceProvider ? 0 : sn.original_pickup_price || sn.inbound_price || 0));
  const currentSettlementPrice = Number(currentPolicy?.settlement_price || currentPolicy?.pickup_price || 0);
  const unitDelta = Number((currentSettlementPrice - pickupSettlementPrice).toFixed(2));
  if (unitDelta <= 0) return null;
  const sourceId = `PRICE_CLAIM_${change.change_id}`;
  return createPendingSettlement({
    sourceType: 'MANUFACTURER_REBATE', sourceId,
    sn: { sn_id: sn.sn_id, sn_code: sn.sn_code, product_id: sn.product_id },
    resourceType: 'MANUFACTURER_REBATE', amount: unitDelta,
    counterpartyId: sn.supplier_id, counterpartyName: sn.supplier_name || '', forceSettlement: true,
    remark: `套回单 ${change.change_order_no}；PO价保 = 当前结算价 ${currentSettlementPrice.toFixed(2)} - 提货时结算价 ${pickupSettlementPrice.toFixed(2)}；数量 1`,
    transaction
  });
}

function reconciliationStatus(total, matched) {
  if (matched <= 0) return 'UNMATCHED';
  if (matched + 0.0001 >= total) return 'MATCHED';
  return 'PARTIALLY_MATCHED';
}

async function settleNegativeRebateCorrection(ctx, record, transaction) {
  if (record.status !== 'PENDING') ctx.throw(409, '返利扣减下账单只能在待下账状态确认');
  const amount = Math.abs(money(record.amount));
  const user = ctx.state.user || {};
  const latest = await SupplierRebate.findOne({
    where: { supplier_id: record.counterparty_id },
    order: [['create_time', 'DESC'], ['rebate_id', 'DESC']],
    transaction,
    lock: transaction.LOCK.UPDATE
  });
  const balance = money(money(latest?.balance) - amount);
  const rebate = await SupplierRebate.create({
    rebate_id: generateUUID(),
    supplier_id: record.counterparty_id,
    supplier_name: record.counterparty_name || '',
    type: 'debit',
    amount,
    balance,
    related_no: record.settlement_no,
    remark: record.remark,
    status: 'active',
    source_type: 'resource_settlement_deduction',
    source_id: record.settlement_id,
    create_user: user.name || user.phone || ''
  }, { transaction });
  const account = await SettlementAccount.findOne({
    where: { account_type: 'SUPPLIER_REBATE', supplier_id: record.counterparty_id, status: 1 },
    transaction,
    lock: transaction.LOCK.UPDATE
  });
  if (account) {
    const income = Number(await SettlementAccountTransaction.sum('amount', { where: { account_id: account.account_id, type: 'income' }, transaction }) || 0);
    const expense = Number(await SettlementAccountTransaction.sum('amount', { where: { account_id: account.account_id, type: 'expense' }, transaction }) || 0);
    await SettlementAccountTransaction.create({
      transaction_id: generateUUID(), account_id: account.account_id, type: 'expense', amount,
      balance_after: money(income - expense - amount),
      description: `返利扣减下账：${record.remark}`,
      related_ref: record.settlement_no, create_user: user.name || user.phone || ''
    }, { transaction });
  }
  await record.update({
    matched_amount: 0,
    status: 'SETTLED',
    target_account_id: account?.account_id || null,
    settled_at: new Date(),
    settled_by: user.staffId || null,
    settled_by_name: user.name || '',
    update_time: new Date()
  }, { transaction });
  return { fullyMatched: true, allocationTotal: 0, matchedAmount: 0, rebateId: rebate.rebate_id || rebate.rebateId };
}

async function reconcileRebateSettlement(ctx, record, transaction, allocationsInput = ctx.request.body?.allocations) {
  if (!['PENDING', 'PARTIALLY_SETTLED'].includes(record.status)) {
    ctx.throw(409, '该待下账返利已完成关联');
  }
  if (!record.counterparty_id) ctx.throw(400, '待下账返利缺少供应商，无法关联');
  if (money(record.amount) < 0) return settleNegativeRebateCorrection(ctx, record, transaction);
  const input = Array.isArray(allocationsInput) ? allocationsInput : [];
  const grouped = new Map();
  for (const item of input) {
    const postingId = item.postingId || item.posting_id;
    const amount = money(item.amount);
    if (!postingId || amount <= 0) continue;
    grouped.set(postingId, money((grouped.get(postingId) || 0) + amount));
  }
  if (grouped.size === 0) ctx.throw(400, '请选择已上账返利单并填写关联金额');

  const settlementAmount = money(record.amount);
  const previousMatched = money(record.matched_amount);
  const remaining = money(settlementAmount - previousMatched);
  const allocationTotal = money([...grouped.values()].reduce((sum, value) => sum + value, 0));
  if (allocationTotal > remaining + 0.0001) {
    ctx.throw(400, `本次关联金额不能超过待下账返利剩余金额 ¥${remaining.toFixed(2)}`);
  }

  const user = ctx.state.user || {};
  for (const [postingId, amount] of grouped.entries()) {
    const posting = await RebatePostingOrder.findByPk(postingId, {
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!posting || posting.status === 'REVERSED' || money(posting.amount) <= 0) ctx.throw(404, '有效的正向已上账返利单不存在');
    if (posting.supplier_id !== record.counterparty_id) ctx.throw(400, '只能关联同一供应商的已上账返利单');
    const postingAmount = money(posting.amount);
    const postingMatched = money(posting.matched_amount);
    const postingRemaining = money(postingAmount - postingMatched);
    if (amount > postingRemaining + 0.0001) {
      ctx.throw(400, `已上账返利单 ${posting.posting_no} 剩余待关联金额仅 ¥${postingRemaining.toFixed(2)}`);
    }
    const newPostingMatched = money(postingMatched + amount);
    await RebateSettlementAllocation.create({
      allocation_id: generateUUID(),
      settlement_id: record.settlement_id,
      posting_id: posting.posting_id,
      amount,
      status: 'ACTIVE',
      create_staff_id: user.staffId || null,
      create_user: user.name || user.phone || ''
    }, { transaction });
    await posting.update({
      matched_amount: newPostingMatched,
      status: reconciliationStatus(postingAmount, newPostingMatched)
    }, { transaction });
  }

  const newMatched = money(previousMatched + allocationTotal);
  const fullyMatched = newMatched + 0.0001 >= settlementAmount;
  await record.update({
    matched_amount: newMatched,
    status: fullyMatched ? 'SETTLED' : 'PARTIALLY_SETTLED',
    settled_at: fullyMatched ? new Date() : null,
    settled_by: fullyMatched ? user.staffId || null : null,
    settled_by_name: fullyMatched ? user.name || '' : null,
    update_time: new Date()
  }, { transaction });
  if (fullyMatched && record.source_type === 'MANUFACTURER_REBATE') {
    await RebateEstimate.update(
      { status: 'received', updated_at: new Date() },
      { where: { estimate_id: record.source_id }, transaction }
    );
  }
  return { fullyMatched, allocationTotal, matchedAmount: newMatched };
}

async function batchSettleRebateResources(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance'], '无权关联返利');
  const items = Array.isArray(ctx.request.body?.items) ? ctx.request.body.items : [];
  if (items.length === 0) ctx.throw(400, '请选择待下账返利');
  const normalizedItems = items.map(item => ({
    settlementId: item.settlementId || item.settlement_id,
    allocations: Array.isArray(item.allocations) ? item.allocations : []
  })).filter(item => item.settlementId);
  if (normalizedItems.length !== items.length) ctx.throw(400, '批量关联待下账返利格式无效');
  const settlementIds = [...new Set(normalizedItems.map(item => item.settlementId))];
  if (settlementIds.length !== normalizedItems.length) ctx.throw(400, '批量关联时不能重复选择待下账返利');

  const results = [];
  await sequelize.transaction(async transaction => {
    const records = await ResourceSettlement.findAll({
      where: { settlement_id: settlementIds },
      order: [['create_time', 'ASC'], ['settlement_id', 'ASC']],
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (records.length !== settlementIds.length) ctx.throw(404, '部分待下账返利记录不存在');
    const recordMap = new Map(records.map(record => [record.settlement_id, record]));
    for (const item of normalizedItems) {
      const record = recordMap.get(item.settlementId);
      if (money(record.amount) <= 0 || !record.counterparty_id) {
        ctx.throw(400, '批量关联仅支持有供应商归属的正向待下账返利');
      }
      const result = await reconcileRebateSettlement(ctx, record, transaction, item.allocations);
      results.push({ settlementId: record.settlement_id, ...result });
    }
  });
  ctx.body = { message: '批量返利关联成功', data: { items: results } };
}

async function linkRebateSettlement(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance'], '无权关联返利');
  let result = null;
  await sequelize.transaction(async transaction => {
    const record = await ResourceSettlement.findByPk(ctx.params.settlementId, {
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!record) ctx.throw(404, '待下账返利记录不存在');
    if (money(record.amount) <= 0) ctx.throw(400, '只有正向待下账返利可以关联');
    if (!record.counterparty_id) ctx.throw(400, '待下账返利缺少供应商，无法关联');
    result = await reconcileRebateSettlement(ctx, record, transaction);
  });
  ctx.body = {
    message: result.fullyMatched ? '待下账返利已关联' : '待下账返利已部分关联',
    data: result
  };
}

async function settleResource(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance'], '无权执行返利下账');
  const accountOverride = ctx.request.body?.accountId || null;
  let result = null;
  await sequelize.transaction(async transaction => {
    const record = await ResourceSettlement.findByPk(ctx.params.settlementId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!record) ctx.throw(404, '资源待下账记录不存在');
    if (!['PENDING', 'PARTIALLY_SETTLED'].includes(record.status)) ctx.throw(409, '该资源记录已完成下账');
    const category = await ResourceCategory.findOne({ where: { category_code: record.resource_type }, transaction });
    if (record.source_type === 'CASH_RED_PACKET') {
      const accountId = String(ctx.request.body?.accountId || record.target_account_id || category?.default_account_id || '').trim();
      const account = accountId ? await SettlementAccount.findOne({
        where: { account_id: accountId, account_type: 'FUND', status: 1 }, transaction, lock: transaction.LOCK.UPDATE
      }) : null;
      if (!account) ctx.throw(400, '请选择有效的现金或银行账户');
      if (record.target_account_id && record.target_account_id !== account.account_id) ctx.throw(409, '同一红包待收记录分次到账时请使用同一账户');
      const remaining = money(Number(record.amount || 0) - Number(record.matched_amount || 0));
      const receivedAmount = money(ctx.request.body?.receivedAmount ?? remaining);
      if (receivedAmount <= 0 || receivedAmount > remaining) ctx.throw(400, `到账金额必须大于0且不超过剩余待收 ¥${remaining.toFixed(2)}`);
      const item = await SalesCashRebateClaimItem.findOne({ where: { claim_item_id: record.source_id }, transaction, lock: transaction.LOCK.UPDATE });
      if (!item) ctx.throw(409, '找不到现金红包对应的销售商品明细');
      const [incomeTotal, expenseTotal] = await Promise.all([
        SettlementAccountTransaction.sum('amount', { where: { account_id: account.account_id, type: 'income' }, transaction }),
        SettlementAccountTransaction.sum('amount', { where: { account_id: account.account_id, type: 'expense' }, transaction })
      ]);
      const receiptId = generateUUID();
      const transactionId = generateUUID();
      const adjustmentId = generateUUID();
      await SettlementAccountTransaction.create({
        transaction_id: transactionId, account_id: account.account_id, type: 'income', amount: receivedAmount,
        balance_after: money(Number(incomeTotal || 0) - Number(expenseTotal || 0) + receivedAmount),
        description: `销售现金红包到账：${record.settlement_no} ${item.sn_code || ''}`,
        related_ref: `${record.settlement_no}:${receiptId}`, create_user: ctx.state.user.name || ctx.state.user.phone || ''
      }, { transaction });
      const order = await Order.findByPk(item.order_id, { transaction });
      if (!order) ctx.throw(409, '现金红包关联的销售订单不存在');
      const applicantStaffId = Number(ctx.state.user.staffId || 0);
      if (!applicantStaffId) ctx.throw(401, '当前账号缺少员工身份，无法登记到账');
      await PerformanceProfitAdjustment.create({
        adjustment_id: adjustmentId, adjustment_no: `CRB-${receiptId}`,
        order_id: item.order_id, order_no: item.order_no, store_id: item.store_id || order.store_id,
        product_id: item.product_id, employee_name: order.operator_name || order.create_user || '',
        adjustment_type: 'increase', amount: receivedAmount, signed_amount: receivedAmount,
        base_gross_profit: 0, reason: `销售红包到账：${record.settlement_no} ${item.sn_code || ''}`,
        status: 'approved', applicant_staff_id: applicantStaffId,
        applicant_name: ctx.state.user.name || ctx.state.user.phone || '',
        finance_reviewer_id: applicantStaffId, finance_reviewer_name: ctx.state.user.name || '',
        finance_review_comment: '实际到账确认', finance_review_time: new Date(),
        admin_reviewer_id: applicantStaffId, admin_reviewer_name: ctx.state.user.name || '', admin_review_time: new Date(),
        create_time: new Date(), update_time: new Date()
      }, { transaction });
      await SalesCashRebateReceipt.create({
        receipt_id: receiptId, settlement_id: record.settlement_id, account_id: account.account_id,
        account_transaction_id: transactionId, adjustment_id: adjustmentId, amount: receivedAmount,
        status: 'active', create_staff_id: applicantStaffId,
        create_user: ctx.state.user.name || ctx.state.user.phone || '', create_time: new Date()
      }, { transaction });
      const matchedAmount = money(Number(record.matched_amount || 0) + receivedAmount);
      const fullyReceived = matchedAmount + 0.0001 >= Number(record.amount || 0);
      await record.update({
        matched_amount: matchedAmount, status: fullyReceived ? 'SETTLED' : 'PARTIALLY_SETTLED',
        target_account_id: account.account_id, settled_at: new Date(),
        settled_by: applicantStaffId, settled_by_name: ctx.state.user.name || '', update_time: new Date()
      }, { transaction });
      result = { fullyMatched: fullyReceived, receivedAmount, matchedAmount, cashRedPacket: true };
      return;
    }
    if (['MANUAL_REBATE', 'MANUFACTURER_REBATE', 'REBATE_RECEIPT', 'EXPENSE_REBATE'].includes(record.source_type)) {
      result = await reconcileRebateSettlement(ctx, record, transaction);
      return;
    }
    let accountId = accountOverride || record.target_account_id || category?.default_account_id;
    let account = null;
    if (!accountId) ctx.throw(400, '该资源类别尚未配置到账账户');
    account = await SettlementAccount.findOne({ where: { account_id: accountId, status: 1 }, transaction, lock: transaction.LOCK.UPDATE });
    if (!account) ctx.throw(400, '到账账户不存在或已停用');
    if (account.account_type === 'SUPPLIER_REBATE' && record.counterparty_id && account.supplier_id !== record.counterparty_id) {
      account = await SettlementAccount.findOne({
        where: { account_type: 'SUPPLIER_REBATE', supplier_id: record.counterparty_id, status: 1 },
        transaction, lock: transaction.LOCK.UPDATE
      });
      if (!account) ctx.throw(400, `未配置${record.counterparty_name || '该供应商'}的供应商返利账户`);
      accountId = account.account_id;
    }
    if (account.account_type === 'SUPPLIER_REBATE') {
      result = await reconcileRebateSettlement(ctx, record, transaction);
      return;
    }
    const income = Number(await SettlementAccountTransaction.sum('amount', { where: { account_id: accountId, type: 'income' }, transaction }) || 0);
    const expense = Number(await SettlementAccountTransaction.sum('amount', { where: { account_id: accountId, type: 'expense' }, transaction }) || 0);
    const amount = Number(record.amount || 0);
    await SettlementAccountTransaction.create({
      transaction_id: generateUUID(), account_id: accountId, type: 'income', amount,
      balance_after: income - expense + amount,
      description: `${category?.name || record.resource_type}下账（${{ SALE_USE: '销售使用', COMPANY_CLAIM: '公司套回', MANUFACTURER_REBATE: '厂商返利', MANUAL_REBATE: '手工返利' }[record.source_type] || record.source_type}）`,
      related_ref: record.settlement_no, create_user: ctx.state.user.name
    }, { transaction });

    await record.update({
      status: 'SETTLED', target_account_id: accountId, settled_at: new Date(),
      settled_by: ctx.state.user.staffId, settled_by_name: ctx.state.user.name,
      update_time: new Date()
    }, { transaction });
    if (record.source_type === 'MANUFACTURER_REBATE') {
      await RebateEstimate.update({ status: 'received', updated_at: new Date() }, { where: { estimate_id: record.source_id }, transaction });
    }
  });
  ctx.body = result
    ? {
        message: result.cashRedPacket
          ? (result.fullyMatched ? '销售红包到账已登记并完成核销' : '销售红包部分到账已登记')
          : (result.fullyMatched ? '返利下账单已完成核销' : '返利下账单已部分核销'),
        data: result
      }
    : { message: '资源权益已下账' };
}

async function cancelResourceSettlement(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance']);
  const reason = String(ctx.request.body?.reason || '').trim();
  if (!reason) ctx.throw(400, '请输入取消原因');
  await sequelize.transaction(async transaction => {
    const record = await ResourceSettlement.findByPk(ctx.params.settlementId, {
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!record) ctx.throw(404, '待下账记录不存在');
    if (record.source_type !== 'MANUAL_REBATE') ctx.throw(400, '只有手工添加的待下账返利可以取消');
    if (record.status !== 'PENDING') ctx.throw(409, '只有待下账记录可以取消');
    await record.update({
      status: 'CANCELLED',
      cancelled_at: new Date(),
      cancelled_by: ctx.state.user.staffId,
      cancelled_by_name: ctx.state.user.name,
      correction_reason: reason,
      update_time: new Date()
    }, { transaction });
  });
  ctx.body = { message: '待下账返利已取消' };
}

async function reverseResourceSettlement(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance']);
  const reason = String(ctx.request.body?.reason || '').trim();
  if (!reason) ctx.throw(400, '请输入冲销原因');
  let reconciliationReversed = false;
  await sequelize.transaction(async transaction => {
    const record = await ResourceSettlement.findByPk(ctx.params.settlementId, {
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!record) ctx.throw(404, '下账记录不存在');
    if (!['SETTLED', 'PARTIALLY_SETTLED'].includes(record.status)) ctx.throw(409, '只有已核销或部分核销记录可以撤销核销');

    if (money(record.amount) < 0) {
      const originalRebate = await SupplierRebate.findOne({
        where: {
          source_type: 'resource_settlement_deduction',
          source_id: record.settlement_id,
          status: 'active'
        },
        transaction,
        lock: transaction.LOCK.UPDATE
      });
      if (!originalRebate) ctx.throw(409, '未找到原返利扣减流水，无法冲销');
      const amount = Math.abs(money(record.amount));
      const latest = await SupplierRebate.findOne({
        where: { supplier_id: record.counterparty_id },
        order: [['create_time', 'DESC'], ['rebate_id', 'DESC']],
        transaction,
        lock: transaction.LOCK.UPDATE
      });
      await SupplierRebate.create({
        rebate_id: generateUUID(),
        supplier_id: record.counterparty_id,
        supplier_name: record.counterparty_name || '',
        type: 'credit',
        amount,
        balance: money(money(latest?.balance) + amount),
        related_no: record.settlement_no,
        remark: `返利扣减冲销：${reason}`,
        status: 'active',
        source_type: 'resource_settlement_deduction_reversal',
        source_id: record.settlement_id,
        reversal_of: originalRebate.rebate_id,
        create_user: ctx.state.user.name || ctx.state.user.phone || ''
      }, { transaction });
      await originalRebate.update({ status: 'reversed' }, { transaction });
      if (record.target_account_id) {
        const account = await SettlementAccount.findOne({
          where: { account_id: record.target_account_id, status: 1 },
          transaction,
          lock: transaction.LOCK.UPDATE
        });
        if (account) {
          const income = Number(await SettlementAccountTransaction.sum('amount', { where: { account_id: account.account_id, type: 'income' }, transaction }) || 0);
          const expense = Number(await SettlementAccountTransaction.sum('amount', { where: { account_id: account.account_id, type: 'expense' }, transaction }) || 0);
          await SettlementAccountTransaction.create({
            transaction_id: generateUUID(), account_id: account.account_id, type: 'income', amount,
            balance_after: money(income - expense + amount),
            description: `返利扣减冲销：${reason}`,
            related_ref: `${record.settlement_no}:REV`, create_user: ctx.state.user.name || ctx.state.user.phone || ''
          }, { transaction });
        }
      }
      await record.update({
        status: 'REVERSED',
        reversed_at: new Date(),
        reversed_by: ctx.state.user.staffId || null,
        reversed_by_name: ctx.state.user.name || '',
        correction_reason: reason,
        update_time: new Date()
      }, { transaction });
      reconciliationReversed = true;
      return;
    }

    if (record.source_type === 'CASH_RED_PACKET') {
      const receipts = await SalesCashRebateReceipt.findAll({
        where: { settlement_id: record.settlement_id, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE
      });
      if (!receipts.length) ctx.throw(409, '未找到现金红包到账流水，无法冲销');
      for (const receipt of receipts) {
        const account = await SettlementAccount.findOne({ where: { account_id: receipt.account_id }, transaction, lock: transaction.LOCK.UPDATE });
        if (!account) ctx.throw(409, '原收款账户不存在，无法冲销现金红包到账');
        const [income, expense] = await Promise.all([
          SettlementAccountTransaction.sum('amount', { where: { account_id: account.account_id, type: 'income' }, transaction }),
          SettlementAccountTransaction.sum('amount', { where: { account_id: account.account_id, type: 'expense' }, transaction })
        ]);
        await SettlementAccountTransaction.create({
          transaction_id: generateUUID(), account_id: account.account_id, type: 'expense', amount: receipt.amount,
          balance_after: money(Number(income || 0) - Number(expense || 0) - Number(receipt.amount || 0)),
          description: `销售现金红包到账冲销：${record.settlement_no} ${reason}`,
          related_ref: `${record.settlement_no}:REV:${receipt.receipt_id}`, create_user: ctx.state.user.name || ctx.state.user.phone || ''
        }, { transaction });
        await PerformanceProfitAdjustment.update(
          { status: 'reversed', update_time: new Date() },
          { where: { adjustment_id: receipt.adjustment_id }, transaction }
        );
        await receipt.update({ status: 'reversed', reverse_reason: reason }, { transaction });
      }
      await record.update({
        matched_amount: 0, status: 'REVERSED', reversed_at: new Date(),
        reversed_by: ctx.state.user.staffId || null, reversed_by_name: ctx.state.user.name || '',
        correction_reason: reason, update_time: new Date()
      }, { transaction });
      reconciliationReversed = true;
      return;
    }

    const activeAllocations = await RebateSettlementAllocation.findAll({
      where: { settlement_id: record.settlement_id, status: 'ACTIVE' },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (activeAllocations.length > 0 || ['MANUAL_REBATE', 'MANUFACTURER_REBATE', 'REBATE_RECEIPT', 'EXPENSE_REBATE'].includes(record.source_type)) {
      if (activeAllocations.length === 0) ctx.throw(409, '未找到返利下账单对应的核销记录');
      for (const allocation of activeAllocations) {
        const posting = await RebatePostingOrder.findByPk(allocation.posting_id, {
          transaction,
          lock: transaction.LOCK.UPDATE
        });
        if (!posting) ctx.throw(409, '核销关联的返利上账单不存在');
        const newMatched = Math.max(0, money(posting.matched_amount) - money(allocation.amount));
        await posting.update({
          matched_amount: newMatched,
          status: reconciliationStatus(money(posting.amount), newMatched)
        }, { transaction });
        await allocation.update({
          status: 'REVERSED',
          reversed_at: new Date(),
          reversed_by: ctx.state.user.staffId || null,
          reversed_by_name: ctx.state.user.name || '',
          reversal_reason: reason
        }, { transaction });
      }
      await record.update({
        matched_amount: 0,
        status: 'PENDING',
        settled_at: null,
        settled_by: null,
        settled_by_name: null,
        reversed_at: new Date(),
        reversed_by: ctx.state.user.staffId || null,
        reversed_by_name: ctx.state.user.name || '',
        correction_reason: reason,
        update_time: new Date()
      }, { transaction });
      if (record.source_type === 'MANUFACTURER_REBATE') {
        await RebateEstimate.update(
          { status: 'confirmed', updated_at: new Date() },
          { where: { estimate_id: record.source_id }, transaction }
        );
      }
      reconciliationReversed = true;
      return;
    }
    if (!record.target_account_id) ctx.throw(409, '原下账记录缺少到账账户，无法自动冲销');

    const account = await SettlementAccount.findOne({
      where: { account_id: record.target_account_id },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!account) ctx.throw(409, '原到账账户不存在，无法自动冲销');
    const originalTransaction = await SettlementAccountTransaction.findOne({
      where: {
        account_id: account.account_id,
        related_ref: record.settlement_no,
        type: 'income'
      },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!originalTransaction) ctx.throw(409, '未找到原下账账户流水，无法自动冲销');

    const income = Number(await SettlementAccountTransaction.sum('amount', {
      where: { account_id: account.account_id, type: 'income' },
      transaction
    }) || 0);
    const expense = Number(await SettlementAccountTransaction.sum('amount', {
      where: { account_id: account.account_id, type: 'expense' },
      transaction
    }) || 0);
    const amount = Number(record.amount || 0);
    await SettlementAccountTransaction.create({
      transaction_id: generateUUID(),
      account_id: account.account_id,
      type: 'expense',
      amount,
      balance_after: income - expense - amount,
      description: `返利下账冲销：${reason}`,
      related_ref: `${record.settlement_no}:REV`,
      create_user: ctx.state.user.name
    }, { transaction });

    if (account.account_type === 'SUPPLIER_REBATE') {
      const originalRebate = await SupplierRebate.findOne({
        where: {
          source_type: 'resource_settlement',
          source_id: record.settlement_id,
          status: 'active'
        },
        transaction,
        lock: transaction.LOCK.UPDATE
      });
      if (!originalRebate) ctx.throw(409, '未找到原供应商返利流水，无法自动冲销');
      const latest = await SupplierRebate.findOne({
        where: { supplier_id: account.supplier_id },
        order: [['create_time', 'DESC'], ['rebate_id', 'DESC']],
        transaction,
        lock: transaction.LOCK.UPDATE
      });
      await SupplierRebate.create({
        rebate_id: generateUUID(),
        supplier_id: account.supplier_id,
        supplier_name: originalRebate.supplier_name || record.counterparty_name || '',
        type: 'debit',
        amount,
        balance: Number(latest?.balance || 0) - amount,
        related_no: record.settlement_no,
        remark: `返利下账冲销：${reason}`,
        status: 'active',
        source_type: 'resource_settlement_reversal',
        source_id: record.settlement_id,
        reversal_of: originalRebate.rebate_id,
        create_user: ctx.state.user.name
      }, { transaction });
      await originalRebate.update({ status: 'reversed' }, { transaction });
    }

    await record.update({
      status: 'REVERSED',
      reversed_at: new Date(),
      reversed_by: ctx.state.user.staffId,
      reversed_by_name: ctx.state.user.name,
      correction_reason: reason,
      update_time: new Date()
    }, { transaction });
    if (record.source_type === 'MANUFACTURER_REBATE') {
      await RebateEstimate.update(
        { status: 'confirmed', updated_at: new Date() },
        { where: { estimate_id: record.source_id }, transaction }
      );
    }
  });
  ctx.body = { message: reconciliationReversed ? '返利下账已撤销' : '资源下账已冲销' };
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
      if (category.resource_kind === 'PO_REWARD') {
        const resourceRight = rightsBySnType.get(`${item.sn_id}:${category.category_code}`);
        if (resourceRight?.current_status === 'AVAILABLE' && resourceRight.supplier_id) {
          const archiveDate = order.archive_time || new Date();
          const date = new Date(archiveDate);
          const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
          const nbPolicy = await ManufacturerPriceHistory.findOne({
            where: {
              pn: item.pn_code,
              [Op.and]: [
                { effective_date: { [Op.lte]: dateOnly } },
                { [Op.or]: [{ expire_date: null }, { expire_date: { [Op.gte]: dateOnly } }] },
                { [Op.or]: [{ product_id: item.product_id }, { product_id: null }, { product_id: '' }] }
              ]
            },
            order: [['effective_date', 'DESC'], ['created_at', 'DESC']],
            transaction
          });
          if (Number(nbPolicy?.po_rebate_amount || 0) > 0) {
            await ResourceRightChangeOrder.create({
              change_id: generateUUID(),
              change_order_no: businessNo(),
              sn_id: item.sn_id,
              sn_code: item.sn_code,
              product_id: item.product_id,
              resource_type: category.category_code,
              before_status: 'AVAILABLE',
              after_status: 'USED',
              change_amount: money(Number(nbPolicy.po_rebate_amount) * Number(item.quantity || 1)),
              change_reason: 'SALE_TRIGGER_NB_POLICY',
              approval_status: 'approved',
              related_sale_order_id: order.order_id,
              applicant_name: order.create_user,
              reviewer_name: 'system',
              review_time: new Date(),
              remark: `NB政策批次 ${nbPolicy.import_batch_no || '-'} 已在销售结算链路生成PO后返，避免重复计入`
            }, { transaction });
            await resourceRight.update({
              current_status: 'USED',
              amount: money(Number(nbPolicy.po_rebate_amount) * Number(item.quantity || 1)),
              locked_source_type: null,
              locked_source_id: null,
              version: Number(resourceRight.version || 0) + 1
            }, { transaction });
            continue;
          }
        }
      }
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
      if (category.resource_kind === 'PO_REWARD' && amount > 0 && !right.supplier_id) {
        throw Object.assign(new Error(`SN ${item.sn_code} 缺少供应商归属，无法生成PO后返待下账`), { status: 409 });
      }
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

      if (category.category_code !== 'SALES_REPORT' && Number(category.generates_staff_care_credit) === 1) {
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
      if ((Number(category.generates_settlement) === 1 || category.resource_kind === 'PO_REWARD') && amount > 0) {
        await createPendingSettlement({
          sourceType: rebateEstimate ? 'MANUFACTURER_REBATE' : 'SALE_TRIGGER',
          sourceId: rebateEstimate?.estimate_id || change.change_id,
          sn: { sn_id: item.sn_id, sn_code: item.sn_code, product_id: item.product_id },
          resourceType: category.category_code,
          amount,
          counterpartyId: right.supplier_id || null,
          counterpartyName: right.supplier_name || '',
          forceSettlement: category.resource_kind === 'PO_REWARD',
          remark: `销售订单 ${order.order_no} 触发${category.name}`,
          transaction
        });
      }
      const affectsProfit = category.category_code === 'EDU_SUBSIDY'
        || category.resource_kind === 'PO_REWARD'
        || Number(rule?.affects_performance_profit ?? category.affects_performance_profit) === 1;
      if (affectsProfit) {
        await createPerformanceProfitAdjustment({
          order,
          item,
          resourceType: category.category_code,
          amount,
          // 教育补贴和 PO 后返全额进入供应商待下账；店员毛利按 80% 计入。
          ratio: ['EDU_SUBSIDY', 'PO_REWARD'].includes(category.category_code) || category.resource_kind === 'PO_REWARD'
            ? 80
            : (rule?.performance_profit_ratio ?? category.performance_profit_ratio),
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

function resourceFlagField(resourceType) {
  return {
    GOV_SUBSIDY: 'use_gov_subsidy',
    EDU_SUBSIDY: 'use_edu_subsidy',
    SALES_REPORT: 'use_sales_report'
  }[resourceType] || null;
}

async function updateItemResourceSelection(item, resourceType, selected, transaction) {
  const resources = selectedResources(item).filter(type => type !== resourceType);
  if (selected) resources.push(resourceType);
  // Sequelize TEXT 字段只接受字符串；统一按现有 JSON 文本格式持久化。
  const changes = { selected_resource_types: JSON.stringify([...new Set(resources)]) };
  const flagField = resourceFlagField(resourceType);
  if (flagField) changes[flagField] = selected ? 1 : 0;
  await item.update(changes, { transaction });
}

/**
 * 订单级补贴金额只能落到已解析出有效 SN 的商品行。
 * 历史订单若把补贴标记遗留在非 SN 行，且订单只有一个有效 SN，则在归档事务内自动纠正；
 * 多个 SN 无法唯一判断时明确阻断，避免把资格核销到错误商品。
 */
async function alignOrderSubsidyRights(order, items, transaction) {
  const configs = [
    { resourceType: 'GOV_SUBSIDY', amount: order.national_subsidy, label: '国补' },
    { resourceType: 'EDU_SUBSIDY', amount: order.education_subsidy, label: '教育补贴' }
  ];
  const productIds = [...new Set(items.map(item => item.product_id).filter(Boolean))];
  const products = productIds.length
    ? await Product.findAll({
        where: { product_id: { [Op.in]: productIds } },
        attributes: ['product_id', 'category'],
        raw: true,
        transaction
      })
    : [];
  const categoryByProduct = new Map(products.map(product => [String(product.product_id), product.category]));
  const snItems = items.filter(item => item.sn_id);

  for (const config of configs) {
    if (Number(config.amount || 0) <= 0) continue;
    const candidates = config.resourceType === 'GOV_SUBSIDY'
      ? snItems.filter(item => isGovSubsidyEligibleCategory(categoryByProduct.get(String(item.product_id))))
      : snItems;
    const selectedItems = items.filter(item => selectedResources(item).includes(config.resourceType));
    const invalidItems = selectedItems.filter(item => !item.sn_id);
    const validItems = selectedItems.filter(item => candidates.some(candidate => candidate.item_id === item.item_id));
    const ineligibleItems = selectedItems.filter(item => item.sn_id && !validItems.includes(item));

    for (const item of [...invalidItems, ...ineligibleItems]) {
      await updateItemResourceSelection(item, config.resourceType, false, transaction);
    }
    if (validItems.length > 0) continue;
    if (candidates.length !== 1) {
      throw Object.assign(new Error(`${config.label}未能匹配唯一的SN商品，请明确选择使用资格的SN`), { status: 409 });
    }
    await updateItemResourceSelection(candidates[0], config.resourceType, true, transaction);
  }

  // 销量报号是售出后完成的事项。SN具备有效资格时自动关联商品行，
  // 避免店员没有在下单页手工勾选就漏掉报号任务。
  for (const item of snItems) {
    if (selectedResources(item).includes('SALES_REPORT')) continue;
    const right = await InventoryResourceRight.findOne({
      where: { sn_id: item.sn_id, resource_type: 'SALES_REPORT' }, transaction
    });
    if (right && effectiveRightStatus(right) === 'AVAILABLE') {
      await updateItemResourceSelection(item, 'SALES_REPORT', true, transaction);
    }
  }
}

async function lockSaleRights(order, items, transaction) {
  for (const item of items) {
    const resources = selectedResources(item);
    if (resources.length && !item.sn_id) {
      const productName = item.product_name || item.pn_code || '未命名商品';
      throw Object.assign(new Error(`商品“${productName}”未绑定有效SN，不能使用SN资格`), { status: 409 });
    }
    for (const resourceType of resources) {
      const category = await ResourceCategory.findOne({ where: { category_code: resourceType, status: 1 }, transaction });
      if (!category || !category.supports_sale_use) throw Object.assign(new Error('所选资源类别不存在、已停用或不允许销售使用'), { status: 409 });
      const right = await InventoryResourceRight.findOne({ where: { sn_id: item.sn_id, resource_type: resourceType }, transaction, lock: transaction.LOCK.UPDATE });
      const alreadyLockedByOrder = right &&
        right.current_status === 'LOCKED' &&
        right.locked_source_type === 'SALE_ORDER' &&
        right.locked_source_id === order.order_id;
      if (alreadyLockedByOrder) continue;
      if (!right || effectiveRightStatus(right) !== 'AVAILABLE') throw Object.assign(new Error(`SN ${item.sn_code} 的${category.name}不可用`), { status: 409 });
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
  const educationItems = items.filter(item => selectedResources(item).includes('EDU_SUBSIDY'));
  const educationTotal = money(order.education_subsidy || 0);
  const itemGross = item => Math.abs(Number(item.sale_price || 0) * Number(item.quantity || 0));
  const educationGrossTotal = educationItems.reduce((sum, item) => sum + itemGross(item), 0);
  const hasLineEducationAmounts = educationItems.some(item => Number(item.education_subsidy_amount || 0) > 0);
  let allocatedEducation = 0;
  const educationAmountByItem = new Map();
  educationItems.forEach((item, index) => {
    const amount = hasLineEducationAmounts
      ? money(item.education_subsidy_amount || 0)
      : index === educationItems.length - 1
        ? money(educationTotal - allocatedEducation)
        : educationGrossTotal > 0
          ? money(educationTotal * itemGross(item) / educationGrossTotal)
          : money(educationTotal / educationItems.length);
    educationAmountByItem.set(String(item.item_id), amount);
    allocatedEducation = money(allocatedEducation + amount);
  });
  for (const item of items) for (const resourceType of selectedResources(item)) {
    if (!item.sn_id) {
      const productName = item.product_name || item.pn_code || '未命名商品';
      throw Object.assign(new Error(`商品“${productName}”未绑定有效SN，不能核销SN资格`), { status: 409 });
    }
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
    const settlementAmount = resourceType === 'EDU_SUBSIDY'
      ? Number(educationAmountByItem.get(String(item.item_id)) || 0)
      : Number(right.amount || 0);
    if (resourceType === 'EDU_SUBSIDY' && settlementAmount > 0 && !right.supplier_id) {
      throw Object.assign(new Error(`SN ${item.sn_code} 缺少供应商归属，无法生成教育补贴返利待下账`), { status: 409 });
    }
    const waitingManualManufacturerRebate = resourceType === 'MANUFACTURER_REBATE'
      ? await RebateEstimate.findOne({
        where: {
          sales_order_id: order.order_id,
          sn_id: item.sn_id,
          source_type: 'manufacturer_rebate_confirmation',
          status: 'pending_confirmation'
        }, transaction
      })
      : null;
    if (!waitingManualManufacturerRebate) {
      await createPendingSettlement({
      sourceType: 'SALE_USE', sourceId: change.change_id,
      sn: { sn_id: item.sn_id, sn_code: item.sn_code, product_id: item.product_id },
      resourceType, amount: settlementAmount,
      counterpartyId: right.supplier_id || null,
      counterpartyName: right.supplier_name || '',
      forceSettlement: resourceType === 'EDU_SUBSIDY',
      remark: `销售订单 ${order.order_no} 使用权益`, transaction
      });
    }
    if (resourceType === 'EDU_SUBSIDY' && settlementAmount > 0) {
      await createPerformanceProfitAdjustment({
        order, item, resourceType, amount: settlementAmount, ratio: 80, transaction
      });
    }
  }
}

// 销售归档仅冻结/核销SN资格；需要员工后续完成的事项以独立状态流水保存，
// 不能把“员工已操作”误作厂家返利到账或 Care 可用金余额。
async function createSaleResourceTasks(order, items, transaction) {
  for (const item of items) {
    if (!item.sn_id) continue;
    const archiveDate = order.archive_time || new Date();
    const archiveDay = new Date(new Date(archiveDate).getFullYear(), new Date(archiveDate).getMonth(), new Date(archiveDate).getDate());
    const manufacturerPolicy = await ManufacturerPriceHistory.findOne({
      where: { pn: item.pn_code, [Op.and]: [
        { effective_date: { [Op.lte]: archiveDay } },
        { [Op.or]: [{ expire_date: null }, { expire_date: { [Op.gte]: archiveDay } }] },
        { [Op.or]: [{ product_id: item.product_id }, { product_id: null }, { product_id: '' }] }
      ] }, order: [['effective_date', 'DESC'], ['created_at', 'DESC']], transaction
    });
    const otherPolicy = String(manufacturerPolicy?.other_policy || '').trim();
    if (otherPolicy) {
      const [right] = await InventoryResourceRight.findOrCreate({
        where: { sn_id: item.sn_id, resource_type: 'OTHER_POLICY' },
        defaults: { right_id: generateUUID(), sn_id: item.sn_id, sn_code: item.sn_code, product_id: item.product_id,
          resource_type: 'OTHER_POLICY', initial_status: 'AVAILABLE', current_status: 'AVAILABLE', amount: 0,
          source: 'MANUFACTURER_POLICY', remark: otherPolicy }, transaction
      });
      if (right.current_status !== 'USED') await right.update({ current_status: 'AVAILABLE', remark: otherPolicy, update_time: new Date() }, { transaction });
      const existingTask = await ResourceRightChangeOrder.findOne({
        where: { related_sale_order_id: order.order_id, sn_id: item.sn_id, resource_type: 'OTHER_POLICY', change_reason: 'SALE_RESOURCE_TASK' }, transaction
      });
      if (!existingTask) await ResourceRightChangeOrder.create({
        change_id: generateUUID(), change_order_no: businessNo('SRT'), sn_id: item.sn_id, sn_code: item.sn_code,
        product_id: item.product_id, resource_type: 'OTHER_POLICY', before_status: 'AVAILABLE', after_status: 'AVAILABLE',
        change_amount: 0, change_reason: 'SALE_RESOURCE_TASK', approval_status: 'pending_submit',
        related_sale_order_id: order.order_id, applicant_staff_id: order.create_staff_id || null,
        applicant_name: order.create_user || '', remark: otherPolicy
      }, { transaction });
    }
    for (const resourceType of selectedResources(item)) {
      if (!SALE_RESOURCE_TASK_TYPES.has(resourceType)) continue;
      const category = await ResourceCategory.findOne({ where: { category_code: resourceType, status: 1 }, transaction });
      if (!category) continue;
      const existing = await ResourceRightChangeOrder.findOne({
        where: { related_sale_order_id: order.order_id, sn_id: item.sn_id, resource_type: resourceType, change_reason: 'SALE_RESOURCE_TASK' },
        transaction
      });
      if (existing) continue;
      await ResourceRightChangeOrder.create({
        change_id: generateUUID(), change_order_no: businessNo('SRT'), sn_id: item.sn_id, sn_code: item.sn_code,
        product_id: item.product_id, resource_type: resourceType, before_status: 'USED', after_status: 'USED',
        change_amount: 0, change_reason: 'SALE_RESOURCE_TASK', approval_status: 'pending_submit',
        related_sale_order_id: order.order_id, applicant_staff_id: order.create_staff_id || null,
        applicant_name: order.create_user || '', remark: `销售订单 ${order.order_no} 的${category.name || resourceType}待完成`
      }, { transaction });
    }
  }
}

function resourceTaskLabel(resourceType) {
  return { EDU_SUBSIDY: '教育优惠返款', SALES_REPORT: '销售报号', SALES_RED_PACKET: '晒单激励', OTHER_POLICY: '其他政策待获取' }[resourceType] || resourceType;
}

async function assertSaleResourceTaskReadable(ctx, task, { review = false } = {}) {
  const order = await Order.findByPk(task.related_sale_order_id);
  if (!order) ctx.throw(404, '关联销售订单不存在');
  const user = ctx.state.user || {};
  const actorId = Number(user.staffId || 0);
  const manager = roles(user).some(role => ['boss', 'admin', 'manager', 'store_manager', 'store_admin'].includes(role));
  const stores = Array.isArray(user.accessibleStoreIds) ? user.accessibleStoreIds.map(String) : [];
  const storeAllowed = stores.includes('*') || stores.includes(String(order.store_id));
  if (review) {
    if (!manager || !storeAllowed) ctx.throw(403, '仅订单所属门店店长可审核晒单');
  } else if (Number(task.applicant_staff_id || order.create_staff_id || 0) !== actorId && !(manager && storeAllowed)) {
    ctx.throw(403, '无权操作该销售资源任务');
  }
  return order;
}

async function listSaleResourceTasks(ctx) {
  const orderId = String(ctx.query.orderId || '').trim();
  if (!orderId) ctx.throw(400, '请指定销售订单');
  const where = { change_reason: 'SALE_RESOURCE_TASK' };
  where.related_sale_order_id = orderId;
  const rows = await ResourceRightChangeOrder.findAll({ where, order: [['create_time', 'DESC']] });
  if (rows.length) await assertSaleResourceTaskReadable(ctx, rows[0]);
  ctx.body = rows.map(row => ({ ...row.toJSON(), resource_name: resourceTaskLabel(row.resource_type) }));
}

async function submitSaleResourceTask(ctx) {
  const attachments = parseJsonArray(ctx.request.body?.attachments || ctx.request.body?.attachmentUrls);
  const task = await ResourceRightChangeOrder.findByPk(ctx.params.changeId);
  if (!task || task.change_reason !== 'SALE_RESOURCE_TASK') ctx.throw(404, '销售资源任务不存在');
  await assertSaleResourceTaskReadable(ctx, task);
  if (!['pending_submit', 'rejected'].includes(task.approval_status)) ctx.throw(409, '该资源任务当前不能提交');
  const needsImageReview = [SHARE_INCENTIVE_TYPE, 'SALES_REPORT'].includes(task.resource_type);
  if (needsImageReview && attachments.length === 0) ctx.throw(400, '请至少上传一张证明图片');
  const nextStatus = needsImageReview ? 'pending_manager_review' : 'completed';
  await sequelize.transaction(async transaction => {
  await task.reload({ transaction, lock: transaction.LOCK.UPDATE });
  if (!['pending_submit', 'rejected'].includes(task.approval_status)) ctx.throw(409, '资源任务状态已变化');
  if (task.resource_type === 'OTHER_POLICY') {
    const right = await InventoryResourceRight.findOne({ where: { sn_id: task.sn_id, resource_type: 'OTHER_POLICY' }, transaction, lock: transaction.LOCK.UPDATE });
    if (right) await right.update({ current_status: 'USED', update_time: new Date(), version: Number(right.version || 0) + 1 }, { transaction });
  }
  await task.update({
    attachment_url: attachments.length ? JSON.stringify(attachments) : null,
    approval_status: nextStatus,
    applicant_staff_id: ctx.state.user.staffId || task.applicant_staff_id,
    applicant_name: ctx.state.user.name || task.applicant_name,
    review_comment: null,
    review_time: needsImageReview ? null : new Date(),
    reviewer_name: needsImageReview ? null : 'system',
    remark: `${resourceTaskLabel(task.resource_type)}${nextStatus === 'completed' ? '已完成确认' : '已提交，待店长审核'}`
  }, { transaction });
  });
  ctx.body = { message: nextStatus === 'completed' ? '资源事项已完成' : '图片已提交，等待店长审核' };
}

function normalizeCashRebateHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_\-\/\\（）()【】\[\]：:]+/g, '');
}

function cashRebateCell(row, indexes, aliases) {
  for (const alias of aliases) {
    const index = indexes.get(normalizeCashRebateHeader(alias));
    if (index !== undefined && row[index] !== undefined && row[index] !== null && String(row[index]).trim() !== '') return row[index];
  }
  return '';
}

function normalizeCashRebateDate(value, endOfDay = false) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function listSalesCashRebatePolicies(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance', 'manager']);
  const where = {};
  const pn = String(ctx.query.pn || '').trim();
  if (pn) where.pn_code = { [Op.like]: `%${pn}%` };
  const { count, rows } = await SalesCashRebatePolicy.findAndCountAll({
    where, order: [['update_time', 'DESC'], ['policy_id', 'DESC']],
    ...paginate({}, { page: ctx.query.page || 1, pageSize: ctx.query.pageSize || 20 })
  });
  ctx.body = formatPaginatedResult(rows, { page: ctx.query.page || 1, pageSize: ctx.query.pageSize || 20, count });
}

async function downloadSalesCashRebateTemplate(ctx) {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet([{ PN: '示例PN', 商品名称: '商品名称', 红包类型: '现金红包', 金额: 100, 供应商: '', 生效日期: '', 失效日期: '', 备注: '' }]);
  sheet['!cols'] = [{ wch: 22 }, { wch: 28 }, { wch: 18 }, { wch: 12 }, { wch: 24 }, { wch: 16 }, { wch: 16 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(workbook, sheet, '销售红包政策');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  ctx.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  ctx.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('商品销售红包模板.xlsx')}`);
  ctx.body = buffer;
}

async function syncSalesCashRebateStockRights(pnCode, productId, transaction) {
  const now = new Date();
  const sns = await ProductSn.findAll({
    where: { product_id: productId, status: 'in_stock', is_deleted: 0 },
    transaction, lock: transaction.LOCK.UPDATE
  });
  const policies = await SalesCashRebatePolicy.findAll({
    where: {
      product_id: productId, status: 1,
      [Op.and]: [
        { [Op.or]: [{ effective_start: null }, { effective_start: { [Op.lte]: now } }] },
        { [Op.or]: [{ effective_end: null }, { effective_end: { [Op.gte]: now } }] }
      ]
    },
    order: [['effective_start', 'DESC']], transaction
  });
  let affected = 0;
  for (const sn of sns) {
    const exactPnMatches = policies.filter(policy => String(policy.pn_code || '') === String(sn.pn_code || ''));
    const pnMatches = exactPnMatches.length
      ? exactPnMatches
      : policies.filter(policy => String(policy.pn_code || '') === String(pnCode));
    const matches = pnMatches.filter(policy => !policy.supplier_id || String(policy.supplier_id) === String(sn.supplier_id || ''))
      .sort((a, b) => Number(Boolean(b.supplier_id)) - Number(Boolean(a.supplier_id))
        || String(b.effective_start || '').localeCompare(String(a.effective_start || '')));
    const policy = matches[0];
    let right = await InventoryResourceRight.findOne({
      where: { sn_id: sn.sn_id, resource_type: 'SALES_CASH_REBATE' }, transaction, lock: transaction.LOCK.UPDATE
    });
    if (!policy && !right) continue;
    const values = {
      sn_code: sn.sn_code, product_id: sn.product_id,
      rule_config_id: policy?.policy_id || null,
      current_status: policy ? 'AVAILABLE' : 'NOT_APPLICABLE',
      amount: policy ? money(policy.amount) : 0,
      effective_start: policy?.effective_start || null, effective_end: policy?.effective_end || null,
      source: 'SALES_CASH_REBATE_POLICY_IMPORT',
      supplier_id: sn.supplier_id || policy?.supplier_id || null,
      supplier_name: sn.supplier_name || policy?.supplier_name || '',
      remark: policy ? `${policy.rebate_type || ''}${policy.remark ? ` / ${policy.remark}` : ''}` : '当前无生效的销售红包政策',
      version: Number(right?.version || 0) + 1, update_time: now
    };
    if (right) await right.update(values, { transaction });
    else {
      await InventoryResourceRight.create({
        right_id: generateUUID(), sn_id: sn.sn_id, resource_type: 'SALES_CASH_REBATE',
        initial_status: 'AVAILABLE', ...values
      }, { transaction });
    }
    affected += 1;
  }
  return affected;
}

async function importSalesCashRebatePolicies(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance', 'manager']);
  if (!ctx.file?.buffer) ctx.throw(400, '请上传销售红包政策Excel文件');
  const workbook = XLSX.read(ctx.file.buffer, { type: 'buffer', cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = sheet ? XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) : [];
  if (data.length < 2) ctx.throw(400, '模板中没有可导入的数据行');
  const headers = new Map(data[0].map((value, index) => [normalizeCashRebateHeader(value), index]));
  const results = [];
  for (let index = 1; index < data.length; index += 1) {
    const row = data[index];
    const pnCode = String(cashRebateCell(row, headers, ['PN', '商品PN', '厂商编码']) || '').trim();
    const rebateType = String(cashRebateCell(row, headers, ['红包类型', '类型']) || '').trim();
    const amount = money(cashRebateCell(row, headers, ['金额', '单件金额', '红包金额']));
    if (!pnCode && !rebateType && !amount) continue;
    try {
      if (!pnCode || !rebateType || amount <= 0) throw new Error('PN、红包类型和大于0的单件金额为必填项');
      const pn = await ProductPn.findOne({ where: { pn_code: pnCode, status: 1, is_deleted: 0 } });
      if (!pn) throw new Error(`未找到有效PN：${pnCode}`);
      const product = await Product.findByPk(pn.product_id);
      if (!product || product.is_deleted) throw new Error(`PN ${pnCode} 对应商品不存在或已停用`);
      const supplierText = String(cashRebateCell(row, headers, ['供应商', '供应商名称']) || '').trim();
      const supplier = supplierText
        ? await Supplier.findOne({ where: { [Op.or]: [{ supplier_id: supplierText }, { name: supplierText }], status: 1, is_deleted: 0 } })
        : null;
      if (supplierText && !supplier) throw new Error(`未找到供应商：${supplierText}`);
      const effectiveStart = normalizeCashRebateDate(cashRebateCell(row, headers, ['生效日期', '开始日期', '生效开始']));
      const effectiveEnd = normalizeCashRebateDate(cashRebateCell(row, headers, ['失效日期', '结束日期', '生效结束']));
      if (effectiveStart && effectiveEnd && effectiveStart > effectiveEnd) throw new Error('生效日期不能晚于失效日期');
      const remark = String(cashRebateCell(row, headers, ['备注']) || '').trim();
      const where = {
        pn_code: pnCode, rebate_type: rebateType,
        supplier_id: supplier?.supplier_id || null,
        effective_start: effectiveStart, effective_end: effectiveEnd
      };
      const values = {
        product_id: product.product_id, product_name: product.name, amount,
        supplier_name: supplier?.name || null, status: 1, remark,
        update_user: ctx.state.user.name || '', update_time: new Date()
      };
      let affectedInventory = 0;
      await sequelize.transaction(async transaction => {
        const existing = await SalesCashRebatePolicy.findOne({ where, transaction, lock: transaction.LOCK.UPDATE });
        if (existing) await existing.update(values, { transaction });
        else await SalesCashRebatePolicy.create({ policy_id: generateUUID(), ...where, ...values, create_user: ctx.state.user.name || '' }, { transaction });
        affectedInventory = await syncSalesCashRebateStockRights(pnCode, product.product_id, transaction);
      });
      results.push({ row: index + 1, pn: pnCode, status: 'success', affectedInventory });
    } catch (error) {
      results.push({ row: index + 1, pn: pnCode, status: 'failed', message: error.message });
    }
  }
  const success = results.filter(item => item.status === 'success').length;
  ctx.body = { message: `销售红包政策导入完成：成功 ${success} 条，失败 ${results.length - success} 条`, success, failed: results.length - success, rows: results };
}

async function findEligibleSalesCashRebateItems(ctx, transaction = null) {
  const where = [
    'o.IS_DELETED = 0',
    "o.ORDER_STATUS IN ('已归档', 'completed', 'archived')",
    'COALESCE(o.ARCHIVE_TIME, o.UPDATE_TIME, o.CREATE_TIME) IS NOT NULL',
    'oi.SN_ID IS NOT NULL',
    'pol.STATUS = 1'
  ];
  const replacements = {};
  const pn = String(ctx.query.pn || '').trim();
  const snCode = String(ctx.query.snCode || '').trim();
  if (pn) { where.push('(oi.PN_CODE LIKE :pn OR sn.PN_CODE LIKE :pn)'); replacements.pn = `%${pn}%`; }
  if (snCode) { where.push('COALESCE(oi.SN_CODE, sn.SN_CODE) LIKE :snCode'); replacements.snCode = `%${snCode}%`; }
  const accessible = Array.isArray(ctx.state.user?.accessibleStoreIds) ? ctx.state.user.accessibleStoreIds.map(String) : [];
  if (!accessible.includes('*')) {
    if (accessible.length) { where.push('o.STORE_ID IN (:storeIds)'); replacements.storeIds = accessible; }
    else where.push('1 = 0');
  }
  const rows = await sequelize.query(
    `SELECT oi.ITEM_ID AS orderItemId, o.ORDER_ID AS orderId, o.ORDER_NO AS orderNo,
            o.STORE_ID AS storeId, COALESCE(o.ARCHIVE_TIME, o.UPDATE_TIME, o.CREATE_TIME) AS archiveTime,
            oi.SN_ID AS snId, COALESCE(oi.SN_CODE, sn.SN_CODE) AS snCode,
            oi.PRODUCT_ID AS productId, COALESCE(p.NAME, oi.PRODUCT_NAME) AS productName,
            COALESCE(NULLIF(oi.PN_CODE, ''), sn.PN_CODE) AS pnCode,
            COALESCE(NULLIF(oi.SUPPLIER_ID, ''), NULLIF(sn.SUPPLIER_ID, '')) AS supplierId,
            COALESCE(NULLIF(oi.SUPPLIER_NAME, ''), NULLIF(sn.SUPPLIER_NAME, '')) AS supplierName,
            pol.POLICY_ID AS policyId, pol.REBATE_TYPE AS rebateType, pol.AMOUNT AS amount,
            pol.SUPPLIER_ID AS policySupplierId, pol.EFFECTIVE_START AS effectiveStart, pol.EFFECTIVE_END AS effectiveEnd
       FROM T_ORDER o
       INNER JOIN T_ORDER_ITEM oi ON oi.ORDER_ID = o.ORDER_ID
       LEFT JOIN T_PRODUCT_SN sn ON sn.SN_ID = oi.SN_ID
       LEFT JOIN T_PRODUCT p ON p.PRODUCT_ID = oi.PRODUCT_ID
       INNER JOIN T_SALES_CASH_REBATE_POLICY pol
         ON pol.PN_CODE = COALESCE(NULLIF(oi.PN_CODE, ''), sn.PN_CODE)
        AND (pol.SUPPLIER_ID IS NULL OR pol.SUPPLIER_ID = '' OR pol.SUPPLIER_ID = COALESCE(NULLIF(oi.SUPPLIER_ID, ''), NULLIF(sn.SUPPLIER_ID, '')))
        AND (pol.EFFECTIVE_START IS NULL OR DATE(COALESCE(o.ARCHIVE_TIME, o.UPDATE_TIME, o.CREATE_TIME)) >= pol.EFFECTIVE_START)
        AND (pol.EFFECTIVE_END IS NULL OR DATE(COALESCE(o.ARCHIVE_TIME, o.UPDATE_TIME, o.CREATE_TIME)) <= pol.EFFECTIVE_END)
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(o.ARCHIVE_TIME, o.UPDATE_TIME, o.CREATE_TIME) DESC, oi.ITEM_ID DESC
      LIMIT 10000`,
    { replacements, type: sequelize.QueryTypes.SELECT, transaction }
  );
  const claimRows = await SalesCashRebateClaim.findAll({ where: { status: { [Op.in]: ['pending_finance', 'approved'] } }, attributes: ['claim_id'], transaction });
  const activeClaimIds = claimRows.map(row => row.claim_id);
  const claimedItems = activeClaimIds.length
    ? await SalesCashRebateClaimItem.findAll({ where: { claim_id: { [Op.in]: activeClaimIds } }, attributes: ['order_item_id'], transaction })
    : [];
  const claimed = new Set(claimedItems.map(row => String(row.order_item_id)));
  const grouped = new Map();
  for (const row of rows) {
    const key = String(row.orderItemId);
    const choices = grouped.get(key) || [];
    choices.push(row);
    grouped.set(key, choices);
  }
  return [...grouped.values()].map(choices => choices.sort((a, b) => {
    const specificity = Number(Boolean(b.policySupplierId)) - Number(Boolean(a.policySupplierId));
    if (specificity) return specificity;
    return String(b.effectiveStart || '').localeCompare(String(a.effectiveStart || ''));
  })[0]).filter(row => !claimed.has(String(row.orderItemId)) && Number(row.amount) > 0 && row.supplierId);
}

async function listEligibleSalesCashRebateItems(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance', 'manager']);
  const items = await findEligibleSalesCashRebateItems(ctx);
  const page = Math.max(1, Number(ctx.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(ctx.query.pageSize) || 20));
  ctx.body = { code: 0, data: { list: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize } };
}

async function createSalesCashRebateClaim(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance', 'manager']);
  const requested = Array.isArray(ctx.request.body?.items) ? ctx.request.body.items : [];
  const itemIds = [...new Set(requested.map(item => String(item.orderItemId || '')).filter(Boolean))];
  if (!itemIds.length) ctx.throw(400, '请先选择符合条件的已售商品');
  if (!ctx.state.user?.staffId) ctx.throw(401, '当前账号缺少员工身份，无法提交套回审批');
  const result = await sequelize.transaction(async transaction => {
    const eligible = await findEligibleSalesCashRebateItems(ctx, transaction);
    const selected = eligible.filter(row => itemIds.includes(String(row.orderItemId)));
    if (selected.length !== itemIds.length) ctx.throw(409, '部分商品已不符合套回条件，请刷新后重新选择');
    const suppliers = new Set(selected.map(row => String(row.supplierId || '')));
    const rebateTypes = new Set(selected.map(row => String(row.rebateType || '')));
    if (suppliers.size !== 1 || rebateTypes.size !== 1) ctx.throw(400, '同一张套回单请只选择同一供应商、同一红包类型的商品');
    const first = selected[0];
    const totalAmount = money(selected.reduce((sum, row) => sum + money(row.amount), 0));
    const claim = await SalesCashRebateClaim.create({
      claim_id: generateUUID(), claim_no: businessNo('CRB'), supplier_id: first.supplierId,
      supplier_name: first.supplierName || '', rebate_type: first.rebateType,
      total_amount: totalAmount, item_count: selected.length,
      distributor_id: ctx.state.user.distributorId || null,
      applicant_staff_id: ctx.state.user.staffId, applicant_name: ctx.state.user.name || ctx.state.user.phone || '',
      status: 'pending_finance', remark: String(ctx.request.body?.remark || '').trim()
    }, { transaction });
    await SalesCashRebateClaimItem.bulkCreate(selected.map(row => ({
      claim_item_id: generateUUID(), claim_id: claim.claim_id, policy_id: row.policyId,
      order_id: row.orderId, order_no: row.orderNo, order_item_id: row.orderItemId,
      sn_id: row.snId, sn_code: row.snCode, product_id: row.productId, product_name: row.productName,
      pn_code: row.pnCode, store_id: row.storeId, supplier_id: row.supplierId,
      supplier_name: row.supplierName || '', rebate_type: row.rebateType, amount: money(row.amount)
    })), { transaction });
    await require('../approval/businessRuntime').begin('sales_cash_rebate_claim', claim, transaction);
    return { claimNo: claim.claim_no, itemCount: selected.length, totalAmount };
  });
  ctx.body = { code: 0, data: result, message: '销售红包套回单已提交审批' };
}

async function listSalesCashRebateClaims(ctx) {
  requireAnyRole(ctx, ['boss', 'admin', 'finance', 'manager']);
  const where = {};
  if (ctx.query.status) where.status = ctx.query.status;
  const { count, rows } = await SalesCashRebateClaim.findAndCountAll({
    where, order: [['create_time', 'DESC']],
    ...paginate({}, { page: ctx.query.page || 1, pageSize: ctx.query.pageSize || 20 })
  });
  const items = rows.length ? await SalesCashRebateClaimItem.findAll({ where: { claim_id: { [Op.in]: rows.map(row => row.claim_id) } }, order: [['create_time', 'ASC']] }) : [];
  const itemsByClaim = new Map();
  for (const item of items) {
    const list = itemsByClaim.get(item.claim_id) || [];
    list.push(item);
    itemsByClaim.set(item.claim_id, list);
  }
  const list = rows.map(row => ({ ...row.toJSON(), items: itemsByClaim.get(row.claim_id) || [] }));
  ctx.body = formatPaginatedResult(list, { page: ctx.query.page || 1, pageSize: ctx.query.pageSize || 20, count });
}

async function reviewSalesCashRebateClaim(ctx) {
  const action = String(ctx.request.body?.action || '');
  const comment = String(ctx.request.body?.comment || '').trim();
  if (!['approve', 'reject'].includes(action)) ctx.throw(400, '审批操作无效');
  await sequelize.transaction(async transaction => {
    const claim = await SalesCashRebateClaim.findByPk(ctx.params.claimId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!claim) ctx.throw(404, '销售红包套回单不存在');
    if (!await require('../approval/businessRuntime').advance(ctx, 'sales_cash_rebate_claim', claim, transaction, action, comment)) return;
    const now = new Date();
    await claim.update({
      status: action === 'approve' ? 'approved' : 'rejected',
      reviewer_staff_id: ctx.state.user.staffId || null, reviewer_name: ctx.state.user.name || '',
      review_comment: comment, review_time: now, update_time: now
    }, { transaction });
    if (action !== 'approve') return;
    const items = await SalesCashRebateClaimItem.findAll({ where: { claim_id: claim.claim_id }, transaction, lock: transaction.LOCK.UPDATE });
    for (const item of items) {
      const settlement = await createPendingSettlement({
        sourceType: 'CASH_RED_PACKET', sourceId: item.claim_item_id,
        sn: { sn_id: item.sn_id, sn_code: item.sn_code, product_id: item.product_id },
        resourceType: 'SALES_CASH_REBATE', amount: item.amount,
        counterpartyId: item.supplier_id, counterpartyName: item.supplier_name || '', forceSettlement: true,
        remark: `${claim.claim_no} ${item.order_no} ${item.rebate_type}`, transaction
      });
      await item.update({ resource_settlement_id: settlement?.settlement_id || null }, { transaction });
    }
  });
  if (ctx.state.businessApproval?.status === 'pending') return;
  ctx.body = { code: 0, message: action === 'approve' ? '销售红包套回审批通过，已进入待收款列表' : '销售红包套回申请已拒绝' };
}

async function completeOtherPolicyResource(ctx) {
  await sequelize.transaction(async transaction => {
    const right = await InventoryResourceRight.findOne({ where: { sn_id: ctx.params.snId, resource_type: 'OTHER_POLICY' }, transaction, lock: transaction.LOCK.UPDATE });
    if (!right) ctx.throw(404, '没有待获取的其他政策资源');
    if (right.current_status === 'USED') return;
    const task = await ResourceRightChangeOrder.findOne({
      where: { sn_id: right.sn_id, resource_type: 'OTHER_POLICY', change_reason: 'SALE_RESOURCE_TASK' },
      order: [['create_time', 'DESC']], transaction
    });
    if (!task) ctx.throw(404, '没有待完成的其他政策任务');
    await assertSaleResourceTaskReadable(ctx, task);
    await right.update({ current_status: 'USED', update_time: new Date(), version: Number(right.version || 0) + 1 }, { transaction });
    await ResourceRightChangeOrder.update({ approval_status: 'completed', after_status: 'USED', reviewer_name: ctx.state.user.name || 'system', review_time: new Date() }, {
      where: { sn_id: right.sn_id, resource_type: 'OTHER_POLICY', change_reason: 'SALE_RESOURCE_TASK', approval_status: { [Op.in]: ['pending_submit', 'rejected'] } }, transaction
    });
  });
  ctx.body = { message: '其他政策已标记完成' };
}

async function reviewSaleResourceTask(ctx) {
  const approved = ctx.request.body?.approved === true || ctx.request.body?.action === 'approve';
  const comment = String(ctx.request.body?.comment || '').trim();
  await sequelize.transaction(async transaction => {
    const task = await ResourceRightChangeOrder.findByPk(ctx.params.changeId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!task || task.change_reason !== 'SALE_RESOURCE_TASK' || ![SHARE_INCENTIVE_TYPE, 'SALES_REPORT'].includes(task.resource_type)) ctx.throw(404, '待审核资源任务不存在');
    if (task.approval_status !== 'pending_manager_review') ctx.throw(409, '资源任务状态已变化');
    if (task.resource_type === 'SALES_REPORT') {
      const order = await assertSaleResourceTaskReadable(ctx, task, { review: true });
      if (!['已归档', 'completed', 'archived'].includes(String(order.order_status || ''))) ctx.throw(409, '订单未归档或正在退货，不能发放报号奖励');
      if (!parseJsonArray(task.attachment_url).length) ctx.throw(409, '报号任务缺少证明图片');
      if (approved) {
        const item = await OrderItem.findOne({ where: { order_id: order.order_id, sn_id: task.sn_id }, transaction });
        await require('../sales/staffCareCredit').creditSalesReport({ task, order, item, transaction });
      }
    } else if (!await require('../approval/businessRuntime').advance(ctx, 'sale_share', task, transaction, approved ? 'approve' : 'reject', comment)) return;
    await task.update({
      approval_status: approved ? 'completed' : 'rejected', reviewer_staff_id: ctx.state.user.staffId,
      reviewer_name: ctx.state.user.name || ctx.state.user.phone || '', review_comment: comment || null, review_time: new Date(),
      remark: approved
        ? (task.resource_type === 'SALES_REPORT' ? '销售报号已审核完成；CARE可用金已入账' : '晒单已审核完成；礼品或红包通过体外流程发放')
        : `${resourceTaskLabel(task.resource_type)}被拒绝：${comment}`
    }, { transaction });
  });
  if (ctx.state.businessApproval?.status === 'pending') return;
  ctx.body = { message: approved ? '资源任务已审核完成' : '图片已退回，可补图后重新提交' };
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
  listRights, exportRights, snRights, saveSnRights, batchAdjustRights, importBatchRights, importEducationPolicies, supplementEducationResource, batchRefreshRights, reverseSaleUseResource, submitClaim, reviewClaim, listChanges, listCostConfigs, listCostAdjustments, saveCostConfig,
  listResourceCategories, saveResourceCategory, deleteResourceCategory,
  listGoodsTypes, saveGoodsType, deleteGoodsType,
  listNbPolicies, importNbPolicy,
  listResourceSettlements, createManualRebateSettlement, settleResource, batchSettleRebateResources, linkRebateSettlement,
  cancelResourceSettlement, reverseResourceSettlement, createPendingSettlement,
  findResourceRule, calculatePreSaleRuleAmount,
  initializeSnResourceRightsFromInbound, triggerSaleResourceBenefits, createSaleResourceTasks,
  listSaleResourceTasks, submitSaleResourceTask, reviewSaleResourceTask, completeOtherPolicyResource,
  listSalesCashRebatePolicies, downloadSalesCashRebateTemplate, importSalesCashRebatePolicies,
  listEligibleSalesCashRebateItems, createSalesCashRebateClaim, listSalesCashRebateClaims, reviewSalesCashRebateClaim,
  alignOrderSubsidyRights, isGovSubsidyEligibleCategory, lockSaleRights, finishSaleRights, releaseSaleRights,
  _test: { normalizeImportRows, normalizeImportStatus, normalizeImportResourceTypes, educationHeaderIndexes, parseEducationDate, parseEducationAmount, extractEducationPolicies, chooseEducationPolicy }
};
