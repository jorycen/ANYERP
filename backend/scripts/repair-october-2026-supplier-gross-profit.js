// Preview by default. Run with --execute only after reviewing the summary.
// Keeps every unaffected archived line and fee snapshot intact.
const { Op } = require('sequelize');
const {
  sequelize, OrderGrossProfit, ProductSn, Supplier
} = require('../src/models');
const {
  roundMoney, calculateGrossProfitValues, isExternalAdjustmentEligibleProduct
} = require('../src/modules/sales/grossProfit');
const { recordBusinessAction } = require('../src/utils/businessActionLog');

const execute = process.argv.includes('--execute');
const START = '2026-10-01';
const END = '2026-11-01';

function array(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  return JSON.parse(value);
}

function calculate(order, snapshot, lines) {
  const adjustments = array(snapshot.supplement_details);
  return calculateGrossProfitValues({
    receivableAmount: snapshot.receivable_amount,
    paymentDetails: array(snapshot.payment_fee_details),
    productPricingDetails: lines,
    supplementDetails: adjustments.filter(item => item.source !== 'freight_cost'),
    freightCostDetails: adjustments.filter(item => item.source === 'freight_cost'),
    invoiceAmount: snapshot.invoice_amount,
    invoiceStatus: order.invoice_status,
    externalAdjustmentEligible: lines.some(item =>
      item.externalAdjustmentEligible === true ||
      item.external_adjustment_eligible === true ||
      isExternalAdjustmentEligibleProduct(item)
    )
  });
}

