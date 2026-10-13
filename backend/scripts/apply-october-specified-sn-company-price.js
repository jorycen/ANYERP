// Set the listed serialized units to company-price cost and refresh their October 2026 final orders.
// Preview by default. --execute backs up all affected rows before applying each order atomically.
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const {
  sequelize, ProductSn, Order, OrderItem, OrderGrossProfit,
  ProductSettlementOrder, ProductSettlementItem, SalesReturnGrossProfitLedger
} = require('../src/models');
const { FORMULA_VERSION, calculateAndSaveOrderGrossProfit, roundMoney } = require('../src/modules/sales/grossProfit');
const { _test: { summarizeProductSettlementItems } } = require('../src/modules/report/productSettlement');
const { normalizeParticipants } = require('../src/modules/report/dashboardDataSource');
const { allocateProfit } = require('../src/modules/report/performanceAllocation');

const CODES = [
  'HA2QPD92', 'HA2QNGX2', 'PF5XXM4V', 'MP2SKXMX',
  'HA2GPVR1', 'PF5RM4GJ', 'QX71M77540Z8AW0NXT'
];
const execute = process.argv.includes('--execute');
const actor = 'october_specified_sn_company_price_20261013';
function array(value) { return Array.isArray(value) ? value : JSON.parse(value || '[]'); }
function same(a, b) { return roundMoney(a) === roundMoney(b); }

