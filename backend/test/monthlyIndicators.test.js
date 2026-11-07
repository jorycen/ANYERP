const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const indicators = require('../src/modules/sales/monthlyIndicators');
const { indicatorActual } = require('../src/modules/report/monthlyTaskAchievement');

test('monthly indicator indexes fit the MySQL identifier limit', () => {
  for (const model of [M.MonthlyIndicatorDefinition, M.MonthlyIndicator, M.MonthlyIndicatorAssignment, M.MonthlyIndicatorEvidence]) {
    for (const index of model.options.indexes) {
      assert(index.name && index.name.length <= 64, index.name);
    }
  }
});

const monthKey = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7);
const store = { store_id: 'A', distributor_id: 'D', manager_staff_id: 2, name: 'A' };
const user = (staffId, role) => ({ staffId, roles: [role], distributorId: 'D' });
const context = (actor, query = {}, body = {}) => ({
  state: { user: actor }, query, request: { body }, params: { indicatorId: 'I' },
  throw(status, message) { throw Object.assign(new Error(message), { status }); }
});

test('formal store manager can allocate above the company target; other staff cannot', async t => {
  const indicator = { indicator_id: 'I', month_key: monthKey, status: 1, source: 'company',
    role_code: 'staff', metric: 'management', store_id: 'A', target: 10 };
  t.mock.method(M.sequelize, 'transaction', async callback => callback({ LOCK: { UPDATE: 'UPDATE' } }));
  t.mock.method(M.MonthlyIndicator, 'findByPk', async () => indicator);
  t.mock.method(M.Store, 'findByPk', async () => store);
  t.mock.method(M.Staff, 'findByPk', async id => ({ staff_id: id, store_id: 'A', distributor_id: 'D', status: 1, role_code: 'staff' }));
  t.mock.method(M.MonthlyIndicatorAssignment, 'findAll', async () => []);
  const created = [];
  t.mock.method(M.MonthlyIndicatorAssignment, 'create', async row => created.push(row));
  const body = { assignments: [{ staffId: '3', target: 12 }] };
  await assert.rejects(() => indicators.update(context(user(4, 'manager'), {}, body)), { status: 403 });
  await indicators.update(context(user(2, 'manager'), {}, body));
  assert.equal(created[0].target, 12);
  assert.equal(indicator.target, 10);
});

test('one configuration publishes multiple roles and independent store metric targets', async t => {
  t.mock.method(M.Store, 'findAll', async () => [store, { ...store, store_id: 'B' }]);
  t.mock.method(M.Role, 'count', async () => 2);
  t.mock.method(M.ProductCategory, 'count', async () => 2);
  t.mock.method(M.sequelize, 'transaction', async callback => callback({}));
  let rows;
  t.mock.method(M.MonthlyIndicator, 'bulkCreate', async values => { rows = values; });
  await indicators.create(context(user(1, 'distributor'), {}, {
    monthKey, name: '手机指标', source: 'company', kind: 'operating',
    roleCodes: ['staff', 'manager'], categoryIds: ['root', 'child'],
    storeTargets: [{ storeId: 'A', sales: 2000, quantity: 2 }, { storeId: 'B', profit: 300 }]
  }));
  assert.deepEqual(rows.map(row => [row.store_id, row.metric, row.target]),
    [['A', 'sales', 2000], ['A', 'quantity', 2], ['B', 'profit', 300]]);
  assert(rows.every(row => row.role_codes.length === 2 && row.category_ids.length === 2));
  const incomplete = {
    monthKey, name: '手机指标', source: 'company', kind: 'operating', categoryIds: ['root', 'child'],
    storeTargets: [{ storeId: 'A' }]
  };
  await assert.rejects(() => indicators.create(context(user(1, 'distributor'), {}, incomplete)), /适用岗位/);
  await assert.rejects(() => indicators.create(context(user(1, 'distributor'), {}, {
    ...incomplete, roleCodes: ['staff', 'manager']
  })), /「A」.*门店目标/);
});

