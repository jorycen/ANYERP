// Align October 2026 product-side settlement lines with the corrected order snapshots.
// Preview by default; pass --execute to apply the guarded update.
const { Op } = require('sequelize');
const { sequelize, OrderGrossProfit, ProductSettlementOrder, ProductSettlementItem } = require('../src/models');
const { recordBusinessAction } = require('../src/utils/businessActionLog');

const CALCULATED_BY = 'october_supplier_company_price_refresh';
const SUPPLIER_IDS = new Set(['SP2026091522196', 'SP2026071555763']);

function money(value) {
  return Number((Number(value || 0)).toFixed(2));
}

function array(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  const rows = JSON.parse(value);
  if (!Array.isArray(rows)) throw new Error('商品定价明细不是数组');
  return rows;
}

function summarize(items) {
  const productPricingAmount = money(items.reduce((sum, item) => sum + money(item.product_unit_price) * Number(item.quantity || 1), 0));
  const purchaseCostAmount = money(items.reduce((sum, item) => sum + money(item.purchase_cost_amount), 0));
  const pending = items.filter(item => item.cost_status !== 'ready');
  const costPendingAmount = money(pending.reduce((sum, item) => sum + money(item.product_unit_price) * Number(item.quantity || 1), 0));
  return {
    productPricingAmount, purchaseCostAmount, costPendingAmount,
    grossProfitAmount: pending.length ? 0 : money(productPricingAmount - purchaseCostAmount),
    status: pending.length ? 'cost_pending' : 'posted'
  };
}

