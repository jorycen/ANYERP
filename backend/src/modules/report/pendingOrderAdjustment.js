const { Op } = require('sequelize');
const { PerformanceProfitAdjustment } = require('../../models');

// Call after locking the order in a READ COMMITTED transaction. Approval
// takes the adjustment lock first, so this lookup must not lock that row.
async function assertNoPendingOrderAdjustment(ctx, orderId, transaction) {
  const pending = await PerformanceProfitAdjustment.findOne({
    where: { order_id: orderId, status: { [Op.in]: ['pending_finance', 'pending_admin'] } },
    attributes: ['adjustment_no'],
    order: [['create_time', 'ASC'], ['adjustment_id', 'ASC']],
    transaction,
    raw: true
  });
  if (pending) ctx.throw(409, `本订单已有待审批调整申请（${pending.adjustment_no}），请先处理该申请`);
}

module.exports = { assertNoPendingOrderAdjustment };
