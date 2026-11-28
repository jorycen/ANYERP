const { Op } = require('sequelize');
const M = require('../../models');
const { generateUUID } = require('../../utils');
const { configObject } = require('./rewardRules');
const money = value => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
function splitEducation(amount) {
  const total = money(amount), employee = money(total * 0.8);
  return { amount: total, employeeAmount: employee, productAmount: money(total - employee) };
}
function educationSnapshot(task) {
  const snapshot = configObject(task.reward_snapshot_json);
  const split = splitEducation(snapshot.amount);
  if (snapshot.accountingVersion !== 2 || snapshot.resourceType !== 'EDU_SUBSIDY' || !(split.amount > 0)
    || split.employeeAmount !== snapshot.employeeAmount || split.productAmount !== snapshot.productAmount) {
    throw Object.assign(new Error('教育补贴未配置有效金额或快照异常，请核查权益规则'), { status: 409 });
  }
  return { ...snapshot, ...split };
}
async function postEducation({ task, order, item, transaction }) {
  const snapshot = educationSnapshot(task);
  const no = `AUTO-${String(order.order_id).slice(0, 12)}-${item.item_id}-EDU_SUBSIDY`;
  const existing = await M.PerformanceProfitAdjustment.findOne({ where: { adjustment_no: no }, transaction });
  if (existing) throw Object.assign(new Error('该商品教育补贴已计入过毛利，不能重复增加，请核对历史记录'), { status: 409 });
  await M.PerformanceProfitAdjustment.create({
    adjustment_id: generateUUID(), adjustment_no: no, order_id: order.order_id, order_no: order.order_no,
    store_id: order.store_id, employee_name: order.create_user || '', adjustment_type: 'increase',
    amount: snapshot.employeeAmount, signed_amount: snapshot.employeeAmount, base_gross_profit: 0,
    reason: `教育补贴三级审批通过；补贴${snapshot.amount}元，员工80%=${snapshot.employeeAmount}元，产品端20%=${snapshot.productAmount}元待返利核销；任务${task.change_id}`,
    status: 'approved', applicant_staff_id: task.applicant_staff_id, applicant_name: task.applicant_name,
    finance_reviewer_id: 0, finance_reviewer_name: '权益审批流程', finance_review_time: new Date(),
    admin_reviewer_id: 0, admin_reviewer_name: '权益审批流程', admin_review_time: new Date(),
    create_time: new Date(), update_time: new Date()
  }, { transaction });
  return snapshot;
}
// A single confirmed task is the full company income. 80%/20% are allocations,
// never additional company income. Historical (unversioned) tasks are excluded.
async function educationIncome({ orderIds, storeIds, startDate, endDate, transaction } = {}) {
  if ((orderIds && !orderIds.length) || (storeIds && !storeIds.length)) return [];
  const where = { resource_type: 'EDU_SUBSIDY', approval_status: 'completed',
    change_reason: { [Op.in]: ['SALE_RESOURCE_TASK', 'EDU_REWARD_RETURN'] } };
  if (orderIds) where.related_sale_order_id = { [Op.in]: orderIds };
  const tasks = await M.ResourceRightChangeOrder.findAll({ where, raw: true, transaction });
  const versioned = tasks.filter(task => {
    try { return configObject(task.reward_snapshot_json).accountingVersion === 2; } catch (_) { return false; }
  });
  if (!versioned.length) return [];
  const orderWhere = { order_id: { [Op.in]: [...new Set(versioned.map(row => row.related_sale_order_id))] }, is_deleted: 0 };
  if (storeIds) orderWhere.store_id = { [Op.in]: storeIds };
  if (startDate && endDate) orderWhere.create_time = { [Op.gte]: new Date(`${startDate}T00:00:00+08:00`), [Op.lt]: new Date(new Date(`${endDate}T00:00:00+08:00`).getTime() + 86400000) };
  const orders = await M.Order.findAll({ where: orderWhere, attributes: ['order_id', 'store_id'], raw: true, transaction });
  const allowed = new Set(orders.map(order => String(order.order_id)));
  const rows = versioned.filter(row => allowed.has(String(row.related_sale_order_id))).map(row => {
    const snapshot = educationSnapshot(row), sign = row.change_reason === 'EDU_REWARD_RETURN' ? -1 : 1;
    return { orderId: row.related_sale_order_id, itemId: snapshot.orderItemId, productId: row.product_id,
      amount: sign * snapshot.amount, employeeAmount: sign * snapshot.employeeAmount, productAmount: 0 };
  });
  const income = await M.ProductProfitIncome.findAll({ where: { entry_type: 'education', source_order_id: { [Op.in]: [...allowed] } }, raw: true, transaction });
  for (const entry of income) {
    const detail = configObject(entry.detail_json);
    rows.push({ orderId: entry.source_order_id, itemId: detail.orderItemId, productId: detail.productId,
      amount: 0, employeeAmount: 0, productAmount: Number(entry.amount || 0) });
  }
  return rows;
}
async function reverseEducation({ request, order, requestItems, orderItemMap, transaction }) {
  for (const returned of requestItems) {
    const item = orderItemMap.get(String(returned.order_item_id));
    if (!item?.sn_id) continue;
    const tasks = await M.ResourceRightChangeOrder.findAll({ where: { related_sale_order_id: order.order_id,
      sn_id: item.sn_id, resource_type: { [Op.in]: ['EDU_SUBSIDY', 'SALES_REPORT'] }, change_reason: 'SALE_RESOURCE_TASK' }, transaction, lock: transaction.LOCK.UPDATE });
    for (const task of tasks) {
      if (['pending_submit', 'pending_manager_review', 'rejected'].includes(task.approval_status)) {
        if (task.resource_type === 'EDU_SUBSIDY') {
          const right = await M.InventoryResourceRight.findOne({ where: { sn_id: item.sn_id, resource_type: 'EDU_SUBSIDY' }, transaction, lock: transaction.LOCK.UPDATE });
          if (right?.current_status === 'LOCKED' && right.locked_source_type === 'SALE_ORDER' && right.locked_source_id === order.order_id) {
            await right.update({ current_status: 'AVAILABLE', locked_source_type: null, locked_source_id: null,
              version: Number(right.version || 0) + 1, update_time: new Date() }, { transaction });
          }
        }
        await task.update({ approval_status: 'cancelled', remark: `退货单${request.return_no}取消权益审批` }, { transaction }); continue;
      }
      if (task.resource_type !== 'EDU_SUBSIDY' || task.approval_status !== 'completed' || !task.reward_snapshot_json) continue;
      const snapshot = educationSnapshot(task);
      const reversal = await M.ResourceRightChangeOrder.findOne({ where: { related_sale_order_id: order.order_id, sn_id: item.sn_id,
        resource_type: 'EDU_SUBSIDY', change_reason: 'EDU_REWARD_RETURN' }, transaction });
      if (reversal) continue;
      const id = generateUUID();
      await M.ResourceRightChangeOrder.create({ change_id: id, change_order_no: `EDUR${id}`, sn_id: item.sn_id,
        sn_code: item.sn_code, product_id: item.product_id, resource_type: 'EDU_SUBSIDY', before_status: 'USED', after_status: 'USED',
        change_reason: 'EDU_REWARD_RETURN', approval_status: 'completed', change_amount: -snapshot.amount,
        reward_snapshot_json: task.reward_snapshot_json, related_sale_order_id: order.order_id, related_order_id: request.return_id,
        review_time: new Date(), remark: `退货单${request.return_no}冲回已确认教育补贴` }, { transaction });
      const settlements = await M.ResourceSettlement.findAll({ where: { source_type: { [Op.in]: ['SALE_USE', 'EDU_PRODUCT_REBATE'] }, source_id: task.change_id, resource_type: 'EDU_SUBSIDY' }, transaction, lock: transaction.LOCK.UPDATE });
      for (const settlement of settlements) {
        await require('../report/productPolicyIncome').syncPolicyIncome(settlement, transaction, { name: 'system' }, true);
        if (settlement.status === 'CANCELLED') continue;
        if (settlement.status === 'PENDING' && Number(settlement.matched_amount || 0) === 0) {
          await settlement.update({ status: 'CANCELLED', remark: `${settlement.remark || ''}；退货${request.return_no}取消教育补贴待下账` }, { transaction });
        } else {
          await M.ResourceSettlement.create({ settlement_id: generateUUID(), settlement_no: `RST${id}`, source_type: 'EDU_REWARD_RETURN', source_id: id,
            sn_id: item.sn_id, sn_code: item.sn_code, product_id: item.product_id, resource_type: 'EDU_SUBSIDY',
            counterparty_id: settlement.counterparty_id, counterparty_name: settlement.counterparty_name,
            distributor_id: settlement.distributor_id, amount: -Number(settlement.amount), matched_amount: 0, status: 'PENDING',
            target_account_id: settlement.target_account_id, remark: `退货${request.return_no}冲回已确认教育补贴，保留原收款记录待财务核对` }, { transaction });
        }
      }
      await M.PerformanceProfitAdjustment.create({ adjustment_id: generateUUID(), adjustment_no: `EDUR-${task.change_id}`,
        order_id: order.order_id, order_no: order.order_no, store_id: order.store_id, employee_name: order.create_user || '',
        adjustment_type: 'decrease', amount: snapshot.employeeAmount, signed_amount: -snapshot.employeeAmount,
        base_gross_profit: 0, status: 'approved', reason: `退货${request.return_no}冲回教育补贴员工业绩80%`,
        applicant_staff_id: 0, applicant_name: 'system', finance_reviewer_id: 0, finance_reviewer_name: 'system', finance_review_time: new Date(),
        admin_reviewer_id: 0, admin_reviewer_name: 'system', admin_review_time: new Date(), create_time: new Date(), update_time: new Date() }, { transaction });
    }
  }
}
module.exports = { splitEducation, educationSnapshot, postEducation, educationIncome, reverseEducation };
