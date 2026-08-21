const { Op } = require('sequelize');
const {
  sequelize,
  Staff,
  Store,
  Role,
  ApprovalFlowDefinition,
  ApprovalFlowInstance,
  ApprovalTask,
  ApprovalActionLog
} = require('../../models');
const { generateUUID } = require('../../utils');
const { createInstance, actionInstance, resubmitInstance, normalizeFlowConfig, parseJson } = require('./service');

function isAdmin(user) {
  return user.roles?.some(role => ['admin', 'boss'].includes(role));
}

function bodyError(ctx, error) {
  ctx.throw(400, error.message || String(error));
}

function toFlow(row) {
  const data = row.toJSON();
  data.config = parseJson(data.config_json, {});
  delete data.config_json;
  return data;
}

function toInstance(row) {
  const data = row.toJSON ? row.toJSON() : row;
  data.payload = parseJson(data.payload_json, null);
  data.definitionSnapshot = parseJson(data.definition_snapshot_json, {});
  delete data.payload_json;
  delete data.definition_snapshot_json;
  return data;
}

async function listFlows(ctx) {
  const where = {};
  if (ctx.query.businessType) where.business_type = ctx.query.businessType;
  if (ctx.query.status) where.status = ctx.query.status;
  const rows = await ApprovalFlowDefinition.findAll({ where, order: [['flow_code', 'ASC'], ['version', 'DESC']] });
  ctx.body = rows.map(toFlow);
}

async function getFlow(ctx) {
  const row = await ApprovalFlowDefinition.findByPk(ctx.params.definitionId);
  if (!row) ctx.throw(404, '审批流程不存在');
  ctx.body = toFlow(row);
}

function validateFlowBody(ctx, body) {
  const flowCode = String(body.flowCode || body.flow_code || '').trim();
  const name = String(body.name || '').trim();
  const businessType = String(body.businessType || body.business_type || '').trim();
  if (!flowCode || !/^[A-Za-z0-9_.-]{2,64}$/.test(flowCode)) ctx.throw(400, '流程编码必须为2-64位英文、数字、点、下划线或短横线');
  if (!name) ctx.throw(400, '请输入流程名称');
  if (!businessType) ctx.throw(400, '请输入业务类型');
  let config;
  try { config = normalizeFlowConfig(body.config || body); } catch (error) { bodyError(ctx, error); }
  return { flowCode, name, businessType, subjectType: body.subjectType || body.subject_type || 'staff', config };
}

async function createFlow(ctx) {
  const input = validateFlowBody(ctx, ctx.request.body || {});
  const existing = await ApprovalFlowDefinition.findOne({ where: { flow_code: input.flowCode }, order: [['version', 'DESC']] });
  const row = await ApprovalFlowDefinition.create({
    definition_id: generateUUID(),
    flow_code: input.flowCode,
    name: input.name,
    business_type: input.businessType,
    subject_type: input.subjectType,
    version: existing ? Number(existing.version) + 1 : 1,
    status: 'draft',
    config_json: JSON.stringify(input.config),
    create_staff_id: ctx.state.user.staffId,
    update_staff_id: ctx.state.user.staffId
  });
  ctx.body = { code: 0, message: '审批流程已保存为草稿', data: toFlow(row) };
}

async function updateFlow(ctx) {
  const row = await ApprovalFlowDefinition.findByPk(ctx.params.definitionId);
  if (!row) ctx.throw(404, '审批流程不存在');
  const input = validateFlowBody(ctx, ctx.request.body || {});
  if (row.status !== 'draft') {
    const latest = await ApprovalFlowDefinition.findOne({ where: { flow_code: row.flow_code }, order: [['version', 'DESC']] });
    const next = await ApprovalFlowDefinition.create({
      definition_id: generateUUID(),
      flow_code: row.flow_code,
      name: input.name,
      business_type: input.businessType,
      subject_type: input.subjectType,
      version: Number(latest?.version || row.version) + 1,
      status: 'draft',
      config_json: JSON.stringify(input.config),
      create_staff_id: ctx.state.user.staffId,
      update_staff_id: ctx.state.user.staffId
    });
    ctx.body = { code: 0, message: '已创建新的审批流程草稿版本', data: toFlow(next) };
    return;
  }
  await row.update({ name: input.name, business_type: input.businessType, subject_type: input.subjectType, config_json: JSON.stringify(input.config), update_staff_id: ctx.state.user.staffId, update_time: new Date() });
  ctx.body = { code: 0, message: '审批流程草稿已更新', data: toFlow(row) };
}

async function publishFlow(ctx) {
  const row = await ApprovalFlowDefinition.findByPk(ctx.params.definitionId);
  if (!row) ctx.throw(404, '审批流程不存在');
  if (row.status !== 'draft') ctx.throw(400, '只有草稿流程可以发布');
  await sequelize.transaction(async transaction => {
    await ApprovalFlowDefinition.update({ status: 'disabled', update_staff_id: ctx.state.user.staffId, update_time: new Date() }, { where: { flow_code: row.flow_code, status: 'published' }, transaction });
    await row.update({ status: 'published', update_staff_id: ctx.state.user.staffId, update_time: new Date() }, { transaction });
  });
  ctx.body = { code: 0, message: '审批流程已发布' };
}

