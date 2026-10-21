const M = require('../../models');
const { generateUUID } = require('../../utils');
const { freezeSalesReportReward } = require('./rewardConfig');
const { educationSnapshot } = require('./educationReward');
async function submit(ctx) {
  const { snId, orderNo, attachmentUrl } = ctx.request.body || {};
  if (!snId || !orderNo || !attachmentUrl) ctx.throw(400, '请填写SN、销售单号并上传完成截图');
  await M.sequelize.transaction(async transaction => {
    const order = await M.Order.findOne({ where: { order_no: String(orderNo).trim(), is_deleted: 0 }, transaction, lock: transaction.LOCK.UPDATE });
    if (!order || !['已归档', 'completed', 'archived'].includes(order.order_status)) ctx.throw(409, '仅支持已归档销售订单');
    if (!require('../approval/service').canReadApprovalStore(ctx.state.user, order.store_id)) ctx.throw(403, '无权操作该门店订单');
    const roles = ctx.state.user.roles?.length ? ctx.state.user.roles : String(ctx.state.user.roleCode || '').split(',');
    if (!roles.some(role => ['boss', 'admin', 'finance', 'manager', 'store_manager', 'store_admin'].includes(role)) && Number(order.create_staff_id) !== Number(ctx.state.user.staffId)) ctx.throw(403, '仅订单销售员可提交本单教育补贴');
    const sn = await M.ProductSn.findByPk(snId, { transaction, lock: transaction.LOCK.UPDATE });
    const item = await M.OrderItem.findOne({ where: { order_id: order.order_id, sn_id: snId }, transaction });
    if (!sn || sn.is_deleted || !item || String(item.product_id) !== String(sn.product_id)) ctx.throw(409, '销售单中没有对应的有效SN商品');
    const right = await M.InventoryResourceRight.findOne({ where: { sn_id: snId, resource_type: 'EDU_SUBSIDY' }, transaction, lock: transaction.LOCK.UPDATE });
    if (!right || right.current_status !== 'AVAILABLE') ctx.throw(409, '教育补贴资格已使用或不可补录');
    const existing = await M.ResourceRightChangeOrder.findOne({ where: { related_sale_order_id: order.order_id, sn_id: snId, resource_type: 'EDU_SUBSIDY' }, transaction });
    if (existing) ctx.throw(409, '已有教育补贴记录，请从原任务上传或核对历史记录');
    const prior = await M.PerformanceProfitAdjustment.findOne({ where: { adjustment_no: `AUTO-${String(order.order_id).slice(0,12)}-${item.item_id}-EDU_SUBSIDY` }, transaction });
    if (prior) ctx.throw(409, '历史教育补贴已入账，不可重复增加毛利');
    const category = await M.ResourceCategory.findOne({ where: { category_code: 'EDU_SUBSIDY', status: 1 }, transaction });
    if (!category) ctx.throw(409, '教育补贴权益类别未启用');
    const snapshot = await freezeSalesReportReward({ category, item, order, transaction });
    const amount = educationSnapshot({ reward_snapshot_json: snapshot }).amount;
    const id = generateUUID();
    const task = await M.ResourceRightChangeOrder.create({ change_id: id, change_order_no: `EDU${id}`, sn_id: snId, sn_code: sn.sn_code,
      product_id: sn.product_id, resource_type: 'EDU_SUBSIDY', before_status: 'AVAILABLE', after_status: 'LOCKED', change_amount: amount,
      change_reason: 'SALE_RESOURCE_TASK', approval_status: 'pending_manager_review', related_sale_order_id: order.order_id,
      attachment_url: JSON.stringify([attachmentUrl]), reward_snapshot_json: snapshot,
      applicant_staff_id: ctx.state.user.staffId, applicant_name: ctx.state.user.name || '',
      remark: `教育补贴补录申请，待店长→张欢→邓红梅审批；配置金额${amount}元，未增加毛利` }, { transaction });
    await right.update({ current_status: 'LOCKED', locked_source_type: 'SALE_ORDER', locked_source_id: order.order_id,
      version: Number(right.version || 0) + 1, update_time: new Date() }, { transaction });
    ctx.body = { message: '教育补贴截图已提交三级审批，全部通过后确认毛利', data: { changeOrderNo: task.change_order_no, amount } };
  });
}
module.exports = { submit };
