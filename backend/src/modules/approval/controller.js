const { Op } = require('sequelize');
const {
  sequelize,
  Staff,
  Store,
  Role,
  Settlement,
  ApprovalFlowDefinition,
  ApprovalFlowInstance,
  ApprovalTask,
  ApprovalActionLog
} = require('../../models');
const { generateUUID } = require('../../utils');
const {
  createInstance,
  actionInstance,
  resubmitInstance,
  normalizeFlowConfig,
  parseJson,
  getApprovalStoreWhere,
  canReadApprovalStore
} = require('./service');

function isAdmin(user) {
  return user.roles?.some(role => ['admin', 'boss'].includes(role));
}

function bodyError(ctx, error) {
  ctx.throw(400, error.message || String(error));
}

function approvalInstanceVisibilityWhere(user) {
  const storeWhere = getApprovalStoreWhere(user);
  if (!storeWhere) return null;
  return {
    [Op.or]: [
      storeWhere,
      { store_id: { [Op.is]: null }, distributor_id: { [Op.in]: require('../../utils/distributorScope').accessibleDistributorIds(user).filter(id => id !== '*') } }
    ]
  };
}

function toFlow(row) {
  const data = row.toJSON();
  data.config = parseJson(data.config_json, {});
  const bound = new Set(require('./catalog').defaultCatalog().map(item => item.flowCode));
  data.binding_status = bound.has(data.flow_code) ? 'business' : 'standalone';
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
  const builtin = require('./catalog').defaultCatalog().find(item => item.flowCode === input.flowCode);
  if ((builtin && builtin.businessType !== input.businessType) || (existing && existing.business_type !== input.businessType)) ctx.throw(400, '流程编码已绑定业务类型，不可更改');
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
  if (input.flowCode !== row.flow_code || input.businessType !== row.business_type) ctx.throw(400, '已有流程的编码和业务类型不可修改，请仅调整名称和审批节点');
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
  let config;
  try { config = normalizeFlowConfig(row.config_json); } catch (error) { bodyError(ctx, error); }
  const fixedIds = config.nodes.flatMap(node => node.approvers).filter(rule => rule.type === 'fixed_user').map(rule => Number(rule.staffId));
  if (fixedIds.length) {
    const active = await Staff.findAll({ where: { staff_id: { [Op.in]: fixedIds }, status: 1, is_deleted: 0 }, attributes: ['staff_id'] });
    if (fixedIds.some(id => !active.some(staff => Number(staff.staff_id) === id))) ctx.throw(400, '流程包含不存在或已停用的审批人，请重新选择');
  }
  const roleCodes = [...new Set(config.nodes.flatMap(node => node.approvers).filter(rule => rule.type === 'role').map(rule => rule.roleCode))];
  if (roleCodes.length) {
    const activeRoles = await Role.findAll({ where: { role_code: { [Op.in]: roleCodes }, status: 1 }, attributes: ['role_code'] });
    if (roleCodes.some(code => !activeRoles.some(role => role.role_code === code))) ctx.throw(400, '流程包含不存在或已停用的审批角色，请重新选择');
  }
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
  const storeWhere = approvalInstanceVisibilityWhere(ctx.state.user);
  const instanceInclude = {
    model: ApprovalFlowInstance,
    as: 'Instance',
    attributes: ['instance_id', 'instance_no', 'business_type', 'business_id', 'title', 'summary', 'applicant_staff_id', 'subject_staff_id', 'store_id', 'status', 'resubmit_count', 'create_time']
  };
  if (storeWhere) {
    instanceInclude.where = storeWhere;
    instanceInclude.required = true;
  }
  instanceInclude.where = { ...(instanceInclude.where || {}), business_type: { [Op.notIn]: Object.keys(require('./businessRuntime').registry) } };
  instanceInclude.required = true;
  const tasks = await ApprovalTask.findAll({
    where,
    include: [instanceInclude],
    order: [['create_time', 'DESC']]
  });
  const settlementIds = tasks
    .filter(task => task.Instance?.business_type === 'payable_settlement')
    .map(task => String(task.Instance.business_id || ''))
    .filter(Boolean);
  const settlements = settlementIds.length ? await Settlement.findAll({
    where: { settlement_id: settlementIds, is_deleted: 0 },
    attributes: ['settlement_id', 'settlement_no', 'supplier_name', 'tax_status', 'total_amount', 'paid_amount', 'submit_time']
  }) : [];
  const settlementMap = new Map(settlements.map(row => [String(row.settlement_id), row.toJSON()]));
  ctx.body = tasks.map(task => {
    const data = task.toJSON();
    if (data.Instance?.business_type === 'payable_settlement') {
      const settlement = settlementMap.get(String(data.Instance.business_id));
      data.Instance.display = settlement ? {
        settlement_no: settlement.settlement_no,
        supplier_name: settlement.supplier_name,
        tax_status: settlement.tax_status,
        amount: Number(settlement.total_amount || 0),
        paid_amount: Number(settlement.paid_amount || 0),
        submit_time: settlement.submit_time
      } : {};
    }
    return data;
  });
}

