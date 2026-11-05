const LEGACY_VERSION = 'PURCHASE_VAT_V1_20261104';
const VERSION = 'PURCHASE_VAT_V2_20261105';
const money = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
function normalizeInvoiceType(value) {
  if (value === '收据' || value === '未税（收据或普票）') return '收据';
  if (['专票13%', '增专票（13%）', '增值税专用发票13%', '13%含税'].includes(value)) return '专票13%';
  return null;
}
function isService(line) {
  const name = String(line.productName || '');
  return /清灰|装系统|系统安装|系统重装|CARE/i.test(name) || /^联想\s*服务\s/.test(name) || /^检测[－-]专业检测$/.test(name);
}
function taxError(message) {
  return Object.assign(new Error(message), { status: 409, code: 'ORDER_PURCHASE_TAX_PENDING' });
}
function calculateVat(lines, invoiceAmount, invoiceStatus) {
  if (String(invoiceStatus).trim() === '不开票' || Number(invoiceAmount) === 0) return { taxableAmount: 0, amount: 0 };
  const bases = lines.map(x => x.purchaseTaxBasis);
  if (bases.some(x => !x || ![VERSION, LEGACY_VERSION].includes(x.version) || x.status !== 'confirmed')) throw taxError('采购票税依据待核实，不能计算税费');
  if (new Set(bases.map(x => x.version)).size > 1) throw taxError('税费规则版本不一致');
  if (bases.some(x => !Number.isFinite(Number(x.purchaseAmount)) || Number(x.purchaseAmount) < 0 ||
    (x.service ? Number(x.purchaseAmount) !== 0 : !['收据', '专票13%'].includes(x.invoiceType)))) {
    throw taxError('采购票税金额或凭证类型无效');
  }
  const modes = new Set(bases.filter(x => !x.service).map(x => x.invoiceType));
  if (modes.size > 1) throw taxError('采购票税类型不一致，须核实历史数据');
  const receipt = modes.has('收据');
  const cost = receipt ? 0 : money(bases.reduce((s, x, index) => {
    if (x.service) return s;
    const line = lines[index];
    if (x.version === VERSION && (line.isCompanyPriced === true || line.costModeSnapshot === 'COMPANY_PRICE' ||
      (line.isCompanyPriced === undefined && ['product_standard_price', 'sn_special_price', 'approved_settlement_price_correction', 'historical_pn_cost_override'].includes(line.source)))) {
      if (line.unitPricing === null || line.unitPricing === undefined || !Number.isFinite(Number(line.unitPricing)) || Number(line.unitPricing) < 0 || !Number.isFinite(Number(line.quantity)) || Number(line.quantity) <= 0) throw taxError('公司定价税费依据不完整');
      return s + money(Number(line.unitPricing) * Number(line.quantity));
    }
    return s + Number(x.purchaseAmount);
  }, 0));
  const taxableAmount = money(Math.max(0, Number(invoiceAmount) - cost));
  return { taxableAmount, amount: money(taxableAmount * 0.13) };
}
async function attachPurchaseTaxBasis(order, lines, transaction, originIndex = null) {
  const M = require('../../models');
  const { QueryTypes } = require('sequelize');
  const cutoff = new Date(new Date(order.archive_time || new Date()).getTime() + 8 * 3600000).toISOString().slice(0, 23).replace('T', ' ');
  const result = [];
  for (const line of lines) {
    if (line.purchaseTaxBasis?.version === VERSION && line.purchaseTaxBasis.status === 'confirmed') { result.push(line); continue; }
    if (line.purchaseTaxBasis?.version === LEGACY_VERSION && line.purchaseTaxBasis.status === 'confirmed') {
      result.push({ ...line, purchaseTaxBasis: { ...line.purchaseTaxBasis, version: VERSION } }); continue;
    }
    let basis = { version: VERSION, status: 'pending', service: false, reason: '缺少可追溯采购来源' };
    if (isService(line)) basis = { version: VERSION, status: 'confirmed', service: true, purchaseAmount: 0, invoiceType: null, source: 'service_zero_purchase' };
    else {
      const receiptId = line.pricingOrigin?.receiptItemId;
      let rows = [];
      if (originIndex) rows = originIndex.get(line.snCode ? 'sn:' + line.snCode : receiptId ? 'receipt:' + receiptId : 'product:' + line.productId) || [];
      else if (line.snCode) rows = await M.sequelize.query(`SELECT DISTINCT pr.REQUEST_ID AS purchaseId, pr.REQUEST_NO AS purchaseNo, pr.INVOICE_TYPE AS invoiceType, ii.ITEM_ID AS receiptItemId, ii.UNIT_PRICE AS unitCost
        FROM T_INBOUND_ITEM ii LEFT JOIN T_INBOUND_ITEM_SN rel ON ii.ITEM_ID=rel.INBOUND_ITEM_ID
        JOIN T_INBOUND i ON i.INBOUND_ID=ii.INBOUND_ID JOIN T_PURCHASE_REQUEST pr ON pr.REQUEST_ID=i.PURCHASE_REQUEST_ID
        WHERE (rel.SN_CODE=:sn OR ii.SN_CODE=:sn OR JSON_CONTAINS(IF(JSON_VALID(ii.RECEIVED_SN_CODES),ii.RECEIVED_SN_CODES,'[]'),JSON_QUOTE(:sn)))
          AND ii.PRODUCT_ID=:product AND COALESCE(ii.RECEIVE_TIME,i.RECEIVE_TIME,i.CREATE_TIME)<=:cutoff`,
        { replacements: { sn: line.snCode, product: line.productId, cutoff }, type: QueryTypes.SELECT, transaction });
      else if (receiptId) rows = await M.sequelize.query(`SELECT pr.REQUEST_ID AS purchaseId, pr.REQUEST_NO AS purchaseNo, pr.INVOICE_TYPE AS invoiceType, ii.ITEM_ID AS receiptItemId, ii.UNIT_PRICE AS unitCost
        FROM T_INBOUND_ITEM ii JOIN T_INBOUND i ON i.INBOUND_ID=ii.INBOUND_ID JOIN T_PURCHASE_REQUEST pr ON pr.REQUEST_ID=i.PURCHASE_REQUEST_ID
        WHERE ii.ITEM_ID=:receiptId AND ii.PRODUCT_ID=:product AND COALESCE(ii.RECEIVE_TIME,i.RECEIVE_TIME,i.CREATE_TIME)<=:cutoff`,
        { replacements: { receiptId, product: line.productId, cutoff }, type: QueryTypes.SELECT, transaction });
      else if (!line.snCode) rows = await M.sequelize.query(`SELECT pr.REQUEST_ID AS purchaseId, pr.REQUEST_NO AS purchaseNo, pr.INVOICE_TYPE AS invoiceType, ii.ITEM_ID AS receiptItemId, ii.UNIT_PRICE AS unitCost, i.STORE_ID AS storeId, pr.SUPPLIER_ID AS supplierId
        FROM T_INBOUND_ITEM ii JOIN T_INBOUND i ON i.INBOUND_ID=ii.INBOUND_ID JOIN T_PURCHASE_REQUEST pr ON pr.REQUEST_ID=i.PURCHASE_REQUEST_ID
        WHERE ii.PRODUCT_ID=:product AND i.STORE_ID=:store AND COALESCE(ii.RECEIVE_TIME,i.RECEIVE_TIME,i.CREATE_TIME)<=:cutoff`,
        { replacements: { product: line.productId, store: order.store_id, cutoff }, type: QueryTypes.SELECT, transaction });
      // Match frozen actual cost, never current company pricing or supplier defaults.
      const candidates = rows.filter(x => line.snCode || receiptId || (x.storeId === order.store_id && (!line.supplierId || x.supplierId === line.supplierId))).filter(x => x.productId === undefined || x.productId === line.productId).filter(x => !x.receiptTime || new Date(x.receiptTime) <= new Date(order.archive_time || Date.now())).filter(x => x.unitCost !== null && x.unitCost !== undefined && line.purchasePrice !== null && line.purchasePrice !== undefined && money(x.unitCost) === money(line.purchasePrice));
      const unique = new Map(candidates.map(x => [x.purchaseId + ':' + x.unitCost + ':' + x.invoiceType, x]));
      if (unique.size === 1) {
        const row = [...unique.values()][0];
        basis = { version: VERSION, status: normalizeInvoiceType(row.invoiceType) ? 'confirmed' : 'pending', service: false,
          purchaseAmount: money(Number(row.unitCost) * Number(line.quantity)), invoiceType: normalizeInvoiceType(row.invoiceType), originalInvoiceType: row.invoiceType,
          purchaseId: row.purchaseId, purchaseNo: row.purchaseNo, receiptItemId: row.receiptItemId, reason: '以对应采购申请票据选择为准' };
      } else if (unique.size > 1) {
        const types = new Set([...unique.values()].map(x => normalizeInvoiceType(x.invoiceType)));
        if (types.size === 1 && !types.has(null)) basis = {
          version: VERSION, status: 'confirmed', service: false, invoiceType: [...types][0],
          purchaseAmount: money(Number(line.purchasePrice) * Number(line.quantity)),
          source: 'all_matching_purchase_candidates_agree',
          candidatePurchaseIds: [...new Set([...unique.values()].map(x => x.purchaseId))],
          reason: '冻结成本匹配的所有候选采购票据口径一致，不指定具体批次'
        }; else basis.reason = '采购候选票据口径不唯一或不明确';
      }
    }
    result.push({ ...line, purchaseTaxBasis: basis });
  }
  return result;
}
module.exports = { VERSION, LEGACY_VERSION, normalizeInvoiceType, isService, calculateVat, attachPurchaseTaxBasis };