test('published targets use the stored definition and share a store overview release', async t => {
  t.mock.method(M.Store, 'findAll', async () => [store, { ...store, store_id: 'B', distributor_id: 'OTHER' }]);
  t.mock.method(M.Role, 'count', async () => 1);
  t.mock.method(M.Role, 'findAll', async () => []);
  t.mock.method(M.ProductCategory, 'count', async () => 1);
  t.mock.method(M.Distributor, 'findAll', async () => []);
  t.mock.method(M.Staff, 'findAll', async () => []);
  t.mock.method(M.sequelize, 'transaction', async callback => callback({ LOCK: { UPDATE: 'UPDATE' } }));
  const definition = { definition_id: 'D1', distributor_id: 'D', source: 'company', name: '手机指标', status: 1,
    config: { kind: 'operating', roleCodes: ['staff'], categoryIds: ['root'], metrics: ['sales', 'quantity'] } };
  t.mock.method(M.MonthlyIndicatorDefinition, 'findByPk', async () => definition);
  t.mock.method(M.MonthlyIndicatorDefinition, 'findAll', async () => [definition]);
  let rows = [];
  t.mock.method(M.MonthlyIndicator, 'findOne', async () => rows[0] || null);
  t.mock.method(M.MonthlyIndicator, 'findAll', async () => rows);
  t.mock.method(M.MonthlyIndicator, 'bulkCreate', async values => { rows = values.map(row => ({ ...row, status: 1 })); });
  const actor = user(1, 'distributor');
  const body = { monthKey, definitionId: 'D1', name: 'Ignored', storeTargets: [{ storeId: 'A', sales: 2000, quantity: 2 }] };
  await assert.rejects(() => indicators.create(context(actor, {}, { ...body, storeTargets: [{ storeId: 'B', sales: 2000 }] })), { status: 403 });
  await indicators.create(context(actor, {}, body));
  assert.equal(rows[0].name, definition.name);
  assert.equal(rows[0].release_id, rows[1].release_id);
  assert.equal(rows[1].definition_id, 'D1');
  await assert.rejects(() => indicators.create(context(actor, {}, body)), { status: 409 });
  t.mock.method(M.MonthlyIndicatorAssignment, 'findAll', async () => [
    { indicator_id: rows[0].indicator_id, staff_id: 3, target: 2100 },
    { indicator_id: rows[1].indicator_id, staff_id: 3, target: 1 }
  ]);
  const ctx = context(actor, { monthKey, allocationStatus: 'partial' });
  await indicators.setup(ctx);
  assert.equal(ctx.body.data.overview.length, 1);
  assert.deepEqual(ctx.body.data.overview[0].metrics.map(metric => metric.allocated), [2100, 1]);
  assert.equal(ctx.body.data.overview[0].assignedPeople, 1);
});

test('category indicators include newly classified products and deduplicate parent and child selections', async t => {
  t.mock.method(M.Store, 'findAll', async () => [store]);
  t.mock.method(M.MonthlyIndicator, 'findAll', async () => [{
    indicator_id: 'I', store_id: 'A', source: 'company', metric: 'quantity', status: 1, target: 5,
    category_ids: ['root', 'child'], product_ids: []
  }]);
  t.mock.method(M.MonthlyIndicatorAssignment, 'findAll', async () => []);
  t.mock.method(M.MonthlyIndicatorEvidence, 'findAll', async () => []);
  t.mock.method(M.ApprovalFlowInstance, 'findAll', async () => []);
  t.mock.method(M.Staff, 'findAll', async () => []);
  t.mock.method(M.ProductCategory, 'findAll', async () => [
    { category_id: 'root', parent_id: null }, { category_id: 'child', parent_id: 'root' },
    { category_id: 'leaf', parent_id: 'child' }
  ]);
  const products = [{ product_id: 'P1', category_id: 'child' }];
  t.mock.method(M.Product, 'findAll', async () => products);
  const performance = require('../src/modules/report/monthlyTaskAchievement');
  t.mock.method(performance, 'loadActuals', async () => ({
    storeActuals: new Map([['A', { productQuantities: new Map([['P1', 2], ['P2', 3], ['OTHER', 8]]) }]])
  }));
  const ctx = context(user(1, 'distributor'), { monthKey });
  await indicators.report(ctx);
  assert.equal(ctx.body.data.rows[0].actual, 2);
  products.push({ product_id: 'P2', category_id: 'leaf' });
  await indicators.report(ctx);
  assert.equal(ctx.body.data.rows[0].actual, 5);
});

