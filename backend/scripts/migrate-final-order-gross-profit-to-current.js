// Refresh active, final order gross-profit snapshots to the current formula.
// Preview by default. Only October 2026 orders are authorized for this migration.
const { QueryTypes } = require('sequelize');
const fs = require('fs');
const path = require('path');
const {
  sequelize, Order, OrderGrossProfit, ProductSettlementOrder,
  ProductSettlementItem, SalesReturnGrossProfitLedger
} = require('../src/models');
const {
  FORMULA_VERSION, calculateAndSaveOrderGrossProfit, roundMoney
} = require('../src/modules/sales/grossProfit');
const { _test: { summarizeProductSettlementItems } } = require('../src/modules/report/productSettlement');
const { normalizeParticipants } = require('../src/modules/report/dashboardDataSource');
const { allocateProfit } = require('../src/modules/report/performanceAllocation');

const scope = process.argv.find(arg => arg.startsWith('--scope='))?.split('=')[1];
if (scope !== 'october') throw new Error('只允许 --scope=october；其他月份毛利已定稿');
const execute = process.argv.includes('--execute');
const limitArg = process.argv.find(arg => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;
if (!(limit > 0)) throw new Error('--limit 必须大于 0');
const concurrency = Math.min(16, Math.max(1, Number(process.argv.find(arg => arg.startsWith('--concurrency='))?.split('=')[1] || 4)));

function array(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error('快照明细不是数组');
  return parsed;
}

async function updateProductSettlement(orderId, pricingDetails, transaction) {
  const settlement = await ProductSettlementOrder.findOne({ where: { source_order_id: orderId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!settlement) return false;
  const items = await ProductSettlementItem.findAll({ where: { settlement_id: settlement.settlement_id }, transaction });
  const byItemId = new Map(pricingDetails.map(line => [String(line.itemId), line]));
  let changed = false;
  for (const item of items) {
    const line = byItemId.get(String(item.source_order_item_id));
    if (!line) throw new Error(`产品结算商品行 ${item.source_order_item_id} 缺少订单快照`);
    const unitPrice = roundMoney(line.unitPricing);
    const lineProfit = item.cost_status === 'ready'
      ? roundMoney(unitPrice * Number(item.quantity || 1) - Number(item.purchase_cost_amount || 0)) : 0;
    if (roundMoney(item.product_unit_price) === unitPrice && item.product_price_source === line.source &&
        roundMoney(item.gross_profit_amount) === lineProfit) continue;
    await item.update({ product_unit_price: unitPrice, product_price_source: line.source,
      gross_profit_amount: lineProfit }, { transaction });
    changed = true;
  }
  if (!changed) return false;
  const summary = summarizeProductSettlementItems(items.map(item => item.toJSON()));
  await settlement.update({
    product_pricing_amount: summary.productPricingAmount,
    purchase_cost_amount: summary.purchaseCostAmount,
    cost_pending_amount: summary.costPendingAmount,
    gross_profit_amount: summary.grossProfitAmount,
    status: summary.status,
    update_time: new Date()
  }, { transaction });
  return true;
}

async function updateReturnLedgers(order, previousGrossProfit, nextGrossProfit, transaction) {
  const rows = await SalesReturnGrossProfitLedger.findAll({
    where: { order_id: order.order_id }, transaction, lock: transaction.LOCK.UPDATE,
    order: [['return_id', 'ASC'], ['participant_key', 'ASC']]
  });
  if (!rows.length) return 0;
  const participants = normalizeParticipants(order.toJSON());
  const originalShares = allocateProfit(participants, nextGrossProfit);
  const shareByKey = new Map(participants.map((participant, index) => [participant.key, originalShares[index]]));
  const byReturn = new Map();
  rows.forEach(row => {
    const group = byReturn.get(row.return_id) || [];
    group.push(row);
    byReturn.set(row.return_id, group);
  });
  for (const group of byReturn.values()) {
    const returnedSales = -roundMoney(group.reduce((sum, row) => sum + Number(row.returned_sales_amount || 0), 0));
    const reversed = roundMoney(Number(order.total_amount || 0) > 0
      ? nextGrossProfit * returnedSales / Number(order.total_amount)
      : previousGrossProfit
        ? -group.reduce((sum, row) => sum + Number(row.gross_profit_amount || 0), 0) * nextGrossProfit / previousGrossProfit
        : 0);
    let allocated = 0;
    for (let index = 0; index < group.length; index += 1) {
      const row = group[index];
      const next = index === group.length - 1
        ? roundMoney(-reversed - allocated)
        : nextGrossProfit && shareByKey.has(row.participant_key)
          ? roundMoney(-reversed * shareByKey.get(row.participant_key) / nextGrossProfit)
          : roundMoney(-reversed / group.length);
      allocated = roundMoney(allocated + next);
      if (roundMoney(row.gross_profit_amount) !== next) await row.update({ gross_profit_amount: next }, { transaction });
    }
  }
  return rows.length;
}

async function refreshOne(candidate) {
  return sequelize.transaction(async transaction => {
    const snapshot = await OrderGrossProfit.findOne({
      where: { order_id: candidate.order_id }, transaction, lock: transaction.LOCK.UPDATE
    });
    if (!snapshot || snapshot.formula_version === FORMULA_VERSION || snapshot.snapshot_status !== 'final') return null;
    const order = await Order.findByPk(candidate.order_id, { transaction });
    if (!order || Number(order.is_deleted) !== 0) return null;
    const previousGrossProfit = roundMoney(snapshot.gross_profit_amount);
    const previousLines = new Map(array(snapshot.product_pricing_details).map(line => [String(line.itemId), line]));
    const nextSnapshot = await calculateAndSaveOrderGrossProfit(candidate.order_id, {
      transaction, calculatedBy: 'final_snapshot_formula_migration', force: true, final: true
    });
    const pricingDetails = array(nextSnapshot.product_pricing_details);
    const missingWithOldPrice = pricingDetails.filter(line => String(line.source || '').startsWith('missing_') &&
      Number(line.quantity || 1) > 0 && Number(previousLines.get(String(line.itemId))?.unitPricing || 0) > 0);
    if (missingWithOldPrice.length) {
      throw new Error('商品缺少可用的定价或采购价，已回滚');
    }
    const settlementChanged = await updateProductSettlement(candidate.order_id, pricingDetails, transaction);
    const nextGrossProfit = roundMoney(nextSnapshot.gross_profit_amount);
    const returnLedgerRows = await updateReturnLedgers(order, previousGrossProfit, nextGrossProfit, transaction);
    return { before: previousGrossProfit, after: nextGrossProfit, settlementChanged, returnLedgerRows };
  });
}

async function main() {
  const candidates = await sequelize.query(`
    SELECT gp.ORDER_ID order_id, gp.ORDER_NO order_no, gp.FORMULA_VERSION formula_version
      FROM T_ORDER_GROSS_PROFIT gp
      JOIN T_ORDER o ON o.ORDER_ID = gp.ORDER_ID
     WHERE gp.SNAPSHOT_STATUS = 'final'
       AND gp.FORMULA_VERSION <> :formulaVersion
       AND o.IS_DELETED = 0
       AND o.CREATE_TIME >= '2026-10-01'
       AND o.CREATE_TIME < '2026-11-01'
     ORDER BY gp.GROSS_PROFIT_ID`,
    { replacements: { formulaVersion: FORMULA_VERSION }, type: QueryTypes.SELECT }
  );
  const selected = candidates.slice(0, limit);
  console.log(JSON.stringify({ mode: execute ? 'execute' : 'preview', scope, formulaVersion: FORMULA_VERSION,
    candidates: candidates.length, selected: selected.length, concurrency }));
  if (!execute || !selected.length) return;
  const selectedIds = selected.map(candidate => candidate.order_id);
  const snapshotsBefore = await OrderGrossProfit.findAll({
    where: { order_id: selectedIds }, raw: true
  });
  const settlementsBefore = await ProductSettlementOrder.findAll({
    where: { source_order_id: selectedIds }, raw: true
  });
  const settlementItemsBefore = await ProductSettlementItem.findAll({
    where: { settlement_id: settlementsBefore.map(row => row.settlement_id) }, raw: true
  });
  const returnLedgersBefore = await SalesReturnGrossProfitLedger.findAll({
    where: { order_id: selectedIds }, raw: true
  });
  const backupFile = path.join(__dirname, '../../backup',
    `migrate-final-order-gross-profit-${scope}-before-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(backupFile), { recursive: true });
  fs.writeFileSync(backupFile, JSON.stringify({ snapshotsBefore, settlementsBefore,
    settlementItemsBefore, returnLedgersBefore }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ backupFile, backedUpOrders: snapshotsBefore.length }));
  const summary = { refreshed: 0, skipped: 0, failed: 0, settlementChanged: 0, returnLedgerRows: 0,
    beforeGrossProfit: 0, afterGrossProfit: 0, failures: [] };
  let cursor = 0;
  const worker = async () => {
    while (cursor < selected.length) {
      const candidate = selected[cursor++];
      try {
        const result = await refreshOne(candidate);
        if (!result) { summary.skipped += 1; continue; }
        summary.refreshed += 1;
        summary.beforeGrossProfit = roundMoney(summary.beforeGrossProfit + result.before);
        summary.afterGrossProfit = roundMoney(summary.afterGrossProfit + result.after);
        if (result.settlementChanged) summary.settlementChanged += 1;
        summary.returnLedgerRows += result.returnLedgerRows;
      } catch (error) {
        summary.failed += 1;
        summary.failures.push({ orderNo: candidate.order_no, message: error.message });
        if (summary.failed <= 10) console.error(`[migration] ${candidate.order_no}: ${error.message}`);
      }
      if ((summary.refreshed + summary.failed + summary.skipped) % 100 === 0) {
        console.log(JSON.stringify({ progress: summary.refreshed + summary.failed + summary.skipped,
          total: selected.length, refreshed: summary.refreshed, failed: summary.failed }));
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const failureFile = path.join(__dirname, '../../backup', `migrate-final-order-gross-profit-${scope}-failures.json`);
  if (summary.failures.length) {
    fs.mkdirSync(path.dirname(failureFile), { recursive: true });
    fs.writeFileSync(failureFile, JSON.stringify(summary.failures, null, 2));
  }
  console.log(JSON.stringify({ ...summary, failures: summary.failures.slice(0, 10),
    failureFile: summary.failures.length ? failureFile : null }));
  if (summary.failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => sequelize.close());
