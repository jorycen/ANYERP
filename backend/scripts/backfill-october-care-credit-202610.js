// Backfill October Care wallet deductions only for orders archived after their
// salesperson's opening wallet balance was recorded. Preview by default.
const { Op } = require('sequelize');
const {
  sequelize, Order, OrderGrossProfit, StaffCareCreditTransaction,
  PerformanceProfitAdjustment
} = require('../src/models');
const { activateOrderCareCredit, _test } = require('../src/modules/sales/staffCareCredit');

const expected = new Map([
  ['ORD202610110816576404', 268],
  ['ORD202610111050285528', 268],
  ['ORD202610111154491783', 268],
  ['ORD202610111114526383', 268],
  ['ORD202610111206333321', 268],
  ['ORD202610110745126050', 268],
  ['ORD202610110736157111', 268],
  ['ORD202610111138163854', 268],
  ['ORD202610111348426457', 268],
  ['ORD202610111457524154', 268],
  ['ORD202610121004016267', 719]
]);

async function main() {
  const execute = process.argv.includes('--execute');
  const orders = await Order.findAll({ where: { order_no: { [Op.in]: [...expected.keys()] } },
    order: [['archive_time', 'ASC']] });
  if (orders.length !== expected.size) throw new Error('October Care order set changed');
  const preview = [];
  for (const order of orders) {
    if (order.order_status !== '已归档' || !String(order.order_no).startsWith('ORD202610')) {
      throw new Error(`Order status/month changed: ${order.order_no}`);
    }
    const opening = await StaffCareCreditTransaction.findOne({
      where: { staff_id: order.create_staff_id, source_type: 'MANUAL_SET', status: 'active' },
      order: [['create_time', 'ASC']]
    });
    if (!opening || new Date(opening.create_time) > new Date(order.archive_time)) {
      throw new Error(`No opening wallet before archive: ${order.order_no}`);
    }
    const snapshot = await OrderGrossProfit.findOne({ where: { order_id: order.order_id } });
    if (snapshot?.snapshot_status !== 'final') throw new Error(`Snapshot is not final: ${order.order_no}`);
    const details = await _test.careCostDetails(snapshot);
    const cost = _test.money(details.reduce((sum, row) => sum + Number(row.pricingAmount || 0), 0));
    if (cost !== expected.get(order.order_no)) throw new Error(`Care cost changed: ${order.order_no}`);
    const existing = await StaffCareCreditTransaction.findOne({
      where: { source_type: 'CARE_ORDER', source_id: order.order_id }
    });
    const adjustment = await PerformanceProfitAdjustment.findOne({
      where: { adjustment_no: `AUTO-CARE-${order.order_id}` }
    });
    if (existing || adjustment) throw new Error(`Care deduction already exists: ${order.order_no}`);
    preview.push({ orderNo: order.order_no, staff: order.create_user,
      archiveTime: order.archive_time, careCost: cost });
  }
  console.log(JSON.stringify({ mode: execute ? 'execute' : 'preview', orders: preview.length, preview }, null, 2));
  if (!execute) return;
  await sequelize.transaction(async transaction => {
    for (const item of preview) {
      const order = orders.find(row => row.order_no === item.orderNo);
      await activateOrderCareCredit(order, transaction);
    }
  });
  const posted = await StaffCareCreditTransaction.findAll({
    where: { source_type: 'CARE_ORDER', order_no: { [Op.in]: [...expected.keys()] }, status: 'active' },
    attributes: ['order_no', 'staff_name', 'amount'], raw: true
  });
  if (posted.length !== expected.size) throw new Error('Backfill posting count mismatch');
  console.log(JSON.stringify({ posted: posted.length,
    totalCovered: _test.money(posted.reduce((sum, row) => sum + Number(row.amount), 0)),
    postedRows: posted }, null, 2));
}

main().then(() => sequelize.close()).catch(async error => {
  console.error(error);
  await sequelize.close();
  process.exitCode = 1;
});
