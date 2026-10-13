// Apply the October 1, 2026 Care company-price policy to October snapshots.
// Preview by default; --execute updates the current product tag, Care lines,
// order gross profit, and matching product-side settlement rows together.
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const {
  sequelize, Order, OrderGrossProfit, Product, ProductPrice,
  ProductSettlementOrder, ProductSettlementItem
} = require('../src/models');
const { FORMULA_VERSION, calculateGrossProfitValues, roundMoney } = require('../src/modules/sales/grossProfit');
const { _test: { summarizeProductSettlementItems } } = require('../src/modules/report/productSettlement');
const { recordBusinessAction } = require('../src/utils/businessActionLog');

const execute = process.argv.includes('--execute');
const backupFile = path.resolve(__dirname, '../../backup/care-company-pricing-before-20261013.json');

function array(value) {
  if (Array.isArray(value)) return value;
  const parsed = JSON.parse(value || '[]');
  if (!Array.isArray(parsed)) throw new Error('Expected a JSON array');
  return parsed;
}

function calculate(order, snapshot, lines) {
  const supplements = array(snapshot.supplement_details);
  return calculateGrossProfitValues({
    receivableAmount: snapshot.receivable_amount,
    paymentDetails: array(snapshot.payment_fee_details),
    productPricingDetails: lines,
    supplementDetails: supplements.filter(row => row.source !== 'freight_cost'),
    freightCostDetails: supplements.filter(row => row.source === 'freight_cost'),
    invoiceAmount: snapshot.invoice_amount,
    invoiceStatus: order.invoice_status,
    externalAdjustmentEligible: lines.some(row => row.externalAdjustmentEligible === true)
  });
}

