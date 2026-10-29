const { QueryTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const isSpecialWarehouse = type => ['display_qty', 'rental_demo_qty'].includes(type);
const fail = message => { throw Object.assign(new Error(message), { status: 409 }); };

// Location is a physical fact. Only an approved, executed purchase can clear
// special-warehouse lineage; prices and editable source labels are not proof.
function evaluateEvidence(sn, location, entries = [], purchases = []) {
  const uncertain = entries.some(entry => !Number(entry.epoch));
  const latest = Math.max(0, ...entries.map(entry => Number(entry.epoch) || 0));
  const converted = !uncertain && purchases.some(p => Number(p.epoch) > latest);
  return {
    restricted: isSpecialWarehouse(sn.inventory_type) || isSpecialWarehouse(location?.type)
      || ((entries.length > 0 || sn.source_type === 'PURCHASED_FROM_SPECIAL_WAREHOUSE') && !converted),
    location,
    locationValid: Boolean(location && Number(location.status) === 1
      && String(location.store_id) === String(sn.store_id)),
    latestSpecialEpoch: latest,
    uncertain
  };
}

async function inspectSnEligibility(sns, transaction = null) {
  if (!sns.length) return new Map();
  const snIds = [...new Set(sns.map(sn => sn.sn_id).filter(Boolean))];
  const snCodes = [...new Set(sns.map(sn => sn.sn_code).filter(Boolean))];
  const replacements = { snIds, snCodes: snCodes.length ? snCodes : [''] };
  const select = sql => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
  const locations = await select(`SELECT l.LOCATION_ID location_id,l.STORE_ID store_id,l.TYPE type,l.STATUS status,
    s.SN_ID snId FROM T_PRODUCT_SN s LEFT JOIN T_LOCATION l ON l.LOCATION_ID=s.LOCATION_ID
    WHERE s.SN_ID IN (:snIds)`);
  const batches = await select(`SELECT i.SN_ID snId,i.SN_CODE snCode,a.APPLICATION_NO document,i.EXECUTE_STATUS executeStatus
    FROM T_INVENTORY_BATCH_APPLICATION_ITEM i
    JOIN T_INVENTORY_BATCH_APPLICATION a ON a.APPLICATION_ID=i.APPLICATION_ID
    WHERE (i.SN_ID IN (:snIds) OR i.SN_CODE IN (:snCodes))
      AND a.STATUS IN ('executed','executing')
      AND (i.EXECUTE_STATUS='success' OR (a.STATUS='executed' AND i.EXECUTE_STATUS='pending'))
      AND i.OPERATION_TYPE='INBOUND' AND i.INVENTORY_TYPE IN ('display_qty','rental_demo_qty')`);
  const logs = await select(`SELECT SN_ID snId,ACTION action,REMARK remark,UNIX_TIMESTAMP(CREATE_TIME)*1000 epoch
    FROM T_SN_LOG WHERE SN_ID IN (:snIds)
      AND ACTION IN ('batch_inbound','special_warehouse_purchase','special_warehouse_flow','location_adjust')`);
  const approvals = await select(`SELECT i.SOURCE_SN_ID snId,p.REQUEST_NO document FROM T_PURCHASE_REQUEST_ITEM i
    JOIN T_PURCHASE_REQUEST p ON p.REQUEST_ID=i.REQUEST_ID
    WHERE i.SOURCE_SN_ID IN (:snIds) AND p.STATUS='approved'`);
  const result = new Map();
  for (const sn of sns) {
    const history = logs.filter(row => String(row.snId) === String(sn.sn_id));
    // A historical duplicate code belonging to another persisted identity must
    // not contaminate this SN. Code fallback is only for legacy unbound rows.
    const entries = batches.filter(row => row.snId
      ? String(row.snId) === String(sn.sn_id)
      : String(row.snCode) === String(sn.sn_code))
      // Older executed applications did not persist per-row success. Accept
      // them only with the same SN's concrete execution log, never status alone.
      .filter(row => row.executeStatus !== 'pending' || history.some(log => log.action === 'batch_inbound'
        && String(log.remark || '').includes(row.document))).map(row => ({
      epoch: history.find(log => log.action === 'batch_inbound' && String(log.remark || '').includes(row.document))?.epoch
    }));
    entries.push(...history.filter(log => log.action === 'special_warehouse_flow'
      || (log.action === 'location_adjust' && /[→>]\s*(?:租赁样机仓|铺货仓)/.test(log.remark || ''))));
    const executed = history.filter(log => log.action === 'special_warehouse_purchase'
      && approvals.some(p => String(p.snId) === String(sn.sn_id) && String(log.remark || '').includes(p.document)));
    result.set(String(sn.sn_id), evaluateEvidence(sn, locations.find(row => String(row.snId) === String(sn.sn_id)), entries, executed));
  }
  return result;
}

async function assertSnEligible(sn, { transaction = null, targetLocation = null, targetStoreId = null,
  movement = false, reentry = false } = {}) {
  const state = (await inspectSnEligibility([sn], transaction)).get(String(sn.sn_id));
  const targetValid = targetLocation && Number(targetLocation.status ?? 1) === 1
    && String(targetLocation.store_id) === String(targetStoreId || sn.store_id);
  // Retired rows may point at an old location, but their lineage still applies.
  if (!reentry && !state.locationValid) fail(`SN [${sn.sn_code}] 门店或库位信息不一致，请核对库存记录`);
  if (state.restricted) {
    if (!movement || (targetLocation && (!targetValid || !isSpecialWarehouse(targetLocation.type)))) {
      fail(`SN [${sn.sn_code}] 属于特殊仓来源，仅允许在特殊仓流转；进入其他仓或销售前须完成采购转换`);
    }
  }
  if (targetLocation && !targetValid) fail(`SN [${sn.sn_code}] 目标库位无效或不属于接收门店`);
  return state;
}

module.exports = { isSpecialWarehouse, evaluateEvidence, inspectSnEligibility, assertSnEligible };
