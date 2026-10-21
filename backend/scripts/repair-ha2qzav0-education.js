// Explicitly authorized one-SN repair. Dry run by default; no profit posting.
const M = require('../src/models');
const { freezeSalesReportReward } = require('../src/modules/inventory/rewardConfig');
const { educationSnapshot } = require('../src/modules/inventory/educationReward');
const { recordBusinessAction } = require('../src/utils/businessActionLog');
const { generateUUID } = require('../src/utils');
async function repair(apply = false) {
  return M.sequelize.transaction(async transaction => {
    const task = await M.ResourceRightChangeOrder.findByPk('80c48609724044559e0415e45c3d2fb4', { transaction, lock: transaction.LOCK.UPDATE });
    if (!task || task.sn_code !== 'HA2QZAV0' || task.resource_type !== 'EDU_SUBSIDY' || task.approval_status !== 'pending_submit' || task.attachment_url) throw Error('Task changed; manual review required');
    const order = await M.Order.findByPk(task.related_sale_order_id, { transaction, lock: transaction.LOCK.UPDATE });
    const item = await M.OrderItem.findOne({ where: { order_id: order.order_id, sn_id: task.sn_id }, transaction });
    const right = await M.InventoryResourceRight.findOne({ where: { sn_id: task.sn_id, resource_type: 'EDU_SUBSIDY' }, transaction, lock: transaction.LOCK.UPDATE });
    if (!item || !right || !['已归档', 'completed', 'archived'].includes(order.order_status)) throw Error('Original order/right invalid');
    const posted = await M.PerformanceProfitAdjustment.findOne({ where: { adjustment_no: `AUTO-${order.order_id.slice(0, 12)}-${item.item_id}-EDU_SUBSIDY` }, transaction });
    const settlement = await M.ResourceSettlement.findOne({ where: { sn_id: task.sn_id, resource_type: 'EDU_SUBSIDY' }, transaction });
    if (posted || settlement) throw Error('Income/settlement exists; refusing pending-only repair');
    if (right.current_status === 'LOCKED' && Number(task.change_amount) === 200) return { message: 'Already repaired', amount: 200 };
    if (right.current_status !== 'USED' || Number(task.change_amount) !== 0 || Number(right.amount) !== 200) throw Error('Expected original zero-task/200-right mismatch not found');
    const category = await M.ResourceCategory.findOne({ where: { category_code: 'EDU_SUBSIDY', status: 1 }, transaction });
    const frozen = await freezeSalesReportReward({ category, item, order, transaction });
    const snapshot = educationSnapshot({ reward_snapshot_json: frozen });
    if (snapshot.amount !== 200) throw Error('Expected authorized 200 CNY; configuration changed');
    const before = { task: task.toJSON(), right: right.toJSON() };
    if (apply) {
      await task.update({ change_amount: 200, reward_snapshot_json: frozen, before_status: 'LOCKED', after_status: 'LOCKED',
        remark: `${task.remark || ''}；用户确认修正：原教育政策200元，待办理，审批前不确认收入` }, { transaction });
      await right.update({ current_status: 'LOCKED', locked_source_type: 'SALE_ORDER', locked_source_id: order.order_id,
        version: Number(right.version || 0) + 1, update_time: new Date() }, { transaction });
      await M.ResourceRightChangeOrder.create({ change_id: generateUUID(), change_order_no: `EDUFIX${Date.now()}`,
        sn_id: task.sn_id, sn_code: task.sn_code, product_id: task.product_id, resource_type: 'EDU_SUBSIDY',
        before_status: 'USED', after_status: 'LOCKED', change_amount: 200, change_reason: 'EDU_PENDING_REPAIR',
        approval_status: 'approved', related_sale_order_id: order.order_id, applicant_name: '系统（用户确认）',
        remark: '修正提前核销及零金额待办；保留原流水，不确认毛利或资金' }, { transaction });
      await recordBusinessAction({ businessType: 'sale_resource_reward', businessId: task.change_id, businessNo: task.change_order_no,
        action: 'repair', fromStatus: 'USED', toStatus: 'LOCKED', user: { name: '系统（用户确认）' },
        comment: '用户确认将HA2QZAV0教育补贴修正为200元待办理，审批前不确认毛利',
        detail: { before, after: { task: task.toJSON(), right: right.toJSON() } }, transaction });
    }
    return { apply, sn: task.sn_code, orderNo: order.order_no, status: 'pending_submit', rightStatus: apply ? right.current_status : 'LOCKED', ...snapshot };
  });
}
if (require.main === module) repair(process.argv.includes('--apply')).then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => M.sequelize.close());
module.exports = { repair };
