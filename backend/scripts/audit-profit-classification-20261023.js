// Read-only classification audit. No business data is changed.
const fs = require('node:fs');
const path = require('node:path');
const { sequelize } = require('../src/models');
const queries = {
  salesSnapshots: `SELECT gp.FORMULA_VERSION formula, COUNT(*) count, SUM(gp.RECEIVABLE_AMOUNT) receivable, SUM(gp.PRODUCT_PRICING_AMOUNT) pricing, SUM(gp.PAYMENT_FEE_AMOUNT) paymentFee, SUM(gp.VAT_AMOUNT) managementTax, SUM(gp.SUPPLEMENT_AMOUNT) supplement, SUM(gp.FREIGHT_COST_AMOUNT) freight, SUM(gp.GROSS_PROFIT_AMOUNT) profit FROM T_ORDER_GROSS_PROFIT gp INNER JOIN T_ORDER o ON o.ORDER_ID=gp.ORDER_ID WHERE o.IS_DELETED=0 AND gp.SNAPSHOT_STATUS='final' GROUP BY gp.FORMULA_VERSION`,
  expenseRisk: `SELECT ATTRIBUTION_TYPE attribution, STATUS status, COUNT(*) count, SUM(AMOUNT) amount, MIN(EXPENSE_DATE) earliest, MAX(EXPENSE_DATE) latest, SUM(CASE WHEN STORE_ID IS NOT NULL AND STORE_ID <> '' THEN 1 ELSE 0 END) withSourceStore FROM T_EXPENSE WHERE IS_DELETED=0 AND AFFECTS_STORE_PROFIT=1 AND (STATUS='withdrawn' OR ATTRIBUTION_TYPE='PRODUCT_SIDE') GROUP BY ATTRIBUTION_TYPE, STATUS`,
  productSettlements: `SELECT STATUS status, COUNT(*) count, SUM(PRODUCT_PRICING_AMOUNT) pricing, SUM(PURCHASE_COST_AMOUNT) cost, SUM(GROSS_PROFIT_AMOUNT) profit, SUM(COST_PENDING_AMOUNT) pending FROM T_PRODUCT_SETTLEMENT_ORDER GROUP BY STATUS`,
  productReturns: `SELECT STATUS status, COUNT(*) count, SUM(GROSS_PROFIT_AMOUNT) profit FROM T_PRODUCT_SETTLEMENT_ADJUSTMENT GROUP BY STATUS`,
  manufacturerPolicies: `SELECT STATUS status, SOURCE_TYPE source, POLICY_TYPE policy, COUNT(*) count, SUM(REBATE_ESTIMATE_AMOUNT) amount FROM T_REBATE_ESTIMATE GROUP BY STATUS, SOURCE_TYPE, POLICY_TYPE`,
  resourceSettlements: `SELECT RESOURCE_TYPE resource, SOURCE_TYPE source, STATUS status, COUNT(*) count, SUM(AMOUNT) amount, SUM(MATCHED_AMOUNT) matched FROM T_RESOURCE_SETTLEMENT GROUP BY RESOURCE_TYPE, SOURCE_TYPE, STATUS`,
  expenses: `SELECT ATTRIBUTION_TYPE attribution, STATUS status, AFFECTS_STORE_PROFIT affectsProfit, COUNT(*) count, SUM(AMOUNT) amount FROM T_EXPENSE WHERE IS_DELETED=0 GROUP BY ATTRIBUTION_TYPE, STATUS, AFFECTS_STORE_PROFIT`,
  education: `SELECT CHANGE_REASON reason, APPROVAL_STATUS status, COUNT(*) count, SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(REWARD_SNAPSHOT_JSON,'$.amount')) AS DECIMAL(12,2))) amount, SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(REWARD_SNAPSHOT_JSON,'$.employeeAmount')) AS DECIMAL(12,2))) employee, SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(REWARD_SNAPSHOT_JSON,'$.productAmount')) AS DECIMAL(12,2))) product FROM T_RESOURCE_RIGHT_CHANGE_ORDER WHERE RESOURCE_TYPE='EDU_SUBSIDY' AND JSON_VALID(REWARD_SNAPSHOT_JSON) AND JSON_EXTRACT(REWARD_SNAPSHOT_JSON,'$.accountingVersion')=2 GROUP BY CHANGE_REASON, APPROVAL_STATUS`,
  performance: `SELECT CASE WHEN ADJUSTMENT_NO LIKE 'AUTO-CARE-%' THEN 'CARE' WHEN ADJUSTMENT_NO LIKE 'CRB-%' THEN 'cash_rebate' WHEN ADJUSTMENT_NO LIKE 'EDUR-%' THEN 'education_return' WHEN ADJUSTMENT_NO LIKE '%EDU_SUBSIDY' THEN 'education' ELSE 'other' END source, STATUS status, COUNT(*) count, SUM(SIGNED_AMOUNT) amount FROM T_PERFORMANCE_PROFIT_ADJUSTMENT GROUP BY source, STATUS`
};
(async () => {
  const result = { capturedAt: new Date().toISOString(), scope: 'all database records, no period or store filters', results: {} };
  for (const [name, sql] of Object.entries(queries)) {
    try { result.results[name] = (await sequelize.query(sql))[0]; }
    catch (error) { result.results[name] = { error: error.message }; }
  }
  fs.writeFileSync(path.join(__dirname, '../../tmp/profit-classification-audit-20261023.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => sequelize.close());
