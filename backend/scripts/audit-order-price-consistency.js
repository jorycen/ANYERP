// Read-only: this script never repairs or updates business records.
const fs = require('node:fs');
const path = require('node:path');
const { sequelize } = require('../src/models');
async function main() {
  const [rows] = await sequelize.query(`
    SELECT o.order_no, o.order_status, i.item_id, i.sale_price, i.quantity, i.subtotal,
      ROUND(i.sale_price * i.quantity, 2) AS expected_subtotal
    FROM T_ORDER_ITEM i JOIN T_ORDER o ON o.order_id = i.order_id
    WHERE o.is_deleted = 0 AND (i.sale_price IS NULL OR i.quantity IS NULL OR
      i.sale_price < 0 OR i.quantity <= 0 OR i.subtotal IS NULL OR
      ROUND(i.sale_price * i.quantity, 2) <> i.subtotal)
    ORDER BY o.order_no, i.item_id`);
  const report = rows.map(row => ({ ...row, classification:
    row.sale_price === null || row.quantity === null || Number(row.quantity) <= 0 || Number(row.sale_price) < 0 ? 'invalid_input'
      : Number(row.sale_price) === 0 && Number(row.subtotal) > 0 ? 'zero_price_positive_subtotal' : 'subtotal_mismatch' }));
  const counts = report.reduce((result, row) => { result[row.classification] = (result[row.classification] || 0) + 1; return result; }, {});
  const output = path.resolve(__dirname, '../../backup/order-price-consistency-20261027.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ generatedAt: new Date().toISOString(), readOnly: true, counts, rows: report }, null, 2));
  console.log(JSON.stringify({ readOnly: true, counts, affectedOrders: new Set(report.map(row => row.order_no)).size, output }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => sequelize.close());
