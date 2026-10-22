// Read-only by default. Only explicitly selected draft orders can be repaired.
// Preserve all frozen prices/taxes/fees; remove only proven unrelated freight.
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const { sequelize, Order, OrderItem, OrderGrossProfit, FreightRecordItem } = require('../src/models');
const { resolveFreightOrigins, matchesFreightOrigin } = require('../src/modules/sales/grossProfit');
const array = value => Array.isArray(value) ? value : JSON.parse(value || '[]');
const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

async function inspect(snapshot, transaction) {
  const details = array(snapshot.supplement_details);
  const items = await OrderItem.findAll({ where: { order_id: snapshot.order_id }, raw: true, transaction });
  const wrong = [], unresolved = [];
  for (const detail of details.filter(row => row.source === 'freight_cost')) {
    const item = items.find(row => String(row.item_id) === String(detail.itemId));
    const origins = item ? await resolveFreightOrigins(item, transaction) : [];
    if (!origins.length) { unresolved.push(detail); continue; }
    const rows = await FreightRecordItem.findAll({
      where: { freight_id: detail.freightId }, include: [{ association: 'freightRecord' }], transaction
    });
    if (!rows.length) { unresolved.push(detail); continue; }
    if (!rows.some(row => matchesFreightOrigin(item, row.toJSON(), origins))) wrong.push(detail);
  }
  return { wrong, unresolved, items, details };
}

async function main() {
  const execute = process.argv.includes('--execute');
  const orderNo = process.argv.find(arg => arg.startsWith('--order='))?.slice(8);
  if (execute && !orderNo) throw new Error('--execute requires an explicit --order=...');
  const snapshots = await OrderGrossProfit.findAll({
    where: { order_no: orderNo || { [Op.like]: 'ORD%' }, freight_cost_amount: { [Op.gt]: 0 } }, raw: true
  });
  const findings = [];
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < snapshots.length) {
      const snapshot = snapshots[next++];
      const result = await inspect(snapshot);
      if (result.wrong.length || result.unresolved.length) findings.push({ orderNo: snapshot.order_no,
        status: snapshot.snapshot_status, oldFreight: Number(snapshot.freight_cost_amount),
        oldProfit: Number(snapshot.gross_profit_amount),
        wrong: result.wrong, unresolved: result.unresolved });
    }
  }));
  const report = { checked: snapshots.length, findings };
  const backupDir = path.resolve(__dirname, '../backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(backupDir, `freight-batch-audit-${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checked: snapshots.length, wrongOrders: findings.filter(row => row.wrong.length).length,
    unresolvedOrders: findings.filter(row => row.unresolved.length).length, reportPath,
    ...(orderNo ? { findings } : {}) }, null, 2));
  if (!execute) return;
  await sequelize.transaction(async transaction => {
    const order = await Order.findOne({ where: { order_no: orderNo }, transaction, lock: transaction.LOCK.UPDATE });
    if (!order) throw new Error('Order not found');
    const snapshot = await OrderGrossProfit.findOne({ where: { order_id: order.order_id }, transaction, lock: transaction.LOCK.UPDATE });
    if (!snapshot) throw new Error('Gross profit snapshot not found');
    if (snapshot.snapshot_status !== 'draft') throw new Error('Historical final snapshots require a separately reviewed correction');
    const result = await inspect(snapshot.toJSON(), transaction);
    if (result.unresolved.length) throw new Error('Unresolved freight attribution; no changes made');
    if (!result.wrong.length) return;
    const detailTotal = money(result.details.filter(row => row.source === 'freight_cost')
      .reduce((sum, row) => sum + Number(row.amount), 0));
    if (detailTotal !== money(snapshot.freight_cost_amount)) throw new Error('Freight detail total mismatch; no changes made');
    fs.writeFileSync(path.join(backupDir, `freight-batch-before-${orderNo}-${stamp}.json`),
      JSON.stringify({ snapshot: snapshot.toJSON(), items: result.items }, null, 2));
    const kept = result.details.filter(row => !result.wrong.includes(row));
    const removedAmount = money(result.wrong.reduce((sum, row) => sum + Number(row.amount), 0));
    await snapshot.update({
      freight_cost_amount: money(Number(snapshot.freight_cost_amount) - removedAmount),
      gross_profit_amount: money(Number(snapshot.gross_profit_amount) + removedAmount),
      supplement_details: kept, calculated_by: 'freight_batch_attribution_fix', calculated_at: new Date(), update_time: new Date()
    }, { transaction });
    for (const item of result.items) {
      const freight = money(kept.filter(row => row.source === 'freight_cost' && String(row.itemId) === String(item.item_id))
        .reduce((sum, row) => sum + Number(row.amount), 0));
      await OrderItem.update({ freight_cost: freight }, { where: { item_id: item.item_id, order_id: order.order_id }, transaction });
    }
    console.log(JSON.stringify({ repaired: orderNo, freight: Number(snapshot.freight_cost_amount), profit: Number(snapshot.gross_profit_amount) }));
  });
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => sequelize.close());
