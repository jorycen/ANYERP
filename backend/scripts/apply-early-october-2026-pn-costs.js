// Refresh only final gross-profit snapshots for sales on October 1–7, 2026.
// Preview by default; --execute backs up affected rows and applies atomically.
const fs = require('fs');
const path = require('path');
const { Op, QueryTypes } = require('sequelize');
const { sequelize, Order, OrderGrossProfit, ProductSettlementOrder,
  ProductSettlementItem, ProductSettlementAdjustment, SalesReturnGrossProfitLedger } = require('../src/models');
const { calculateGrossProfitValues, roundMoney } = require('../src/modules/sales/grossProfit');
const { _test: { summarizeProductSettlementItems } } = require('../src/modules/report/productSettlement');
const { normalizeParticipants } = require('../src/modules/report/dashboardDataSource');
const { allocateProfit } = require('../src/modules/report/performanceAllocation');

const targets = new Map([
  ['ZAJA0009CN', 5400], ['ZAJA0007CN', 4500],
  ['ZAJA0001CN', 5400], ['ZAJA0002CN', 4500], ['ZAJA0012CN', 4500]
]);
const marker = 'early_october_2026_fixed_pn_cost';
const execute = process.argv.includes('--execute');
const money = roundMoney;
const same = (a, b) => money(a) === money(b);
function array(value) {
  const result = Array.isArray(value) ? value : JSON.parse(value || '[]');
  if (!Array.isArray(result)) throw new Error('Expected array details');
  return result;
}
function calculate(order, snapshot, lines) {
  const additions = array(snapshot.supplement_details);
  return calculateGrossProfitValues({
    receivableAmount: snapshot.receivable_amount,
    paymentDetails: array(snapshot.payment_fee_details),
    productPricingDetails: lines,
    supplementDetails: additions.filter(x => x.source !== 'freight_cost'),
    freightCostDetails: additions.filter(x => x.source === 'freight_cost'),
    invoiceAmount: snapshot.invoice_amount,
    invoiceStatus: order.invoice_status,
    externalAdjustmentEligible: lines.some(x => x.externalAdjustmentEligible === true)
  });
}