test('business achievement counts approved evidence once, preserves original target and scopes employee rows', async t => {
  t.mock.method(M.Store, 'findAll', async () => [store]);
  t.mock.method(M.MonthlyIndicator, 'findAll', async () => [
    { indicator_id: 'I', store_id: 'A', source: 'company', metric: 'management', status: 1, target: 1 },
    { indicator_id: 'S', store_id: 'A', source: 'store', metric: 'management', status: 1, target: 1 }
  ]);
  t.mock.method(M.MonthlyIndicatorAssignment, 'findAll', async () => [
    { assignment_id: 'E', indicator_id: 'I', staff_id: 3, target: 3 },
    { assignment_id: 'F', indicator_id: 'I', staff_id: 4, target: 1 },
    { assignment_id: 'G', indicator_id: 'S', staff_id: 4, target: 1 }
  ]);
  t.mock.method(M.MonthlyIndicatorEvidence, 'findAll', async () => [
    { assignment_id: 'E', instance_id: 'A1' }, { assignment_id: 'E', instance_id: 'A2' },
    { assignment_id: 'F', instance_id: 'A3' }, { assignment_id: 'F', instance_id: 'A4' }
  ]);
  t.mock.method(M.ApprovalFlowInstance, 'findAll', async () => [
    { instance_id: 'A1', status: 'approved' }, { instance_id: 'A2', status: 'pending' },
    { instance_id: 'A3', status: 'approved' }, { instance_id: 'A4', status: 'rejected' }
  ]);
  t.mock.method(M.Staff, 'findAll', async () => [{ staff_id: 3, name: 'Three', store_id: 'A', distributor_id: 'D' },
    { staff_id: 4, name: 'Four', store_id: 'A', distributor_id: 'D' }]);
  t.mock.method(M.Staff, 'findOne', async ({ where }) => where.staff_id === '4' ? { staff_id: 4 } : null);
  const employee = context(user(3, 'staff'), { monthKey });
  await indicators.report(employee);
  assert.deepEqual(employee.body.data.rows.map(row => [row.id, row.actual, row.pendingCount]), [['E', 1, 1]]);
  const dealer = context(user(1, 'distributor'), { monthKey });
  await indicators.report(dealer);
  const [total, ...people] = dealer.body.data.rows;
  assert.deepEqual([total.target, total.allocated, total.actual, total.rate], [1, 4, 2, 200]);
  assert(people.some(row => row.source === 'store'));
  const workbench = context(user(2, 'manager'), { monthKey, view: 'mine', includeTeam: '1' });
  await indicators.report(workbench);
  assert.deepEqual(workbench.body.data.team, [{ id: 'A', name: 'A', employees: [{ id: '3', name: 'Three' }, { id: '4', name: 'Four' }] }]);
  const query = { monthKey, view: 'managed', storeId: 'A', staffId: '4' };
  const teamDetail = context(user(2, 'manager'), query);
  await indicators.report(teamDetail);
  assert.deepEqual(teamDetail.body.data.rows.map(row => [row.id, row.actual, row.canSubmit, row.submissions]),
    [['F', 1, false, []], ['G', 0, false, []]]);
  await assert.rejects(() => indicators.report(context(user(3, 'manager'), query)), { status: 403 });
  await assert.rejects(() => indicators.report(context(user(2, 'manager'), { ...query, staffId: '9' })), { status: 403 });
});