function instanceAccessWhere(user, scope) {
  if (scope === 'all' && isAdmin(user)) return {};
  return { [Op.or]: [{ applicant_staff_id: user.staffId }, { subject_staff_id: user.staffId }] };
}

async function listInstances(ctx) {
  const scope = ctx.query.scope || 'mine';
  const where = scope === 'todo' ? {} : { [Op.and]: [instanceAccessWhere(ctx.state.user, scope)] };
  const storeWhere = approvalInstanceVisibilityWhere(ctx.state.user);
  if (storeWhere) where[Op.and] = [...(where[Op.and] || []), storeWhere];
  if (scope === 'todo') {
    const taskInclude = {
      model: ApprovalFlowInstance,
      as: 'Instance',
      attributes: [],
      required: Boolean(storeWhere),
      ...(storeWhere ? { where: storeWhere } : {})
    };
    const taskRows = await ApprovalTask.findAll({
      where: { assignee_staff_id: ctx.state.user.staffId },
      include: [taskInclude],
      attributes: ['instance_id'],
      raw: true
    });
    where.instance_id = taskRows.length ? taskRows.map(row => row.instance_id) : '';
  }
  if (ctx.query.status) where.status = ctx.query.status;
  const rows = await ApprovalFlowInstance.findAll({ where, order: [['create_time', 'DESC']], limit: Math.min(Number(ctx.query.limit || 100), 500) });
  ctx.body = rows.map(toInstance);
}

async function canReadInstance(ctx, instance) {
  const managed = parseJson(instance.payload_json, {}).managedBusiness;
  if (managed ? !require('./businessRuntime').visible(ctx.state.user, instance) : !canReadApprovalStore(ctx.state.user, instance.store_id, instance.business_type, instance.distributor_id)) return false;
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
  const data = toInstance(row);
  if (data.business_type === 'payable_settlement') {
    const settlement = await Settlement.findOne({
      where: { settlement_id: data.business_id, is_deleted: 0 },
      attributes: ['payee_name', 'supplier_name', 'supplier_account_snapshot', 'other_payment_remark']
    });
    const snapshot = parseJson(settlement?.supplier_account_snapshot, {}) || {};
    data.counterparty_payment_info = {
      payeeName: settlement?.payee_name || settlement?.supplier_name || '',
      companyName: snapshot.companyName || '',
      bankName: snapshot.bankName || '',
      accountNumber: snapshot.accountNumber || '',
      taxNo: snapshot.taxNo || '',
      remark: snapshot.remark || settlement?.other_payment_remark || '',
      available: Boolean(snapshot.companyName || snapshot.bankName || snapshot.accountNumber || snapshot.taxNo || snapshot.remark || settlement?.other_payment_remark)
    };
  }
  ctx.body = data;
}

async function submitInstance(ctx) {
  const input = ctx.request.body || {};
  if (['storeId', 'distributorId', 'initialNodeIndex'].some(key => input[key] !== undefined)) ctx.throw(400, '审批归属和起始节点由业务单据确定，不可手动指定');
  if (input.payload?.managedBusiness || require('./businessRuntime').registry[input.businessType]) ctx.throw(400, '请从原业务单据提交审批');
  const selectedFlow = await ApprovalFlowDefinition.findOne({ where: input.flowId ? { definition_id: input.flowId } : { flow_code: input.flowCode || '' }, order: [['version', 'DESC']] });
  if (selectedFlow && require('./businessRuntime').registry[selectedFlow.business_type]) ctx.throw(400, '请从原业务单据提交审批');
  try {
    const row = await createInstance(ctx.request.body || {}, ctx.state.user);
    ctx.body = { code: 0, message: '审批申请已提交', data: toInstance(row) };
  } catch (error) { bodyError(ctx, error); }
}

async function action(ctx) {
  const instance = await ApprovalFlowInstance.findByPk(ctx.params.instanceId);
  if (instance && parseJson(instance.payload_json, {}).managedBusiness) {
    return require('./businessRuntime').dispatch(ctx, instance.business_type, instance.business_id, ctx.request.body?.action, ctx.request.body?.comment || '');
  }
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
