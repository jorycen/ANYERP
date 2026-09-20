const M = require('../../models');
const { Op } = require('sequelize');
const S = require('./service');

// Business modules own their effects; this layer owns snapshots, tasks and votes.
const registry = {
  purchase_request: { model: 'PurchaseRequest', id: 'request_id', no: 'request_no', states: ['pending'], module: '../purchase/controller', handler: 'approveRequest', param: 'requestId', actionKey: 'status', past: true },
  product_application: { model: 'ProductApplication', id: 'application_id', no: 'application_no', states: ['pending'], module: '../product/controller', handler: 'reviewProductApplication', param: 'applicationId', past: true },
  sales_return: { model: 'SalesReturnRequest', id: 'return_id', no: 'return_no', states: ['pending'], module: '../sales/controller', handler: 'reviewSalesReturn', param: 'returnId', past: true, stages: ['pending_store', 'pending_duan', 'pending_deng', 'pending_li'] },
  deposit_refund: { model: 'DepositRefund', id: 'refund_id', no: 'refund_no', states: ['pending'], module: '../sales/controller', handler: 'reviewDepositRefund', param: 'refundId', past: true, stages: ['pending_store', 'pending_deng', 'pending_li'] },
  return_stock: { model: 'ReturnStock', id: 'return_id', no: 'return_no', states: ['pending'], module: '../inventory/controller', handler: 'approveReturn', bodyId: 'returnId', past: true },
  resource_claim: { model: 'ResourceRightChangeOrder', id: 'change_id', no: 'change_order_no', status: 'approval_status', states: ['pending_finance'], module: '../inventory/resourceRights', handler: 'reviewClaim', param: 'changeId' },
  profit_adjustment: { model: 'PerformanceProfitAdjustment', id: 'adjustment_id', no: 'adjustment_no', states: ['pending_finance', 'pending_admin'], module: '../report/profitAdjustmentController', handler: 'approveProfitAdjustment', reject: 'rejectProfitAdjustment', param: 'adjustmentId' },
  subsidy_receivable_adjustment: { model: 'SubsidyReceivableAdjustment', id: 'adjustment_id', states: ['PENDING'], module: '../finance/controller', handler: 'reviewSubsidyAdjustment', param: 'id' },
  expense_performance_allocation: { model: 'ExpensePerformanceAllocation', id: 'allocation_id', no: 'allocation_no', states: ['pending_finance', 'pending_admin'], module: '../finance/expenseAccountingController', handler: 'reviewExpensePerformanceAllocation', param: 'allocationId' },
  purchase_expense: { model: 'Expense', id: 'expense_id', no: 'expense_no', states: ['pending_approval'], extra: { [Op.or]: [{ source_type: { [Op.ne]: 'expense' } }, { source_type: { [Op.is]: null } }] }, module: '../finance/controller', handler: 'reviewExpense', param: 'id', past: true },
  sales_order_negative_gross_profit: { model: 'Order', id: 'order_id', no: 'order_no', status: 'order_status', states: ['pending_store_approval', 'pending_approval', 'pending_distributor_approval'], module: '../sales/controller', handler: 'approve', reject: 'reject', param: 'orderId' },
  inventory_transfer: { model: 'Transfer', id: 'transfer_id', no: 'transfer_no', states: ['pending'], store: 'from_store_id', manual: '/inventory/transfer' },
  inventory_transfer_receipt: { model: 'Transfer', id: 'transfer_id', no: 'transfer_no', states: ['out_confirmed'], store: 'to_store_id', manual: '/inventory/transfer' },
  inventory_batch: { model: 'InventoryBatchApplication', id: 'application_id', no: 'application_no', states: ['pending'], module: '../inventory/batchMaintenance', handler: 'reviewBatchApplication', param: 'applicationId' },
  sale_share: { model: 'ResourceRightChangeOrder', id: 'change_id', no: 'change_order_no', status: 'approval_status', states: ['pending_manager_review'], extra: { change_reason: 'SALE_RESOURCE_TASK' }, module: '../inventory/resourceRights', handler: 'reviewSaleResourceTask', param: 'changeId' }
};

