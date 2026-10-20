// Reward matching is separate from SN eligibility and never changes inventory cost.
function fail(message) { throw Object.assign(new Error(message), { status: 400 }); }
function configObject(value) {
  if (!value) return {};
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('权益规则配置格式无效');
  return parsed;
}
function day(value) {
  if (!value) return '';
  const text = String(value);
  const date = new Date(`${text}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) fail('规则日期无效');
  return text;
}
function validateRules(input, categories) {
  if (!Array.isArray(input) || input.length > 500) fail('奖励规则最多500条');
  const categoryIds = new Set(categories.map(row => String(row.category_id)));
  const ids = new Set();
  const rules = input.map((row, index) => {
    if (!row || typeof row !== 'object') fail('奖励规则格式无效');
    const id = String(row.id || `rule-${index + 1}`).trim();
    if (!id || id.length > 64 || ids.has(id)) fail('奖励规则编号重复或无效');
    ids.add(id);
    const scope = row.scope;
    if (!['PN', 'CATEGORY'].includes(scope)) fail('匹配范围仅允许PN或商品类别');
    const pnCode = String(row.pnCode || '').trim().toUpperCase();
    const categoryId = String(row.categoryId || '');
    if (scope === 'PN' && (!pnCode || pnCode.length > 128)) fail('请输入有效PN');
    if (scope === 'CATEGORY' && !categoryIds.has(categoryId)) fail('请选择有效商品类别');
    if (row.amount === '' || row.amount == null || !Number.isFinite(Number(row.amount)) || Number(row.amount) < 0 || Number(row.amount) > 1000000 || Math.abs(Number(row.amount) * 100 - Math.round(Number(row.amount) * 100)) > 0.000001) fail('奖励金额须为0至100万元，最多两位小数');
    const start = day(row.start), end = day(row.end);
    if (start && end && start > end) fail('结束日期不能早于开始日期');
    return { id, name: String(row.name || '').trim().slice(0, 100), scope,
      pnCode: scope === 'PN' ? pnCode : '', categoryId: scope === 'CATEGORY' ? categoryId : '',
      includeDescendants: row.includeDescendants !== false, amount: Number(row.amount), start, end, enabled: row.enabled !== false };
  });
  for (let i = 0; i < rules.length; i++) for (let j = i + 1; j < rules.length; j++) {
    const a = rules[i], b = rules[j];
    if (a.enabled && b.enabled && a.scope === b.scope && (a.scope === 'PN' ? a.pnCode === b.pnCode : a.categoryId === b.categoryId)
      && (a.start || '0000') <= (b.end || '9999') && (b.start || '0000') <= (a.end || '9999')) fail('同一PN或类别的启用规则日期不能重叠');
  }
  return rules;
}
function defaultRules(categories) {
  return categories.filter(row => row.name === '笔记本' && !row.parent_id && Number(row.status) === 1).map(row => ({
    id: `default-${row.category_id}`, name: '笔记本销量报号', scope: 'CATEGORY', categoryId: String(row.category_id),
    pnCode: '', includeDescendants: true, amount: 160, start: '', end: '', enabled: true
  }));
}
function configuredRules(config, categories) {
  const parsed = configObject(config);
  return Object.hasOwn(parsed, 'rewardRules') ? parsed.rewardRules : defaultRules(categories);
}
function resolveCategoryId(product, categories) {
  if (product?.category_id) return String(product.category_id);
  // Legacy paths match category names exactly, never guess from product names.
  const parts = String(product?.category_path_legacy || product?.category || '').split(/[\\/>]+/).map(value => value.trim()).filter(Boolean);
  let parent = '', matched = '';
  for (const name of parts) {
    const candidates = categories.filter(row => String(row.parent_id || '') === parent && row.name === name);
    if (candidates.length !== 1) break;
    matched = String(candidates[0].category_id); parent = matched;
  }
  return matched;
}
function matchRule(rules, { pnCode, categoryId, at }, categories) {
  const byId = new Map(categories.map(row => [String(row.category_id), row]));
  const ancestry = [], seen = new Set();
  let current = String(categoryId || '');
  while (current && !seen.has(current)) { seen.add(current); ancestry.push(current); current = String(byId.get(current)?.parent_id || ''); }
  const date = at || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  return rules.filter(rule => rule.enabled !== false && (!rule.start || rule.start <= date) && (!rule.end || rule.end >= date))
    .map(rule => ({ rule, rank: rule.scope === 'PN'
      ? (String(pnCode || '').trim().toUpperCase() === rule.pnCode ? -1 : Infinity)
      : (ancestry.includes(String(rule.categoryId)) && (rule.includeDescendants !== false || ancestry[0] === String(rule.categoryId)) ? ancestry.indexOf(String(rule.categoryId)) : Infinity) }))
    .filter(row => Number.isFinite(row.rank)).sort((a, b) => a.rank - b.rank || String(a.rule.id).localeCompare(String(b.rule.id)))[0]?.rule || null;
}
function rewardAmount(snapshot, legacyAmount = 160) {
  if (snapshot == null || snapshot === '') return legacyAmount;
  const parsed = configObject(snapshot);
  if (parsed.version !== 1 || !Number.isFinite(parsed.amount) || parsed.amount < 0) throw Object.assign(new Error('奖励快照无效，请核查销售资源任务'), { status: 409 });
  return parsed.amount;
}
module.exports = { configObject, validateRules, defaultRules, configuredRules, resolveCategoryId, matchRule, rewardAmount };
