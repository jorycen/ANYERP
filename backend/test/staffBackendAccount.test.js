const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/models');
const { accountTypeWhere, parseBackendAccount, ensureStaffAccountSchema } = require('../src/utils/staffAccount');

test('后台标记严格区分是/否，管理列表可筛选全部、业务、后台', () => {
  for (const value of [true, 1, '1']) assert.equal(parseBackendAccount(value), 1);
  for (const value of [false, 0, '0']) assert.equal(parseBackendAccount(value), 0);
  for (const value of ['', null, 'true', 2, [], {}]) assert.throws(() => parseBackendAccount(value), error => error.status === 400);
  assert.deepEqual(accountTypeWhere('all'), {});
  assert.deepEqual(accountTypeWhere('business'), { is_backend_account: 0 });
  assert.deepEqual(accountTypeWhere('backend'), { is_backend_account: 1 });
  assert.throws(() => accountTypeWhere('other'), error => error.status === 400);
});

test('用户管理筛选在分页前执行，全部列表仍返回后台账号及标记', async t => {
  const records = [{ staff_id: 1, name: 'sales', is_backend_account: 0 }, { staff_id: 2, name: 'backend', is_backend_account: 1 }];
  t.mock.method(M.Staff, 'findAndCountAll', async ({ where }) => {
    const selected = records.filter(row => where.is_backend_account === undefined || row.is_backend_account === where.is_backend_account);
    return { count: selected.length, rows: selected.map(row => ({ toJSON: () => ({ ...row, Roles: [], AssignedStores: [], AssignedDistributors: [] }) })) };
  });
  t.mock.method(M.Store, 'findAll', async () => []);
  t.mock.method(M.Region, 'findAll', async () => []);
  for (const [accountType, ids] of [['all', [1, 2]], ['business', [1]], ['backend', [2]]]) {
    const ctx = { query: { accountType }, state: { user: { roles: ['boss'], accessibleDistributorIds: ['*'] } } };
    await require('../src/modules/system/controller').getUsers(ctx);
    assert.deepEqual(ctx.body.list.map(row => row.staff_id), ids);
    assert.equal(ctx.body.pagination.total, ids.length);
    if (accountType === 'backend') assert.equal(ctx.body.list[0].is_backend_account, 1);
  }
});

test('辅助销售选项过滤后台账号，原经销商和门店范围保留', async t => {
  let captured;
  t.mock.method(M.Store, 'findAll', async () => []);
  t.mock.method(M.Staff, 'findAll', async options => { captured = options; return []; });
  const ctx = { state: { user: { distributorId: 'D' } }, query: {} };
  await require('../src/modules/sales/controller').auxiliaryStaff(ctx);
  assert.equal(captured.where.is_backend_account, 0);
  assert.equal(captured.where.status, 1);
  assert.ok(Reflect.ownKeys(captured.where).some(key => typeof key === 'symbol'));
});

test('标记不对Staff模型施加全局scope，认证、历史引用和审批可继续按ID读取', () => {
  assert.equal(M.Staff.options.defaultScope?.where?.is_backend_account, undefined);
});
test('更新后台标记持久化并审计，其他编辑省略标记时不会清除它', async t => {
  const staff = { staff_id: 9, distributor_id: 'D', is_backend_account: 0, Roles: [{ role_code: 'admin' }],
    async update(values) { Object.assign(this, values); } };
  const logs = [], updates = [];
  t.mock.method(M.Staff, 'findByPk', async () => staff);
  t.mock.method(M.StaffDistributorPermission, 'findAll', async () => [{ distributor_id: 'D' }]);
  t.mock.method(M.StaffDistributorPermission, 'destroy', async () => {});
  t.mock.method(M.StaffDistributorPermission, 'bulkCreate', async () => {});
  t.mock.method(M.Distributor, 'findAll', async () => [{ distributor_id: 'D' }]);
  t.mock.method(M.sequelize, 'transaction', async fn => fn({}));
  t.mock.method(M.BusinessActionLog, 'create', async values => { logs.push(values); });
  t.mock.method(M.StaffRole, 'destroy', async () => { throw new Error('Must not change role'); });
  const controller = require('../src/modules/system/controller');
  for (const body of [{ isBackendAccount: true }, { name: 'Renamed' }, { isBackendAccount: false }]) {
    const ctx = { params: { staffId: 9 }, request: { body }, state: { user: { staffId: 1, name: 'Admin', roles: ['boss'] } } };
    await controller.updateUser(ctx); updates.push(staff.is_backend_account);
  }
  assert.deepEqual(updates, [1, 1, 0]);
  assert.equal(logs.length, 2);
  assert.deepEqual(JSON.parse(logs[0].detail_json), { before: 0, after: 1 });
  assert.equal(staff.password_hash, undefined);
  assert.equal(staff.role_code, undefined);
});

test('审批配置保留后台账号选项，不套用业务人员过滤', async t => {
  let where;
  t.mock.method(M.Staff, 'findAll', async options => { where = options.where; return [{ staff_id: 9, name: 'backend' }]; });
  t.mock.method(M.Role, 'findAll', async () => []);
  t.mock.method(M.Store, 'findAll', async () => []);
  const ctx = { state: { user: { roles: ['boss'] } } };
  await require('../src/modules/approval/controller').getAssigneeOptions(ctx);
  assert.equal(where.is_backend_account, undefined);
  assert.equal(ctx.body.staff[0].staff_id, 9);
});

test('字段迁移可重复运行，添加失败时不能伪装为迁移成功', async () => {
  let columns = {}, adds = 0, verified = 0;
  const query = { describeTable: async () => columns, addColumn: async (_, name, definition) => {
    adds++; assert.equal(definition.defaultValue, 0); assert.equal(definition.allowNull, false); columns[name] = {};
  } };
  const db = { getQueryInterface: () => query, query: async () => { verified++; } };
  await ensureStaffAccountSchema(db); await ensureStaffAccountSchema(db);
  assert.equal(adds, 1); assert.equal(verified, 2);
  await assert.rejects(ensureStaffAccountSchema({ getQueryInterface: () => ({ describeTable: async () => ({}), addColumn: async () => { throw new Error('DDL denied'); } }) }), /DDL denied/);
});
