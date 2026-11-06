const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const indicators = require('../src/modules/sales/monthlyIndicators');
const { indicatorActual } = require('../src/modules/report/monthlyTaskAchievement');

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
  t.mock.method(M.Staff, 'findAll', async () => [{ staff_id: 3, name: 'Three' }, { staff_id: 4, name: 'Four' }]);
  const employee = context(user(3, 'staff'), { monthKey });
  await indicators.report(employee);
  assert.deepEqual(employee.body.data.rows.map(row => [row.id, row.actual, row.pendingCount]), [['E', 1, 1]]);
  const dealer = context(user(1, 'distributor'), { monthKey });
  await indicators.report(dealer);
  const [total, ...people] = dealer.body.data.rows;
  assert.deepEqual([total.target, total.allocated, total.actual, total.rate], [1, 4, 2, 200]);
  assert(people.some(row => row.source === 'store'));
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
  t.mock.method(M.MonthlyIndicator, 'findByPk', async () => ({ name: 'Inspection', month_key: monthKey, metric: 'management', status: 1 }));
  t.mock.method(M.Staff, 'findByPk', async id => ({ staff_id: id, supervisor_staff_id: 2, distributor_id: 'D', status: 1 }));
  const approval = require('../src/modules/approval/service');
  t.mock.method(approval, 'startInstance', async (input, actor, transaction) => {
    assert.equal(input.subjectStaffId, 3);
    assert.equal(actor.staffId, 3);
    assert.equal(transaction, tx);
    return { instance_id: 'A1' };
  });
  t.mock.method(M.ApprovalTask, 'findAll', async () => [{ assignee_staff_id: 2 }]);
  let stored;
  t.mock.method(M.MonthlyIndicatorEvidence, 'create', async row => { stored = row; });
  t.mock.method(M.MonthlyIndicatorEvidence, 'findByPk', async () => stored);
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
});