async function main() {
  const products = await Product.findAll({
    where: { category: '售后', brand: 'Care服务', is_deleted: 0 }, raw: true
  });
  const ids = products.map(row => row.product_id);
  const prices = await ProductPrice.findAll({
    where: { product_id: { [Op.in]: ids }, status: 1 }, raw: true
  });
  const priceMap = new Map(prices.map(row => [row.product_id, roundMoney(row.standard_price)]));
  const careIds = new Set(ids);
  const snapshots = await OrderGrossProfit.findAll({
    where: { order_no: { [Op.like]: 'ORD202610%' }, snapshot_status: 'final' }, raw: true
  });
  const selected = snapshots.filter(snapshot =>
    array(snapshot.product_pricing_details).some(line => careIds.has(line.productId)));
  const orders = await Order.findAll({
    where: { order_id: { [Op.in]: selected.map(row => row.order_id) } }, raw: true
  });
  const orderMap = new Map(orders.map(row => [row.order_id, row]));
  const settlements = await ProductSettlementOrder.findAll({
    where: { source_order_id: { [Op.in]: selected.map(row => row.order_id) } }, raw: true
  });
  const settlementMap = new Map(settlements.map(row => [row.source_order_id, row]));
  const settlementItems = await ProductSettlementItem.findAll({
    where: { settlement_id: { [Op.in]: settlements.map(row => row.settlement_id) } }, raw: true
  });
  const settlementItemsById = new Map();
  for (const item of settlementItems) {
    if (!settlementItemsById.has(item.settlement_id)) settlementItemsById.set(item.settlement_id, []);
    settlementItemsById.get(item.settlement_id).push(item);
  }

  const plans = [];
  for (const snapshot of selected) {
    const order = orderMap.get(snapshot.order_id);
    if (!order || !['已归档', 'returned'].includes(order.order_status) ||
      !String(order.order_no).startsWith('ORD202610') ||
      String(order.create_time).slice(0, 10) < '2026-10-01') {
      throw new Error(`Order is outside October final scope: ${snapshot.order_no}`);
    }
    if (!['ORDER_GP_V9_FREIGHT_SEPARATE', FORMULA_VERSION].includes(snapshot.formula_version)) {
      throw new Error(`Unexpected formula: ${snapshot.order_no}`);
    }
    const beforeLines = array(snapshot.product_pricing_details);
    const changes = [];
    const afterLines = beforeLines.map(line => {
      if (!careIds.has(line.productId)) return line;
      const price = priceMap.get(line.productId);
      if (!(price > 0)) throw new Error(`Missing Care company price: ${line.pnCode}`);
      if (Number(line.specialPrice || 0) > 0) throw new Error(`Unexpected Care special price: ${snapshot.order_no}`);
      const updated = {
        ...line, unitPricing: price,
        pricingAmount: roundMoney(price * Number(line.quantity || 1)),
        source: 'product_standard_price', isCompanyPriced: true,
        grossProfitUpliftAmount: 0, externalAdjustmentEligible: false
      };
      if (roundMoney(line.unitPricing) !== price || line.source !== updated.source ||
        line.isCompanyPriced !== true || roundMoney(line.pricingAmount) !== updated.pricingAmount) {
        changes.push({ itemId: line.itemId, productId: line.productId, pnCode: line.pnCode,
          before: roundMoney(line.pricingAmount), after: updated.pricingAmount,
          oldSource: line.source || '' });
      }
      return updated;
    });
    if (!changes.length) continue;
    const before = calculate(order, snapshot, beforeLines);
    if (roundMoney(snapshot.product_pricing_amount) !== before.productPricingAmount ||
      roundMoney(snapshot.payment_fee_amount) !== before.paymentFeeAmount ||
      roundMoney(snapshot.vat_amount) !== before.vatAmount ||
      roundMoney(snapshot.gross_profit_amount) !== before.grossProfitAmount) {
      throw new Error(`Original gross-profit snapshot has drift: ${snapshot.order_no}`);
    }
    const after = calculate(order, snapshot, afterLines);
    const settlement = settlementMap.get(order.order_id);
    if (!settlement) throw new Error(`Missing product settlement: ${snapshot.order_no}`);
    const oldItems = settlementItemsById.get(settlement.settlement_id) || [];
    const changedById = new Map(changes.map(row => [String(row.itemId), row]));
    const afterItems = oldItems.map(item => {
      const changed = changedById.get(String(item.source_order_item_id));
      if (!changed) return item;
      if (String(item.product_id) !== String(changed.productId)) {
        throw new Error(`Settlement item product mismatch: ${snapshot.order_no}`);
      }
      const unitPrice = priceMap.get(changed.productId);
      return { ...item, product_unit_price: unitPrice,
        product_price_source: 'product_standard_price',
        gross_profit_amount: item.cost_status === 'ready'
          ? roundMoney(unitPrice * Number(item.quantity || 1) - Number(item.purchase_cost_amount || 0)) : 0 };
    });
    if (changedById.size !== afterItems.filter(item => changedById.has(String(item.source_order_item_id))).length) {
      throw new Error(`Missing settlement item: ${snapshot.order_no}`);
    }
    const beforeSettlement = summarizeProductSettlementItems(oldItems);
    if (roundMoney(settlement.product_pricing_amount) !== beforeSettlement.productPricingAmount ||
      roundMoney(settlement.purchase_cost_amount) !== beforeSettlement.purchaseCostAmount ||
      roundMoney(settlement.cost_pending_amount) !== beforeSettlement.costPendingAmount ||
      roundMoney(settlement.gross_profit_amount) !== beforeSettlement.grossProfitAmount) {
      throw new Error(`Product settlement has drift: ${snapshot.order_no}`);
    }
    plans.push({ order, snapshot, beforeLines, afterLines, before, after, changes,
      settlement, oldItems, afterItems, afterSettlement: summarizeProductSettlementItems(afterItems) });
  }
  console.log(JSON.stringify({ mode: execute ? 'execute' : 'preview',
    careProducts: products.length, careOrders: selected.length, changedOrders: plans.length,
    changedCostLines: plans.flatMap(plan => plan.changes).filter(row => row.before !== row.after).length,
    oldCareCost: roundMoney(plans.flatMap(plan => plan.changes).reduce((sum, row) => sum + row.before, 0)),
    newCareCost: roundMoney(plans.flatMap(plan => plan.changes).reduce((sum, row) => sum + row.after, 0)),
    grossProfitChange: roundMoney(plans.reduce((sum, plan) =>
      sum + plan.after.grossProfitAmount - plan.before.grossProfitAmount, 0)),
    sample: plans.filter(plan => plan.changes.some(row => row.before !== row.after))
      .slice(0, 8).map(plan => ({ orderNo: plan.order.order_no, changes: plan.changes,
        oldGrossProfit: plan.before.grossProfitAmount, newGrossProfit: plan.after.grossProfitAmount }))
  }, null, 2));
  if (!execute) return;
  if (fs.existsSync(backupFile)) throw new Error(`Backup already exists: ${backupFile}`);
  fs.mkdirSync(path.dirname(backupFile), { recursive: true });
  fs.writeFileSync(backupFile, JSON.stringify({ products, plans: plans.map(plan => ({
    snapshot: plan.snapshot, settlement: plan.settlement, settlementItems: plan.oldItems
  })) }, null, 2), { flag: 'wx' });

  await sequelize.transaction(async transaction => {
    for (const product of products) {
      if (product.gross_profit_cost_mode === 'COMPANY_PRICE') continue;
      const [count] = await Product.update({ gross_profit_cost_mode: 'COMPANY_PRICE' }, {
        where: { product_id: product.product_id, gross_profit_cost_mode: product.gross_profit_cost_mode },
        transaction
      });
      if (count !== 1) throw new Error(`Product changed: ${product.product_code}`);
    }
    for (const plan of plans) {
      const current = await OrderGrossProfit.findByPk(plan.snapshot.gross_profit_id,
        { transaction, lock: transaction.LOCK.UPDATE });
      if (!current || JSON.stringify(array(current.product_pricing_details)) !== JSON.stringify(plan.beforeLines) ||
        roundMoney(current.gross_profit_amount) !== plan.before.grossProfitAmount) {
        throw new Error(`Snapshot changed: ${plan.order.order_no}`);
      }
      await current.update({
        product_pricing_details: plan.afterLines,
        product_pricing_amount: plan.after.productPricingAmount,
        vat_taxable_amount: plan.after.vatTaxableAmount,
        vat_amount: plan.after.vatAmount,
        gross_profit_amount: plan.after.grossProfitAmount,
        formula_version: FORMULA_VERSION,
        calculated_by: 'care_company_price_from_20261001',
        calculated_at: new Date(), update_time: new Date()
      }, { transaction });
      for (let index = 0; index < plan.oldItems.length; index++) {
        const oldItem = plan.oldItems[index];
        const newItem = plan.afterItems[index];
        if (oldItem === newItem) continue;
        const item = await ProductSettlementItem.findByPk(oldItem.settlement_item_id,
          { transaction, lock: transaction.LOCK.UPDATE });
        if (!item || roundMoney(item.product_unit_price) !== roundMoney(oldItem.product_unit_price) ||
          item.product_price_source !== oldItem.product_price_source) {
          throw new Error(`Settlement item changed: ${plan.order.order_no}`);
        }
        await item.update({ product_unit_price: newItem.product_unit_price,
          product_price_source: newItem.product_price_source,
          gross_profit_amount: newItem.gross_profit_amount }, { transaction });
      }
      const settlement = await ProductSettlementOrder.findByPk(plan.settlement.settlement_id,
        { transaction, lock: transaction.LOCK.UPDATE });
      if (!settlement || roundMoney(settlement.product_pricing_amount) !==
        roundMoney(plan.settlement.product_pricing_amount)) {
        throw new Error(`Settlement changed: ${plan.order.order_no}`);
      }
      await settlement.update({
        product_pricing_amount: plan.afterSettlement.productPricingAmount,
        purchase_cost_amount: plan.afterSettlement.purchaseCostAmount,
        cost_pending_amount: plan.afterSettlement.costPendingAmount,
        gross_profit_amount: plan.afterSettlement.grossProfitAmount,
        status: plan.afterSettlement.status, update_time: new Date()
      }, { transaction });
      await recordBusinessAction({ businessType: 'sales_order', businessId: plan.order.order_id,
        businessNo: plan.order.order_no, action: 'gross_profit_corrected',
        fromStatus: plan.order.order_status, toStatus: plan.order.order_status,
        user: { name: 'system_care_company_price_20261001' },
        comment: '从2026-10-01起Care商品按公司定价计算毛利成本',
        detail: { changes: plan.changes, beforeGrossProfit: plan.before.grossProfitAmount,
          afterGrossProfit: plan.after.grossProfitAmount }, transaction });
    }
  });
  console.log(JSON.stringify({ updatedProducts: products.filter(row =>
    row.gross_profit_cost_mode !== 'COMPANY_PRICE').length, updatedOrders: plans.length, backupFile }));
}

main().then(() => sequelize.close()).catch(async error => {
  console.error(error);
  await sequelize.close();
  process.exitCode = 1;
});
