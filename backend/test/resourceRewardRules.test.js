const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRules, configuredRules, matchRule, resolveCategoryId, rewardAmount } = require('../src/modules/inventory/rewardRules');
const categories = [
  { category_id: 'laptop', parent_id: null, name: '笔记本', status: 1 },
  { category_id: 'gaming', parent_id: 'laptop', name: '游戏本', status: 1 },
  { category_id: 'desktop', parent_id: null, name: '台机', status: 1 }
];
const base = { id: 'root', scope: 'CATEGORY', categoryId: 'laptop', amount: 160 };
const choose = (rules, props = {}) => matchRule(validateRules(rules, categories), { categoryId: 'gaming', pnCode: 'PN1', at: '2026-10-20', ...props }, categories);
test('PN overrides closest category; one reward only, including explicit zero exclusion', () => {
  const child = { ...base, id: 'child', categoryId: 'gaming', amount: 180 };
  assert.equal(choose([base, child]).amount, 180);
  assert.equal(choose([base, child, { id: 'pn', scope: 'PN', pnCode: 'pn1', amount: 0 }]).amount, 0);
  assert.equal(choose([base], { categoryId: 'desktop' }), null);
  assert.equal(choose([{ ...base, includeDescendants: false }]), null);
});
test('effective dates are inclusive and overlapping same-target rules are rejected', () => {
  const rules = [{ ...base, start: '2026-10-01', end: '2026-10-20' }];
  assert.equal(choose(rules).amount, 160);
  assert.equal(choose(rules, { at: '2026-10-21' }), null);
  assert.throws(() => validateRules([base, { ...base, id: 'second' }], categories), /重叠/);
  assert.doesNotThrow(() => validateRules([{ ...base, end: '2026-10-19' }, { ...base, id: 'next', start: '2026-10-20' }], categories));
});
test('reject invalid money, dates, categories and duplicate ids', () => {
  for (const amount of [-1, NaN, '', null, 1.001, 1000001]) assert.throws(() => choose([{ ...base, amount }]), /金额/);
  for (const start of ['2026-02-30', '2026-13-01', 'bad']) assert.throws(() => choose([{ ...base, start }]), /日期/);
  assert.throws(() => choose([{ ...base, categoryId: 'missing' }]), /类别/);
  assert.throws(() => choose([base, base]), /编号/);
});
test('default covers only notebooks and empty configuration disables all future rewards', () => {
  const defaults = configuredRules(null, categories);
  assert.equal(choose(defaults).amount, 160);
  assert.equal(choose(defaults, { categoryId: 'desktop' }), null);
  assert.deepEqual(configuredRules({ rewardRules: [] }, categories), []);
  assert.equal(resolveCategoryId({ category: '笔记本/游戏本' }, categories), 'gaming');
  assert.equal(resolveCategoryId({ name: '笔记本' }, categories), '');
});
test('frozen amount survives future changes; legacy tasks keep original reward; invalid snapshots fail closed', () => {
  const rule = choose([base]);
  const snapshot = JSON.stringify({ version: 1, amount: rule.amount, rule });
  rule.amount = 999;
  assert.equal(rewardAmount(snapshot), 160);
  assert.equal(rewardAmount(null), 160);
  assert.equal(rewardAmount(JSON.stringify({ version: 1, amount: 0 })), 0);
  assert.throws(() => rewardAmount('{"amount":999}'), /快照/);
});

