// Reconcile the seven newly priced October Care orders archived after wallet opening.
// The earlier Yin Hui order receives the ¥88 credit previously assigned to a later order.
// Preview by default; --execute is transactional and preserves cancelled rows for audit.
const { Op } = require('sequelize');
const {
  sequelize, Order, OrderGrossProfit, StaffCareCreditTransaction,
  PerformanceProfitAdjustment
} = require('../src/models');
const { activateOrderCareCredit, walletTotals, _test } = require('../src/modules/sales/staffCareCredit');
const { recordBusinessAction } = require('../src/utils/businessActionLog');

const execute = process.argv.includes('--execute');
const oldYinNo = 'ORD202610110736157111';
const expected = new Map([
  ['ORD202610110925116020', { staffId: 28, covered: 268 }],
  ['ORD202610110936529370', { staffId: 35, covered: 0 }],
  ['ORD202610111150387908', { staffId: 21, covered: 88 }],
  ['ORD202610111509111536', { staffId: 42, covered: 268 }],
  ['ORD202610120716156398', { staffId: 28, covered: 268 }],
  ['ORD202610121056265595', { staffId: 28, covered: 268 }],
  ['ORD202610121036513038', { staffId: 35, covered: 0 }]
]);

async function main() {
  const orders = await Order.findAll({
    where: { order_no: { [Op.in]: [...expected.keys(), oldYinNo] } },
    order: [['archive_time', 'ASC']]
  });
  if (orders.length !== expected.size + 1) throw new Error('Order set changed');
  const previous = orders.find(order => order.order_no === oldYinNo);
  const previousExpense = await StaffCareCreditTransaction.findOne({
    where: { source_type: 'CARE_ORDER', source_id: previous.order_id, status: 'active' }
  });
  const previousAdjustment = await PerformanceProfitAdjustment.findOne({
    where: { adjustment_no: `AUTO-CARE-${previous.order_id}`, status: 'approved' }
  });
  if (Number(previousExpense?.amount) !== 88 || Number(previousAdjustment?.signed_amount) !== 88) {
    throw new Error('The later Yin Hui Care credit changed');
  }
  const targets = orders.filter(order => expected.has(order.order_no));
  const balances = new Map();
  for (const order of targets) {
    const rule = expected.get(order.order_no);
    if (order.order_status !== '已归档' || Number(order.create_staff_id) !== rule.staffId) {
      throw new Error(`Order status or salesperson changed: ${order.order_no}`);
    }
    const snapshot = await OrderGrossProfit.findOne({ where: { order_id: order.order_id } });
    const details = await _test.careCostDetails(snapshot);
    const careCost = _test.money(details.reduce((sum, row) => sum + Number(row.pricingAmount || 0), 0));
    if (snapshot?.snapshot_status !== 'final' || careCost !== 268) {
      throw new Error(`Care cost changed: ${order.order_no}`);
    }
    const existing = await StaffCareCreditTransaction.findOne({
      where: { source_type: 'CARE_ORDER', source_id: order.order_id }
    });
    if (existing) throw new Error(`Care credit already exists: ${order.order_no}`);
    if (!balances.has(rule.staffId)) balances.set(rule.staffId, await walletTotals(rule.staffId));
  }
  const expectedAvailable = new Map([[28, 3428], [35, 0], [21, 0], [42, 1712]]);
  for (const [staffId, total] of balances) {
    if (total.available !== expectedAvailable.get(staffId)) {
      throw new Error(`Wallet balance changed for staff ${staffId}`);
    }
  }
  console.log(JSON.stringify({ mode: execute ? 'execute' : 'preview',
    reassignFrom: oldYinNo,
    targets: targets.map(order => ({ orderNo: order.order_no, staffId: order.create_staff_id,
      careCost: 268, expectedCovered: expected.get(order.order_no).covered })),
    newCoveredTotal: [...expected.values()].reduce((sum, item) => sum + item.covered, 0)
  }, null, 2));
  if (!execute) return;

  await sequelize.transaction(async transaction => {
    const expense = await StaffCareCreditTransaction.findByPk(previousExpense.transaction_id,
      { transaction, lock: transaction.LOCK.UPDATE });
    const adjustment = await PerformanceProfitAdjustment.findByPk(previousAdjustment.adjustment_id,
      { transaction, lock: transaction.LOCK.UPDATE });
    if (expense?.status !== 'active' || adjustment?.status !== 'approved') {
      throw new Error('The existing Yin Hui credit changed');
    }
    await expense.update({ status: 'cancelled',
      remark: `10月Care定价补算后按归档顺序改由较早订单ORD202610111150387908使用¥88.00` }, { transaction });
    await adjustment.update({ status: 'cancelled',
      reason: `${adjustment.reason}；10月Care定价补算后调整至较早订单ORD202610111150387908`,
      update_time: new Date() }, { transaction });
    await recordBusinessAction({ businessType: 'sales_order', businessId: previous.order_id,
      businessNo: previous.order_no, action: 'care_credit_reallocated',
      fromStatus: previous.order_status, toStatus: previous.order_status,
      user: { name: 'system_care_company_price_20261001' },
      comment: 'Care可用金按历史归档顺序由较早订单优先使用',
      detail: { amount: 88, toOrderNo: 'ORD202610111150387908' }, transaction });
    for (const order of targets) {
      const covered = expected.get(order.order_no).covered;
      if (covered <= 0) continue;
      await activateOrderCareCredit(order, transaction);
      const applied = await StaffCareCreditTransaction.findOne({
        where: { source_type: 'CARE_ORDER', source_id: order.order_id, status: 'active' },
        transaction
      });
      if (Number(applied?.amount) !== covered) throw new Error(`Unexpected credit: ${order.order_no}`);
    }
  });
  console.log(JSON.stringify({ postedOrders: 5, coveredTotal: 1160,
    cancelledPreviousOrder: oldYinNo }));
}

main().then(() => sequelize.close()).catch(async error => {
  console.error(error);
  await sequelize.close();
  process.exitCode = 1;
});
