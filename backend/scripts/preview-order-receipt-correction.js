// Read-only proposal: original archived amounts are never persisted here.
const fs = require('node:fs');
const path = require('node:path');
const M = require('../src/models');
const GP = require('../src/modules/sales/grossProfit');
const json = value => typeof value === 'string' ? JSON.parse(value) : value || [];
async function preview(orderNo, snCode) {
  const order = await M.Order.findOne({ where: { order_no: orderNo }, raw: true });
  if (!order) throw new Error('Order not found');
  const snapshot = await M.OrderGrossProfit.findOne({ where: { order_id: order.order_id }, raw: true });
  if (snapshot?.snapshot_status !== 'final') throw new Error('Archived snapshot required');
  const sn = await M.ProductSn.findOne({ where: { sn_code: snCode, is_deleted: 0 }, raw: true });
  const original = json(snapshot.product_pricing_details);
  const line = original.find(row => row.snCode === snCode && row.productId === sn?.product_id);
  if (!line || !(Number(sn.inbound_price) > 0)) throw new Error('Matching SN and evidenced purchase cost required');
  if (!order.archive_time || Number(line.purchasePrice) !== Number(sn.inbound_price)) {
    throw new Error('Archive time or original purchase-cost evidence has changed; verify the original receipt before preview');
  }
  const supplier = await M.Supplier.findByPk(sn.supplier_id, { raw: true });
  const proposed = original.map(row => row !== line ? row : { ...row, unitPricing: Number(sn.inbound_price),
    pricingAmount: GP.roundMoney(Number(sn.inbound_price) * row.quantity), purchasePrice: Number(sn.inbound_price),
    source: 'purchase_price', isCompanyPriced: false, costModeSnapshot: 'PURCHASE_PRICE',
    grossProfitUpliftAmount: Number(sn.gross_profit_uplift_amount ?? supplier?.gross_profit_uplift_amount ?? 0),
    externalAdjustmentEligible: GP.isExternalAdjustmentEligibleProduct({ category: row.category,
      productName: row.productName, accessoryType: row.accessoryType }) });
  const proposedFreight = await GP.buildFreightCostDetails(order, null, proposed);
  const calculate = (lines, freight) => GP.calculateGrossProfitValues({ receivableAmount: snapshot.receivable_amount,
    productPricingDetails: lines, paymentDetails: json(snapshot.payment_fee_details),
    supplementDetails: json(snapshot.supplement_details).filter(row => row.source !== 'freight_cost'),
    freightCostDetails: freight, invoiceAmount: snapshot.invoice_amount, invoiceStatus: order.invoice_status });
  const before = calculate(original, json(snapshot.supplement_details).filter(row => row.source === 'freight_cost'));
  const after = calculate(proposed, proposedFreight);
  return { proposalOnly: true, orderNo, snCode, receiptModeInHistoricalSnapshot: line.source,
    proposedMode: 'PURCHASE_PRICE', before: { productPricing: before.productPricingAmount, freight: before.freightCostAmount,
      vat: before.vatAmount, externalFee: before.externalAdjustmentFee, grossProfit: before.grossProfitAmount },
    after: { productPricing: after.productPricingAmount, freight: after.freightCostAmount, vat: after.vatAmount,
      externalFee: after.externalAdjustmentFee, grossProfit: after.grossProfitAmount },
    difference: GP.roundMoney(after.grossProfitAmount - before.grossProfitAmount), freightDetails: proposedFreight,
    proposedPricingDetails: proposed };
}
if (require.main === module) {
  const [orderNo, snCode] = process.argv.slice(2);
  if (!orderNo || !snCode) throw new Error('Usage: node scripts/preview-order-receipt-correction.js ORDER_NO SN_CODE');
  preview(orderNo, snCode).then(result => {
    const directory = path.resolve(__dirname, '../backup/receipt-pricing-previews');
    fs.mkdirSync(directory, { recursive: true });
    const filename = path.join(directory, `${orderNo.replace(/[^A-Za-z0-9_-]/g, '')}.json`);
    fs.writeFileSync(filename, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, proposedPricingDetails: undefined, output: filename }));
  }).catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => M.sequelize.close());
}
module.exports = { preview };
