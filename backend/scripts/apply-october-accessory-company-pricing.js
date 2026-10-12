// Apply the accessory cost rule to priced products and October 2026 final orders only.
// Preview by default; --execute writes a local backup before changing any rows.
const fs = require('fs');
const path = require('path');
const { Op, QueryTypes } = require('sequelize');
const { sequelize, Product, Order, OrderGrossProfit, ProductSettlementOrder,
  ProductSettlementItem, SalesReturnGrossProfitLedger } = require('../src/models');
const { calculateGrossProfitValues, roundMoney } = require('../src/modules/sales/grossProfit');
const { _test: { summarizeProductSettlementItems } } = require('../src/modules/report/productSettlement');
const { normalizeParticipants } = require('../src/modules/report/dashboardDataSource');
const { allocateProfit } = require('../src/modules/report/performanceAllocation');

const execute = process.argv.includes('--execute');
const outputDir = path.join(__dirname, '../../backup');
const marker = 'october_accessory_company_pricing_20261012';
function array(value) {
  const rows = Array.isArray(value) ? value : JSON.parse(value || '[]');
  if (!Array.isArray(rows)) throw new Error('Invalid snapshot detail array');
  return rows;
}
function calculate(order, snapshot, lines) {
  const supplements = array(snapshot.supplement_details);
  return calculateGrossProfitValues({
    receivableAmount: snapshot.receivable_amount,
    paymentDetails: array(snapshot.payment_fee_details),
    productPricingDetails: lines,
    supplementDetails: supplements.filter(item => item.source !== 'freight_cost'),
    freightCostDetails: supplements.filter(item => item.source === 'freight_cost'),
    invoiceAmount: snapshot.invoice_amount,
    invoiceStatus: order.invoice_status,
    externalAdjustmentEligible: lines.some(item => item.externalAdjustmentEligible === true)
  });
}
function sameAmount(a, b) { return roundMoney(a) === roundMoney(b); }

