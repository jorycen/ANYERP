const { QueryTypes } = require('sequelize');
const id = value => String(value || '');
const money = value => value == null || String(value).trim() === '' || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 100);
const time = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).getTime() : null;
function codes(value) {
  if (Array.isArray(value)) return value.map(id);
  try { const list = JSON.parse(value || '[]'); return Array.isArray(list) ? list.map(id) : []; } catch { return []; }
}
function documentBasis(type, rate) {
  const text = String(type || '');
  if (/专票|增值税专用/.test(text)) {
    const explicit = text.match(/(\d+(?:\.\d+)?)\s*%/);
    if (explicit) {
      const percent=Number(explicit[1]);
      if(percent<0||percent>100)return '';
      if(rate!==null&&rate!==undefined&&rate!==''&&(!Number.isFinite(Number(rate))||Math.abs(Number(rate)*100-percent)>0.0001))return '';
      return `专票${percent}%`;
    }
    if (rate !== null && rate !== undefined && rate !== '' && Number.isFinite(Number(rate)) && Number(rate) >= 0 && Number(rate) <= 1) return `专票${Number((Number(rate)*100).toFixed(4))}%`;
    return '';
  }
  if (/收据|普通发票|普票/.test(text)) return '收据或普票';
  return '';
}
function identityMatch(sn, row) {
  if (id(row.boundSnId) === id(sn.sn_id) || id(row.directSnId) === id(sn.sn_id)) return true;
  // A code alone may identify a legacy receipt only when it has no competing ID.
  if (row.boundSnId || row.directSnId) return false;
  return id(row.snCode).trim() === id(sn.sn_code).trim() || codes(row.receivedCodes).includes(id(sn.sn_code));
}
function resolveSnEvidence(sn, rows, distributorId, invoices = new Map(), at = new Date()) {
  const matching = rows.filter(row => id(row.productId) === id(sn.product_id) && identityMatch(sn,row));
  const byItem=new Map();
  for(const row of matching){const old=byItem.get(id(row.itemId));if(!old||(id(row.boundSnId)===id(sn.sn_id)&&id(old.boundSnId)!==id(sn.sn_id)))byItem.set(id(row.itemId),row);}
  const unique = [...byItem.values()];
  if (!unique.length) return { status:'unlinked', reason:'未找到该SN的采购入库关联', candidateCount:0 };
  const cutoff = Math.min(time(sn.inbound_time) || at.getTime(), at.getTime());
  // Binding rows may be historical backfills. Prefer actual receipt timestamps;
  // for a partial receipt, the immutable per-SN binding may predate the final row receipt time.
  const dated=unique.map(row=>({...row,effectiveTime:time(row.receivedAt)!==null&&time(row.receivedAt)<=cutoff?time(row.receivedAt):time(row.bindingAt)}));
  const eligible = dated.filter(row => row.effectiveTime !== null && row.effectiveTime <= cutoff
    && money(row.unitPrice) !== null && money(row.unitPrice) === money(sn.inbound_price));
  if (!eligible.length) return { status:'conflict', reason:unique.some(row=>money(row.unitPrice)===money(sn.inbound_price))
    ? '已有关联入库，但无法确认当前库存周期的收货时间'
    : '已关联采购入库，但单价与当前SN采购成本不一致', candidateCount:unique.length };
  const latest = Math.max(...eligible.map(row => row.effectiveTime));
  const candidates = eligible.filter(row => row.effectiveTime === latest);
  if (new Set(candidates.map(row => id(row.requestId))).size !== 1) return {status:'conflict',reason:'同一SN存在多个同时间采购来源，需核对',candidateCount:candidates.length};
  const source = candidates[0];
  const base = { requestId:source.requestId, requestNo:source.requestNo, inboundNo:source.inboundNo,
    candidateCount:unique.length, invoiceType:source.invoiceType || '', evidenceSource:'purchase_request', invoiceNos:'' };
  if (!distributorId || !source.distributorId || id(source.distributorId) !== id(distributorId)) return {...base,status:'owner_pending',reason:'来源与当前库存的经销商归属未一致确认，不能套用票据'};
  const registered = invoices.get(id(source.requestId));
  if (registered?.conflict) return {...base,status:'invoice_conflict',reason:registered.reason};
  if (registered?.basis) return {...base,invoiceType:registered.basis,invoiceNos:registered.invoiceNos,evidenceSource:'registered_invoice',status:'linked',reason:'已关联完整覆盖且税务口径一致的已登记采购发票'};
  const basis = documentBasis(source.invoiceType);
  return {...base,invoiceType:basis || source.invoiceType || '',status:basis?'linked':'invoice_pending',reason:basis?'已关联采购申请约定票种，仍属测算':'已关联采购入库，但缺少明确票种或税率'};
}
function registeredInvoiceEvidence(rows) {
  const groups = new Map(), result = new Map();
  for (const row of rows) { const key=id(row.requestId); if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row); }
  for (const [key, raw] of groups) {
    const values=[...new Map(raw.map(row=>[id(row.allocationId),row])).values()];
    const expected=money(values[0].requestAmount);
    const allocated=values.reduce((sum,row)=>sum+(money(row.allocationAmount)||0),0);
    if (!(expected>0) || allocated<expected) continue;
    const bases=values.map(row=>documentBasis(row.invoiceType,row.taxRate));
    if (bases.some(value=>!value) || new Set(bases).size!==1) { result.set(key,{conflict:true,reason:'已登记发票票种或税率不一致，不能确定当前商品对应税率'});continue; }
    result.set(key,{basis:bases[0],invoiceNos:[...new Set(values.map(row=>row.invoiceNo).filter(Boolean))].join('、')});
  }
  return result;
}
function nonSnCandidates(productId, storeId, distributorId, rows, at = new Date()) {
  return [...new Map(rows.filter(row => id(row.productId)===id(productId) && id(row.storeId)===id(storeId)
    && id(row.distributorId)===id(distributorId) && time(row.receivedAt)!==null && time(row.receivedAt)<=at.getTime())
    .map(row=>[id(row.requestId),{requestNo:row.requestNo,inboundNo:row.inboundNo,invoiceType:row.invoiceType||''}])).values()];
}
async function loadEvidence(sequelize, productIds, transaction, at) {
  if(!productIds.length)return {receipts:[],invoices:new Map()};
  const receipts=await sequelize.query(`SELECT ii.ITEM_ID itemId,ii.PRODUCT_ID productId,ii.SN_ID directSnId,
    ins.SN_ID boundSnId,ii.SN_CODE snCode,ii.RECEIVED_SN_CODES receivedCodes,ii.UNIT_PRICE unitPrice,
    i.INBOUND_NO inboundNo,i.STORE_ID storeId,pr.REQUEST_ID requestId,pr.REQUEST_NO requestNo,
    pr.INVOICE_TYPE invoiceType,COALESCE(pr.DISTRIBUTOR_ID,ps.DISTRIBUTOR_ID) distributorId,
    ins.CREATE_TIME bindingAt,
    COALESCE(ii.RECEIVE_TIME,i.RECEIVE_TIME,CASE WHEN i.STATUS='completed' THEN i.CREATE_TIME END) receivedAt
    FROM T_INBOUND_ITEM ii JOIN T_INBOUND i ON i.INBOUND_ID=ii.INBOUND_ID
    LEFT JOIN T_INBOUND_ITEM_SN ins ON ins.INBOUND_ITEM_ID=ii.ITEM_ID
    JOIN T_PURCHASE_REQUEST pr ON pr.REQUEST_ID=COALESCE(NULLIF(i.PURCHASE_REQUEST_ID,''),
      (SELECT pr2.REQUEST_ID FROM T_PURCHASE_REQUEST pr2 WHERE i.SOURCE_TYPE='purchase' AND pr2.REQUEST_NO=i.SOURCE_NO LIMIT 1))
    LEFT JOIN T_STORE ps ON ps.STORE_ID=pr.STORE_ID
    WHERE ii.PRODUCT_ID IN (:ids) AND i.STATUS IN ('completed','pending')
      AND pr.STATUS NOT IN ('draft','pending','pending_approval','rejected','revoked','cancelled','canceled')
      AND (i.STATUS='completed' OR ii.RECEIVED_QUANTITY>0 OR ins.SN_ID IS NOT NULL)
    ORDER BY receivedAt DESC,ii.ITEM_ID DESC`,{replacements:{ids:productIds},type:QueryTypes.SELECT,transaction});
  const requestIds=[...new Set(receipts.map(row=>row.requestId).filter(Boolean))];
  if(!requestIds.length)return {receipts,invoices:new Map()};
  const invoiceRows=await sequelize.query(`SELECT pr.REQUEST_ID requestId,pr.TOTAL_AMOUNT requestAmount,
    ia.ALLOCATION_ID allocationId,ia.AMOUNT allocationAmount,pi.INVOICE_TYPE invoiceType,
    pi.TAX_RATE taxRate,pi.INVOICE_NO invoiceNo
    FROM T_PURCHASE_INVOICE_ALLOCATION ia
    JOIN T_PURCHASE_INVOICE pi ON pi.INVOICE_ID=ia.INVOICE_ID AND pi.STATUS='active'
    JOIN T_SETTLEMENT st ON st.SETTLEMENT_ID=ia.SETTLEMENT_ID AND st.IS_DELETED=0 AND st.STATUS='confirmed'
    JOIN (SELECT si.SETTLEMENT_ID,MIN(p.REQUEST_ID) requestId
      FROM T_SETTLEMENT_ITEM si JOIN T_PAYABLE p ON p.PAYABLE_ID=si.PAYABLE_ID
      GROUP BY si.SETTLEMENT_ID HAVING COUNT(DISTINCT p.REQUEST_ID)=1 AND SUM(p.REQUEST_ID IS NULL OR p.REQUEST_ID='')=0) src
      ON src.SETTLEMENT_ID=ia.SETTLEMENT_ID
    JOIN T_PURCHASE_REQUEST pr ON pr.REQUEST_ID=src.requestId
    LEFT JOIN T_STORE ps ON ps.STORE_ID=pr.STORE_ID
    WHERE pr.REQUEST_ID IN (:ids) AND pi.DISTRIBUTOR_ID=COALESCE(pr.DISTRIBUTOR_ID,ps.DISTRIBUTOR_ID)
      AND pi.CREATE_TIME<=:at AND pi.INVOICE_DATE<=:day`,{replacements:{ids:requestIds,at,day:new Date(at.getTime()+8*3600000).toISOString().slice(0,10)},type:QueryTypes.SELECT,transaction});
  return {receipts,invoices:registeredInvoiceEvidence(invoiceRows)};
}
module.exports={documentBasis,identityMatch,resolveSnEvidence,registeredInvoiceEvidence,nonSnCandidates,loadEvidence};