const models = require('../src/models');
const { freezeSalesReportReward, saveRewardRules } = require('../src/modules/inventory/rewardConfig');
const { creditSalesReport, reverseForSalesReturn } = require('../src/modules/sales/staffCareCredit');
test('archive snapshot feeds actual approval amount and repeated review creates only one ledger entry', async () => {
  const originals = { product: models.Product.findByPk, categories: models.ProductCategory.findAll,
    staff: models.Staff.findByPk, find: models.StaffCareCreditTransaction.findOne,
    all: models.StaffCareCreditTransaction.findAll, create: models.StaffCareCreditTransaction.create };
  try {
    models.Product.findByPk = async () => ({ category_id: 'gaming' });
    models.ProductCategory.findAll = async () => categories;
    models.Staff.findByPk = async () => ({ staff_id: 1, name: 'sales' });
    let entry = null, count = 0;
    models.StaffCareCreditTransaction.findOne = async () => entry;
    models.StaffCareCreditTransaction.findAll = async () => [];
    models.StaffCareCreditTransaction.create = async values => { count++; entry = values; return values; };
    const category = { rule_config_json: JSON.stringify({ rewardRules: validateRules([{ ...base, amount: 220 }], categories) }) };
    const item = { item_id: 1, product_id: 'p', sn_id: 's', pn_code: 'PN1', use_sales_report: 1 };
    const order = { order_id: 'o', create_staff_id: 1, archive_time: '2026-10-20T00:00:00+08:00' };
    const snapshot = await freezeSalesReportReward({ category, item, order, transaction: {} });
    category.rule_config_json = JSON.stringify({ rewardRules: [] });
    const task = { change_id: 't', sn_id: 's', reward_snapshot_json: snapshot };
    const transaction = { LOCK: { UPDATE: 'UPDATE' } };
    await creditSalesReport({ task, item, order, transaction });
    await creditSalesReport({ task, item, order, transaction });
    assert.equal(count, 1); assert.equal(entry.amount, 220);
    await assert.rejects(creditSalesReport({ task, item: { ...item, use_sales_report: 0 }, order, transaction }), /资格/);
    task.reward_snapshot_json = await freezeSalesReportReward({ category, item, order, transaction });
    assert.equal(await creditSalesReport({ task, item, order, transaction }), null);
    assert.equal(count, 1);
  } finally {
    models.Product.findByPk = originals.product; models.ProductCategory.findAll = originals.categories;
    models.Staff.findByPk = originals.staff; models.StaffCareCreditTransaction.findOne = originals.find;
    models.StaffCareCreditTransaction.findAll = originals.all; models.StaffCareCreditTransaction.create = originals.create;
  }
});
test('rule updates require admin role before accessing database', async () => {
  const ctx = { state: { user: { roles: ['clerk'] } }, throw(status, message) { throw Object.assign(new Error(message), { status }); } };
  await assert.rejects(saveRewardRules(ctx), error => error.status === 403);
});
test('saving rules preserves other resource config, audits changes and rejects stale revisions', async t => {
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const logs = [], writes = [];
  const resource = { category_id: 'report', rule_config_json: JSON.stringify({ otherSetting: 99, rewardRevision: 2, rewardRules: [] }),
    async update(values, options) { assert.equal(options.transaction, transaction); writes.push(values); Object.assign(this, values); } };
  t.mock.method(models.sequelize, 'transaction', async fn => fn(transaction));
  t.mock.method(models.ResourceCategory, 'findOne', async options => { assert.equal(options.lock, 'UPDATE'); return resource; });
  t.mock.method(models.ProductCategory, 'findAll', async () => categories);
  t.mock.method(models.BusinessActionLog, 'create', async (values, options) => { assert.equal(options.transaction, transaction); logs.push(values); });
  const ctx = { state: { user: { roleCode: 'admin', staffId: 1 } }, request: { body: { revision: 2, rules: [base] } },
    throw(status, message) { throw Object.assign(new Error(message), { status }); } };
  await saveRewardRules(ctx);
  const saved = JSON.parse(resource.rule_config_json);
  assert.equal(saved.otherSetting, 99); assert.equal(saved.rewardRevision, 3); assert.equal(saved.rewardRules[0].amount, 160);
  assert.equal(logs.length, 1); assert.equal(JSON.parse(logs[0].detail_json).after[0].amount, 160);
  await assert.rejects(saveRewardRules(ctx), error => error.status === 409);
  assert.equal(writes.length, 1);
});
test('sales return reverses actual awarded amount once, independent of changed reward rules', async t => {
  t.mock.method(models.ResourceRightChangeOrder, 'findAll', async () => []);
  const entries = [], transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const original = { amount: 220 };
  t.mock.method(models.Staff, 'findByPk', async () => ({ name: 'sales' }));
  t.mock.method(models.ResourceRightChangeOrder, 'update', async () => [1]);
  t.mock.method(models.StaffCareCreditTransaction, 'findAll', async () => []);
  t.mock.method(models.StaffCareCreditTransaction, 'findOne', async ({ where }) => {
    if (where.source_type === 'SALE_REPORT_APPROVAL') return original;
    if (where.source_type === 'SALE_REPORT_RETURN') return entries[0] || null;
    return null;
  });
  t.mock.method(models.StaffCareCreditTransaction, 'create', async values => { entries.push(values); return values; });
  const args = { request: { return_id: 'ret', return_no: 'RET1' }, order: { order_id: 'o', create_staff_id: 1 },
    requestItems: [{ order_item_id: 1, quantity: 1 }], orderItemMap: new Map([['1', { item_id: 1, sn_id: 's' }]]), transaction };
  await reverseForSalesReturn(args);
  await reverseForSalesReturn(args);
  assert.equal(entries.length, 1); assert.equal(entries[0].amount, 220); assert.equal(entries[0].type, 'expense');
});
