// SN-specific company price correction. Preview by default; --execute applies it.
const fs = require('fs');
const path = require('path');
const { Op, QueryTypes } = require('sequelize');
const { sequelize, ProductSn, Order, OrderGrossProfit, ProductSettlementOrder,
  ProductSettlementItem, SalesReturnGrossProfitLedger } = require('../src/models');
const { calculateGrossProfitValues, roundMoney } = require('../src/modules/sales/grossProfit');
const { _test: { summarizeProductSettlementItems } } = require('../src/modules/report/productSettlement');
const { normalizeParticipants } = require('../src/modules/report/dashboardDataSource');
const { allocateProfit } = require('../src/modules/report/performanceAllocation');

const codes = `PF6DWF7C HA2MH2ET BH028NR1 HA2LYFAQ HA2JF84R HA2EF57A HA2Q0SCB HA2Q01B5 HA2PW7EL 870056914AHLL6890284 MP31370T MP31399W BH02531N BH02539P BH02533P PF656NYZ MP2V9VCE MP2VFE4R MP2VFDTW MP2VF9GX BH02DM3C BH028ZB5 BH02DLXA BH02DMLM BH02DMH4 BH02DMJ6 BH028ZDA BH028ZAL BH02DMFE BH02D0ND BH02CFB3 BH028ZEX BH02DMM3`.split(' ');
const execute = process.argv.includes('--execute');
const marker = 'october_specified_sn_company_pricing_20261012';
function array(value) {
  const rows = Array.isArray(value) ? value : JSON.parse(value || '[]');
  if (!Array.isArray(rows)) throw new Error('Invalid detail array');
  return rows;
}
function same(a, b) { return roundMoney(a) === roundMoney(b); }
function calculate(order, snapshot, lines) {
  const supplements = array(snapshot.supplement_details);
  return calculateGrossProfitValues({
    receivableAmount: snapshot.receivable_amount,
    paymentDetails: array(snapshot.payment_fee_details), productPricingDetails: lines,
    supplementDetails: supplements.filter(x => x.source !== 'freight_cost'),
    freightCostDetails: supplements.filter(x => x.source === 'freight_cost'),
    invoiceAmount: snapshot.invoice_amount, invoiceStatus: order.invoice_status,
    externalAdjustmentEligible: lines.some(x => x.externalAdjustmentEligible === true)
  });
}