async function main() {
  const [orders] = await sequelize.query(
    `SELECT o.ORDER_ID order_id, o.ORDER_NO order_no,
            o.ORDER_STATUS order_status, o.ARCHIVE_TIME archive_time,
            o.INVOICE_STATUS invoice_status
       FROM T_ORDER o
       JOIN T_ORDER_GROSS_PROFIT gp ON gp.ORDER_ID = o.ORDER_ID
      WHERE o.IS_DELETED = 0
        AND o.ARCHIVE_TIME >= :startDate
        AND o.ARCHIVE_TIME < :endDate
        AND gp.SNAPSHOT_STATUS = 'final'`,
    { replacements: { startDate: START, endDate: END } }
  );
  const snapshots = await OrderGrossProfit.findAll({
    where: { order_id: { [Op.in]: orders.map(order => order.order_id) } },
    raw: true
  });
  const snapshotByOrder = new Map(snapshots.map(snapshot => [snapshot.order_id, snapshot]));
  const allLines = snapshots.flatMap(snapshot => array(snapshot.product_pricing_details));
  const snCodes = [...new Set(allLines.map(line => line.snCode).filter(Boolean))];
  const snRows = snCodes.length ? await ProductSn.findAll({
    where: { sn_code: { [Op.in]: snCodes }, is_deleted: 0 },
    attributes: ['sn_code', 'supplier_id'], raw: true
  }) : [];
  const snByCode = new Map(snRows.map(sn => [sn.sn_code, sn]));
  const supplierIds = [...new Set(allLines.map(line =>
    line.supplierId || snByCode.get(line.snCode)?.supplier_id
  ).filter(Boolean))];
  const suppliers = supplierIds.length ? await Supplier.findAll({
    where: { supplier_id: { [Op.in]: supplierIds }, is_deleted: 0 }, raw: true
  }) : [];
  const supplierById = new Map(suppliers.map(supplier => [supplier.supplier_id, supplier]));

  const summary = {
    period: `${START}..${END}`,
    scannedOrders: orders.length,
    affectedOrders: 0,
    correctedItems: 0,
    skippedLaterSupplierChange: [],
    skippedOtherStatus: [],
    skippedSnapshotDrift: [],
    skippedSupplierMismatch: [],
    changes: []
  };

  for (const order of orders) {
    const snapshot = snapshotByOrder.get(order.order_id);
    if (!snapshot) continue;
    const beforeLines = array(snapshot.product_pricing_details);
    const afterLines = beforeLines.map(line => ({ ...line }));
    const changes = [];

    for (const line of afterLines) {
      const sn = snByCode.get(line.snCode);
      const supplierId = line.supplierId || sn?.supplier_id;
      const supplier = supplierById.get(supplierId);
      if (!supplier || Number(supplier.is_service_provider) !== 0) continue;
      if (/选件/.test(`${line.category || ''} ${line.accessoryType || ''}`)) continue;
      const purchasePrice = Number(line.purchasePrice || 0);
      if (!(purchasePrice > 0)) continue;
      const uplift = Math.max(0, roundMoney(supplier.gross_profit_uplift_amount));
      const expectedPrice = roundMoney(purchasePrice + uplift);
      if (roundMoney(line.unitPricing) === expectedPrice) continue;
      if (line.supplierId && sn?.supplier_id && line.supplierId !== sn.supplier_id) {
        summary.skippedSupplierMismatch.push({ orderNo: order.order_no, itemId: line.itemId });
        continue;
      }
      if (!supplier.update_time || new Date(supplier.update_time) > new Date(order.archive_time)) {
        summary.skippedLaterSupplierChange.push({
          orderNo: order.order_no, itemId: line.itemId, snCode: line.snCode,
          supplierId, archivedAt: order.archive_time, supplierUpdatedAt: supplier.update_time
        });
        continue;
      }
      if (order.order_status !== '已归档') {
        summary.skippedOtherStatus.push({ orderNo: order.order_no, status: order.order_status });
        continue;
      }
      changes.push({
        itemId: line.itemId, snCode: line.snCode || '', supplierId,
        beforeUnitPricing: roundMoney(line.unitPricing), afterUnitPricing: expectedPrice,
        purchasePrice: roundMoney(purchasePrice), uplift,
        beforeSource: line.source || '', beforeSupplierIsServiceProvider: line.isServiceProvider
      });
      line.unitPricing = expectedPrice;
      line.pricingAmount = roundMoney(expectedPrice * Number(line.quantity || 1));
      line.source = 'purchase_price_with_uplift';
      line.supplierId = supplierId;
      line.supplierName = supplier.name;
      line.purchasePrice = roundMoney(purchasePrice);
      line.grossProfitUpliftAmount = uplift;
      line.isServiceProvider = false;
      line.externalAdjustmentEligible = isExternalAdjustmentEligibleProduct(line);
    }
    if (!changes.length) continue;

    const baseline = calculate(order, snapshot, beforeLines);
    if (
      roundMoney(baseline.productPricingAmount) !== roundMoney(snapshot.product_pricing_amount) ||
      roundMoney(baseline.paymentFeeAmount) !== roundMoney(snapshot.payment_fee_amount) ||
      roundMoney(baseline.vatAmount) !== roundMoney(snapshot.vat_amount) ||
      roundMoney(baseline.grossProfitAmount) !== roundMoney(snapshot.gross_profit_amount)
    ) {
      summary.skippedSnapshotDrift.push({ orderNo: order.order_no, itemIds: changes.map(x => x.itemId) });
      continue;
    }
    const after = calculate(order, snapshot, afterLines);
    const before = {
      productPricingAmount: roundMoney(snapshot.product_pricing_amount),
      vatTaxableAmount: roundMoney(snapshot.vat_taxable_amount),
      vatAmount: roundMoney(snapshot.vat_amount),
      grossProfitAmount: roundMoney(snapshot.gross_profit_amount)
    };
    const result = {
      productPricingAmount: after.productPricingAmount,
      vatTaxableAmount: after.vatTaxableAmount,
      vatAmount: after.vatAmount,
      grossProfitAmount: after.grossProfitAmount
    };

    if (execute) {
      await sequelize.transaction(async transaction => {
        const current = await OrderGrossProfit.findOne({
          where: { order_id: order.order_id }, transaction, lock: transaction.LOCK.UPDATE
        });
        if (!current || current.snapshot_status !== 'final' ||
            JSON.stringify(array(current.product_pricing_details)) !== JSON.stringify(beforeLines) ||
            roundMoney(current.gross_profit_amount) !== before.grossProfitAmount) {
          throw new Error(`Snapshot changed during repair: ${order.order_no}`);
        }
        await current.update({
          product_pricing_details: afterLines,
          product_pricing_amount: result.productPricingAmount,
          vat_taxable_amount: result.vatTaxableAmount,
          vat_amount: result.vatAmount,
          gross_profit_amount: result.grossProfitAmount,
          calculated_by: 'october_supplier_profit_repair',
          calculated_at: new Date(), update_time: new Date()
        }, { transaction });
        await recordBusinessAction({
          businessType: 'sales_order', businessId: order.order_id,
          businessNo: order.order_no, action: 'gross_profit_corrected',
          fromStatus: order.order_status, toStatus: order.order_status,
          user: { name: 'system_october_supplier_profit_repair' },
          comment: '按用户要求更正2026年10月非服务商商品毛利快照；其他商品与费用保留原快照',
          detail: { before, after: result, changes }, transaction
        });
      });
    }
    summary.affectedOrders += 1;
    summary.correctedItems += changes.length;
    summary.changes.push({ orderNo: order.order_no, before, after: result, items: changes });
  }
  console.log(JSON.stringify({ mode: execute ? 'executed' : 'preview', ...summary }, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => sequelize.close());
