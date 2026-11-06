
const { randomUUID } = require('node:crypto');
const { Op } = require('sequelize');
const M = require('../../models');
const { getUserRoles, isDealerAccount } = require('../../middleware/permission');
const { canAccessDistributor } = require('../../utils/distributorScope');
const approval = require('../approval/service');
const metrics = ['sales', 'profit', 'quantity', 'management'];
const active = { status: 1, is_deleted: 0 };
const key = value => String(value ?? '');
const nowMonth = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7);
const result = (ctx, data) => { ctx.body = { code: 0, data }; };

function month(ctx, value = nowMonth()) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) ctx.throw(400, '请选择有效月份');
  return value;
}

function target(ctx, value, metric) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1e12 ||
      (['quantity', 'management'].includes(metric) ? !Number.isInteger(number) :
        Math.abs(number * 100 - Math.round(number * 100)) > 0.001)) ctx.throw(400, '目标值格式不正确');
  return number;
}

async function storesFor(user) {
  const stores = await M.Store.findAll({
    where: active, attributes: ['store_id', 'name', 'distributor_id', 'manager_staff_id'], raw: true
  });
  return stores.filter(store => canAccessDistributor(user, store.distributor_id));
}

function permissions(user, store) {
  return { company: isDealerAccount(user) && ['boss', 'admin', 'distributor'].some(role =>
    getUserRoles(user).includes(role)),
    manager: !!user.staffId && key(store.manager_staff_id) === key(user.staffId) };
}

async function setup(ctx) {
  const user = ctx.state.user;
  const monthKey = month(ctx, ctx.query.monthKey);
  const stores = (await storesFor(user)).map(store => ({ ...store, ...permissions(user, store) }))
    .filter(store => store.company || store.manager);
  const ids = stores.map(store => store.store_id);
  const [indicators, staff] = await Promise.all([
    M.MonthlyIndicator.findAll({ where: { month_key: monthKey, store_id: ids }, raw: true }),
    M.Staff.findAll({ where: { ...active, [Op.or]: [{ store_id: ids }, { staff_id: stores.map(store => store.manager_staff_id).filter(Boolean) }] },
      attributes: ['staff_id', 'store_id', 'name', 'role_code'], raw: true })
  ]);
  const assignments = await M.MonthlyIndicatorAssignment.findAll({ where: { indicator_id: indicators.map(row => row.indicator_id) }, raw: true });
  result(ctx, { stores, staff, indicators, assignments });
}

async function create(ctx) {
  const user = ctx.state.user;
  const body = ctx.request.body || {};
  const monthKey = month(ctx, body.monthKey);
  const ids = [...new Set(Array.isArray(body.storeIds) ? body.storeIds.map(key) : [])];
  const stores = (await storesFor(user)).filter(store => ids.includes(key(store.store_id)));
  const name = key(body.name).trim();
  const requirements = key(body.requirements).trim();
  if (monthKey < nowMonth() || !name || name.length > 128 || requirements.length > 1000 ||
      !metrics.includes(body.metric) || !['company', 'store'].includes(body.source) ||
      !key(body.roleCode).trim() || key(body.roleCode).length > 32 || !ids.length || ids.length !== stores.length) ctx.throw(400, '指标配置不完整');
  if (stores.some(store => !permissions(user, store)[body.source === 'company' ? 'company' : 'manager'])) ctx.throw(403, '无权在所选门店配置此指标');
  const productIds = body.metric === 'management' ? [] : [...new Set(Array.isArray(body.productIds) ? body.productIds.map(key) : [])];
  if (productIds.length && await M.Product.count({ where: { product_id: productIds } }) !== productIds.length) ctx.throw(400, '商品范围无效');
  const goal = target(ctx, body.target, body.metric);
  await M.sequelize.transaction(async transaction => {
    await M.MonthlyIndicator.bulkCreate(stores.map(store => ({
      indicator_id: randomUUID(), month_key: monthKey, store_id: store.store_id, source: body.source,
      name, role_code: body.roleCode, metric: body.metric, target: goal, product_ids: productIds,
      requirements, created_by: user.staffId
    })), { transaction });
  });
  result(ctx, {});
}