async function main() {
  const sns = await sequelize.query(`
    SELECT sn.SN_ID snId, sn.SN_CODE snCode, sn.PRODUCT_ID productId,
           sn.GROSS_PROFIT_USE_STANDARD_PRICE useStandardPrice,
           sn.IS_DELETED isDeleted, p.IS_DELETED productDeleted,
           pp.STANDARD_PRICE standardPrice, pp.STATUS priceStatus
      FROM T_PRODUCT_SN sn JOIN T_PRODUCT p ON p.PRODUCT_ID=sn.PRODUCT_ID
      LEFT JOIN T_PRODUCT_PRICE pp ON pp.PRODUCT_ID=p.PRODUCT_ID
     WHERE sn.SN_CODE IN (:codes)`, { replacements: { codes }, type: QueryTypes.SELECT });
  if (sns.length !== codes.length || new Set(sns.map(x => x.snCode)).size !== codes.length ||
      sns.some(x => Number(x.isDeleted) !== 0 || Number(x.productDeleted) !== 0 ||
        Number(x.priceStatus) !== 1 || !(Number(x.standardPrice) > 0))) {
    throw new Error('SN matching or active company prices changed; no update made');
  }
  const bySnId = new Map(sns.map(x => [x.snId, x]));
  const bySnCode = new Map(sns.map(x => [x.snCode, x]));
  const rows = await sequelize.query(`
    SELECT o.ORDER_ID orderId, o.ORDER_NO orderNo, oi.ITEM_ID itemId,
           oi.SN_ID snId, oi.SN_CODE snCode, oi.PRODUCT_ID productId
      FROM T_ORDER o JOIN T_ORDER_ITEM oi ON oi.ORDER_ID=o.ORDER_ID
     WHERE o.IS_DELETED=0 AND (oi.SN_ID IN (:snIds) OR oi.SN_CODE IN (:codes))
       AND ((o.CREATE_TIME>='2026-10-01' AND o.CREATE_TIME<'2026-11-01')
         OR (o.ARCHIVE_TIME>='2026-10-01' AND o.ARCHIVE_TIME<'2026-11-01'))`,
    { replacements: { snIds: sns.map(x => x.snId), codes }, type: QueryTypes.SELECT });
  const orderIds = [...new Set(rows.map(x => x.orderId))];
  const [orders, snapshots, settlements, ledgers] = await Promise.all([
    Order.findAll({ where: { order_id: { [Op.in]: orderIds } }, raw: true }),
    OrderGrossProfit.findAll({ where: { order_id: { [Op.in]: orderIds } }, raw: true }),
    ProductSettlementOrder.findAll({ where: { source_order_id: { [Op.in]: orderIds } }, raw: true }),
    SalesReturnGrossProfitLedger.findAll({ where: { order_id: { [Op.in]: orderIds } }, raw: true })
  ]);
  const orderById = new Map(orders.map(x => [x.order_id, x]));
  const snapshotById = new Map(snapshots.map(x => [x.order_id, x]));
  const settlementById = new Map(settlements.map(x => [x.source_order_id, x]));
  const settlementItems = settlements.length ? await ProductSettlementItem.findAll({
    where: { settlement_id: { [Op.in]: settlements.map(x => x.settlement_id) } }, raw: true
  }) : [];
  const itemsBySettlement = new Map();
  for (const item of settlementItems) {
    if (!itemsBySettlement.has(item.settlement_id)) itemsBySettlement.set(item.settlement_id, []);
    itemsBySettlement.get(item.settlement_id).push(item);
  }
  const ledgersByOrder = new Map();
  for (const ledger of ledgers) {
    if (!ledgersByOrder.has(ledger.order_id)) ledgersByOrder.set(ledger.order_id, []);
    ledgersByOrder.get(ledger.order_id).push(ledger);
  }
  const rowsByOrder = new Map();
  for (const row of rows) {
    if (!rowsByOrder.has(row.orderId)) rowsByOrder.set(row.orderId, []);
    rowsByOrder.get(row.orderId).push(row);
  }
  const summary = { mode: execute ? 'execute' : 'preview', requestedSn: codes.length,
    newSnOverrides: sns.filter(x => Number(x.useStandardPrice) !== 1).length,
    octoberOrderLines: rows.length, octoberOrders: orderIds.length,
    changedOrders: 0, changedLines: 0, changedGrossProfitOrders: 0,
    beforeGrossProfit: 0, afterGrossProfit: 0, changedSettlements: 0,
    returnLedgerOrders: 0, skipped: [] };
  const plans = [];
  for (const orderId of orderIds) {
    const order = orderById.get(orderId);
    const snapshot = snapshotById.get(orderId);
    if (!snapshot || snapshot.snapshot_status !== 'final') continue;
    const beforeLines = array(snapshot.product_pricing_details);
    const afterLines = beforeLines.map(x => ({ ...x }));
    const itemMap = new Map(rowsByOrder.get(orderId).map(x => [String(x.itemId), x]));
    const changes = [];
    for (const line of afterLines) {
      const item = itemMap.get(String(line.itemId));
      if (!item) continue;
      const sn = bySnId.get(item.snId) || bySnCode.get(item.snCode);
      if (!sn || sn.productId !== item.productId || String(line.productId) !== String(item.productId)) {
        throw new Error(`SN or product mismatch in ${order.order_no}`);
      }
      const special = Number(line.specialPrice || 0);
      const nextUnit = special > 0 ? roundMoney(special) : roundMoney(sn.standardPrice);
      const nextSource = special > 0 ? 'sn_special_price' : 'product_standard_price';
      if (same(line.unitPricing, nextUnit) && line.source === nextSource &&
          line.isCompanyPriced === true && line.externalAdjustmentEligible !== true) continue;
      changes.push({ itemId: item.itemId, snCode: sn.snCode,
        beforeUnit: line.unitPricing, afterUnit: nextUnit, beforeSource: line.source, afterSource: nextSource });
      line.unitPricing = nextUnit;
      line.pricingAmount = roundMoney(nextUnit * Number(line.quantity || 1));
      line.source = nextSource;
      line.isCompanyPriced = true;
      line.grossProfitUpliftAmount = 0;
      line.externalAdjustmentEligible = false;
    }
    if (!changes.length) continue;
    const before = calculate(order, snapshot, beforeLines);
    if (!same(before.productPricingAmount, snapshot.product_pricing_amount) ||
        !same(before.paymentFeeAmount, snapshot.payment_fee_amount) ||
        !same(before.vatAmount, snapshot.vat_amount) ||
        !same(before.grossProfitAmount, snapshot.gross_profit_amount)) {
      summary.skipped.push({ orderNo: order.order_no, reason: 'snapshot baseline drift' });
      continue;
    }
    const after = calculate(order, snapshot, afterLines);
    const settlement = settlementById.get(orderId);
    const originalItems = settlement ? itemsBySettlement.get(settlement.settlement_id) || [] : [];
    const afterItems = originalItems.map(x => ({ ...x }));
    let afterSettlement = null;
    if (settlement) {
      const originalSummary = summarizeProductSettlementItems(originalItems);
      if (!same(originalSummary.productPricingAmount, settlement.product_pricing_amount) ||
          !same(originalSummary.grossProfitAmount, settlement.gross_profit_amount) ||
          originalSummary.status !== settlement.status) {
        summary.skipped.push({ orderNo: order.order_no, reason: 'settlement baseline drift' });
        continue;
      }
      for (const change of changes) {
        const target = afterItems.find(x => String(x.source_order_item_id) === String(change.itemId));
        if (!target) throw new Error(`Missing settlement item in ${order.order_no}`);
        target.product_unit_price = change.afterUnit;
        target.product_price_source = change.afterSource;
        target.gross_profit_amount = target.cost_status === 'ready'
          ? roundMoney(change.afterUnit * Number(target.quantity || 1) - Number(target.purchase_cost_amount || 0)) : 0;
      }
      afterSettlement = summarizeProductSettlementItems(afterItems);
    }
    plans.push({ order, snapshot, beforeLines, afterLines, after, changes, settlement,
      originalItems, afterItems, afterSettlement, ledgers: ledgersByOrder.get(orderId) || [] });
    summary.changedOrders++;
    summary.changedLines += changes.length;
    if (!same(snapshot.gross_profit_amount, after.grossProfitAmount)) summary.changedGrossProfitOrders++;
    summary.beforeGrossProfit = roundMoney(summary.beforeGrossProfit + Number(snapshot.gross_profit_amount));
    summary.afterGrossProfit = roundMoney(summary.afterGrossProfit + after.grossProfitAmount);
    if (settlement) summary.changedSettlements++;
    if (ledgersByOrder.has(orderId)) summary.returnLedgerOrders++;
  }
  console.log(JSON.stringify(summary, null, 2));
  if (!execute) return;
  const backupDir = path.join(__dirname, '../../backup');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, `${marker}-before.json`);
  fs.writeFileSync(backupFile, JSON.stringify({ sns, plans: plans.map(p => ({ order: p.order,
    snapshot: p.snapshot, settlement: p.settlement, items: p.originalItems, ledgers: p.ledgers })) }, null, 2), { flag: 'wx' });
  await sequelize.transaction(async transaction => {
    for (const sn of sns) {
      if (Number(sn.useStandardPrice) === 1) continue;
      const [updated] = await ProductSn.update({ gross_profit_use_standard_price: 1 }, {
        where: { sn_id: sn.snId, gross_profit_use_standard_price: sn.useStandardPrice }, transaction
      });
      if (updated !== 1) throw new Error(`SN changed: ${sn.snCode}`);
    }
    for (const plan of plans) {
      const current = await OrderGrossProfit.findByPk(plan.snapshot.gross_profit_id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!current || JSON.stringify(array(current.product_pricing_details)) !== JSON.stringify(plan.beforeLines) ||
          !same(current.gross_profit_amount, plan.snapshot.gross_profit_amount)) {
        throw new Error(`Snapshot changed: ${plan.order.order_no}`);
      }
      await current.update({ product_pricing_details: plan.afterLines,
        product_pricing_amount: plan.after.productPricingAmount,
        vat_taxable_amount: plan.after.vatTaxableAmount, vat_amount: plan.after.vatAmount,
        gross_profit_amount: plan.after.grossProfitAmount, calculated_by: marker,
        calculated_at: new Date(), update_time: new Date() }, { transaction });
      if (plan.settlement) {
        for (let i = 0; i < plan.afterItems.length; i++) {
          const before = plan.originalItems[i], afterItem = plan.afterItems[i];
          if (same(before.product_unit_price, afterItem.product_unit_price) &&
              before.product_price_source === afterItem.product_price_source &&
              same(before.gross_profit_amount, afterItem.gross_profit_amount)) continue;
          const [updated] = await ProductSettlementItem.update({
            product_unit_price: afterItem.product_unit_price,
            product_price_source: afterItem.product_price_source,
            gross_profit_amount: afterItem.gross_profit_amount
          }, { where: { settlement_item_id: before.settlement_item_id,
            product_unit_price: before.product_unit_price,
            gross_profit_amount: before.gross_profit_amount }, transaction });
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
      if (plan.ledgers.length) {
        const participants = normalizeParticipants(plan.order);
        const shares = allocateProfit(participants, plan.after.grossProfitAmount);
        const shareByKey = new Map(participants.map((p, i) => [p.key, shares[i]]));
        const groups = new Map();
        for (const ledger of plan.ledgers) {
          if (!groups.has(ledger.return_id)) groups.set(ledger.return_id, []);
          groups.get(ledger.return_id).push(ledger);
        }
        for (const group of groups.values()) {
          const returned = -roundMoney(group.reduce((sum, x) => sum + Number(x.returned_sales_amount || 0), 0));
          const reversed = roundMoney(Number(plan.order.total_amount || 0) > 0
            ? plan.after.grossProfitAmount * returned / Number(plan.order.total_amount)
            : Number(plan.snapshot.gross_profit_amount)
              ? -group.reduce((sum, x) => sum + Number(x.gross_profit_amount || 0), 0) *
                plan.after.grossProfitAmount / Number(plan.snapshot.gross_profit_amount) : 0);
          let allocated = 0;
          for (let i = 0; i < group.length; i++) {
            const ledger = group[i];
            const next = i === group.length - 1 ? roundMoney(-reversed - allocated)
              : plan.after.grossProfitAmount && shareByKey.has(ledger.participant_key)
                ? roundMoney(-reversed * shareByKey.get(ledger.participant_key) / plan.after.grossProfitAmount)
                : roundMoney(-reversed / group.length);
            allocated = roundMoney(allocated + next);
            await SalesReturnGrossProfitLedger.update({ gross_profit_amount: next }, {
              where: { return_id: ledger.return_id, participant_key: ledger.participant_key,
                gross_profit_amount: ledger.gross_profit_amount }, transaction });
          }
        }
      }
    }
  });
  console.log(JSON.stringify({ applied: true, backupFile, ...summary }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => sequelize.close());