async function main() {
  const products = await sequelize.query(`
    SELECT p.PRODUCT_ID product_id, p.GROSS_PROFIT_COST_MODE cost_mode,
           pp.STANDARD_PRICE standard_price
      FROM T_PRODUCT p JOIN T_PRODUCT_PRICE pp ON pp.PRODUCT_ID = p.PRODUCT_ID
     WHERE p.CATEGORY = CONVERT(UNHEX('E98089E4BBB6') USING utf8mb4)
       AND pp.STATUS = 1 AND pp.STANDARD_PRICE > 0`, { type: QueryTypes.SELECT });
  const priceById = new Map(products.map(row => [String(row.product_id), roundMoney(row.standard_price)]));
  const productChanges = products.filter(row => row.cost_mode !== 'COMPANY_PRICE');
  const orderRows = await sequelize.query(`
    SELECT DISTINCT o.ORDER_ID order_id, o.ORDER_NO order_no
      FROM T_ORDER o JOIN T_ORDER_ITEM oi ON oi.ORDER_ID = o.ORDER_ID
     WHERE o.IS_DELETED = 0 AND oi.PRODUCT_ID IN (:productIds)
       AND ((o.CREATE_TIME >= '2026-10-01' AND o.CREATE_TIME < '2026-11-01')
         OR (o.ARCHIVE_TIME >= '2026-10-01' AND o.ARCHIVE_TIME < '2026-11-01'))`,
    { replacements: { productIds: [...priceById.keys()] }, type: QueryTypes.SELECT });
  const orderIds = orderRows.map(row => row.order_id);
  const [orders, snapshots, settlements, ledgers] = await Promise.all([
    Order.findAll({ where: { order_id: { [Op.in]: orderIds } }, raw: true }),
    OrderGrossProfit.findAll({ where: { order_id: { [Op.in]: orderIds } }, raw: true }),
    ProductSettlementOrder.findAll({ where: { source_order_id: { [Op.in]: orderIds } }, raw: true }),
    SalesReturnGrossProfitLedger.findAll({ where: { order_id: { [Op.in]: orderIds } }, raw: true })
  ]);
  const orderMap = new Map(orders.map(row => [row.order_id, row]));
  const snapshotMap = new Map(snapshots.map(row => [row.order_id, row]));
  const settlementMap = new Map(settlements.map(row => [row.source_order_id, row]));
  const settlementItems = settlements.length ? await ProductSettlementItem.findAll({
    where: { settlement_id: { [Op.in]: settlements.map(row => row.settlement_id) } }, raw: true
  }) : [];
  const itemsBySettlement = new Map();
  for (const item of settlementItems) {
    if (!itemsBySettlement.has(item.settlement_id)) itemsBySettlement.set(item.settlement_id, []);
    itemsBySettlement.get(item.settlement_id).push(item);
  }
  const ledgerByOrder = new Map();
  for (const row of ledgers) {
    if (!ledgerByOrder.has(row.order_id)) ledgerByOrder.set(row.order_id, []);
    ledgerByOrder.get(row.order_id).push(row);
  }
  const summary = { mode: execute ? 'execute' : 'preview', pricedAccessories: products.length,
    productTagChanges: productChanges.length, octoberOrders: orderRows.length,
    changedOrders: 0, changedLines: 0, changedGrossProfitOrders: 0,
    beforeGrossProfit: 0, afterGrossProfit: 0, changedSettlements: 0,
    skipped: [], returnLedgerOrders: 0 };
  const plans = [];
  for (const row of orderRows) {
    const order = orderMap.get(row.order_id);
    const snapshot = snapshotMap.get(row.order_id);
    if (!snapshot || snapshot.snapshot_status !== 'final') continue;
    const beforeLines = array(snapshot.product_pricing_details);
    const afterLines = beforeLines.map(line => ({ ...line }));
    const changedLines = [];
    for (const line of afterLines) {
      const standardPrice = priceById.get(String(line.productId));
      if (!(standardPrice > 0)) continue;
      const specialPrice = Number(line.specialPrice || 0);
      const expected = specialPrice > 0 ? roundMoney(specialPrice) : standardPrice;
      const source = specialPrice > 0 ? 'sn_special_price' : 'product_standard_price';
      if (sameAmount(line.unitPricing, expected) && line.source === source &&
          line.isCompanyPriced === true && line.externalAdjustmentEligible !== true) continue;
      changedLines.push({ itemId: line.itemId, productId: line.productId,
        beforeUnitPricing: line.unitPricing, afterUnitPricing: expected, beforeSource: line.source, afterSource: source });
      line.unitPricing = expected;
      line.pricingAmount = roundMoney(expected * Number(line.quantity || 1));
      line.source = source;
      line.isCompanyPriced = true;
      line.grossProfitUpliftAmount = 0;
      line.externalAdjustmentEligible = false;
    }
    if (!changedLines.length) continue;
    const baseline = calculate(order, snapshot, beforeLines);
    if (!sameAmount(baseline.productPricingAmount, snapshot.product_pricing_amount) ||
        !sameAmount(baseline.paymentFeeAmount, snapshot.payment_fee_amount) ||
        !sameAmount(baseline.vatAmount, snapshot.vat_amount) ||
        !sameAmount(baseline.grossProfitAmount, snapshot.gross_profit_amount)) {
      summary.skipped.push({ orderNo: row.order_no, reason: 'snapshot baseline drift', version: snapshot.formula_version });
      continue;
    }
    const after = calculate(order, snapshot, afterLines);
    const settlement = settlementMap.get(row.order_id);
    const originalItems = settlement ? itemsBySettlement.get(settlement.settlement_id) || [] : [];
    const afterItems = originalItems.map(item => ({ ...item }));
    const afterByItemId = new Map(afterItems.map(item => [String(item.source_order_item_id), item]));
    let afterSettlement = null;
    if (settlement) {
      const beforeSettlement = summarizeProductSettlementItems(originalItems);
      if (!sameAmount(beforeSettlement.productPricingAmount, settlement.product_pricing_amount) ||
          !sameAmount(beforeSettlement.grossProfitAmount, settlement.gross_profit_amount) ||
          beforeSettlement.status !== settlement.status) {
        summary.skipped.push({ orderNo: row.order_no, reason: 'settlement baseline drift' });
        continue;
      }
      let missing = false;
      for (const change of changedLines) {
        const target = afterByItemId.get(String(change.itemId));
        if (!target || String(target.product_id) !== String(change.productId)) { missing = true; break; }
        target.product_unit_price = change.afterUnitPricing;
        target.product_price_source = change.afterSource;
        target.gross_profit_amount = target.cost_status === 'ready'
          ? roundMoney(change.afterUnitPricing * Number(target.quantity || 1) - Number(target.purchase_cost_amount || 0)) : 0;
      }
      if (missing) { summary.skipped.push({ orderNo: row.order_no, reason: 'missing settlement item' }); continue; }
      afterSettlement = summarizeProductSettlementItems(afterItems);
    }
    plans.push({ row, order, snapshot, beforeLines, afterLines, after, changedLines,
      settlement, originalItems, afterItems, afterSettlement, ledgers: ledgerByOrder.get(row.order_id) || [] });
    summary.changedOrders += 1;
    summary.changedLines += changedLines.length;
    if (!sameAmount(snapshot.gross_profit_amount, after.grossProfitAmount)) summary.changedGrossProfitOrders += 1;
    summary.beforeGrossProfit = roundMoney(summary.beforeGrossProfit + Number(snapshot.gross_profit_amount));
    summary.afterGrossProfit = roundMoney(summary.afterGrossProfit + after.grossProfitAmount);
    if (settlement) summary.changedSettlements += 1;
    if ((ledgerByOrder.get(row.order_id) || []).length) summary.returnLedgerOrders += 1;
  }
  console.log(JSON.stringify(summary, null, 2));
  if (!execute) return;
  fs.mkdirSync(outputDir, { recursive: true });
  const backupFile = path.join(outputDir, `${marker}-before.json`);
  fs.writeFileSync(backupFile, JSON.stringify({ productChanges, plans: plans.map(plan => ({
    order: plan.order, snapshot: plan.snapshot, settlement: plan.settlement,
    settlementItems: plan.originalItems, returnLedgers: plan.ledgers
  })) }, null, 2), { flag: 'wx' });
  await sequelize.transaction(async transaction => {
    for (const product of productChanges) {
      const [updated] = await Product.update({ gross_profit_cost_mode: 'COMPANY_PRICE' }, {
        where: { product_id: product.product_id, gross_profit_cost_mode: product.cost_mode }, transaction
      });
      if (updated !== 1) throw new Error(`Product changed: ${product.product_id}`);
    }
    for (const plan of plans) {
      const current = await OrderGrossProfit.findByPk(plan.snapshot.gross_profit_id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!current || JSON.stringify(array(current.product_pricing_details)) !== JSON.stringify(plan.beforeLines) ||
          !sameAmount(current.gross_profit_amount, plan.snapshot.gross_profit_amount)) {
        throw new Error(`Snapshot changed: ${plan.row.order_no}`);
      }
      await current.update({ product_pricing_details: plan.afterLines,
        product_pricing_amount: plan.after.productPricingAmount,
        vat_taxable_amount: plan.after.vatTaxableAmount, vat_amount: plan.after.vatAmount,
        gross_profit_amount: plan.after.grossProfitAmount,
        calculated_by: marker, calculated_at: new Date(), update_time: new Date() }, { transaction });
      if (plan.settlement) {
        const beforeById = new Map(plan.originalItems.map(item => [String(item.settlement_item_id), item]));
        for (const item of plan.afterItems) {
          const before = beforeById.get(String(item.settlement_item_id));
          if (sameAmount(before.product_unit_price, item.product_unit_price) &&
              before.product_price_source === item.product_price_source &&
              sameAmount(before.gross_profit_amount, item.gross_profit_amount)) continue;
          const [updated] = await ProductSettlementItem.update({ product_unit_price: item.product_unit_price,
            product_price_source: item.product_price_source, gross_profit_amount: item.gross_profit_amount }, {
            where: { settlement_item_id: item.settlement_item_id, product_unit_price: before.product_unit_price,
              gross_profit_amount: before.gross_profit_amount }, transaction
          });
          if (updated !== 1) throw new Error(`Settlement item changed: ${plan.row.order_no}`);
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
        if (updated !== 1) throw new Error(`Settlement changed: ${plan.row.order_no}`);
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
          const returnedSales = -roundMoney(group.reduce((sum, r) => sum + Number(r.returned_sales_amount || 0), 0));
          const reversed = roundMoney(Number(plan.order.total_amount || 0) > 0
            ? plan.after.grossProfitAmount * returnedSales / Number(plan.order.total_amount)
            : Number(plan.snapshot.gross_profit_amount)
              ? -group.reduce((sum, row) => sum + Number(row.gross_profit_amount || 0), 0) *
                plan.after.grossProfitAmount / Number(plan.snapshot.gross_profit_amount)
              : 0);
          let allocated = 0;
          for (let i = 0; i < group.length; i += 1) {
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