async function main() {
  const sns = await ProductSn.findAll({ where: { sn_code: { [Op.in]: CODES } }, raw: true });
  if (sns.length !== CODES.length || CODES.some(code => !sns.some(sn => sn.sn_code === code))) {
    throw new Error('Some requested SN codes are missing or duplicated');
  }
  const items = await OrderItem.findAll({ where: { sn_code: { [Op.in]: CODES } }, raw: true });
  const orderIds = [...new Set(items.map(item => item.order_id))];
  const orders = await Order.findAll({ where: { order_id: { [Op.in]: orderIds } }, raw: true });
  const snapshots = await OrderGrossProfit.findAll({ where: { order_id: { [Op.in]: orderIds } }, raw: true });
  const snapshotById = new Map(snapshots.map(row => [row.order_id, row]));
  const finalOrders = orders.filter(order => order.is_deleted === 0 &&
    order.create_time >= new Date('2026-10-01T00:00:00Z') &&
    order.create_time < new Date('2026-11-01T00:00:00Z') &&
    snapshotById.get(order.order_id)?.snapshot_status === 'final');
  const finalIds = new Set(finalOrders.map(order => order.order_id));
  const outOfScope = orders.filter(order => !finalIds.has(order.order_id));
  if (outOfScope.some(order => !String(order.order_status).includes('作废'))) {
    throw new Error('A requested SN has an active order outside October final scope');
  }
  for (const order of finalOrders) {
    if (snapshotById.get(order.order_id).formula_version !== FORMULA_VERSION) {
      throw new Error(`Unexpected formula version: ${order.order_no}`);
    }
  }
  const settlements = await ProductSettlementOrder.findAll({
    where: { source_order_id: { [Op.in]: [...finalIds] } }, raw: true
  });
  const settlementItems = await ProductSettlementItem.findAll({
    where: { settlement_id: { [Op.in]: settlements.map(row => row.settlement_id) } }, raw: true
  });
  const ledgers = await SalesReturnGrossProfitLedger.findAll({
    where: { order_id: { [Op.in]: [...finalIds] } }, raw: true
  });
  const settlementByOrder = new Map(settlements.map(row => [row.source_order_id, row]));
  const itemsBySettlement = new Map();
  for (const item of settlementItems) {
    const group = itemsBySettlement.get(item.settlement_id) || [];
    group.push(item);
    itemsBySettlement.set(item.settlement_id, group);
  }
  const plans = finalOrders.map(order => {
    const snapshot = snapshotById.get(order.order_id);
    const lines = array(snapshot.product_pricing_details);
    const targeted = items.filter(item => item.order_id === order.order_id);
    for (const item of targeted) {
      const line = lines.find(row => String(row.itemId) === String(item.item_id));
      if (!line || line.snCode !== item.sn_code || line.productId !== item.product_id) {
        throw new Error(`Snapshot item mismatch: ${order.order_no}`);
      }
    }
    const settlement = settlementByOrder.get(order.order_id);
    if (!settlement) throw new Error(`Missing product settlement: ${order.order_no}`);
    const originalItems = itemsBySettlement.get(settlement.settlement_id) || [];
    const summary = summarizeProductSettlementItems(originalItems);
    if (!same(summary.productPricingAmount, settlement.product_pricing_amount) ||
        !same(summary.grossProfitAmount, settlement.gross_profit_amount)) {
      throw new Error(`Product settlement drift: ${order.order_no}`);
    }
    return { order, snapshot, lines, targeted, settlement, originalItems };
  });
  console.log(JSON.stringify({ mode: execute ? 'execute' : 'preview',
    snModes: sns.map(sn => ({ sn: sn.sn_code, mode: sn.gross_profit_use_standard_price })),
    finalOrders: plans.map(plan => ({ orderNo: plan.order.order_no,
      lines: plan.targeted.map(item => {
        const line = plan.lines.find(row => String(row.itemId) === String(item.item_id));
        return { sn: item.sn_code, before: line.unitPricing, source: line.source,
          specialPrice: line.specialPrice };
      }) })),
    ignoredVoidedOrders: outOfScope.map(order => order.order_no)
  }, null, 2));
  if (!execute) return;

  const backupFile = path.resolve(__dirname, `../../backup/${actor}-before.json`);
  fs.mkdirSync(path.dirname(backupFile), { recursive: true });
  fs.writeFileSync(backupFile, JSON.stringify({ sns, plans, ledgers }, null, 2), { flag: 'wx' });
  const summary = { updatedSnModes: 0, refreshedOrders: 0, changedGrossProfitOrders: 0,
    beforeGrossProfit: 0, afterGrossProfit: 0, orderChanges: [], backupFile };
  await sequelize.transaction(async transaction => {
    for (const sn of sns) {
      if (Number(sn.gross_profit_use_standard_price) === 1) continue;
      const current = await ProductSn.findByPk(sn.sn_id, { transaction, lock: transaction.LOCK.UPDATE });
      if (current.gross_profit_use_standard_price !== sn.gross_profit_use_standard_price) {
        throw new Error(`SN pricing mode changed: ${sn.sn_code}`);
      }
      await current.update({ gross_profit_use_standard_price: 1 }, { transaction });
      summary.updatedSnModes += 1;
    }
    for (const plan of plans) {
      const before = roundMoney(plan.snapshot.gross_profit_amount);
      const next = await calculateAndSaveOrderGrossProfit(plan.order.order_id, {
        transaction, calculatedBy: actor, force: true, final: true
      });
      const nextLines = array(next.product_pricing_details);
      const targetedIds = new Set(plan.targeted.map(item => String(item.item_id)));
      for (const oldLine of plan.lines) {
        const line = nextLines.find(row => String(row.itemId) === String(oldLine.itemId));
        if (!line) throw new Error(`Missing recalculated line: ${plan.order.order_no}`);
        if (targetedIds.has(String(oldLine.itemId))) {
          if (line.isCompanyPriced !== true || !(line.unitPricing > 0)) {
            throw new Error(`SN did not use company price: ${line.snCode}`);
          }
        } else if (!same(line.unitPricing, oldLine.unitPricing) || line.source !== oldLine.source) {
          throw new Error(`Unrelated line changed: ${plan.order.order_no}, ${oldLine.itemId}`);
        }
      }
      const settlement = await ProductSettlementOrder.findByPk(plan.settlement.settlement_id,
        { transaction, lock: transaction.LOCK.UPDATE });
      if (!same(settlement.product_pricing_amount, plan.settlement.product_pricing_amount)) {
        throw new Error(`Settlement changed concurrently: ${plan.order.order_no}`);
      }
      const settlementRows = await ProductSettlementItem.findAll({
        where: { settlement_id: settlement.settlement_id }, transaction, lock: transaction.LOCK.UPDATE
      });
      const nextByItem = new Map(nextLines.map(line => [String(line.itemId), line]));
      for (const item of settlementRows) {
        const line = nextByItem.get(String(item.source_order_item_id));
        if (!line) throw new Error(`Missing settlement line: ${plan.order.order_no}`);
        const unitPrice = roundMoney(line.unitPricing);
        const lineProfit = item.cost_status === 'ready'
          ? roundMoney(unitPrice * Number(item.quantity || 1) - Number(item.purchase_cost_amount || 0)) : 0;
        if (!same(item.product_unit_price, unitPrice) || item.product_price_source !== line.source ||
            !same(item.gross_profit_amount, lineProfit)) {
          await item.update({ product_unit_price: unitPrice, product_price_source: line.source,
            gross_profit_amount: lineProfit }, { transaction });
        }
      }
      const totals = summarizeProductSettlementItems(settlementRows.map(row => row.toJSON()));
      await settlement.update({ product_pricing_amount: totals.productPricingAmount,
        purchase_cost_amount: totals.purchaseCostAmount,
        cost_pending_amount: totals.costPendingAmount,
        gross_profit_amount: totals.grossProfitAmount,
        status: totals.status, update_time: new Date() }, { transaction });
      const orderLedgers = ledgers.filter(row => row.order_id === plan.order.order_id);
      if (orderLedgers.length) {
        const participants = normalizeParticipants(plan.order);
        const shares = allocateProfit(participants, roundMoney(next.gross_profit_amount));
        const shareByKey = new Map(participants.map((p, i) => [p.key, shares[i]]));
        const byReturn = new Map();
        for (const row of orderLedgers) {
          const group = byReturn.get(row.return_id) || [];
          group.push(row);
          byReturn.set(row.return_id, group);
        }
        for (const group of byReturn.values()) {
          const returnedSales = -roundMoney(group.reduce((sum, row) =>
            sum + Number(row.returned_sales_amount || 0), 0));
          const reversed = roundMoney(Number(plan.order.total_amount || 0) > 0
            ? Number(next.gross_profit_amount) * returnedSales / Number(plan.order.total_amount)
            : before ? -group.reduce((sum, row) => sum + Number(row.gross_profit_amount || 0), 0) *
              Number(next.gross_profit_amount) / before : 0);
          let allocated = 0;
          for (let i = 0; i < group.length; i += 1) {
            const row = group[i];
            const value = i === group.length - 1 ? roundMoney(-reversed - allocated)
              : Number(next.gross_profit_amount) && shareByKey.has(row.participant_key)
                ? roundMoney(-reversed * shareByKey.get(row.participant_key) / Number(next.gross_profit_amount))
                : roundMoney(-reversed / group.length);
            allocated = roundMoney(allocated + value);
            await SalesReturnGrossProfitLedger.update({ gross_profit_amount: value }, {
              where: { return_id: row.return_id, participant_key: row.participant_key,
                gross_profit_amount: row.gross_profit_amount }, transaction
            });
          }
        }
      }
      const after = roundMoney(next.gross_profit_amount);
      summary.refreshedOrders += 1;
      if (!same(before, after)) summary.changedGrossProfitOrders += 1;
      summary.beforeGrossProfit = roundMoney(summary.beforeGrossProfit + before);
      summary.afterGrossProfit = roundMoney(summary.afterGrossProfit + after);
      summary.orderChanges.push({ orderNo: plan.order.order_no, before, after,
        lines: plan.targeted.map(item => {
          const oldLine = plan.lines.find(row => String(row.itemId) === String(item.item_id));
          const line = nextByItem.get(String(item.item_id));
          return { sn: item.sn_code, before: oldLine.unitPricing, after: line.unitPricing,
            source: line.source };
        }) });
    }
  });
  console.log(JSON.stringify(summary, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => sequelize.close());
