function costAmount(value) {
  if (value === null || value === undefined || typeof value === 'boolean' || String(value).trim() === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}
function knownCost(value, confirmed = false) {
  const amount = costAmount(value);
  return amount !== null && (amount > 0 || confirmed === true) ? amount : null;
}
function costState(amount) {
  return amount === null ? 'pending' : Number(amount) === 0 ? 'confirmed_zero' : 'known';
}

// Explicit per-SN audit or completed cost-conserving split is evidence, while
// an editable source label/default database zero is not. Later receipts or
// cost changes invalidate an older confirmation. Read only; no auto backfill.
async function confirmedZeroSnIds(sns, transaction) {
  const zero = [...new Map(sns.filter(sn => sn?.sn_id && costAmount(sn.inbound_price) === 0).map(sn => [sn.sn_id, sn])).values()];
  if (!zero.length) return new Set();
  const { sequelize } = require('../models');
  const { QueryTypes } = require('sequelize');
  const rows = await sequelize.query(`SELECT evidence.snId FROM (
    SELECT a.BUSINESS_ID snId,a.CREATE_TIME evidenceTime
    FROM T_BUSINESS_ACTION_LOG a WHERE a.BUSINESS_ID IN (:ids) AND a.ACTION='sn_purchase_cost_corrected'
      AND JSON_VALID(a.DETAIL_JSON) AND JSON_EXTRACT(a.DETAIL_JSON,'$.after.inbound_price') IS NOT NULL
      AND CAST(JSON_UNQUOTE(JSON_EXTRACT(a.DETAIL_JSON,'$.after.inbound_price')) AS DECIMAL(12,2))=0
    UNION ALL
    SELECT ci.SN_ID,sl.CREATE_TIME FROM T_INVENTORY_CONVERSION_ITEM ci
      JOIN T_INVENTORY_CONVERSION c ON c.CONVERSION_ID=ci.CONVERSION_ID
      JOIN T_SN_LOG sl ON sl.SN_ID=ci.SN_ID AND sl.ACTION='inventory_split_source'
        AND sl.REMARK LIKE CONCAT('%',c.CONVERSION_NO,'%')
    WHERE ci.SN_ID IN (:ids) AND ci.LINE_ROLE='source' AND c.CONVERSION_TYPE='split'
      AND c.STATUS='completed' AND c.TOTAL_SOURCE_COST>0 AND c.TOTAL_SOURCE_COST=c.TOTAL_TARGET_COST
  ) evidence WHERE NOT EXISTS (SELECT 1 FROM T_SN_LOG l WHERE l.SN_ID=evidence.snId
    AND l.CREATE_TIME>evidence.evidenceTime AND l.ACTION IN ('batch_inbound','inbound','special_warehouse_purchase',
      'inventory_split_source','inventory_assemble_target','inventory_split_target','purchase_cost_correction'))`,
  { replacements: { ids: zero.map(sn => sn.sn_id) }, type: QueryTypes.SELECT, transaction });
  return new Set(rows.map(row => String(row.snId)));
}
module.exports = { costAmount, knownCost, costState, confirmedZeroSnIds };
