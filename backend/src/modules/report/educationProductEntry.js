// Confirmed education income is recorded once on its resource task. Expose the
// product's 20% allocation alongside settlements without modifying cost snapshots.
function educationProductEntrySql() {
  const json = "IF(JSON_VALID(r.REWARD_SNAPSHOT_JSON), r.REWARD_SNAPSHOT_JSON, '{}')";
  const sign = "CASE WHEN r.CHANGE_REASON = 'EDU_REWARD_RETURN' THEN -1 ELSE 1 END";
  return `SELECT 'education' AS ENTRY_TYPE, r.CHANGE_ID AS ENTRY_ID, r.CHANGE_ORDER_NO AS ENTRY_NO,
      sale.ORDER_ID AS SOURCE_ORDER_ID, sale.ORDER_NO AS SOURCE_ORDER_NO,
      NULL AS DISTRIBUTOR_ID, NULL AS REGION_ID, sale.STORE_ID,
      sale.CREATE_TIME AS BUSINESS_DATE, 0 AS PRODUCT_PRICING_AMOUNT, 0 AS PURCHASE_COST_AMOUNT,
      ROUND((${sign}) * CAST(JSON_UNQUOTE(JSON_EXTRACT(${json}, '$.productAmount')) AS DECIMAL(12,2)), 2) AS GROSS_PROFIT_AMOUNT,
      0 AS COST_PENDING_AMOUNT, 'posted' AS STATUS, 'EDU_APPROVAL_80_20_V2' AS FORMULA_VERSION
    FROM T_RESOURCE_RIGHT_CHANGE_ORDER r INNER JOIN T_ORDER sale ON sale.ORDER_ID = r.RELATED_SALE_ORDER_ID
    WHERE r.RESOURCE_TYPE = 'EDU_SUBSIDY' AND r.APPROVAL_STATUS = 'completed'
      AND r.CHANGE_REASON IN ('SALE_RESOURCE_TASK', 'EDU_REWARD_RETURN') AND sale.IS_DELETED = 0
      AND JSON_EXTRACT(${json}, '$.accountingVersion') = 2`;
}
module.exports = { educationProductEntrySql };
