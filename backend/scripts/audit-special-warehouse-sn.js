// Read-only evidence audit. Reports never authorize or apply stock/cost corrections.
const fs = require('node:fs');
const path = require('node:path');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../src/config/database');
const { inspectSnEligibility } = require('../src/utils/snEligibility');
const special = value => ['display_qty', 'rental_demo_qty'].includes(value);
const ruleEffectiveEpoch = Date.parse('2026-09-08T00:00:00+08:00');
const parse = value => { try { return typeof value === 'string' ? JSON.parse(value) : value || {}; } catch { return {}; } };
const group = (rows, field) => {
  const result = new Map();
  for (const row of rows) { const key = String(row[field] || ''); if (!result.has(key)) result.set(key, []); result.get(key).push(row); }
  return result;
};

async function audit() {
  const facts = await sequelize.transaction({ isolationLevel: 'REPEATABLE READ', readOnly: true }, async transaction => {
    const select = sql => sequelize.query(sql, { type: QueryTypes.SELECT, transaction });
    const sns = await select(`SELECT sn.SN_ID id,sn.SN_CODE sn,sn.PRODUCT_ID productId,p.NAME productName,
      sn.STATUS status,sn.INVENTORY_TYPE inventoryType,sn.STORE_ID storeId,s.NAME storeName,
      sn.LOCATION_ID locationId,l.NAME locationName,l.TYPE locationType,l.STORE_ID locationStoreId,l.STATUS locationStatus,
      sn.INBOUND_PRICE cost,sn.SOURCE_TYPE sourceType FROM T_PRODUCT_SN sn
      LEFT JOIN T_STORE s ON s.STORE_ID=sn.STORE_ID LEFT JOIN T_LOCATION l ON l.LOCATION_ID=sn.LOCATION_ID
      LEFT JOIN T_PRODUCT p ON p.PRODUCT_ID=sn.PRODUCT_ID WHERE sn.IS_DELETED=0`);
    const logs = await select(`SELECT SN_ID snId,ACTION action,REMARK remark,STORE_ID storeId,CREATE_USER actor,
      DATE_FORMAT(CREATE_TIME,'%Y-%m-%d %H:%i:%s') time,UNIX_TIMESTAMP(CREATE_TIME)*1000 epoch FROM T_SN_LOG ORDER BY CREATE_TIME,LOG_ID`);
    const batches = await select(`SELECT i.SN_ID snId,i.SN_CODE sn,a.APPLICATION_NO document,i.OPERATION_TYPE operation,
      i.INVENTORY_TYPE inventoryType,i.LOCATION_ID locationId,l.TYPE locationType,i.STORE_ID storeId,
      i.RAW_JSON raw,i.EXECUTE_STATUS executeStatus FROM T_INVENTORY_BATCH_APPLICATION_ITEM i
      JOIN T_INVENTORY_BATCH_APPLICATION a ON a.APPLICATION_ID=i.APPLICATION_ID
      LEFT JOIN T_LOCATION l ON l.LOCATION_ID=i.LOCATION_ID
      WHERE a.STATUS IN ('executed','executing')
      AND (i.EXECUTE_STATUS='success' OR (a.STATUS='executed' AND i.EXECUTE_STATUS='pending'))
      AND (COALESCE(i.SN_ID,'')<>'' OR COALESCE(i.SN_CODE,'')<>'')`);
    const purchases = await select(`SELECT i.SOURCE_SN_ID snId,pr.REQUEST_NO document,pr.STATUS status,
      DATE_FORMAT(pr.APPROVE_TIME,'%Y-%m-%d %H:%i:%s') approvedAt,UNIX_TIMESTAMP(pr.APPROVE_TIME)*1000 approvedEpoch,
      i.UNIT_PRICE price,pr.SUPPLIER_ID supplierId FROM T_PURCHASE_REQUEST_ITEM i
      JOIN T_PURCHASE_REQUEST pr ON pr.REQUEST_ID=i.REQUEST_ID WHERE COALESCE(i.SOURCE_SN_ID,'')<>''`);
    const orders = await select(`SELECT oi.SN_ID snId,oi.SN_CODE sn,o.ORDER_NO document,o.ORDER_STATUS status,
      o.STORE_ID storeId,DATE_FORMAT(o.CREATE_TIME,'%Y-%m-%d %H:%i:%s') time
      FROM T_ORDER_ITEM oi JOIN T_ORDER o ON o.ORDER_ID=oi.ORDER_ID WHERE o.IS_DELETED=0 AND (COALESCE(oi.SN_ID,'')<>'' OR COALESCE(oi.SN_CODE,'')<>'')`);
    const eligibility = await inspectSnEligibility(sns.map(sn => ({ sn_id: sn.id, sn_code: sn.sn,
      store_id: sn.storeId, inventory_type: sn.inventoryType, source_type: sn.sourceType })), transaction);
    return { sns, logs, batches, purchases, orders, eligibility };
  });
  const { sns, logs, batches, purchases, orders } = facts;
  const logMap = group(logs, 'snId'), purchaseMap = group(purchases, 'snId');
  const batchMap = group(batches, 'snId'), batchCodeMap = group(batches, 'sn');
  const orderMap = group(orders, 'snId'), orderCodeMap = group(orders, 'sn');
  const findings = [], coverage = { linkedSpecialBatch:0, timestampMissing:0, currentlySpecial:0, verifiedPurchaseLog:0, historicalTransferLaterConverted:0 };
  for (const sn of sns) {
    const history = logMap.get(sn.id) || [];
    const sourceBatches = [...new Set([...(batchMap.get(sn.id)||[]),...(batchCodeMap.get(sn.sn)||[])])]
      .filter(row => row.snId ? String(row.snId) === String(sn.id) : row.sn === sn.sn);
    const specialEntries = [];
    for (const row of sourceBatches.filter(row => row.operation==='INBOUND' && special(row.inventoryType))) {
      const evidence = history.find(log => log.action==='batch_inbound' && String(log.remark||'').includes(row.document));
      if (row.executeStatus === 'pending' && !evidence) continue;
      specialEntries.push({type:row.inventoryType,document:row.document,storeId:row.storeId,time:evidence?.time||null,epoch:Number(evidence?.epoch||0)});
    }
    // Old location-adjust logs are textual evidence, kept separate from structured batch evidence.
    const textualSpecial = history.filter(log => log.action==='location_adjust' && /[→>]\s*(?:租赁样机仓|铺货仓)/.test(log.remark||''));
    specialEntries.sort((a,b)=>a.epoch-b.epoch);
    const latest = specialEntries.at(-1);
    if (latest) coverage.linkedSpecialBatch++;
    if (latest && !latest.epoch) coverage.timestampMissing++;
    if (special(sn.locationType) || special(sn.inventoryType)) coverage.currentlySpecial++;
    const approvals = purchaseMap.get(sn.id)||[];
    const conversionLogs = history.filter(log=>log.action==='special_warehouse_purchase');
    if (conversionLogs.length) coverage.verifiedPurchaseLog++;
    const flags=[];
    const mismatched=['in_stock','reserved','occupied'].includes(sn.status) && sn.locationType &&
      (sn.inventoryType!==sn.locationType || sn.locationStoreId!==sn.storeId || Number(sn.locationStatus)!==1);
    if (mismatched) flags.push({type:'CURRENT_LOCATION_CONFLICT',confidence:'确定记录冲突',reason:'SN类型、所属门店或有效性与实际库位记录不一致；不据此推定已采购'});
    let transfer;
    if (latest?.epoch) {
      transfer=history.find(log=>['transfer_out_confirm','transfer_out'].includes(log.action) && Number(log.epoch)>latest.epoch &&
        !conversionLogs.some(p=>Number(p.epoch)>latest.epoch && Number(p.epoch)<=Number(log.epoch)) &&
        !approvals.some(p=>p.status==='approved' && Number(p.approvedEpoch)>latest.epoch && Number(p.approvedEpoch)<=Number(log.epoch)));
      const convertedLater=conversionLogs.some(p=>Number(p.epoch)>latest.epoch) || approvals.some(p=>p.status==='approved' && Number(p.approvedEpoch)>latest.epoch);
      const knownSpecialReceipt = transfer && history.some(log => log.action === 'special_warehouse_flow' && Number(log.epoch) >= Number(transfer.epoch));
      if (transfer && !knownSpecialReceipt && Number(transfer.epoch)>=ruleEffectiveEpoch) flags.push({type:'SPECIAL_TRANSFER_TARGET_NEEDS_REVIEW',confidence:'有特殊仓来源和调拨记录，历史目标类型须核对',reason:'特殊仓之间允许流转；只有未经采购进入其他仓才违规，不能凭调拨本身认定',transfer});
      else if (transfer && !convertedLater) flags.push({type:'PRE_RULE_TRANSFER_NEEDS_REVIEW',confidence:'规则生效前历史，不能追认违规',reason:'规则生效前曾有特殊仓调拨，当前采购依据待核实',transfer});
      else if (transfer && convertedLater) coverage.historicalTransferLaterConverted++;
      if (facts.eligibility.get(String(sn.id))?.restricted && !special(sn.locationType) && ['in_stock','reserved','occupied','sold'].includes(sn.status)) flags.push({type:'SPECIAL_HISTORY_NOW_OUTSIDE_WITHOUT_PURCHASE',confidence:'疑似异常，需核对离仓依据',reason:'后台共享资格校验仍有特殊仓限制，当前位置已离开特殊仓；须核对后续有效采购执行凭据'});
    }
    if (!latest && textualSpecial.length && !conversionLogs.length && !special(sn.locationType)) flags.push({type:'TEXT_HISTORY_NEEDS_REVIEW',confidence:'证据不足',reason:'仅有文本特殊仓调整痕迹，缺结构化来源或采购转换证据'});
    if (sn.sourceType==='PURCHASED_FROM_SPECIAL_WAREHOUSE' && !approvals.some(p=>p.status==='approved') && !conversionLogs.length) flags.push({type:'PURCHASE_SOURCE_WITHOUT_DOCUMENT',confidence:'证据不足',reason:'SN标记特殊仓采购来源，但未找到审批或转换日志'});
    if (!flags.length) continue;
    findings.push({...sn,flags,latestSpecialEntry:latest||null,specialEntries,procurements:approvals,
      conversionLogs,orders:[...new Set([...(orderMap.get(sn.id)||[]),...(orderCodeMap.get(sn.sn)||[])])],history});
  }
  const byFlag={},byStatus={};
  for (const row of findings) { byStatus[row.status]=(byStatus[row.status]||0)+1;for(const flag of row.flags)byFlag[flag.type]=(byFlag[flag.type]||0)+1; }
  const report={generatedAt:new Date().toISOString(),readOnly:true,totalSn:sns.length,coverage,summary:{uniqueFindings:findings.length,byFlag,byStatus},
    limitations:['无结构化历史来源的SN不能据此证明无异常','未找到系统采购记录不等同于证明外部从未采购','价格导入、批量入库、调拨完成及销售仓位置均不能代替采购审批','同一SN可同时命中多项，分类数量不能直接相加','2026-09-08之前的历史调拨单独核对，不直接按后来规则追认违规'],findings};
  const out=path.resolve(__dirname,'../backup/special-warehouse-audit-20261028-special-flow.json');
  fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2));
  const csvFields=['sn','productName','status','storeName','locationName','inventoryType','locationType','cost'];
  const quote=value=>'"'+String(value??'').replaceAll('"','""')+'"';
  const csv=[csvFields.concat(['flags','specialEntry','purchaseDocuments','orderDocuments']).map(quote).join(',')];
  for(const r of findings)csv.push(csvFields.map(f=>r[f]).concat([r.flags.map(f=>f.type).join(';'),r.latestSpecialEntry?.document||'',r.procurements.map(p=>p.document+':'+p.status).join(';'),r.orders.map(o=>o.document+':'+o.status).join(';')]).map(quote).join(','));
  fs.writeFileSync(out.replace('.json','.csv'),'\ufeff'+csv.join('\r\n'),'utf8');
  console.log(JSON.stringify({totalSn:report.totalSn,coverage,summary:report.summary,report:out,sample:findings.slice(0,8).map(r=>({sn:r.sn,store:r.storeName,status:r.status,flags:r.flags.map(f=>f.type)}))},null,2));
  return report;
}
if(require.main===module)audit().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>sequelize.close());
module.exports={audit};
