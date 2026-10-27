const crypto = require('crypto');
const M = require('../../models');
const runtime = require('./businessRuntime');
const service = require('./service');

const detailOnly = {
  sales_component_recovery: '请进入详情逐项确认回收成本',
  manufacturer_rebate_confirmation: '请进入详情填写厂商返利金额',
  product_application: '请进入详情确认商品资料'
};
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function instanceToken(instance, task) {
  return digest([String(instance.instance_id), instance.status, instance.current_node_index, instance.resubmit_count, String(task?.task_id || '')]);
}
async function pendingTask(instance, user, transaction) {
  return M.ApprovalTask.findOne({ where: { instance_id: instance.instance_id, round_no: instance.resubmit_count,
    node_index: instance.current_node_index, assignee_staff_id: user.staffId, status: 'pending' },
  order: [['task_order', 'ASC']], transaction });
}
async function businessToken(type, row, user, transaction) {
  const d = runtime.registry[type];
  const instance = await M.ApprovalFlowInstance.findOne({ where: { business_type: type, business_id: String(row[d.id]) },
    order: [['create_time', 'DESC']], transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
  const task = instance ? await pendingTask(instance, user, transaction) : null;
  let legacyFlow = null;
  if (instance && (instance.status !== 'pending' || !task)) throw new Error('当前账号没有该节点的待审批任务');
  if (!instance) {
    const flow = await M.ApprovalFlowDefinition.findOne({ where: { flow_code: type, status: 'published' }, order: [['version', 'DESC']], transaction });
    if (!flow) throw new Error('流程未发布或已停用');
    const node = service.normalizeFlowConfig(flow.config_json).nodes[runtime.legacyIndex(type, row)];
    if (!node) throw new Error('历史审批阶段与配置不匹配');
    const ids = await service.resolveApprovers(node, await runtime.context(type, row, transaction));
    const canReview = node.signMode === 'serial' ? ids[0] === Number(user.staffId) : ids.includes(Number(user.staffId));
    if (!canReview) throw new Error('当前账号不是该节点的待审批人');
    legacyFlow = [flow.definition_id, flow.version, flow.config_json];
  }
  return digest([type, String(row[d.id]), row[d.status || 'status'], row.approval_stage,
    row.update_time || row.updatedAt, instance ? instanceToken(instance, task) : legacyFlow]);
}
async function assertBusiness(ctx, type, row, transaction) {
  const expected = ctx.state.batchApprovalExpected;
  if (expected && expected !== await businessToken(type, row, ctx.state.user, transaction)) {
    ctx.throw(409, '审批状态已变化，请刷新后重新勾选');
  }
}
function input(ctx) {
  const items = ctx.request.body?.items;
  if (!Array.isArray(items) || !items.length || items.length > 100) ctx.throw(400, '每批请选择1至100条审批单');
  return items;
}
async function resolve(item, user) {
  if (!item || typeof item !== 'object') throw new Error('审批参数无效');
  let type = item.businessType;
  let id = item.businessId;
  if (item.kind === 'sales') type = 'sales_order_negative_gross_profit';
  if (item.kind === 'instance') {
    const instance = await M.ApprovalFlowInstance.findByPk(item.instanceId);
    if (!instance || !service.canReadApprovalStore(user, instance.store_id, instance.business_type, instance.distributor_id)) throw new Error('审批不存在或无权访问');
    let payload;
    try { payload = JSON.parse(instance.payload_json || '{}'); } catch (_) { payload = {}; }
    if (payload.managedBusiness) { type = instance.business_type; id = instance.business_id; }
    else {
      if (detailOnly[instance.business_type] || instance.business_type === 'product') throw new Error('请进入详情确认业务资料');
      if (instance.status !== 'pending') throw new Error('单据已处理，请刷新');
      const task = await pendingTask(instance, user);
      if (!task) throw new Error('当前账号没有该节点的待审批任务');
      return { canonical: `instance:${instance.instance_id}`, instanceId: instance.instance_id, token: instanceToken(instance, task) };
    }
  } else if (!['business', 'sales'].includes(item.kind)) throw new Error('审批类型无效');
  const d = runtime.registry[type];
  if (!d || d.manual || d.retired) throw new Error('请进入业务详情处理');
  if (detailOnly[type]) throw new Error(detailOnly[type]);
  const row = await M[d.model].findByPk(id);
  if (!row || !runtime.pending(type, row)) throw new Error('单据已处理或不存在，请刷新');
  if (!runtime.visible(user, await runtime.context(type, row))) throw new Error('无权审批该门店或经销商的单据');
  if (type === 'purchase_request') {
    const items = await M.PurchaseRequestItem.findAll({ where: { request_id: id } });
    if (items.some(item => Number(item.is_used_product) === 1 && !item.product_id)) throw new Error('请进入详情确认新建商品类别');
  }
  return { canonical: `business:${type}:${id}`, businessType: type, businessId: id, token: await businessToken(type, row, user) };
}
async function options(ctx) {
  const result = [];
  for (const item of input(ctx)) {
    try { const resolved = await resolve(item, ctx.state.user); result.push({ key: item.key, eligible: true, token: resolved.token }); }
    catch (error) { result.push({ key: item?.key, eligible: false, reason: error.message }); }
  }
  ctx.body = { code: 0, data: result };
}
async function approve(ctx) {
  const results = [], seen = new Set();
  for (const item of input(ctx)) {
    try {
      const resolved = await resolve(item, ctx.state.user);
      if (seen.has(resolved.canonical)) throw new Error('同一审批单不能重复处理');
      seen.add(resolved.canonical);
      if (!item.token || item.token !== resolved.token) throw new Error('审批状态已变化，请刷新后重新勾选');
      const child = Object.create(ctx);
      child.state = { ...ctx.state, batchApprovalExpected: resolved.token };
      child.request = Object.create(ctx.request);
      child.request.body = { action: 'approve', comment: '' };
      child.params = { ...ctx.params, instanceId: resolved.instanceId };
      // Isolate response/status setters: one failed item must not change the batch HTTP status.
      Object.defineProperty(child, 'body', { value: null, writable: true });
      Object.defineProperty(child, 'status', { value: 200, writable: true });
      if (resolved.instanceId) await require('./controller').action(child);
      else await runtime.dispatch(child, resolved.businessType, resolved.businessId, 'approve', '');
      // Some original handlers return {message,data}; the outer response formatter
      // normally adds code:0. Preserve that contract when invoking them internally.
      if (!child.body || child.status >= 400 || (child.body.code !== undefined && ![0, 200].includes(child.body.code))) throw new Error(child.body?.message || '审批失败');
      const pending = child.body.status === 'pending' || child.body.data?.status === 'pending';
      results.push({ key: item.key, success: true, pending, message: pending ? '本次审批已记录，等待其他审批人或下一节点' : '审批处理成功' });
    } catch (error) { results.push({ key: item?.key, success: false, message: error.message || '审批失败' }); }
  }
  ctx.body = { code: 0, data: { results, succeeded: results.filter(row => row.success).length, failed: results.filter(row => !row.success).length } };
}
module.exports = { options, approve, assertBusiness, instanceToken, resolve };
