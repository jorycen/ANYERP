// Replay October 2026 final Care orders against each salesperson's available credit.
// Existing credit is assigned to earlier archived orders first, including orders before the
// October 11 balance import. Preview by default; --execute backs up rows and writes atomically.
const fs = require('fs');
const path = require('path');
const { Op, QueryTypes } = require('sequelize');
const {
  sequelize, Staff, Order, OrderGrossProfit, StaffCareCreditTransaction,
  PerformanceProfitAdjustment
} = require('../src/models');
const { generateUUID } = require('../src/utils');
const { roundMoney } = require('../src/modules/sales/grossProfit');

const execute = process.argv.includes('--execute');
const actor = 'october_care_credit_retroactive_20261013';
const start = new Date('2026-10-01T00:00:00Z');
const end = new Date('2026-11-01T00:00:00Z');
function array(value) { return Array.isArray(value) ? value : JSON.parse(value || '[]'); }
function money(value) { return roundMoney(value); }

async function main() {
  const careProducts = await sequelize.query(
    "SELECT PRODUCT_ID product_id FROM T_PRODUCT WHERE BRAND LIKE 'Care%' AND IS_DELETED = 0",
    { type: QueryTypes.SELECT }
  );
  if (careProducts.length !== 11) throw new Error(`Care product set changed: ${careProducts.length}`);
  const careIds = new Set(careProducts.map(row => String(row.product_id)));
  const orders = await Order.findAll({
    where: { create_time: { [Op.gte]: start, [Op.lt]: end }, is_deleted: 0 }, raw: true
  });
  const orderById = new Map(orders.map(row => [String(row.order_id), row]));
  const snapshots = await OrderGrossProfit.findAll({
    where: { order_id: { [Op.in]: orders.map(row => row.order_id) }, snapshot_status: 'final' }, raw: true
  });
  const careOrders = snapshots.map(snapshot => {
    const order = orderById.get(String(snapshot.order_id));
    const cost = money(array(snapshot.product_pricing_details)
      .filter(line => careIds.has(String(line.productId)))
      .reduce((sum, line) => sum + Number(line.pricingAmount || 0), 0));
    return { order, snapshot, cost };
  }).filter(row => row.cost > 0).sort((a, b) =>
    new Date(a.order.archive_time || a.order.create_time) -
    new Date(b.order.archive_time || b.order.create_time) ||
    String(a.order.order_no).localeCompare(String(b.order.order_no)));
  if (careOrders.length !== 150) throw new Error(`October Care order set changed: ${careOrders.length}`);
  if (careOrders.some(row => !row.order?.create_staff_id || !row.order.archive_time)) {
    throw new Error('Care order lacks salesperson or archive time');
  }
  const staffIds = [...new Set(careOrders.map(row => Number(row.order.create_staff_id)))];
  const credits = await StaffCareCreditTransaction.findAll({
    where: { staff_id: { [Op.in]: staffIds } }, raw: true
  });
  const adjustments = await PerformanceProfitAdjustment.findAll({
    where: { order_id: { [Op.in]: careOrders.map(row => row.order.order_id) },
      adjustment_no: { [Op.like]: 'AUTO-CARE-%' } }, raw: true
  });
  const creditByOrder = new Map();
  for (const row of credits.filter(row => row.source_type === 'CARE_ORDER')) {
    if (creditByOrder.has(String(row.source_id))) throw new Error(`Duplicate Care credit: ${row.source_id}`);
    creditByOrder.set(String(row.source_id), row);
  }
  const adjustmentByOrder = new Map();
  for (const row of adjustments) {
    if (adjustmentByOrder.has(String(row.order_id))) throw new Error(`Duplicate Care adjustment: ${row.order_no}`);
    adjustmentByOrder.set(String(row.order_id), row);
  }
  const pools = new Map();
  for (const staffId of staffIds) {
    const staffCredits = credits.filter(row => Number(row.staff_id) === staffId);
    const earned = money(staffCredits.filter(row => row.type === 'income' && row.status === 'active')
      .reduce((sum, row) => sum + Number(row.amount), 0));
    const nonCareSpent = money(staffCredits.filter(row => row.type === 'expense' &&
      row.source_type !== 'CARE_ORDER' && ['active', 'reserved'].includes(row.status))
      .reduce((sum, row) => sum + Number(row.amount), 0));
    if (earned < nonCareSpent) throw new Error(`Negative non-Care pool: ${staffId}`);
    pools.set(staffId, money(earned - nonCareSpent));
  }
  const remaining = new Map(pools);
  const plans = careOrders.map(({ order, snapshot, cost }) => {
    const staffId = Number(order.create_staff_id);
    const before = creditByOrder.get(String(order.order_id));
    const adjustment = adjustmentByOrder.get(String(order.order_id));
    if (before && !['active', 'cancelled', 'reserved'].includes(before.status)) {
      throw new Error(`Unexpected Care credit status: ${order.order_no}`);
    }
    if (adjustment && !['approved', 'cancelled'].includes(adjustment.status)) {
      throw new Error(`Unexpected Care adjustment status: ${order.order_no}`);
    }
    const currentCovered = before?.status === 'active' ? money(before.amount) : 0;
    const currentAdjustment = adjustment?.status === 'approved' ? money(adjustment.signed_amount) : 0;
    if (currentCovered !== currentAdjustment) throw new Error(`Credit and adjustment differ: ${order.order_no}`);
    const covered = money(Math.min(cost, remaining.get(staffId)));
    remaining.set(staffId, money(remaining.get(staffId) - covered));
    return { order, snapshot, cost, staffId, before, adjustment, currentCovered, covered,
      balanceAfter: remaining.get(staffId) };
  });
  const changes = plans.filter(row => row.currentCovered !== row.covered);
  const balanceOnly = plans.filter(row => row.currentCovered === row.covered &&
    row.covered > 0 && row.before?.status === 'active' &&
    money(row.before.balance_after) !== row.balanceAfter);
  const preview = { mode: execute ? 'execute' : 'preview', careOrders: plans.length,
    changedOrders: changes.length,
    balanceRowsToRefresh: balanceOnly.length,
    beforeCovered: money(plans.reduce((sum, row) => sum + row.currentCovered, 0)),
    afterCovered: money(plans.reduce((sum, row) => sum + row.covered, 0)),
    addedCoverage: money(changes.reduce((sum, row) => sum + row.covered - row.currentCovered, 0)),
    staffAffected: [...new Set(changes.map(row => row.staffId))].length,
    targetOrder: plans.filter(row => row.order.order_no === 'ORD202610010341470370')
      .map(row => ({ orderNo: row.order.order_no, careCost: row.cost,
        beforeCovered: row.currentCovered, afterCovered: row.covered,
        staffBalanceAfter: row.balanceAfter })),
    changes: changes.map(row => ({ orderNo: row.order.order_no,
      staffId: row.staffId, before: row.currentCovered, after: row.covered }))
  };
  console.log(JSON.stringify(preview, null, 2));
  if (!execute || (!changes.length && !balanceOnly.length)) return;

  const backupFile = path.resolve(__dirname, `../../backup/${actor}-before.json`);
  fs.mkdirSync(path.dirname(backupFile), { recursive: true });
  fs.writeFileSync(backupFile, JSON.stringify({ careProducts, pools: [...pools],
    plans: plans.map(({ order, snapshot, before, adjustment, cost, covered }) =>
      ({ order, snapshot, credit: before, adjustment, careCost: cost, desiredCredit: covered })),
    credits, adjustments }, null, 2), { flag: 'wx' });

  await sequelize.transaction(async transaction => {
    for (const staffId of [...new Set(changes.map(row => row.staffId))].sort((a, b) => a - b)) {
      const staff = await Staff.findByPk(staffId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!staff || Number(staff.is_deleted) === 1) throw new Error(`Staff unavailable: ${staffId}`);
    }
    for (const staffId of [...new Set(changes.map(row => row.staffId))]) {
      const previousRows = credits.filter(row => Number(row.staff_id) === staffId);
      const currentRows = await StaffCareCreditTransaction.findAll({
        where: { staff_id: staffId }, transaction, raw: true
      });
      if (currentRows.length !== previousRows.length || currentRows.some(row => {
        const old = previousRows.find(item => item.transaction_id === row.transaction_id);
        return !old || row.status !== old.status || money(row.amount) !== money(old.amount);
      })) throw new Error(`Wallet changed during preview: ${staffId}`);
    }
    const now = new Date();
    for (const plan of changes) {
      const { order, before, adjustment, covered, balanceAfter } = plan;
      const remark = `Retrospective October Care credit by archive order; ${order.order_no}`;
      let current = before ? await StaffCareCreditTransaction.findByPk(before.transaction_id,
        { transaction, lock: transaction.LOCK.UPDATE }) : null;
      if (before && (!current || current.status !== before.status ||
        money(current.amount) !== money(before.amount))) {
        throw new Error(`Care credit changed: ${order.order_no}`);
      }
      let currentAdjustment = adjustment ? await PerformanceProfitAdjustment.findByPk(
        adjustment.adjustment_id, { transaction, lock: transaction.LOCK.UPDATE }) : null;
      if (adjustment && (!currentAdjustment || currentAdjustment.status !== adjustment.status ||
        money(currentAdjustment.signed_amount) !== money(adjustment.signed_amount))) {
        throw new Error(`Care adjustment changed: ${order.order_no}`);
      }
      if (covered > 0) {
        if (current) {
          await current.update({ amount: covered, status: 'active', balance_after: balanceAfter,
            remark }, { transaction });
        } else {
          current = await StaffCareCreditTransaction.create({ transaction_id: generateUUID(),
            staff_id: plan.staffId, staff_name: order.create_user || '', type: 'expense',
            amount: covered, balance_after: balanceAfter, source_type: 'CARE_ORDER',
            source_id: order.order_id, order_id: order.order_id, order_no: order.order_no,
            status: 'active', remark, create_time: now }, { transaction });
        }
        if (currentAdjustment) {
          await currentAdjustment.update({ amount: covered, signed_amount: covered,
            status: 'approved', reason: remark, update_time: now }, { transaction });
        } else {
          await PerformanceProfitAdjustment.create({ adjustment_id: generateUUID(),
            adjustment_no: `AUTO-CARE-${order.order_id}`, order_id: order.order_id,
            order_no: order.order_no, store_id: order.store_id,
            employee_name: order.create_user || current.staff_name,
            adjustment_type: 'increase', amount: covered, signed_amount: covered,
            base_gross_profit: 0, reason: remark, status: 'approved',
            applicant_staff_id: 0, applicant_name: 'system', finance_reviewer_id: 0,
            finance_reviewer_name: 'system', finance_review_time: now,
            admin_reviewer_id: 0, admin_reviewer_name: 'system', admin_review_time: now,
            create_time: now, update_time: now }, { transaction });
        }
      } else {
        if (current?.status === 'active') await current.update({ status: 'cancelled',
          remark }, { transaction });
        if (currentAdjustment?.status === 'approved') await currentAdjustment.update({
          status: 'cancelled', reason: remark, update_time: now }, { transaction });
      }
    }
    for (const plan of balanceOnly) {
      const current = await StaffCareCreditTransaction.findByPk(plan.before.transaction_id,
        { transaction, lock: transaction.LOCK.UPDATE });
      if (!current || current.status !== 'active' || money(current.amount) !== plan.covered) {
        throw new Error(`Care balance row changed: ${plan.order.order_no}`);
      }
      await current.update({ balance_after: plan.balanceAfter }, { transaction });
    }
  });
  console.log(JSON.stringify({ applied: true, changedOrders: changes.length,
    balanceRowsRefreshed: balanceOnly.length, addedCoverage: preview.addedCoverage, backupFile }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => sequelize.close());
