// Read-only rollout verification. Does not migrate schema or save costs.
const M = require('../src/models');
const { _test } = require('../src/modules/report/productSettlement');
const cost = require('../src/modules/report/productCostSupplement');
(async () => {
  const stores = await M.Store.findAll({ attributes: ['store_id'], raw: true });
  const query = _test.buildProductSettlementEntrySql({ storeIds: stores.map(s => s.store_id) });
  // Before deploying the new table, check the complete union against the live
  // schema with an explicitly empty ledger, never write synthetic business rows.
  const emptyLedger = `(SELECT CAST(NULL AS CHAR(32)) COLLATE utf8mb4_0900_ai_ci ENTRY_TYPE, CAST(NULL AS CHAR(32)) COLLATE utf8mb4_0900_ai_ci ENTRY_ID,
    CAST(NULL AS CHAR(32)) COLLATE utf8mb4_0900_ai_ci SOURCE_ORDER_ID, CAST(NULL AS CHAR(64)) COLLATE utf8mb4_0900_ai_ci SOURCE_ORDER_NO,
    CAST(NULL AS CHAR(32)) COLLATE utf8mb4_0900_ai_ci STORE_ID, CAST(NULL AS DATETIME) BUSINESS_DATE,
    CAST(0 AS DECIMAL(12,2)) AMOUNT WHERE 1=0)`;
  const sql = query.sql.replace('FROM T_PRODUCT_PROFIT_INCOME e', `FROM ${emptyLedger} e`);
  const [totals] = await M.sequelize.query(`SELECT ENTRY_TYPE, STATUS, COUNT(*) count, SUM(GROSS_PROFIT_AMOUNT) amount FROM (${sql}) x GROUP BY ENTRY_TYPE, STATUS`, { replacements: query.replacements });
  console.log('Pre-migration query validation (recognized policy ledger excluded):', totals);
  const item = await M.ProductSettlementItem.findOne({ where: { cost_status: 'pending', purchase_unit_cost: 0 }, order: [['settlement_item_id', 'DESC']] });
  if (item) {
    const ctx = { state: { user: { roles: ['boss'], accessibleStoreIds: ['*'] } },
      params: { settlementId: item.settlement_id }, request: { body: { items: [{ itemId: item.settlement_item_id, unitCost: 1 }] } },
      throw(status, message) { throw Object.assign(new Error(message), { status }); } };
    await cost.preview(ctx);
    console.log('Cost preview only:', { itemCount: ctx.body.data.items.length, affectedReturns: ctx.body.data.returns.length, hasPreviewHash: Boolean(ctx.body.data.previewHash), saved: false });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => M.sequelize.close());