async function update(ctx) {
  const user = ctx.state.user;
  const body = ctx.request.body || {};
  await M.sequelize.transaction(async transaction => {
    const row = await M.MonthlyIndicator.findByPk(ctx.params.indicatorId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!row || row.month_key < nowMonth() || !row.status) ctx.throw(409, '指标不存在或已停用');
    const store = await M.Store.findByPk(row.store_id, { transaction });
    if (!store || !canAccessDistributor(user, store.distributor_id)) ctx.throw(403, '无权操作该门店');
    const access = permissions(user, store);
    if (body.disable === true) {
      if (!access[row.source === 'company' ? 'company' : 'manager']) ctx.throw(403, '无权停用此指标');
      await row.update({ status: 0 }, { transaction });
      return;
    }
    if (!access.manager) ctx.throw(403, '由本店店长分解目标');
    if (!Array.isArray(body.assignments)) ctx.throw(400, '请选择分解对象');
    const existing = await M.MonthlyIndicatorAssignment.findAll({ where: { indicator_id: row.indicator_id }, transaction });
    const submitted = new Set();
    for (const entry of body.assignments) {
      const id = key(entry.staffId);
      if (submitted.has(id)) ctx.throw(400, '同一员工只能分解一次');
      submitted.add(id);
      const staff = await M.Staff.findByPk(id, { transaction });
      if (!staff || !staff.status || staff.is_deleted || key(staff.distributor_id) !== key(store.distributor_id) ||
          (key(staff.store_id) !== key(store.store_id) && id !== key(store.manager_staff_id)) ||
          (staff.role_code !== row.role_code && !(row.source === 'store' && id === key(store.manager_staff_id)))) ctx.throw(400, '员工不符合门店或岗位范围');
      const goal = target(ctx, entry.target, row.metric);
      const old = existing.find(item => key(item.staff_id) === id);
      if (old) await old.update({ target: goal }, { transaction });
      else await M.MonthlyIndicatorAssignment.create({ assignment_id: randomUUID(), indicator_id: row.indicator_id, staff_id: id, target: goal }, { transaction });
    }
    for (const old of existing.filter(item => !submitted.has(key(item.staff_id)))) {
      if (await M.MonthlyIndicatorEvidence.count({ where: { assignment_id: old.assignment_id }, transaction })) ctx.throw(409, '已有提交记录的人员不能移除');
      await old.destroy({ transaction });
    }
  });
  result(ctx, {});
}