test('product indicators use selected amounts and leave unallocated product profit unknown', () => {
  const actual = { salesAmount: 50, grossProfit: 10, productQuantities: new Map([['P', 2]]),
    productValues: new Map([['P', { sales: 20, profit: 4 }]]) };
  assert.equal(indicatorActual(actual, 'sales', ['P']), 20);
  assert.equal(indicatorActual(actual, 'quantity', ['P']), 2);
  assert.equal(indicatorActual(actual, 'profit', ['P']), 4);
  assert.equal(indicatorActual({ ...actual, unallocatedProfit: true }, 'profit', ['P']), null);
});

test('proof uses the direct supervisor and an authenticated attachment endpoint', async t => {
  const tx = { LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' } };
  t.mock.method(M.sequelize, 'transaction', async callback => callback(tx));
  t.mock.method(M.MonthlyIndicatorAssignment, 'findByPk', async () => ({ assignment_id: 'E', indicator_id: 'I', staff_id: 3 }));
  const indicator = { name: 'Inspection', month_key: monthKey, metric: 'management', status: 1 };
  t.mock.method(M.MonthlyIndicator, 'findByPk', async () => indicator);
  t.mock.method(M.Staff, 'findByPk', async id => ({ staff_id: id, supervisor_staff_id: 2, distributor_id: 'D', status: 1 }));
  const approval = require('../src/modules/approval/service');
  let started = 0;
  t.mock.method(approval, 'startInstance', async (input, actor, transaction) => {
    assert.equal(input.subjectStaffId, 3);
    assert.equal(actor.staffId, 3);
    assert.equal(transaction, tx);
    started++;
    return { instance_id: 'A1' };
  });
  t.mock.method(M.ApprovalTask, 'findAll', async () => [{ assignee_staff_id: 2 }]);
  let stored;
  t.mock.method(M.MonthlyIndicatorEvidence, 'create', async row => { stored = row; });
  t.mock.method(M.MonthlyIndicatorEvidence, 'findByPk', async id => !id || stored?.evidence_id === id ? stored : null);
  const ctx = context(user(3, 'staff'));
  ctx.params.assignmentId = 'E';
  ctx.file = { mimetype: 'application/pdf', originalname: 'proof.pdf', buffer: Buffer.from('%PDF-1.4') };
  await indicators.submit(ctx);
  assert.equal(stored.supervisor_staff_id, 2);
  assert.equal(stored.instance_id, 'A1');
  await assert.rejects(() => indicators.download(context(user(4, 'manager'))), { status: 404 });
  const supervisor = context(user(2, 'manager'));
  supervisor.attachment = () => {};
  supervisor.set = () => {};
  await indicators.download(supervisor);
  assert.deepEqual(supervisor.body, ctx.file.buffer);
  indicator.check_method = 'text';
  delete ctx.file;
  ctx.request.body.resultText = '  已完成检查  ';
  await indicators.submit(ctx);
  assert.equal(stored.result_text, '已完成检查');
  await assert.rejects(() => indicators.download(supervisor), { status: 404 });
  indicator.check_method = 'photo';
  const photo = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  ctx.request.body = { photoBase64: photo, submissionKey: 'same-photo-123' };
  await indicators.submit(ctx);
  const evidenceId = ctx.body.data.evidenceId;
  await indicators.submit(ctx);
  assert.equal(ctx.body.data.evidenceId, evidenceId);
  assert.equal(started, 3);
  supervisor.params.evidenceId = evidenceId;
  supervisor.query.format = 'base64';
  await indicators.download(supervisor);
  assert.deepEqual(supervisor.body.data, { photoBase64: photo, mimeType: 'image/png' });
});
