const { sequelize, ResourceCategory, ProductCategory, Product, InventoryResourceRight, ProductResourceCostConfig } = require('../../models');
const { recordBusinessAction } = require('../../utils/businessActionLog');
const { configObject, configuredRules, validateRules, resolveCategoryId, matchRule } = require('./rewardRules');

async function listRewardRules(ctx) {
  const resourceType = rewardType(ctx.query?.resourceType);
  const [resource, categories] = await Promise.all([
    ResourceCategory.findOne({ where: { category_code: resourceType } }),
    ProductCategory.findAll({ raw: true })
  ]);
  if (!resource) ctx.throw(404, '销量报号权益类型不存在');
  const config = configObject(resource.rule_config_json);
  ctx.body = { rules: rulesFor(resourceType, config, categories), revision: Number(config.rewardRevision || 0),
    categories: categories.filter(row => Number(row.status) === 1), usingDefault: resourceType === 'SALES_REPORT' && !Object.hasOwn(config, 'rewardRules') };
}
function rewardType(value) {
  const type = value || 'SALES_REPORT';
  if (!['SALES_REPORT', 'EDU_SUBSIDY'].includes(type)) throw Object.assign(new Error('不支持的权益奖励类型'), { status: 400 });
  return type;
}
function rulesFor(type, config, categories) {
  const parsed = configObject(config);
  return type === 'EDU_SUBSIDY' ? (parsed.rewardRules || []) : configuredRules(parsed, categories);
}
async function saveRewardRules(ctx) {
  const user = ctx.state.user || {};
  const roles = Array.isArray(user.roles) && user.roles.length ? user.roles : String(user.roleCode || '').split(',').map(value => value.trim());
  if (!roles.some(role => ['boss', 'admin'].includes(role))) ctx.throw(403, '仅管理员可配置权益奖励规则');
  const body = ctx.request.body || {};
  const resourceType = rewardType(body.resourceType);
  await sequelize.transaction(async transaction => {
    const resource = await ResourceCategory.findOne({ where: { category_code: resourceType }, transaction, lock: transaction.LOCK.UPDATE });
    if (!resource) ctx.throw(404, '销量报号权益类型不存在');
    const config = configObject(resource.rule_config_json);
    const revision = Number(config.rewardRevision || 0);
    if (body.revision !== revision) ctx.throw(409, '规则已被其他人修改，请刷新后重试');
    const categories = await ProductCategory.findAll({ raw: true, transaction });
    const rules = validateRules(body.rules, categories.filter(row => Number(row.status) === 1));
    await resource.update({ rule_config_json: JSON.stringify({ ...config, rewardRules: rules, rewardRevision: revision + 1 }), update_time: new Date() }, { transaction });
    await recordBusinessAction({ businessType: 'resource_reward_rule', businessId: resource.category_id,
      action: 'update', user, comment: '修改教育补贴或销量报号权益规则，仅影响后续归档任务',
      detail: { resourceType, before: rulesFor(resourceType, config, categories), after: rules }, transaction });
    ctx.body = { message: '奖励规则已保存，仅影响后续归档任务', revision: revision + 1 };
  });
}
async function freezeSalesReportReward({ category, item, order, transaction }) {
  // finishSaleRights already validates and consumes the selected SN's locked eligibility.
  const [product, categories] = await Promise.all([
    Product.findByPk(item.product_id, { transaction }), ProductCategory.findAll({ raw: true, transaction })
  ]);
  const at = new Date(order.archive_time || new Date()).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const categoryId = resolveCategoryId(product, categories);
  const type = category.category_code || 'SALES_REPORT';
  const rule = matchRule(rulesFor(type, category.rule_config_json, categories), { pnCode: item.pn_code, categoryId, at }, categories);
  let amount = rule ? Number(rule.amount) : 0;
  let policy = null;
  if (type === 'EDU_SUBSIDY' && !rule && item.sn_id) {
    const right = await InventoryResourceRight.findOne({ where: { sn_id: item.sn_id, resource_type: type }, transaction });
    if (right?.rule_config_id && right.source === 'EDUCATION_POLICY_IMPORT') {
      const config = await ProductResourceCostConfig.findOne({ where: { config_id: right.rule_config_id,
        product_id: item.product_id, resource_type: type, status: 1 }, transaction });
      const instant = new Date(order.archive_time || new Date()).getTime();
      if (config && (!right.effective_start || new Date(right.effective_start).getTime() <= instant)
        && (!right.effective_end || new Date(right.effective_end).getTime() >= instant)
        && Number(right.amount) > 0) {
        amount = Number(right.amount);
        policy = { configId: config.config_id, rightId: right.right_id, source: right.source };
      }
    }
  }
  if (type === 'EDU_SUBSIDY' && !(amount > 0)) throw Object.assign(new Error('教育补贴未配置有效金额，请维护权益规则或有效教育优惠政策，不能生成零金额待办'), { status: 409 });
  const employeeAmount = Math.round(amount * 80) / 100;
  return JSON.stringify({ version: 1, resourceType: type, amount,
    ...(type === 'EDU_SUBSIDY' ? { accountingVersion: 2, employeeAmount, productAmount: Math.round((amount - employeeAmount) * 100) / 100, orderItemId: item.item_id } : {}),
    rule: rule || null, policy, pnCode: item.pn_code, categoryId: categoryId || null, at,
    reason: rule ? 'matched' : policy ? 'education_policy_import' : 'no_matching_rule' });
}
module.exports = { listRewardRules, saveRewardRules, freezeSalesReportReward };