async function submit(ctx) {
  const user = ctx.state.user;
  const file = ctx.file;
  if (!file?.buffer?.length || !['image/jpeg', 'image/png', 'application/pdf'].includes(file.mimetype)) ctx.throw(400, '请上传 JPG、PNG 或 PDF 证明文件');
  const signature = { 'image/jpeg': 'ffd8ff', 'image/png': '89504e470d0a1a0a', 'application/pdf': '255044462d' }[file.mimetype];
  if (!file.buffer.subarray(0, 8).toString('hex').startsWith(signature)) ctx.throw(400, '证明文件内容与格式不匹配');
  await M.sequelize.transaction(async transaction => {
    const assignment = await M.MonthlyIndicatorAssignment.findByPk(ctx.params.assignmentId, { transaction });
    if (!assignment || key(assignment.staff_id) !== key(user.staffId)) ctx.throw(403, '只能提交自己的任务');
    const indicator = await M.MonthlyIndicator.findByPk(assignment.indicator_id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!indicator?.status || indicator.metric !== 'management' || indicator.month_key !== nowMonth()) ctx.throw(409, '该任务当前不可提交');
    if (!await M.MonthlyIndicatorAssignment.findByPk(assignment.assignment_id, { transaction, lock: transaction.LOCK.UPDATE })) ctx.throw(409, '任务分解已变更');
    const staff = await M.Staff.findByPk(user.staffId, { transaction, lock: transaction.LOCK.SHARE });
    const supervisor = staff?.supervisor_staff_id && await M.Staff.findByPk(staff.supervisor_staff_id, { transaction });
    if (!supervisor?.status || supervisor.is_deleted || key(supervisor.staff_id) === key(staff.staff_id)) ctx.throw(409, '请检查直属上级配置');
    const id = randomUUID();
    const instance = await approval.startInstance({
      flowCode: 'monthly_indicator_evidence', businessType: 'monthly_indicator_evidence', businessId: id,
      subjectStaffId: staff.staff_id, storeId: null, distributorId: staff.distributor_id,
      title: indicator.name, summary: indicator.requirements,
      payload: { indicatorEvidenceId: id, original_name: key(file.originalname).slice(0, 255), mime_type: file.mimetype }
    }, user, transaction);
    const tasks = await M.ApprovalTask.findAll({ where: { instance_id: instance.instance_id }, transaction });
    if (tasks.length !== 1 || key(tasks[0].assignee_staff_id) !== key(supervisor.staff_id)) ctx.throw(409, '管理指标审批须由直属上级处理');
    await M.MonthlyIndicatorEvidence.create({ evidence_id: id, assignment_id: assignment.assignment_id,
      instance_id: instance.instance_id, applicant_staff_id: staff.staff_id, supervisor_staff_id: supervisor.staff_id,
      original_name: key(file.originalname).slice(0, 255), mime_type: file.mimetype, attachment: file.buffer }, { transaction });
  });
  result(ctx, {});
}

async function download(ctx) {
  const row = await M.MonthlyIndicatorEvidence.findByPk(ctx.params.evidenceId);
  const id = key(ctx.state.user.staffId);
  if (!row || ![key(row.applicant_staff_id), key(row.supervisor_staff_id)].includes(id)) ctx.throw(404, '证明文件不存在');
  ctx.attachment(row.original_name);
  ctx.set('X-Content-Type-Options', 'nosniff');
  ctx.type = row.mime_type;
  ctx.body = row.attachment;
}

