const { Op } = require('sequelize');
const {
  sequelize,
  Staff,
  Role,
  StaffStorePermission,
  ApprovalFlowDefinition,
  ApprovalFlowInstance,
  ApprovalTask,
  ApprovalActionLog
} = require('../../models');
const { generateUUID } = require('../../utils');

const APPROVER_TYPES = new Set([
  'fixed_user',
  'store_manager',
  'direct_supervisor',
  'role'
]);

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try { return value ? JSON.parse(value) : fallback; } catch (error) { return fallback; }
}

function normalizeFlowConfig(config) {
  const input = parseJson(config, {});
  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  if (nodes.length === 0) throw new Error('审批流程至少需要一个审批节点');
  return {
    nodes: nodes.map((node, index) => {
      const signMode = node.signMode || node.sign_mode || 'serial';
      if (!['serial', 'or'].includes(signMode)) throw new Error(`第${index + 1}个节点的签批方式无效`);
      const approvers = Array.isArray(node.approvers) ? node.approvers : [];
      if (approvers.length === 0) throw new Error(`第${index + 1}个审批节点未配置审批人`);
      approvers.forEach(rule => {
        if (!APPROVER_TYPES.has(rule.type)) throw new Error(`审批人类型不支持：${rule.type}`);
        if (rule.type === 'fixed_user' && !rule.staffId && !rule.staff_id) throw new Error('指定人员审批必须填写员工');
        if (rule.type === 'role' && !rule.roleCode && !rule.role_code) throw new Error('角色审批必须填写角色');
      });
      return {
        name: String(node.name || `审批节点${index + 1}`).trim(),
        signMode,
        approvers: approvers.map(rule => ({
          type: rule.type,
          staffId: rule.staffId || rule.staff_id || undefined,
          roleCode: rule.roleCode || rule.role_code || undefined,
          scope: rule.scope || 'subject_store'
        }))
      };
    })
  };
}