async function disableFlow(ctx) {
  const row = await ApprovalFlowDefinition.findByPk(ctx.params.definitionId);
  if (!row) ctx.throw(404, '审批流程不存在');
  await row.update({ status: 'disabled', update_staff_id: ctx.state.user.staffId, update_time: new Date() });
  ctx.body = { code: 0, message: '审批流程已停用' };
}

async function listTasks(ctx) {
  const where = { assignee_staff_id: ctx.state.user.staffId };
  if (ctx.query.status) where.status = ctx.query.status;
  else where.status = 'pending';
  const tasks = await ApprovalTask.findAll({
    where,
    include: [{ model: ApprovalFlowInstance, as: 'Instance', attributes: ['instance_id', 'instance_no', 'business_type', 'business_id', 'title', 'summary', 'applicant_staff_id', 'subject_staff_id', 'status', 'resubmit_count', 'create_time'] }],
    order: [['create_time', 'DESC']]
  });
  ctx.body = tasks;
}

function instanceAccessWhere(user, scope) {
  if (scope === 'all' && isAdmin(user)) return {};
  return { [Op.or]: [{ applicant_staff_id: user.staffId }, { subject_staff_id: user.staffId }] };
}

async function listInstances(ctx) {
  const scope = ctx.query.scope || 'mine';
  const where = scope === 'todo' ? {} : { ...instanceAccessWhere(ctx.state.user, scope) };
  if (scope === 'todo') {
    const taskRows = await ApprovalTask.findAll({ where: { assignee_staff_id: ctx.state.user.staffId }, attributes: ['instance_id'], raw: true });
    where.instance_id = taskRows.length ? taskRows.map(row => row.instance_id) : '';
  }
  if (ctx.query.status) where.status = ctx.query.status;
  const rows = await ApprovalFlowInstance.findAll({ where, order: [['create_time', 'DESC']], limit: Math.min(Number(ctx.query.limit || 100), 500) });
  ctx.body = rows.map(toInstance);
}

async function canReadInstance(ctx, instance) {
  if (isAdmin(ctx.state.user)) return true;
  if (Number(instance.applicant_staff_id) === Number(ctx.state.user.staffId) || Number(instance.subject_staff_id) === Number(ctx.state.user.staffId)) return true;
  return Boolean(await ApprovalTask.findOne({ where: { instance_id: instance.instance_id, assignee_staff_id: ctx.state.user.staffId } }));
}

async function getInstance(ctx) {
  const row = await ApprovalFlowInstance.findByPk(ctx.params.instanceId, {
    include: [
      { model: ApprovalTask, as: 'Tasks', include: [{ model: Staff, as: 'Assignee', attributes: ['staff_id', 'name'] }], order: [['round_no', 'ASC'], ['node_index', 'ASC'], ['task_order', 'ASC']] },
      { model: ApprovalActionLog, as: 'Logs', include: [{ model: Staff, as: 'Actor', attributes: ['staff_id', 'name'] }], order: [['create_time', 'ASC']] }
    ]
  });
  if (!row) ctx.throw(404, '审批实例不存在');
  if (!(await canReadInstance(ctx, row))) ctx.throw(403, '无权查看该审批实例');
  ctx.body = toInstance(row);
}

async function submitInstance(ctx) {
  try {
    const row = await createInstance(ctx.request.body || {}, ctx.state.user);
    ctx.body = { code: 0, message: '审批申请已提交', data: toInstance(row) };
  } catch (error) { bodyError(ctx, error); }
}

async function action(ctx) {
  try {
    const row = await actionInstance(ctx.params.instanceId, ctx.request.body?.action, ctx.request.body?.comment, ctx.state.user);
    ctx.body = { code: 0, message: ctx.request.body?.action === 'approve' ? '审批已通过' : '审批已拒绝', data: toInstance(row) };
  } catch (error) { bodyError(ctx, error); }
}

async function resubmit(ctx) {
  try {
    const row = await resubmitInstance(ctx.params.instanceId, ctx.request.body || {}, ctx.state.user);
    ctx.body = { code: 0, message: '申请已重新提交', data: toInstance(row) };
  } catch (error) { bodyError(ctx, error); }
}

async function getAssigneeOptions(ctx) {
  const where = { status: 1, is_deleted: 0 };
  if (!isAdmin(ctx.state.user) && ctx.state.user.distributorId) where.distributor_id = ctx.state.user.distributorId;
  const [staff, roles, stores] = await Promise.all([
    Staff.findAll({ where, attributes: ['staff_id', 'name', 'phone'], order: [['name', 'ASC']] }),
    Role.findAll({ where: { status: 1, ...(ctx.state.user.roles.includes('boss') ? {} : { role_code: { [Op.ne]: 'boss' } }) }, attributes: ['role_code', 'name'], order: [['name', 'ASC']] }),
    Store.findAll({ where: { status: 1, is_deleted: 0, ...(ctx.state.user.roles.includes('boss') ? {} : { distributor_id: ctx.state.user.distributorId }) }, attributes: ['store_id', 'name'], order: [['name', 'ASC']] })
  ]);
  ctx.body = { staff, roles, stores };
}

module.exports = { listFlows, getFlow, createFlow, updateFlow, publishFlow, disableFlow, listTasks, listInstances, getInstance, submitInstance, action, resubmit, getAssigneeOptions };