function pending(type, row) {
  const d = registry[type];
  return d.states.includes(row[d.status || 'status']) && !row.is_deleted && !(type === 'purchase_expense' && row.source_type === 'expense');
}
function legacyIndex(type, row) {
  const d = registry[type];
  if (d.stages) return Math.max(0, d.stages.indexOf(row.approval_stage === 'pending_distributor' ? 'pending_li' : row.approval_stage));
  return row.status === 'pending_admin' || row.order_status === 'pending_distributor_approval' ? 1 : 0;
}
async function context(type, row, transaction) {
  const d = registry[type];
  let storeId = row[d.store || 'store_id'] || null;
  let staffId = row.applicant_staff_id || row.create_staff_id || row.applicant_id;
  if (type === 'deposit_refund') storeId = (await M.DepositOrder.findByPk(row.deposit_id, { transaction }))?.store_id;
  if (type === 'resource_claim') storeId = (await M.ProductSn.findByPk(row.sn_id, { transaction }))?.store_id;
  if (type === 'sale_share') storeId = (await M.Order.findByPk(row.related_sale_order_id, { transaction }))?.store_id;
  if (type === 'subsidy_receivable_adjustment') {
    const detail = await M.DailyStatementDetail.findByPk(row.detail_id, { transaction });
    storeId = detail ? (await M.DailyStatement.findByPk(detail.statement_id, { transaction }))?.store_id : null;
  }
  if (!staffId) {
    const name = row.create_user || row.apply_user || row.applicant_name;
    const identifiers = [{ name }, { phone: name }];
    if (/^[1-9]\d*$/.test(String(name || '')) && Number.isSafeInteger(Number(name))) identifiers.push({ staff_id: Number(name) });
    const matches = name ? await M.Staff.findAll({ where: { [Op.or]: identifiers }, limit: 2, transaction }) : [];
    if (matches.length === 1) staffId = matches[0].staff_id;
  }
  if (!staffId) throw Object.assign(new Error('无法唯一确认历史单据申请人，请补全申请人员工信息'), { status: 409 });
  const employee = await M.Staff.findByPk(staffId, { transaction });
  if (!employee) throw Object.assign(new Error('审批申请人员工记录不存在'), { status: 409 });
  if (type === 'product_application' && !storeId) storeId = employee.store_id;
  const store = storeId ? await M.Store.findByPk(storeId, { transaction }) : null;
  return { subject_staff_id: Number(staffId), store_id: storeId || null, distributor_id: store?.distributor_id || row.distributor_id || row.applicant_distributor_id || employee.distributor_id, employee };
}
function visible(user, info) {
  const { canAccessDistributor } = require('../../utils/distributorScope');
  return info.store_id ? S.canReadApprovalStore(user, info.store_id) : canAccessDistributor(user, info.distributor_id);
}
async function latest(type, row, transaction) {
  return M.ApprovalFlowInstance.findOne({ where: { business_type: type, business_id: String(row[registry[type].id]) }, order: [['create_time', 'DESC']], transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
}
async function begin(type, row, transaction, { historical = false } = {}) {
  if (!pending(type, row)) return null;
  const previous = await latest(type, row, transaction);
  if (previous?.status === 'pending') return previous;
  const info = await context(type, row, transaction);
  const employee = info.employee;
  const instance = await S.startInstance({ flowCode: type, businessType: type, businessId: row[registry[type].id],
    subjectStaffId: info.subject_staff_id, storeId: info.store_id, distributorId: info.distributor_id,
    initialNodeIndex: historical ? legacyIndex(type, row) : 0,
    title: `${row[registry[type].no] || row[registry[type].id]}`, summary: row.reason || row.remark || '',
    payload: { managedBusiness: true, businessNo: row[registry[type].no] || '', manualPath: registry[type].manual || null }
  }, { staffId: employee.staff_id, name: employee.name, roles: [], accessibleStoreIds: info.store_id ? [info.store_id] : [], distributorId: info.distributor_id }, transaction);
  return instance;
}

// Must be called with the business row locked, inside its existing transaction.
async function advance(ctx, type, row, transaction, action, comment = '') {
  if (!transaction) throw new Error('审批必须与业务变更使用同一事务');
  if (!['approve', 'approved', 'reject', 'rejected'].includes(action)) ctx.throw(400, '审批动作无效');
  if (!pending(type, row)) ctx.throw(409, '单据已处理，请刷新后重试');
  const info = await context(type, row, transaction);
  if (!visible(ctx.state.user, info)) ctx.throw(403, '无权审批该门店或经销商的单据');
  let instance = await latest(type, row, transaction);
  if (instance && instance.status !== 'pending') ctx.throw(409, '审批已处理，需从原单据重新提交');
  if (!instance) instance = await begin(type, row, transaction, { historical: true });
  const task = await M.ApprovalTask.findOne({ where: { instance_id: instance.instance_id, assignee_staff_id: ctx.state.user.staffId, status: 'pending', node_index: instance.current_node_index, round_no: instance.resubmit_count }, transaction });
  if (!task) ctx.throw(403, '当前账号不是该节点的待审批人');
  // Generic service handles store-less documents using their distributor scope here.
  const actor = { ...ctx.state.user, approvalDistributorId: info.distributor_id };
  instance = await S.actionInstance(instance.instance_id, ['approve', 'approved'].includes(action) ? 'approve' : 'reject', comment, actor, { transaction, managedBusiness: true });
  ctx.state.businessApproval = { status: instance.status, instanceId: instance.instance_id };
  if (instance.status === 'pending') {
    ctx.body = { code: 0, status: 'pending', message: '本次审批已记录，等待其他审批人或下一节点', data: { instanceId: instance.instance_id } };
    return false;
  }
  return true;
}

async function dispatch(ctx, type, id, action, comment) {
  const d = registry[type];
  if (!d || !['approve', 'reject'].includes(action)) ctx.throw(400, '审批类型或动作无效');
  if (d.manual) ctx.throw(400, '请进入调拨管理选择实物并上传凭证后确认');
  const child = Object.create(ctx);
  child.state = { ...ctx.state };
  child.params = { ...ctx.params, [d.param || 'id']: id };
  child.request = Object.create(ctx.request);
  child.request.body = { ...(ctx.request.body?.businessData || {}), [d.actionKey || 'action']: d.past ? (action === 'approve' ? 'approved' : 'rejected') : action, comment, reason: comment, ...(d.bodyId ? { [d.bodyId]: id } : {}) };
  await require(d.module)[action === 'reject' && d.reject ? d.reject : d.handler](child);
  ctx.body = child.body;
  if (child.state.businessApproval?.status === 'pending') ctx.body = { code: 0, status: 'pending', message: '本次审批已记录，等待其他审批人或下一节点' };
}

async function listBusinessTasks(ctx, onlyType = null) {
  const tasks = [], issues = [];
  for (const [type, d] of Object.entries(registry)) {
    if (onlyType && onlyType !== type) continue;
    // 需要选择实物、扫码或上传凭证的人工业务必须在原业务页面处理。
    // 手机端一直按此口径展示；统一审批中心不再重复列出调拨出/入库确认。
    if (!onlyType && d.manual) continue;
    const model = M[d.model];
    const where = { [d.status || 'status']: { [Op.in]: d.states }, ...d.extra };
    if (model.rawAttributes.is_deleted) where.is_deleted = 0;
    const storeIds = S.getApprovalStoreIds(ctx.state.user);
    const storeField = d.store || 'store_id';
    if (storeIds !== null && model.rawAttributes[storeField] && type !== 'product_application') {
      where[Op.and] = [{ [Op.or]: [{ [storeField]: { [Op.in]: storeIds } }, { [storeField]: { [Op.is]: null } }, { [storeField]: '' }] }];
    }
    let configuredFlow;
    let offset = 0;
    while (true) {
      const rows = await model.findAll({ where, order: [[d.id, 'ASC']], limit: 200, offset });
      for (const row of rows) {
        try {
          const info = await context(type, row);
          if (!visible(ctx.state.user, info)) continue;
          const instance = await latest(type, row);
          if (instance && instance.status !== 'pending') throw new Error('审批与业务状态不一致，请核对原单据后重新提交');
          let nodeName, canReview = false;
          if (instance?.status === 'pending') {
            const task = await M.ApprovalTask.findOne({ where: { instance_id: instance.instance_id, assignee_staff_id: ctx.state.user.staffId, status: 'pending', node_index: instance.current_node_index, round_no: instance.resubmit_count } });
            canReview = Boolean(task); nodeName = task?.node_name;
          } else {
            if (configuredFlow === undefined) configuredFlow = await M.ApprovalFlowDefinition.findOne({ where: { flow_code: type, status: 'published' }, order: [['version', 'DESC']] });
            const flow = configuredFlow;
            if (!flow) throw new Error('流程未发布或已停用');
            const node = S.normalizeFlowConfig(flow.config_json).nodes[legacyIndex(type, row)];
            if (!node) throw new Error('历史审批阶段与配置不匹配，请核对流程');
            const ids = await S.resolveApprovers(node, info);
            canReview = node.signMode === 'serial' ? ids[0] === Number(ctx.state.user.staffId) : ids.includes(Number(ctx.state.user.staffId));
            nodeName = node.name;
          }
          if (canReview) tasks.push({ business_type: type, business_id: String(row[d.id]), business_no: row[d.no] || row[d.id], node_name: nodeName, instance_id: instance?.instance_id, manual_path: d.manual || null, row: row.toJSON() });
        } catch (error) {
          if (ctx.state.user.roles?.some(role => ['admin', 'boss'].includes(role))) issues.push({ businessType: type, message: error.message });
        }
      }
      if (rows.length < 200) break;
      offset += rows.length;
    }
  }
  ctx.body = { code: 0, data: tasks, issues: [...new Map(issues.map(item => [`${item.businessType}:${item.message}`, item])).values()] };
}

let hooksInstalled = false;
function installHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  for (const [type, d] of Object.entries(registry)) {
    const save = async (row, options) => {
      if (!pending(type, row)) {
        if (options.transaction && d.states.includes(row.previous(d.status || 'status'))) {
          const instance = await latest(type, row, options.transaction);
          if (instance?.status === 'pending') {
            await instance.update({ status: 'cancelled', completed_time: new Date() }, { transaction: options.transaction });
            await M.ApprovalTask.update({ status: 'cancelled' }, { where: { instance_id: instance.instance_id, status: { [Op.in]: ['pending', 'waiting'] } }, transaction: options.transaction });
          }
        }
        return;
      }
      const field = d.status || 'status';
      if (!row.isNewRecord && row.previous(field) === row[field]) return;
      // Legacy nontransactional paths are resolved on first review. Never commit
      // an approval separately from a caller's business transaction.
      if (options.transaction) await begin(type, row, options.transaction);
    };
    M[d.model].addHook('afterSave', `approval_${type}`, save);
    M[d.model].addHook('afterBulkCreate', `approval_${type}`, async (rows, options) => {
      if (options.transaction) for (const row of rows) if (pending(type, row)) await begin(type, row, options.transaction);
    });
  }
}
async function reviewList(ctx, type) {
  if (ctx.query.scope !== 'review') return false;
  await listBusinessTasks(ctx, type);
  const rows = ctx.body.data.map(item => ({ ...item.row, approval_node_name: item.node_name, approval_instance_id: item.instance_id, can_review: true })).filter(row => {
    const q = ctx.query;
    if (q.storeId && String(row.store_id || '') !== String(q.storeId)) return false;
    if (q.expenseId && String(row.expense_id || '') !== String(q.expenseId)) return false;
    if (q.orderNo && !String(row.order_no || '').includes(q.orderNo)) return false;
    if (q.snCode && !String(row.sn_code || '').includes(q.snCode)) return false;
    return true;
  });
  const page = Math.max(1, Number(ctx.query.page) || 1), pageSize = Math.min(200, Math.max(1, Number(ctx.query.pageSize) || 20));
  ctx.body = { code: 0, data: { list: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize }, issues: ctx.body.issues };
  return true;
}
module.exports = { registry, pending, legacyIndex, context, visible, begin, advance, dispatch, listBusinessTasks, reviewList, installHooks };