async function main() {
  const rows = await sequelize.query(`
    SELECT o.ORDER_ID orderId, o.ORDER_NO orderNo, oi.ITEM_ID itemId,
           oi.PN_CODE pn, oi.PRODUCT_ID productId, oi.QUANTITY quantity
      FROM T_ORDER o JOIN T_ORDER_ITEM oi ON oi.ORDER_ID=o.ORDER_ID
     WHERE o.IS_DELETED=0 AND oi.PN_CODE IN (:pns)
       AND o.CREATE_TIME >= '2026-10-01' AND o.CREATE_TIME < '2026-10-08'
     ORDER BY o.ORDER_NO, oi.ITEM_ID`,
    { replacements: { pns: [...targets.keys()] }, type: QueryTypes.SELECT });
  const orderIds = [...new Set(rows.map(x => x.orderId))];
  const [orders, snapshots, settlements, ledgers, adjustments] = await Promise.all([
    Order.findAll({ where: { order_id: { [Op.in]: orderIds } }, raw: true }),
    OrderGrossProfit.findAll({ where: { order_id: { [Op.in]: orderIds } }, raw: true }),
    ProductSettlementOrder.findAll({ where: { source_order_id: { [Op.in]: orderIds } }, raw: true }),
    SalesReturnGrossProfitLedger.findAll({ where: { order_id: { [Op.in]: orderIds } }, raw: true }),
    ProductSettlementAdjustment.findAll({ where: { source_order_id: { [Op.in]: orderIds } }, raw: true })
  ]);
  const byId = list => new Map(list.map(x => [x.order_id || x.source_order_id, x]));
  const orderById = byId(orders);
  const snapshotById = byId(snapshots);
  const settlementById = byId(settlements);
  const settlementItems = settlements.length ? await ProductSettlementItem.findAll({
    where: { settlement_id: { [Op.in]: settlements.map(x => x.settlement_id) } }, raw: true
  }) : [];
  const itemsBySettlement = new Map();
  for (const item of settlementItems) {
    if (!itemsBySettlement.has(item.settlement_id)) itemsBySettlement.set(item.settlement_id, []);
    itemsBySettlement.get(item.settlement_id).push(item);
  }
  const ledgersByOrder = new Map(), adjustmentsByOrder = new Map(), rowsByOrder = new Map();
  for (const [list, map, key] of [[ledgers, ledgersByOrder, 'order_id'],
    [adjustments, adjustmentsByOrder, 'source_order_id'], [rows, rowsByOrder, 'orderId']]) {
    for (const item of list) {
      if (!map.has(item[key])) map.set(item[key], []);
      map.get(item[key]).push(item);
    }
  }
  const summary = { mode: execute ? 'execute' : 'preview', window: '2026-10-01..2026-10-07',
    targetPrices: Object.fromEntries(targets), matchingOrderLines: rows.length,
    matchingOrders: orderIds.length, changedOrders: 0, changedLines: 0,
    amountChangedOrders: 0, beforeGrossProfit: 0, afterGrossProfit: 0,
    changedSettlements: 0, returnLedgerOrders: 0, skipped: [], byPn: {} };
  for (const pn of targets.keys()) summary.byPn[pn] = { matched: 0, changed: 0 };
  for (const row of rows) summary.byPn[row.pn].matched++;
  const plans = [];
  for (const orderId of orderIds) {
    const order = orderById.get(orderId);
    const snapshot = snapshotById.get(orderId);
    if (!snapshot || snapshot.snapshot_status !== 'final') {
      summary.skipped.push({ orderNo: order?.order_no, reason: 'not a final snapshot' });
      continue;
    }
    const beforeLines = array(snapshot.product_pricing_details);
    const afterLines = beforeLines.map(x => ({ ...x }));
    const matchingItems = new Map(rowsByOrder.get(orderId).map(x => [String(x.itemId), x]));
    const changes = [];
    let matchedLines = 0;
    for (const line of afterLines) {
      const item = matchingItems.get(String(line.itemId));
      if (!item) continue;
      matchedLines++;
      if (String(line.productId) !== String(item.productId)) {
        throw new Error(`Product mismatch: ${order.order_no} / ${item.itemId}`);
      }
      const nextUnit = targets.get(item.pn);
      if (!nextUnit) throw new Error(`Unexpected PN: ${item.pn}`);
      if (same(line.unitPricing, nextUnit) && line.source === 'historical_pn_cost_override' &&
          line.isCompanyPriced === true && line.externalAdjustmentEligible !== true) continue;
      changes.push({ pn: item.pn, itemId: item.itemId,
        beforeUnit: money(line.unitPricing), afterUnit: nextUnit, beforeSource: line.source });
      line.unitPricing = nextUnit;
      line.pricingAmount = money(nextUnit * Number(line.quantity || item.quantity || 1));
      line.source = 'historical_pn_cost_override';
      line.isCompanyPriced = true;
      line.isSpecialPrice = false;
      line.specialPrice = null;
      line.grossProfitUpliftAmount = 0;
      line.externalAdjustmentEligible = false;
    }
    if (matchedLines !== matchingItems.size) {
      throw new Error(`Missing gross-profit details: ${order.order_no}`);
    }
    if (!changes.length) continue;
    const before = calculate(order, snapshot, beforeLines);
    if (!same(before.productPricingAmount, snapshot.product_pricing_amount) ||
        !same(before.paymentFeeAmount, snapshot.payment_fee_amount) ||
        !same(before.vatAmount, snapshot.vat_amount) ||
        !same(before.grossProfitAmount, snapshot.gross_profit_amount)) {
      summary.skipped.push({ orderNo: order.order_no, reason: 'snapshot baseline drift', version: snapshot.formula_version });
      continue;
    }
    const after = calculate(order, snapshot, afterLines);
    const settlement = settlementById.get(orderId);
    const originalItems = settlement ? itemsBySettlement.get(settlement.settlement_id) || [] : [];
    const afterItems = originalItems.map(x => ({ ...x }));
    let afterSettlement = null;
    if (settlement) {
      const baseline = summarizeProductSettlementItems(originalItems);
      if (!same(baseline.productPricingAmount, settlement.product_pricing_amount) ||
          !same(baseline.grossProfitAmount, settlement.gross_profit_amount) ||
          baseline.status !== settlement.status) {
        summary.skipped.push({ orderNo: order.order_no, reason: 'settlement baseline drift' });
        continue;
      }
      for (const change of changes) {
        const item = afterItems.find(x => String(x.source_order_item_id) === String(change.itemId));
        if (!item) throw new Error(`Missing settlement item: ${order.order_no}`);
        item.product_unit_price = change.afterUnit;
        item.product_price_source = 'historical_pn_cost_override';
        item.gross_profit_amount = item.cost_status === 'ready'
          ? money(change.afterUnit * Number(item.quantity || 1) - Number(item.purchase_cost_amount || 0)) : 0;
      }
      afterSettlement = summarizeProductSettlementItems(afterItems);
    }
    if ((adjustmentsByOrder.get(orderId) || []).length && changes.some(x => x.beforeUnit !== x.afterUnit)) {
      throw new Error(`Return settlement needs a coordinated update: ${order.order_no}`);
    }
    plans.push({ order, snapshot, beforeLines, afterLines, after, changes,
      settlement, originalItems, afterItems, afterSettlement,
      ledgers: ledgersByOrder.get(orderId) || [] });
    summary.changedOrders++;
    summary.changedLines += changes.length;
    if (!same(snapshot.gross_profit_amount, after.grossProfitAmount)) summary.amountChangedOrders++;
    summary.beforeGrossProfit = money(summary.beforeGrossProfit + Number(snapshot.gross_profit_amount));
    summary.afterGrossProfit = money(summary.afterGrossProfit + after.grossProfitAmount);
    if (settlement) summary.changedSettlements++;
    if (ledgersByOrder.has(orderId)) summary.returnLedgerOrders++;
    for (const change of changes) summary.byPn[change.pn].changed++;
  }
  console.log(JSON.stringify(summary, null, 2));
  if (!execute) return;
  if (summary.skipped.length) throw new Error('Some final orders were skipped; no changes written');
  const backupDir = path.join(__dirname, '../../backup');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, `${marker}-before.json`);
  fs.writeFileSync(backupFile, JSON.stringify(plans.map(p => ({ order: p.order, snapshot: p.snapshot,
    settlement: p.settlement, settlementItems: p.originalItems, ledgers: p.ledgers })), null, 2), { flag: 'wx' });
  await sequelize.transaction(async transaction => {
    for (const plan of plans) {
      const current = await OrderGrossProfit.findByPk(plan.snapshot.gross_profit_id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!current || JSON.stringify(array(current.product_pricing_details)) !== JSON.stringify(plan.beforeLines) ||
          !same(current.gross_profit_amount, plan.snapshot.gross_profit_amount)) {
        throw new Error(`Snapshot changed: ${plan.order.order_no}`);
      }
      await current.update({ product_pricing_details: plan.afterLines,
        product_pricing_amount: plan.after.productPricingAmount,
        vat_taxable_amount: plan.after.vatTaxableAmount,
        vat_amount: plan.after.vatAmount,
        gross_profit_amount: plan.after.grossProfitAmount,
        calculated_by: marker, calculated_at: new Date(), update_time: new Date() }, { transaction });
      if (plan.settlement) {
        for (let index = 0; index < plan.afterItems.length; index++) {
          const beforeItem = plan.originalItems[index], afterItem = plan.afterItems[index];
          if (same(beforeItem.product_unit_price, afterItem.product_unit_price) &&
              beforeItem.product_price_source === afterItem.product_price_source &&
              same(beforeItem.gross_profit_amount, afterItem.gross_profit_amount)) continue;
          const [updated] = await ProductSettlementItem.update({
            product_unit_price: afterItem.product_unit_price,
            product_price_source: afterItem.product_price_source,
            gross_profit_amount: afterItem.gross_profit_amount
          }, { where: { settlement_item_id: beforeItem.settlement_item_id,
            product_unit_price: beforeItem.product_unit_price,
            gross_profit_amount: beforeItem.gross_profit_amount }, transaction });
          if (updated !== 1) throw new Error(`Settlement item changed: ${plan.order.order_no}`);
        }
        const [updated] = await ProductSettlementOrder.update({
          product_pricing_amount: plan.afterSettlement.productPricingAmount,
          purchase_cost_amount: plan.afterSettlement.purchaseCostAmount,
          cost_pending_amount: plan.afterSettlement.costPendingAmount,
          gross_profit_amount: plan.afterSettlement.grossProfitAmount,
          status: plan.afterSettlement.status, update_time: new Date()
        }, { where: { settlement_id: plan.settlement.settlement_id,
          product_pricing_amount: plan.settlement.product_pricing_amount,
          gross_profit_amount: plan.settlement.gross_profit_amount }, transaction });
        if (updated !== 1) throw new Error(`Settlement changed: ${plan.order.order_no}`);
      }
      if (plan.ledgers.length && !same(plan.snapshot.gross_profit_amount, plan.after.grossProfitAmount)) {
        const participants = normalizeParticipants(plan.order);
        const shares = allocateProfit(participants, plan.after.grossProfitAmount);
        const shareByKey = new Map(participants.map((p, index) => [p.key, shares[index]]));
        const groups = new Map();
        for (const ledger of plan.ledgers) {
          if (!groups.has(ledger.return_id)) groups.set(ledger.return_id, []);
          groups.get(ledger.return_id).push(ledger);
        }
        for (const group of groups.values()) {
          const returned = -money(group.reduce((sum, x) => sum + Number(x.returned_sales_amount || 0), 0));
          const reversed = money(Number(plan.order.total_amount || 0) > 0
            ? plan.after.grossProfitAmount * returned / Number(plan.order.total_amount)
            : Number(plan.snapshot.gross_profit_amount)
              ? -group.reduce((sum, x) => sum + Number(x.gross_profit_amount || 0), 0) *
                plan.after.grossProfitAmount / Number(plan.snapshot.gross_profit_amount) : 0);
          let allocated = 0;
          for (let index = 0; index < group.length; index++) {
            const ledger = group[index];
            const next = index === group.length - 1 ? money(-reversed - allocated)
              : plan.after.grossProfitAmount && shareByKey.has(ledger.participant_key)
                ? money(-reversed * shareByKey.get(ledger.participant_key) / plan.after.grossProfitAmount)
                : money(-reversed / group.length);
            allocated = money(allocated + next);
            const [updated] = await SalesReturnGrossProfitLedger.update({ gross_profit_amount: next }, {
              where: { ledger_id: ledger.ledger_id, gross_profit_amount: ledger.gross_profit_amount }, transaction
            });
            if (updated !== 1) throw new Error(`Return ledger changed: ${plan.order.order_no}`);
          }
        }
      }
    }
  });
  console.log(JSON.stringify({ applied: true, backupFile, ...summary }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => sequelize.close());
