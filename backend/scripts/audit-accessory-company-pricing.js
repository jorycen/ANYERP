// Read-only audit for category 选件. Writes local reports under backup/.
const fs = require('fs');
const path = require('path');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../src/models');

const OCT_START = '2026-10-01';
const OCT_END = '2026-11-01';
const outputDir = path.join(__dirname, '../../backup');

function array(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  const rows = JSON.parse(value);
  return Array.isArray(rows) ? rows : [];
}

function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function csv(rows, columns) {
  const quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  return [columns.join(','), ...rows.map(row => columns.map(column => quote(row[column])).join(','))].join('\r\n');
}

async function main() {
  const products = await sequelize.query(`
    SELECT p.PRODUCT_ID productId, p.MANUFACTURER_CODE pn, p.NAME productName,
           p.STATUS status, p.IS_DELETED isDeleted, p.GROSS_PROFIT_COST_MODE costMode,
           pp.STANDARD_PRICE standardPrice, pp.COST_PRICE purchasePrice,
           pp.STATUS priceStatus
      FROM T_PRODUCT p
      LEFT JOIN T_PRODUCT_PRICE pp ON pp.PRODUCT_ID = p.PRODUCT_ID
     WHERE p.CATEGORY = CONVERT(UNHEX('E98089E4BBB6') USING utf8mb4)
     ORDER BY p.IS_DELETED, p.STATUS DESC, p.MANUFACTURER_CODE, p.PRODUCT_ID`,
    { type: QueryTypes.SELECT }
  );
  const byProduct = new Map(products.map(product => [product.productId, {
    ...product, standardPrice: money(product.standardPrice), purchasePrice: money(product.purchasePrice),
    active: Number(product.isDeleted) === 0 && Number(product.status) === 1,
    validStandardPrice: Number(product.priceStatus) === 1 && Number(product.standardPrice) > 0,
    octoberOrders: new Set(), octoberLines: 0, finalSnapshotLines: 0,
    purchaseSourceLines: 0, missingSourceLines: 0, priceDifferenceLines: 0,
    pricingDifferenceTotal: 0, detailIssues: []
  }]));
  const orderLines = await sequelize.query(`
    SELECT o.ORDER_ID orderId, o.ORDER_NO orderNo, o.ORDER_STATUS orderStatus,
           oi.ITEM_ID itemId, oi.PRODUCT_ID productId, oi.QUANTITY quantity,
           gp.FORMULA_VERSION formulaVersion, gp.SNAPSHOT_STATUS snapshotStatus,
           gp.PRODUCT_PRICING_DETAILS details
      FROM T_ORDER o
      JOIN T_ORDER_ITEM oi ON oi.ORDER_ID = o.ORDER_ID
      JOIN T_PRODUCT p ON p.PRODUCT_ID = oi.PRODUCT_ID
      LEFT JOIN T_ORDER_GROSS_PROFIT gp ON gp.ORDER_ID = o.ORDER_ID
     WHERE o.IS_DELETED = 0
       AND p.CATEGORY = CONVERT(UNHEX('E98089E4BBB6') USING utf8mb4)
       AND (o.CREATE_TIME >= :startDate AND o.CREATE_TIME < :endDate
         OR o.ARCHIVE_TIME >= :startDate AND o.ARCHIVE_TIME < :endDate)
     ORDER BY o.ORDER_NO, oi.ITEM_ID`,
    { replacements: { startDate: OCT_START, endDate: OCT_END }, type: QueryTypes.SELECT }
  );
  const snapshotCache = new Map();
  const orderIssues = [];
  for (const row of orderLines) {
    const product = byProduct.get(row.productId);
    product.octoberOrders.add(row.orderNo);
    product.octoberLines += 1;
    if (row.snapshotStatus !== 'final') continue;
    product.finalSnapshotLines += 1;
    if (!snapshotCache.has(row.orderId)) snapshotCache.set(row.orderId, array(row.details));
    const line = snapshotCache.get(row.orderId).find(item => String(item.itemId) === String(row.itemId));
    if (!line) throw new Error(`订单 ${row.orderNo} 商品行 ${row.itemId} 缺少毛利明细`);
    const source = String(line.source || '');
    if (source === 'purchase_price') product.purchaseSourceLines += 1;
    if (source.startsWith('missing_')) product.missingSourceLines += 1;
    const specialPrice = Number(line.specialPrice || 0);
    const expectedPrice = specialPrice > 0 ? money(specialPrice)
      : product.validStandardPrice ? product.standardPrice : null;
    const difference = expectedPrice === null ? null
      : money((expectedPrice - Number(line.unitPricing || 0)) * Number(line.quantity || row.quantity || 1));
    const wrongSource = expectedPrice !== null && source !== (specialPrice > 0 ? 'sn_special_price' : 'product_standard_price');
    if (difference !== null && difference !== 0) {
      product.priceDifferenceLines += 1;
      product.pricingDifferenceTotal = money(product.pricingDifferenceTotal + difference);
    }
    if (wrongSource || difference !== 0 || !product.validStandardPrice) {
      const issue = { orderNo: row.orderNo, orderStatus: row.orderStatus, productId: row.productId,
        pn: product.pn, productName: product.productName, itemId: row.itemId,
        formulaVersion: row.formulaVersion, costMode: product.costMode,
        standardPrice: product.validStandardPrice ? product.standardPrice : null,
        actualUnitPricing: money(line.unitPricing), actualSource: source,
        quantity: Number(line.quantity || row.quantity || 1), priceDifference: difference };
      product.detailIssues.push(issue);
      orderIssues.push(issue);
    }
  }
  const productRows = [...byProduct.values()].map(product => ({
    productId: product.productId, pn: product.pn, productName: product.productName,
    active: product.active, costMode: product.costMode, standardPrice: product.standardPrice,
    purchasePrice: product.purchasePrice, validStandardPrice: product.validStandardPrice,
    octoberOrderCount: product.octoberOrders.size, octoberLines: product.octoberLines,
    finalSnapshotLines: product.finalSnapshotLines, purchaseSourceLines: product.purchaseSourceLines,
    missingSourceLines: product.missingSourceLines, priceDifferenceLines: product.priceDifferenceLines,
    pricingDifferenceTotal: product.pricingDifferenceTotal
  }));
  const masterIssues = productRows.filter(row => row.active &&
    (row.costMode !== 'COMPANY_PRICE' || !row.validStandardPrice));
  const summary = {
    categoryProducts: productRows.length,
    activeProducts: productRows.filter(row => row.active).length,
    activeWrongTag: productRows.filter(row => row.active && row.costMode !== 'COMPANY_PRICE').length,
    activeWrongTagWithPrice: productRows.filter(row => row.active && row.costMode !== 'COMPANY_PRICE' && row.validStandardPrice).length,
    activeMissingStandardPrice: productRows.filter(row => row.active && !row.validStandardPrice).length,
    octoberOrders: new Set(orderLines.map(row => row.orderNo)).size,
    octoberLines: orderLines.length,
    octoberProducts: productRows.filter(row => row.octoberLines).length,
    octoberFinalSnapshotLines: productRows.reduce((sum, row) => sum + row.finalSnapshotLines, 0),
    octoberPurchaseSourceLines: productRows.reduce((sum, row) => sum + row.purchaseSourceLines, 0),
    octoberMissingSourceLines: productRows.reduce((sum, row) => sum + row.missingSourceLines, 0),
    octoberPriceDifferenceLines: productRows.reduce((sum, row) => sum + row.priceDifferenceLines, 0),
    octoberPricingDifferenceTotal: money(productRows.reduce((sum, row) => sum + row.pricingDifferenceTotal, 0)),
    octoberIssueOrders: new Set(orderIssues.map(row => row.orderNo)).size,
    octoberIssueProducts: new Set(orderIssues.map(row => row.productId)).size
  };
  fs.mkdirSync(outputDir, { recursive: true });
  const masterFile = path.join(outputDir, 'accessory-company-pricing-master-issues-20261012.csv');
  const missingPriceFile = path.join(outputDir, 'accessory-company-pricing-missing-standard-price-20261012.csv');
  const octoberProductFile = path.join(outputDir, 'accessory-company-pricing-october-affected-products-20261012.csv');
  const orderFile = path.join(outputDir, 'accessory-company-pricing-october-order-issues-20261012.csv');
  fs.writeFileSync(masterFile, '\ufeff' + csv(masterIssues, [
    'productId', 'pn', 'productName', 'costMode', 'standardPrice', 'purchasePrice',
    'validStandardPrice', 'octoberOrderCount', 'octoberLines', 'purchaseSourceLines',
    'missingSourceLines', 'priceDifferenceLines', 'pricingDifferenceTotal'
  ]));
  fs.writeFileSync(missingPriceFile, '\ufeff' + csv(masterIssues.filter(row => !row.validStandardPrice), [
    'productId', 'pn', 'productName', 'costMode', 'standardPrice', 'purchasePrice',
    'octoberOrderCount', 'octoberLines'
  ]));
  fs.writeFileSync(orderFile, '\ufeff' + csv(orderIssues, [
    'orderNo', 'orderStatus', 'pn', 'productName', 'itemId', 'costMode',
    'standardPrice', 'actualUnitPricing', 'actualSource', 'quantity', 'priceDifference'
  ]));
  const octoberIssueProductIds = new Set(orderIssues.map(row => row.productId));
  const octoberIssueProducts = productRows.filter(row => octoberIssueProductIds.has(row.productId))
    .sort((a, b) => Math.abs(b.pricingDifferenceTotal) - Math.abs(a.pricingDifferenceTotal));
  fs.writeFileSync(octoberProductFile, '\ufeff' + csv(octoberIssueProducts, [
    'productId', 'pn', 'productName', 'active', 'costMode', 'standardPrice', 'validStandardPrice',
    'octoberOrderCount', 'finalSnapshotLines', 'purchaseSourceLines', 'missingSourceLines',
    'priceDifferenceLines', 'pricingDifferenceTotal'
  ]));
  console.log(JSON.stringify({ summary, masterFile, missingPriceFile, octoberProductFile, orderFile,
    octoberProductsWithPriceDifference: productRows.filter(row => row.priceDifferenceLines)
      .sort((a, b) => Math.abs(b.pricingDifferenceTotal) - Math.abs(a.pricingDifferenceTotal))
      .slice(0, 20) }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => sequelize.close());