async function report(ctx) {
  const user = ctx.state.user;
  const monthKey = month(ctx, ctx.query.monthKey);
  const own = ctx.query.view === 'mine';
  const stores = (await storesFor(user)).filter(store => !ctx.query.storeId || key(store.store_id) === key(ctx.query.storeId));
  const indicators = await M.MonthlyIndicator.findAll({ where: { month_key: monthKey, store_id: stores.map(store => store.store_id),
    ...(['company', 'store'].includes(ctx.query.source) ? { source: ctx.query.source } : {}) }, raw: true });
  const assignments = await M.MonthlyIndicatorAssignment.findAll({ where: { indicator_id: indicators.map(row => row.indicator_id) }, raw: true });
  const visible = indicators.filter(row => assignments.some(item => item.indicator_id === row.indicator_id && key(item.staff_id) === key(user.staffId)) ||
    (!own && Object.values(permissions(user, stores.find(store => store.store_id === row.store_id))).some(Boolean)));
  const visibleIds = new Set(visible.map(row => row.indicator_id));
  const related = assignments.filter(row => visibleIds.has(row.indicator_id));
  const evidence = await M.MonthlyIndicatorEvidence.findAll({ where: { assignment_id: related.map(row => row.assignment_id) },
    attributes: ['assignment_id', 'instance_id', 'evidence_id', 'original_name', 'create_time'], raw: true });
  const instances = await M.ApprovalFlowInstance.findAll({ where: { instance_id: evidence.map(row => row.instance_id) }, attributes: ['instance_id', 'status'], raw: true });
  const statusById = new Map(instances.map(row => [row.instance_id, row.status]));
  const staff = await M.Staff.findAll({ where: { staff_id: related.map(row => row.staff_id) }, attributes: ['staff_id', 'name'], raw: true });
  const staffNames = new Map(staff.map(row => [key(row.staff_id), row.name]));
  const performance = require('../report/monthlyTaskAchievement');
  const start = new Date(monthKey + '-01T00:00:00+08:00');
  const endAt = new Date(Date.UTC(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7)), 1) - 8 * 3600000);
  const canProfit = require('../report/dashboardService').canViewProfit(user);
  const operatingStoreIds = [...new Set(visible.filter(row => !own && row.metric !== 'management').map(row => row.store_id))];
  const actuals = await performance.loadActuals(operatingStoreIds, start, endAt, 'archived', true);
  const rows = [];
  for (const store of stores) {
    const indicators = visible.filter(row => row.store_id === store.store_id && (!own || row.metric === 'management'));
    if (!indicators.length) continue;
    for (const row of indicators) {
      const managerial = !own && Object.values(permissions(user, store)).some(Boolean);
      const people = related.filter(item => item.indicator_id === row.indicator_id);
      const actualFor = item => {
        if (row.metric === 'management') return evidence.filter(ev => (item ? ev.assignment_id === item.assignment_id :
          people.some(person => person.assignment_id === ev.assignment_id)) && statusById.get(ev.instance_id) === 'approved').length;
        if (row.metric === 'profit' && !canProfit) return null;
        const actual = item ? actuals.employeeActuals.get(`${store.store_id}:id:${item.staff_id}`) : actuals.storeActuals.get(key(store.store_id));
        return performance.indicatorActual(actual, row.metric, row.product_ids);
      };
      const response = (item, goal) => {
        const actual = actualFor(item);
        const showGoal = row.metric !== 'profit' || canProfit;
        const mine = item && key(item.staff_id) === key(user.staffId);
        const submissions = item ? evidence.filter(ev => ev.assignment_id === item.assignment_id) :
          evidence.filter(ev => people.some(person => person.assignment_id === ev.assignment_id));
        return { id: item?.assignment_id || row.indicator_id, name: row.name, metric: row.metric, source: row.source,
          store: store.name, employee: item ? staffNames.get(key(item.staff_id)) : '', requirements: row.requirements,
          target: showGoal ? Number(goal) : null, actual, rate: actual === null ? null : Number((actual / Number(goal) * 100).toFixed(2)),
          actualStatus: !showGoal ? 'hidden' : actual === null ? 'pending' : 'available',
          allocated: item || !showGoal ? null : people.reduce((sum, person) => sum + Number(person.target), 0),
          pendingCount: submissions.filter(ev => statusById.get(ev.instance_id) === 'pending').length,
          active: !!row.status, canSubmit: !!mine && !!row.status && row.metric === 'management' && monthKey === nowMonth(),
          submissions: item && own ? submissions.map(ev => ({
            id: ev.evidence_id, name: ev.original_name, status: statusById.get(ev.instance_id), createdAt: ev.create_time
          })) : [] };
      };
      if (managerial && row.source === 'company' && !ctx.query.staffId) rows.push(response(null, row.target));
      for (const item of people) {
        if ((managerial || key(item.staff_id) === key(user.staffId)) &&
            (!ctx.query.staffId || key(item.staff_id) === key(ctx.query.staffId))) rows.push(response(item, item.target));
      }
    }
  }
  if (ctx.query.format === 'xlsx') {
    const { sendExcel } = require('../../utils/excelExport');
    const labels = { sales: '销售额', profit: '销售毛利', quantity: '销售数量', management: '管理次数' };
    const headers = ['门店', '员工', '指标', '来源', '类型', '目标', '已分解', '实际', '达成率百分比', '待审次数'];
    return sendExcel(ctx, rows.map(row => ({
      门店: row.store, 员工: row.employee, 指标: row.name, 来源: row.source === 'company' ? '公司下发' : '门店自建',
      类型: labels[row.metric], 目标: row.target, 已分解: row.allocated,
      实际: row.actualStatus === 'pending' ? '待核算' : row.actual, 达成率百分比: row.rate,
      待审次数: row.metric === 'management' ? row.pendingCount : null
    })), headers, `月度指标达成_${monthKey}.xlsx`, '业务达成');
  }
  result(ctx, { rows });
}

module.exports = { setup, create, update, report, submit, download };