function nextInstanceNo() {
  return `AP${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function asStaffId(value) {
  return value === undefined || value === null || value === '' ? null : Number(value);
}

function getApprovalStoreIds(user = {}) {
  const roles = user.roles || user.roleCode || [];
  const normalizedRoles = Array.isArray(roles)
    ? roles.map(role => String(role || '').trim().toLowerCase()).filter(Boolean)
    : String(roles || '').split(',').map(role => role.trim().toLowerCase()).filter(Boolean);
  // 只有 BOSS 是系统全局范围；admin、财务及其他经销商级账号仍必须受
  // auth middleware 生成的 accessibleStoreIds 限制，避免审批列表/详情放大到全系统。
  if (normalizedRoles.includes('boss')) return null;
  const storeIds = Array.isArray(user.accessibleStoreIds)
    ? [...new Set(user.accessibleStoreIds.map(value => String(value || '').trim()).filter(Boolean))]
    : [];
  return storeIds.includes('*') ? null : storeIds;
}

function getApprovalStoreWhere(user = {}) {
  const storeIds = getApprovalStoreIds(user);
  if (storeIds === null) return null;
  return { store_id: storeIds.length ? { [Op.in]: storeIds } : '__NO_STORE__' };
}

function canReadApprovalStore(user = {}, storeId, businessType = '') {
  const storeIds = getApprovalStoreIds(user);
  if (storeIds === null) return true;
  if (!storeId && businessType === 'payable_settlement') return true;
  return Boolean(storeId) && storeIds.includes(String(storeId));
}

function assertApprovalStoreVisible(user = {}, storeId) {
  if (!canReadApprovalStore(user, storeId)) throw new Error('无权访问该门店的审批记录');
}

async function getSubject(subjectStaffId, transaction) {
  const subject = await Staff.findByPk(subjectStaffId, { transaction });
  if (!subject || subject.status !== 1 || subject.is_deleted) throw new Error('审批主题员工不存在或已停用');
  return subject;
}

async function resolveRule(rule, subject, transaction) {
  const type = rule.type;
  if (type === 'store_manager') {
    if (!subject.store_id) return [];
    const managerRoles = ['manager', 'store_manager', 'store_admin'];
    const managerCandidates = await Staff.findAll({
      where: {
        status: 1,
        is_deleted: 0,
        ...(subject.distributor_id ? { distributor_id: subject.distributor_id } : {})
      },
      include: [{
        model: Role,
        as: 'Roles',
        attributes: ['role_code'],
        through: { attributes: [] },
        required: false
      }],
      attributes: ['staff_id', 'role_code'],
      transaction
    });
    const managerIds = managerCandidates
      .filter(staff => managerRoles.includes(String(staff.role_code || '').trim().toLowerCase())
        || (staff.Roles || []).some(role => managerRoles.includes(String(role.role_code || '').trim().toLowerCase())))
      .map(staff => Number(staff.staff_id))
      .filter(Boolean);
    if (!managerIds.length) return [];
    const permissions = await StaffStorePermission.findAll({
      where: { staff_id: { [Op.in]: managerIds }, store_id: subject.store_id },
      attributes: ['staff_id'],
      transaction
    });
    return [...new Set(permissions.map(row => Number(row.staff_id)).filter(Boolean))];
  }
  if (type === 'direct_supervisor') return subject.supervisor_staff_id ? [Number(subject.supervisor_staff_id)] : [];
  if (type === 'fixed_user') return rule.staffId ? [Number(rule.staffId)] : [];

  const roleCode = String(rule.roleCode || '').trim();
  const roleUsers = await Staff.findAll({
    where: {
      status: 1,
      is_deleted: 0,
      ...(subject.distributor_id && roleCode !== 'boss' ? { distributor_id: subject.distributor_id } : {})
    },
    include: [{ model: Role, as: 'Roles', where: { role_code: roleCode, status: 1 }, attributes: [], through: { attributes: [] }, required: true }],
    attributes: ['staff_id'],
    transaction
  });
  let ids = roleUsers.map(row => Number(row.staff_id));
  const scope = rule.scope || 'subject_store';
  if (scope === 'subject_store') {
    if (!subject.store_id) return [];
    const permissions = await StaffStorePermission.findAll({
      where: { staff_id: ids.length ? { [Op.in]: ids } : [], store_id: subject.store_id },
      attributes: ['staff_id'],
      transaction
    });
    ids = permissions.map(row => Number(row.staff_id));
  }
  return ids;
}

async function resolveApprovers(node, instance, transaction) {
  const subject = await getSubject(instance.subject_staff_id, transaction);
  const ids = [];
  const fixedUserIds = new Set();
  for (const rule of node.approvers || []) {
    if (rule.type === 'fixed_user' && rule.staffId) fixedUserIds.add(Number(rule.staffId));
    ids.push(...await resolveRule(rule, subject, transaction));
  }
  const candidates = ids.length ? await Staff.findAll({
    where: { staff_id: { [Op.in]: [...new Set(ids)] }, status: 1, is_deleted: 0 },
    include: [{ model: Role, as: 'Roles', attributes: ['role_code'], through: { attributes: [] }, required: false }],
    transaction
  }) : [];
  const unique = candidates
    .filter(staff => fixedUserIds.has(Number(staff.staff_id))
      || !subject.distributor_id
      || staff.distributor_id === subject.distributor_id
      || (staff.Roles || []).some(role => role.role_code === 'boss'))
    .map(staff => Number(staff.staff_id))
    .filter(id => id);
  if (!unique.length) throw new Error(`审批节点“${node.name}”未解析到可用审批人，请检查门店店长、直属上级或角色范围配置`);
  return unique;
}

async function writeLog(instanceId, taskId, action, actor, comment, detail, transaction) {
  return ApprovalActionLog.create({
    log_id: generateUUID(),
    instance_id: instanceId,
    task_id: taskId || null,
    action,
    actor_staff_id: actor.staffId,
    actor_name: actor.name,
    comment: comment || '',
    detail_json: detail ? JSON.stringify(detail) : null
  }, { transaction });
}

async function completeBusinessApproval(instance, transaction, actor, comment = '') {
  if (instance.business_type === 'payable_settlement') {
    const { applyPayableSettlementApproval } = require('../finance/payableController');
    await applyPayableSettlementApproval(instance, transaction, actor, 'approved', comment);
    return;
  }
  if (instance.business_type !== 'sn_change') return;
  const { applySnChangeApplication } = require('../inventory/snChangeApplication');
  await applySnChangeApplication(instance, transaction, actor);
}

async function rejectBusinessApproval(instance, transaction, actor, comment = '') {
  if (instance.business_type !== 'payable_settlement') return;
  const { applyPayableSettlementApproval } = require('../finance/payableController');
  await applyPayableSettlementApproval(instance, transaction, actor, 'rejected', comment);
}

async function createNodeTasks(instance, config, nodeIndex, roundNo, transaction, actor = null, completionComment = '') {
  const node = config.nodes[nodeIndex];
  if (!node) {
    await instance.update({ status: 'approved', completed_time: new Date(), update_time: new Date() }, { transaction });
    await completeBusinessApproval(instance, transaction, actor, completionComment);
    return;
  }
  const assigneeIds = await resolveApprovers(node, instance, transaction);
  const rows = assigneeIds.map((staffId, index) => ({
    task_id: generateUUID(),
    instance_id: instance.instance_id,
    node_index: nodeIndex,
    node_name: node.name,
    sign_mode: node.signMode,
    round_no: roundNo,
    task_order: index,
    assignee_staff_id: staffId,
    status: node.signMode === 'or' || index === 0 ? 'pending' : 'waiting'
  }));
  await ApprovalTask.bulkCreate(rows, { transaction });
  await instance.update({ current_node_index: nodeIndex, status: 'pending', update_time: new Date() }, { transaction });
}

async function startInstance(input, actor, transaction) {
  const flow = await ApprovalFlowDefinition.findOne({
    where: {
      status: 'published',
      ...(input.flowId ? { definition_id: input.flowId } : { flow_code: input.flowCode }),
      ...(input.businessType ? { business_type: input.businessType } : {})
    },
    order: [['version', 'DESC']],
    transaction
  });
  if (!flow) throw new Error('没有找到已发布的审批流程');
  const config = normalizeFlowConfig(flow.config_json);
  const subjectStaffId = asStaffId(input.subjectStaffId) || Number(actor.staffId);
  const subject = await getSubject(subjectStaffId, transaction);
  if (actor.distributorId && subject.distributor_id !== actor.distributorId && !actor.roles?.includes('boss')) {
    throw new Error('审批主题员工不在当前经销商范围内');
  }
  if (!(flow.business_type === 'payable_settlement' && !subject.store_id)) {
    assertApprovalStoreVisible(actor, subject.store_id);
  }
  if (!input.businessId) throw new Error('业务单据ID不能为空');
  const instance = await ApprovalFlowInstance.create({
    instance_id: generateUUID(),
    instance_no: nextInstanceNo(),
    definition_id: flow.definition_id,
    definition_version: flow.version,
    business_type: flow.business_type,
    business_id: String(input.businessId),
    title: String(input.title || flow.name).slice(0, 255),
    summary: String(input.summary || '').slice(0, 1000),
    applicant_staff_id: Number(actor.staffId),
    subject_staff_id: subject.staff_id,
    distributor_id: subject.distributor_id,
    store_id: subject.store_id,
    current_node_index: 0,
    status: 'pending',
    resubmit_count: 0,
    payload_json: input.payload === undefined ? null : JSON.stringify(input.payload),
    definition_snapshot_json: JSON.stringify(config)
  }, { transaction });
  await createNodeTasks(instance, config, 0, 0, transaction);
  await writeLog(instance.instance_id, null, 'submit', actor, input.comment, { flowCode: flow.flow_code, version: flow.version }, transaction);
  return instance;
}

async function createInstance(input, actor) {
  return sequelize.transaction(transaction => startInstance(input, actor, transaction));
}

async function actionInstance(instanceId, action, comment, actor) {
  if (!['approve', 'reject'].includes(action)) throw new Error('审批动作无效');
  if (action === 'reject' && !String(comment || '').trim()) throw new Error('拒绝时必须填写审批意见');
  return sequelize.transaction(async transaction => {
    const instance = await ApprovalFlowInstance.findByPk(instanceId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!instance) throw new Error('审批实例不存在');
    assertApprovalStoreVisible(actor, instance.store_id);
    if (instance.status !== 'pending') throw new Error('该审批实例当前不可处理');
    const task = await ApprovalTask.findOne({
      where: { instance_id: instanceId, round_no: instance.resubmit_count, assignee_staff_id: actor.staffId, status: 'pending', node_index: instance.current_node_index },
      order: [['task_order', 'ASC']],
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!task) throw new Error('当前账号没有该审批节点的待办任务');
    const now = new Date();
    await task.update({ status: action === 'approve' ? 'approved' : 'rejected', action, comment: comment || '', acted_time: now }, { transaction });
    await writeLog(instanceId, task.task_id, action, actor, comment, { nodeIndex: task.node_index, roundNo: instance.resubmit_count }, transaction);

    if (action === 'reject') {
      await rejectBusinessApproval(instance, transaction, actor, comment);
      if (task.sign_mode === 'or') {
        const remaining = await ApprovalTask.count({ where: { instance_id: instanceId, round_no: instance.resubmit_count, node_index: task.node_index, status: 'pending' }, transaction });
        if (remaining > 0) return instance;
      }
      await instance.update({ status: 'rejected', completed_time: now, update_time: now }, { transaction });
      return instance;
    }

    if (task.sign_mode === 'serial') {
      const nextTask = await ApprovalTask.findOne({ where: { instance_id: instanceId, round_no: instance.resubmit_count, node_index: task.node_index, status: 'waiting' }, order: [['task_order', 'ASC']], transaction });
      if (nextTask) {
        await nextTask.update({ status: 'pending' }, { transaction });
        return instance;
      }
    } else {
      await ApprovalTask.update({ status: 'cancelled', acted_time: now }, { where: { instance_id: instanceId, round_no: instance.resubmit_count, node_index: task.node_index, status: 'pending' }, transaction });
    }

    const config = parseJson(instance.definition_snapshot_json, {});
    await createNodeTasks(instance, config, Number(instance.current_node_index) + 1, instance.resubmit_count, transaction, actor, comment);
    return instance;
  });
}

async function resubmitInstance(instanceId, input, actor) {
  return sequelize.transaction(async transaction => {
    const instance = await ApprovalFlowInstance.findByPk(instanceId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!instance) throw new Error('审批实例不存在');
    assertApprovalStoreVisible(actor, instance.store_id);
    if (Number(instance.applicant_staff_id) !== Number(actor.staffId)) throw new Error('只有申请人可以重新提交');
    if (instance.status !== 'rejected') throw new Error('只有已拒绝的审批可以重新提交');
    const roundNo = Number(instance.resubmit_count || 0) + 1;
    await instance.update({
      status: 'pending',
      current_node_index: 0,
      resubmit_count: roundNo,
      title: input.title ? String(input.title).slice(0, 255) : instance.title,
      summary: input.summary !== undefined ? String(input.summary).slice(0, 1000) : instance.summary,
      payload_json: input.payload === undefined ? instance.payload_json : JSON.stringify(input.payload),
      completed_time: null,
      update_time: new Date()
    }, { transaction });
    await createNodeTasks(instance, parseJson(instance.definition_snapshot_json, {}), 0, roundNo, transaction, actor);
    if (instance.business_type === 'payable_settlement') {
      const { applyPayableSettlementApproval } = require('../finance/payableController');
      await applyPayableSettlementApproval(instance, transaction, actor, 'resubmitted', input.comment || '');
    }
    await writeLog(instanceId, null, 'resubmit', actor, input.comment, { roundNo }, transaction);
    return instance;
  });
}

module.exports = {
  APPROVER_TYPES,
  normalizeFlowConfig,
  parseJson,
  createInstance,
  startInstance,
  actionInstance,
  resubmitInstance,
  getApprovalStoreIds,
  getApprovalStoreWhere,
  canReadApprovalStore,
  assertApprovalStoreVisible
};