async function main() {
  const execute = process.argv.includes('--execute');
  const snapshots = await OrderGrossProfit.findAll({ where: { calculated_by: CALCULATED_BY }, raw: true });
  const orderIds = snapshots.map(snapshot => snapshot.order_id);
  const settlements = orderIds.length ? await ProductSettlementOrder.findAll({
    where: { source_order_id: { [Op.in]: orderIds } }, raw: true
  }) : [];
  const settlementByOrder = new Map(settlements.map(row => [row.source_order_id, row]));
  const settlementIds = settlements.map(row => row.settlement_id);
  const items = settlementIds.length ? await ProductSettlementItem.findAll({
    where: { settlement_id: { [Op.in]: settlementIds } }, raw: true
  }) : [];
  const itemsBySettlement = new Map();
  items.forEach(item => {
    const rows = itemsBySettlement.get(item.settlement_id) || [];
    rows.push(item);
    itemsBySettlement.set(item.settlement_id, rows);
  });
  const summary = {
    scannedOrders: snapshots.length, affectedSettlements: 0, affectedItems: 0,
    amountChangedSettlements: 0, beforePricing: 0, afterPricing: 0,
    beforeGrossProfit: 0, afterGrossProfit: 0, changes: []
  };

  for (const snapshot of snapshots) {
    const settlement = settlementByOrder.get(snapshot.order_id);
    if (!settlement) throw new Error(`订单 ${snapshot.order_no} 缺少产品端结算单`);
    const originalItems = itemsBySettlement.get(settlement.settlement_id) || [];
    const byOrderItem = new Map(originalItems.map(item => [String(item.source_order_item_id), item]));
    const newItems = originalItems.map(item => ({ ...item }));
    const newByOrderItem = new Map(newItems.map(item => [String(item.source_order_item_id), item]));
    const before = summarize(originalItems);
    if (money(settlement.product_pricing_amount) !== before.productPricingAmount ||
        money(settlement.purchase_cost_amount) !== before.purchaseCostAmount ||
        money(settlement.cost_pending_amount) !== before.costPendingAmount ||
        money(settlement.gross_profit_amount) !== before.grossProfitAmount ||
        settlement.status !== before.status) {
      throw new Error(`订单 ${snapshot.order_no} 产品端结算汇总与明细不一致`);
    }
    const changes = [];
    for (const line of array(snapshot.product_pricing_details)) {
      if (!SUPPLIER_IDS.has(line.supplierId) || line.source !== 'product_standard_price') continue;
      const target = newByOrderItem.get(String(line.itemId));
      const original = byOrderItem.get(String(line.itemId));
      if (!target || !original) throw new Error(`订单 ${snapshot.order_no} 缺少产品端商品行 ${line.itemId}`);
      const newUnitPrice = money(line.unitPricing);
      if (!(newUnitPrice > 0)) throw new Error(`订单 ${snapshot.order_no} 商品 ${line.itemId} 定价无效`);
      const newGrossProfit = target.cost_status === 'ready'
        ? money(newUnitPrice * Number(target.quantity || 1) - money(target.purchase_cost_amount)) : 0;
      if (money(target.product_unit_price) === newUnitPrice &&
          target.product_price_source === 'product_standard_price' &&
          money(target.gross_profit_amount) === newGrossProfit) continue;
      changes.push({ settlementItemId: target.settlement_item_id, orderItemId: line.itemId,
        beforeUnitPrice: money(original.product_unit_price), afterUnitPrice: newUnitPrice,
        beforeItemGrossProfit: money(original.gross_profit_amount), afterItemGrossProfit: newGrossProfit });
      target.product_unit_price = newUnitPrice;
      target.product_price_source = 'product_standard_price';
      target.gross_profit_amount = newGrossProfit;
    }
    if (!changes.length) continue;
    const after = summarize(newItems);
    if (execute) {
      await sequelize.transaction(async transaction => {
        const current = await ProductSettlementOrder.findByPk(settlement.settlement_id, {
          transaction, lock: transaction.LOCK.UPDATE
        });
        if (!current || money(current.product_pricing_amount) !== before.productPricingAmount ||
            money(current.gross_profit_amount) !== before.grossProfitAmount || current.status !== before.status) {
          throw new Error(`订单 ${snapshot.order_no} 产品端结算单已变化`);
        }
        for (const change of changes) {
          const original = originalItems.find(item => item.settlement_item_id === change.settlementItemId);
          const [updated] = await ProductSettlementItem.update({
            product_unit_price: change.afterUnitPrice,
            product_price_source: 'product_standard_price',
            gross_profit_amount: change.afterItemGrossProfit
          }, { where: {
            settlement_item_id: change.settlementItemId,
            product_unit_price: original.product_unit_price,
            gross_profit_amount: original.gross_profit_amount
          }, transaction });
          if (updated !== 1) throw new Error(`商品行 ${change.orderItemId} 已变化，事务已回滚`);
        }
        await current.update({
          product_pricing_amount: after.productPricingAmount,
          cost_pending_amount: after.costPendingAmount,
          gross_profit_amount: after.grossProfitAmount,
          update_time: new Date()
        }, { transaction });
        await recordBusinessAction({
          businessType: 'product_settlement', businessId: settlement.settlement_id,
          businessNo: settlement.settlement_no, action: 'gross_profit_corrected',
          fromStatus: before.status, toStatus: after.status,
          user: { name: 'system_october_supplier_company_price_refresh' },
          comment: '按2026年10月销售订单毛利快照同步指定来源商品定价，保留采购成本与其他商品明细',
          detail: { orderNo: snapshot.order_no, before, after, items: changes }, transaction
        });
      });
    }
    summary.affectedSettlements += 1;
    summary.affectedItems += changes.length;
    if (before.grossProfitAmount !== after.grossProfitAmount) summary.amountChangedSettlements += 1;
    summary.beforePricing = money(summary.beforePricing + before.productPricingAmount);
    summary.afterPricing = money(summary.afterPricing + after.productPricingAmount);
    summary.beforeGrossProfit = money(summary.beforeGrossProfit + before.grossProfitAmount);
    summary.afterGrossProfit = money(summary.afterGrossProfit + after.grossProfitAmount);
    summary.changes.push({ orderNo: snapshot.order_no, before, after, items: changes });
  }
  console.log(JSON.stringify({ mode: execute ? 'executed' : 'preview', ...summary }, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => sequelize.close());
